import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import {
	type AutonomousRuntimeState,
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_LIMITS,
	DEFAULT_AUTONOMOUS_SUBAGENT_KEEP_ALIVE_MS,
} from "../src/core/autonomous.js";

type FakeAssistantMessage = { role: "assistant"; stopReason: string };

type FakeSession = {
	_autonomousState: AutonomousRuntimeState;
	_autonomousContinuationAwaitsRlmWork: boolean;
	_autonomousSubagentKeepAliveTimer: ReturnType<typeof setTimeout> | undefined;
	_autonomousContinuationResumeTask: Promise<void> | undefined;
	_lastAssistantMessage: { role: "assistant"; stopReason: string } | undefined;
	agent: { signal: AbortSignal | undefined; state: { messages: unknown[] } };
	_disposed: boolean;
	_disposing: boolean;
	_sessionInputAdmissionPauses: Set<symbol>;
	_sessionInputPumpSuspended: boolean;
	_sessionInputArrivalEpoch: number;
	_cwd: string | undefined;
	queuedActionCount: number;
	_goalState: { status: string; objective?: string };
	_goalAccountingStartedAt: number | undefined;
	_getGoalContinuationMessages: () => Promise<unknown[]>;
	_autonomousContinuationSuppressionDepth: number;
	_autonomousContinuationSuppressedMessages: WeakSet<object>;
	_hasUnsettledRlmQuiescenceWork: () => boolean;
	_hasLiveBackgroundBashHandles: () => boolean;
	_rlmTerminalNoticeAdmissionCount: number;
	_admitSessionInput: ReturnType<typeof vi.fn>;
	_createPreparedTurnAction: ReturnType<typeof vi.fn>;
	_snapshotAutonomousRuntimeState: () => unknown;
	_restoreAutonomousRuntimeSnapshot: (snapshot: unknown) => void;
};

const getContinuationMessages = Reflect.get(AgentSession.prototype, "_getContinuationMessages") as (
	this: FakeSession,
	context: { message: FakeAssistantMessage; newMessages: unknown[] },
	signal?: AbortSignal,
) => Promise<unknown[]>;
const holdForRlmWork = Reflect.get(AgentSession.prototype, "_holdAutonomousContinuationForRlmWork") as (
	this: FakeSession,
	message: FakeAssistantMessage,
) => boolean;
const maybeResume = Reflect.get(AgentSession.prototype, "_maybeResumeAutonomousContinuationAfterRlmWork") as (
	this: FakeSession,
) => void;
const fireKeepAlive = Reflect.get(AgentSession.prototype, "_fireAutonomousSubagentKeepAlive") as (
	this: FakeSession,
) => void;
const queueThresholdContinuation = Reflect.get(
	AgentSession.prototype,
	"_queueAutonomousContinuationForThresholdCompaction",
) as (this: FakeSession, message: FakeAssistantMessage) => Promise<unknown>;
const snapshotRuntimeState = Reflect.get(AgentSession.prototype, "_snapshotAutonomousRuntimeState") as (
	this: FakeSession,
) => unknown;
const restoreRuntimeSnapshot = Reflect.get(AgentSession.prototype, "_restoreAutonomousRuntimeSnapshot") as (
	this: FakeSession,
	snapshot: unknown,
) => void;

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
	const session: FakeSession = {
		_autonomousState: createAutonomousRuntimeState({ enabled: true, maxContinuations: 5 }),
		_autonomousContinuationAwaitsRlmWork: false,
		_autonomousSubagentKeepAliveTimer: undefined,
		_autonomousContinuationResumeTask: undefined,
		_lastAssistantMessage: { role: "assistant", stopReason: "stop" },
		agent: { signal: undefined, state: { messages: [] } },
		_disposed: false,
		_disposing: false,
		_sessionInputAdmissionPauses: new Set(),
		_sessionInputPumpSuspended: false,
		_sessionInputArrivalEpoch: 0,
		_cwd: undefined,
		queuedActionCount: 0,
		_goalState: { status: "idle" },
		_goalAccountingStartedAt: undefined,
		_getGoalContinuationMessages: async () => [],
		_autonomousContinuationSuppressionDepth: 0,
		_autonomousContinuationSuppressedMessages: new WeakSet(),
		_hasUnsettledRlmQuiescenceWork: () => false,
		_hasLiveBackgroundBashHandles: () => false,
		_rlmTerminalNoticeAdmissionCount: 0,
		_admitSessionInput: vi.fn(),
		_createPreparedTurnAction: vi.fn(
			(schedule: string, _text: string, _images: unknown, options: Record<string, unknown>) => ({
				schedule,
				options,
			}),
		),
		_snapshotAutonomousRuntimeState: () => undefined,
		_restoreAutonomousRuntimeSnapshot: () => undefined,
		...overrides,
	};
	// The gate, resume, and keep-alive methods run for real: assign the
	// prototype functions as own properties so internal `this.` calls land on
	// the fake session.
	const realMethods = [
		"_holdAutonomousContinuationForRlmWork",
		"_maybeResumeAutonomousContinuationAfterRlmWork",
		"_resumeOwedAutonomousContinuation",
		"_goalOwnsContinuationWakeup",
		"_deliverAutonomousSubagentKeepAlive",
		"_admitOwedAutonomousContinuation",
		"_findLastAssistantInMessages",
		"_armAutonomousSubagentKeepAlive",
		"_disarmAutonomousSubagentKeepAlive",
		"_clearAutonomousContinuationAwait",
		"_fireAutonomousSubagentKeepAlive",
	] as const;
	for (const method of realMethods) {
		(session as unknown as Record<string, unknown>)[method] = Reflect.get(AgentSession.prototype, method);
	}
	// Real prototype helpers read the live state object, so keep the snapshot
	// pair bound to the fake session.
	session._snapshotAutonomousRuntimeState = () => snapshotRuntimeState.call(session);
	session._restoreAutonomousRuntimeSnapshot = (snapshot: unknown) => restoreRuntimeSnapshot.call(session, snapshot);
	return session;
}

const stoppedTurn = { role: "assistant", stopReason: "stop" } as FakeAssistantMessage;
const context = { message: stoppedTurn, newMessages: [] };

describe("autonomous continuation vs active subagents", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedules a continuation and counts it when no descendant work is pending", async () => {
		const session = fakeSession();
		const messages = await getContinuationMessages.call(session, context);
		expect(messages).toHaveLength(1);
		expect(session._autonomousState.continuationsUsed).toBe(1);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("holds the timer-driven continuation while a child runs without spending budget", async () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
		});
		const messages = await getContinuationMessages.call(session, context);
		expect(messages).toEqual([]);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(0);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("holds the timer-driven continuation while a background bash handle runs without spending budget", async () => {
		vi.useFakeTimers();
		const session = fakeSession({ _hasLiveBackgroundBashHandles: () => true });
		expect(await getContinuationMessages.call(session, context)).toEqual([]);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});
	it("re-polls the keep-alive instead of waking the parent while only background handles run", () => {
		vi.useFakeTimers();
		const session = fakeSession({ _hasLiveBackgroundBashHandles: () => true });
		session._autonomousState.subagentKeepAliveMs = 1_000;
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		vi.advanceTimersByTime(1_000);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
	});
	it("holds without queueing behind an active goal continuation", () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
		});
		session._autonomousContinuationAwaitsRlmWork = true;
		session._goalState = { status: "active", objective: "ship it" };
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		// The goal's own continuation loop takes over the owed continuation.
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("drops a held continuation when a goal takes over at settlement", () => {
		const session = fakeSession({ _autonomousContinuationAwaitsRlmWork: true });
		session._goalState = { status: "active", objective: "ship it" };
		maybeResume.call(session);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("drops a pending keep-alive when a goal takes over while children stay active", () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, subagentKeepAliveMs: 1_000 }),
		});
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		session._goalState = { status: "active", objective: "ship it" };
		vi.advanceTimersByTime(1_000);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("does not hold the continuation for aborted or errored turns", async () => {
		const session = fakeSession({ _hasUnsettledRlmQuiescenceWork: () => true });
		for (const stopReason of ["aborted", "error"]) {
			const held = holdForRlmWork.call(session, { role: "assistant", stopReason });
			expect(held).toBe(false);
		}
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		await expect(
			getContinuationMessages.call(session, {
				message: { role: "assistant", stopReason: "aborted" },
				newMessages: [],
			}),
		).resolves.toEqual([]);
		expect(session._autonomousState.continuationsUsed).toBe(0);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("resumes the held continuation exactly once, unqueued, idle-waking, and counted", async () => {
		const session = fakeSession({ _autonomousContinuationAwaitsRlmWork: true });
		maybeResume.call(session);
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action] = session._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(1);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps the deferral while descendant work remains", () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_hasUnsettledRlmQuiescenceWork: () => true,
		});
		maybeResume.call(session);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("keeps the deferral while admission is paused and retries after release", async () => {
		const session = fakeSession({ _autonomousContinuationAwaitsRlmWork: true });
		session._sessionInputAdmissionPauses.add(Symbol("pause"));
		maybeResume.call(session);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);

		session._sessionInputAdmissionPauses.clear();
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps the deferral while the pump is suspended after an abort", () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_sessionInputPumpSuspended: true,
		});
		maybeResume.call(session);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
	});

	it("keeps the deferral and rolls back the count when admission throws", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_admitSessionInput: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("drops the held continuation when autonomous mode is disabled", () => {
		const session = fakeSession({ _autonomousContinuationAwaitsRlmWork: true });
		session._autonomousState.enabled = false;
		maybeResume.call(session);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("drops the held continuation when limits are already reached", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, maxContinuations: 1 }),
		});
		session._autonomousState.continuationsUsed = 1;
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(1);
	});

	it("skips the owed continuation when configured gates pass at settlement", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["true"] },
			}),
		});
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("delivers a gate-failure continuation when configured gates fail at settlement", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["false"] },
			}),
		});
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action] = session._admitSessionInput.mock.calls[0]!;
		const message = (action as { options: { message: { content: Array<{ text: string }> } } }).options.message;
		expect(message.content[0]!.text).toContain("[autonomous-continuation: gate-failed]");
		expect(session._autonomousState.continuationsUsed).toBe(1);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("fires one keep-alive continuation per window while children stay active", () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, subagentKeepAliveMs: 1_000 }),
		});
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		vi.advanceTimersByTime(1_000);
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action] = session._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(1);
		// Children are still active: the next turn end re-holds and re-arms.
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		vi.advanceTimersByTime(999);
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(session._admitSessionInput).toHaveBeenCalledTimes(2);
		expect(session._autonomousState.continuationsUsed).toBe(2);
	});

	it("delivers the plain owed continuation, not a keep-alive, when children settle first", async () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, subagentKeepAliveMs: 1_000 }),
		});
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		session._hasUnsettledRlmQuiescenceWork = () => false;
		fireKeepAlive.call(session);
		await session._autonomousContinuationResumeTask;
		const [action] = session._admitSessionInput.mock.calls[0]!;
		const message = (action as { options: { message: { content: Array<{ text: string }> } } }).options.message;
		expect(message.content[0]!.text).toContain("[autonomous-continuation]");
		expect(message.content[0]!.text).not.toContain("subagent-keep-alive");
		expect(session._autonomousState.continuationsUsed).toBe(1);
	});

	it("never arms a keep-alive when the valve is disabled with 0", () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, subagentKeepAliveMs: 0 }),
		});
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(session._autonomousState.subagentKeepAliveMs).toBe(0);
	});

	it("retries the keep-alive after the window when admission is paused", () => {
		vi.useFakeTimers();
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, subagentKeepAliveMs: 1_000 }),
		});
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(true);
		session._sessionInputAdmissionPauses.add(Symbol("pause"));
		vi.advanceTimersByTime(1_000);
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		session._sessionInputAdmissionPauses.clear();
		vi.advanceTimersByTime(1_000);
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
	});

	it("keeps the default keep-alive window under the default wall-clock budget", () => {
		// A window at or above the timeout would be blocked by the wall-clock
		// limit at the fire time, so the valve could never wake the parent.
		expect(DEFAULT_AUTONOMOUS_SUBAGENT_KEEP_ALIVE_MS).toBeGreaterThan(0);
		expect(DEFAULT_AUTONOMOUS_SUBAGENT_KEEP_ALIVE_MS).toBeLessThan(DEFAULT_AUTONOMOUS_LIMITS.timeoutMs);
	});

	it("does not hold the continuation once limits are reached", async () => {
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
			_autonomousState: createAutonomousRuntimeState({ enabled: true, maxContinuations: 1 }),
		});
		session._autonomousState.continuationsUsed = 1;
		expect(holdForRlmWork.call(session, stoppedTurn)).toBe(false);
		await expect(getContinuationMessages.call(session, context)).resolves.toEqual([]);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(1);
	});

	it("drops a stale owed continuation when user-driven work arrives during the gate evaluation", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["false"] },
			}),
		});
		maybeResume.call(session);
		// A user prompt is admitted (and may even finish) while the gate
		// command is still running; the epoch sees it either way.
		session._sessionInputArrivalEpoch++;
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		// Nothing was spent on the dropped continuation.
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("delivers past sibling terminal notices admitted during the gate evaluation", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["false"] },
			}),
		});
		maybeResume.call(session);
		// A second child exits while the gate command is still running: the
		// notice admission is not user-driven, and the owed continuation is
		// the wake that reads it.
		session._sessionInputArrivalEpoch++;
		session._rlmTerminalNoticeAdmissionCount++;
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).toHaveBeenCalledTimes(1);
		expect(session._autonomousState.continuationsUsed).toBe(1);
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
	});

	it("keeps a user-reset budget when dropping a stale owed continuation", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["false"] },
			}),
		});
		maybeResume.call(session);
		// The user resets the run while the gate command is still running.
		session._autonomousState.continuationsUsed = 0;
		session._autonomousState.startedAt = (session._autonomousState.startedAt ?? 0) + 1;
		session._sessionInputArrivalEpoch++;
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		// The reset budget is untouched: no phantom continuation was spent.
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("evaluates gates from the transcript after agent_end clears the live last-assistant field", async () => {
		const session = fakeSession({
			_autonomousContinuationAwaitsRlmWork: true,
			_cwd: "/tmp",
			_lastAssistantMessage: undefined,
			agent: { signal: undefined, state: { messages: [stoppedTurn] } },
			_autonomousState: createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 5,
				gates: { commands: ["true"] },
			}),
		});
		maybeResume.call(session);
		await session._autonomousContinuationResumeTask;
		expect(session._admitSessionInput).not.toHaveBeenCalled();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(false);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});

	it("holds the threshold-compaction continuation while a child runs", async () => {
		const session = fakeSession({
			_hasUnsettledRlmQuiescenceWork: () => true,
		}) as FakeSession & {
			_queuedAutonomousThresholdContinuations: Map<unknown, unknown>;
			_postCompactionContinuationMessages: unknown[];
		};
		session._queuedAutonomousThresholdContinuations = new Map();
		session._postCompactionContinuationMessages = [];
		const queued = await queueThresholdContinuation.call(session, stoppedTurn);
		expect(queued).toBeUndefined();
		expect(session._autonomousContinuationAwaitsRlmWork).toBe(true);
		expect(session._autonomousState.continuationsUsed).toBe(0);
	});
});
