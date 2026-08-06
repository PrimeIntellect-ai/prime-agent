import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { KernelManager, type KernelSentAgentMessage } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledAgentMessageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "agent-message");
	return {
		name: "agent-message",
		importName: "agent_message",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

type LateHandlerRetentionHost = {
	lateSentAgentMessageHandlers: Map<string, (message: KernelSentAgentMessage) => void>;
	registerLateSentAgentMessageHandler: (
		requestMessageId: string,
		handler: (message: KernelSentAgentMessage) => void,
	) => void;
};

describe("agent-message skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-message-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists agents and sends without exposing a spoofable sender", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.list_agents": async (payload) => {
					requests.push({ type: "agent_message.list_agents", payload });
					return {
						current: { name: "alpha", id: "session-alpha", depth: 0 },
						entries: [{ relationship: "sibling", name: "Beta", id: "session-beta", depth: 0, status: "idle" }],
					};
				},
				"agent_message.send": async (payload) => {
					requests.push({ type: "agent_message.send", payload });
					return {
						id: "agentmsg-test",
						source: "agent_message",
						target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
						from: { activeSessionId: "alpha", sessionId: "session-alpha" },
						message: payload.message,
						deliveryStatus: "queued",
						queuedAt: "2026-06-16T00:00:00.000Z",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
agents = await agent_message.list_agents()
receipt = await agent_message.send(
    "hello beta", receiver_role="sibling", receiver_name="beta"
)
print(json.dumps({"agents": agents, "receipt": receipt}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output.agents).toMatchObject({
			current: { id: "session-alpha", depth: 0 },
			entries: [{ relationship: "sibling", id: "session-beta", status: "idle" }],
		});
		expect(output.receipt).toMatchObject({
			id: "agentmsg-test",
			source: "agent_message",
			message: "hello beta",
			deliveryStatus: "queued",
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-test",
				message: "hello beta",
				deliveryStatus: "queued",
				receiverRole: "sibling",
				target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
			},
		]);
		expect(requests[0]).toMatchObject({
			type: "agent_message.list_agents",
			payload: { type: "agent_message.list_agents" },
		});
		expect(requests[1]).toMatchObject({
			type: "agent_message.send",
			payload: {
				type: "agent_message.send",
				message: "hello beta",
				receiver_role: "sibling",
				receiver_name: "beta",
			},
		});
		expect(requests[1].payload).not.toHaveProperty("from");
	});

	it("emits successful broadcast receipts and leaves short errors in the result", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					receipts: [
						{
							id: "agentmsg-root",
							source: "agent_message",
							target: { activeSessionId: "root", sessionId: "session-root" },
							message: payload.message,
							deliveryStatus: "delivered",
							deliveredAt: "2026-08-03T00:00:00.000Z",
							deliveryMode: payload.mode,
						},
						{ target: "sibling", error: "rate limited" },
					],
				}),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
receipt = await agent_message.send("all", "status")
print(json.dumps(receipt, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			receipts: [
				{ id: "agentmsg-root", deliveryStatus: "delivered" },
				{ target: "sibling", error: "rate limited" },
			],
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-root",
				message: "status",
				deliveryStatus: "delivered",
				target: { activeSessionId: "root", sessionId: "session-root" },
			},
		]);
	});

	it("rejects broadcast combined with role selectors before reaching the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("all", "secret", receiver_role="sibling", receiver_name="beta")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("TypeError: broadcast cannot be combined with receiver_role/receiver_name");
	});

	it("rejects a positional name target before reaching the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("beta", "done")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"TypeError: positional agent_message.send targets are not supported; use receiver_role and receiver_name",
		);
	});

	it("does not expose a queueable delivery mode", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("hello", receiver_role="sibling", receiver_name="beta", mode="broadcast")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("TypeError: send() got an unexpected keyword argument 'mode'");
	});

	it("captures sent messages from detached tasks after the cell is idle", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					id: "agentmsg-background",
					source: "agent_message",
					target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
					message: payload.message,
					deliveryStatus: "delivered",
					deliveredAt: "2026-07-10T00:00:00.000Z",
					deliveryMode: payload.mode,
				}),
			},
		});

		const manager = await provisioner.ensure();
		let resolveLateMessage!: (message: KernelSentAgentMessage) => void;
		const lateMessage = new Promise<KernelSentAgentMessage>((resolve) => {
			resolveLateMessage = resolve;
		});
		const result = await manager.execute(
			`async def send_later():
    await asyncio.sleep(0.05)
    await agent_message.send("background hello", receiver_role="sibling", receiver_name="beta")

background_send = asyncio.create_task(send_later())`,
			{ onLateSentAgentMessage: (message) => resolveLateMessage(message) },
		);

		expect(result.status).toBe("ok");
		expect(result.sentAgentMessages).toBeUndefined();
		await expect(lateMessage).resolves.toEqual({
			id: "agentmsg-background",
			message: "background hello",
			deliveryStatus: "delivered",
			receiverRole: "sibling",
			target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
		});
	});

	it("cancels a blocking mailbox wait when the cell is interrupted", async () => {
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let hostCancelled = false;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.wait": async (_payload, signal) => {
					started();
					await new Promise<void>((_resolve, reject) => {
						const cancel = () => {
							hostCancelled = true;
							reject(new Error("wait cancelled"));
						};
						signal?.addEventListener("abort", cancel, { once: true });
						if (signal?.aborted) cancel();
					});
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const abort = new AbortController();
		const execution = manager.execute("await agent_message.wait(timeout=30)", { signal: abort.signal });
		await didStart;
		abort.abort();
		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		await expect.poll(() => hostCancelled).toBe(true);
	});

	it("bounds retained handlers for late sent messages", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const host = manager as unknown as LateHandlerRetentionHost;
		const handler = () => {};

		for (let index = 0; index < 300; index += 1) {
			host.registerLateSentAgentMessageHandler(`request-${index}`, handler);
		}

		expect(host.lateSentAgentMessageHandlers.size).toBe(256);
		expect(host.lateSentAgentMessageHandlers.has("request-0")).toBe(false);
		expect(host.lateSentAgentMessageHandlers.has("request-299")).toBe(true);
		await manager.dispose();
	});
});
