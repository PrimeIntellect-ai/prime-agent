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
	INCIDENT_NOTICE_MAX_WINDOW_ENTRIES,
	INCIDENT_NOTICE_TAIL_BYTES,
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

function commandTimeoutLine(base: number, minutesAgoValue: number, socketPath: string = DAEMON_SOCKET): string {
	return logLine({
		ts: tsAgo(base, minutesAgoValue * 60_000),
		component: "coding-agent.daemon-supervisor",
		socketPath,
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
	// The classifier pins the crash shapes and the unknown-worker subject on the
	// stack base (incident.test.ts); this pins the notice built from the event.
	it("derives a worker-crash notice with the local time of the crash", () => {
		const base = Date.now();
		const entries = fixtureEntries([workerCrashLine(base, "5b1d3aeb91ee", 600)]);
		const notices = deriveIncidentNotices(entries, Date.now());
		expect(notices).toHaveLength(1);
		const notice = notices[0]!;
		expect(notice).toMatchObject({
			kind: "worker-crash",
			severity: "critical",
			key: "worker-crash|worker 5b1d3aeb91ee",
			subject: "worker 5b1d3aeb91ee",
			timeMs: entries[0]!.timeMs,
		});
		expect(notice.text).toBe(
			`worker 5b1d3aeb91ee crashed at ${formatIncidentNoticeTime(entries[0]!.timeMs, Date.now())}`,
		);
	});

	it("anchors each subject's timeout burst at its own latest timeout and advances with later ones", () => {
		const base = Date.now();
		// The classifier anchors the anomaly at the burst's first timeout, but the
		// notice carries the latest one so dismissal advances with a growing burst.
		const two = fixtureEntries([commandTimeoutLine(base, 30), commandTimeoutLine(base, 20)]);
		const burst = deriveIncidentNotices(two, base)[0]!;
		expect(burst).toMatchObject({
			kind: "timeout-burst",
			severity: "error",
			subject: DAEMON_SOCKET,
			timeMs: two[1]!.timeMs,
			text: `${DAEMON_SOCKET}: 2 command timeouts over 10m`,
		});

		// A later timeout extends the burst: the notice timeMs advances with it.
		const three = [...two, ...fixtureEntries([commandTimeoutLine(base, 5)])];
		const extended = deriveIncidentNotices(three, base)[0]!;
		expect(extended.timeMs).toBe(three[2]!.timeMs);
		expect(extended.text).toBe(`${DAEMON_SOCKET}: 3 command timeouts over 25m`);

		// Two daemon sockets: the per-subject latest-timeout lookup must never
		// leak one subject's timeout into the other subject's notice.
		const otherSocket = "/tmp/prime-agent-501/daemon-other.sock";
		const mixed = fixtureEntries([
			commandTimeoutLine(base, 30, DAEMON_SOCKET),
			commandTimeoutLine(base, 25, otherSocket),
			commandTimeoutLine(base, 20, DAEMON_SOCKET),
			commandTimeoutLine(base, 5, otherSocket),
		]);
		const bySubject = new Map(
			deriveIncidentNotices(mixed, base)
				.filter((notice) => notice.kind === "timeout-burst")
				.map((notice) => [notice.subject, notice]),
		);
		expect(bySubject.get(DAEMON_SOCKET)?.timeMs).toBe(base - 20 * 60_000);
		expect(bySubject.get(otherSocket)?.timeMs).toBe(base - 5 * 60_000);
	});

	it("derives an update-restart only from repeated successful supervisor starts", () => {
		const base = Date.now();
		const replaced = fixtureEntries([supervisorStartLine(base, 120), supervisorStartLine(base, 60)]);
		const restarts = deriveIncidentNotices(replaced, Date.now());
		expect(restarts).toHaveLength(1);
		expect(restarts[0]).toMatchObject({
			kind: "update-restart",
			severity: "info",
			subject: DAEMON_SOCKET,
			timeMs: replaced[1]!.timeMs,
		});
		expect(restarts[0]!.text).toBe(
			`daemon restarted for update at ${formatIncidentNoticeTime(replaced[1]!.timeMs, Date.now())}`,
		);

		// A first-ever start is routine; a failed startup (lock held) never
		// counts toward a replacement, or two failed spawns on one socket
		// would read as an update restart.
		const failedStartLine = (minutesAgoValue: number) =>
			logLine({
				ts: tsAgo(base, minutesAgoValue * 60_000),
				component: "coding-agent.daemon-supervisor",
				socketPath: DAEMON_SOCKET,
				msg: "Daemon supervisor startup failed: lock file is already being held by another process",
			});
		expect(deriveIncidentNotices(fixtureEntries([supervisorStartLine(base, 60)]), Date.now())).toEqual([]);
		expect(
			deriveIncidentNotices(fixtureEntries([failedStartLine(30), supervisorStartLine(base, 20)]), Date.now()),
		).toEqual([]);
	});

	it("qualifies the notice time with the date when the incident is not from today", () => {
		const now = new Date(2026, 8, 15, 12, 0, 0).getTime();
		const crashTextAt = (timeMs: number) =>
			deriveIncidentNotices(
				fixtureEntries([
					logLine({
						ts: new Date(timeMs).toISOString(),
						component: "coding-agent.daemon",
						msg: "uncaught exception: Error: write EPIPE",
					}),
				]),
				now,
			)[0]!.text;
		// Late yesterday, still inside the 24h window: the bare HH:MM would read
		// as today, so the local date qualifies it; today stays bare.
		expect(crashTextAt(new Date(2026, 8, 14, 23, 10, 0).getTime())).toBe("worker crashed at 9/14 23:10");
		expect(crashTextAt(new Date(2026, 8, 15, 9, 5, 0).getTime())).toBe("worker crashed at 09:05");
	});

	it("prefers the most severe incident and breaks ties by recency", () => {
		const base = Date.now();
		const entries = fixtureEntries([
			supervisorStartLine(base, 90),
			supervisorStartLine(base, 80),
			commandTimeoutLine(base, 20),
			workerCrashLine(base, "5b1d3aeb91ee", 30),
		]);
		expect(selectIncidentNotice(deriveIncidentNotices(entries, Date.now()))?.kind).toBe("worker-crash");
	});

	it("keeps a dismissal horizon per key and dismisses nothing when nothing shows", () => {
		const base = Date.now();
		const notices = deriveIncidentNotices(
			fixtureEntries([workerCrashLine(base, "5b1d3aeb91ee", 60), workerCrashLine(base, "aaaaaaaaaaaa", 30)]),
			Date.now(),
		);
		const state = createIncidentNoticeState();
		expect(dismissIncidentNoticeState(state)).toBe(false);
		expect(state.dismissedHorizons).toEqual({});
		state.notice = notices[0];
		expect(dismissIncidentNoticeState(state)).toBe(true);
		const horizons = state.dismissedHorizons;
		const dismissed = notices[0]!;
		// Same or older incidents on the key stay hidden; a different key is not
		// covered by this dismissal (newer-on-key re-shows are pinned at the view).
		expect(isIncidentNoticeDismissed(dismissed, horizons)).toBe(true);
		expect(isIncidentNoticeDismissed({ ...dismissed, timeMs: dismissed.timeMs - 1000 }, horizons)).toBe(true);
		expect(isIncidentNoticeDismissed(notices[1]!, horizons)).toBe(false);
	});
});

describe("agents view incident notices", () => {
	// [log fixture, expected rendered substring]
	it.each([
		[
			"worker-crash",
			(base: number) => [workerCrashLine(base, "5b1d3aeb91ee", 120)],
			"worker 5b1d3aeb91ee crashed at",
		],
		[
			"timeout-burst",
			(base: number) => [commandTimeoutLine(base, 30), commandTimeoutLine(base, 29)],
			`${DAEMON_SOCKET}: 2 command timeouts over`,
		],
		[
			"update-restart",
			(base: number) => [supervisorStartLine(base, 120), supervisorStartLine(base, 60)],
			"daemon restarted for update at",
		],
	] as const)("renders the %s notice line from the log tail", (_kind, makeLines, expected) => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog(makeLines(base));
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			const lines = renderedIncidentLines(view);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(expected);
			expect(lines[0]).toContain("prime-agent incident for the timeline");
			expect(lines[0].startsWith(" \u26a0")).toBe(true);
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
			// Later polls re-read the same incident from the log; dismissal is
			// sticky, and re-entering the view reuses the persistent state.
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(0);
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

	it.each([
		[
			"cancels an armed delete confirmation instead",
			(view: AgentsViewMode) => invoke("showDeleteConfirmation", view),
		],
		[
			"does nothing while the search prompt has text",
			(view: AgentsViewMode) => {
				(Reflect.get(view, "editor") as { setText: (text: string) => void }).setText("still typing");
			},
		],
	])("Esc %s of dismissing the notice", (_name, arm) => {
		useTempAgentDir();
		writeAgentLog([workerCrashLine(Date.now(), "5b1d3aeb91ee", 120)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(1);
			arm(view);
			view.handleInput("\x1b");
			// The armed state was cancelled (or never engaged) and the notice stays.
			expect(Reflect.get(view, "deleteConfirmExpiresAt")).toBe(0);
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
			// The repeated events collapse to the most recent incident.
			expect(lines[0]).toContain("worker aaaaaaaaaaaa crashed at");
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
		expect(dismissIncidentNoticeState(state)).toBe(true);
		// A later timeout extends the burst past the dismissed horizon: the
		// notice reappears instead of staying hidden until the first timeout
		// ages out.
		appendAgentLog([commandTimeoutLine(base, 5)]);
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		expect(state.notice).toMatchObject({ kind: "timeout-burst", timeMs: base - 5 * 60_000 });
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

	it("drops future-dated log lines instead of surfacing them", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([
			logLine({
				ts: new Date(base + 60 * 60_000).toISOString(),
				component: "coding-agent.daemon-supervisor",
				msg: "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
			}),
		]);
		const state = createIncidentNoticeState();
		// CLI window parity: entries are bounded by >= since && <= until, so a
		// future-dated crash never enters the window nor pins a notice.
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(false);
		expect(state.entries).toHaveLength(0);
		expect(state.notice).toBeUndefined();
	});

	it("holds back partial lines, drops torn fragments, and keeps boundary-aligned tail records", () => {
		const base = Date.now();
		// A partially-written final line stays held back until it completes.
		useTempAgentDir();
		writeFileSync(getAgentLogPath(), workerCrashLine(base, "5b1d3aeb91ee", 120));
		let state = createIncidentNoticeState();
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(false);
		appendFileSync(getAgentLogPath(), "\n");
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(true);
		expect(state.notice?.subject).toBe("worker 5b1d3aeb91ee");

		// A log larger than one tail bound: the bounded tail necessarily starts
		// mid-line, and the torn leading fragment must not break the parse.
		useTempAgentDir();
		const filler = logLine({
			ts: tsAgo(base, 3600_000),
			component: "coding-agent.daemon-supervisor",
			msg: `filler ${"x".repeat(200)}`,
		});
		writeAgentLog([
			...Array.from({ length: Math.ceil((INCIDENT_NOTICE_TAIL_BYTES + 4096) / (filler.length + 1)) }, () => filler),
			workerCrashLine(base, "5b1d3aeb91ee", 60),
		]);
		state = createIncidentNoticeState();
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(true);
		expect(state.notice?.subject).toBe("worker 5b1d3aeb91ee");

		// Records sized so the tail cut lands exactly on a record boundary: the
		// first record in the tail is a complete crash record, not a torn
		// fragment (regression: dropping it would lose a qualifying incident
		// for the lifetime of the state).
		useTempAgentDir();
		const fixedLengthLine = (fields: Record<string, unknown>): string => {
			const unpadded = logLine(fields);
			const padded = `${unpadded.slice(0, -1)},"pad":"${"x".repeat(502 - unpadded.length)}"}`;
			expect(`${padded}\n`).toHaveLength(512);
			return `${padded}\n`;
		};
		const filler512 = () =>
			fixedLengthLine({
				ts: tsAgo(base, 3600_000),
				component: "coding-agent.daemon-supervisor",
				msg: "filler",
			});
		const records = [
			filler512(),
			filler512(),
			fixedLengthLine({
				ts: tsAgo(base, 60_000),
				component: "coding-agent.daemon-supervisor",
				msg: "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
			}),
		];
		while (records.length < 1026) {
			records.push(filler512());
		}
		writeFileSync(getAgentLogPath(), records.join(""));
		state = createIncidentNoticeState();
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(true);
		expect(state.notice?.subject).toBe("worker 5b1d3aeb91ee");
	});

	it("bridges the rotated .old generation only on the first successful main-log read and follows later rotations", () => {
		const base = Date.now();
		// A rotation moved the earlier supervisor start into agent.jsonl.old while
		// agent.jsonl has not been recreated yet: the missing-log poll must not
		// read .old early nor poison the fresh state.
		useTempAgentDir();
		writeFileSync(`${getAgentLogPath()}.old`, `${supervisorStartLine(base, 120)}\n`);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(false);
		expect(state.logOffset).toBeUndefined();
		expect(state.entries).toHaveLength(0);

		// The main log appears: the bridge happens exactly on this first
		// successful read, pairing the .old start with the newer one.
		writeAgentLog([supervisorStartLine(base, 30)]);
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		expect(state.notice?.kind).toBe("update-restart");
		expect(state.entries).toHaveLength(2);

		// Later polls never re-read .old: duplicate supervisor starts would pair
		// with the current file into a phantom restart.
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(false);
		expect(state.entries).toHaveLength(2);
		expect(
			deriveIncidentNotices(state.entries, base).filter((notice) => notice.kind === "update-restart"),
		).toHaveLength(1);

		// Rotation: a fresh file replaces agent.jsonl under a new inode. The new
		// file is LARGER than the consumed offset (no shrink re-tail) and within
		// one tail bound of it, so only the file-id change forces the re-tail
		// that follows the rotation to the newest incident.
		const rotatedFiller = logLine({
			ts: tsAgo(base, 3600_000),
			component: "coding-agent.daemon-supervisor",
			msg: "filler padding after the rotated log",
		});
		const rotatedPath = `${getAgentLogPath()}.new`;
		writeFileSync(
			rotatedPath,
			`${[workerCrashLine(base, "aaaaaaaaaaaa", 60), rotatedFiller, rotatedFiller, rotatedFiller].join("\n")}\n`,
		);
		renameSync(rotatedPath, getAgentLogPath());
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		expect(state.notice?.subject).toBe("worker aaaaaaaaaaaa");
	});

	it("reads appended bytes only, reports notice changes, and keeps the consumed offset through a transient read failure", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([supervisorStartLine(base, 30), workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(true);
		expect(state.notice?.kind).toBe("worker-crash");
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

		// The log briefly becomes unreadable. The failed poll keeps the consumed
		// offset: the next poll would otherwise re-tail and re-parse the
		// supervisor start into a phantom restart and double timeout counts.
		const backupPath = `${logPath}.backup`;
		renameSync(logPath, backupPath);
		mkdirSync(logPath);
		const offset = state.logOffset;
		const fileId = state.logFileId;
		const entryCount = state.entries.length;
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.logOffset).toBe(offset);
		expect(state.logFileId).toBe(fileId);

		// The log returns (rename keeps the inode): nothing re-parses, no
		// phantom update-restart appears, and the offset only ever grew.
		rmSync(logPath, { recursive: true, force: true });
		renameSync(backupPath, logPath);
		expect(refreshIncidentNoticeState(state, logPath, Date.now())).toBe(false);
		expect(state.entries).toHaveLength(entryCount);
		expect(state.notice?.kind).toBe("worker-crash");
		expect(state.logOffset).toBeGreaterThan(initialOffset);
		expect(deriveIncidentNotices(state.entries, Date.now()).some((notice) => notice.kind === "update-restart")).toBe(
			false,
		);
	});

	it("expires the notice while the log stays unreadable", () => {
		useTempAgentDir();
		const base = Date.now();
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 120)]);
		const state = createIncidentNoticeState();
		const logPath = getAgentLogPath();
		expect(refreshIncidentNoticeState(state, logPath, base)).toBe(true);
		// The log disappears for good: the consumed offset stays (a re-tail
		// would fabricate restarts), but the poll still re-derives, so the crash
		// ages out of the window and the notice expires instead of surviving
		// forever.
		rmSync(logPath);
		expect(refreshIncidentNoticeState(state, logPath, base + 25 * 60 * 60_000)).toBe(true);
		expect(state.notice).toBeUndefined();
		expect(state.entries).toHaveLength(0);
		expect(state.logOffset).toBeGreaterThan(0);
	});

	it("caps retained windowed entries at the newest bounded set", () => {
		useTempAgentDir();
		const base = Date.now();
		const oldestTimeMs = base - 3 * 60 * 60_000;
		const stepMs = Math.ceil((60 * 60_000) / INCIDENT_NOTICE_MAX_WINDOW_ENTRIES);
		const state = createIncidentNoticeState();
		state.entries = Array.from({ length: INCIDENT_NOTICE_MAX_WINDOW_ENTRIES }, (_, index) => ({
			timeMs: oldestTimeMs + index * stepMs,
			level: "warn",
			component: "coding-agent.daemon-supervisor",
			msg: `filler entry ${index}`,
			fields: { ts: new Date(oldestTimeMs + index * stepMs).toISOString(), msg: `filler entry ${index}` },
		}));
		writeAgentLog([workerCrashLine(base, "5b1d3aeb91ee", 60)]);
		// The crash is the newest entry of all: the cap keeps it and drops the
		// oldest fixture instead of growing past the bound, so memory and
		// per-poll sort/classify work stay bounded on a busy log day.
		expect(refreshIncidentNoticeState(state, getAgentLogPath(), base)).toBe(true);
		expect(state.entries).toHaveLength(INCIDENT_NOTICE_MAX_WINDOW_ENTRIES);
		expect(state.entries[0]!.timeMs).toBe(oldestTimeMs + stepMs);
		expect(state.entries.some((entry) => entry.msg.includes("5b1d3aeb91ee"))).toBe(true);
		expect(state.notice?.kind).toBe("worker-crash");
	});
});
