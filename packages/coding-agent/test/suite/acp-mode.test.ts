import * as acp from "@agentclientprotocol/sdk";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
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
	connection.waitForHeadlessCompletion = async (options) => {
		const status = await waitForHeadlessCompletion(options);
		if (!options?.waitForRlmQuiescence && !injected) {
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

interface ClientHarnessOptions {
	beforeAcpUpdatePublish?: (update: Record<string, unknown>) => void | Promise<void>;
}

function fakeAcpConnection(
	options: {
		initialSnapshot?: () => Promise<any>;
		finalSnapshot?: () => Promise<any>;
		onPromptAndWait?: () => void | Promise<void>;
		onWaitForHeadlessCompletion?: (options?: { waitForRlmQuiescence?: boolean }) => void | Promise<void>;
		headlessStatus?: Record<string, unknown>;
		onFinalSnapshot?: () => void | Promise<void>;
		onUnsubscribe?: () => void;
		onAbort?: () => void | Promise<void>;
		onAcquireSessionInputPause?: () => void | Promise<void>;
		onReleaseSessionInputPause?: () => void | Promise<void>;
		onCancelRlmChild?: (childId: string) => void | Promise<void>;
	} = {},
): any {
	let listener: ((event: any) => void) | undefined;
	const messages: any[] = [];
	const inputPauses = new Map<string, { release(): Promise<void> }>();
	const snapshot = { state: { cwd: process.cwd() }, messages, children: [] };
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
			if (options.finalSnapshot) return options.finalSnapshot();
			return snapshot;
		},
		getRlmChildSnapshots: async () => {
			await options.onFinalSnapshot?.();
			return options.finalSnapshot ? ((await options.finalSnapshot()).children ?? []) : snapshot.children;
		},
		promptAndWait: async () => {
			await options.onPromptAndWait?.();
		},
		dispose: async () => {},
		abort: async () => {
			await options.onAbort?.();
		},
		abortAndClearQueue: async () => {
			await options.onAbort?.();
			return { followUpMessages: [], pendingMessages: [] };
		},
		acquireSessionInputPause: async (leaseKey: string) => {
			const existing = inputPauses.get(leaseKey);
			if (existing) return existing;
			await options.onAcquireSessionInputPause?.();
			const pause = {
				release: async () => {
					await options.onReleaseSessionInputPause?.();
					if (inputPauses.get(leaseKey) === pause) inputPauses.delete(leaseKey);
				},
			};
			inputPauses.set(leaseKey, pause);
			return pause;
		},
		waitForIdle: async () => {},
		cancelRlmChild: async (childId: string) => {
			await options.onCancelRlmChild?.(childId);
			return true;
		},
		waitForHeadlessCompletion: async (completionOptions?: { waitForRlmQuiescence?: boolean }) => {
			await options.onWaitForHeadlessCompletion?.(completionOptions);
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

function acpUpdatePhase(update: Record<string, unknown>): unknown {
	const metadata = update._meta as Record<string, unknown> | undefined;
	const primeMetadata = metadata?.[PRIME_AGENT_META_NAMESPACE] as Record<string, unknown> | undefined;
	return primeMetadata?.phase;
}

function connectAcpClient(connection: any, options: ClientHarnessOptions = {}): ClientHarness {
	// Two web streams crossed over: agent's stdout is the client's stdin.
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();

	const originalNotify = acp.AgentContext.prototype.notify;
	const publishSpy = options.beforeAcpUpdatePublish
		? vi.spyOn(acp.AgentContext.prototype, "notify").mockImplementation(async function (
				this: acp.AgentContext,
				method: string,
				params?: unknown,
			) {
				if (method === acp.methods.client.session.update) {
					const update = (params as { update: Record<string, unknown> }).update;
					await options.beforeAcpUpdatePublish?.(update);
				}
				return originalNotify.call(this, method, params);
			})
		: undefined;
	const agentStream = acp.ndJsonStream(toClient.writable, toAgent.readable);
	const clientStream = acp.ndJsonStream(toAgent.writable, toClient.readable);

	const updates: any[] = [];
	void runAcpModeWithConnection(connection, { stream: agentStream });

	const handle = acp
		.client({ name: "test-client" })
		.onNotification("session/update", (ctx: any) => {
			updates.push(ctx.params);
		})
		.connect(clientStream);

	// connect() yields a handle whose `agent` proxy is the outbound call surface.
	return {
		client: handle.agent,
		updates,
		close: () => {
			publishSpy?.mockRestore();
			handle.close();
		},
	};
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

		let firstSettled = false;
		const first = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "First turn" }],
			})
			.finally(() => {
				firstSettled = true;
			});
		await vi.waitFor(() => expect(injected()).toBe(true));
		expect(firstSettled).toBe(false);
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
		await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
		await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });

		const text = updates
			.filter((update) => update.update?.sessionUpdate === "agent_message_chunk")
			.map((update) => update.update.content.text)
			.join("");
		expect(text).toContain("turn two done");
		harness.cleanup();
	}, 5_000);

	it("reports the prompt stop reason from its terminal autonomous status", async () => {
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
		harness.setResponses([fauxAssistantMessage("turn one done"), () => injectedHeld]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const injected = injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		await vi.waitFor(() => expect(injected()).toBe(true));
		releaseInjected();
		await expect(prompt).resolves.toMatchObject({ stopReason: "max_turn_requests" });
		expect(harness.session.getAutonomousStatus().turnsUsed).toBeGreaterThanOrEqual(
			harness.session.getAutonomousStatus().limits.maxTurns,
		);
		harness.cleanup();
	}, 5_000);

	it("holds the prompt response open for causally admitted work", async () => {
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
		expect(settled).toBe(false);
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
		const first = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));

		const queued = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Second turn" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		void client.notify("session/cancel", { sessionId: session.sessionId });
		releaseInjected();
		await expect(first).resolves.toBeDefined();
		await expect(queued).resolves.toMatchObject({ stopReason: "cancelled" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		const assistantText = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message.content))
			.join("|");
		expect(assistantText).not.toContain("queued turn done");
		harness.cleanup();
	}, 5_000);

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
		await vi.waitFor(() =>
			expect(
				updates.some(
					(update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "terminalQuiescence",
				),
			).toBe(true),
		);
		const correlated = updates
			.map((update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.promptTurnId === 1);
		expect(correlated.map((meta) => meta.eventSequence)).toEqual(
			[...correlated.map((meta) => meta.eventSequence)].sort((a, b) => a - b),
		);
		expect(new Set(correlated.map((meta) => meta.eventSequence)).size).toBe(correlated.length);
		expect(correlated.filter((meta) => meta.phase === "responseBoundary")).toEqual([
			expect.objectContaining({ outcome: "result", terminalQuiescenceExpected: true }),
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
		await vi.waitFor(() =>
			expect(
				updates.some((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "terminalQuiescence"),
			).toBe(true),
		);
		const meta = updates.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(meta.filter((item) => item.phase === "responseBoundary")).toHaveLength(1);
		expect(meta.filter((item) => item.phase === "terminalQuiescence")).toEqual([
			expect.objectContaining({
				quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 2 },
			}),
		]);
		close();
	});

	it("reports a descendant-driven parent failure in the terminal outcome", async () => {
		const connection = fakeAcpConnection({
			onWaitForHeadlessCompletion: (options) => {
				if (!options?.waitForRlmQuiescence) return;
				connection.messages.push({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "child continuation failed",
					timestamp: Date.now(),
				});
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "delegate" }],
			}),
		).rejects.toThrow();
		await vi.waitFor(() =>
			expect(
				updates
					.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
					.find((meta) => meta?.phase === "terminalQuiescence"),
			).toMatchObject({ promptTurnId: 1, outcome: "error" }),
		);
		close();
	});

	it("finalizes a child-backed turn only after the strong RLM barrier", async () => {
		const child = { id: "child-1", label: "child", status: "running", sessionDir: "/tmp/child" };
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		let roster = [{ ...child, status: "done" }];
		let promptCalls = 0;
		let connection: any;
		connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: roster }),
			onPromptAndWait: () => {
				promptCalls++;
				if (promptCalls === 1) connection.emitChild(child);
			},
			onWaitForHeadlessCompletion: async (options) => {
				if (options?.waitForRlmQuiescence) await barrier;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		let firstSettled = false;
		const firstPrompt = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "delegate" }],
			})
			.finally(() => {
				firstSettled = true;
			});
		await vi.waitFor(() => expect(promptCalls).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(firstSettled).toBe(false);

		let metadata = updates.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(metadata.filter((item) => item.phase === "terminalQuiescence")).toHaveLength(0);
		const nextPrompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "wait for the child" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(promptCalls).toBe(1);

		roster = [{ ...child, status: "done" }];
		connection.emitChild(roster[0]);
		releaseBarrier();
		await vi.waitFor(() => {
			metadata = updates.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
			expect(metadata.filter((item) => item.phase === "terminalQuiescence" && item.promptTurnId === 1)).toEqual([
				expect.objectContaining({
					promptTurnId: 1,
					outcome: "result",
					quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
				}),
			]);
		});
		const sequences = metadata.map((item) => item.eventSequence);
		expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
		await expect(firstPrompt).resolves.toBeDefined();
		await nextPrompt;
		expect(promptCalls).toBe(2);
		close();
	});

	it("does not admit the next prompt while terminal settlement is still publishing", async () => {
		let terminalPublicationStarted!: () => void;
		let releaseTerminalPublication!: () => void;
		const terminalPublicationStart = new Promise<void>((resolve) => {
			terminalPublicationStarted = resolve;
		});
		const terminalPublicationRelease = new Promise<void>((resolve) => {
			releaseTerminalPublication = resolve;
		});
		let promptCalls = 0;
		let blockTerminalPublication = true;
		const connection = fakeAcpConnection({
			onPromptAndWait: () => {
				promptCalls++;
			},
		});
		const { client, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async (update) => {
				if (acpUpdatePhase(update) !== "terminalQuiescence" || !blockTerminalPublication) return;
				blockTerminalPublication = false;
				terminalPublicationStarted();
				await terminalPublicationRelease;
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const first = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "first" }],
		});
		await terminalPublicationStart;
		const second = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "second" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const promptCallsBeforeSettlement = promptCalls;

		releaseTerminalPublication();
		await expect(first).resolves.toBeDefined();
		await expect(second).resolves.toBeDefined();
		expect(promptCallsBeforeSettlement).toBe(1);
		expect(promptCalls).toBe(2);
		close();
	});

	it("coalesces duplicate cancellation notifications under one stop owner", async () => {
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		let abortCalls = 0;
		let abortEntered!: () => void;
		const abortStarted = new Promise<void>((resolve) => {
			abortEntered = resolve;
		});
		const connection = fakeAcpConnection({
			onWaitForHeadlessCompletion: async (options) => {
				if (options?.waitForRlmQuiescence) await barrier;
			},
			onAbort: async () => {
				abortCalls++;
				abortEntered();
				await abortGate;
				releaseBarrier();
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel twice" }],
		});
		await vi.waitFor(() =>
			expect(
				updates.some((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "responseBoundary"),
			).toBe(true),
		);
		await client.notify("session/cancel", { sessionId: session.sessionId });
		await abortStarted;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		await Promise.resolve();
		expect(abortCalls).toBe(1);
		releaseAbort();
		await expect(prompt).resolves.toBeDefined();
		await vi.waitFor(async () => {
			await expect(
				client.request("session/prompt", {
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "after duplicate cancel" }],
				}),
			).resolves.toBeDefined();
		});
		close();
	});

	it("cancels deferred child work before reopening prompt admission", async () => {
		const child = { id: "child-cancel", label: "child", status: "running", sessionDir: "/tmp/child" };
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		let abortObserved!: () => void;
		const aborted = new Promise<void>((resolve) => {
			abortObserved = resolve;
		});
		let roster = [child];
		let connection: any;
		connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: roster }),
			onPromptAndWait: () => connection.emitChild(child),
			onWaitForHeadlessCompletion: async (options) => {
				if (options?.waitForRlmQuiescence) await barrier;
			},
			onCancelRlmChild: () => {
				roster = [{ ...child, status: "cancelled" }];
				connection.emitChild(roster[0]);
				releaseBarrier();
			},
			onAbort: () => abortObserved(),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "delegate" }],
		});
		await vi.waitFor(() =>
			expect(
				updates.some((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "responseBoundary"),
			).toBe(true),
		);
		await client.notify("session/cancel", { sessionId: session.sessionId });
		await aborted;
		await expect(prompt).resolves.toBeDefined();

		const firstTurnTerminal = updates
			.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.promptTurnId === 1 && meta.phase === "terminalQuiescence");
		expect(firstTurnTerminal).toHaveLength(0);
		await vi.waitFor(async () => {
			await expect(
				client.request("session/prompt", {
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "after cancellation" }],
				}),
			).resolves.toBeDefined();
		});
		close();
	});

	it("reports cancellation while terminal settlement is still pending", async () => {
		let terminalSettlementStarted!: () => void;
		let releaseTerminalSettlement!: () => void;
		const terminalSettlementStart = new Promise<void>((resolve) => {
			terminalSettlementStarted = resolve;
		});
		const terminalSettlementRelease = new Promise<void>((resolve) => {
			releaseTerminalSettlement = resolve;
		});
		const connection = fakeAcpConnection({
			onWaitForHeadlessCompletion: async (options) => {
				if (!options?.waitForRlmQuiescence) return;
				terminalSettlementStarted();
				await terminalSettlementRelease;
			},
			onAbort: () => releaseTerminalSettlement(),
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "cancel during terminal settlement" }],
		});

		await terminalSettlementStart;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
		close();
	});

	it("closes a pending child lifecycle without publishing a false terminal", async () => {
		const child = { id: "child-close", label: "child", status: "running", sessionDir: "/tmp/child" };
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		let connection: any;
		connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [child] }),
			onPromptAndWait: () => connection.emitChild(child),
			onWaitForHeadlessCompletion: async (options) => {
				if (options?.waitForRlmQuiescence) await barrier;
			},
			onCancelRlmChild: () => releaseBarrier(),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "delegate" }],
		});
		await vi.waitFor(() =>
			expect(
				updates.some((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "responseBoundary"),
			).toBe(true),
		);
		const closing = client.request("session/close", { sessionId: session.sessionId });
		await expect(prompt).resolves.toBeDefined();
		await closing;
		await Promise.resolve();

		const terminal = updates
			.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.phase === "terminalQuiescence");
		expect(terminal).toHaveLength(0);
		close();
	});

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

	it("keeps a live child update newer than the in-flight initial snapshot", async () => {
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
				emitChild({ id: "during-snapshot", label: "during snapshot", status: "done", sessionDir: "/tmp/child" });
				snapshotEventEmitted();
				await snapshotReleased;
				return {
					state: { cwd: process.cwd() },
					messages: [],
					children: [
						{ id: "during-snapshot", label: "during snapshot", status: "running", sessionDir: "/tmp/child" },
					],
				};
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
			update: {
				_meta: {
					[PRIME_AGENT_META_NAMESPACE]: {
						eventSequence: 1,
						promptTurnId: 0,
						subagents: [expect.objectContaining({ id: "during-snapshot", status: "done" })],
					},
				},
			},
		});
		close();
	});

	it("publishes and seeds the authoritative initial child roster at turn zero", async () => {
		const child = { id: "resident-child", label: "resident child", status: "running", sessionDir: "/tmp/child" };
		let connection: any;
		connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [child] }),
			onPromptAndWait: () => connection.emitChild({ ...child, status: "done" }),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "continue" }],
		});
		const childMeta = updates
			.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE])
			.filter((meta) => meta?.subagents);
		expect(childMeta.map((meta) => meta.promptTurnId)).toEqual([0, 0]);
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
				terminalQuiescenceExpected: false,
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
		await vi.waitFor(() =>
			expect(
				updates.filter((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.phase === "terminalQuiescence"),
			).toHaveLength(2),
		);
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

	it("holds the backing input fence from close until replacement session admission", async () => {
		let acquired = 0;
		let released = 0;
		const connection = fakeAcpConnection({
			onAcquireSessionInputPause: () => {
				acquired++;
			},
			onReleaseSessionInputPause: () => {
				released++;
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const first = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/close", { sessionId: first.sessionId });
		expect({ acquired, released }).toEqual({ acquired: 1, released: 0 });

		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).resolves.toBeDefined();
		expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });
		close();
	});

	it("retries the same input fence when replacement admission cannot release it", async () => {
		let acquired = 0;
		let releaseAttempts = 0;
		const connection = fakeAcpConnection({
			onAcquireSessionInputPause: () => {
				acquired++;
			},
			onReleaseSessionInputPause: () => {
				releaseAttempts++;
				if (releaseAttempts === 1) throw new Error("release response lost");
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });

		await expect(client.request("session/close", { sessionId: session.sessionId })).resolves.toEqual({});
		const replacement = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: replacement.sessionId,
				prompt: [{ type: "text", text: "still fenced" }],
			}),
		).rejects.toThrow();
		await client.notify("session/cancel", { sessionId: replacement.sessionId });
		await vi.waitFor(async () => {
			await expect(
				client.request("session/prompt", {
					sessionId: replacement.sessionId,
					prompt: [{ type: "text", text: "released on retry" }],
				}),
			).resolves.toBeDefined();
		});
		expect({ acquired, releaseAttempts }).toEqual({ acquired: 1, releaseAttempts: 2 });
		close();
	});

	it("keeps failed close state fenced and recoverable through cancellation", async () => {
		let abortAttempts = 0;
		let unsubscribeAttempts = 0;
		const connection = fakeAcpConnection({
			onAbort: () => {
				abortAttempts++;
				if (abortAttempts === 1) throw new Error("transient stop failure");
			},
			onUnsubscribe: () => {
				unsubscribeAttempts++;
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });

		await expect(client.request("session/close", { sessionId: session.sessionId })).rejects.toThrow();
		expect(unsubscribeAttempts).toBe(0);
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "must remain closed to prompts" }],
			}),
		).rejects.toThrow();

		await client.notify("session/cancel", { sessionId: session.sessionId });
		await vi.waitFor(() => expect(abortAttempts).toBe(2));
		const updatesBeforeHeartbeat = updates.length;
		connection.emitHeartbeat();
		await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updatesBeforeHeartbeat));
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "admitted after successful reconciliation" }],
			}),
		).resolves.toBeDefined();

		await expect(client.request("session/close", { sessionId: session.sessionId })).resolves.toEqual({});
		expect(abortAttempts).toBe(3);
		expect(unsubscribeAttempts).toBe(1);
		close();
	});

	it("reconciles cancellation that arrives during a failed close", async () => {
		let abortAttempts = 0;
		let firstAbortStarted!: () => void;
		let releaseFirstAbort!: () => void;
		const firstAbortEntered = new Promise<void>((resolve) => {
			firstAbortStarted = resolve;
		});
		const firstAbortGate = new Promise<void>((resolve) => {
			releaseFirstAbort = resolve;
		});
		const connection = fakeAcpConnection({
			onAbort: async () => {
				abortAttempts++;
				if (abortAttempts !== 1) return;
				firstAbortStarted();
				await firstAbortGate;
				throw new Error("transient stop failure");
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });

		const closing = client.request("session/close", { sessionId: session.sessionId });
		await firstAbortEntered;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		releaseFirstAbort();
		await expect(closing).rejects.toThrow();
		await vi.waitFor(() => expect(abortAttempts).toBe(2));
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "admitted after queued cancellation" }],
			}),
		).resolves.toBeDefined();
		await expect(client.request("session/close", { sessionId: session.sessionId })).resolves.toEqual({});
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
		connection.emitHeartbeat();
		const closing = client.request("session/close", { sessionId: session.sessionId });
		await Promise.resolve();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "must not start while closing" }],
			}),
		).rejects.toThrow();
		release();
		await closing;
		expect(updates).toHaveLength(2);
		await Promise.resolve();
		expect(updates).toHaveLength(2);
		close();
	});

	it("keeps the session slot reserved until close finishes aborting", async () => {
		let promptStarted!: () => void;
		let releasePrompt!: () => void;
		let abortStarted!: () => void;
		let releaseAbort!: () => void;
		const promptStart = new Promise<void>((resolve) => {
			promptStarted = resolve;
		});
		const promptRelease = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const abortStart = new Promise<void>((resolve) => {
			abortStarted = resolve;
		});
		const abortRelease = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		const connection = fakeAcpConnection({
			onPromptAndWait: async () => {
				promptStarted();
				await promptRelease;
			},
			onAbort: async () => {
				abortStarted();
				await abortRelease;
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		await promptStart;
		const closing = client.request("session/close", { sessionId: session.sessionId });
		await abortStart;
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		releaseAbort();
		releasePrompt();
		await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
		await expect(closing).resolves.toEqual({});
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

	it("does not relabel a nonterminal completion when cancellation races its boundary", async () => {
		let entered!: () => void;
		let release!: () => void;
		const enteredBoundary = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releaseBoundary = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = fakeAcpConnection({
			finalSnapshot: async () => ({
				state: { cwd: process.cwd() },
				messages: [],
				children: [{ id: "live-child", label: "live", status: "running", sessionDir: "/tmp/child" }],
			}),
		});
		const { client, updates, close } = connectAcpClient(connection, {
			beforeAcpUpdatePublish: async (update) => {
				if (acpUpdatePhase(update) === "responseBoundary") {
					entered();
					await releaseBoundary;
				}
			},
		});
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const pending = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "gate nonterminal boundary" }],
		});
		await enteredBoundary;
		await client.notify("session/cancel", { sessionId: session.sessionId });
		release();
		await expect(pending).resolves.not.toMatchObject({ stopReason: "cancelled" });
		const meta = updates.map((item) => item.update?._meta?.[PRIME_AGENT_META_NAMESPACE]).filter(Boolean);
		expect(meta).toContainEqual(expect.objectContaining({ phase: "responseBoundary", outcome: "result" }));
		expect(meta).toContainEqual(
			expect.objectContaining({ phase: "event", quiescence: expect.objectContaining({ outstandingSubagents: 1 }) }),
		);
		close();
	});

	it("does not invent terminal quiescence after cancellation crosses the response boundary", async () => {
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
			beforeAcpUpdatePublish: async (update) => {
				if (acpUpdatePhase(update) === "responseBoundary") {
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
		expect(meta.filter((item) => item.phase === "terminalQuiescence")).toEqual([]);
		close();
	});
});
