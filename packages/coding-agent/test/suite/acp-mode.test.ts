import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createHarness } from "./harness.js";

/** Minimal AgentSessionRuntime host over a real faux-backed AgentSession. */
function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

/**
 * Drives ACP mode with a REAL @agentclientprotocol/sdk client over an in-memory
 * duplex pair, so the protocol handshake, prompt turn, streamed updates, and
 * stop reason are exercised end to end rather than asserted from source.
 */

interface ClientHarness {
	client: any;
	updates: any[];
	close: () => void;
}

function connectAcpClient(connection: any): ClientHarness {
	// Two web streams crossed over: agent's stdout is the client's stdin.
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();

	const agentStream = acp.ndJsonStream(toClient.writable, toAgent.readable);
	const clientStream = acp.ndJsonStream(toAgent.writable, toClient.readable);

	const updates: any[] = [];
	void runAcpModeWithConnection(connection, { stream: agentStream } as any);

	const handle = acp
		.client({ name: "test-client" })
		.onNotification("session/update", (ctx: any) => {
			updates.push(ctx.params);
		})
		.connect(clientStream);

	// connect() yields a handle whose `agent` proxy is the outbound call surface.
	return { client: handle.agent, updates, close: () => handle.close() };
}

describe("ACP mode end to end", () => {
	it("completes a prompt turn and streams assistant text", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Hello from prime-agent.")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));

		const { client, updates } = connectAcpClient(connection);

		const init = await client.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
		expect(init.agentInfo?.name).toBe("prime-agent");
		expect(init._meta).toHaveProperty(PRIME_AGENT_META_NAMESPACE);

		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		expect(typeof session.sessionId).toBe("string");

		const result = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expect(result.stopReason).toBe("end_turn");

		const text = updates
			.filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
			.map((u) => u.update.content.text)
			.join("");
		expect(text).toContain("Hello from prime-agent");

		harness.cleanup();
	}, 30_000);

	it("advertises executable commands after session/new", async () => {
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({
				skills: [
					{
						kind: "markdown",
						name: "code-review",
						description: "Review a diff",
						filePath: "/skills/code-review/SKILL.md",
						baseDir: "/skills/code-review",
						sourceInfo: {
							path: "/skills/code-review/SKILL.md",
							source: "user",
							scope: "user",
							origin: "top-level",
						},
						disableModelInvocation: false,
					},
				],
			}),
		});
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));

		const { client, updates } = connectAcpClient(connection);

		await client.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const update = await vi.waitFor(() => {
			const found = updates.find((u) => u.update?.sessionUpdate === "available_commands_update");
			if (!found) throw new Error("no available_commands_update yet");
			return found.update;
		});

		const names = update.availableCommands.map((command: acp.AvailableCommand) => command.name);
		expect(names).toContain("compact");
		expect(names).toContain("skill:code-review");
		// TUI-only selectors have no headless behavior and must not be offered.
		expect(names).not.toContain("model");
		expect(
			update.availableCommands.find((command: acp.AvailableCommand) => command.name === "compact"),
		).toMatchObject({ input: { hint: "[instructions]" } });

		harness.cleanup();
	}, 30_000);

	it("advertises one entry per name, resolved the way a submission is", async () => {
		const sourceInfo = { path: "/x", source: "user", scope: "user", origin: "top-level" } as const;
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi: any) => {
					// Collides with the builtin session command, which wins at submission.
					pi.registerCommand("compact", { description: "extension compact", handler: async () => {} });
					// Collides with the skill below, and an extension command is resolved first.
					pi.registerCommand("skill:code-review", { description: "extension review", handler: async () => {} });
				},
			],
			tmpdir(),
		);
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({
				extensionsResult,
				skills: [
					{
						kind: "markdown",
						name: "code-review",
						description: "skill review",
						filePath: "/skills/code-review/SKILL.md",
						baseDir: "/skills/code-review",
						sourceInfo,
						disableModelInvocation: false,
					},
				],
				prompts: [
					{
						name: "skill:code-review",
						description: "template review",
						content: "",
						filePath: "/prompts/review.md",
						sourceInfo,
					},
				],
			}),
		});
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);

		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const update = await vi.waitFor(() => {
			const found = updates.find((u) => u.update?.sessionUpdate === "available_commands_update");
			if (!found) throw new Error("no available_commands_update yet");
			return found.update;
		});

		const names = update.availableCommands.map((command: acp.AvailableCommand) => command.name);
		expect(names.length).toBe(new Set(names).size);
		const describe = (name: string) =>
			update.availableCommands.find((command: acp.AvailableCommand) => command.name === name)?.description;
		// A session builtin is parsed before any extension command.
		expect(describe("compact")).not.toBe("extension compact");
		// An extension command is executed before a skill or a prompt template.
		expect(describe("skill:code-review")).toBe("extension review");

		harness.cleanup();
	}, 30_000);

	it("does not advertise commands to a session that was closed first", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);

		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		// Closing before the deferred callback runs must cancel it: the resources it
		// would read belong to a session the client has already released.
		await client.request("session/close", { sessionId: session.sessionId });

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(updates.some((u) => u.update?.sessionUpdate === "available_commands_update")).toBe(false);

		harness.cleanup();
	}, 30_000);
});
