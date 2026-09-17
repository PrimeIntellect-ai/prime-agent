import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	refreshIncidentNoticeState,
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
	it("anchors each subject's timeout burst at that subject's own latest timeout", () => {
		const base = Date.now();
		// Two daemon sockets, each with its own timeout burst: the per-subject
		// latest-timeout lookup must never leak one subject's timeout into the
		// other subject's notice.
		const otherSocket = "/tmp/prime-agent-501/daemon-other.sock";
		const entries = fixtureEntries([
			commandTimeoutLine(base, 30, DAEMON_SOCKET),
			commandTimeoutLine(base, 25, otherSocket),
			commandTimeoutLine(base, 20, DAEMON_SOCKET),
			commandTimeoutLine(base, 5, otherSocket),
		]);
		const bursts = deriveIncidentNotices(entries, base).filter((notice) => notice.kind === "timeout-burst");
		expect(bursts).toHaveLength(2);
		const bySubject = new Map(bursts.map((notice) => [notice.subject, notice]));
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
});

describe("agents view incident notices", () => {
	it("renders the collapsed worker-crash notice line from the log tail", () => {
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
			expect(lines[0].startsWith(" \u26a0")).toBe(true);
		} finally {
			stopThemeWatcher();
		}
	});

	it("cancels an armed delete confirmation with Esc instead of dismissing the notice", () => {
		useTempAgentDir();
		writeAgentLog([workerCrashLine(Date.now(), "5b1d3aeb91ee", 120)]);
		const view = newView();
		try {
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(1);
			// A delete confirmation is armed: Esc must cancel it and keep the
			// notice, or the next delete press would fire without a fresh
			// confirmation.
			invoke("showDeleteConfirmation", view);
			view.handleInput("\x1b");
			expect(Reflect.get(view, "deleteConfirmExpiresAt")).toBe(0);
			expect(renderedIncidentLines(view)).toHaveLength(1);
		} finally {
			stopThemeWatcher();
		}
	});

	it("dismisses with Esc and never resurrects across later polls", () => {
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
			// Later polls re-read the same incident from the log; dismissal is sticky.
			invoke("refreshIncidentNotices", view);
			expect(renderedIncidentLines(view)).toHaveLength(0);
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
});
