import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { KernelSentAgentMessage } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

/** Runtime info for a bundled Python skill, e.g. ("agent-message", "agent_message"). */
function bundledSkill(name: string, importName: string): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return { name, importName, packagePath, pyprojectPath: join(packagePath, "pyproject.toml") };
}

const bundledAgentMessageSkill = () => bundledSkill("agent-message", "agent_message");

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

	it("sends without exposing a spoofable sender and rejects the removed roster call", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
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
receipt = await agent_message.send(
    "hello beta", receiver_role="sibling", receiver_name="beta"
)
print(json.dumps({"has_list_agents": hasattr(agent_message, "list_agents"), "receipt": receipt}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output.has_list_agents).toBe(false);
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
			type: "agent_message.send",
			payload: {
				type: "agent_message.send",
				message: "hello beta",
				receiver_role: "sibling",
				receiver_name: "beta",
			},
		});
		expect(requests[0].payload).not.toHaveProperty("from");
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
});

describe("rlm-heartbeat skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-heartbeat-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips create, list, update, and delete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const record = (type: string) => async (payload: Record<string, unknown>) => {
			requests.push({ type, payload });
			return { heartbeat: { id: payload.id ?? "job-1", label: "tests", instruction: "check tests" } };
		};
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("rlm-heartbeat", "rlm_heartbeat")],
			hostHandlers: {
				"rlm_heartbeat.create": record("rlm_heartbeat.create"),
				"rlm_heartbeat.list": async (payload) => {
					requests.push({ type: "rlm_heartbeat.list", payload });
					return { heartbeats: [{ id: "job-1", status: "active" }] };
				},
				"rlm_heartbeat.update": record("rlm_heartbeat.update"),
				"rlm_heartbeat.delete": record("rlm_heartbeat.delete"),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
created = await rlm_heartbeat.create("check tests", interval="5m", label="tests", delivery_mode="follow_up")
listed = await rlm_heartbeat.list(include_inactive=True)
updated = await rlm_heartbeat.update(created["heartbeat"]["id"], status="pause")
deleted = await rlm_heartbeat.delete(created["heartbeat"]["id"])
print(json.dumps({"created": created["heartbeat"], "listed": listed["heartbeats"]}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			created: { id: "job-1", label: "tests", instruction: "check tests" },
			listed: [{ id: "job-1", status: "active" }],
		});
		expect(requests.map((request) => request.type)).toEqual([
			"rlm_heartbeat.create",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
		]);
		expect(requests[0].payload).toMatchObject({
			type: "rlm_heartbeat.create",
			instruction: "check tests",
			interval: "5m",
			label: "tests",
			delivery_mode: "follow_up",
		});
		expect(requests[1].payload).toMatchObject({ type: "rlm_heartbeat.list", include_inactive: true });
		expect(requests[2].payload).toMatchObject({ type: "rlm_heartbeat.update", id: "job-1", status: "pause" });
		expect(requests[3].payload).toMatchObject({ type: "rlm_heartbeat.delete", id: "job-1" });
	});

	it("rejects non-string delivery modes before calling a missing host handler", async () => {
		let hostRequestCount = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("rlm-heartbeat", "rlm_heartbeat")],
			hostHandlers: {
				"rlm_heartbeat.create": async () => {
					hostRequestCount++;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for value in ([], {}):
    try:
        await rlm_heartbeat.create("check tests", delivery_mode=value)
    except TypeError as error:
        print(f"TypeError: {error}")
try:
    await rlm_heartbeat.list()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"TypeError: delivery_mode must be str or None, got list",
			"TypeError: delivery_mode must be str or None, got dict",
			'RuntimeError: host request type "rlm_heartbeat.list" is not available in this session',
		]);
		expect(hostRequestCount).toBe(0);
	});
});

describe("goal skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips goal.create and goal.complete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("goal", "goal")],
			hostHandlers: {
				"goal.create": async (payload) => {
					requests.push({ type: "goal.create", payload });
					return {
						goal: { objective: payload.objective, status: "active", tokens_used: 0 },
						remaining_tokens: payload.token_budget ?? null,
						completion_budget_report: null,
					};
				},
				"goal.complete": async (payload) => {
					requests.push({ type: "goal.complete", payload });
					return { goal: { objective: "ship it", status: "complete", tokens_used: 7 }, remaining_tokens: 3 };
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_created = await goal.create("ship it", token_budget=10)
print(json.dumps(_created, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			goal: { objective: "ship it", status: "active", tokens_used: 0 },
			remaining_tokens: 10,
			completion_budget_report: null,
		});

		const completed = await manager.execute(`
_completed = await goal.complete()
print(_completed["goal"]["status"], _completed["remaining_tokens"])
`);
		expect(completed.status).toBe("ok");
		expect(completed.stdout.trim()).toBe("complete 3");
		expect(requests.map((request) => request.type)).toEqual(["goal.create", "goal.complete"]);
		expect(requests[0].payload).toMatchObject({ type: "goal.create", objective: "ship it", token_budget: 10 });
	});

	it("surfaces host errors and missing handlers as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("goal", "goal")],
			hostHandlers: {
				"goal.complete": async () => {
					throw new Error("cannot complete goal because this thread has no goal");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import rlm as _rlm
for call in (goal.complete(), goal.get(), _rlm.host_request("goal.get", {"type": "goal.complete"})):
    try:
        await call
    except RuntimeError as error:
        print(f"RuntimeError: {error}")
`);
		expect(result.status).toBe("ok");
		// A missing handler cannot be rerouted by putting another type in the payload.
		expect(result.stdout.trim().split("\n")).toEqual([
			"RuntimeError: cannot complete goal because this thread has no goal",
			'RuntimeError: host request type "goal.get" is not available in this session',
			'RuntimeError: host request type "goal.get" is not available in this session',
		]);
	});
});
