import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { DaemonSessionSummarizer } from "../src/modes/daemon/daemon-session-summarizer.js";

// The debounce the summarizer waits for after a turn settles (kept in sync with
// SETTLE_DEBOUNCE_MS in the module).
const SETTLE_MS = 2000;

function makeState(
	opts: { working?: boolean; messages?: number; kind?: "top-level" | "subagent"; persisted?: unknown } = {},
): ActiveSessionState {
	const appended: unknown[] = [];
	const state = {
		activeSessionId: "a1",
		summaryState: undefined,
		runtime: {
			metadata: { kind: opts.kind ?? "top-level" },
			session: {
				isStreaming: opts.working ?? false,
				isCompacting: false,
				isSessionActive: opts.working ?? false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				messages: Array.from({ length: opts.messages ?? 2 }, () => ({ role: "user", content: "hi" })),
				state: { streamingMessage: undefined },
				modelRegistry: {},
				sessionManager: {
					appendAgentStatus: (s: unknown) => appended.push(s),
					getLatestAgentStatus: () => opts.persisted,
				},
			},
		},
	} as unknown as ActiveSessionState;
	(state as unknown as { appendedStatuses: unknown[] }).appendedStatuses = appended;
	return state;
}

describe("DaemonSessionSummarizer lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("runs the model call after the settle debounce and records the verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Added the health endpoint", taskState: "completed" });
		const onStatusChanged = vi.fn();
		const summarizer = new DaemonSessionSummarizer(() => [], onStatusChanged, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		// No model call until the agent has settled for the debounce window.
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 500);
		expect(generate).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(600);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toMatchObject({ summary: "Added the health endpoint", taskState: "completed" });
		expect(onStatusChanged).toHaveBeenCalled();
	});

	test("a failing model on an idle session settles to a needs_input fallback verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue(undefined); // 404 / 401 / timeout / unparseable
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// The activity axis holds an unjudged idle session at "working"; the fallback
		// settles it to needs_input so it doesn't spin forever.
		expect(state.summaryState).toMatchObject({ taskState: "needs_input", basedOnMessageCount: 2 });
	});

	test("retries after a needs_input fallback until a real summary lands", async () => {
		vi.useFakeTimers();
		const generate = vi
			.fn()
			.mockResolvedValueOnce(undefined) // transient failure → blank needs_input fallback
			.mockResolvedValue({ summary: "Reviewed the diff", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(state.summaryState).toMatchObject({ summary: "", taskState: "needs_input" });

		// A blank recap still owes a summary, so a later sweep retries and records it.
		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(state.summaryState).toMatchObject({ summary: "Reviewed the diff", taskState: "completed" });
	});

	test("refreshes a working session even when the message count is unchanged", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Editing the router" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: true });
		// A status already exists for the current message count, so an idle session
		// would be skipped — but a working one must still refresh its recap.
		state.summaryState = { summary: "Editing the router", taskState: undefined, basedOnMessageCount: 2 };

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		expect(generate.mock.calls[0]?.[0]).toMatchObject({ isWorking: true });
	});

	test("a working refresh preserves a still-valid verdict at the same message count", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Editing the router" }); // working → no verdict
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: true });
		state.summaryState = { summary: "Asked which db", taskState: "needs_input", basedOnMessageCount: 2 };

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(state.summaryState).toMatchObject({ summary: "Editing the router", taskState: "needs_input" });
	});

	test("discards a verdict when the session is forgotten (closed) mid-call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: false });
		let summarizer!: DaemonSessionSummarizer;
		const generate = vi.fn().mockImplementation(async () => {
			summarizer.forget(state.activeSessionId); // session closes while the model runs
			return { summary: "Result after close", taskState: "completed" };
		});
		summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// Aborted → nothing written to the disposed session.
		expect(state.summaryState).toBeUndefined();
	});

	test("discards a verdict when a new turn arrives during the model call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: false });
		// The model "responds" only after the session has moved on to a new turn.
		const generate = vi.fn().mockImplementation(async () => {
			(state.runtime.session.messages as unknown[]).push({ role: "user", content: "another task" });
			return { summary: "Stale summary for the old turn", taskState: "completed" };
		});
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// Result is for an outdated turn → dropped, nothing persisted.
		expect(state.summaryState).toBeUndefined();
	});

	test("summarizes a subagent and persists its settled idle verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Auditing the migration scripts", taskState: "completed" });
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false, kind: "subagent" });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);

		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toMatchObject({ summary: "Auditing the migration scripts", taskState: "completed" });
		expect((state as unknown as { appendedStatuses: unknown[] }).appendedStatuses).toHaveLength(1);
	});

	test("seeds a subagent's persisted recap into memory", () => {
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, vi.fn());
		const persisted = { summary: "Reviewing the diff", taskState: "needs_input", basedOnMessageCount: 3 };
		const state = makeState({ kind: "subagent", persisted });

		summarizer.seed(state);
		expect(state.summaryState).toEqual(persisted);
	});
});
