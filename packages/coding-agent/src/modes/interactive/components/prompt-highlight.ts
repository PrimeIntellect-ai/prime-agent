import { visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";

const ARG_TOKEN_PATTERN = /@"[^"\n]*"|@[^\s\x1b]+|--[A-Za-z0-9][A-Za-z0-9-]*/g;
/** Also matches a bare `--` end-of-options separator; only used in recognized slash-command text. */
const ARG_TOKEN_PATTERN_WITH_SEPARATOR = /@"[^"\n]*"|@[^\s\x1b]+|--[A-Za-z0-9][A-Za-z0-9-]*|--(?=\s|$)/g;
const FG_SGR_PATTERN = /\x1b\[(?:0|39|3[0-7]|9[0-7]|38;[0-9;]+)m/g;
/** Escape sequences the editor splices into displayed text (cursor highlight, IME marker). */
const CURSOR_ESCAPE_PATTERN = /\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g;

const MASK_BASE = "\uE000";
const MASK_EXTRA_WIDTH = "\uFF9E";
const MASK_ZERO_WIDTH = "\u2060";
const MASK_PATTERN = /\u2060|\uE000\uFF9E*/gu;
/** Literal mask-range characters would alias generated placeholders; messages containing them skip masking. */
const MASK_LITERAL_PATTERN = /[\u2060\uE000\uFF9E]/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface ArgTokenSpan {
	start: number;
	end: number;
	color: ThemeColor;
}

function tokenColor(token: string): ThemeColor {
	return token.startsWith("@") ? "success" : "mdLink";
}

function hasTokenBoundary(text: string, index: number): boolean {
	return index === 0 || /\s/.test(text.charAt(index - 1));
}

/** Finds @path references and --flags in plain (unrendered) text; includeBareSeparator also matches a bare `--`. */
function findArgTokens(text: string, fromIndex = 0, includeBareSeparator = false): ArgTokenSpan[] {
	const spans: ArgTokenSpan[] = [];
	const pattern = includeBareSeparator ? ARG_TOKEN_PATTERN_WITH_SEPARATOR : ARG_TOKEN_PATTERN;
	for (const match of text.matchAll(pattern)) {
		if (match.index < fromIndex || !hasTokenBoundary(text, match.index)) continue;
		spans.push({ start: match.index, end: match.index + match[0].length, color: tokenColor(match[0]) });
	}
	return spans;
}

/** Foreground SGR active at index; theme.fg() closes with \x1b[39m, so it must be re-emitted. */
function activeFgBefore(line: string, index: number): string {
	let active = "";
	for (const sgr of line.slice(0, index).matchAll(FG_SGR_PATTERN)) {
		active = sgr[0] === "\x1b[0m" ? "" : sgr[0];
	}
	return active;
}

function maskGrapheme(grapheme: string): string {
	const width = visibleWidth(grapheme);
	return width === 0 ? MASK_ZERO_WIDTH : MASK_BASE + MASK_EXTRA_WIDTH.repeat(width - 1);
}

/** Styles @path references and --flags in a plain (unrendered) string. */
export function styleArgumentTokens(
	text: string,
	styleOther: (segment: string) => string = (segment) => segment,
	includeBareSeparator = false,
): string {
	let result = "";
	let offset = 0;
	for (const token of findArgTokens(text, 0, includeBareSeparator)) {
		result += styleOther(text.slice(offset, token.start)) + theme.fg(token.color, text.slice(token.start, token.end));
		offset = token.end;
	}
	return result + styleOther(text.slice(offset));
}

/**
 * Replaces the leading slash command (optional) and every @path/--flag token
 * in a prompt with same-width placeholders before markdown layout, so the
 * themed text can be spliced back into rendered lines after wrapping.
 */
export class PromptTokenMask {
	readonly text: string;
	private readonly graphemes: { segment: string; color: ThemeColor }[] = [];
	private offset = 0;

	constructor(source: string, commandEnd = 0) {
		if (MASK_LITERAL_PATTERN.test(source)) {
			this.text = source;
			return;
		}
		const tokens: ArgTokenSpan[] = [];
		if (commandEnd > 0) {
			tokens.push({ start: 0, end: commandEnd, color: "accent" });
		}
		tokens.push(...findArgTokens(source, commandEnd, commandEnd > 0));

		let text = "";
		let cursor = 0;
		for (const token of tokens) {
			text += source.slice(cursor, token.start);
			for (const { segment } of graphemeSegmenter.segment(source.slice(token.start, token.end))) {
				this.graphemes.push({ segment, color: token.color });
				text += maskGrapheme(segment);
			}
			cursor = token.end;
		}
		this.text = text + source.slice(cursor);
	}

	/** Placeholders are consumed in order across lines; rewind before each render pass. */
	reset(): void {
		this.offset = 0;
	}

	restoreLine(line: string): string {
		let result = "";
		let copied = 0;
		let run: { start: number; end: number; color: ThemeColor; text: string } | undefined;
		const flush = () => {
			if (!run) return;
			result += line.slice(copied, run.start) + theme.fg(run.color, run.text) + activeFgBefore(line, run.start);
			copied = run.end;
			run = undefined;
		};
		for (const match of line.matchAll(MASK_PATTERN)) {
			const grapheme = this.graphemes[this.offset];
			if (!grapheme) break; // literal mask-range character from the source; leave it untouched
			this.offset++;
			if (run && run.color === grapheme.color && run.end === match.index) {
				run.text += grapheme.segment;
				run.end += match[0].length;
			} else {
				flush();
				run = {
					start: match.index,
					end: match.index + match[0].length,
					color: grapheme.color,
					text: grapheme.segment,
				};
			}
		}
		flush();
		return result + line.slice(copied);
	}
}

/**
 * Styles @path references and --flags in laid-out editor lines. Token spans
 * are computed on the logical source lines before wrapping, so wrapped
 * fragments, quoted paths with spaces, and line-leading tokens are all
 * colored exactly. Call reset() with the current lines before each render
 * pass; each chunk carries its exact source coordinates.
 */
export class ArgTokenHighlighter {
	private spans: ArgTokenSpan[][] = [];

	reset(lines: readonly string[], includeBareSeparator = false): void {
		this.spans = lines.map((line) => findArgTokens(line, 0, includeBareSeparator));
	}

	/**
	 * Styles the tokens covered by one laid-out chunk. displayText is the
	 * chunk with any cursor escape sequences already spliced in; chunkText is
	 * the raw chunk text starting at sourceStart within source line sourceLine.
	 */
	highlightLine(displayText: string, chunkText: string, sourceLine: number, sourceStart: number): string {
		const rangeEnd = sourceStart + chunkText.length;
		const spans: ArgTokenSpan[] = [];
		for (const span of this.spans[sourceLine] ?? []) {
			if (span.end <= sourceStart) continue;
			if (span.start >= rangeEnd) break;
			spans.push({
				start: Math.max(span.start, sourceStart) - sourceStart,
				end: Math.min(span.end, rangeEnd) - sourceStart,
				color: span.color,
			});
		}
		if (spans.length === 0) return displayText;

		// Map visible code-unit offsets to displayText offsets, skipping the
		// escape sequences the editor spliced in for the cursor.
		const visibleStart: number[] = [];
		let pos = 0;
		for (const seq of displayText.matchAll(CURSOR_ESCAPE_PATTERN)) {
			for (; pos < seq.index; pos++) visibleStart.push(pos);
			pos = seq.index + seq[0].length;
		}
		for (; pos < displayText.length; pos++) visibleStart.push(pos);

		let result = "";
		let copied = 0;
		for (const span of spans) {
			const start = visibleStart[span.start] ?? displayText.length;
			const end = (visibleStart[span.end - 1] ?? displayText.length - 1) + 1;
			result += displayText.slice(copied, start) + theme.fg(span.color, displayText.slice(start, end));
			copied = end;
		}
		return result + displayText.slice(copied);
	}
}
