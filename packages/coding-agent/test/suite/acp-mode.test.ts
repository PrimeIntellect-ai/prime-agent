import * as acp from "@agentclientprotocol/sdk";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
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

function injectWorkAfterHeadlessCompletion(
	connection: InProcessAgentConnection,
	session: AgentSession,
	text: string,
): () => boolean {
	const waitForHeadlessCompletion = connection.waitForHeadlessCompletion.bind(connection);
	let injected = false;
	connection.waitForHeadlessCompletion = async () => {
		const status = await waitForHeadlessCompletion();
		if (!injected) {
			injected = true;
			void session.prompt(text);
			const deadline = Date.now() + 5_000;
			while (!session.isStreaming && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(session.isStreaming).toBe(true);
		}
		return status;
	};
	return () => injected;
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

	it("queues a follow-up prompt behind injected work instead of rejecting it", async () => {
		const harness = await createHarness();
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<AssistantMessage>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			() => injectedHeld,
			fauxAssistantMessage("turn two done"),
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const injected = injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const first = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		expect(first.stopReason).toBe("end_turn");
		expect(injected()).toBe(true);
		expect(harness.session.isStreaming).toBe(true);

		let secondSettled = false;
		const second = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "Second turn" }],
			})
			.finally(() => {
				secondSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(secondSettled).toBe(false);
		releaseInjected();
		await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });

		const text = updates
			.filter((update) => update.update?.sessionUpdate === "agent_message_chunk")
			.map((update) => update.update.content.text)
			.join("");
		expect(text).toContain("turn two done");
		harness.cleanup();
	}, 5_000);

	it("reports the queued turn's stop reason from a fresh autonomous status", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxTurns: 2,
				maxContinuations: 3,
				maxTokens: 80_000,
				gates: { commands: ["true"], maxRetries: 3 },
			},
		});
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<AssistantMessage>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			() => injectedHeld,
			fauxAssistantMessage("turn two done"),
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const first = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		expect(first.stopReason).toBe("end_turn");
		expect(harness.session.getAutonomousStatus().turnsUsed).toBe(1);

		const second = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Second turn" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		releaseInjected();
		await expect(second).resolves.toMatchObject({ stopReason: "max_turn_requests" });
		expect(harness.session.getAutonomousStatus().turnsUsed).toBeGreaterThanOrEqual(
			harness.session.getAutonomousStatus().limits.maxTurns,
		);
		harness.cleanup();
	}, 5_000);

	it("does not hold the prompt response open for detached work", async () => {
		const harness = await createHarness();
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<AssistantMessage>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([fauxAssistantMessage("turn one done"), () => injectedHeld]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const injected = injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		let settled = false;
		const prompt = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "First turn" }],
			})
			.finally(() => {
				settled = true;
			});
		const deadline = Date.now() + 5_000;
		while (!injected() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(injected()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(settled).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		releaseInjected();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		harness.cleanup();
	}, 5_000);

	it("cancels a prompt that is still queued behind busy work", async () => {
		const harness = await createHarness();
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<AssistantMessage>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			() => injectedHeld,
			fauxAssistantMessage("queued turn done"),
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});

		const queued = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Second turn" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		void client.notify("session/cancel", { sessionId: session.sessionId });
		await expect(queued).resolves.toMatchObject({ stopReason: "cancelled" });
		releaseInjected();
		await new Promise((resolve) => setTimeout(resolve, 300));
		const assistantText = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message.content))
			.join("|");
		expect(assistantText).not.toContain("queued turn done");
		harness.cleanup();
	}, 5_000);
});
