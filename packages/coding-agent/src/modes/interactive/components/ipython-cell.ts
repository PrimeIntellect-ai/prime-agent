import {
	type Component,
	truncateToWidth,
	VersionedRenderCache,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import { previewIpythonCode } from "../../../core/tools/code-preview.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { parseIpythonBashCell } from "../../../core/tools/ipython-cell-code.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, WORKING_ICON_FRAMES, workingIconFrame } from "../theme/working-icon.js";
import { agentMessageBodyLines, agentMessagePreview, agentMessageSummaryLine } from "./agent-message.js";
import { normalizeErrorDetails, summarizeErrorDetails } from "./collapsible-error.js";
import { renderDiffSeparator, renderRichDiff } from "./diff.js";
import { countChangedLines, FILE_CHANGE_DIFF_INDENT, formatFileChangeSummaryLine } from "./edit-summary.js";
import { expandCollapseHint } from "./keybinding-hints.js";

export interface IPythonCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface IPythonCellState {
	code: string;
	content?: readonly IPythonCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	agentMessagesExpanded?: boolean;
	editDiffsExpanded?: boolean;
	showExpandHint?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	showImages?: boolean;
	/** Session cwd — edit paths nested under it render relative, else absolute. */
	cwd?: string;
}

interface DiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

interface SentAgentMessageDisplay {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

interface IpythonDetails {
	durationMs?: number;
	status?: string;
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	backgroundOutput?: string;
	diffs?: DiffDisplay[];
	sentAgentMessages?: SentAgentMessageDisplay[];
	error?: IpythonErrorDetails;
}

interface IpythonErrorDetails {
	ename: string;
	evalue: string;
	traceback: readonly string[];
}

interface TracebackParts {
	output: string;
	traceback: string;
	preview: string;
}

const MAGIC_LINE_PATTERN = /^\s*!/;

// Two columns, matching the code body's "› "/"  " gutter so output aligns under it.
const OUTPUT_INDENT = "  ";

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append `ESC[0m` when `line` ends with a foreground or background color still
 * open, so a span that wrapTextWithAnsi split across lines cannot bleed into the
 * trailing padding or the next line.
 */
function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the color data of `38;5;n` / `38;2;r;g;b` so a component (e.g. 38) isn't read as a code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function getIpythonCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) {
		return "";
	}
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

function readDetails(details: unknown): IpythonDetails {
	if (!details || typeof details !== "object") {
		return {};
	}
	const record = details as Record<string, unknown>;
	const error = readErrorDetails(record.error);
	return {
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		errorEname: error?.ename ?? (typeof record.errorEname === "string" ? record.errorEname : undefined),
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
		result: typeof record.result === "string" ? record.result : undefined,
		backgroundOutput: typeof record.backgroundOutput === "string" ? record.backgroundOutput : undefined,
		diffs: readDiffDisplays(record.diffs),
		sentAgentMessages: readSentAgentMessages(record.sentAgentMessages),
		error,
	};
}

function readSentAgentMessages(value: unknown): SentAgentMessageDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const messages = value.flatMap((entry): SentAgentMessageDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		const target = record.target;
		if (!target || typeof target !== "object") {
			return [];
		}
		const targetRecord = target as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			typeof record.message !== "string" ||
			(record.deliveryStatus !== "delivered" && record.deliveryStatus !== "queued") ||
			typeof targetRecord.activeSessionId !== "string" ||
			typeof targetRecord.sessionId !== "string"
		) {
			return [];
		}
		return [
			{
				id: record.id,
				message: record.message,
				deliveryStatus: record.deliveryStatus,
				...(record.receiverRole === "parent" || record.receiverRole === "sibling" || record.receiverRole === "child"
					? { receiverRole: record.receiverRole }
					: {}),
				target: {
					activeSessionId: targetRecord.activeSessionId,
					sessionId: targetRecord.sessionId,
					...(typeof targetRecord.sessionName === "string" ? { sessionName: targetRecord.sessionName } : {}),
				},
			},
		];
	});
	return messages.length > 0 ? messages : undefined;
}

function readDiffDisplays(value: unknown): DiffDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const diffs = value.flatMap((entry): DiffDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.oldStr !== "string" || typeof record.newStr !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				oldStr: record.oldStr,
				newStr: record.newStr,
				startLine: typeof record.startLine === "number" ? record.startLine : undefined,
			},
		];
	});
	return diffs.length > 0 ? diffs : undefined;
}

/** Strip one layer of repr quotes so an `execute_result` string compares cleanly. */
function stripReprQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** True when `text` is just the edit skill's "Edited <path>" confirmation for one of `diffs`. */
function isEditConfirmation(text: string | undefined, diffs: readonly DiffDisplay[]): boolean {
	if (!text) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return diffs.some((diff) => stripped === `Edited ${diff.path}`);
}

/**
 * True when `text` is the `agent_message.send` receipt dict for one of the sent
 * messages already summarized above the output, so the raw receipt isn't shown.
 * Matches only a single-receipt repr — the receipt dict always starts with its
 * `id` key — so broadcast `{'receipts': [...]}` results (which can carry error
 * entries with no summary line) and results that merely mention an ID still render.
 */
function isAgentMessageReceipt(text: string | undefined, messages: readonly SentAgentMessageDisplay[]): boolean {
	if (!text || messages.length === 0) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return messages.some(
		(message) => stripped.startsWith(`{'id': '${message.id}'`) || stripped.startsWith(`{"id": "${message.id}"`),
	);
}

function readErrorDetails(value: unknown): IpythonErrorDetails | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.ename !== "string") {
		return undefined;
	}
	return {
		ename: record.ename,
		evalue: typeof record.evalue === "string" ? record.evalue : "",
		traceback: Array.isArray(record.traceback)
			? record.traceback.filter((line): line is string => typeof line === "string")
			: [],
	};
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) {
		return undefined;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function isImageBlock(block: IPythonCellContentBlock): boolean {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function textFromBlocks(blocks: readonly IPythonCellContentBlock[] | undefined): string {
	if (!blocks) {
		return "";
	}
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function splitTraceback(text: string, errorName: string | undefined): TracebackParts | undefined {
	const normalized = normalizeErrorDetails(text);
	if (!normalized.trim()) {
		return undefined;
	}

	const lines = normalized.split("\n");
	let tracebackIndex = lines.findIndex((line) => line.includes("Traceback (most recent call last):"));
	if (tracebackIndex < 0 && errorName) {
		tracebackIndex = lines.findIndex((line) => line.trim().startsWith(`${errorName}:`));
	}
	if (tracebackIndex < 0) {
		return undefined;
	}

	const output = lines.slice(0, tracebackIndex).join("\n").trimEnd();
	const traceback = lines.slice(tracebackIndex).join("\n").trim();
	const preview = summarizeErrorDetails(traceback);
	return { output, traceback, preview: preview === "Error" && errorName ? errorName : preview };
}

function formatIpythonErrorSummary(error: IpythonErrorDetails): string {
	const normalizedValue = normalizeErrorDetails(error.evalue);
	if (!normalizedValue.trim()) {
		return error.ename;
	}
	const value = summarizeErrorDetails(normalizedValue);
	if (value === "Error") {
		return error.ename;
	}
	return visibleWidth(value) <= 48 ? `${error.ename}: ${value}` : error.ename;
}

export class IPythonCellComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: IPythonCellState;
	private stateVersion = 0;

	constructor(state: IPythonCellState) {
		this.state = state;
	}

	update(state: IPythonCellState): void {
		this.state = state;
		this.stateVersion += 1;
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = readDetails(this.state.details);
		// Fold the animation frame into the cache key while running (offset within
		// a stateVersion slot so it never collides with another version).
		const frames = WORKING_ICON_FRAMES.length;
		const cacheVersion =
			this.statusKind(details) === "running"
				? this.stateVersion * frames + (getWorkingPulseFrame() % frames)
				: this.stateVersion * frames;
		const cached = this.renderCache.get(safeWidth, cacheVersion);
		if (cached) {
			return cached;
		}

		// The top line is identical whether collapsed or expanded — same marker,
		// counts, duration, and expand hint — so toggling never shifts the layout
		// or indentation; expanding only attaches code and output below it.
		// Cached by state version so unrelated repaints don't re-render (flicker).
		const lines = [truncateToWidth(` ${this.collapsedLine(details)}`, safeWidth, "")];

		const hasCode = this.state.expanded ? this.renderCode(lines, safeWidth) : false;
		if ((details.diffs?.length ?? 0) > 0) {
			this.renderDiffs(lines, safeWidth, details.diffs ?? [], hasCode);
		}
		if ((details.sentAgentMessages?.length ?? 0) > 0) {
			this.renderSentAgentMessages(lines, safeWidth, details.sentAgentMessages ?? []);
		}

		if (!this.state.expanded) {
			return this.renderCache.set(safeWidth, cacheVersion, lines);
		}

		this.renderOutput(lines, safeWidth, details, hasCode);
		return this.renderCache.set(safeWidth, cacheVersion, lines);
	}

	private collapsedLine(details: IpythonDetails): string {
		const code = this.state.code.trimEnd();
		const isBashCell = parseIpythonBashCell(code) !== undefined;
		const preview = previewIpythonCode(code);
		const languageLabel = isBashCell && preview.language !== "bash" ? `bash · ${preview.language}` : preview.language;
		const parts = [`${this.marker(details)} ${theme.fg("muted", languageLabel)}`];

		if (preview.text) {
			parts.push(this.highlightInputLine(preview.text, preview.language === "bash"));
		} else if (!this.state.executionStarted) {
			parts.push(theme.fg("muted", "waiting for code"));
		}

		const counts = this.lineCounts(details);
		if (counts) {
			parts.push(theme.fg("muted", counts));
		}

		const duration = formatDuration(details.durationMs);
		if (duration) {
			parts.push(theme.fg("muted", duration));
		}

		const errorName = !this.state.isPartial ? (details.error?.ename ?? details.errorEname) : undefined;
		if (errorName) {
			parts.push(theme.fg("error", errorName));
		}

		if (this.state.showExpandHint !== false) {
			parts.push(expandCollapseHint("app.tools.expand", this.state.expanded === true));
		}
		return parts.join(theme.fg("dim", " · "));
	}

	/** Status marker — color carries running/done/error; ✓/✗ once finished. */
	private marker(details: IpythonDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", workingIconFrame(getWorkingPulseFrame()));
			default: // queued
				return theme.fg("muted", "◇");
		}
	}

	// `↑in ↓out lines` — the "lines" unit disambiguates from the token counts on
	// the activity line. Output is omitted for edits (the diff shows on expand).
	private lineCounts(details: IpythonDetails): string | undefined {
		const bashCell = parseIpythonBashCell(this.state.code);
		const body = (bashCell?.body ?? this.state.code).split(/\r?\n/);
		const input = body.filter((line) => line.trim().length > 0).length;

		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		const sentMessages = details.sentAgentMessages ?? [];
		const result = isAgentMessageReceipt(details.result, sentMessages) ? undefined : details.result;
		const structured = [details.stdout, details.stderr, result, details.backgroundOutput]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		const blocksText = textFromBlocks(this.state.content);
		const fallback = isAgentMessageReceipt(blocksText, sentMessages) ? "" : blocksText;
		const outputText = (structured || fallback).trim();
		const output = hasDiffs || !outputText ? 0 : outputText.split("\n").length;

		const segments: string[] = [];
		if (input > 0) {
			segments.push(`↑ ${input}`);
		}
		if (output > 0) {
			segments.push(`↓ ${output}`);
		}
		return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
	}

	private statusKind(details: IpythonDetails): "error" | "aborted" | "running" | "queued" | "done" {
		const status = details.status;
		if (this.state.isError || status === "error") {
			return "error";
		}
		if (status === "aborted") {
			return "aborted";
		}
		// Keyed off the result, not executionStarted, so calls rehydrated from a
		// past session (which never saw the live start) render done, not running.
		if (!this.state.isPartial && (status !== undefined || this.state.executionStarted || this.hasResult(details))) {
			return "done";
		}
		if (this.state.isPartial || this.state.executionStarted) {
			return "running";
		}
		return "queued";
	}

	private hasResult(details: IpythonDetails): boolean {
		return (
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined ||
			(details.diffs?.length ?? 0) > 0 ||
			(details.sentAgentMessages?.length ?? 0) > 0 ||
			(this.state.content?.length ?? 0) > 0
		);
	}

	// Only runs when expanded — shows the full source below the fixed top line.
	private renderCode(lines: string[], width: number): boolean {
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addBlank(lines, width);
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for code"), width);
			return false;
		}

		this.addBlank(lines, width);
		const isBashCell = parseIpythonBashCell(code) !== undefined;
		const rawLines = code.split("\n");
		// Highlight the whole cell at once so multi-line strings keep their color.
		const highlightedLines = isBashCell ? [] : highlightCode(code, "python");
		for (const [index, rawLine] of rawLines.entries()) {
			const prefix = index === 0 ? theme.fg("dim", "› ") : theme.fg("dim", "  ");
			const highlighted =
				isBashCell || MAGIC_LINE_PATTERN.test(rawLine) || parseIpythonBashCell(rawLine) !== undefined
					? theme.fg("bashMode", rawLine)
					: (highlightedLines[index] ?? theme.fg("mdCodeBlock", rawLine));
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}

		return true;
	}

	private highlightInputLine(line: string, isBashCell: boolean): string {
		if (isBashCell || MAGIC_LINE_PATTERN.test(line) || parseIpythonBashCell(line) !== undefined) {
			return theme.fg("bashMode", line);
		}
		const highlighted = highlightCode(line, "python");
		return highlighted[0] ?? theme.fg("mdCodeBlock", line);
	}

	// Only runs when expanded — shows full output below the code, no previews.
	private renderOutput(lines: string[], width: number, details: IpythonDetails, hasCode: boolean): void {
		const blocks = this.state.content ?? [];
		const text = textFromBlocks(blocks);
		const imageCount = blocks.filter(isImageBlock).length;
		const hasStructuredOutput =
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined;
		const traceback =
			!hasStructuredOutput && (this.state.isError || details.status === "error")
				? splitTraceback(text, details.errorEname)
				: undefined;
		let outputStarted = false;
		let renderedTextOutput = false;

		const diffs = details.diffs ?? [];
		const sentMessages = details.sentAgentMessages ?? [];

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (hasStructuredOutput) {
			if (details.stdout?.trim() && !isEditConfirmation(details.stdout, diffs)) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out");
			}
			if (details.stderr?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err");
			}
			if (
				details.result?.trim() &&
				!isEditConfirmation(details.result, diffs) &&
				!isAgentMessageReceipt(details.result, sentMessages)
			) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.result), "out");
			}
		} else if (traceback) {
			if (traceback.output) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, traceback.output, "out");
			}
		} else if (text.trim() && !isAgentMessageReceipt(text, sentMessages)) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(lines, width, normalizeErrorDetails(text), this.state.isError ? "err" : "out");
		}

		// Without structured fields the fallback content text above already contains the appended background block.
		const backgroundOutput =
			hasStructuredOutput && details.backgroundOutput?.trim() ? details.backgroundOutput : undefined;
		if (backgroundOutput) {
			// Suppresses the placeholders below when background output is the cell's only output; rendered after the traceback to match the model-facing order.
			renderedTextOutput = true;
		}

		if (!renderedTextOutput && this.state.isPartial) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for output..."), width);
		} else if (!renderedTextOutput && this.state.executionStarted && !this.state.argsComplete) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for output..."), width);
		} else if (
			!renderedTextOutput &&
			!traceback &&
			!details.error &&
			diffs.length === 0 &&
			(details.sentAgentMessages?.length ?? 0) === 0 &&
			this.state.executionStarted &&
			imageCount === 0
		) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "no output"), width);
		}

		if (details.error) {
			startOutput();
			this.renderTraceback(
				lines,
				width,
				details.error.traceback.join("\n") || formatIpythonErrorSummary(details.error),
			);
		} else if (traceback) {
			startOutput();
			this.renderTraceback(lines, width, traceback.traceback);
		}

		if (backgroundOutput) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "background output (unattributed)"), width);
			this.renderOutputText(lines, width, normalizeErrorDetails(backgroundOutput), "err");
		}

		if (imageCount > 0) {
			startOutput();
			const text = this.state.showImages
				? `${imageCount} image${imageCount === 1 ? "" : "s"} rendered below`
				: `${imageCount} image${imageCount === 1 ? "" : "s"} hidden`;
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", text), width);
		}
	}

	// Summary line per message; expanding shows the message text in a `╰─` gutter
	// instead of the collapsed preview, matching received agent-message UI.
	private renderSentAgentMessages(lines: string[], width: number, messages: readonly SentAgentMessageDisplay[]): void {
		for (const message of messages) {
			const label = message.deliveryStatus === "delivered" ? "Agent message sent" : "Agent message queued";
			const recipient = formatAgentMessageParticipant("sent", message.receiverRole, message.target);
			if (this.state.agentMessagesExpanded) {
				this.addBlank(lines, width);
				this.addPlain(
					lines,
					truncateToWidth(agentMessageSummaryLine(label, recipient), Math.max(1, width - 1), "…"),
				);
				for (const bodyLine of agentMessageBodyLines(message.message, width)) {
					lines.push(bodyLine);
				}
				continue;
			}
			const prefixWidth = visibleWidth(`◆ ${label} · ${recipient} · `);
			const preview = agentMessagePreview(prefixWidth, message.message);
			this.addPlain(
				lines,
				truncateToWidth(agentMessageSummaryLine(label, recipient, preview), Math.max(1, width - 1), "…"),
			);
		}
	}

	// The `╰─ <path> +N -M` summary line renders in both states; ctrl+j only
	// attaches or removes the indented diff rows underneath it.
	private renderDiffs(lines: string[], width: number, diffs: readonly DiffDisplay[], hasCode: boolean): void {
		const diffsByPath = new Map<string, DiffDisplay[]>();
		for (const diff of diffs) {
			const existing = diffsByPath.get(diff.path);
			if (existing) existing.push(diff);
			else diffsByPath.set(diff.path, [diff]);
		}
		if (hasCode) {
			this.addPlain(lines, "");
		}
		let index = 0;
		for (const [path, edits] of diffsByPath) {
			index += 1;
			this.renderFileDiff(lines, width, path, edits, index === diffsByPath.size);
		}
	}

	private renderFileDiff(
		lines: string[],
		width: number,
		path: string,
		edits: readonly DiffDisplay[],
		showHint: boolean,
	): void {
		const language = getLanguageFromPath(path);
		// Diff rows align with the summary line's text column (after the `╰─ ` gutter).
		const indent = FILE_CHANGE_DIFF_INDENT.slice(0, Math.max(0, width - 1));
		const contentWidth = Math.max(1, width - indent.length);
		let added = 0;
		let removed = 0;
		const rows: string[] = [];
		edits.forEach((edit, index) => {
			const { diff: diffText } = generateDiffString(edit.oldStr, edit.newStr, 4, edit.startLine ?? 1);
			const counts = countChangedLines(diffText);
			added += counts.added;
			removed += counts.removed;
			if (!this.state.editDiffsExpanded) {
				return;
			}
			if (index > 0) {
				rows.push(`${indent}${renderDiffSeparator(contentWidth)}`);
			}
			// Append, not spread: a huge edit's diff can exceed the JS arg-count limit.
			for (const row of renderRichDiff(diffText, contentWidth, { language })) {
				rows.push(`${indent}${row}`);
			}
		});

		// Unlike the ctrl+o hint (latest tool row only), the ctrl+j hint renders on
		// every tool row, matching the thinking and agent-message hints. Within a
		// row it renders once, on the last file's summary line (showHint).
		const hint = showHint ? this.state.editDiffsExpanded === true : undefined;
		lines.push(formatFileChangeSummaryLine(path, this.state.cwd, { added, removed }, hint, width));

		for (const row of rows) {
			lines.push(row);
		}
	}

	private renderOutputText(lines: string[], width: number, text: string, label: "out" | "err"): void {
		const color = label === "err" ? "muted" : "toolOutput";
		for (const line of text.split("\n")) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg(color, line || " "), width);
		}
	}

	private renderTraceback(lines: string[], width: number, traceback: string): void {
		for (const line of traceback.split("\n")) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", line || " "), width);
		}
	}

	// Backgroundless line, indented one space to align under the fixed top line.
	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			// Truncate the composed line so a narrow pane can't exceed width (fatal in the renderer).
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addBlank(lines: string[], _width: number): void {
		lines.push("");
	}

	// No-background line, indented one space to align with the summary line above.
	private addPlain(lines: string[], text: string): void {
		lines.push(` ${text}`);
	}
}
