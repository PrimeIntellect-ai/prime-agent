import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningDaemonProbe } from "../src/cli/daemon-launch.js";
import {
	confirmDaemonSessionLoss,
	type DaemonSessionLossCopy,
	pluralizeSessions,
} from "../src/cli/daemon-stop-confirm.js";
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

	it("proceeds without prompting when the daemon is unreachable", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = { reachable: false };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(true);
	});

	it("proceeds without prompting when force is set", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = { reachable: true, activeSessions: [session({ isStreaming: true })] };
		expect(await confirmDaemonSessionLoss(probe, { force: true, copy: COPY })).toBe(true);
	});

	it("proceeds without prompting when no session is busy", async () => {
		setTTY(true);
		const probe: RunningDaemonProbe = {
			reachable: true,
			activeSessions: [
				session({ isStreaming: false }),
				session({ sessionActions: { queuedCount: 0, steering: [], followUps: [] } }),
			],
		};
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(true);
	});

	it("aborts without prompting when not at a TTY and a session is busy", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = {
			reachable: true,
			activeSessions: [
				session({
					isSessionActive: true,
					sessionActions: { queuedCount: 2, steering: [], followUps: [] },
				}),
			],
		};
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hint"));
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("busy:1"));
	});

	it("counts busy client-owned sessions without exposing their identities", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = {
			reachable: true,
			activeSessions: [],
			busyClientOwnedSessionCount: 2,
		};
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("busy:2"));
	});

	it("aborts without prompting when not at a TTY and sessions cannot be listed", async () => {
		setTTY(false);
		const probe: RunningDaemonProbe = { reachable: true };
		expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unlistable"));
	});

	it("treats compacting and pending-message sessions as busy", async () => {
		setTTY(false);
		for (const overrides of [
			{ isSessionActive: true, isCompacting: true },
			{ isSessionActive: true, sessionActions: { queuedCount: 1, steering: [], followUps: [] } },
			{ isSessionActive: true, isStreaming: true },
			{ isSessionActive: true, isBashRunning: true },
			{ hasRunningRlmChildren: true },
		]) {
			vi.mocked(console.error).mockClear();
			const probe: RunningDaemonProbe = { reachable: true, activeSessions: [session(overrides)] };
			expect(await confirmDaemonSessionLoss(probe, { force: false, copy: COPY })).toBe(false);
		}
	});
});

describe("pluralizeSessions", () => {
	it("uses singular for one and plural otherwise", () => {
		expect(pluralizeSessions(1)).toEqual({ noun: "session", pronoun: "it" });
		expect(pluralizeSessions(2)).toEqual({ noun: "sessions", pronoun: "them" });
	});
});
