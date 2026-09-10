import type { GetContinuationMessagesContext } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { emptyGoalState } from "../src/core/goals.js";
import { ActionStore } from "../src/core/session-action-store.js";
import { GoalController } from "../src/goals/controller.js";
import { SessionGoalContinuation, type SessionGoalContinuationHost } from "../src/session/goal-continuation.js";
import { SessionInputScheduler } from "../src/session/input-scheduler.js";
import type { QueuedSessionAction } from "../src/session/prepared-actions.js";

function harness(overrides: { awaitsChildWork?: boolean } & Partial<SessionGoalContinuationHost> = {}) {
	const goals = new GoalController({ load: emptyGoalState, save: () => {} }, () => {});
	goals.start("ship it", undefined);
	const actions = new ActionStore<QueuedSessionAction>();
	const scheduler = new SessionInputScheduler({ canSchedule: () => false, run: async () => {} });
	const admit = vi.fn<SessionGoalContinuationHost["admit"]>(
		overrides.admit ??
			((action) => {
				actions.enqueue(action);
				return { accepted: true, disposition: "queued" };
			}),
	);
	const owner = new SessionGoalContinuation(goals, actions, {
		getGoalState: () => goals.current,
		getScheduler: () => scheduler,
		isDisposed: () => false,
		isDisposing: () => false,
		hasUnsettledChildWork: () => false,
		ensureRuntimeActive: () => {},
		cancelActions: (predicate) => actions.remove(predicate),
		clearPendingGoalContexts: () => {},
		emitQueueUpdate: () => {},
		emitGoalUpdate: () => {},
		validate: async () => {},
		isStreaming: () => false,
		includesGoals: () => true,
		getAgent: () => ({ removeQueuedMessages: () => [] }),
		...overrides,
		admit,
	});
	if (overrides.awaitsChildWork) owner.deferUntilChildSettlement();
	return { owner, goals, scheduler, actions, admit };
}

const context: GetContinuationMessagesContext = {
	message: fauxAssistantMessage("done"),
	toolResults: [],
	context: { systemPrompt: "", messages: [], tools: [] },
	newMessages: [],
};

describe("goal continuation vs unsettled subagent work", () => {
	it("defers the continuation while descendant work is unsettled", async () => {
		const mode = harness({ hasUnsettledChildWork: () => true });
		await expect(mode.owner.getGoalContinuationMessages(context)).resolves.toEqual([]);
		expect(mode.owner.awaitsChildWork).toBe(true);
		expect(mode.goals.state.continuationsUsed).toBe(0);
	});

	it("continues normally when no descendant work is pending", async () => {
		const mode = harness();
		const messages = await mode.owner.getGoalContinuationMessages(context);
		expect(messages).toHaveLength(1);
		expect(mode.owner.awaitsChildWork).toBe(false);
		expect(mode.goals.state.continuationsUsed).toBe(1);
	});

	it("resumes a deferred continuation exactly once, unqueued, idle-waking, and counted", () => {
		const mode = harness({ awaitsChildWork: true });
		mode.owner.maybeResumeGoalContinuationAfterRlmWork();
		mode.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(mode.admit).toHaveBeenCalledTimes(1);
		const [action, options] = mode.admit.mock.calls[0]!;
		expect(action?.wake).toBe("immediate");
		expect(options).toBeUndefined();
		expect(mode.goals.state.continuationsUsed).toBe(1);
	});

	it("keeps the deferral while admission is paused and retries after release", () => {
		const paused = harness({
			awaitsChildWork: true,
		});
		const pause = paused.scheduler.acquireAdmissionPause(() => {});
		paused.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(paused.admit).not.toHaveBeenCalled();
		expect(paused.owner.awaitsChildWork).toBe(true);

		pause.release();
		paused.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(paused.admit).toHaveBeenCalledTimes(1);
		expect(paused.owner.awaitsChildWork).toBe(false);
	});

	it("keeps the deferral while the pump is suspended after an abort", () => {
		const mode = harness({ awaitsChildWork: true });
		mode.scheduler.suspend("abort");
		mode.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(mode.admit).not.toHaveBeenCalled();
		expect(mode.owner.awaitsChildWork).toBe(true);
	});

	it("keeps the deferral and rolls back the count when admission throws", () => {
		const mode = harness({
			awaitsChildWork: true,
			admit: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		mode.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(mode.owner.awaitsChildWork).toBe(true);
		expect(mode.goals.state.continuationsUsed).toBe(0);
	});

	it("stays deferred while work remains and drops the deferral for inactive goals", () => {
		const busy = harness({ awaitsChildWork: true, hasUnsettledChildWork: () => true });
		busy.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(busy.admit).not.toHaveBeenCalled();
		expect(busy.owner.awaitsChildWork).toBe(true);

		const inactive = harness({ awaitsChildWork: true });
		inactive.goals.pause();
		inactive.owner.maybeResumeGoalContinuationAfterRlmWork();
		expect(inactive.admit).not.toHaveBeenCalled();
		expect(inactive.owner.awaitsChildWork).toBe(false);
	});
});
