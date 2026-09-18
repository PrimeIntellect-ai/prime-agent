import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionsTable } from "../src/cli/sessions-table-format.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const NOW_MS = Date.parse("2026-05-29T12:00:00.000Z");
const HEADER = ["name", "status", "activity", "last heard", "error", "usage"];
const STALE_AT = "2026-05-29T11:50:00.000Z";
const LONG_ID = "019e71ec-e08a-75a9-b573-fc10e9f8380f";
const SPEND: SessionSummary["usage"] = { inputTokens: 1234, outputTokens: 567, cost: 0.4234 };
const FLEET_SPEND: SessionSummary["usage"] = { inputTokens: 1_626_400_000, outputTokens: 2_100_000, cost: 382.85 };
const DIAGNOSTICS: SessionSummary["diagnostics"] = [
	{ type: "warning", message: "skill path missing" },
	{ type: "error", message: "older extension error" },
	{ type: "error", message: "bad extension config" },
];

function withActiveAction(active: SessionSummary["sessionActions"]["active"]): SessionSummary["sessionActions"] {
	return { queuedCount: 0, steering: [], followUps: [], active };
}
const RUN_ACTIONS = withActiveAction({ kind: "session_command", phase: "running", label: "send to worker" });
const PREP_ACTIONS = withActiveAction({ kind: "session_command", phase: "preparing" });

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

function row(name: string, status: string, activity: string, lastHeard = "2h", error = "", usage = ""): string[] {
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
	makeSummary({ sessionName: "crashed", workerState: "failed" }),
	makeSummary({ sessionName: "sleeper", taskState: "completed" }),
	makeSummary({ sessionName: "restarting", workerState: "recovering" }),
];
const EXPECTED_SORT = [
	row("crashed", "idle", "failed", "2h", "worker failed"),
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
		["failed label", { statusLabel: "failed" }, row("s", "failed", "", "2h", "worker failed")],
		[
			"prefers the latest error diagnostic over the worker mark and the model notice",
			{ workerState: "failed", modelFallbackMessage: "none", diagnostics: DIAGNOSTICS },
			row("s", "idle", "failed", "2h", "bad extension config"),
		],
		["model notice", { modelFallbackMessage: "no model" }, row("s", "idle", "", "2h", "no model")],
		["staleness", { activity: "working", lastHeardFromAt: STALE_AT }, row("s", "running", "classifying", "10m")],
		["usage compact", { usage: SPEND }, row("s", "idle", "", "2h", "", "1.2k/567 $0.42")],
		[
			"appends the recap to the activity detail and truncates long cells",
			{ activity: "working", isStreaming: true, isRunningTools: true, summary: "a".repeat(100) },
			["s", "running", `running tools · ${"a".repeat(43)}…`, "2h", "", ""],
		],
		["usage fleet scale", { usage: FLEET_SPEND }, row("s", "idle", "", "2h", "", "1.6b/2.1m $382.85")],
		["archived rows", { lifecycle: "archived", rosterStatus: "inactive" }, row("s", "inactive", "archived")],
		["display id fallback", { id: LONG_ID, sessionName: undefined }, row("fc10e9f8380f", "idle", "")],
		["newline in name", { sessionName: "sneaky\nagent" }, row("sneaky agent", "idle", "")],
		["ansi in name", { sessionName: "\u001B[31mansi\u001B[39m agent" }, row("ansi agent", "idle", "")],
		["control chars in name", { sessionName: "beep\u0007 agent" }, row("beep agent", "idle", "")],
		["heartbeat", { hasActiveHeartbeat: true }, row("s", "idle", "heartbeat")],
		["action label", { activity: "working", sessionActions: RUN_ACTIONS }, row("s", "running", "send to worker")],
		["kind label", { activity: "working", sessionActions: PREP_ACTIONS }, row("s", "running", "session command")],
		["queued actions", { sessionActions: { ...BASE.sessionActions, queuedCount: 2 } }, row("s", "idle", "2 queued")],
		["starting worker", { activity: "working", workerState: "starting" }, row("s", "running", "starting")],
		["stopping worker", { workerState: "stopping" }, row("s", "idle", "stopping")],
		["replied subagent", { runtimeKind: "subagent", repliedSinceTask: true }, row("s", "idle", "replied")],
	])("%s", (_name, overrides, expected) => {
		expectTable(overrides ? [makeSummary(overrides)] : [], overrides ? [expected] : []);
	});

	it("sorts failures first, then recovering workers, then running, then idle, then the rest", () => {
		expectTable(UNSORTED, EXPECTED_SORT);
	});
});
