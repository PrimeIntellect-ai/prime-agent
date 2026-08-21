import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

type Harness = {
	_goalState: { status: string; objective?: string; continuationsUsed: number };
	_goalContinuationAwaitsRlmWork: boolean;
	_disposed: boolean;
	_disposing: boolean;
	_hasUnsettledRlmQuiescenceWork: () => boolean;
	_stopGoalContinuationForTerminalMessage: () => boolean;
	_ensureGoalRuntimeActive: () => void;
	_setGoalState: (goal: unknown) => void;
	_runOrQueueGoalContext: ReturnType<typeof vi.fn>;
};

const getGoalContinuation = Reflect.get(AgentSession.prototype, "_getGoalContinuationMessages") as (
	this: Harness,
	context: { message: unknown; context: unknown },
) => Promise<unknown[]>;
const maybeResume = Reflect.get(AgentSession.prototype, "_maybeResumeGoalContinuationAfterRlmWork") as (
	this: Harness,
) => void;

function harness(overrides: Partial<Harness> = {}): Harness {
	return {
		_goalState: { status: "active", objective: "ship it", continuationsUsed: 0 },
		_goalContinuationAwaitsRlmWork: false,
		_disposed: false,
		_disposing: false,
		_hasUnsettledRlmQuiescenceWork: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_ensureGoalRuntimeActive: () => {},
		_setGoalState: function (this: Harness, goal: unknown) {
			this._goalState = goal as Harness["_goalState"];
		},
		_runOrQueueGoalContext: vi.fn(),
		...overrides,
	};
}

const context = { message: { role: "assistant", stopReason: "stop" }, context: {} };

describe("goal continuation vs unsettled subagent work", () => {
	it("defers the continuation while descendant work is unsettled", async () => {
		const mode = harness({ _hasUnsettledRlmQuiescenceWork: () => true });
		await expect(getGoalContinuation.call(mode, context)).resolves.toEqual([]);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("continues normally when no descendant work is pending", async () => {
		const mode = harness();
		const messages = await getGoalContinuation.call(mode, context);
		expect(messages).toHaveLength(1);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(false);
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("resumes a deferred continuation exactly once after settlement", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		maybeResume.call(mode);
		maybeResume.call(mode);
		expect(mode._runOrQueueGoalContext).toHaveBeenCalledTimes(1);
		expect(mode._runOrQueueGoalContext).toHaveBeenCalledWith("continuation");
	});

	it("stays deferred while work remains and skips inactive goals", () => {
		const busy = harness({ _goalContinuationAwaitsRlmWork: true, _hasUnsettledRlmQuiescenceWork: () => true });
		maybeResume.call(busy);
		expect(busy._runOrQueueGoalContext).not.toHaveBeenCalled();
		expect(busy._goalContinuationAwaitsRlmWork).toBe(true);

		const inactive = harness({ _goalContinuationAwaitsRlmWork: true });
		inactive._goalState = { status: "paused", objective: "ship it", continuationsUsed: 0 };
		maybeResume.call(inactive);
		expect(inactive._runOrQueueGoalContext).not.toHaveBeenCalled();
		expect(inactive._goalContinuationAwaitsRlmWork).toBe(false);
	});
});
