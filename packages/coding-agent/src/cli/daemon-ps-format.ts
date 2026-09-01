import chalk from "chalk";
import type { DaemonInfo, DaemonStatus } from "./daemon-ps.js";

type DaemonRow = {
	socket: string;
	pid: string;
	version: string;
	status: string;
	sessions: string;
	uptime: string;
};

export function formatDaemonListTable(daemons: readonly DaemonInfo[]): string {
	const rows = daemons.map((daemon) => ({
		socket: daemon.isDefault ? `${daemon.socketPath} *` : daemon.socketPath,
		pid: daemon.pid !== undefined ? String(daemon.pid) : "",
		version: daemon.version ?? "",
		status: daemon.status,
		sessions: daemon.sessionCount !== undefined ? String(daemon.sessionCount) : "",
		uptime: formatUptime(daemon.uptimeSeconds),
	}));
	const table = formatTable(["socket", "pid", "version", "status", "sessions", "uptime"], rows, formatDaemonCell);
	const footers: string[] = [];
	if (daemons.some((daemon) => daemon.isDefault)) {
		footers.push(chalk.dim("* default background service"));
	}
	for (const daemon of daemons) {
		if (daemon.status === "ownership-lost") {
			footers.push(
				chalk.dim(
					`! ${daemon.socketPath}: supervisor lost its ownership record — ` +
						'run "prime-agent doctor --fix" to restart it (sessions are preserved)',
				),
			);
		}
	}
	return footers.length > 0 ? `${table}\n\n${footers.join("\n")}` : table;
}

function formatDaemonCell(_row: DaemonRow, column: keyof DaemonRow, value: string): string {
	if (column !== "status") {
		return value;
	}
	return colorStatus(value.trim() as DaemonStatus, value);
}

function colorStatus(status: DaemonStatus, value: string): string {
	switch (status) {
		case "current":
			return chalk.green(value);
		case "stale":
			return chalk.yellow(value);
		case "ownership-lost":
		case "unreachable":
			return chalk.red(value);
		case "orphan-file":
			return chalk.dim(value);
	}
}

export function formatUptime(uptimeSeconds: number | undefined): string {
	if (uptimeSeconds === undefined || !Number.isFinite(uptimeSeconds)) {
		return "";
	}
	const seconds = Math.max(0, Math.floor(uptimeSeconds));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d`;
	}
	return `${Math.floor(days / 7)}w`;
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
