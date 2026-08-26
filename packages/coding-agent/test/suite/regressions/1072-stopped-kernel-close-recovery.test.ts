import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import * as childProcessUtils from "../../../src/utils/child-process.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * Regression for https://github.com/PrimeIntellect-ai/prime-agent/issues/1072.
 *
 * A session close awaits its runtime's dispose(), which can hang forever if
 * the session's kernel process is genuinely OS-level job-control-stopped
 * (e.g. an external SIGSTOP) rather than merely slow. Left alone, the
 * closingSessions bookkeeping never clears, so every future attach/close for
 * that session fails with "Active session <id> is closing" until the whole
 * daemon/worker is killed. These tests drive the real closeSession() path
 * with a deliberately-hung dispose() and a mocked isStoppedProcess(), rather
 * than testing the private stall-recovery method in isolation, so the
 * regression is proven end to end through the same code path a real attach
 * would exercise.
 */

type DaemonInternals = {
	sessions: Map<string, ActiveSessionState>;
	closingSessions: Map<string, { promise: Promise<void>; reason: string }>;
	closeSession(
		state: ActiveSessionState,
		reason: string,
		waitForAbort?: boolean,
		cascadeChildren?: boolean,
	): Promise<void>;
};

function createDaemonInternals(harness: Harness): DaemonInternals {
	const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
		defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return daemon as unknown as DaemonInternals;
}

function createHungState(
	harness: Harness,
	activeSessionId: string,
): { state: ActiveSessionState; disposeCalled: Promise<void> } {
	let resolveDisposeCalled: () => void = () => {};
	const disposeCalled = new Promise<void>((resolve) => {
		resolveDisposeCalled = resolve;
	});
	const runtime = {
		session: harness.session,
		metadata: { kind: "top-level", createdAt: Date.now() },
		cwd: harness.tempDir,
		runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		diagnostics: [],
		dispose: async () => {
			resolveDisposeCalled();
			// A job-control-stopped kernel means this genuinely never resolves.
			await new Promise<void>(() => {});
		},
	} as unknown as AgentSessionRuntime;
	const state = {
		activeSessionId,
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: `generation-${activeSessionId}`,
		lastEventSequence: 0,
	} as unknown as ActiveSessionState;
	return { state, disposeCalled };
}

describe("regression #1072: stopped-kernel close recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("releases closingSessions after the kernel stays OS-stopped through a SIGCONT attempt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		const { state } = createHungState(harness, "active-1");
		internals.sessions.set(state.activeSessionId, state);

		const fakePid = 987_654; // never a real pid; isStoppedProcess is mocked below
		Object.defineProperty(harness.session, "kernelProcessPid", { value: fakePid, configurable: true });
		vi.spyOn(childProcessUtils, "isStoppedProcess").mockReturnValue(true);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		const closePromise = internals.closeSession(state, "killed");
		// Let the close start and the watchdog begin polling, without waiting on
		// the (deliberately never-resolving) close itself.
		await vi.advanceTimersByTimeAsync(0);

		expect(internals.closingSessions.has("active-1")).toBe(true);

		// First poll: confirmed stopped -> SIGCONT attempt, bookkeeping still held.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(killSpy).toHaveBeenCalledWith(fakePid, "SIGCONT");
		expect(internals.closingSessions.has("active-1")).toBe(true);

		// Two more confirmations despite SIGCONT -> give up waiting and recover.
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(internals.closingSessions.has("active-1")).toBe(false);

		vi.useRealTimers();
		// The original close is still running in the background; don't leak it
		// into the next test as an unhandled rejection.
		void closePromise.catch(() => undefined);
	});

	it("does not touch closingSessions while the kernel is merely slow, not OS-stopped", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = createDaemonInternals(harness);
		const { state } = createHungState(harness, "active-2");
		internals.sessions.set(state.activeSessionId, state);

		const fakePid = 987_655;
		Object.defineProperty(harness.session, "kernelProcessPid", { value: fakePid, configurable: true });
		vi.spyOn(childProcessUtils, "isStoppedProcess").mockReturnValue(false);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		const closePromise = internals.closeSession(state, "killed");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(killSpy).not.toHaveBeenCalled();
		expect(internals.closingSessions.has("active-2")).toBe(true);

		vi.useRealTimers();
		void closePromise.catch(() => undefined);
	});
});
