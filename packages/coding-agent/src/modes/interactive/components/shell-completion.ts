import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	type AsyncBashCompletionDetails,
	type CustomMessage,
} from "../../../core/messages.js";
import { theme } from "../theme/theme.js";

export interface ShellCompletion {
	details: AsyncBashCompletionDetails;
	message: CustomMessage;
}

export interface BackgroundShellHandle {
	pid: number;
	command: string;
	exitCode?: number;
}

export function readShellCompletion(message: CustomMessage): ShellCompletion | undefined {
	if (message.customType !== ASYNC_BASH_COMPLETION_CUSTOM_TYPE) return undefined;
	const details = message.details;
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	if (
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.command !== "string" ||
		typeof record.exitCode !== "number" ||
		!Number.isInteger(record.exitCode)
	)
		return undefined;
	return { details: { pid: record.pid, command: record.command, exitCode: record.exitCode }, message };
}

function readPythonString(literal: string): string | undefined {
	const quote = literal[0];
	if ((quote !== "'" && quote !== '"') || literal.at(-1) !== quote) return undefined;
	const escapes: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t" };
	let value = "";
	for (let index = 1; index < literal.length - 1; index++) {
		const char = literal[index]!;
		if (char === quote || char === "\n" || char === "\r") return undefined;
		if (char !== "\\") {
			value += char;
			continue;
		}
		const escaped = escapes[literal[++index]!];
		if (escaped === undefined || index >= literal.length - 1) return undefined;
		value += escaped;
	}
	return value;
}

function readLiteralShellLaunch(code: string): { command: string; assignmentOnly: boolean } | undefined {
	const launch = code
		.trim()
		.split("\n")
		.filter((line) => !/^(?:from rlm import bash|import rlm)\s*$/.test(line));
	// Restrict to a single top-level launch, optionally followed by its variable.
	const call = /^(?:([A-Za-z_]\w*)\s*=\s*)?(?:rlm\.)?bash\(\s*(.*)\s*\)\s*$/.exec(launch[0] ?? "");
	if (!call || (launch.length > 1 && (launch.length !== 2 || launch[1]?.trim() !== call[1]))) return undefined;
	const command = readPythonString(call[2]?.trim() ?? "");
	return command === undefined ? undefined : { command, assignmentOnly: !!call[1] && launch.length === 1 };
}

// Assignment-only cells save no handle repr. The caller must require a unique
// exact command match; this does not infer a PID or inspect an await expression.
export function readAssignedShellCommand(code: string, details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	if (record.status !== "ok" || (record.result !== undefined && record.result !== "")) return undefined;
	const launch = readLiteralShellLaunch(code);
	return launch?.assignmentOnly ? launch.command : undefined;
}

// Only literal commands and a complete handle repr establish identity. Ordinary
// output containing PID digits or a similar command is deliberately insufficient.
export function readBackgroundShellHandle(code: string, details: unknown): BackgroundShellHandle | undefined {
	if (!details || typeof details !== "object" || !("result" in details) || typeof details.result !== "string")
		return undefined;
	const match =
		/^<BashHandle pid=(\d+) (running|exit_code=-?\d+) command=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')>$/.exec(
			details.result.trim(),
		);
	if (!match) return undefined;
	const command = readPythonString(match[3]!);
	if (command === undefined) return undefined;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (readLiteralShellLaunch(code)?.command !== command) return undefined;
	return { pid, command, exitCode: match[2] === "running" ? undefined : Number(match[2]!.slice(10)) };
}

export function shellCompletionText(completion: ShellCompletion): string {
	const content = completion.message.content;
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

export function shellCompletionLabel(completion: ShellCompletion | undefined): string {
	return completion && completion.details.exitCode !== 0
		? `Background shell command failed · exit ${completion.details.exitCode}`
		: "Background shell command finished";
}

export class ShellCompletionComponent implements Component {
	private expanded = false;
	constructor(
		private readonly message: CustomMessage,
		private attached = false,
	) {}
	setAttached(): void {
		this.attached = true;
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (this.attached && !this.expanded) return [];
		const completion = readShellCompletion(this.message);
		const color = completion?.details.exitCode ? "error" : "muted";
		const label = shellCompletionLabel(completion);
		const heading = this.attached
			? `${label} · pid ${completion?.details.pid} · ${formatShellCompletionTime(this.message.timestamp)}`
			: `${completion?.details.exitCode ? "✗" : "✓"} ${label}`;
		const header = truncateToWidth(theme.fg(color, ` ${heading}`), width, "");
		if (!this.expanded) return [header];
		const raw = completion
			? shellCompletionText(completion)
			: typeof this.message.content === "string"
				? this.message.content
				: JSON.stringify(this.message.content);
		return [header, ...new Text(raw, 1, 0).render(width)];
	}
}

export function formatShellCompletionTime(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown time";
}
