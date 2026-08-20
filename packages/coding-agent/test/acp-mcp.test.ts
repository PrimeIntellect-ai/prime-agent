import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { resolveAcpMcpServers } from "../src/modes/acp/acp-mcp.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./suite/harness.js";

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

describe("ACP MCP servers", () => {
	it("installs session MCP config and frees the session slot when kernel release fails", async () => {
		const harness = await createHarness();
		const replace = vi.spyOn(harness.session, "replaceAcpMcpServers").mockImplementation(() => undefined);
		const release = vi
			.spyOn(harness.session, "releaseAcpMcpServers")
			.mockRejectedValueOnce(new Error("kernel release failed"))
			.mockResolvedValue(undefined);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const agentCwd = (await connection.getState()).cwd;
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "mcp-test-client" })
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		try {
			const initialized = await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);

			const created = await handle.agent.request("session/new", {
				cwd: harness.tempDir,
				mcpServers: [
					{
						type: "http",
						name: "TaskTools",
						url: "https://task.example/mcp",
						headers: [{ name: "Authorization", value: "Bearer task" }],
					},
					{
						name: "LocalTools",
						command: "node",
						args: ["server.js"],
						env: [{ name: "TASK_TOKEN", value: "task-secret" }],
					},
				],
			});
			const ownerId = replace.mock.calls[0]?.[1];
			expect(ownerId).toEqual(expect.any(String));
			expect(replace).toHaveBeenCalledWith(
				[
					{
						name: "TaskTools",
						type: "http",
						url: "https://task.example/mcp",
						headers: { Authorization: "Bearer task" },
					},
					{
						name: "LocalTools",
						type: "stdio",
						command: "node",
						args: ["server.js"],
						cwd: agentCwd,
						env: { TASK_TOKEN: "task-secret" },
					},
				],
				ownerId,
			);
			await handle.agent.request("session/close", { sessionId: created.sessionId });
			expect(release).toHaveBeenCalledWith(ownerId, ["TaskTools", "LocalTools"]);

			// The failed release is retried before a new ACP session is admitted, but it
			// must not leave the single-session slot occupied.
			const replacement = await handle.agent.request("session/new", {
				cwd: harness.tempDir,
				mcpServers: [],
			});
			expect(release).toHaveBeenCalledWith(ownerId, ["TaskTools", "LocalTools"]);
			await handle.agent.request("session/close", { sessionId: replacement.sessionId });
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
			harness.cleanup();
		}
	}, 30_000);

	it("clears owner-scoped config when daemon acknowledgement is lost", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const replace = vi.spyOn(connection, "replaceAcpMcpServers").mockImplementation(async (servers) => {
			if (servers.length > 0) throw new Error("replacement acknowledgement lost");
		});
		const release = vi.spyOn(connection, "releaseAcpMcpServers").mockResolvedValue(undefined);
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		});
		const handle = acp
			.client({ name: "mcp-lost-ack-test-client" })
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		try {
			await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			await expect(
				handle.agent.request("session/new", {
					cwd: harness.tempDir,
					mcpServers: [
						{
							type: "http",
							name: "TaskTools",
							url: "https://task.example/mcp",
							headers: [],
						},
					],
				}),
			).rejects.toThrow();

			expect(replace.mock.calls[0]?.[0]).toHaveLength(1);
			const ownerId = replace.mock.calls[0]?.[1];
			expect(ownerId).toEqual(expect.any(String));
			expect(release).toHaveBeenCalledWith(ownerId, ["TaskTools"]);
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
			harness.cleanup();
		}
	}, 30_000);

	it("preserves stdio cwd and literal environment", () => {
		const [server] = resolveAcpMcpServers(
			[
				{
					name: "TaskTools",
					command: "node",
					args: ["server.js"],
					env: [{ name: "TASK_TOKEN", value: "secret" }],
				},
			],
			"/actual/session",
		);
		expect(server).toEqual({
			name: "TaskTools",
			type: "stdio",
			command: "node",
			args: ["server.js"],
			cwd: "/actual/session",
			env: { TASK_TOKEN: "secret" },
		});
	});

	it("rejects names that could inject prompt code and ambiguous credentials", () => {
		expect(() =>
			resolveAcpMcpServers(
				[{ type: "http", name: 'bad"\nname', url: "https://task.example/mcp", headers: [] }],
				"/tmp",
			),
		).toThrow("Invalid params");
		expect(() =>
			resolveAcpMcpServers(
				[
					{
						type: "http",
						name: "task",
						url: "https://user:password@task.example/mcp",
						headers: [],
					},
				],
				"/tmp",
			),
		).toThrow("Invalid params");
		expect(() =>
			resolveAcpMcpServers(
				[
					{
						type: "http",
						name: "task",
						url: "https://task.example/mcp",
						headers: [
							{ name: "Authorization", value: "one" },
							{ name: "authorization", value: "two" },
						],
					},
				],
				"/tmp",
			),
		).toThrow("Invalid params");
	});
});
