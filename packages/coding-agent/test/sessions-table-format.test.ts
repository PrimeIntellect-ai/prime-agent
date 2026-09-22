import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionsTable } from "../src/cli/sessions-table-format.js";
import { getSessionStatusLabel } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const NOW_MS = Date.parse("2026-05-29T12:00:00.000Z");
const HEADER = ["name", "status", "activity", "last heard", "error", "usage"];
const STALE_AT = "2026-05-29T11:50:00.000Z";
const LONG_ID = "019e71ec-e08a-75a9-b573-fc10e9f8380f";
const SPEND: SessionSummary["usage"] = { inputTokens: 1234, outputTokens: 567, cost: 0.4234 };
const FLEET_SPEND: SessionSummary["usage"] = { inputTokens: 1_626_400_000, outputTokens: 2_100_000, cost: 382.85 };

// Base summary: a resident idle session last modified two hours before NOW_MS.
const BASE: SessionSummary = {
	id: "s",
	lifecycle: "live",
	activity: "idle",
	isSessionActive: false,
	activeSessionId: "a1",
	sessionId: "session-s",
	cwd: "/tmp/project",
	isStreaming: false,
	isCompacting: false,
	attachedClients: 0,
	messageCount: 2,
	sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	modified: "2026-05-29T10:00:00.000Z",
};

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return { ...BASE, ...overrides, isSessionActive: (overrides.activity ?? BASE.activity) === "working" };
}

function row(name: string, status: string, activity: string, lastHeard = "", error = "", usage = ""): string[] {
	return [name, status, activity, lastHeard, error, usage];
}

function expectTable(sessions: SessionSummary[], expectedRows: string[][]): void {
	const widths = HEADER.map((header, index) => Math.max(header.length, ...expectedRows.map((r) => r[index]!.length)));
	const pad = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
	const lines = [pad(HEADER), ...expectedRows.map(pad)];
	expect(stripAnsi(formatSessionsTable(sessions, NOW_MS)).split("\n")).toEqual(lines);
}

const UNSORTED = [
	makeSummary({ sessionName: "plain-saved", activeSessionId: undefined, rosterStatus: "inactive" }),
	makeSummary({ sessionName: "worker", activity: "working", isStreaming: true }),
	// The diagnostics entry is never served by the supervisor list RPC; the row must keep showing the worker mark.
	makeSummary({ sessionName: "crashed", workerState: "failed", diagnostics: [{ type: "error", message: "x" }] }),
	makeSummary({ sessionName: "sleeper", taskState: "completed" }),
	makeSummary({ sessionName: "restarting", workerState: "recovering" }),
];
const EXPECTED_SORT = [
	row("crashed", "idle", "failed", "", "worker failed"),
	row("restarting", "idle", "recovering"),
	row("worker", "running", "thinking"),
	row("sleeper", "idle", "completed"),
	row("plain-saved", "inactive", ""),
];

describe("formatSessionsTable", () => {
	it.each<[string, Partial<SessionSummary> | null, string[]]>([
		["empty roster renders the header only", null, []],
		["thinking detail", { activity: "working", isStreaming: true }, row("s", "running", "thinking")],
		["running bash", { activity: "working", isBashRunning: true }, row("s", "running", "running bash")],
		["compacting", { activity: "working", isCompacting: true }, row("s", "running", "compacting")],
		["completed verdict", { taskState: "completed" }, row("s", "idle", "completed")],
		["saved status", { activeSessionId: undefined, rosterStatus: "inactive" }, row("s", "inactive", "")],
		["queued label", { activity: "working", statusLabel: "queued" }, row("s", "queued", "classifying")],
		["recovering label", { statusLabel: "recovering" }, row("s", "recovering", "")],
		["failed label", { statusLabel: "failed" }, row("s", "failed", "", "", "worker failed")],
		[
			"sanitized model notice",
			{ modelFallbackMessage: "boom\u0007\u001B[31m!\u001B[39m" },
			row("s", "idle", "", "", "boom!"),
		],
		["staleness", { activity: "working", lastHeardFromAt: STALE_AT }, row("s", "running", "classifying", "10m")],
		["usage compact", { usage: SPEND }, row("s", "idle", "", "", "", "1.2k/567 $0.42")],
		[
			"sanitizes and truncates the recap appended to the activity detail",
			{ activity: "working", isStreaming: true, isRunningTools: true, summary: `\u0007${"a".repeat(100)}` },
			["s", "running", `running tools · ${"a".repeat(43)}…`, "", "", ""],
		],
		["usage fleet scale", { usage: FLEET_SPEND }, row("s", "idle", "", "", "", "1.6b/2.1m $382.85")],
		["archived rows", { lifecycle: "archived", rosterStatus: "inactive" }, row("s", "inactive", "archived")],
		["display id fallback", { id: LONG_ID, sessionName: undefined }, row("fc10e9f8380f", "idle", "")],
		["newline in name", { sessionName: "sneaky\nagent" }, row("sneaky agent", "idle", "")],
		["ansi in name", { sessionName: "\u001B[31mansi\u001B[39m agent" }, row("ansi agent", "idle", "")],
		["control chars in name", { sessionName: "beep\u0007 agent" }, row("beep agent", "idle", "")],
		["blank name", { sessionName: "\u0007", id: LONG_ID }, row("fc10e9f8380f", "idle", "")],
		["long name cap", { sessionName: "n".repeat(200) }, row(`${"n".repeat(59)}…`, "idle", "")],
		["heartbeat", { hasActiveHeartbeat: true }, row("s", "idle", "heartbeat")],
		["ignores queued actions", { sessionActions: { ...BASE.sessionActions, queuedCount: 2 } }, row("s", "idle", "")],
		["starting worker", { activity: "working", workerState: "starting" }, row("s", "running", "starting")],
		["stopping worker", { workerState: "stopping" }, row("s", "idle", "stopping")],
		["replied subagent", { runtimeKind: "subagent", repliedSinceTask: true }, row("s", "idle", "replied")],
	])("%s", (_name, overrides, expected) => {
		expectTable(overrides ? [makeSummary(overrides)] : [], overrides ? [expected] : []);
	});

	it("sorts failures first, then recovering workers, then running, then idle, then the rest", () => {
		expectTable(UNSORTED, EXPECTED_SORT);
	});

	// One branch table (agent-roster.ts sessionActivityDetail) serves both surfaces; a re-added local branch splits the wording and fails here.
	it.each<[string, Partial<SessionSummary>]>([
		["thinking", { activity: "working", isStreaming: true }],
		["running tools", { activity: "working", isStreaming: true, isRunningTools: true }],
		["running bash", { activity: "working", isBashRunning: true }],
		["compacting", { activity: "working", isCompacting: true }],
		["starting", { activity: "working", workerState: "starting" }],
		["archived", { lifecycle: "archived", rosterStatus: "inactive" }],
		["replied", { runtimeKind: "subagent", repliedSinceTask: true }],
		["classifying", { activity: "working" }],
		["error", { taskState: "error" }],
		["completed", { taskState: "completed" }],
	])("%s agrees with the table's activity wording", (expected, overrides) => {
		expect(getSessionStatusLabel(makeSummary(overrides))).toBe(expected);
	});

	it("measures wide-glyph cells by display width", () => {
		const sessions = [
			makeSummary({ sessionName: "中文" }),
			makeSummary({ sessionName: "hello", summary: "🚀".repeat(40) }),
		];
		const lines = stripAnsi(formatSessionsTable(sessions)).split("\n");
		// UTF-16 padding would misalign the CJK name; the recap cap counts display columns, pair-safe.
		expect(lines[1]!.startsWith("中文   idle")).toBe(true);
		expect(lines[2]!.includes(`${"🚀".repeat(29)}…`)).toBe(true);
	});
});
