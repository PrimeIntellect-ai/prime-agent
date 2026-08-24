import chalk from "chalk";
import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { DaemonWorkflowStatusProjection, SessionSummary } from "../modes/daemon/daemon-session-list.js";

// Display status derived from the lifecycle + activity axes.
type ListStatus = "working" | "idle" | "archived";

const LIST_STATUS_ORDER: Record<ListStatus, number> = {
	working: 0,
	idle: 1,
	archived: 2,
};

function listStatusForSummary(summary: SessionSummary): ListStatus {
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
	workflow: string;
	next: string;
	blocker: string;
	head: string;
};

export function formatSessionListTable(sessions: readonly SessionSummary[], nowMs = Date.now()): string {
	const rows = sortSessionsForList(sessions).map((session) => ({
		name: session.sessionName ?? "",
		id: formatSessionDisplayId(session.id),
		status: listStatusForSummary(session),
		workflow: formatWorkflowStatus(session.workflowStatus),
		next: formatWorkflowNext(session.workflowStatus),
		blocker: formatWorkflowBlocker(session.workflowStatus),
		head: formatWorkflowHead(session.workflowStatus),
		age: formatSessionAge(session.modified, nowMs),
		model: formatSessionModel(session.model),
		messages: String(session.messageCount),
		clients: String(session.attachedClients),
	}));
	return formatTable(
		["name", "id", "status", "workflow", "next", "blocker", "head", "age", "model", "messages", "clients"],
		rows,
		formatListCell,
	);
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
		case "archived":
			return chalk.dim(value);
	}
}

function formatSessionAge(modified: string | undefined, nowMs: number): string {
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

function formatSessionModel(model: SessionSummary["model"]): string {
	return model ? `${model.provider}/${model.id}` : "";
}

function formatWorkflowStatus(status: DaemonWorkflowStatusProjection | undefined): string {
	if (!status) {
		return "";
	}
	return status.phase ? `${status.status}/${status.phase}` : status.status;
}

function formatWorkflowNext(status: DaemonWorkflowStatusProjection | undefined): string {
	if (!status) {
		return "";
	}
	const next = [status.nextGate, status.nextTask].filter((value): value is string => value !== null);
	if (status.approvalRequest) {
		next.push(`approval:${status.approvalRequest.approvalRequestId}`);
	}
	return next.join("/");
}

function formatWorkflowBlocker(status: DaemonWorkflowStatusProjection | undefined): string {
	if (status?.blocker) {
		return `${status.blocker.kind}:${status.blocker.reason}`;
	}
	return status?.approvalRequest ? "approval_pending" : "";
}

function formatWorkflowHead(status: DaemonWorkflowStatusProjection | undefined): string {
	return status?.headDigest ?? status?.approvalRequest?.headDigest ?? "";
}

function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
): string {
	const widths = columns.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
	);
	const lines = [columns.map((column, index) => String(column).padEnd(widths[index])).join("  ")];
	for (const row of rows) {
		const line = columns
			.map((column, index) => {
				const value = String(row[column]).padEnd(widths[index]);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}
