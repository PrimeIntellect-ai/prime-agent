import chalk from "chalk";
import stripAnsi from "strip-ansi";
import type { SessionUsageSummary } from "../core/usage.js";
import { classifySessionRosterStatus } from "../modes/daemon/agent-roster.js";
import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { formatSessionAge, formatTable } from "./daemon-list-format.js";

// Cap for free-text cells (recaps, diagnostics) so one long line never stretches the row.
const MAX_CELL_CHARS = 60;

// Controls that stripAnsi misses and compactCellText would not compact away.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

type SessionsRow = {
	name: string;
	status: string;
	activity: string;
	"last heard": string;
	error: string;
	usage: string;
};

/**
 * One-line-per-agent operator table for `prime-agent sessions`.
 */
export function formatSessionsTable(sessions: readonly SessionSummary[], nowMs = Date.now()): string {
	const rows = sortSessionsForTable(sessions).map((summary) => ({
		name: sessionNameCell(summary),
		status: sessionsStatusLabel(summary),
		activity: truncateCell(sessionActivityCell(summary)),
		"last heard": formatSessionAge(summary.lastHeardFromAt ?? summary.modified, nowMs),
		error: truncateCell(sessionErrorCell(summary)),
		usage: formatUsageCell(summary.usage),
	}));
	return formatTable(["name", "status", "activity", "last heard", "error", "usage"], rows, formatSessionsCell);
}

// Failures first, then recovering/running, then idle, then everything else.
function sortSessionsForTable(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => sessionsSortKey(left.session) - sessionsSortKey(right.session) || left.index - right.index)
		.map(({ session }) => session);
}

function sessionsSortKey(summary: SessionSummary): number {
	if (summary.statusLabel === "failed" || summary.workerState === "failed") return 0;
	if (summary.statusLabel === "recovering" || summary.workerState === "recovering") return 1;
	if (summary.statusLabel === "queued" || sessionRosterStatus(summary) === "running") return 2;
	if (sessionRosterStatus(summary) === "idle") return 3;
	return 4;
}

function sessionRosterStatus(summary: SessionSummary): "running" | "idle" | "inactive" {
	return summary.rosterStatus ?? classifySessionRosterStatus(summary);
}

// Exceptional labels (queued/recovering/failed) override the plain roster status,
// mirroring the agents view's status-label precedence.
function sessionsStatusLabel(summary: SessionSummary): string {
	return summary.statusLabel ?? sessionRosterStatus(summary);
}

// Mirrors the agents-view status label branch by branch, minus statusLabel and
// lastHeardFromAt (they get their own columns here). Two deliberate wording
// drops: the heartbeat mark is just "heartbeat" (no countdown; the TUI has a
// live next-run timer, this table does not), and the final idle fallback is
// empty instead of "needs input" (the status column already says idle).
function sessionActivityDetail(summary: SessionSummary): string {
	if (summary.statusLabel === undefined && summary.workerState !== undefined && summary.workerState !== "ready") {
		return summary.workerState;
	}
	if (summary.isCompacting) {
		return "compacting";
	}
	if (summary.isStreaming) {
		return summary.isRunningTools ? "running tools" : "thinking";
	}
	if (summary.isRunningTools === true) {
		return "running tools";
	}
	if (summary.isBashRunning === true) {
		return "running bash";
	}
	if (summary.sessionActions.active) {
		return summary.sessionActions.active.label ?? summary.sessionActions.active.kind.replaceAll("_", " ");
	}
	if (summary.sessionActions.queuedCount > 0) {
		return `${summary.sessionActions.queuedCount} queued`;
	}
	if (summary.lifecycle === "archived") {
		return "archived";
	}
	if (summary.hasActiveHeartbeat) {
		return "heartbeat";
	}
	if (summary.runtimeKind === "subagent" && summary.repliedSinceTask) {
		return "replied";
	}
	if (summary.activity === "working") {
		return "classifying";
	}
	if (summary.taskState === "error") {
		return "error";
	}
	return summary.taskState === "completed" ? "completed" : "";
}

function sessionActivityCell(summary: SessionSummary): string {
	const detail = sessionActivityDetail(summary);
	const recap = compactCellText(summary.summary);
	return [detail, recap].filter((part) => part.length > 0).join(" · ");
}

function sessionErrorCell(summary: SessionSummary): string {
	const diagnostics = summary.diagnostics ?? [];
	for (let index = diagnostics.length - 1; index >= 0; index--) {
		const diagnostic = diagnostics[index];
		if (diagnostic?.type === "error") {
			return compactCellText(diagnostic.message);
		}
	}
	if (summary.statusLabel === "failed" || summary.workerState === "failed") {
		return "worker failed";
	}
	return compactCellText(summary.modelFallbackMessage);
}

function formatUsageCell(usage: SessionUsageSummary | undefined): string {
	if (!usage) {
		return "";
	}
	return `${formatTokenCount(usage.inputTokens)}/${formatTokenCount(usage.outputTokens)} $${usage.cost.toFixed(2)}`;
}

function formatTokenCount(tokens: number): string {
	if (tokens < 1000) {
		return String(tokens);
	}
	if (tokens < 1_000_000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	if (tokens < 1_000_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}m`;
	}
	return `${(tokens / 1_000_000_000).toFixed(1)}b`;
}

// Names are user-provided: strip ANSI escapes and control characters, then
// compact whitespace, so the cell can never add table lines or move the cursor.
function sessionNameCell(summary: SessionSummary): string {
	const raw = summary.sessionName ?? formatSessionDisplayId(summary.id);
	return compactCellText(stripAnsi(raw).replace(CONTROL_CHARACTERS, ""));
}

function compactCellText(value: string | undefined): string {
	return value?.replaceAll(/\s+/g, " ").trim() ?? "";
}

function truncateCell(value: string, maxChars = MAX_CELL_CHARS): string {
	if (value.length <= maxChars) {
		return value;
	}
	return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatSessionsCell(row: SessionsRow, column: keyof SessionsRow, value: string): string {
	if (column === "status") {
		switch (row.status) {
			case "running":
			case "failed":
				return chalk.red(value);
			case "idle":
				return chalk.blue(value);
			case "inactive":
				return chalk.dim(value);
			case "recovering":
			case "queued":
				return chalk.yellow(value);
			default:
				return value;
		}
	}
	if (column === "error" && row.error.length > 0) {
		return chalk.red(value);
	}
	return value;
}
