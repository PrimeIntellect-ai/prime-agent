import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { CompactionResult } from "../src/core/compaction/index.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-concurrent-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		delete (globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi;
		delete (globalThis as typeof globalThis & { testCommandRuns?: unknown }).testCommandRuns;
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	it("awaits asynchronous dispose callbacks during graceful disposal", async () => {
		createSession();
		let releaseCallback: () => void = () => {};
		const callbackGate = new Promise<void>((resolve) => {
			releaseCallback = resolve;
		});
		let callbackStarted = false;
		session.registerDisposeCallback(async () => {
			callbackStarted = true;
			await callbackGate;
		});

		let disposed = false;
		const disposal = session.disposeAsync().then(() => {
			disposed = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(callbackStarted).toBe(true);
		expect(disposed).toBe(false);
		releaseCallback();
		await disposal;
		expect(disposed).toBe(true);
	});

	it("awaits dispose callbacks when synchronous disposal wins during the refinement drain", async () => {
		createSession();
		let releaseDrain: () => void = () => {};
		const drainGate = new Promise<void>((resolve) => {
			releaseDrain = resolve;
		});
		let drainStarted = false;
		const internals = session as unknown as {
			_drainPendingRefinementForDisposal: () => Promise<void>;
		};
		vi.spyOn(internals, "_drainPendingRefinementForDisposal").mockImplementation(async () => {
			drainStarted = true;
			await drainGate;
		});

		let releaseCallback: () => void = () => {};
		const callbackGate = new Promise<void>((resolve) => {
			releaseCallback = resolve;
		});
		let callbackStarted = false;
		session.registerDisposeCallback(async () => {
			callbackStarted = true;
			await callbackGate;
		});

		let disposed = false;
		const disposal = session.disposeAsync().then(() => {
			disposed = true;
		});
		await vi.waitFor(() => expect(drainStarted).toBe(true));
		session.dispose();
		expect(callbackStarted).toBe(true);

		releaseDrain();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(disposed).toBe(false);
		releaseCallback();
		await disposal;
		expect(disposed).toBe(true);
	});

	it("should throw when prompt() called while streaming", async () => {
		createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		await expect(session.prompt("Second message")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow steer() while streaming", async () => {
		createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(() => session.steer("Steering message")).not.toThrow();
		expect(session.queuedActionCount).toBe(1);

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow followUp() while streaming", async () => {
		createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(() => session.followUp("Follow-up message")).not.toThrow();
		expect(session.queuedActionCount).toBe(1);

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should queue extension-origin steering messages while streaming", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;
		let sawSteeringMessage = false;
		let lastInputSource: string | undefined;
		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) => {
							if (typeof message.content === "string") {
								return message.content;
							}
							return message.content
								.filter((part): part is TextContent | ImageContent => typeof part === "object" && part !== null)
								.filter((part): part is TextContent => part.type === "text")
								.map((part) => part.text)
								.join("\n");
						});

					if (userTexts.includes("Steer from extension")) {
						sawSteeringMessage = true;
						stream.push({ type: "start", partial: createAssistantMessage("") });
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Steered") });
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				(globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi = pi;
			},
			(pi) => {
				pi.on("input", async (event) => {
					lastInputSource = event.source;
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		session.subscribe((event) => {
			if (event.type === "session_action_update") {
				queueEvents.push({ steering: event.actions.steering, followUp: event.actions.followUps });
			}
		});

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		const pi = (
			globalThis as typeof globalThis & {
				testExtensionApi?: {
					sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
				};
			}
		).testExtensionApi;
		expect(pi).toBeDefined();

		pi!.sendUserMessage("Steer from extension", { deliverAs: "steer" });
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(session.queuedActionCount).toBe(1);
		expect(session.getSteeringMessages()).toContain("Steer from extension");
		expect(lastInputSource).toBe("extension");
		expect(queueEvents.some((event) => event.steering.includes("Steer from extension"))).toBe(true);

		await session.abort();
		await firstPrompt.catch(() => {});

		expect(sawSteeringMessage).toBe(false);
		expect(session.getSteeringMessages()).toContain("Steer from extension");
		expect(session.queuedActionCount).toBe(1);

		await session.prompt("After abort");

		expect(sawSteeringMessage).toBe(true);
		expect(session.queuedActionCount).toBe(0);
	});

	it("delivers accepted agent messages without extension input interception", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let inputCalls = 0;
		let receivedUserText: string | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userMessages = context.messages.filter((message) => message.role === "user");
					const user = userMessages.at(-1);
					if (user && typeof user.content !== "string") {
						receivedUserText = user.content
							.filter(
								(part): part is TextContent =>
									typeof part === "object" && part !== null && part.type === "text",
							)
							.map((part) => part.text)
							.join("\n");
					}
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Delivered") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("input", async () => {
					inputCalls++;
					return { action: "handled" };
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		await session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await session.agent.waitForIdle();

		expect(inputCalls).toBe(0);
		expect(receivedUserText).toBe("agent-to-agent payload");
	});

	it("queues an agent message behind an active turn", async () => {
		createSession();
		const activeTurn = session.prompt("active turn");
		await vi.waitFor(() => expect(session.isStreaming).toBe(true));
		let queued: boolean | undefined;

		await session.acceptAgentMessagePrompt("message during turn", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				queued = didQueue;
			},
		});

		expect(queued).toBe(true);
		expect(session.getSessionActionSnapshot().steering).toContain("message during turn");
		await session.abort();
		await activeTurn.catch(() => undefined);
	});

	it("serializes an agent message behind cron admission", async () => {
		createSession();
		const now = new Date().toISOString();
		const job: AgentCronJob = {
			id: "cron-overlap",
			status: "active",
			source: "cron",
			activeSessionId: "active-1",
			sessionId: session.sessionId,
			sessionFile: "/tmp/session.jsonl",
			cwd: tempDir,
			prompt: "cron prompt",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: now,
			updatedAt: now,
			runCount: 0,
		};
		const cronTurn = session.promptHeartbeat(job, { streamingBehavior: "followUp", source: "rpc" });
		let queued: boolean | undefined;

		await session.acceptAgentMessagePrompt("message during cron admission", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				queued = didQueue;
			},
		});

		expect(queued).toBe(true);
		expect(session.getSessionActionSnapshot().steering).toContain("message during cron admission");
		await session.abort();
		await cronTurn.catch(() => undefined);
	});

	it("does not admit a cron prompt invalidated while async input handlers ran", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let deliveredUserText: string | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const user = context.messages.filter((message) => message.role === "user").at(-1);
					if (user && typeof user.content !== "string") {
						deliveredUserText = user.content
							.filter(
								(part): part is TextContent =>
									typeof part === "object" && part !== null && part.type === "text",
							)
							.map((part) => part.text)
							.join("\n");
					}
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Delivered") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		let jobInvalidated = false;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("input", async () => {
					jobInvalidated = true;
					return undefined;
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		// Mirrors the daemon cron path: admissionCommitted re-checks the job and
		// throws when it was cancelled or updated before the prompt is admitted.
		await expect(
			session.promptUntilAccepted("stale cron prompt", {
				streamingBehavior: "followUp",
				source: "rpc",
				admissionCommitted: () => {
					if (jobInvalidated) throw new Error("Cron job became unrunnable before admission");
				},
			}),
		).rejects.toThrow("Cron job became unrunnable before admission");

		await session.agent.waitForIdle();
		expect(deliveredUserText).toBeUndefined();
		expect(session.isStreaming).toBe(false);
	});

	it("serializes concurrent agent messages", async () => {
		createSession();
		const dispositions = new Map<string, boolean | undefined>();
		const accept = (message: string) =>
			session.acceptAgentMessagePrompt(message, {
				queueIfBusy: true,
				streamingBehavior: "steer",
				preflightResult: (accepted, queued) => {
					expect(accepted).toBe(true);
					dispositions.set(message, queued);
				},
			});

		await Promise.all([accept("first concurrent message"), accept("second concurrent message")]);

		expect(dispositions.get("first concurrent message")).toBe(false);
		expect(dispositions.get("second concurrent message")).toBe(true);
		expect(session.getSessionActionSnapshot().steering).toContain("second concurrent message");
		await session.abort();
	});

	it("enforces the agent message queue cap inside core admission", async () => {
		createSession();
		const accept = (index: number) => {
			const message = createAgentSessionMessage({
				id: `agentmsg-${index}`,
				source: "agent_message",
				message: `message ${index}`,
				from: { clientId: "test" },
				target: {
					activeSessionId: "target",
					sessionId: session.sessionId,
					runtimeKind: "subagent",
				},
			});
			return session.queueAgentMessagePrompt(message.content, "steer", message);
		};

		for (let index = 0; index < 20; index++) {
			await accept(index);
		}
		await expect(accept(20)).rejects.toThrow("Target session has too many pending messages");
		expect(session.unfinishedActionCount).toBe(20);
		const snapshot = session.getSessionActionRecoverySnapshot();
		session.dispose();

		createSession();
		await expect(session.restoreSessionActions(snapshot)).resolves.toBe(20);
		expect(session.unfinishedActionCount).toBe(20);
	});

	it("rejects an agent message when clear wins core admission", async () => {
		createSession();
		const internals = session as unknown as {
			_acquireSessionActionCommitFence(): Promise<{ release(): void }>;
		};
		const fence = await internals._acquireSessionActionCommitFence();
		const message = createAgentSessionMessage({
			id: "agentmsg-clear-race",
			source: "agent_message",
			message: "clear race",
			from: { clientId: "test" },
			target: {
				activeSessionId: "target",
				sessionId: session.sessionId,
				runtimeKind: "subagent",
			},
		});
		const accepted = session.acceptAgentMessagePrompt(message.content, {
			customMessage: message,
			queueIfBusy: true,
			streamingBehavior: "steer",
		});
		await Promise.resolve();

		session.clearQueuedAgentMessages();
		fence.release();

		await expect(accepted).rejects.toThrow("Agent message was cleared before admission");
		expect(session.unfinishedActionCount).toBe(0);
	});

	it("accepts agent messages during and after direct compaction", async () => {
		createSession();
		let releaseCompaction: (result: CompactionResult) => void = () => {};
		const compactionGate = new Promise<CompactionResult>((resolve) => {
			releaseCompaction = resolve;
		});
		const internals = session as unknown as {
			_performCompaction: () => Promise<CompactionResult>;
		};
		vi.spyOn(internals, "_performCompaction").mockImplementation(() => compactionGate);
		const compaction = session.compact();
		await vi.waitFor(() => expect(session.isCompacting).toBe(true));
		let queued: boolean | undefined;

		await session.acceptAgentMessagePrompt("message during direct compaction", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				queued = didQueue;
			},
		});

		expect(queued).toBe(true);
		expect(session.getSessionActionSnapshot().steering).toContain("message during direct compaction");
		releaseCompaction({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 1 });
		await compaction;
		let postCompactionQueued: boolean | undefined;
		await session.acceptAgentMessagePrompt("message after direct compaction", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				postCompactionQueued = didQueue;
			},
		});
		expect(postCompactionQueued).toBe(true);
		const deliveryCount = (text: string) =>
			session.messages.filter(
				(message) =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content.some((part) => part.type === "text" && part.text === text),
			).length;
		expect(deliveryCount("message during direct compaction")).toBe(0);
		expect(deliveryCount("message after direct compaction")).toBe(0);

		session.resumeQueuedWork();
		await vi.waitFor(() => expect(deliveryCount("message during direct compaction")).toBe(1));
		expect(session.getSessionActionSnapshot().steering).toContain("message after direct compaction");
	});

	it("delivers an accepted agent message once after scheduler-owned compaction", async () => {
		createSession();
		let releaseCompaction: (result: CompactionResult) => void = () => {};
		const compactionGate = new Promise<CompactionResult>((resolve) => {
			releaseCompaction = resolve;
		});
		const internals = session as unknown as {
			_performCompaction: () => Promise<CompactionResult>;
		};
		vi.spyOn(internals, "_performCompaction").mockImplementation(() => compactionGate);
		const compaction = session.compact(undefined, { skipAbort: true });
		await vi.waitFor(() => expect(session.isCompacting).toBe(true));
		let queued: boolean | undefined;

		await session.acceptAgentMessagePrompt("message during scheduled compaction", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				queued = didQueue;
			},
		});

		expect(queued).toBe(true);
		expect(session.getSessionActionSnapshot().steering).toContain("message during scheduled compaction");
		releaseCompaction({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 1 });
		await compaction;
		const deliveryCount = () =>
			session.messages.filter(
				(message) =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content.some(
						(part) => part.type === "text" && part.text === "message during scheduled compaction",
					),
			).length;

		await vi.waitFor(() => expect(deliveryCount()).toBe(1));
		expect(deliveryCount()).toBe(1);
	});

	it("delivers internal prompts without extension input interception", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let inputCalls = 0;
		let receivedUserText: string | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userMessages = context.messages.filter((message) => message.role === "user");
					const user = userMessages.at(-1);
					if (user && typeof user.content !== "string") {
						receivedUserText = user.content
							.filter(
								(part): part is TextContent =>
									typeof part === "object" && part !== null && part.type === "text",
							)
							.map((part) => part.text)
							.join("\n");
					}
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Delivered") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("input", async () => {
					inputCalls++;
					return { action: "handled" };
				});
			},
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		await session.prompt("host gate follow-up", { internalPrompt: true });
		await session.agent.waitForIdle();

		expect(inputCalls).toBe(0);
		expect(receivedUserText).toBe("host gate follow-up");
	});

	it("should allow prompt() after previous completes", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		await expect(session.prompt("Second message")).resolves.not.toThrow();
	});

	it("should wait for queued agent events before emitting tool_call", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
					if (toolResultCount > 0) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
							{ type: "toolCall", id: "toolu_2", name: "dummy", arguments: { q: "y" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const snapshots: string[][] = [];
		const sessionWithRunner = session as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitToolCall: (event: { type: string; toolCallId: string }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: (eventType) => eventType === "tool_call",
			emit: async () => {},
			emitMessageEnd: async () => undefined,
			emitToolCall: async () => {
				snapshots.push(
					sessionManager
						.getEntries()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message.role),
				);
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await session.prompt("hi");
		await session.agent.waitForIdle();

		expect(snapshots).toEqual([
			["user", "assistant"],
			["user", "assistant"],
		]);
	});

	it("should persist message_end events in order with slow extension handlers", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const tool = {
			name: "dummy",
			description: "Dummy tool",
			label: "dummy",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: unknown) => {
				const q =
					typeof params === "object" && params !== null && "q" in params
						? String((params as { q: unknown }).q)
						: "";
				return {
					content: [{ type: "text" as const, text: `result:${q}` }],
					details: {},
				};
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [tool],
			},
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");

					if (hasToolResult) {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "mock",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: { ...message, content: [] } });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}

					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "text", text: "calling tool" },
							{ type: "toolCall", id: "toolu_1", name: "dummy", arguments: { q: "x" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};

					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { dummy: tool },
		});

		const sessionWithRunner = session as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string; message?: { role?: string } }) => Promise<void>;
				emitMessageEnd: (event: { type: string; message?: { role?: string } }) => Promise<undefined>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (
					prompt: string,
					images: unknown,
					systemPrompt: string,
					systemPromptOptions: BuildSystemPromptOptions,
				) => Promise<undefined>;
				invalidate: (message?: string) => void;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: () => false,
			emit: async () => {},
			emitMessageEnd: async (event) => {
				if (event.type === "message_end" && event.message?.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, 40));
				}
				return undefined;
			},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async () => undefined,
			invalidate: () => {},
		};

		await session.prompt("hi");
		await session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const messageEntries = sessionManager.getEntries().filter((entry) => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});
});
