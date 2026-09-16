import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningDaemonProbe } from "../src/cli/daemon-launch.js";
import { confirmDaemonSessionLoss, type DaemonSessionLossCopy } from "../src/cli/daemon-stop-confirm.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const COPY: DaemonSessionLossCopy = {
	busyDetail: (count) => `busy:${count}`,
	unlistableDetail: "unlistable",
	question: "Continue?",
	nonTtyHint: "hint",
};

function session(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		isStreaming: false,
		isCompacting: false,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	} as unknown as SessionSummary;
}

function reachable(...activeSessions: SessionSummary[]): RunningDaemonProbe {
	return { reachable: true, activeSessions };
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

describe("confirmDaemonSessionLoss", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (ttyDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
		}
	});

	// Stopping the daemon while a session is working loses that work: the guard may only
	// proceed unattended when nothing is busy. Off a TTY every busy shape must abort.
	it.each([
		["the daemon is unreachable", { reachable: false }, false, true],
		["force is set", reachable(session({ isStreaming: true })), true, true],
		["no session is busy", reachable(session({}), session({})), false, true],
		["a streaming session is busy", reachable(session({ isSessionActive: true, isStreaming: true })), false, false],
		["a compacting session is busy", reachable(session({ isSessionActive: true, isCompacting: true })), false, false],
		["a bash run is in flight", reachable(session({ isSessionActive: true, isBashRunning: true })), false, false],
		[
			"a session has queued work",
			reachable(session({ isSessionActive: true, sessionActions: { queuedCount: 2, steering: [], followUps: [] } })),
			false,
			false,
		],
		["a session has running RLM children", reachable(session({ hasRunningRlmChildren: true })), false, false],
		[
			"only client-owned sessions are busy",
			{ reachable: true, activeSessions: [], busyClientOwnedSessionCount: 2 },
			false,
			false,
		],
		["sessions cannot be listed", { reachable: true }, false, false],
	])("proceeds only when safe: %s", async (_name, probe, force, expected) => {
		setTTY(false);

		expect(await confirmDaemonSessionLoss(probe as RunningDaemonProbe, { force, copy: COPY })).toBe(expected);
	});
});
