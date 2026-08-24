import { appendFileSync } from "node:fs";
import { AgentContinueError, type AgentMessage, type ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<void>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<void>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_persistCompactionOutcome: (
		reason: "overflow" | "threshold" | "requested",
		outcome: "skipped" | "cancelled" | "failed",
		message: string,
	) => void;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function failingGateCommand(): string {
	return `${process.execPath} -e "console.error('gate failed'); process.exit(1)"`;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const pruneOversizedVariables = vi.fn(async () => ["large_text"]);
		const listNamespaceNames = vi.fn(async () => ["small_value"]);
		const internals = harness.session as unknown as { _ipythonKernelProvisioner?: unknown };
		const previousProvisioner = internals._ipythonKernelProvisioner;
		internals._ipythonKernelProvisioner = {
			hasRunningKernel: true,
			pruneOversizedVariables,
			listNamespaceNames,
		};
		let result!: Awaited<ReturnType<typeof harness.session.compact>>;
		try {
			result = await harness.session.compact();
		} finally {
			internals._ipythonKernelProvisioner = previousProvisioner;
		}
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(pruneOversizedVariables).toHaveBeenCalledOnce();
		expect(listNamespaceNames).toHaveBeenCalledOnce();
		expect(pruneOversizedVariables.mock.invocationCallOrder[0] as number).toBeLessThan(
			listNamespaceNames.mock.invocationCallOrder[0] as number,
		);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "ipython_state",
				content: expect.stringContaining("were removed: large_text"),
			}),
		);
		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("compacts through the model summarizer, persists metadata, emits events, and remains usable", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
			fauxAssistantMessage("still usable"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");

		expect(result.summary).toContain("model-generated summary");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(entry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("model-generated summary"),
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			fromHook: false,
		});
		expect(harness.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("model-generated summary"),
		});
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				result: expect.objectContaining({ tokensBefore: result.tokensBefore }),
				aborted: false,
				willRetry: false,
			}),
		]);

		await harness.session.prompt("after compaction");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "still usable" }],
		});
	});

	it("renders an executing /compact as activity instead of queued work", async () => {
		let releaseCompaction: () => void = () => {};
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await compactionGate;
					});
				},
			],
		});
		harnesses.push(harness);
		let releaseTurn: () => void = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.setResponses([
			async () => {
				await turnGate;
				return fauxAssistantMessage("slow response");
			},
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
		]);
		const running = harness.session.prompt("one");
		// Queue the command while the turn streams, then let the turn finish.
		const queued = harness.session.prompt("/compact", { streamingBehavior: "steer" });
		releaseTurn();
		await vi.waitFor(() =>
			expect(harness.session.getSessionActionSnapshot()).toMatchObject({
				queuedCount: 0,
				steering: [],
				followUps: [],
				active: { kind: "session_command", phase: "running", label: "/compact" },
			}),
		);
		expect(harness.session.isSessionActive).toBe(true);
		releaseCompaction();
		await Promise.all([running, queued]);

		const order = harness.events.map((event) => event.type);
		expect(order.indexOf("compaction_start")).toBeGreaterThan(order.indexOf("agent_end"));
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
	});

	it("reschedules a pending post-compaction continuation after successful manual compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationScheduled: boolean;
		};
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			internals._schedulePostCompactionContinue();

			await harness.session.compact();

			expect(internals._postCompactionContinuationScheduled).toBe(true);
		} finally {
			internals._cancelPostCompactionContinue();
		}
	});

	it("treats session-owned queued inputs as queued work after compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			// Hold the input in the session-owned follow-up queue across compaction.
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("queued across compaction", undefined, { resumeIfIdle: true });
			expect(harness.session.queuedActionCount).toBe(1);

			await harness.session.compact();

			// Session-owned queued work counts as queued: refine defers to the next
			// turn boundary instead of running before the queued input's turn.
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);

			pause.release();
		} finally {
			harness.session.clearQueue();
			internals._cancelPostCompactionContinue();
		}
	});

	it("defers post-compaction refine behind a preparing session action", async () => {
		const preparationReached = vi.fn();
		let releasePreparation = () => {};
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "preparing across compaction") return;
						preparationReached();
						await preparationGate;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("prepared response"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.followUp("preparing across compaction", undefined, { resumeIfIdle: true });
		await vi.waitFor(() => expect(preparationReached).toHaveBeenCalledOnce());
		const internals = harness.session as unknown as SessionWithCompactionInternals & {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await internals._runAutoCompaction("requested", false);
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);
		} finally {
			releasePreparation();
			internals._cancelPostCompactionContinue();
		}
		await harness.session.waitForIdle();
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps prior autonomous continuations when later threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 4,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_queueAutonomousContinuationForThresholdCompaction(
				message: AssistantMessage,
			): Promise<AgentMessage | undefined>;
			_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				shouldContinueAfterThreshold: boolean,
				queuedMessages: AgentMessage[],
			): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const firstAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const secondAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });

		const firstQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(firstAssistant);
		const secondQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(secondAssistant);

		expect(firstQueued).toBeDefined();
		expect(secondQueued).toBeDefined();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(2);
		sessionInternals._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, [secondQueued!]);

		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([firstQueued]);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
	});

	it("clears queued autonomous continuations when threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(shouldStop).toBe(true);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("emits a warning and persists the outcome outside model context when auto-compaction has nothing to summarize", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const endEvents: Array<{ errorMessage?: string; errorSeverity?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				expect(harness.session.messages.at(-1)).toMatchObject({ customType: "compaction_outcome" });
				endEvents.push({ errorMessage: event.errorMessage, errorSeverity: event.errorSeverity });
			}
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("threshold", false);

		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorSeverity).toBe("warning");
		expect(endEvents[0].errorMessage).toContain("Auto-compaction skipped");

		// The unsuccessful outcome is disclosed as a durable custom message that stays out of model context.
		const outcome = harness.session.messages.at(-1);
		expect(outcome).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: endEvents[0].errorMessage,
			display: true,
			details: { reason: "threshold", outcome: "skipped" },
		});
		expect(harness.session.agent.convertToLlm([outcome!])).toEqual([]);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 2 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		const message =
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
		expect(compactionErrors).toContain(message);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: message,
			details: { reason: "overflow", outcome: "failed" },
		});
		expect(
			harness.session.messages.filter(
				(entry) =>
					entry.role === "custom" && entry.customType === "compaction_outcome" && entry.content === message,
			),
		).toHaveLength(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("triggers threshold compaction when trailing context exceeds the model window", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{
				role: "custom",
				customType: "large-context",
				content: [{ type: "text", text: "x".repeat(800_000) }],
				display: false,
				timestamp: Date.now() + 500,
			},
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("stops a tool loop for threshold compaction before the next model call", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
	});

	it("queues a failing autonomous gate continuation before threshold compaction stops a tool loop", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const oldMessages: AgentMessage[] = [oldUser, oldAssistant];
		const messages: AgentMessage[] = [currentUser, successfulAssistant, toolResult];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [...oldMessages, ...messages];

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		const shouldStop = await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(shouldStop).toBe(true);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			gates: expect.objectContaining({ maxRetries: 5 }),
		});
		expect(followUpSpy).not.toHaveBeenCalled();
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("keeps autonomous continuation bookkeeping when only steering queue is drained", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const steeringMessage = {
			role: "user",
			content: [{ type: "text", text: "steer first" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		const autonomousMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [autonomousMessage];
		harness.session.agent.state.messages = [{ ...fauxAssistantMessage("done"), timestamp: Date.now() - 1000 }];
		harness.session.agent.steer(steeringMessage);
		harness.session.agent.followUp(autonomousMessage);
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([autonomousMessage]);
		expect(followUpSpy).toHaveBeenCalledWith(autonomousMessage);
	});

	it.each([
		{
			name: "untracked queued input",
			text: "queued input",
			response: "queued input handled",
			tracked: false,
		},
		{
			name: "post-compaction continuation",
			text: "session-owned continuation",
			response: "continuation handled",
			tracked: true,
		},
	])("does not continue again after the session pump handles $name", async ({ text, response, tracked }) => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
			_createPreparedTurnAction(
				schedule: "followUp",
				text: string,
				images: undefined,
				options: { message?: AgentMessage; resumeIfIdle: boolean },
			): unknown;
			_admitSessionInput(action: unknown, options?: { wake?: boolean }): { accepted: boolean };
		};
		const continuation = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		if (tracked) sessionInternals._postCompactionContinuationMessages = [continuation];
		harness.setResponses([fauxAssistantMessage(response)]);
		sessionInternals._admitSessionInput(
			sessionInternals._createPreparedTurnAction("followUp", text, undefined, {
				...(tracked && { message: continuation }),
				resumeIfIdle: tracked,
			}),
		);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(200);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(false);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: response }],
		});
	});

	it("keeps autonomous threshold continuations when post-compaction continue must retry", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
		};
		const queuedMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [queuedMessage];
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
		];
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new AgentContinueError("busy", "already processing"));

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([queuedMessage]);
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(true);
	});

	it("clears queued autonomous threshold continuations when autonomous mode is disabled", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [oldUser, oldAssistant, currentUser, successfulAssistant, toolResult];

		await sessionInternals._shouldStopAfterTurn({
			message: successfulAssistant,
			toolResults: [toolResult],
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [currentUser, successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);

		await harness.session.prompt("/autonomous off");
		await harness.session.waitForIdle();
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("queues a failing autonomous gate continuation before post-turn threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");
	});

	it("does not queue autonomous gate continuations for pre-prompt threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("waits for threshold-compaction autonomous continuations before finishing prompt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const highUsageDone = {
			...fauxAssistantMessage("done"),
			usage: createUsage(10_000),
		};
		harness.setResponses([highUsageDone, fauxAssistantMessage("retry")]);
		const promptPromise = harness.session.prompt("make the change");

		await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await promptPromise;

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue();

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue();
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue();

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("rolls back failed outcome persistence without breaking the persisted branch", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("persist this turn");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const persistedLeafId = harness.sessionManager.getLeafId();
		const persistedEntries = harness.sessionManager.getEntries();
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			appendFileSync(sessionFile, '{"type":"custom_message"');
			throw new Error("disk full");
		});

		expect(() =>
			internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed"),
		).not.toThrow();
		// The live outcome message discloses that it was not saved.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
			details: { reason: "requested", outcome: "failed" },
		});
		// In-memory state is fully rolled back: no outcome entry, same leaf and entries.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(persistedEntries);

		// The next append attaches to the persisted leaf and rewrites a coherent file.
		const nextId = harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = SessionManager.open(sessionFile);
		expect(reloaded.getEntry(nextId)?.parentId).toBe(persistedLeafId);
		expect(reloaded.getBranch().map((entry) => entry.id)).toEqual(
			harness.sessionManager.getBranch().map((entry) => entry.id),
		);
		expect(reloaded.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "compaction_outcome" }),
		);
		// The unpersisted disclosure survives context rebuilds (e.g. thinking toggle).
		const rebuilt = harness.session.buildSessionContext();
		expect(rebuilt.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
		});

		// Cross a millisecond boundary so the later turn's timestamp is strictly newer.
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.setResponses([fauxAssistantMessage("later response")]);
		await harness.session.prompt("later turn");
		const reordered = harness.session.buildSessionContext().messages;
		const outcomeIndex = reordered.findIndex(
			(message) => message.role === "custom" && message.customType === "compaction_outcome",
		);
		const laterTurnIndex = reordered.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("later turn"),
		);
		expect(outcomeIndex).toBeGreaterThanOrEqual(0);
		expect(laterTurnIndex).toBeGreaterThan(outcomeIndex);
	});

	it("keeps an unpersisted outcome in agent state after a successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "post-failure summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed");

		// Compaction reloads agent.state.messages from the session file; the
		// memory-only disclosure must survive.
		await harness.session.compact();

		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "compaction_outcome",
				content: expect.stringContaining("could not be saved to session history"),
			}),
		);
	});
});
