import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

type Harness = {
	_goalState: { status: string; objective?: string; continuationsUsed: number };
	_goalContinuationAwaitsRlmWork: boolean;
	_disposed: boolean;
	_disposing: boolean;
	_sessionInputAdmissionPauses: Set<symbol>;
	_sessionInputPumpSuspended: boolean;
	_hasUnsettledRlmQuiescenceWork: () => boolean;
	_stopGoalContinuationForTerminalMessage: () => boolean;
	_ensureGoalRuntimeActive: () => void;
	_setGoalState: (goal: unknown) => void;
	_createPreparedTurnAction: ReturnType<typeof vi.fn>;
	_admitSessionInput: ReturnType<typeof vi.fn>;
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
		_sessionInputAdmissionPauses: new Set(),
		_sessionInputPumpSuspended: false,
		_hasUnsettledRlmQuiescenceWork: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_ensureGoalRuntimeActive: () => {},
		_setGoalState: function (this: Harness, goal: unknown) {
			this._goalState = goal as Harness["_goalState"];
		},
		_createPreparedTurnAction: vi.fn((schedule: string, _text: string, _images: unknown, options: unknown) => ({
			schedule,
			options,
		})),
		_admitSessionInput: vi.fn(),
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

	it("resumes a deferred continuation exactly once, unqueued, idle-waking, and counted", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		maybeResume.call(mode);
		maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action, options] = mode._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(options).toBeUndefined();
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("keeps the deferral while admission is paused and retries after release", () => {
		const paused = harness({
			_goalContinuationAwaitsRlmWork: true,
			_sessionInputAdmissionPauses: new Set([Symbol("pause")]),
		});
		maybeResume.call(paused);
		expect(paused._admitSessionInput).not.toHaveBeenCalled();
		expect(paused._goalContinuationAwaitsRlmWork).toBe(true);

		paused._sessionInputAdmissionPauses.clear();
		maybeResume.call(paused);
		expect(paused._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(paused._goalContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps the deferral while the pump is suspended after an abort", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true, _sessionInputPumpSuspended: true });
		maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
	});

	it("keeps the deferral and rolls back the count when admission throws", () => {
		const mode = harness({
			_goalContinuationAwaitsRlmWork: true,
			_admitSessionInput: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		maybeResume.call(mode);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("stays deferred while work remains and drops the deferral for inactive goals", () => {
		const busy = harness({ _goalContinuationAwaitsRlmWork: true, _hasUnsettledRlmQuiescenceWork: () => true });
		maybeResume.call(busy);
		expect(busy._admitSessionInput).not.toHaveBeenCalled();
		expect(busy._goalContinuationAwaitsRlmWork).toBe(true);

		const inactive = harness({ _goalContinuationAwaitsRlmWork: true });
		inactive._goalState = { status: "paused", objective: "ship it", continuationsUsed: 0 };
		maybeResume.call(inactive);
		expect(inactive._admitSessionInput).not.toHaveBeenCalled();
		expect(inactive._goalContinuationAwaitsRlmWork).toBe(false);
	});
});
