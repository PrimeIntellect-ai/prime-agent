import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIncidentLogLine } from "../src/cli/incident.js";
import { ENV_AGENT_DIR, getAgentLogPath } from "../src/config.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../src/modes/agents-view/agents-view-mode.js";
import {
	createIncidentNoticeState,
	deriveIncidentNotices,
	dismissIncidentNoticeState,
	formatIncidentNoticeTime,
	INCIDENT_NOTICE_TAIL_BYTES,
	INCIDENT_NOTICE_WINDOW_MS,
	isIncidentNoticeDismissed,
	refreshIncidentNoticeState,
	selectIncidentNotice,
} from "../src/modes/agents-view/incident-notices.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();
	return { ...actual, appendRotatingLog: vi.fn() };
});

vi.mock("../src/utils/tools-manager.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.js")>();
	// ensureTool would download fd into the redirected agent dir; tests never need it.
	return { ...actual, ensureTool: vi.fn(async () => undefined) };
});

const DAEMON_SOCKET = "/tmp/prime-agent-501/daemon.sock";

function logLine(fields: Record<string, unknown>): string {
	return JSON.stringify({ level: "warn", ...fields });
}

function tsAgo(base: number, ms: number): string {
	return new Date(base - ms).toISOString();
}

function supervisorStartLine(base: number, minutesAgoValue: number, generation = "e14de15c"): string {
	return logLine({
		ts: tsAgo(base, minutesAgoValue * 60_000),
		component: "coding-agent.daemon-supervisor",
		msg: `Prime Agent daemon supervisor ${generation} listening on ${DAEMON_SOCKET}`,
		socketPath: DAEMON_SOCKET,
		pid: 15026,
	});
}

function workerCrashLine(base: number, workerId: string, secondsAgoValue: number): string {
	return logLine({
		ts: tsAgo(base, secondsAgoValue * 1000),
		component: "coding-agent.daemon-supervisor",
		msg: `Session worker ${workerId} stderr: uncaught exception: Error: write EPIPE`,
	});
}

function commandTimeoutLine(base: number, minutesAgoValue: number): string {
	return logLine({
		ts: tsAgo(base, minutesAgoValue * 60_000),
		component: "coding-agent.daemon-supervisor",
		socketPath: DAEMON_SOCKET,
		msg: "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach\n    at Timeout._onTimeout (node:internal/timers:618:7)",
	});
}

function fixtureEntries(lines: readonly string[]) {
	return lines.map((line) => parseIncidentLogLine(line)).filter((entry) => entry !== undefined);
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

const cleanupDirs: string[] = [];
let previousAgentDir: string | undefined;

/** Fresh per-test agent dir so getAgentLogPath() points at a fixture log. */
function useTempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agents-view-incident-"));
	cleanupDirs.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
	mkdirSync(join(dir, "logs"), { recursive: true });
	return dir;
}

function writeAgentLog(lines: readonly string[]): void {
	writeFileSync(getAgentLogPath(), `${lines.join("\n")}\n`);
}

function appendAgentLog(lines: readonly string[]): void {
	appendFileSync(getAgentLogPath(), `${lines.join("\n")}\n`);
}

function newView(persistentState: AgentsViewPersistentState = { savedCatalogLoaded: true }): AgentsViewMode {
	return new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
}

/** The incident notice lines renderContent produces (startup notices stay unset). */
function renderedIncidentLines(view: AgentsViewMode): string[] {
	const lines = invoke("renderContent", view, 120, 40) as string[];
	return lines.map(stripAnsi).filter((line) => line.includes("prime-agent incident"));
}

beforeAll(() => {
	setKeybindings(new KeybindingsManager());
	previousAgentDir = process.env[ENV_AGENT_DIR];
});

afterAll(() => {
	if (previousAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = previousAgentDir;
	}
	for (const dir of cleanupDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("incident notice derivation", () => {
	it("derives a worker-crash notice with the local time of the crash", () => {
		const base = Date.now();
		const entries = fixtureEntries([workerCrashLine(base, "5b1d3aeb91ee", 600)]);
		const notices = deriveIncidentNotices(entries, Date.now());
		expect(notices).toHaveLength(1);
		const notice = notices[0]!;
		expect(notice.kind).toBe("worker-crash");
		expect(notice.severity).toBe("critical");
		expect(notice.key).toBe("worker-crash|worker 5b1d3aeb91ee");
		expect(notice.subject).toBe("worker 5b1d3aeb91ee");
		expect(notice.timeMs).toBe(entries[0]!.timeMs);
		expect(notice.text).toBe(
			`worker 5b1d3aeb91ee crashed at ${formatIncidentNoticeTime(entries[0]!.timeMs, Date.now())}`,
		);
	});

	it("uses subject 'worker' when the crashed worker id is unknown", () => {
		const base = Date.now();
		const entries = fixtureEntries([
			logLine({
				ts: tsAgo(base, 600_000),
				component: "coding-agent.daemon",
				msg: "uncaught exception: Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:159:15)",
			}),
		]);
		const notices = deriveIncidentNotices(entries, Date.now());
		expect(notices).toHaveLength(1);
		expect(notices[0]!.subject).toBe("worker");
		expect(notices[0]!.text).toContain("worker crashed at");
	});

	it("derives a command-timeout burst notice from the classifier anomaly", () => {
		const base = Date.now();
		const entries = fixtureEntries([commandTimeoutLine(base, 30), commandTimeoutLine(base, 29)]);
		const notices = deriveIncidentNotices(entries, Date.now());
		expect(notices).toHaveLength(1);
		const notice = notices[0]!;
		expect(notice.kind).toBe("timeout-burst");
		expect(notice.severity).toBe("error");
		expect(notice.subject).toBe(DAEMON_SOCKET);
		// The classifier anchors the anomaly at the burst's first timeout, but the
		// notice carries the latest one so dismissal advances with a growing burst.
		expect(notice.timeMs).toBe(entries[1]!.timeMs);
		expect(notice.text).toBe(`${DAEMON_SOCKET}: 2 command timeouts over 1m`);
	});

	it("advances the timeout-burst notice timeMs with the latest timeout", () => {
		const base = Date.now();
		const two = fixtureEntries([commandTimeoutLine(base, 30), commandTimeoutLine(base, 20)]);
		const burst = deriveIncidentNotices(two, base)[0]!;
		expect(burst.timeMs).toBe(two[1]!.timeMs);
		expect(burst.text).toBe(`${DAEMON_SOCKET}: 2 command timeouts over 10m`);

		// A later timeout extends the burst: the notice timeMs advances with it.
		const three = [...two, ...fixtureEntries([commandTimeoutLine(base, 5)])];
		const extended = deriveIncidentNotices(three, base)[0]!;
		expect(extended.timeMs).toBe(three[2]!.timeMs);
		expect(extended.text).toBe(`${DAEMON_SOCKET}: 3 command timeouts over 25m`);
	});

	it("derives an update-restart notice only for a repeated supervisor start", () => {
		const base = Date.now();
		const replaced = fixtureEntries([supervisorStartLine(base, 120), supervisorStartLine(base, 60)]);
		const restarts = deriveIncidentNotices(replaced, Date.now());
		expect(restarts).toHaveLength(1);
		const notice = restarts[0]!;
		expect(notice.kind).toBe("update-restart");
		expect(notice.severity).toBe("info");
		expect(notice.subject).toBe(DAEMON_SOCKET);
		expect(notice.timeMs).toBe(replaced[1]!.timeMs);
		expect(notice.text).toBe(
			`daemon restarted for update at ${formatIncidentNoticeTime(replaced[1]!.timeMs, Date.now())}`,
		);

		const firstEver = fixtureEntries([supervisorStartLine(base, 60)]);
		expect(deriveIncidentNotices(firstEver, Date.now())).toEqual([]);
	});

	it("does not count failed supervisor startups as restarts", () => {
		const base = Date.now();
		const failedStartLine = (minutesAgoValue: number) =>
			logLine({
				ts: tsAgo(base, minutesAgoValue * 60_000),
				component: "coding-agent.daemon-supervisor",
				socketPath: DAEMON_SOCKET,
				msg: "Daemon supervisor startup failed: lock file is already being held by another process",
			});
		// The failed spawn classifies as a warn-severity supervisor-start with
		// the same subject; only a successful start may count toward a restart,
		// or two failed spawns on one socket would read as an update restart.
		const failedThenStarted = fixtureEntries([failedStartLine(30), supervisorStartLine(base, 20)]);
		expect(deriveIncidentNotices(failedThenStarted, Date.now())).toEqual([]);

		const failedTwiceThenStarted = fixtureEntries([
			failedStartLine(30),
			failedStartLine(25),
			supervisorStartLine(base, 20),
		]);
		expect(deriveIncidentNotices(failedTwiceThenStarted, Date.now())).toEqual([]);

		// Two successful starts on the same socket still report the restart.
		const replaced = fixtureEntries([supervisorStartLine(base, 20), supervisorStartLine(base, 10)]);
		expect(deriveIncidentNotices(replaced, Date.now())).toHaveLength(1);
	});

	it("qualifies the time with the date when the incident is not from today", () => {
		const now = new Date(2026, 8, 15, 12, 0, 0).getTime();
		const crashEntries = (timeMs: number) =>
			fixtureEntries([
				logLine({
					ts: new Date(timeMs).toISOString(),
					component: "coding-agent.daemon-supervisor",
					msg: "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
				}),
			]);
		// Late yesterday, still inside the 24h window: the bare HH:MM would read
		// as today, so the local date qualifies it (tree-selector.ts style).
		const yesterdayEvening = new Date(2026, 8, 14, 23, 10, 0).getTime();
		const yesterday = deriveIncidentNotices(crashEntries(yesterdayEvening), now);
		expect(yesterday[0]!.text).toBe("worker 5b1d3aeb91ee crashed at 9/14 23:10");
		// From today: bare local HH:MM.
		const thisMorning = new Date(2026, 8, 15, 9, 5, 0).getTime();
		const today = deriveIncidentNotices(crashEntries(thisMorning), now);
		expect(today[0]!.text).toBe("worker 5b1d3aeb91ee crashed at 09:05");
	});

	it("ignores incidents outside the recent window", () => {
		const base = Date.now();
		const stale = fixtureEntries([
			logLine({
				ts: tsAgo(base, INCIDENT_NOTICE_WINDOW_MS + 60_000),
				component: "coding-agent.daemon-supervisor",
				msg: "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
			}),
		]);
		expect(deriveIncidentNotices(stale, Date.now())).toEqual([]);
	});

	it("collapses repeated identical crashes to a single notice line", () => {
		const base = Date.now();
		// The daemon logs the crash twice (worker log + stderr forward, deduped by
		// the classifier) and the same worker crashes again a minute later; the
		// header still shows one line, the most recent incident.
		const entries = fixtureEntries([
			workerCrashLine(base, "5b1d3aeb91ee", 120),
			workerCrashLine(base, "5b1d3aeb91ee", 60),
			workerCrashLine(base, "5b1d3aeb91ee", 60),
		]);
		const notices = deriveIncidentNotices(entries, Date.now());
		const selected = selectIncidentNotice(notices);
		expect(selected?.kind).toBe("worker-crash");
		expect(selected?.timeMs).toBe(entries[1]!.timeMs);
	});

	it("prefers the most severe incident and breaks ties by recency", () => {
		const base = Date.now();
		const entries = fixtureEntries([
			supervisorStartLine(base, 90),
			supervisorStartLine(base, 80),
			commandTimeoutLine(base, 20),
			workerCrashLine(base, "5b1d3aeb91ee", 30),
		]);
		const selected = selectIncidentNotice(deriveIncidentNotices(entries, Date.now()));
		expect(selected?.kind).toBe("worker-crash");
	});

	it("keeps a dismissal horizon per key: same or older incidents stay hidden, newer ones show", () => {
		const base = Date.now();
		const notices = deriveIncidentNotices(
			fixtureEntries([workerCrashLine(base, "5b1d3aeb91ee", 60), workerCrashLine(base, "aaaaaaaaaaaa", 30)]),
			Date.now(),
		);
		const state = createIncidentNoticeState();
		state.notice = notices[0];
		expect(dismissIncidentNoticeState(state)).toBe(true);
		expect(state.notice).toBeUndefined();
		const horizons = state.dismissedHorizons;
		const dismissed = notices[0]!;
		expect(isIncidentNoticeDismissed(dismissed, horizons)).toBe(true);
		const older = { ...dismissed, timeMs: dismissed.timeMs - 1000 };
		expect(isIncidentNoticeDismissed(older, horizons)).toBe(true);
		const newer = { ...dismissed, timeMs: dismissed.timeMs + 1000 };
		expect(isIncidentNoticeDismissed(newer, horizons)).toBe(false);
		// A different key is not covered by this dismissal.
		expect(isIncidentNoticeDismissed(notices[1]!, horizons)).toBe(false);
	});

	it("dismisses false without side effects when nothing is showing", () => {
		const state = createIncidentNoticeState();
		expect(dismissIncidentNoticeState(state)).toBe(false);
		expect(state.dismissedHorizons).toEqual({});
	});
});

describe("agents view incident notices", () => {
	it("renders the collapsed worker-crash notice from the log tail", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([supervisorStartLine(base, 600), workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(
				`worker 5b1d3aeb91ee crashed at ${formatIncidentNoticeTime(base - 120_000, Date.now())}`,
			);
			expect(lines[0]).toContain("prime-agent incident for the timeline");
			expect(lines[0].startsWith(" ⚠")).toBe(true);
		} finally {
			stopThemeWatcher();
		}
	});

	it("dismisses with Esc and never resurrects across re-render, re-entry, and polls", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const persistentState: AgentsViewPersistentState = { savedCatalogLoaded: true };
		const view = newView(persistentState);
		try {
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(1);

			view.handleInput("\x1b");
			expect(Reflect.get(view, "statusMessage")).toBe("Incident notice dismissed");
			expect(renderedIncidentLines(view)).toHaveLength(0);

			// Later polls re-read the same incident from the log; dismissal is sticky.
			invoke("refreshIncidentNotices", view);
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(0);

			// Re-entering the view reuses the persistent state: still dismissed.
			const reentered = newView(persistentState);
			try {
				expect(renderedIncidentLines(reentered)).toHaveLength(0);
			} finally {
				stopThemeWatcher();
			}

			// A NEWER incident on the same key shows a fresh notice again.
			appendAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 60)]);
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(1);
		} finally {
			stopThemeWatcher();
		}
	});

	it("does not dismiss while the search prompt has text", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const editor = Reflect.get(view, "editor") as { setText: (text: string) => void };
			editor.setText("still typing");
			view.handleInput("\x1b");
			expect(renderedIncidentLines(view)).toHaveLength(1);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps repeated identical crashes to exactly one notice line", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([
			workerCrashLine(base, "5b1d3aeb91ee", 120),
			workerCrashLine(base, "5b1d3aeb91ee", 60),
			workerCrashLine(base, "5b1d3aeb91ee", 60),
			workerCrashLine(base, "aaaaaaaaaaaa", 30),
		]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			// The three kept crash events (critical) collapse to the most recent.
			expect(lines[0]).toContain("worker aaaaaaaaaaaa crashed at");
		} finally {
			stopThemeWatcher();
		}
	});

	it("surfaces a command-timeout burst", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([commandTimeoutLine(base, 30), commandTimeoutLine(base, 29)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(`${DAEMON_SOCKET}: 2 command timeouts over`);
			expect(lines[0]).toContain("prime-agent incident for the timeline");
		} finally {
			stopThemeWatcher();
		}
	});

	it("re-shows a dismissed timeout-burst when a later timeout extends the burst", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([commandTimeoutLine(base, 30), commandTimeoutLine(base, 29)]);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		expect(state.notice?.kind).toBe("timeout-burst");
		// Dismissal records the notice's timeMs — the burst's latest timeout so
		// far — as the horizon for the key.
		expect(dismissIncidentNoticeState(state)).toBe(true);

		// A later timeout extends the burst past the horizon: the notice
		// reappears instead of staying hidden until the first timeout ages out.
		appendAgentLog([commandTimeoutLine(base, 5)]);
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		expect(state.notice?.kind).toBe("timeout-burst");
		expect(state.notice?.timeMs).toBe(base - 5 * 60_000);
	});

	it("surfaces an update restart only when the supervisor was replaced", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([supervisorStartLine(base, 120), supervisorStartLine(base, 60)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("daemon restarted for update at");
		} finally {
			stopThemeWatcher();
		}

		useTempAgentDir();
		writeAgentLog([supervisorStartLine(base, 60)]);
		const firstEver = newView();
		try {
			invoke("refreshIncidentNotices", firstEver);
			expect(renderedIncidentLines(firstEver)).toHaveLength(0);
		} finally {
			stopThemeWatcher();
		}
	});

	it("surfaces nothing and never throws when the log is missing", () => {
		useTempAgentDir();
		const view = newView();
		try {
			expect(() => invoke("refreshIncidentNotices", view)).not.toThrow();
			expect(renderedIncidentLines(view)).toHaveLength(0);
		} finally {
			stopThemeWatcher();
		}
	});

	it("holds back a partially-written final line until it completes", () => {
		useTempAgentDir();
		const base = Date.now();
		writeFileSync(getAgentLogPath(), workerCrashLine(base, "5b1d3aeb91ee", 120));
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(0);

			appendFileSync(getAgentLogPath(), "\n");
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(1);
		} finally {
			stopThemeWatcher();
		}
	});

	it("drops the torn leading line when the tail starts mid-file", () => {
		useTempAgentDir();
		const base = Date.now();
		// A log larger than one tail bound: the bounded tail necessarily starts
		// mid-line, and the torn leading fragment must not break the parse.
		const filler = logLine({
			ts: tsAgo(base, 3600_000),
			component: "coding-agent.daemon-supervisor",
			msg: `filler ${"x".repeat(200)}`,
		});
		const fillerCount = Math.ceil((INCIDENT_NOTICE_TAIL_BYTES + 4096) / (filler.length + 1));
		const lines = Array.from({ length: fillerCount }, () => filler);
		lines.push(workerCrashLine(base, "5b1d3aeb91ee", 60));
		writeAgentLog(lines);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const rendered = renderedIncidentLines(view);
			expect(rendered).toHaveLength(1);
			expect(rendered[0]).toContain("worker 5b1d3aeb91ee crashed at");
		} finally {
			stopThemeWatcher();
		}
	});

	it("follows a rotated log (new inode) to the newest incident", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)[0]).toContain("worker 5b1d3aeb91ee crashed at");

			// Rotation: a fresh file replaces agent.jsonl under a new inode.
			const rotatedPath = `${getAgentLogPath()}.new`;
			writeFileSync(rotatedPath, `${workerCrashLine(base, "aaaaaaaaaaaa", 60)}\n`);
			renameSync(rotatedPath, getAgentLogPath());
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("worker aaaaaaaaaaaa crashed at");
		} finally {
			stopThemeWatcher();
		}
	});

	it("reads only appended bytes on later polls and reports notice changes", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(true);
		expect(state.logOffset).toBeGreaterThan(0);
		const initialOffset = state.logOffset!;

		// A burst lands, but the crash (critical) still wins the single
		// collapsed line: the poll reports no change to re-render.
		appendAgentLog([commandTimeoutLine(base, 30), commandTimeoutLine(base, 29)]);
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.notice?.kind).toBe("worker-crash");

		// A newer crash replaces the collapsed line.
		appendAgentLog([workerCrashLine(base, "aaaaaaaaaaaa", 5)]);
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(true);
		expect(state.notice?.subject).toBe("worker aaaaaaaaaaaa");

		// A poll with nothing new reports no change and leaves the offset alone.
		const before = state.logOffset!;
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.logOffset).toBe(before);
		expect(initialOffset).toBeLessThan(before);
	});

	it("keeps the consumed offset across a transient read failure", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([supervisorStartLine(base, 30), workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(true);
		expect(state.notice?.kind).toBe("worker-crash");
		const entryCount = state.entries.length;
		const offset = state.logOffset;
		const fileId = state.logFileId;

		// The log briefly becomes unreadable. The failed poll must keep the
		// consumed offset: the next poll would otherwise re-tail and re-parse
		// the supervisor start into a phantom restart and double timeout counts.
		const backupPath = `${logPath}.backup`;
		renameSync(logPath, backupPath);
		mkdirSync(logPath);
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.logOffset).toBe(offset);
		expect(state.logFileId).toBe(fileId);

		// The log returns (rename keeps the inode): nothing re-parses and no
		// phantom update-restart appears.
		rmSync(logPath, { recursive: true, force: true });
		renameSync(backupPath, logPath);
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.entries).toHaveLength(entryCount);
		expect(state.notice?.kind).toBe("worker-crash");
		const notices = deriveIncidentNotices(state.entries, Date.now());
		expect(notices.some((notice) => notice.kind === "update-restart")).toBe(false);
	});
});
