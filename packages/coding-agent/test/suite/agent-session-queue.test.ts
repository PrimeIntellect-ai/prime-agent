import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentContinueError, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { type AgentCronJob, shouldDeferHeartbeatCronJob } from "../../src/core/cron-jobs.js";
import {
	createSessionSlashCommandMessage,
	isRefinementOutcomeMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import {
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	type HarnessEntry,
	loadGlobalRefinementHistory,
	loadHarnessState,
	type RefinementResult,
	saveHarnessState,
} from "../../src/core/refinement/index.js";
import { parseSessionSlashCommand } from "../../src/core/slash-commands.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook, withStreaming } from "./scheduling.js";

type AutoRefineReason = "turn_interval" | "compact";

type AutoRefineInternals = {
	_maybeAutoRefine(reason: AutoRefineReason): Promise<void>;
	_scheduleAutoRefine(reason: AutoRefineReason): void;
	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
	_scheduleAutoRefineAfterAgentEnd(): void;
	_schedulePostCompactionContinue(continueAfterSessionInput?: boolean): void;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_cancelPostCompactionContinue(): void;
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_compactAutoRefinePending: boolean;
	_turnIntervalAutoRefinePending: boolean;
	_postCompactionContinuationScheduled: boolean;
	_pendingAutoRefineReview?: unknown;
	_autoRefineInProgress: boolean;
	_autoRefineBranchVersion: number;
};

type SteeringStopInternals = {
	_steeringStopPending: boolean;
	_clearQueuedGoalContexts(): void;
};

function emptyRefinementResult(): RefinementResult {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

function refinePlanJson(summary: string, edits: unknown[] = []): string {
	return JSON.stringify({
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	});
}

function createAutoRefineHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true });
}

function agentPromptText(id: string, body: string): string {
	return `Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${id}\n\n${body}`;
}

function heartbeatJob(): AgentCronJob {
	return {
		id: "heartbeat-test",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-test",
		sessionId: "session-test",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "check progress",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
	};
}

const skipReviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not count failed assistant messages toward the auto-refine interval", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "provider failed" })]);

		await harness.session.prompt("fail once");

		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it.each([
		{
			name: "review runs after the configured turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "turn_interval" as AutoRefineReason,
			review: {
				shouldRefine: true,
				rationale: "durable lesson found",
				instructions: "capture the durable lesson",
			},
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 2 },
			refineFragments: ["capture the durable lesson", "local harness entries", "Do not promote anything global"],
			turnsAfter: 0,
			compactPendingAfter: undefined as boolean | undefined,
			scheduleCalledWith: undefined as AutoRefineReason | undefined,
			queuedMessages: false,
		},
		{
			name: "compact hook does not require the turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			turns: 0,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing durable" },
			expectedReviewContext: { reason: "compact", turnsSinceLastReview: 0 },
			refineFragments: undefined as string[] | undefined,
			turnsAfter: undefined as number | undefined,
			compactPendingAfter: undefined,
			scheduleCalledWith: undefined,
			queuedMessages: false,
		},
		{
			name: "falls back to turn-interval review when compact auto-refine is disabled",
			settings: { autoRefine: { enabled: true, compact: false, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing durable" },
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 2 },
			refineFragments: undefined,
			turnsAfter: undefined,
			compactPendingAfter: false as boolean | undefined,
			scheduleCalledWith: undefined,
			queuedMessages: false,
		},
		{
			name: "declined compact review preserves an already-due turn interval",
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			turns: 2,
			reason: "compact" as AutoRefineReason,
			review: { shouldRefine: false, rationale: "nothing compact-specific" },
			expectedReviewContext: undefined as { reason: string; turnsSinceLastReview: number } | undefined,
			refineFragments: undefined,
			turnsAfter: 2,
			compactPendingAfter: undefined,
			scheduleCalledWith: "turn_interval" as AutoRefineReason | undefined,
			queuedMessages: false,
		},
		{
			name: "queued follow-up messages do not make an idle agent active",
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			turns: 1,
			reason: "turn_interval" as AutoRefineReason,
			review: {
				shouldRefine: true,
				rationale: "durable lesson found",
				instructions: "capture the durable lesson",
			},
			expectedReviewContext: { reason: "turn_interval", turnsSinceLastReview: 1 },
			refineFragments: [],
			turnsAfter: undefined,
			compactPendingAfter: undefined,
			scheduleCalledWith: undefined,
			queuedMessages: true,
		},
	])(
		"auto-refine $name",
		async ({
			settings,
			turns,
			reason,
			review,
			expectedReviewContext,
			refineFragments,
			turnsAfter,
			compactPendingAfter,
			scheduleCalledWith,
			queuedMessages,
		}) => {
			const reviewer = vi.fn(async () => review);
			const harness = await createAutoRefineHarness({ settings, autoRefineReviewer: reviewer });
			harnesses.push(harness);
			const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
			const internals = harness.session as unknown as AutoRefineInternals;
			internals._assistantTurnsSinceAutoRefine = turns;
			const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});
			if (queuedMessages) vi.spyOn(harness.session.agent, "hasQueuedMessages").mockReturnValue(true);

			await internals._maybeAutoRefine(reason);

			if (expectedReviewContext !== undefined) {
				expect(reviewer).toHaveBeenCalledWith(expectedReviewContext, expect.any(AbortSignal));
			}
			if (refineFragments === undefined) {
				expect(refine).not.toHaveBeenCalled();
			} else {
				expect(refine).toHaveBeenCalled();
				for (const fragment of refineFragments) {
					expect(refine).toHaveBeenCalledWith(
						expect.objectContaining({ instructions: expect.stringContaining(fragment) }),
						{ trigger: "auto" },
					);
				}
			}
			if (turnsAfter !== undefined) expect(internals._assistantTurnsSinceAutoRefine).toBe(turnsAfter);
			if (compactPendingAfter !== undefined) expect(internals._compactAutoRefinePending).toBe(compactPendingAfter);
			if (scheduleCalledWith !== undefined) expect(scheduleAutoRefine).toHaveBeenCalledWith(scheduleCalledWith);
		},
	);

	it.each([
		{
			name: "waits for planned post-compaction continuation",
			act: (internals: AutoRefineInternals, expectSchedule: (called: boolean) => void) => {
				internals._scheduleAutoRefineAfterCompaction(true);
				expect(internals._compactAutoRefinePending).toBe(true);
				expectSchedule(false);
				internals._scheduleAutoRefineAfterAgentEnd();
				expect(internals._compactAutoRefinePending).toBe(true);
			},
		},
		{
			name: "waits until the scheduled post-compaction continuation starts",
			act: (internals: AutoRefineInternals, expectSchedule: (called: boolean) => void) => {
				internals._compactAutoRefinePending = true;
				internals._postCompactionContinuationScheduled = true;
				internals._scheduleAutoRefineAfterAgentEnd();
				expectSchedule(false);
				internals._postCompactionContinuationScheduled = false;
				internals._scheduleAutoRefineAfterAgentEnd();
			},
		},
		{
			name: "runs immediately when no post-compaction continuation is planned",
			act: (internals: AutoRefineInternals) => {
				internals._scheduleAutoRefineAfterCompaction(false);
				expect(internals._compactAutoRefinePending).toBe(false);
			},
		},
	])("auto-refine compact hook $name", async ({ act }) => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		act(internals, (called) =>
			called ? expect(scheduleAutoRefine).toHaveBeenCalled() : expect(scheduleAutoRefine).not.toHaveBeenCalled(),
		);

		expect(scheduleAutoRefine).toHaveBeenCalledWith("compact");
		expect(scheduleAutoRefine).toHaveBeenCalledTimes(1);
	});

	it("runs a turn-interval review after a concurrent compact review declines", async () => {
		vi.useFakeTimers();
		const compactReviewGate = createDeferred();
		const reviewer = vi.fn(async ({ reason }: { reason: AutoRefineReason }) => {
			if (reason === "compact") {
				await compactReviewGate.promise;
			}
			return { shouldRefine: false, rationale: `${reason} found nothing durable` };
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;

		try {
			const compactReview = internals._maybeAutoRefine("compact");
			await Promise.resolve();
			await internals._maybeAutoRefine("turn_interval");

			expect(internals._turnIntervalAutoRefinePending).toBe(true);

			compactReviewGate.resolve();
			await compactReview;
			await vi.runOnlyPendingTimersAsync();

			expect(reviewer.mock.calls.map(([context]) => context.reason)).toEqual(["compact", "turn_interval"]);
			expect(internals._turnIntervalAutoRefinePending).toBe(false);
			expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for the active run to settle before retrying a post-compaction continuation", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const activeRunSettled = createDeferred();
		const continueAgent = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(
				new AgentContinueError("busy", "Agent is already processing. Wait for completion before continuing."),
			)
			.mockResolvedValueOnce();
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(() =>
			continueAgent.mock.calls.length === 0 ? Promise.resolve() : activeRunSettled.promise,
		);

		internals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(1));
		expect(internals._postCompactionContinuationScheduled).toBe(true);

		activeRunSettled.resolve();
		await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(2));
		expect(internals._postCompactionContinuationScheduled).toBe(false);
	});

	it("does not let a failed cancelled continuation reject its replacement", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const cancelledRun = createDeferred();
		const replacementRun = createDeferred();
		const continueAgent = vi
			.spyOn(harness.session.agent, "continue")
			.mockReturnValueOnce(cancelledRun.promise)
			.mockReturnValueOnce(replacementRun.promise);

		internals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(1));
		internals._cancelPostCompactionContinue();
		internals._schedulePostCompactionContinue();
		await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(2));
		const idle = harness.session.waitForHeadlessIdle();

		cancelledRun.reject(new Error("cancelled continuation failed"));
		await new Promise<void>(setImmediate);
		replacementRun.resolve();

		await expect(idle).resolves.toBeUndefined();
	});

	it("waits for a queued-work pause to release before post-compaction continuation", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const pause = harness.session.acquireQueuedWorkPause();
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		internals._schedulePostCompactionContinue();
		await new Promise<void>(setImmediate);
		expect(continueAgent).not.toHaveBeenCalled();

		pause.release();
		await harness.session.waitForHeadlessIdle();
		expect(continueAgent).toHaveBeenCalledTimes(1);
	});

	it("cancels scheduled post-compaction continuation on branch changes", async () => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		try {
			internals._schedulePostCompactionContinue();
			await internals._invalidatePendingAutoRefineForBranchChange();
			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).not.toHaveBeenCalled();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ name: "requestAbort", abort: (harness: Harness) => harness.session.requestAbort() },
		{
			name: "abortForUpdateRestart",
			abort: (harness: Harness) => harness.session.abortForUpdateRestart(),
		},
	])("cancels scheduled post-compaction continuation at $name without dropping queued input", async ({ abort }) => {
		vi.useFakeTimers();
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const continueAgent = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		try {
			internals._schedulePostCompactionContinue();
			await harness.session.followUp("queued across abort");

			abort(harness);
			await vi.advanceTimersByTimeAsync(100);

			expect(continueAgent).not.toHaveBeenCalled();
			expect(internals._postCompactionContinuationScheduled).toBe(false);
			expect(harness.session.getFollowUpMessages()).toEqual(["queued across abort"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps scheduled post-compaction continuation when session-input pump compaction skips without aborting", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		const idle = createDeferred();
		vi.spyOn(harness.session.agent, "waitForIdle").mockReturnValue(idle.promise);
		internals._schedulePostCompactionContinue();

		await expect(harness.session.compact(undefined, { skipAbort: true })).rejects.toThrow(
			"Session is too short to compact",
		);

		expect(internals._postCompactionContinuationScheduled).toBe(true);
		internals._cancelPostCompactionContinue();
		idle.resolve();
	});

	it("auto-refine pending review uses the in-progress guard and catches refine failures", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._pendingAutoRefineReview = {
			reason: "turn_interval",
			review: { shouldRefine: true, rationale: "durable lesson" },
		};
		let guardWasSetDuringRefine = false;
		const refine = vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			guardWasSetDuringRefine = internals._autoRefineInProgress;
			throw new Error("refine failed");
		});

		await internals._maybeAutoRefine("turn_interval");

		expect(refine).toHaveBeenCalledWith(
			expect.objectContaining({ instructions: expect.stringContaining("durable lesson") }),
			{ trigger: "auto" },
		);
		expect(guardWasSetDuringRefine).toBe(true);
		expect(internals._autoRefineInProgress).toBe(false);
		expect(internals._pendingAutoRefineReview).toBeDefined();
		// The failure stamps the cooldown so the retained pending review does not
		// retry on every agent end.
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		refine.mockResolvedValueOnce(emptyRefinementResult());
		await internals._maybeAutoRefine("turn_interval");

		expect(refine).toHaveBeenCalledTimes(1);
		expect(internals._pendingAutoRefineReview).toBeDefined();

		internals._lastAutoRefineReviewAt = 0;
		await internals._maybeAutoRefine("turn_interval");

		expect(internals._pendingAutoRefineReview).toBeUndefined();
	});

	it("keeps the turn counter and stamps the cooldown when an approved immediate refine fails", async () => {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 2;
		vi.spyOn(harness.session, "refine").mockRejectedValueOnce(new Error("refine failed"));

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledWith(
			{ reason: "turn_interval", turnsSinceLastReview: 2 },
			expect.any(AbortSignal),
		);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(2);
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);
	});

	it("does not refine when a review resolves after the session is disposed", async () => {
		const reviewGate = createDeferred();
		const signals: Array<AbortSignal | undefined> = [];
		const reviewer = vi.fn(
			async (_context: { reason: AutoRefineReason; turnsSinceLastReview: number }, signal?: AbortSignal) => {
				signals.push(signal);
				await reviewGate.promise;
				return { shouldRefine: true, rationale: "durable lesson" };
			},
		);
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		const autoRefinePromise = internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledTimes(1);
		const entriesBeforeDispose = harness.sessionManager.getEntries().length;
		harness.session.dispose();
		expect(signals[0]?.aborted).toBe(true);
		reviewGate.resolve();
		await autoRefinePromise;

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeUndefined();
		expect(harness.sessionManager.getEntries().length).toBe(entriesBeforeDispose);

		// Disposal also invalidates any newly scheduled auto-refine.
		await internals._maybeAutoRefine("turn_interval");
		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("stamps the cooldown when the auto-refine review fails", async () => {
		const reviewer = vi.fn(async () => {
			throw new Error("review failed");
		});
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		await internals._maybeAutoRefine("turn_interval");

		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("auto-refine pending review respects the cooldown", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._pendingAutoRefineReview = {
			reason: "turn_interval",
			review: { shouldRefine: true, rationale: "durable lesson" },
		};
		internals._lastAutoRefineReviewAt = Date.now();
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		await internals._maybeAutoRefine("turn_interval");

		expect(refine).not.toHaveBeenCalled();
		expect(internals._pendingAutoRefineReview).toBeDefined();
	});

	it("serializes concurrent refine calls", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const firstPlanGate = createDeferred();
		const firstPlanStartedPromise = createDeferred();
		harness.setResponses([
			async () => {
				firstPlanStartedPromise.resolve();
				await firstPlanGate.promise;
				return fauxAssistantMessage(refinePlanJson("first"));
			},
			fauxAssistantMessage(refinePlanJson("second")),
		]);

		const firstRefine = harness.session.refine({ instructions: "first refine" });
		await firstPlanStartedPromise.promise;
		const secondRefine = harness.session.refine({ instructions: "second refine" });
		await Promise.resolve();

		expect(harness.getPendingResponseCount()).toBe(1);

		firstPlanGate.resolve();
		await firstRefine;
		await secondRefine;

		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not persist or reconnect an in-flight refine after dispose", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const planGate = createDeferred();
		const planStartedPromise = createDeferred();
		harness.setResponses([
			async () => {
				planStartedPromise.resolve();
				await planGate.promise;
				return fauxAssistantMessage(
					refinePlanJson("stale refine", [
						{
							action: "create",
							kind: "memory",
							id: "stale_after_dispose",
							title: "Stale after dispose",
							content: "This must not be saved.",
						},
					]),
				);
			},
		]);
		const internals = harness.session as unknown as { _reconnectToAgent(): void };
		const reconnect = vi.spyOn(internals, "_reconnectToAgent");
		const entriesBeforeDispose = harness.sessionManager.getEntries().length;

		const refine = harness.session.refine({ instructions: "write stale state" });
		await planStartedPromise.promise;
		harness.session.dispose();
		planGate.resolve();

		await expect(refine).rejects.toThrow();
		expect(reconnect).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBeforeDispose);
	});

	it("waits for an active direct prompt before navigating", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await waitForToolStart;
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		let navigated = false;
		const navigation = harness.session.navigateTree(target!.id).then(() => {
			navigated = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(navigated).toBe(false);

		releaseToolExecution();
		await promptPromise;
		await navigation;
		expect(navigated).toBe(true);
	});

	it("cancels a restart checkpoint while tree navigation owns the commit fence", async () => {
		const treeEventReached = createDeferred();
		const treeEventGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						treeEventReached.resolve();
						await treeEventGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		await harness.session.prompt("two");

		const navigation = harness.session.navigateTree(target!.id, { summarize: false });
		await treeEventReached.promise;
		const controller = new AbortController();
		const checkpoint = harness.session.waitForSessionInputCheckpoint(controller.signal);
		controller.abort();

		await expect(checkpoint).rejects.toThrow("Update restart preparation cancelled");
		const nextCheckpoint = harness.session.waitForSessionInputCheckpoint();
		treeEventGate.resolve();
		await navigation;
		await expect(nextCheckpoint).resolves.toBeUndefined();
	});

	it("keeps queued work paused until tree navigation events settle", async () => {
		const treeEvent = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async () => treeEvent.promise);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("queued")]);
		await harness.session.prompt("first");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();

		const navigation = harness.session.navigateTree(target!.id, { summarize: false });
		await harness.session.followUp("after navigation", undefined, { resumeIfIdle: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUserTexts(harness)).not.toContain("after navigation");

		treeEvent.resolve();
		await navigation;
		await vi.waitFor(() => expect(getUserTexts(harness)).toContain("after navigation"));
	});

	it("queueIfBusy enqueues behind pending work instead of draining it first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		withStreaming(harness, true);
		await harness.session.followUp("already queued", undefined, { queueKey: "existing" });
		withStreaming(harness, false);

		let queuedAtPreflight: boolean | undefined;
		await harness.session.prompt("respects the queue", {
			queueIfBusy: true,
			streamingBehavior: "followUp",
			preflightResult: (_success, queued) => {
				queuedAtPreflight ??= queued;
			},
		});
		await harness.session.waitForIdle();

		expect(queuedAtPreflight).toBe(true);
		expect(getUserTexts(harness)).toEqual(["already queued", "respects the queue"]);
	});

	it("invalidates queued prompt preparation on branch navigation", async () => {
		let pause: { release(): void } | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "queued" && !pause) pause = harness.session.acquireQueuedWorkPause();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("first");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();

		withStreaming(harness, true);
		await harness.session.followUp("queued", undefined, { resumeIfIdle: true });
		withStreaming(harness, false);
		await vi.waitFor(() => expect(pause).toBeDefined());
		await harness.session.waitForSessionInputIdle();
		const store = (
			harness.session as unknown as {
				_actionStore: { queuedActions(): readonly { payload: { prepared?: unknown } }[] };
			}
		)._actionStore;
		await vi.waitFor(() => expect(store.queuedActions()[0]?.payload.prepared).toBeDefined());

		const navigation = harness.session.navigateTree(target!.id, { summarize: false });
		pause?.release();
		pause = undefined;
		await navigation;

		expect(store.queuedActions()[0]?.payload.prepared).toBeUndefined();
	});

	it.each([
		{
			name: "sessions without a local harness directory",
			makeHarness: () =>
				createHarness({
					settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
					autoRefineReviewer: skipReviewer,
				}),
			expectRefineChecked: true,
		},
		{
			name: "subagent sessions",
			makeHarness: () =>
				createAutoRefineHarness({
					settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
					rlmDepth: 1,
					autoRefineReviewer: skipReviewer,
				}),
			expectRefineChecked: false,
		},
	])("auto-refine is skipped for $name", async ({ makeHarness, expectRefineChecked }) => {
		skipReviewer.mockClear();
		const harness = await makeHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as AutoRefineInternals;
		internals._assistantTurnsSinceAutoRefine = 1;
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine").mockImplementation(() => {});

		await internals._maybeAutoRefine("turn_interval");
		internals._scheduleAutoRefineAfterCompaction(false);
		internals._scheduleAutoRefineAfterAgentEnd();

		expect(skipReviewer).not.toHaveBeenCalled();
		if (expectRefineChecked) expect(refine).not.toHaveBeenCalled();
		expect(scheduleAutoRefine).not.toHaveBeenCalled();
	});

	it("preserves compact auto-refine pending state when no model is selected", async () => {
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const state = harness.session.agent.state as { model: typeof harness.session.agent.state.model | undefined };
		state.model = undefined;
		const internals = harness.session as unknown as AutoRefineInternals;

		await internals._maybeAutoRefine("compact");

		expect(internals._compactAutoRefinePending).toBe(true);
	});

	it.each([
		{ reason: "turn_interval" as AutoRefineReason, turns: 1, pendingFlag: "_turnIntervalAutoRefinePending" as const },
		{ reason: "compact" as AutoRefineReason, turns: 0, pendingFlag: "_compactAutoRefinePending" as const },
	])(
		"auto-refine review obeys the cooldown and preserves a $reason checkpoint",
		async ({ reason, turns, pendingFlag }) => {
			const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "durable lesson" }));
			const harness = await createAutoRefineHarness({
				settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000 } },
				autoRefineReviewer: reviewer,
			});
			harnesses.push(harness);
			const internals = harness.session as unknown as AutoRefineInternals;
			internals._assistantTurnsSinceAutoRefine = turns;
			internals._lastAutoRefineReviewAt = Date.now();

			await internals._maybeAutoRefine(reason);

			expect(reviewer).not.toHaveBeenCalled();
			expect(internals[pendingFlag]).toBe(true);
		},
	);

	it.each([
		{
			name: "local display prefixes before applying local refine edits",
			seedGlobal: true,
			seedLocal: true,
			editId: "local:shared",
			refineOptions: { instructions: "update the local shared memory" },
			updatedContent: "Updated local content",
			expectLocalContent: "Updated local content" as string | undefined,
			expectGlobalContent: "Global content" as string | undefined,
		},
		{
			name: "global display prefixes before applying local refine edits",
			seedGlobal: false,
			seedLocal: true,
			editId: "global:shared",
			refineOptions: { instructions: "update local memory" },
			updatedContent: "Updated local content",
			expectLocalContent: "Updated local content" as string | undefined,
			expectGlobalContent: undefined as string | undefined,
		},
		{
			name: "global display prefixes before applying global refine edits",
			seedGlobal: true,
			seedLocal: false,
			editId: "global:shared",
			refineOptions: { instructions: "update the global shared memory", global: true },
			updatedContent: "Updated global content",
			expectLocalContent: undefined as string | undefined,
			expectGlobalContent: "Updated global content" as string | undefined,
		},
	])(
		"strips $name",
		async ({
			seedGlobal,
			seedLocal,
			editId,
			refineOptions,
			updatedContent,
			expectLocalContent,
			expectGlobalContent,
		}) => {
			const harness = await createAutoRefineHarness();
			harnesses.push(harness);
			const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
			process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
			try {
				const globalDir = getGlobalHarnessStateDir();
				const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
				const seedMemory = (scope: "global" | "local", dir: string, content: string) => {
					const state = loadHarnessState(dir, scope);
					applyRefinementProposal(
						state,
						{
							summary: `${scope} shared memory`,
							rationale: "seed",
							expectedOutcome: "seeded",
							edits: [{ action: "create", kind: "memory", id: "shared", title: "Shared", content }],
						},
						{ id: `seed_${scope}`, scope },
					);
					saveHarnessState(dir, state);
				};
				if (seedGlobal) seedMemory("global", globalDir, "Global content");
				if (seedLocal) seedMemory("local", localDir, "Local content");
				harness.setResponses([
					fauxAssistantMessage(
						JSON.stringify({
							summary: "Update shared memory",
							rationale: "The display id was selected from merged state.",
							expectedOutcome: "Only the targeted entry changes.",
							edits: [
								{ action: "update", kind: "memory", id: editId, title: "Shared", content: updatedContent },
							],
						}),
					),
				]);

				const result = await harness.session.refine(refineOptions);

				expect(result.appliedEdits[0]).toMatchObject({ id: "shared", applied: true });
				if (expectLocalContent !== undefined) {
					expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe(expectLocalContent);
					expect(loadHarnessState(localDir, "local").entries.memory["global:shared"]).toBeUndefined();
				}
				if (expectGlobalContent !== undefined) {
					expect(loadHarnessState(globalDir, "global").entries.memory.shared.content).toBe(expectGlobalContent);
				}
			} finally {
				if (previousAgentDir === undefined) {
					delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
				} else {
					process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
				}
			}
		},
	);

	it("rolls back copied local refinement history against the original local harness state", async () => {
		const original = await createAutoRefineHarness();
		const branched = await createAutoRefineHarness();
		harnesses.push(original, branched);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${original.tempDir}/agent`;
		try {
			const originalLocalDir = getLocalHarnessStateDir(original.sessionManager.getSessionArtifactDir())!;
			const branchedLocalDir = getLocalHarnessStateDir(branched.sessionManager.getSessionArtifactDir())!;
			const branchedState = loadHarnessState(branchedLocalDir, "local");
			applyRefinementProposal(
				branchedState,
				{
					summary: "Branch local memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Branch memory",
							content: "Branch content should survive rollback of copied history.",
						},
					],
				},
				{ id: "seed_branch", scope: "local" },
			);
			saveHarnessState(branchedLocalDir, branchedState);
			original.setResponses([
				fauxAssistantMessage(
					refinePlanJson("Create original local memory", [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Original memory",
							content: "Original content should be rolled back.",
						},
					]),
				),
			]);

			const originalRefinement = await original.session.refine({ instructions: "remember this locally" });
			branched.sessionManager.appendCustomEntry("prime-agent.refinement", originalRefinement);
			expect(loadHarnessState(originalLocalDir, "local").entries.memory.remember_me.content).toBe(
				"Original content should be rolled back.",
			);

			await branched.session.refine({ rollbackId: originalRefinement.id });

			expect(loadHarnessState(originalLocalDir, "local").entries.memory.remember_me).toBeUndefined();
			expect(loadHarnessState(branchedLocalDir, "local").entries.memory.remember_me.content).toBe(
				"Branch content should survive rollback of copied history.",
			);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("records a durable refinement outcome while preserving a concurrent prompt result", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const planGate = createDeferred();
			const planStartedPromise = createDeferred();
			const promptGate = createDeferred();
			const promptStartedPromise = createDeferred();
			let promptSignal: AbortSignal | undefined;
			harness.setResponses([
				async () => {
					planStartedPromise.resolve();
					await planGate.promise;
					return fauxAssistantMessage(refinePlanJson("no-op"));
				},
				async (_context, options) => {
					promptSignal = options?.signal;
					promptStartedPromise.resolve();
					await promptGate.promise;
					return fauxAssistantMessage("prompt reply");
				},
			]);

			const refinePromise = harness.session.refine({ instructions: "background refine" });
			await planStartedPromise.promise;

			const promptPromise = harness.session.prompt("hello during refine");
			await promptStartedPromise.promise;
			// With backgrounded refine planning, the prompt does NOT wait for the
			// planning LLM pass. It starts immediately and streams its response
			// while planning is still in flight. The application phase waits for
			// the agent to be idle before disconnecting and applying.
			expect(harness.getPendingResponseCount()).toBe(0);

			planGate.resolve();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(promptSignal?.aborted).toBe(false);

			let refineSettled = false;
			void refinePromise.finally(() => {
				refineSettled = true;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(refineSettled).toBe(false);

			promptGate.resolve();
			await refinePromise;
			await promptPromise;

			const outcome = harness.session.messages.find(isRefinementOutcomeMessage);
			expect(outcome?.details.summary).toBe("no-op");
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE),
			).toBe(true);
			expect(
				harness
					.eventsOfType("message_end")
					.some((event) => event.message.role === "assistant" && getMessageText(event.message) === "prompt reply"),
			).toBe(true);
			const persistedAssistants = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(persistedAssistants).toHaveLength(1);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("keeps an unpersisted refinement outcome when the refinement audit append fails", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			harness.setResponses([fauxAssistantMessage(refinePlanJson("no-op"))]);
			const auditAppendError = new Error("audit write failed");
			vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
				throw auditAppendError;
			});
			vi.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback").mockImplementationOnce(() => {
				throw new Error("outcome write failed");
			});

			await expect(harness.session.refine({ instructions: "audit persistence failure" })).rejects.toThrow(
				auditAppendError,
			);

			expect(harness.session.messages.some(isRefinementOutcomeMessage)).toBe(true);
			// The outcome survives context rebuilds even when neither session entry could persist.
			expect(harness.session.buildSessionContext().messages.some(isRefinementOutcomeMessage)).toBe(true);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("keeps an unpersisted refinement outcome across context rebuilds", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			harness.setResponses([fauxAssistantMessage(refinePlanJson("no-op"))]);
			vi.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback").mockImplementationOnce(() => {
				throw new Error("disk full");
			});

			await harness.session.refine({ instructions: "outcome persistence failure" });

			const outcome = harness.session.messages.find(isRefinementOutcomeMessage);
			expect(outcome?.details.summary).toBe("no-op");
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE),
			).toBe(false);
			// The memory-only outcome survives context rebuilds despite the failed write.
			expect(harness.session.buildSessionContext().messages.some(isRefinementOutcomeMessage)).toBe(true);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("preserves a same-entry harness write made during background planning", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const initialState = loadHarnessState(localDir, "local");
			applyRefinementProposal(
				initialState,
				{
					summary: "Seed memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "planning baseline",
						},
					],
				},
				{ id: "seed_shared", scope: "local" },
			);
			saveHarnessState(localDir, initialState);

			let releasePlan: (() => void) | undefined;
			const planGate = new Promise<void>((resolve) => {
				releasePlan = resolve;
			});
			let planStarted: (() => void) | undefined;
			const planStartedPromise = new Promise<void>((resolve) => {
				planStarted = resolve;
			});
			harness.setResponses([
				async () => {
					planStarted?.();
					await planGate;
					return fauxAssistantMessage(
						JSON.stringify({
							summary: "Update shared memory",
							rationale: "planned update",
							expectedOutcome: "updated",
							edits: [
								{
									action: "update",
									kind: "memory",
									id: "shared",
									title: "Shared",
									content: "stale planned content",
								},
							],
						}),
					);
				},
			]);

			const refinePromise = harness.session.refine({ instructions: "update shared memory" });
			await planStartedPromise;
			const concurrentState = loadHarnessState(localDir, "local");
			concurrentState.entries.memory.shared.content = "concurrent kernel content";
			concurrentState.entries.memory.shared.version++;
			saveHarnessState(localDir, concurrentState);
			releasePlan?.();

			const result = await refinePromise;
			expect(result.appliedEdits).toMatchObject([
				{ applied: false, error: "entry changed during refinement planning" },
			]);
			expect(loadHarnessState(localDir, "local").entries.memory.shared.content).toBe("concurrent kernel content");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("rolls back a local refinement in a non-persisted session via the recorded state path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const recordedDir = join(harness.tempDir, "recorded-local", "harness");
			const recordedState = loadHarnessState(recordedDir, "local");
			const seeded = applyRefinementProposal(
				recordedState,
				{
					summary: "Seed local memory",
					rationale: "seed",
					expectedOutcome: "seeded",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "remember_me",
							title: "Remember",
							content: "Content to roll back",
						},
					],
				},
				{ id: "refine_recorded", scope: "local" },
			);
			seeded.harnessStatePath = saveHarnessState(recordedDir, recordedState);
			harness.sessionManager.appendCustomEntry("prime-agent.refinement", seeded);

			const result = await harness.session.refine({ rollbackId: "refine_recorded" });

			expect(result.rollbackOf).toBe("refine_recorded");
			expect(loadHarnessState(recordedDir, "local").entries.memory.remember_me).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("keeps a legacy scope-less rollback in the global store with global scope", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const globalDir = getGlobalHarnessStateDir();
			const timestamp = new Date().toISOString();
			// Legacy (pre-scope) store: entries carry no scope fields.
			const legacyEntry = (id: string, content: string): HarnessEntry => ({
				id,
				kind: "memory",
				title: id,
				content,
				path: "general",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: timestamp,
				updated_at: timestamp,
				version: 1,
			});
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				getHarnessStatePath(globalDir),
				JSON.stringify({
					schema: 1,
					entries: {
						prompt: {},
						memory: {
							legacy_target: legacyEntry("legacy_target", "Rolled back"),
							keep_me: legacyEntry("keep_me", "Untouched"),
						},
						skill: {},
						subagent: {},
					},
					refinements: [],
				}),
			);
			const legacyRefinement: RefinementResult = {
				id: "refine_legacy",
				summary: "legacy refinement",
				rationale: "legacy",
				expectedOutcome: "legacy",
				appliedEdits: [
					{
						action: "create",
						kind: "memory",
						id: "legacy_target",
						applied: true,
						after: legacyEntry("legacy_target", "Rolled back"),
					},
				],
				harnessStatePath: getHarnessStatePath(globalDir),
			};
			harness.sessionManager.appendCustomEntry("prime-agent.refinement", legacyRefinement);

			const result = await harness.session.refine({ rollbackId: "refine_legacy" });

			expect(result.scope).toBe("global");
			const stored = JSON.parse(readFileSync(getHarnessStatePath(globalDir), "utf8"));
			expect(stored.entries.memory.legacy_target).toBeUndefined();
			expect(stored.entries.memory.keep_me.scope).toBe("global");
			const rollbackRecord = loadGlobalRefinementHistory(globalDir).find(
				(item) => item.rollbackOf === "refine_legacy",
			);
			expect(rollbackRecord).toBeDefined();
			expect(rollbackRecord?.scope).toBe("global");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("admits extension commands immediately while completion tracks the handler", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", { description: "Test", handler: async () => gate });
					pi.registerCommand("fail", {
						description: "Fail",
						handler: async () => {
							throw new Error("extension exploded");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const extensionErrors: string[] = [];
		harness.session.bindExtensions({ onError: (error) => extensionErrors.push(error.error) });

		await expect(harness.session.promptUntilAccepted("/testcmd")).resolves.toBeUndefined();
		let completed = false;
		const completion = harness.session.promptAndWait("/testcmd").then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		release?.();
		await completion;
		await expect(harness.session.promptAndWait("/fail")).rejects.toThrow("extension exploded");
		expect(extensionErrors).toEqual(["extension exploded"]);
		expect(harness.session.messages).toEqual([]);
	});

	it("settles a visibly queued session command while an earlier action is preparing", async () => {
		const hook = gatedHook({ prompt: "preparing turn" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("preparing turn", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;

		const command = harness.session.prompt("/goal status");
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toContain("/goal status"));
		await expect(command).resolves.toBeUndefined();

		hook.release();
		await harness.session.waitForIdle();
	});

	it("removes goal context while its steering handoff is still preparing", async () => {
		const hook = gatedHook({ prompt: "stale goal context" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const pause = harness.session.acquireQueuedWorkPause();
		withStreaming(harness, true);
		await harness.session.sendCustomMessage(
			{ customType: "goal_context", content: "stale goal context", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		withStreaming(harness, false);
		pause.release();
		await hook.reached;

		(harness.session as unknown as SteeringStopInternals)._clearQueuedGoalContexts();
		hook.release();
		await harness.session.waitForIdle();

		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "goal_context"),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("releases restart checkpoint waiters when preparation hands off", async () => {
		const hook = gatedHook({ prompt: "checkpoint handoff" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		let releaseResponse = () => {};
		harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					releaseResponse = resolve;
				});
				return fauxAssistantMessage("done");
			},
		]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("checkpoint handoff", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;

		let checkpointSettled = false;
		const checkpoint = harness.session.waitForSessionInputCheckpoint().then(() => {
			checkpointSettled = true;
		});
		await Promise.resolve();
		expect(checkpointSettled).toBe(false);
		hook.release();
		await vi.waitFor(() => expect(checkpointSettled).toBe(true));
		releaseResponse();
		await checkpoint;
		await harness.session.waitForIdle();
	});

	it("keeps steering stop pending while a steering handoff is still preparing", async () => {
		const hook = gatedHook({ prompt: "active steering" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		const internals = harness.session as unknown as SteeringStopInternals;
		harness.setResponses([fauxAssistantMessage("delivered")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("active steering", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;

		// The pump owns the prompt during preparation, so it is active rather than queued.
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(internals._steeringStopPending).toBe(true);
		expect(harness.session.clearQueue()).toEqual({ steering: ["active steering"], followUp: [] });
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		expect(internals._steeringStopPending).toBe(false);

		hook.release();
		await harness.session.waitForIdle();
		expect(internals._steeringStopPending).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("removes preparing inputs from literal queue projections", async () => {
		const hook = gatedHook({ prompt: "owned prompt" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("delivered")]);
		const queueUpdates: { steering: readonly string[]; followUp: readonly string[] }[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "session_action_update") {
				queueUpdates.push({ steering: [...event.actions.steering], followUp: [...event.actions.followUps] });
			}
		});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("owned prompt", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;

		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.getFollowUpMessagePreviews()).toEqual([]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
		expect(queueUpdates.at(-1)).toEqual({ steering: [], followUp: [] });

		hook.release();
		await harness.session.waitForIdle();
		expect(harness.session.queuedActionCount).toBe(0);
		expect(queueUpdates.at(-1)).toEqual({ steering: [], followUp: [] });
		expect(getUserTexts(harness)).toEqual(["owned prompt"]);
	});

	it("hides queued trigger-turn actions from user-visible queue projections", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as { _scheduleSessionInputPump(): void };
		const schedule = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {});
		await harness.session.followUp("visible queued prompt");
		const hidden = harness.session.sendCustomMessage(
			{ customType: "hidden-trigger", content: "hidden queued prompt", display: false },
			{ triggerTurn: true },
		);
		const hiddenRejection = expect(hidden).rejects.toThrow("Prompt aborted before delivery.");

		await vi.waitFor(() => expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(2));
		expect(harness.session.getFollowUpMessages()).toEqual(["visible queued prompt"]);
		expect(harness.session.getFollowUpMessagePreviews()).toEqual(["visible queued prompt"]);
		expect(harness.session.getSessionActionSnapshot()).toMatchObject({
			queuedCount: 1,
			steering: [],
			followUps: ["visible queued prompt"],
		});
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.getSessionActionRecoverySnapshot().actions.map((action) => action.payload.text)).toEqual([
			"visible queued prompt",
			"hidden queued prompt",
		]);

		harness.session.requestAbort();
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["visible queued prompt"] });
		schedule.mockRestore();
		await hiddenRejection;
	});

	it("emits the running phase when a queued turn starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const phases: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "session_action_update" && event.actions.active) {
				phases.push(event.actions.active.phase);
			}
		});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("phase probe", undefined, { resumeIfIdle: true });

		pause.release();
		await harness.session.waitForIdle();

		expect(phases).toContain("running");
	});

	it("reports selected work when resuming after an abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const command = parseSessionSlashCommand("/autonomous status");
		expect(command).toBeDefined();
		const selected = createDeferred<void>();
		const releaseSelection = createDeferred<void>();
		const internals = harness.session as unknown as {
			_executeSelectedSessionCommand(action: unknown, epoch?: number): Promise<void>;
		};
		internals._executeSelectedSessionCommand = async () => {
			selected.resolve();
			await releaseSelection.promise;
		};
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			customMessage: createSessionSlashCommandMessage(command!),
		});

		pause.release();
		await selected.promise;
		harness.session.requestAbort();
		expect(harness.session.resumeQueuedWork()).toBe(true);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [command!.text] });
		releaseSelection.resolve();
		await harness.session.waitForSessionInputIdle();
	});

	it("revalidates turn batches after acquiring the commit fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("survivor delivered")]);
		const pause = harness.session.acquireQueuedWorkPause();
		withStreaming(harness, true);
		const removed = harness.session.promptAndWait("remove after preparation", {
			streamingBehavior: "followUp",
			followUpQueueKey: "remove",
		});
		const removedOutcome = removed.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		const survivor = harness.session.promptAndWait("survive re-selection", {
			streamingBehavior: "followUp",
			followUpQueueKey: "survivor",
		});
		const survivorOutcome = survivor.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		withStreaming(harness, false);
		const internals = harness.session as unknown as {
			_acquireSessionActionCommitFence(): Promise<{ release(): void }>;
		};
		const fence = await internals._acquireSessionActionCommitFence();

		pause.release();
		try {
			await vi.waitFor(() => expect(harness.session.getSessionActionSnapshot().active?.phase).toBe("preparing"));
			expect(harness.session.removeQueuedFollowUp("remove")).toBe(true);
		} finally {
			fence.release();
		}
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect((await removedOutcome).error).toEqual(
			expect.objectContaining({ message: "Queued agent message was cleared before delivery." }),
		);
		expect((await survivorOutcome).error).toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["survive re-selection"]);
	});

	it("stops counting cleared preparing inputs as pending", async () => {
		const hook = gatedHook({ prompt: "cleared prompt" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never delivered")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("cleared prompt", undefined, { resumeIfIdle: true });
		pause.release();
		await hook.reached;
		expect(harness.session.queuedActionCount).toBe(0);

		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["cleared prompt"] });
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.getFollowUpMessagePreviews()).toEqual([]);

		hook.release();
		await harness.session.waitForSessionInputIdle();
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("coalesces a same-key follow-up while a steering owner is preparing", async () => {
		const hook = gatedHook({ prompt: "steering heartbeat" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("steering heartbeat", undefined, { queueKey: "heartbeat", resumeIfIdle: true });
		pause.release();
		await hook.reached;

		expect(await harness.session.followUp("duplicate heartbeat", undefined, { queueKey: "heartbeat" })).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		hook.release();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["steering heartbeat"]);
	});

	it("queues a same-key follow-up once the prior owner has handed off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const dispatchGate = createDeferred();
		const promptCalled = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				promptCalled.resolve();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("first heartbeat", undefined, { queueKey: "heartbeat", resumeIfIdle: true });
		pause.release();
		await promptCalled.promise;

		// The first prompt handed off to the turn; a same-key follow-up must queue
		// for the next turn instead of coalescing into the committed one.
		expect(await harness.session.followUp("second heartbeat", undefined, { queueKey: "heartbeat" })).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["second heartbeat"]);

		dispatchGate.resolve();
		await harness.session.waitForSessionInputIdle();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["first heartbeat", "second heartbeat"]);
	});

	it("does not reclaim a handed-off action before its delivery event", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("delivered")]);
		const dispatchGate = createDeferred();
		const promptCalled = createDeferred();
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptSpy = vi
			.spyOn(harness.session.agent, "prompt")
			.mockImplementation(async (messages: Parameters<typeof originalPrompt>[0]) => {
				promptSpy.mockRestore();
				promptCalled.resolve();
				await dispatchGate.promise;
				return originalPrompt(messages);
			});
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("handed off", undefined, { resumeIfIdle: true });
		pause.release();
		await promptCalled.promise;

		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		dispatchGate.resolve();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["handed off"]);
		expect(getAssistantTexts(harness)).toEqual(["delivered"]);
	});

	it("does not cancel one action from a handed-off batch", async () => {
		const firstPrompt = agentPromptText("agentmsg_batch_first", "first");
		const secondPrompt = agentPromptText("agentmsg_batch_second", "second");
		let cancelSecond: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role === "user" && getMessageText(event.message) === firstPrompt) {
							cancelSecond?.();
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("shared response")]);
		let cleared: { steering: string[]; followUp: string[] } | undefined;
		cancelSecond = () => {
			cleared = harness.session.clearQueuedUserMessagesMatching((text) => text === secondPrompt);
		};

		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt(firstPrompt, "followUp");
		await harness.session.queueAgentMessagePrompt(secondPrompt, "followUp");
		pause.release();
		await harness.session.waitForIdle();

		expect(cleared).toEqual({ steering: [], followUp: [] });
		expect(getUserTexts(harness)).toEqual([firstPrompt, secondPrompt]);
		expect(getAssistantTexts(harness)).toEqual(["shared response"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => getMessageText(entry.message)),
		).toContain("shared response");
	});

	it("keeps cleared prompts out of the handoff snapshot during the refine wait", async () => {
		let sessionInternals: { _refineInFlight?: Promise<void> };
		let clearDuringRefineWait: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						// Stall the pre-handoff refine wait and clear the queued agent
						// message inside that window; the handoff snapshot must not
						// deliver it.
						let releaseRefine: (() => void) | undefined;
						sessionInternals._refineInFlight = new Promise<void>((resolve) => {
							releaseRefine = resolve;
						});
						setTimeout(() => {
							clearDuringRefineWait?.();
							sessionInternals._refineInFlight = undefined;
							releaseRefine?.();
						}, 0);
						return {};
					});
				},
			],
		});
		harnesses.push(harness);
		sessionInternals = harness.session as unknown as { _refineInFlight?: Promise<void> };
		harness.setResponses([fauxAssistantMessage("kept response")]);

		const clearedAgentMessage = agentPromptText("agentmsg_cleared", "cleared");
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("kept");
		await harness.session.queueAgentMessagePrompt(clearedAgentMessage, "followUp", undefined);
		harness.session.setFollowUpMode("all");
		let cleared: { steering: string[]; followUp: string[] } | undefined;
		clearDuringRefineWait = () => {
			cleared = harness.session.clearQueuedUserMessagesMatching((text) => text === clearedAgentMessage);
		};
		pause.release();
		await harness.session.waitForIdle();

		expect(cleared).toEqual({ steering: [], followUp: [clearedAgentMessage] });
		expect(getUserTexts(harness)).toEqual(["kept"]);
	});

	it("restores next-turn context from cancelled actions in action order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstPrompt = agentPromptText("agentmsg_restore_first", "first");
		const secondPrompt = agentPromptText("agentmsg_restore_second", "second");
		withStreaming(harness, true);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "context A", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.queueAgentMessagePrompt(firstPrompt, "followUp");
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "context B", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.queueAgentMessagePrompt(secondPrompt, "followUp");

		expect(harness.session.clearQueue().followUp).toEqual([firstPrompt, secondPrompt]);
		expect(harness.session.getPendingNextTurnMessageSnapshots().map(getMessageText)).toEqual([
			"context A",
			"context B",
		]);
		withStreaming(harness, false);
	});

	it("delivers next-turn context when the first preparing turn is cancelled", async () => {
		const firstPrompt = agentPromptText("agentmsg_cancel_first", "cancelled");
		let cancelFirst: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						cancelFirst?.();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let cleared: { steering: string[]; followUp: string[] } | undefined;
		cancelFirst = () => {
			cleared = harness.session.clearQueuedUserMessagesMatching((text) => text === firstPrompt);
		};
		let sawNextTurnContext = false;
		harness.setResponses([
			(context) => {
				sawNextTurnContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("done");
			},
		]);

		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await harness.session.queueAgentMessagePrompt(firstPrompt, "followUp");
		await harness.session.followUp("surviving");
		pause.release();
		await harness.session.waitForIdle();

		expect(cleared).toEqual({ steering: [], followUp: [firstPrompt] });
		expect(sawNextTurnContext).toBe(true);
		expect(getUserTexts(harness)).toEqual(["surviving"]);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([fauxAssistantMessage("seed")]);
		await harness.session.prompt("seed");
		vi.spyOn(
			harness.session as unknown as { _checkCompaction(): Promise<boolean> },
			"_checkCompaction",
		).mockImplementationOnce(async () => {
			await harness.session.sendCustomMessage(
				{ customType: "next-turn", content: "carry this", display: true, details: {} },
				{ deliverAs: "nextTurn" },
			);
			return false;
		});

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
			"user",
			"assistant",
		]);
	});

	it("clears the agent queue when a queue update listener clears a newly queued steering prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt = agentPromptText("agentmsg_queue_update_clear", "clear during update");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_queue_update_clear");
		let cleared = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "session_action_update" && !cleared) {
				cleared = true;
				harness.session.clearQueue();
			}
		});

		await harness.session.queueAgentMessagePrompt(agentPrompt, "steer");
		unsubscribe();
		await expect(delivery).rejects.toThrow("cleared before delivery");
		expect(harness.session.getSteeringMessages()).toEqual([]);

		let sawClearedPrompt = false;
		harness.setResponses([
			(context) => {
				sawClearedPrompt = context.messages.some(
					(message) => message.role === "user" && getMessageText(message).includes("agentmsg_queue_update_clear"),
				);
				return fauxAssistantMessage("normal response");
			},
		]);
		await harness.session.prompt("normal");

		expect(sawClearedPrompt).toBe(false);
		expect(getUserTexts(harness)).toEqual(["normal"]);
	});

	it("clearQueue and terminal preparation errors reject delivery and completion waiters", async () => {
		// clearQueue while an active batch is preparing rejects every prompt's waiters.
		let preparationStarted: (() => void) | undefined;
		const waitForPreparation = new Promise<void>((resolve) => {
			preparationStarted = resolve;
		});
		let pause: { release(): void } | undefined;
		let gatePreparation = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!gatePreparation) return;
						preparationStarted?.();
						pause = harness.session.acquireQueuedWorkPause();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		withStreaming(harness, true);
		const firstDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_clear_first");
		const firstCompletion = harness.session.promptAndWait("clear first while preparing", {
			agentMessageId: "agentmsg_clear_first",
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const completion = harness.session.promptAndWait("clear second while preparing", {
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const firstCompletionRejection = expect(firstCompletion).rejects.toThrow("cleared before delivery");
		const completionRejection = expect(completion).rejects.toThrow("cleared before delivery");
		withStreaming(harness, false);
		await waitForPreparation;
		gatePreparation = false;
		expect(pause).toBeDefined();

		expect(harness.session.clearQueue()).toEqual({
			steering: [],
			followUp: ["clear first while preparing", "clear second while preparing"],
		});
		pause?.release();
		await firstCompletionRejection;
		await completionRejection;
		await expect(firstDelivery).rejects.toThrow("cleared before delivery");
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);

		harness.setResponses([fauxAssistantMessage("later response")]);
		await expect(
			harness.session.promptAndWait("later prompt", { agentMessageId: "agentmsg_clear_first" }),
		).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["later prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["later response"]);

		// Terminal queued-prompt preparation errors reject both delivery and completion.
		const errors: string[] = [];
		const authHarness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(authHarness);
		await authHarness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		withStreaming(authHarness, true);
		const delivery = authHarness.session.waitForAgentMessagePromptDelivery("agentmsg_terminal");
		const terminalCompletion = authHarness.session.promptAndWait("cannot start", {
			agentMessageId: "agentmsg_terminal",
			streamingBehavior: "followUp",
			resumeIfIdle: true,
		});
		const terminalRejection = expect(terminalCompletion).rejects.toThrow("No API key");
		await vi.waitFor(() => expect(authHarness.session.getFollowUpMessages()).toEqual(["cannot start"]));
		withStreaming(authHarness, false);
		await authHarness.session.waitForSessionInputIdle();

		await expect(delivery).rejects.toThrow("No API key");
		await terminalRejection;
		expect(authHarness.session.getFollowUpMessages()).toEqual([]);
		expect(errors).toEqual([expect.stringContaining("No API key")]);
	});

	it("keeps a second one-at-a-time input queued when both use the same message object", async () => {
		const firstResponse = createDeferred();
		const firstProviderStarted = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("one-at-a-time");
		harness.setResponses([
			async () => {
				firstProviderStarted.resolve();
				await firstResponse.promise;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("second done"),
		]);
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_same_object",
			source: AGENT_MESSAGE_SOURCE,
			message: "same object",
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		};
		const message = createAgentSessionMessage(payload);
		const prompt = createAgentSessionMessagePrompt(payload);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		pause.release();

		await firstProviderStarted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([prompt]);
		firstResponse.resolve();
		await harness.session.waitForIdle();

		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.messages.filter((item) => item === message)).toHaveLength(2);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	});

	it("releases external promptAndWait outcomes for pre-registered id reuse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		for (let index = 0; index < 3; index++) {
			const id = `agentmsg_completed_${index}`;
			harness.setResponses([fauxAssistantMessage(`done ${index}`)]);
			await expect(
				harness.session.promptAndWait(`prompt ${index}`, { agentMessageId: id }),
			).resolves.toBeUndefined();
		}

		const reusedId = "agentmsg_completed_0";
		let delivered = false;
		const delivery = harness.session.waitForAgentMessagePromptDelivery(reusedId).then(() => {
			delivered = true;
		});
		await Promise.resolve();
		expect(delivered).toBe(false);

		harness.setResponses([fauxAssistantMessage("reused done")]);
		await harness.session.acceptAgentMessagePrompt(agentPromptText(reusedId, "reused prompt"));
		await expect(delivery).resolves.toBeUndefined();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toHaveLength(4);
		expect(getAssistantTexts(harness)).toHaveLength(4);
	});

	it("resolves pre-registered queued and direct agent-message delivery waiters once prompts start", async () => {
		const blocked = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_start", async () => blocked.promise);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		withStreaming(harness, true);
		const queuedDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_sync");
		await harness.session.followUp("agent message", undefined, {
			agentMessageId: "agentmsg_sync",
			resumeIfIdle: true,
		});
		withStreaming(harness, false);

		// Queued delivery resolves on message_start, before the gated turn completes.
		await expect(queuedDelivery).resolves.toBeUndefined();
		blocked.resolve();
		await harness.session.waitForIdle();

		harness.setResponses([fauxAssistantMessage("direct reply")]);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_direct");
		await harness.session.acceptAgentMessagePrompt(agentPromptText("agentmsg_direct", "direct delivery"));
		await expect(delivery).resolves.toBeUndefined();
	});

	it("settles disposal and post-delivery handoff failures with distinct errors", async () => {
		// Dispose rejects pending waiters with distinct delivery and completion errors.
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt = agentPromptText("agentmsg_dispose", "dispose me");
		withStreaming(harness, true);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_dispose");
		const completion = harness.session.promptAndWait(agentPrompt, {
			agentMessageId: "agentmsg_dispose",
			streamingBehavior: "followUp",
		});
		await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]));
		harness.session.dispose();

		await expect(delivery).rejects.toThrow("disposed before prompt delivery");
		await expect(completion).rejects.toThrow("disposed before prompt completion");

		// A handoff failure after the prompt entered agent state rejects completion only.
		const handoffHarness = await createHarness();
		harnesses.push(handoffHarness);
		const prompt = handoffHarness.session.agent.prompt.bind(handoffHarness.session.agent);
		vi.spyOn(handoffHarness.session.agent, "prompt").mockImplementationOnce(async (messages) => {
			await prompt(messages);
			throw new Error("handoff failed after delivery");
		});
		withStreaming(handoffHarness, true);
		const handoffCompletion = handoffHarness.session.promptAndWait("delivered then failed", {
			streamingBehavior: "followUp",
		});
		await vi.waitFor(() => expect(handoffHarness.session.getFollowUpMessages()).toEqual(["delivered then failed"]));
		withStreaming(handoffHarness, false);

		expect(handoffHarness.session.resumeQueuedWork()).toBe(true);
		await expect(handoffCompletion).rejects.toThrow("handoff failed after delivery");
		expect(getUserTexts(handoffHarness)).toEqual(["delivered then failed"]);
		expect(handoffHarness.session.getFollowUpMessages()).toEqual([]);
	});

	it("throws when queueing an extension command", async () => {
		const queue = (harness: Harness) => harness.session.steer("/testcmd queued");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(queue(harness)).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("rejects queued command delivery and completion when the invocation append fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("durable invocation append failed");
		});
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_command_append_failed";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		const completion = harness.session.promptAndWait("/autonomous status", { agentMessageId: id });

		pause.release();
		await expect(delivery).rejects.toThrow("durable invocation append failed");
		await expect(completion).rejects.toThrow("durable invocation append failed");

		// The failed append must roll back fully: no live-only command message and
		// no unsaved leaf, so later durable entries persist cleanly.
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType.startsWith("session_slash_command"),
			),
		).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "session_slash_command"),
		).toBe(false);
		const followUpEntryId = harness.sessionManager.appendCustomMessageEntry("post-failure", "still writable", false);
		expect(harness.sessionManager.getBranch().at(-1)?.id).toBe(followUpEntryId);
	});

	it("does not record a benign compaction skip as a command failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let compactionEndErrorSeverity: string | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") compactionEndErrorSeverity = event.errorSeverity;
		});

		// Too-short session: compact() throws CompactionSkippedError.
		await harness.session.prompt("/compact");

		const commandMessages = harness.session.messages.filter(
			(message): message is Extract<(typeof harness.session.messages)[number], { role: "custom" }> =>
				message.role === "custom" && message.customType.startsWith("session_slash_command"),
		);
		expect(commandMessages.map((message) => message.customType)).toEqual(["session_slash_command"]);
		expect(compactionEndErrorSeverity).toBe("warning");
	});

	it("splits all-mode batches when execution policies differ", async () => {
		const beforeAgentStartPrompts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						beforeAgentStartPrompts.push(event.prompt);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("custom done"), fauxAssistantMessage("follow-up done")]);
		const prompt = vi.spyOn(harness.session.agent, "prompt");
		const admitted = createDeferred<void>();
		let pause: { release(): void } | undefined;
		const internals = harness.session as unknown as {
			_canStartSessionActionImmediately(): boolean;
			_scheduleSessionInputPump(): void;
		};
		const immediateEligibilitySpy = vi.spyOn(internals, "_canStartSessionActionImmediately").mockReturnValue(false);
		const scheduleSpy = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {
			pause = harness.session.acquireQueuedWorkPause();
			admitted.resolve();
		});

		const customTurn = harness.session.sendCustomMessage(
			{ customType: "trigger", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await admitted.promise;
		immediateEligibilitySpy.mockRestore();
		scheduleSpy.mockRestore();
		await harness.session.followUp("ordinary follow-up");
		pause?.release();
		await customTurn;
		await harness.session.waitForIdle();

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(beforeAgentStartPrompts).toEqual(["ordinary follow-up"]);
	});

	it("serializes concurrent trigger-turn custom messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await Promise.all([
			harness.session.sendCustomMessage(
				{ customType: "first", content: "first", display: false },
				{ triggerTurn: true },
			),
			harness.session.sendCustomMessage(
				{ customType: "second", content: "second", display: false },
				{ triggerTurn: true },
			),
		]);

		expect(
			harness.session.messages.filter((message) => message.role === "custom").map((message) => message.content),
		).toEqual(["first", "second"]);
	});

	it("pumps follow-up work admitted during a trigger-turn custom message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = false;
		harness.setResponses([
			async () => {
				queued = await harness.session.restoreFollowUpMessage("queued during custom turn");
				return fauxAssistantMessage("custom done");
			},
			fauxAssistantMessage("follow-up done"),
		]);

		await harness.session.sendCustomMessage(
			{ customType: "trigger", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();

		expect(queued).toBe(true);
		expect(getUserTexts(harness)).toEqual(["queued during custom turn"]);
		expect(getAssistantTexts(harness)).toEqual(["custom done", "follow-up done"]);
	});

	it("settles an action disposed while its queued-work pause is held", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const release = vi.spyOn(pause, "release");
		const prompt = vi.spyOn(harness.session.agent, "prompt");
		const trigger = harness.session.sendCustomMessage(
			{ customType: "trigger", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		harness.session.dispose();
		await expect(trigger).rejects.toThrow("session is disposing or disposed");

		expect(prompt).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it("rejects a post-disposal action call without prompting the agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const prompt = vi.spyOn(harness.session.agent, "prompt");
		harness.session.dispose();

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("session is disposing or disposed");
		expect(prompt).not.toHaveBeenCalled();
	});

	it.each(["queued", "preparing"] as const)(
		"keeps a coalesced duplicate with its $phase agent-message owner",
		async (phase) => {
			const prepared = createDeferred<void>();
			const releasePreparation = createDeferred<void>();
			const harness = await createHarness({
				extensionFactories:
					phase === "preparing"
						? [
								(pi) => {
									pi.on("before_agent_start", async () => {
										prepared.resolve();
										await releasePreparation.promise;
									});
								},
							]
						: [],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("accepted done")]);
			const pause = phase === "queued" ? harness.session.acquireQueuedWorkPause() : undefined;
			const id = `agentmsg_${phase}_coalesced_owner`;
			withStreaming(harness, true);
			const earlyDelivery = harness.session.waitForAgentMessagePromptDelivery(id);

			const completion = harness.session.promptAndWait("accepted", {
				streamingBehavior: "followUp",
				followUpQueueKey: "same",
				agentMessageId: id,
				resumeIfIdle: true,
			});
			if (phase === "queued") {
				await vi.waitFor(() => expect(harness.session.getFollowUpMessages()).toEqual(["accepted"]));
			} else {
				withStreaming(harness, false);
				await prepared.promise;
				expect(harness.session.getFollowUpMessages()).toEqual([]);
			}
			await expect(
				harness.session.restoreFollowUpMessage("duplicate", undefined, { queueKey: "same", agentMessageId: id }),
			).resolves.toBe(false);

			withStreaming(harness, false);
			pause?.release();
			releasePreparation.resolve();
			await expect(earlyDelivery).resolves.toBeUndefined();
			await expect(completion).resolves.toBeUndefined();
			expect(getUserTexts(harness)).toEqual(["accepted"]);
		},
	);

	it("retains active preparation while blocking duplicate and direct admission", async () => {
		let hookRuns = 0;
		let pause: { release(): void } | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "queued") {
							hookRuns++;
							pause = harness.session.acquireQueuedWorkPause();
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("direct done")]);
		withStreaming(harness, true);
		await harness.session.followUp("queued", undefined, { queueKey: "same", resumeIfIdle: true });
		withStreaming(harness, false);
		await vi.waitFor(() => expect(pause).toBeDefined());

		expect(await harness.session.followUp("duplicate", undefined, { queueKey: "same" })).toBe(false);
		const direct = harness.session.prompt("direct");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUserTexts(harness)).toEqual([]);
		pause?.release();
		await direct;

		expect(hookRuns).toBe(1);
		expect(getUserTexts(harness)).toEqual(["queued", "direct"]);
	});

	it("stops before another turn when more steering remains", async () => {
		const tool: AgentTool = {
			name: "instant",
			label: "Instant",
			description: "Returns immediately",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("instant", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("second handled"),
		]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.steer("first", undefined, { resumeIfIdle: true });
		await harness.session.steer("second", undefined, { resumeIfIdle: true });
		pause.release();
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(getAssistantTexts(harness)).toEqual(["", "second handled"]);
	});

	it.each([
		{
			action: "refine",
			run: (harness: Harness) => harness.session.refine({}, { skipAbort: true }),
		},
		{
			action: "compact",
			run: (harness: Harness) => harness.session.compact(undefined, { skipAbort: true }),
		},
	])("rejects skip-abort $action while a turn is active", async ({ action, run }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);

		await expect(run(harness)).rejects.toThrow(`Cannot ${action} without aborting while the agent is running.`);
	});

	it("serializes an extension command behind an unrelated navigation owner", async () => {
		let targetId: string | undefined;
		const navigationGate = createDeferred();
		let navigationStarts = 0;
		let commandNavigated = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						if (navigationStarts++ === 0) await navigationGate.promise;
					});
					pi.registerCommand("back", {
						description: "Navigate back",
						handler: async (_args, ctx) => {
							await ctx.navigateTree(targetId!, { summarize: false });
							commandNavigated = true;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async (target, options) => harness.session.navigateTree(target, options),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		targetId = harness.sessionManager.getEntries().find((entry) => entry.type === "message")?.id;
		expect(targetId).toBeDefined();
		await harness.session.prompt("two");
		const secondId = harness.sessionManager.getLeafId();

		const unrelatedNavigation = harness.session.navigateTree(targetId!, { summarize: false });
		await vi.waitFor(() => expect(navigationStarts).toBe(1));
		const extensionCommand = harness.session.prompt("/back");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(commandNavigated).toBe(false);

		navigationGate.resolve();
		await unrelatedNavigation;
		await extensionCommand;
		expect(commandNavigated).toBe(true);
		expect(navigationStarts).toBe(2);
		expect(harness.sessionManager.getLeafId()).not.toBe(secondId);
	});

	it("defers steer heartbeats while a non-streaming session command is running", async () => {
		const commandStarted = createDeferred();
		const commandGate = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			commandStarted.resolve();
			await commandGate.promise;
			return emptyRefinementResult();
		});

		const command = harness.session.prompt("/refine --local");
		await commandStarted.promise;
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.unfinishedActionCount).toBe(1);
		expect(harness.session.hasPendingSessionWork).toBe(false);
		expect(shouldDeferHeartbeatCronJob(heartbeatJob(), harness.session)).toBe(true);

		commandGate.resolve();
		await command;
	});

	it("keeps a slow session command on one branch while concurrent navigation waits", async () => {
		const commandStarted = createDeferred();
		const commandGate = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		await harness.session.prompt("two");
		vi.spyOn(harness.session, "refine").mockImplementation(async () => {
			commandStarted.resolve();
			await commandGate.promise;
			return emptyRefinementResult();
		});

		const command = harness.session.prompt("/refine --local");
		await commandStarted.promise;
		let navigationSettled = false;
		const navigation = harness.session.navigateTree(target!.id, { summarize: false }).then(() => {
			navigationSettled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(navigationSettled).toBe(false);

		commandGate.resolve();
		await command;
		await navigation;
		const entries = harness.sessionManager.getEntries();
		const inputEntry = entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "session_slash_command" &&
				entry.content === "/refine --local",
		);
		const resultEntry = entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "session_slash_command_result",
		);
		expect(inputEntry).toBeDefined();
		expect(resultEntry).toMatchObject({ display: false });
		expect(harness.sessionManager.getBranch(resultEntry!.id).map((entry) => entry.id)).toContain(inputEntry!.id);
	});

	it("emits refine_failed when a queued /refine command fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("one");
		vi.spyOn(harness.session, "refine").mockRejectedValue(new Error("planner unavailable"));

		const failures: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "refine_failed") failures.push(event.error);
		});

		await harness.session.prompt("/refine --local").catch(() => undefined);
		expect(failures).toEqual(["planner unavailable"]);
		const errorRow = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "session_slash_command_result");
		expect(errorRow).toMatchObject({ content: "Command failed: planner unavailable" });
	});

	it("emits an unpersisted /refine result when error-row persistence fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("one");
		vi.spyOn(harness.session, "refine").mockRejectedValue(new Error("planner unavailable"));

		const append = harness.sessionManager.appendCustomMessageEntryWithRollback.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback").mockImplementation((...args) => {
			if (args[0] === "session_slash_command_result") throw new Error("disk full");
			return append(...args);
		});
		const resultMessages: string[] = [];
		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "session_slash_command_result" &&
				typeof event.message.content === "string"
			) {
				resultMessages.push(event.message.content);
			}
		});

		await harness.session.prompt("/refine --local").catch(() => undefined);
		expect(resultMessages).toEqual(["Command failed: planner unavailable"]);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "session_slash_command_result"),
		).toBe(false);
	});

	it("does not emit refine_failed when only the result-row persist fails after a successful refine", async () => {
		const harness = await createAutoRefineHarness();
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage(refinePlanJson("no-op"))]);
			await harness.session.prompt("one");
			const append = harness.sessionManager.appendCustomMessageEntryWithRollback.bind(harness.sessionManager);
			vi.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback").mockImplementation((...args) => {
				if (args[0] === "session_slash_command_result") throw new Error("disk full");
				return append(...args);
			});
			const failures: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "refine_failed") failures.push(event.error);
			});

			await harness.session.prompt("/refine --local").catch(() => undefined);

			expect(failures).toEqual([]);
			expect(harness.session.messages.find(isRefinementOutcomeMessage)?.details.summary).toBe("no-op");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("allows a /compact extension hook to navigate without deadlocking on the commit fence", async () => {
		let targetId: string | undefined;
		let navigateFromContext: ((target: string) => Promise<{ cancelled: boolean }>) | undefined;
		let navigated = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("capture-navigation", {
						description: "Capture command context",
						handler: async (_args, ctx) => {
							navigateFromContext = (target) => ctx.navigateTree(target, { summarize: false });
						},
					});
					pi.on("session_before_compact", async () => {
						if (!navigateFromContext) throw new Error("Expected captured extension command context");
						const result = await navigateFromContext(targetId!);
						navigated = !result.cancelled;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async (target, options) => harness.session.navigateTree(target, options),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		targetId = harness.sessionManager.getEntries().find((entry) => entry.type === "message")?.id;
		expect(targetId).toBeDefined();
		await harness.session.prompt("two");
		await harness.session.prompt("/capture-navigation");

		await harness.session.prompt("/compact");

		expect(navigated).toBe(true);
	});

	it("waitForIdle yields to timers while queued work is paused", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("paused follow-up", undefined, { resumeIfIdle: true });
		const originalWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let waitCalls = 0;
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			if (++waitCalls > 100) throw new Error("waitForIdle spun without yielding");
			await originalWaitForIdle();
		});
		const waiting = harness.session.waitForIdle().then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(waitCalls).toBeLessThan(100);
			expect(harness.session.getFollowUpMessages()).toEqual(["paused follow-up"]);
		} finally {
			pause.release();
		}
		expect(await waiting).toEqual({ ok: true });
		expect(getUserTexts(harness)).toEqual(["paused follow-up"]);
	});

	it("waitForIdle yields to timers while queued work is suspended after abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.followUp("queued across abort");
		harness.session.requestAbort();
		expect(harness.session.getFollowUpMessages()).toEqual(["queued across abort"]);
		const originalWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let waitCalls = 0;
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			if (++waitCalls > 100) throw new Error("waitForIdle spun without yielding");
			await originalWaitForIdle();
		});
		const waiting = harness.session.waitForIdle().then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(waitCalls).toBeLessThan(100);
		} finally {
			harness.session.resumeQueuedWork();
		}
		expect(await waiting).toEqual({ ok: true });
		expect(getUserTexts(harness)).toEqual(["queued across abort"]);
	});

	it("admits a resumeIfIdle follow-up after abort suspends queued work", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("wake done")]);
		await harness.session.followUp("queued before abort");
		await harness.session.abort();

		await expect(harness.session.followUp("wake after abort", undefined, { resumeIfIdle: true })).resolves.toBe(true);
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["queued before abort", "wake after abort"]);
	});

	it("resumes an explicit custom trigger after an ordinary abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("trigger resumed")]);
		harness.session.requestAbort();

		await harness.session.sendCustomMessage(
			{ customType: "trigger", content: "resume after abort", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();
		expect(
			harness.session.messages.filter((message) => message.role === "custom").map((message) => message.content),
		).toContain("resume after abort");
	});

	it("rejects all new session actions while an input admission pause is held", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireSessionInputPause();
		await expect(harness.session.prompt("blocked prompt")).rejects.toThrow("input admission is paused");
		await expect(harness.session.followUp("blocked follow-up")).rejects.toThrow("input admission is paused");

		pause.release();
		harness.setResponses([fauxAssistantMessage("resumed")]);
		await harness.session.prompt("allowed prompt");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["allowed prompt"]);
	});

	it("reschedules previously queued input when an admission pause releases", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued input resumed")]);
		const internals = harness.session as unknown as {
			_sessionInputPumpRequested: boolean;
			_scheduleSessionInputPump(): void;
		};
		const schedule = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {});
		await harness.session.followUp("queued before pause");
		expect(harness.session.getFollowUpMessages()).toEqual(["queued before pause"]);
		schedule.mockRestore();

		// Model a pump that was requested before the pause invalidated its epoch.
		internals._sessionInputPumpRequested = true;
		const pause = harness.session.acquireSessionInputPause();
		expect(internals._sessionInputPumpRequested).toBe(false);
		pause.release();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["queued before pause"]);
	});

	it("does not admit a late agent message across an abort and explicit resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("user turn done")]);
		harness.session.requestAbort();
		const lateAgentMessage = harness.session.acceptAgentMessagePrompt(
			agentPromptText("agentmsg_after_abort", "late child result"),
		);
		const lateRejection = expect(lateAgentMessage).rejects.toThrow("queued session input is suspended");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		await harness.session.prompt("explicit user resume");
		await lateRejection;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["explicit user resume"]);
	});

	it("invalidates late agent-message admission when queued work is resumed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		const lateAgentMessage = harness.session.acceptAgentMessagePrompt(
			agentPromptText("agentmsg_resume_queue", "late child result"),
		);
		const lateRejection = expect(lateAgentMessage).rejects.toThrow("queued session input is suspended");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		harness.session.resumeQueuedWork();
		await lateRejection;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("waitForIdle resolves when the queue is cleared while the pump is suspended", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.followUp("cleared while suspended");
		harness.session.requestAbort();
		expect(harness.session.getFollowUpMessages()).toEqual(["cleared while suspended"]);
		const waiting = harness.session.waitForIdle().then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const cleared = harness.session.clearQueue();
		expect(cleared.followUp).toEqual(["cleared while suspended"]);
		const outcome = await Promise.race([
			waiting,
			new Promise<{ ok: false; error: Error }>((resolve) =>
				setTimeout(() => resolve({ ok: false, error: new Error("waitForIdle hung after clearQueue") }), 500),
			),
		]);
		expect(outcome).toEqual({ ok: true });
	});

	it("does not report a visible accepted prompt as accepted in flight", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);

		await harness.session.promptUntilAccepted("visible queued prompt", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});

		expect(harness.session.getFollowUpMessages()).toEqual(["visible queued prompt"]);
		expect(harness.session.hasAcceptedPromptInFlight).toBe(false);
		harness.session.clearQueue();
		withStreaming(harness, false);
	});

	it("waitForIdle observes event-queue work chained while settling", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const initialEvent = createDeferred();
		const chainedOperation = createDeferred();
		const internals = harness.session as unknown as { _agentEventQueue: Promise<void> };
		let eventQueue: Promise<void>;
		eventQueue = initialEvent.promise.then(() => {
			internals._agentEventQueue = eventQueue.then(() => chainedOperation.promise);
		});
		internals._agentEventQueue = eventQueue;
		let idle = false;
		const waiting = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		initialEvent.resolve();
		await eventQueue;
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(idle).toBe(false);
		} finally {
			chainedOperation.resolve();
		}
		await waiting;
		expect(idle).toBe(true);
	});

	it("waitForIdle observes a run that starts at its final idle boundary", async () => {
		const responseGate = createDeferred();
		const waitForResponseStart = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				waitForResponseStart.resolve();
				await responseGate.promise;
				return fauxAssistantMessage("late done");
			},
		]);
		const agentWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let waitCalls = 0;
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			await agentWaitForIdle();
			if (waitCalls++ === 0) void harness.session.agent.prompt("late run");
		});

		let idle = false;
		const waiting = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await waitForResponseStart.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(idle).toBe(false);

		responseGate.resolve();
		await waiting;
		expect(idle).toBe(true);
	});
	it("parses queued refine rollback ids and global placement without consuming instruction text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine").mockResolvedValue(emptyRefinementResult());

		for (const [command, options] of [
			["/refine rollback refine_123", { rollbackId: "refine_123", global: false }],
			["/refine rollback refine_456 --global", { rollbackId: "refine_456", global: true }],
			["/refine --global rollback refine_789", { rollbackId: "refine_789", global: true }],
			["/refine --global focus on validation", { instructions: "focus on validation", global: true }],
			[
				"/refine update docs to explain --global",
				{ instructions: "update docs to explain --global", global: false },
			],
		] as const) {
			await harness.session.prompt(command);
			expect(refine).toHaveBeenLastCalledWith(options, { skipAbort: true });
		}
	});

	it("reports a missing queued refine rollback id without invoking refine", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refine = vi.spyOn(harness.session, "refine");

		await harness.session.prompt("/refine rollback");

		expect(refine).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === "session_slash_command_result" &&
					message.content === "Command failed: Usage: /refine rollback <refinement-id>",
			),
		).toBe(true);
	});
});

describe("AgentSession scheduler scenarios", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("S1: delivers mid-run steering, follow-up, command, and custom inputs in order", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");

		const countsAtUserMessageStart: Array<{ text: string; pending: number }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				countsAtUserMessageStart.push({
					text: getMessageText(event.message),
					pending: harness.session.queuedActionCount,
				});
			}
		});

		let batchedUsers: string[] | undefined;
		let batchSawImage = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "s1",
				);
				return fauxAssistantMessage(sawSteer ? "handled s1" : "missing s1");
			},
			(context) => {
				const sawCustom = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage(sawCustom ? "handled steer custom" : "missing steer custom");
			},
			fauxAssistantMessage("handled extension steer"),
			fauxAssistantMessage("f1 done"),
			(context) => {
				batchedUsers = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				batchSawImage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "image" && part.data === "image-data"),
				);
				return fauxAssistantMessage("f2 batch done");
			},
		]);

		// Phase 1: queue all input kinds while the run is gated.
		await waitForToolStart;
		await harness.session.steer("s1");
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: {} },
			{ deliverAs: "steer" },
		);
		expect(extensionApi).toBeDefined();
		extensionApi?.sendUserMessage("extension steer", { deliverAs: "steer" });
		await harness.session.followUp("f1");
		await harness.session.prompt("/autonomous status", { streamingBehavior: "followUp" });
		await harness.session.followUp("f2");
		await harness.session.sendCustomMessage(
			{
				customType: "queue-test-follow-up",
				content: [
					{ type: "text", text: "follow-up custom" },
					{ type: "image", data: "image-data", mimeType: "image/png" },
				],
				display: true,
				details: {},
			},
			{ deliverAs: "followUp" },
		);

		// Phase 2: queued work stays in session queues, not Agent queues.
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		const pendingAfterQueueing = harness.session.queuedActionCount;
		expect(pendingAfterQueueing).toBeGreaterThan(0);
		expect(harness.session.getFollowUpMessages()).toContain("f1");
		expect(harness.session.getFollowUpMessages()).toContain("f2");

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();

		// Phase 3: steering inside the run, follow-ups after it, f2 + custom batched (all mode).
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"handled s1",
			"handled steer custom",
			"handled extension steer",
			"f1 done",
			"f2 batch done",
		]);
		expect(getUserTexts(harness)).toEqual(["start", "s1", "extension steer", "f1", "f2"]);
		expect(batchedUsers).toContain("f2");
		expect(batchedUsers).toContain("follow-up custom");
		expect(batchSawImage).toBe(true);

		// Phase 4: the command is a durable hard boundary between f1 and f2.
		const rows = harness.session.messages.map((message) =>
			message.role === "custom" ? `custom:${message.customType}` : `${message.role}`,
		);
		const userTexts = harness.session.messages.map((message) =>
			message.role === "user" ? getMessageText(message) : undefined,
		);
		const f1Index = userTexts.indexOf("f1");
		const f2Index = userTexts.indexOf("f2");
		const commandIndex = rows.indexOf("custom:session_slash_command");
		expect(commandIndex).toBeGreaterThan(f1Index);
		expect(commandIndex).toBeLessThan(f2Index);
		expect(rows).toContain("custom:autonomous_status");
		expect(rows).toContain("custom:queue-test");
		expect(rows).toContain("custom:queue-test-follow-up");

		// Phase 5: every queued input left the pending count before its message_start.
		expect(harness.session.queuedActionCount).toBe(0);
		const queuedStarts = countsAtUserMessageStart.filter((entry) => entry.text !== "start");
		expect(queuedStarts.length).toBeGreaterThan(0);
		for (const entry of queuedStarts) {
			expect(entry.pending).toBeLessThan(pendingAfterQueueing);
		}
		for (let i = 1; i < queuedStarts.length; i++) {
			expect(queuedStarts[i]!.pending).toBeLessThanOrEqual(queuedStarts[i - 1]!.pending);
		}
	});

	it("S2: edits queued work mid-run with coalescing, removal APIs, and steering-stop reconciliation", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const internals = harness.session as unknown as SteeringStopInternals;
		const removedTexts = ["first", "second", "same heartbeat", "clear me"];
		let continuationSawRemoved = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				continuationSawRemoved = context.messages.some(
					(message) =>
						message.role === "user" && removedTexts.some((text) => getMessageText(message).includes(text)),
				);
				return fauxAssistantMessage("continued clean");
			},
			fauxAssistantMessage("keep me done"),
			fauxAssistantMessage("spoof done"),
		]);
		await waitForToolStart;

		// Phase 1: keyed follow-ups coalesce per key.
		const preflights: boolean[] = [];
		await harness.session.prompt("same heartbeat", { streamingBehavior: "followUp", followUpQueueKey: "hb:one" });
		await harness.session.prompt("same heartbeat", { streamingBehavior: "followUp", followUpQueueKey: "hb:two" });
		await harness.session.prompt("same heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "hb:two",
			preflightResult: (didSucceed: boolean) => preflights.push(didSucceed),
		});
		expect(preflights).toEqual([false]);
		expect(harness.session.getFollowUpMessages()).toEqual(["same heartbeat", "same heartbeat"]);
		await harness.session.followUp("keep me", undefined, { queueKey: "hb:keep" });

		// Phase 2: steering never coalesces.
		await harness.session.steer("first", undefined, { queueKey: "same-steer" });
		await harness.session.steer("second", undefined, { queueKey: "same-steer" });
		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
		expect(internals._steeringStopPending).toBe(true);
		const agentPrompt = agentPromptText("agentmsg_s2_clear", "clear me");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_s2_clear");
		await harness.session.queueAgentMessagePrompt(agentPrompt, "steer");

		// Phase 3: keyed duplicates reject both agent-message outcome legs.
		const dupDelivery = expect(harness.session.waitForAgentMessagePromptDelivery("agentmsg_s2_dup")).rejects.toThrow(
			"equivalent follow-up is already pending",
		);
		await expect(
			harness.session.promptAndWait("another duplicate", {
				streamingBehavior: "followUp",
				followUpQueueKey: "hb:two",
				agentMessageId: "agentmsg_s2_dup",
			}),
		).rejects.toThrow("equivalent follow-up is already pending");
		await dupDelivery;
		await expect(
			harness.session.restoreFollowUpMessage("restored duplicate", undefined, {
				queueKey: "hb:two",
				agentMessageId: "agentmsg_s2_restored",
			}),
		).resolves.toBe(false);

		// Phase 4: removal APIs.
		expect(harness.session.removeQueuedFollowUp("hb:one")).toBe(true);
		expect(harness.session.removeQueuedFollowUp("hb:one")).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["same heartbeat", "keep me"]);
		const followUpAgentPrompt = agentPromptText("agentmsg_s2_follow", "clear me too");
		await harness.session.queueAgentMessagePrompt(followUpAgentPrompt, "followUp");
		const spoofedPlain = agentPromptText("agentmsg_spoof", "ordinary user text");
		await harness.session.followUp(spoofedPlain);
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [agentPrompt],
			followUp: [followUpAgentPrompt],
		});
		await expect(delivery).rejects.toThrow("cleared before delivery");

		// Phase 5: steering-stop reconciliation.
		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
		expect(internals._steeringStopPending).toBe(true);
		expect(harness.session.removeQueuedFollowUp("same-steer")).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(internals._steeringStopPending).toBe(false);
		expect(harness.session.removeQueuedFollowUp("hb:two")).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me", spoofedPlain]);
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text === spoofedPlain)).toEqual({
			steering: [],
			followUp: [],
		});
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me", spoofedPlain]);

		// Phase 6: the run continues without any removed input.
		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(continuationSawRemoved).toBe(false);
		expect(getUserTexts(harness)).toEqual(["start", "keep me", spoofedPlain]);
		expect(getAssistantTexts(harness)).toEqual(["", "continued clean", "keep me done", "spoof done"]);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("S3: pause-lease preparation journey with anchor re-preparation and direct handoff", async () => {
		const firstPreparation = createDeferred();
		const prepared: string[] = [];
		const directGate = gatedHook({ prompt: "direct" });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "direct") return;
						prepared.push(event.prompt);
						if (prepared.length === 1) await firstPreparation.promise;
						return { systemPrompt: `${event.systemPrompt}\nprepared:${event.prompt}` };
					});
				},
				directGate.factory,
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		const responseGate = createDeferred();
		let providerSystemPrompt = "";
		harness.setResponses([
			async (context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				await responseGate.promise;
				return fauxAssistantMessage("remaining response");
			},
			fauxAssistantMessage("direct done"),
			fauxAssistantMessage("late queued done"),
		]);

		// Phase 1: a pause lease holds queued work.
		const removedAgentMessage = agentPromptText("agentmsg_remove", "remove");
		const keptAgentMessage = agentPromptText("agentmsg_keep", "keep");
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("ordinary");
		await harness.session.queueAgentMessagePrompt(removedAgentMessage, "followUp", undefined);
		await harness.session.queueAgentMessagePrompt(keptAgentMessage, "followUp", undefined);
		await harness.session.followUp("last anchor", undefined, { queueKey: "heartbeat:one" });
		expect(prepared).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);

		// Phase 2: release starts preparation with the last message as batch anchor.
		pause.release();
		await vi.waitFor(() => expect(prepared).toEqual(["last anchor"]));

		// Phase 3: removals during preparation re-prepare around the new anchor.
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text === removedAgentMessage)).toEqual({
			steering: [],
			followUp: [removedAgentMessage],
		});
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(true);
		firstPreparation.resolve();
		await vi.waitFor(() => expect(providerSystemPrompt).not.toBe(""));
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(false);
		expect(prepared).toEqual(["last anchor", keptAgentMessage]);
		expect(providerSystemPrompt).toContain(`prepared:${keptAgentMessage}`);
		expect(providerSystemPrompt).not.toContain("prepared:last anchor");
		responseGate.resolve();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage]);

		// Phase 4: a direct prompt blocks queued work admitted behind it.
		const direct = harness.session.prompt("direct");
		await directGate.reached;
		await harness.session.followUp("late queued", undefined, { resumeIfIdle: true });
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage]);
		directGate.release();
		await direct;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage, "direct", "late queued"]);
	});

	it("S4: restart abort snapshots queued work and restores it, envelopes as commands", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		const firstGate = createDeferred();
		harness.setResponses([
			async () => {
				await firstGate.promise;
				return fauxAssistantMessage("first done");
			},
			() => {
				providerCalls++;
				return fauxAssistantMessage("must not run");
			},
		]);

		// Phase 1: queue a follow-up, a command with images, and an agent-message prompt mid-run.
		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await harness.session.followUp("queued for restart");
		const image = { type: "image" as const, mimeType: "image/png", data: "image-data" };
		await harness.session.prompt("/goal inspect image", { streamingBehavior: "followUp", images: [image] });
		const agentPrompt = agentPromptText("agentmsg_abort", "survive the abort");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_abort");
		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		let deliverySettled = false;
		void delivery.then(
			() => {
				deliverySettled = true;
			},
			() => {
				deliverySettled = true;
			},
		);

		// Phase 2: abortForUpdateRestart suspends the queue without starting a new turn.
		harness.session.abortForUpdateRestart();
		firstGate.resolve();
		await first.catch(() => undefined);
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();
		expect(providerCalls).toBe(0);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued for restart", "/goal inspect image", agentPrompt]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ text: "queued for restart" }) }),
			expect.objectContaining({
				payload: expect.objectContaining({ text: "/goal inspect image", images: [image] }),
			}),
			expect.objectContaining({
				agentMessageId: "agentmsg_abort",
				payload: expect.objectContaining({ text: agentPrompt }),
			}),
		]);
		expect(deliverySettled).toBe(false);

		// Phase 3: while suspended, triggerTurn rejects promptly.
		const agentPromptSpy = vi.spyOn(harness.session.agent, "prompt");
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("queued session input is suspended");
		expect(agentPromptSpy).not.toHaveBeenCalled();

		// Phase 4: restore an envelope command and a literal slash message, then resume.
		const command = parseSessionSlashCommand("/autonomous status");
		expect(command).toBeDefined();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			agentMessageId: "agentmsg_restored_command",
			customMessage: createSessionSlashCommandMessage(command!),
		});
		const mismatchedCommand = parseSessionSlashCommand("/autonomous on");
		expect(mismatchedCommand).toBeDefined();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			customMessage: createSessionSlashCommandMessage(mismatchedCommand!),
		});
		await harness.session.restoreFollowUpMessage("/autonomous off", undefined, {
			customMessage: {
				role: "custom",
				customType: "restored-literal",
				content: "/autonomous off",
				display: true,
				timestamp: Date.now(),
			},
		});
		harness.setResponses([
			fauxAssistantMessage("queued handled"),
			fauxAssistantMessage("agent prompt handled"),
			fauxAssistantMessage("literal handled"),
		]);
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();

		// Phase 5: envelope ran as a command, the literal stayed literal, delivery settled.
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(
			harness.session.messages.filter(
				(message) =>
					message.role === "custom" &&
					message.customType === "session_slash_command" &&
					(message.details as { command?: { text?: string } } | undefined)?.command?.text === command!.text,
			),
		).toHaveLength(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "restored-literal",
			),
		).toBe(true);
		await expect(delivery).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toContain("queued for restart");
		expect(getUserTexts(harness)).toContain(agentPrompt);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("S5: settles queued command delivery before gated completion and rejects completion on failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Phase 1: delivery settles at the durable append, completion stays gated.
		const started = createDeferred<void>();
		const release = createDeferred<void>();
		vi.spyOn(harness.session, "refine")
			.mockImplementationOnce(async () => {
				started.resolve();
				await release.promise;
				return emptyRefinementResult();
			})
			.mockRejectedValueOnce(new Error("refine execution failed"));
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_gated_command";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		let completionSettled = false;
		const completion = harness.session.promptAndWait("/refine --local", { agentMessageId: id }).finally(() => {
			completionSettled = true;
		});
		pause.release();
		await started.promise;
		await expect(delivery).resolves.toBeUndefined();
		expect(completionSettled).toBe(false);
		release.resolve();
		await expect(completion).resolves.toBeUndefined();

		// Phase 2: execution failure is delivered but rejects completion.
		const failedPause = harness.session.acquireQueuedWorkPause();
		const failedId = "agentmsg_failed_command";
		const failedDelivery = harness.session.waitForAgentMessagePromptDelivery(failedId);
		const failedCompletion = harness.session.promptAndWait("/refine --local", { agentMessageId: failedId });
		failedPause.release();
		await expect(failedDelivery).resolves.toBeUndefined();
		await expect(failedCompletion).rejects.toThrow("refine execution failed");
	});

	it("S6: auto-refine reviews after real turns, defers while busy, and drops reviews on navigation", async () => {
		const review2Gate = createDeferred();
		const review3Gate = createDeferred();
		const reviewer = vi.fn(
			async (context: { reason: string; turnsSinceLastReview: number }, _signal?: AbortSignal) => {
				if (reviewer.mock.calls.length === 2) await review2Gate.promise;
				if (reviewer.mock.calls.length === 3) await review3Gate.promise;
				return { shouldRefine: true, rationale: "durable lesson", instructions: `lesson ${context.reason}` };
			},
		);
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const memoryIds = () => {
				try {
					return Object.keys(loadHarnessState(localDir, "local").entries.memory ?? {});
				} catch {
					return [];
				}
			};
			const busyGate = createDeferred();
			harness.setResponses([
				fauxAssistantMessage("first done"),
				fauxAssistantMessage(
					refinePlanJson("First auto refine", [
						{ action: "create", kind: "memory", id: "auto_one", title: "One", content: "First lesson." },
					]),
				),
				fauxAssistantMessage("second done"),
				async () => {
					await busyGate.promise;
					return fauxAssistantMessage("busy done");
				},
				fauxAssistantMessage(
					refinePlanJson("Second auto refine", [
						{ action: "create", kind: "memory", id: "auto_two", title: "Two", content: "Second lesson." },
					]),
				),
				fauxAssistantMessage("fourth done"),
			]);

			// Phase 1: interval review approves and the refine applies durably.
			await harness.session.prompt("first");
			await vi.waitFor(() => expect(memoryIds()).toContain("auto_one"));
			expect(reviewer).toHaveBeenCalledTimes(1);
			expect(reviewer.mock.calls[0]![0]).toEqual({ reason: "turn_interval", turnsSinceLastReview: 1 });

			// Phase 2: review resolves while busy -> refine defers.
			await harness.session.prompt("second");
			await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(2));
			const busyPrompt = harness.session.prompt("busy");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			review2Gate.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(memoryIds()).not.toContain("auto_two");

			// Phase 3: the pending review executes at idle without a second review.
			busyGate.resolve();
			await busyPrompt;
			await vi.waitFor(() => expect(memoryIds()).toContain("auto_two"));
			expect(reviewer).toHaveBeenCalledTimes(2);

			// Phase 4: branch navigation discards the in-flight review.
			await harness.session.prompt("fourth");
			await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(3));
			const target = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			expect(target).toBeDefined();
			const navigation = harness.session.navigateTree(target!.id, { summarize: false });
			review3Gate.resolve();
			await navigation;
			await harness.session.waitForIdle();
			expect(memoryIds()).toEqual(["auto_one", "auto_two"]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});
