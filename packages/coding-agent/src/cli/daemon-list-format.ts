import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";

// Display status derived from the lifecycle + activity axes, plus the remote
// mesh reachability axis: an unreachable tailnet peer reads "offline".
type ListStatus = "working" | "idle" | "offline" | "archived";

const LIST_STATUS_ORDER: Record<ListStatus, number> = {
	working: 0,
	idle: 1,
	offline: 2,
	archived: 3,
};

function listStatusForSummary(summary: SessionSummary): ListStatus {
	if (summary.remoteOffline === true) {
		return "offline";
	}
	if (summary.lifecycle === "archived") {
		return "archived";
	}
	return summary.activity === "working" ? "working" : "idle";
}

type ListRow = {
	name: string;
	id: string;
	status: ListStatus;
	age: string;
	model: string;
	messages: string;
	clients: string;
	host: string;
};

export function formatSessionListTable(sessions: readonly SessionSummary[], nowMs = Date.now()): string {
	// The host column appears only when a remote mesh session is present, so a
	// purely local table keeps its long-standing column layout byte-for-byte.
	const showHost = sessions.some((session) => session.remoteHost !== undefined);
	const rows = sortSessionsForList(sessions).map((session) => ({
		name: session.sessionName ?? "",
		id: formatSessionDisplayId(session.id),
		status: listStatusForSummary(session),
		age: formatSessionAge(session.modified, nowMs),
		model: formatModelSelector(session.model, session.remoteModel),
		messages: String(session.messageCount),
		clients: String(session.attachedClients),
		host: session.remoteHost ?? "",
	}));
	const columns: Array<keyof ListRow> = ["name", "id", "status", "age", "model", "messages", "clients"];
	if (showHost) columns.push("host");
	return formatTable(columns, rows, formatListCell);
}

function sortSessionsForList(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => {
			const statusDelta =
				LIST_STATUS_ORDER[listStatusForSummary(left.session)] -
				LIST_STATUS_ORDER[listStatusForSummary(right.session)];
			return statusDelta || left.index - right.index;
		})
		.map(({ session }) => session);
}

function formatListCell(row: ListRow, column: keyof ListRow, value: string): string {
	if (column !== "status") {
		return value;
	}

	switch (row.status) {
		case "working":
			return chalk.red(value);
		case "idle":
			return chalk.blue(value);
		case "offline":
		case "archived":
			return chalk.dim(value);
	}
}

export function formatSessionAge(modified: string | undefined, nowMs: number): string {
	if (!modified) {
		return "";
	}
	const modifiedMs = new Date(modified).getTime();
	if (Number.isNaN(modifiedMs)) {
		return "";
	}
	const ageSeconds = Math.max(0, Math.floor((nowMs - modifiedMs) / 1000));
	if (ageSeconds < 60) {
		return `${ageSeconds}s`;
	}
	const ageMinutes = Math.floor(ageSeconds / 60);
	if (ageMinutes < 60) {
		return `${ageMinutes}m`;
	}
	const ageHours = Math.floor(ageMinutes / 60);
	if (ageHours < 24) {
		return `${ageHours}h`;
	}
	const ageDays = Math.floor(ageHours / 24);
	if (ageDays < 7) {
		return `${ageDays}d`;
	}
	const ageWeeks = Math.floor(ageDays / 7);
	if (ageWeeks < 52) {
		return `${ageWeeks}w`;
	}
	return `${Math.floor(ageWeeks / 52)}y`;
}

function formatModelSelector(model: SessionSummary["model"], remoteModel: SessionSummary["remoteModel"]): string {
	if (model) return `${model.provider}/${model.id}`;
	// Remote mesh rows carry a display-only model identity.
	return remoteModel ? `${remoteModel.provider}/${remoteModel.modelId}` : "";
}

// Column widths are terminal display widths: UTF-16 `.length` under-counts CJK
// and emoji cells, which drifts the following columns (the agents view measures
// with `visibleWidth` for the same reason).
export function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
): string {
	const widths = columns.map((column) =>
		Math.max(visibleWidth(String(column)), ...rows.map((row) => visibleWidth(String(row[column])))),
	);
	const padCell = (value: string, width: number): string =>
		value + " ".repeat(Math.max(0, width - visibleWidth(value)));
	const lines = [columns.map((column, index) => padCell(String(column), widths[index])).join("  ")];
	for (const row of rows) {
		const line = columns
			.map((column, index) => {
				const value = padCell(String(row[column]), widths[index]);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}
