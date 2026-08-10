import { type MermaidArt, render as renderMermaid, type Span } from "grok-mermaid";

/**
 * Mermaid rendering modes.
 * - "off" — no transformation; raw source shown
 * - "streaming" — always render Mermaid blocks (best-effort during streaming)
 */
export type MermaidRenderingMode = "off" | "streaming";

export interface MermaidTransformerTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme: MermaidTransformerTheme;
}

/**
 * Wrap text in a markdown inline code span, preserving whitespace.
 *
 * If the content contains backticks, the fence is extended to be longer than
 * the longest backtick run. A leading/trailing backtick is padded with a space
 * so the span delimiter stays unambiguous.
 */
function wrapInCodeSpan(content: string): string {
	const maxBacktickRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(1, maxBacktickRun + 1));

	// Pad with spaces if content starts or ends with a backtick to prevent
	// ambiguity with the fence delimiter.
	let text = content;
	if (text.startsWith("`")) {
		text = ` ${text}`;
	}
	if (text.endsWith("`")) {
		text = `${text} `;
	}

	return `${fence}${text}${fence}`;
}

/**
 * Map a styled span to its theme-styled text.
 *
 * border → dim, text → default (no explicit color), edge → accent,
 * edgeLabel → accent, title → dim + bold, none → no styling.
 */
function styleSpan(span: Span, theme: MermaidTransformerOptions["theme"]): string {
	switch (span.cls) {
		case "border":
			return theme.fg("dim", span.text);
		case "edge":
		case "edgeLabel":
			return theme.fg("accent", span.text);
		case "title":
			return theme.bold(theme.fg("dim", span.text));
		default:
			return span.text;
	}
}

/**
 * Convert rendered MermaidArt to markdown text.
 *
 * Each diagram row is wrapped in a markdown inline code span to preserve
 * leading/trailing spaces and box-drawing alignment. Blank rows use a
 * non-breaking space (\u00a0) to ensure visible height. Rows are joined
 * with markdown hard breaks (two trailing spaces + newline).
 */
function artToMarkdown(art: MermaidArt, theme: MermaidTransformerOptions["theme"]): string {
	const lines: string[] = [];
	for (const row of art.styled) {
		const styledText = row.map((span) => styleSpan(span, theme)).join("");
		const content = styledText.trimEnd() === "" ? "\u00a0" : styledText;
		lines.push(wrapInCodeSpan(content));
	}
	return lines.join("  \n");
}

/**
 * Regex matching a fenced mermaid code block.
 *
 * Captures: [1] = opening fence + info string, [2] = body, [3] = closing fence.
 */
const MERMAID_FENCE_REGEX = /(^|\n)(`{3,})mermaid[ \t]*\n([\s\S]*?)(`{3,})/g;

/**
 * Create a Markdown transform callback that renders Mermaid code blocks as
 * Unicode box-drawing art.
 *
 * When mode is "off" or render fails, the original source block is left
 * untouched (fallback).
 */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions) {
	return (text: string, availableWidth: number): string => {
		if (options.getMode() === "off") {
			return text;
		}

		return text.replace(MERMAID_FENCE_REGEX, (match, prefix: string, _openFence: string, body: string) => {
			const src = body.trim();
			const art = renderMermaid(src);
			if (!art || art.width > availableWidth) {
				return match; // Fallback: leave original block untouched
			}
			return `${prefix}${artToMarkdown(art, options.theme)}`;
		});
	};
}
