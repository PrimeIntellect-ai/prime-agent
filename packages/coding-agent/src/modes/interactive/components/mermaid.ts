import { type MermaidArt, render, type Span } from "grok-mermaid";
import { Marked, type Token } from "marked";
import type { MermaidRenderingMode } from "../../../core/settings-manager.js";
import type { Theme } from "../theme/theme.js";

const markdownParser = new Marked();

interface MermaidTransformOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

/** Rewrites assistant Markdown before pi-tui renders it, with the exact width available for content. */
export type MermaidMarkdownTransform = (markdown: string, availableWidth: number, isStreaming: boolean) => string;

function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	// Inline code spans preserve the diagram row's spacing; a blank row becomes NBSP to keep visible height.
	const content = line || "\u00a0";
	// CommonMark: the delimiter must beat the longest backtick run, and padding keeps edge backticks as content.
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/** Create a transform that replaces top-level Mermaid code blocks with Unicode terminal diagrams. */
export function createMermaidMarkdownTransform(options: MermaidTransformOptions): MermaidMarkdownTransform {
	return (markdown, availableWidth, isStreaming) => {
		const mode = options.getMode();
		if (mode === "off" || (isStreaming && mode !== "streaming")) {
			return markdown;
		}

		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				if (!art || art.width > availableWidth) return token.raw;
				if (!isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				// Markdown hard breaks keep every diagram row on its own line.
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	};
}
