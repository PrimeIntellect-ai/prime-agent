import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
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

function fakeAcpConnection(
	options: {
		initialSnapshot?: () => Promise<any>;
		finalSnapshot?: () => Promise<any>;
		onPromptAndWait?: () => void | Promise<void>;
		onWaitForHeadlessCompletion?: () => void | Promise<void>;
		headlessStatus?: Record<string, unknown>;
		onFinalSnapshot?: () => void | Promise<void>;
		onUnsubscribe?: () => void;
	} = {},
): any {
	let listener: ((event: any) => void) | undefined;
	const messages: any[] = [];
	const snapshot = { state: { cwd: process.cwd() }, messages };
	return {
		subscribe(callback: (event: any) => void) {
			listener = callback;
			return () => {
				listener = undefined;
				options.onUnsubscribe?.();
			};
		},
		getState: async () => snapshot.state,
		getMessages: async () => messages,
		getInitialSnapshot: async () => {
			if (options.initialSnapshot) {
				const result = await options.initialSnapshot();
				options.initialSnapshot = undefined;
				return result;
			}
			if (options.finalSnapshot) {
				await options.onFinalSnapshot?.();
				return options.finalSnapshot();
			}
			return snapshot;
		},
		promptAndWait: async () => {
			await options.onPromptAndWait?.();
		},
		dispose: async () => {},
		abort: async () => {},
		waitForHeadlessCompletion: async () => {
			await options.onWaitForHeadlessCompletion?.();
			return {
				enabled: false,
				continuationsUsed: 0,
				turnsUsed: 0,
				tokensUsed: 0,
				limits: { maxContinuations: 0 },
				...options.headlessStatus,
			};
		},
		emitChild(child: any) {
			listener?.({ type: "session_event", event: { type: "rlm_child_update", child } });
		},
		emitHeartbeat() {
			listener?.({ type: "heartbeats_changed" });
		},
		messages,
	};
}

function connectAcpClient(connection: any, options: Record<string, unknown> = {}): ClientHarness {
	// Two web streams crossed over: agent's stdout is the client's stdin.
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();

	const agentStream = acp.ndJsonStream(toClient.writable, toAgent.readable);
	const clientStream = acp.ndJsonStream(toAgent.writable, toClient.readable);

	const updates: any[] = [];
	void runAcpModeWithConnection(connection, { stream: agentStream, ...options } as any);

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

	it("emits score-safe quiescence metadata with outstanding work and budget", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish" }],
		});
		const correlated = updates
			.map((update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.promptTurnId === 1);
		expect(correlated.map((meta) => meta.eventSequence)).toEqual(
			[...correlated.map((meta) => meta.eventSequence)].sort((a, b) => a - b),
		);
		expect(new Set(correlated.map((meta) => meta.eventSequence)).size).toBe(correlated.length);
		expect(correlated.filter((meta) => meta.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "result" }),
		]);
		const terminalIndex = correlated.findIndex((meta) => meta.phase === "terminalQuiescence");
		expect(terminalIndex).toBeGreaterThan(correlated.findIndex((meta) => meta.phase === "responseBoundary"));
		expect(correlated[terminalIndex].quiescence).toEqual({
			outstandingSubagents: 0,
			remainingAutonomousContinuations: 0,
		});
		harness.cleanup();
	}, 30_000);

	it("treats unused autonomous capacity as terminal lifecycle telemetry", async () => {
		const connection = fakeAcpConnection({
			headlessStatus: {
				enabled: true,
				continuationsUsed: 1,
				gateAttempts: {},
				limits: { maxContinuations: 3 },
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish" }],
		});
		const meta = updates.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(meta.filter((item) => item.phase === "responseBoundary")).toHaveLength(1);
		expect(meta.filter((item) => item.phase === "terminalQuiescence")).toEqual([
			expect.objectContaining({
				quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 2 },
			}),
		]);
		close();
	});

	it("does not emit terminal quiescence when a lifecycle-filtered parent leaves a live grandchild", async () => {
		const connection = fakeAcpConnection({
			finalSnapshot: async () => ({
				state: { cwd: process.cwd() },
				messages: [],
				children: [
					{
						id: "live-grandchild",
						parentId: "deleted-parent",
						sessionName: "live-grandchild",
						label: "still working",
						status: "running",
						sessionDir: "/tmp/live-grandchild",
					},
				],
			}),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish" }],
		});
		const metadata = updates.map((update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.some((meta) => meta.phase === "terminalQuiescence")).toBe(false);
		expect(metadata.find((meta) => meta.quiescence)?.quiescence.outstandingSubagents).toBe(1);
		close();
	});

	it("reports a live in-process child that spawned after ACP attached", async () => {
		const harness = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		let releaseChild!: () => void;
		const childReleased = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		harness.setResponses([
			async () => {
				await childReleased;
				return fauxAssistantMessage("child done");
			},
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		await harness.session.runRlmChild("continue in the background");
		harness.appendResponses([fauxAssistantMessage("parent done")]);
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish the parent turn" }],
		});
		const quiescence = updates.find((update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence);
		const meta = quiescence?.update?._meta?.[PRIME_AGENT_META_NAMESPACE];
		expect(meta?.quiescence.outstandingSubagents).toBe(1);
		expect(meta?.phase).toBe("event");

		releaseChild();
		await vi.waitFor(() => expect(harness.session.getRlmChildSnapshots()[0]?.status).toBe("done"));
		harness.cleanup();
	}, 30_000);

	it("releases the subscription when the initial roster snapshot fails", async () => {
		let unsubscribeCount = 0;
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				throw new Error("snapshot unavailable");
			},
			onUnsubscribe: () => {
				unsubscribeCount += 1;
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		expect(unsubscribeCount).toBe(1);
		close();
	});

	it("rejects a concurrent session creation while the first snapshot is pending", async () => {
		let enteredSnapshot!: () => void;
		let releaseSnapshot!: () => void;
		const snapshotEntered = new Promise<void>((resolve) => {
			enteredSnapshot = resolve;
		});
		const snapshotReleased = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				enteredSnapshot();
				await snapshotReleased;
				return { state: { cwd: process.cwd() }, messages: [], children: [] };
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const first = client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await snapshotEntered;
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		releaseSnapshot();
		await expect(first).resolves.toMatchObject({ sessionId: expect.any(String) });
		close();
	});

	it("buffers subscription updates until the session/new response commits", async () => {
		let emitChild: (child: any) => void = () => {};
		let releaseSnapshot!: () => void;
		let snapshotEventEmitted!: () => void;
		const snapshotReleased = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const snapshotEvent = new Promise<void>((resolve) => {
			snapshotEventEmitted = resolve;
		});
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				emitChild({ id: "during-snapshot", label: "during snapshot", status: "running", sessionDir: "/tmp/child" });
				snapshotEventEmitted();
				await snapshotReleased;
				return { state: { cwd: process.cwd() }, messages: [], children: [] };
			},
		});
		const originalSubscribe = connection.subscribe.bind(connection);
		connection.subscribe = (listener: (event: any) => void) => {
			emitChild = (child) => listener({ type: "session_event", event: { type: "rlm_child_update", child } });
			return originalSubscribe(listener);
		};
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const pending = client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await snapshotEvent;
		expect(updates).toHaveLength(0);
		releaseSnapshot();
		const session = await pending;
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0]).toMatchObject({
			sessionId: session.sessionId,
			update: { _meta: { [PRIME_AGENT_META_NAMESPACE]: { eventSequence: 1, promptTurnId: 0 } } },
		});
		close();
	});

	it("captures an autonomous continuation error after headless completion", async () => {
		let connection: any;
		connection = fakeAcpConnection({
			onWaitForHeadlessCompletion: () => {
				connection.messages.push({
					role: "assistant",
					timestamp: Date.now(),
					stopReason: "error",
					errorMessage: "autonomous continuation failed",
				});
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "finish" }],
			}),
		).rejects.toThrow("Internal error");
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.filter((meta) => meta.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "error" }),
		]);
		expect(metadata.filter((meta) => meta.phase === "terminalQuiescence")).toEqual([
			expect.objectContaining({ outcome: "error" }),
		]);
		close();
	});

	it("propagates a failed roster read at quiescence emission", async () => {
		const connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => {
				throw new Error("roster unavailable");
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "finish" }],
			}),
		).rejects.toThrow();
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata).toContainEqual(
			expect.objectContaining({
				promptTurnId: 1,
				phase: "responseBoundary",
				outcome: "error",
			}),
		);
		expect(metadata.find((meta) => meta.phase === "terminalQuiescence")).toBeUndefined();
		close();
	});

	it("keeps global sequences and causal turn ids across sequential prompts", async () => {
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "first" }],
		});
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "second" }],
		});
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		const sequences = metadata.map((meta) => meta.eventSequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(metadata.filter((meta) => meta.phase === "responseBoundary").map((meta) => meta.promptTurnId)).toEqual([
			1, 2,
		]);
		expect(metadata.filter((meta) => meta.phase === "terminalQuiescence").map((meta) => meta.promptTurnId)).toEqual([
			1, 2,
		]);
		close();
	});

	it("moves a retained child update after terminal to safe turn zero", async () => {
		const child = { id: "child-1", label: "child", status: "running", sessionDir: "/tmp/child" };
		let connection: any;
		connection = fakeAcpConnection({
			onPromptAndWait: () => connection.emitChild(child),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "first" }],
		});
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "second" }],
		});
		connection.emitChild({ ...child, status: "done" });
		await vi.waitFor(() =>
			expect(
				updates.some(
					(u) =>
						u.update?.sessionUpdate === "session_info_update" &&
						u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.subagents,
				),
			).toBe(true),
		);
		const childUpdates = updates
			.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.subagents);
		expect(childUpdates.map((meta) => meta.promptTurnId)).toEqual([1, 0]);
		expect(childUpdates.map((meta) => meta.phase)).toEqual(["event", "event"]);
		close();
	});

	it("preserves a child first observed between prompts as connection-scoped", async () => {
		const child = { id: "between-prompts", label: "child", status: "running", sessionDir: "/tmp/child" };
		let connection: any;
		connection = fakeAcpConnection({
			onPromptAndWait: () => connection.emitChild({ ...child, status: "done" }),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitChild(child);
		await vi.waitFor(() =>
			expect(updates.some((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.subagents)).toBe(true),
		);
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "complete" }],
		});
		const childUpdates = updates
			.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.subagents?.[0]?.id === child.id);
		expect(childUpdates.map((meta) => meta.promptTurnId)).toEqual([0, 0]);
		close();
	});

	it("makes a child first observed after terminal connection-scoped", async () => {
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "complete" }],
		});
		connection.emitChild({ id: "late", label: "late", status: "running", sessionDir: "/tmp/late" });
		await vi.waitFor(() =>
			expect(updates.some((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.subagents)).toBe(true),
		);
		const late = updates
			.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.find((meta) => meta?.subagents?.[0]?.id === "late");
		expect(late).toMatchObject({ promptTurnId: 0, phase: "event" });
		close();
	});

	it("drains an earlier backpressured update before cancellation after the initial transcript read", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredPublish = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePublish = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async () => {
				entered();
				await releasePublish;
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitHeartbeat();
		await enteredPublish;
		connection.getMessages = async () => {
			await client.notify("session/cancel", { sessionId: session.sessionId });
			return [];
		};
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel" }],
		});
		await Promise.resolve();
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(updates.map((update) => update.update?.sessionUpdate)).toEqual(["session_info_update"]);
		close();
	});

	it("recovers the update queue after a failed publish hook", async () => {
		let rejectOnce = true;
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: () => {
				if (!rejectOnce) return;
				rejectOnce = false;
				throw new Error("publish hook failed");
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitHeartbeat();
		connection.emitHeartbeat();
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0].update?._meta?.[PRIME_AGENT_META_NAMESPACE]).toMatchObject({ eventSequence: 2 });
		await expect(client.request("session/close", { sessionId: session.sessionId })).resolves.toEqual({});
		close();
	});

	it("reports a failed response-boundary publish instead of completing without an envelope", async () => {
		let rejectBoundary = true;
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: (update: any) => {
				if (!rejectBoundary || update._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase !== "responseBoundary") return;
				rejectBoundary = false;
				throw new Error("drop response boundary");
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "finish" }],
			}),
		).rejects.toThrow("Internal error");
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.filter((meta) => meta.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "error" }),
		]);
		expect(metadata.find((meta) => meta.phase === "terminalQuiescence")).toBeUndefined();
		close();
	});

	it("settles queued updates before close resolves without a post-close notification", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredPublish = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePublish = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async () => {
				entered();
				await releasePublish;
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitHeartbeat();
		await enteredPublish;
		const closing = client.request("session/close", { sessionId: session.sessionId });
		await Promise.resolve();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		await closing;
		expect(updates).toHaveLength(1);
		await Promise.resolve();
		expect(updates).toHaveLength(1);
		close();
	});

	it("closes update admission before an in-flight prompt can finish", async () => {
		let entered!: () => void;
		let release!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const promptRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection({
			onPromptAndWait: async () => {
				entered();
				await promptRelease;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish after close" }],
		});
		await promptStarted;
		await expect(client.request("session/close", { sessionId: session.sessionId })).resolves.toEqual({});
		const updatesAtClose = updates.length;
		release();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		await Promise.resolve();
		expect(updates).toHaveLength(updatesAtClose);
		close();
	});

	it("cancels after prompt completion without emitting a result or terminal boundary", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredPrompt = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePrompt = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection({
			onPromptAndWait: async () => {
				entered();
				await releasePrompt;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel" }],
		});
		await enteredPrompt;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.some((meta) => meta.phase === "responseBoundary" && meta.outcome === "result")).toBe(false);
		expect(metadata.some((meta) => meta.phase === "terminalQuiescence")).toBe(false);
		close();
	});

	it("cancels during headless completion without any completion envelope", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredWait = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releaseWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection({
			onWaitForHeadlessCompletion: async () => {
				entered();
				await releaseWait;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel in headless" }],
		});
		await enteredWait;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.some((meta) => meta.phase === "responseBoundary" || meta.phase === "terminalQuiescence")).toBe(
			false,
		);
		close();
	});

	it("cancels during the authoritative final snapshot without any completion envelope", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredSnapshot = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releaseSnapshot = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			onFinalSnapshot: async () => {
				entered();
				await releaseSnapshot;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel in snapshot" }],
		});
		await enteredSnapshot;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		const metadata = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.some((meta) => meta.phase === "responseBoundary" || meta.phase === "terminalQuiescence")).toBe(
			false,
		);
		close();
	});

	it("drains queued updates before returning cancellation at the final snapshot cut", async () => {
		let enteredUpdate!: () => void;
		let releaseUpdate!: () => void;
		let enteredSnapshot!: () => void;
		let releaseSnapshot!: () => void;
		const updateStarted = new Promise<void>((resolve) => {
			enteredUpdate = resolve;
		});
		const updateRelease = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		const snapshotStarted = new Promise<void>((resolve) => {
			enteredSnapshot = resolve;
		});
		const snapshotRelease = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			onFinalSnapshot: async () => {
				enteredSnapshot();
				await snapshotRelease;
			},
		});
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async () => {
				enteredUpdate();
				await updateRelease;
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitHeartbeat();
		await updateStarted;
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel after final snapshot" }],
		});
		await snapshotStarted;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		releaseSnapshot();
		await Promise.resolve();
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseUpdate();
		await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
		expect(updates).toHaveLength(1);
		close();
	});

	it("linearizes a cancellation during the response-boundary publish as a completed pair", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredBoundary = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releaseBoundary = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async (update: any) => {
				if (update._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "responseBoundary") {
					entered();
					await releaseBoundary;
				}
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "gate boundary" }],
		});
		await enteredBoundary;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		const result = await pending;
		expect(result.stopReason).not.toBe("cancelled");
		const meta = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(meta.filter((item) => item.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "result" }),
		]);
		expect(meta.filter((item) => item.phase === "terminalQuiescence")).toEqual([
			expect.objectContaining({
				outcome: "result",
				quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
			}),
		]);
		close();
	});

	it("keeps a terminal publish sealed when its last originated child finishes", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredTerminal = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releaseTerminal = new Promise<void>((resolve) => {
			release = resolve;
		});
		const child = { id: "terminal-race-child", label: "child", status: "running", sessionDir: "/tmp/child" };
		let connection: any;
		connection = fakeAcpConnection({
			onPromptAndWait: () => connection.emitChild(child),
		});
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async (update: any) => {
				if (update._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "terminalQuiescence") {
					entered();
					await releaseTerminal;
				}
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "gate terminal" }],
		});
		await enteredTerminal;
		connection.emitChild({ ...child, status: "done" });
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		const result = await pending;
		expect(result.stopReason).not.toBe("cancelled");
		const meta = updates.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(meta.filter((item) => item.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "result" }),
		]);
		expect(meta.filter((item) => item.phase === "terminalQuiescence")).toEqual([
			expect.objectContaining({
				outcome: "result",
				quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
			}),
		]);
		const childUpdates = meta.filter((item) => item.subagents?.[0]?.id === child.id);
		expect(childUpdates.map((item) => item.promptTurnId)).toEqual([1, 0]);
		close();
	});

	it("correlates connection-scoped heartbeats to turn zero", async () => {
		const connection = fakeAcpConnection();
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		connection.emitHeartbeat();
		await vi.waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0].update._meta[PRIME_AGENT_META_NAMESPACE]).toMatchObject({
			promptTurnId: 0,
			phase: "event",
			eventSequence: 1,
		});
		close();
	});
});
