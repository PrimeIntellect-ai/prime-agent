import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { highlightCode, theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}

type ThemeBg = Parameters<typeof theme.bg>[0];
type ThemeColor = Parameters<typeof theme.fg>[0];

// Rewrite full/background resets to foreground-only so a row's background block
// survives the syntax-highlighted content.
const BG_CLEARING_RESET = /\x1b\[(?:0|49)m/g;

function keepBackground(highlighted: string): string {
	return highlighted.replace(BG_CLEARING_RESET, "\x1b[39m");
}

function highlightContent(content: string, language: string | undefined): string {
	if (!content) {
		return "";
	}
	if (language) {
		return keepBackground(highlightCode(content, language)[0] ?? content);
	}
	return theme.fg("mdCodeBlock", content);
}

interface DiffLineSpec {
	bg: ThemeBg;
	gutter: string;
	gutterFg: ThemeColor;
	content: string;
	language: string | undefined;
	width: number;
	/** Flat content color instead of syntax highlighting (256-color fallback). */
	contentFg?: ThemeColor;
}

function padToWidth(inner: string, width: number): string {
	if (visibleWidth(inner) > width) {
		inner = truncateToWidth(inner, width, "");
	}
	// Pad after truncating too: a 2-cell character straddling the cutoff leaves
	// the result a cell short.
	const pad = width - visibleWidth(inner);
	return pad > 0 ? inner + " ".repeat(pad) : inner;
}

// One diff line as one-or-more full-width background rows. Content wider than the
// row wraps onto continuation rows with a blank gutter, so nothing is truncated.
function buildRichDiffLine(spec: DiffLineSpec): string[] {
	const renderedContent = spec.contentFg
		? theme.fg(spec.contentFg, spec.content)
		: highlightContent(spec.content, spec.language);

	const gutterWidth = visibleWidth(spec.gutter);
	const contentWidth = Math.max(1, spec.width - gutterWidth);
	const contentRows = wrapTextWithAnsi(renderedContent, contentWidth);
	if (contentRows.length === 0) {
		contentRows.push("");
	}

	const styledGutter = theme.fg(spec.gutterFg, spec.gutter);
	const styledCont = " ".repeat(gutterWidth);
	return contentRows.map((row, index) => {
		const gutter = index === 0 ? styledGutter : styledCont;
		return theme.bg(spec.bg, padToWidth(`${gutter}${row}\x1b[39m`, spec.width));
	});
}

export interface RichDiffOptions {
	/** Language id for syntax highlighting the diff content (e.g. "typescript"). */
	language?: string;
}

/** A dim `⋮` row separating non-adjacent hunks of one file's diff. */
export function renderDiffSeparator(contentWidth: number): string {
	const width = Math.max(1, contentWidth);
	const marker = theme.fg("toolDiffContext", " ⋮");
	const pad = Math.max(0, width - visibleWidth(marker));
	return theme.bg("toolPanelBg", marker + " ".repeat(pad));
}

/** Render a unified diff as full-width rows: green/red blocks, syntax-highlighted. */
export function renderRichDiff(diffText: string, contentWidth: number, options: RichDiffOptions = {}): string[] {
	const width = Math.max(1, contentWidth);
	const language = options.language;
	// 256-color can't render subtle tints (a dark block quantizes to black), so
	// color the text instead of the background there.
	const useBlocks = theme.colorMode === "truecolor";
	const rows: string[] = [];

	for (const rawLine of diffText.split("\n")) {
		const parsed = parseDiffLine(rawLine);
		if (!parsed) {
			rows.push(
				...buildRichDiffLine({
					bg: "toolPanelBg",
					gutterFg: "toolDiffContext",
					// Leading space keeps the text off the edge while the bg still reaches it.
					gutter: " ",
					content: replaceTabs(rawLine),
					language,
					width,
				}),
			);
			continue;
		}
		const { prefix, lineNum, content } = parsed;
		const gutter = ` ${lineNum} ${prefix === " " ? " " : prefix} `;
		const text = replaceTabs(content);
		if (prefix === "+") {
			rows.push(
				...buildRichDiffLine({
					bg: useBlocks ? "toolDiffAddedBg" : "toolPanelBg",
					gutterFg: "toolDiffAdded",
					gutter,
					content: text,
					language,
					width,
					contentFg: useBlocks ? undefined : "toolDiffAdded",
				}),
			);
		} else if (prefix === "-") {
			rows.push(
				...buildRichDiffLine({
					bg: useBlocks ? "toolDiffRemovedBg" : "toolPanelBg",
					gutterFg: "toolDiffRemoved",
					gutter,
					content: text,
					language,
					width,
					contentFg: useBlocks ? undefined : "toolDiffRemoved",
				}),
			);
		} else {
			rows.push(
				...buildRichDiffLine({
					bg: "toolPanelBg",
					gutterFg: "toolDiffContext",
					gutter,
					content: text,
					language,
					width,
				}),
			);
		}
	}

	return rows;
}
