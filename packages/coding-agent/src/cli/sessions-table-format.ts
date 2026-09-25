import { truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import type { SessionUsageSummary } from "../core/usage.js";
import { classifySessionRosterStatus, sessionActivityDetail } from "../modes/daemon/agent-roster.js";
import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { formatSessionAge, formatTable } from "./daemon-list-format.js";

// Display-width cap for free-text cells (names, recaps, error text) so one
// long line never stretches the row; wide glyphs count as their terminal columns.
const MAX_CELL_CHARS = 60;

// C0/C1 controls that stripAnsi misses and whitespace compaction cannot remove.
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
		name: truncateCell(sessionNameCell(summary)),
		status: sessionsStatusLabel(summary),
		activity: truncateCell(sessionActivityCell(summary)),
		// lastHeardFromAt is the supervisor's staleness mark, served only when a
		// worker's roster frames go stale (sweepRosterStaleness); healthy workers
		// carry no heard-from timestamp, so the cell stays empty rather than
		// mislabeling the session-file mtime as a heard-from time (the agents view
		// keys the same label on the mark's presence).
		"last heard": formatSessionAge(summary.lastHeardFromAt, nowMs),
		error: truncateCell(sessionErrorCell(summary)),
		usage: formatUsageCell(summary.usage),
	}));
	return formatTable(["name", "status", "activity", "last heard", "error", "usage"], rows, formatSessionsCell);
}

// Names are user-provided; sanitize them and fall back to the display id when
// sanitizing leaves nothing (a name of only control characters had no
// identifier to show).
function sessionNameCell(summary: SessionSummary): string {
	return compactCellText(summary.sessionName) || formatSessionDisplayId(summary.id);
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

// The detail wording comes from the shared roster branch table (agent-roster.ts):
// one table serves this column and the agents view status label, so a state
// added there shows up on both surfaces. The table's knobs: the heartbeat mark
// is just "heartbeat" (no countdown; the TUI has a live next-run timer, this
// table does not) and the idle fallback is empty instead of "needs input"
// (the status column already says idle). statusLabel and lastHeardFromAt get
// their own columns here, and roster rows carry an empty sessionActions
// snapshot (see RosterSessionSummary), so there is no action branch.
function sessionActivityCell(summary: SessionSummary): string {
	const detail = sessionActivityDetail(summary, { heartbeatLabel: "heartbeat", idleLabel: "" });
	const recap = compactCellText(summary.summary);
	return [detail, recap].filter((part) => part.length > 0).join(" · ");
}

// The supervisor `list` RPC serves roster rows, which omit summary.diagnostics
// (see RosterSessionSummary in agent-roster.ts), so this cell can only show the
// worker failure mark and the model fallback notice the roster actually carries.
function sessionErrorCell(summary: SessionSummary): string {
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

// All free-text cells (names, recaps, error notices) share one sanitizer: strip
// ANSI escapes and control characters, then compact whitespace, so no cell can
// clear the screen, move the cursor, restyle later columns, or add table lines.
function compactCellText(value: string | undefined): string {
	return (value === undefined ? "" : stripAnsi(value).replace(CONTROL_CHARACTERS, "")).replaceAll(/\s+/g, " ").trim();
}

function truncateCell(value: string, maxChars = MAX_CELL_CHARS): string {
	return truncateToWidth(value, maxChars, "…");
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
