import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { latexToUnicode } from "../latex.js";
import {
	extractTableCellSelectionRegions,
	markTableCell,
	markTableEnd,
	markTableStart,
	type TableCellSelectionRegion,
} from "../selection-metadata.js";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, stripAnsi, visibleWidth, wrapTextWithAnsi } from "../utils.js";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface MathToken {
	type: "blockMath" | "inlineMath";
	raw: string;
	/** Raw LaTeX source without the delimiters. */
	text: string;
}

// Math must tokenize before marked's escape/emphasis handling, or \[ collapses
// to [ and underscores inside formulas become italics. Unterminated delimiters
// never match, so partially streamed math stays plain text until the closing
// delimiter arrives. Leading indentation is consumed because models often
// indent display math, which would otherwise lex as an indented code block.
const BLOCK_MATH_REGEX = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

function minIndex(a: number, b: number): number | undefined {
	if (a === -1) {
		return b === -1 ? undefined : b;
	}
	return b === -1 ? a : Math.min(a, b);
}

const blockMathExtension: TokenizerExtension = {
	name: "blockMath",
	level: "block",
	// start() runs on every paragraph continuation; scanning only the current
	// paragraph keeps it cheap, and later math is caught at its block boundary.
	start: (src: string) => {
		const paragraphEnd = src.indexOf("\n\n");
		const window = paragraphEnd === -1 ? src : src.slice(0, paragraphEnd);
		return minIndex(window.indexOf("$$"), window.indexOf("\\["));
	},
	tokenizer(src: string): Tokens.Generic | undefined {
		const first = src.charCodeAt(0);
		if (first !== 0x24 /* $ */ && first !== 0x5c /* \ */ && first !== 0x20 /* space */ && first !== 0x09 /* tab */) {
			return undefined;
		}
		const match = BLOCK_MATH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}
		const token: MathToken = { type: "blockMath", raw: match[0], text: (match[1] ?? match[2]).trim() };
		return token;
	},
};

// $...$ uses the pandoc/GitHub rules to avoid matching prose dollar amounts:
// the opening $ must be followed by a non-space, the closing $ preceded by a
// non-space and not followed by a digit ("between $5 and $10" never matches).
const INLINE_MATH_PATTERNS = [
	/^\$\$([\s\S]+?)\$\$/, // display math used mid-paragraph
	/^\\\[([\s\S]+?)\\\]/,
	/^\\\(([\s\S]+?)\\\)/,
	/^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/,
];

const inlineMathExtension: TokenizerExtension = {
	name: "inlineMath",
	level: "inline",
	// Only "$" needs a start() hint: backslashes already terminate text runs,
	// but the text tokenizer would swallow a bare "$" without one.
	start: (src: string) => {
		const index = src.indexOf("$");
		return index === -1 ? undefined : index;
	},
	tokenizer(src: string): Tokens.Generic | undefined {
		const first = src.charCodeAt(0);
		if (first !== 0x24 /* $ */ && first !== 0x5c /* \ */) {
			return undefined;
		}
		for (const pattern of INLINE_MATH_PATTERNS) {
			const match = pattern.exec(src);
			if (match) {
				const token: MathToken = { type: "inlineMath", raw: match[0], text: match[1].trim() };
				return token;
			}
		}
		return undefined;
	},
};

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// Registered extensions measurably slow marked's lexing even when they never
// match, so math-free text (the common case) uses a parser without them.
const mathMarkdownParser = new Marked();
mathMarkdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
mathMarkdownParser.use({ extensions: [blockMathExtension, inlineMathExtension] });

function pickMarkdownParser(text: string): Marked {
	return text.includes("$") || text.includes("\\(") || text.includes("\\[") ? mathMarkdownParser : markdownParser;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	codeBlockIndent?: string;
	math?: (text: string) => string;
	mathBlock?: (text: string) => string;
}

export interface MarkdownOptions {
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private selectionRegions: TableCellSelectionRegion[] = [];
	private tableIdentities: object[] = [];
	// Per-block render cache so streaming appends only re-render the changing
	// final block instead of the whole document. Keyed by width/type/nextType/raw;
	// rebuilt each render so it stays bounded to the current document's blocks.
	private blockCache = new Map<string, string[]>();

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		// Only the whole-result cache is dropped; the per-block cache stays so a
		// streaming append re-renders just the blocks that actually changed.
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectionRegions = [];
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectionRegions = [];
		// External invalidation (e.g. theme change) affects rendered output, so
		// the per-block cache must go too.
		this.blockCache = new Map();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		if (!text || text.trim() === "") {
			const result: string[] = [];
			this.selectionRegions = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const normalizedText = text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const tokens = pickMarkdownParser(normalizedText).lexer(normalizedText);

		// Reference-link definitions make a block's rendering depend on other
		// blocks, so per-block caching is disabled when any are present.
		const cacheable = Object.keys(tokens.links).length === 0;

		// Render, wrap, and pad per top-level block so unchanged blocks can be
		// served from the cache. The final block is never cached: while streaming,
		// appended text can reinterpret it (unterminated fences, growing lists);
		// once a block is no longer last, its raw text is final.
		const nextCache = new Map<string, string[]>();
		const contentLines: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextTokenType = tokens[i + 1]?.type;
			const useCache = cacheable && i < tokens.length - 1;
			const key = useCache ? `${width}|${token.type}|${nextTokenType ?? ""}|${token.raw}` : "";
			let blockLines = useCache ? (nextCache.get(key) ?? this.blockCache.get(key)) : undefined;
			if (!blockLines) {
				blockLines = this.renderBlock(token, nextTokenType, width, contentWidth);
			}
			if (useCache) {
				nextCache.set(key, blockLines);
			}
			contentLines.push(...blockLines);
		}
		this.blockCache = nextCache;

		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		const markedResult = [...emptyLines, ...contentLines, ...emptyLines];
		const { lines: result, regions } = extractTableCellSelectionRegions(markedResult, (index) => {
			this.tableIdentities[index] ??= {};
			return this.tableIdentities[index];
		});
		this.selectionRegions = regions;

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.selectionRegions;
	}

	/** Render one top-level block: token lines, wrapping, margins, background. */
	private renderBlock(token: Token, nextTokenType: string | undefined, width: number, contentWidth: number): string[] {
		const tokenLines = this.renderToken(token, contentWidth, nextTokenType);

		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const blockLines: string[] = [];

		for (const line of tokenLines) {
			if (isImageLine(line)) {
				blockLines.push(line);
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(line, contentWidth)) {
				const lineWithMargins = leftMargin + wrapped + rightMargin;
				if (bgFn) {
					blockLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
				} else {
					const visibleLen = visibleWidth(lineWithMargins);
					const paddingNeeded = Math.max(0, width - visibleLen);
					blockLines.push(lineWithMargins + " ".repeat(paddingNeeded));
				}
			}
		}

		return blockLines;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				lines.push(...this.renderCodeBlock(token));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "blockMath": {
				lines.push(...this.renderMathBlock(token as unknown as MathToken));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after math blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as any, 0, styleContext);
				lines.push(...listLines);
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as any, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				lines.push("");
				break;

			default:
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "inlineMath": {
					const mathStyle = this.theme.math ?? this.theme.code;
					const converted = latexToUnicode((token as unknown as MathToken).text).replace(/\s*\n\s*/g, " ");
					result += mathStyle(converted) + stylePrefix;
					break;
				}

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(
		token: Token & { items: any[]; ordered: boolean; start?: number },
		depth: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		const startNumber = token.start ?? 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

			const itemLines = this.renderListItem(item.tokens || [], depth, styleContext);

			if (itemLines.length > 0) {
				// A nested list will start with indent (spaces) followed by cyan bullet
				const firstLine = itemLines[0];
				const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine); // starts with spaces + cyan + bullet char

				if (isNestedList) {
					lines.push(firstLine);
				} else {
					lines.push(indent + this.theme.listBullet(bullet) + firstLine);
				}

				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j];
					const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line); // starts with spaces + cyan + bullet char

					if (isNestedListLine) {
						lines.push(line);
					} else {
						lines.push(`${indent}  ${line}`);
					}
				}
			} else {
				lines.push(indent + this.theme.listBullet(bullet));
			}
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists
	 * Returns lines WITHOUT the parent indent (renderList will add it)
	 */
	private renderListItem(tokens: Token[], parentDepth: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// Nested list - render with one additional indent level
				// These lines will have their own indent, so we just add them as-is
				const nestedLines = this.renderList(token as any, parentDepth + 1, styleContext);
				lines.push(...nestedLines);
			} else if (token.type === "text") {
				// Text content (may have inline tokens)
				const text =
					token.tokens && token.tokens.length > 0
						? this.renderInlineTokens(token.tokens, styleContext)
						: token.text || "";
				lines.push(text);
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const text = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(text);
			} else if (token.type === "code") {
				// Code block in list item
				lines.push(...this.renderCodeBlock(token));
			} else if (token.type === "blockMath") {
				// Display math in list item
				lines.push(...this.renderMathBlock(token as unknown as MathToken));
			} else {
				// Other token types - try to render as inline
				const text = this.renderInlineTokens([token], styleContext);
				if (text) {
					lines.push(text);
				}
			}
		}

		return lines;
	}

	private renderCodeBlock(token: Token): string[] {
		if (!("text" in token) || typeof token.text !== "string") {
			return [];
		}

		const indent = this.theme.codeBlockIndent ?? "  ";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const renderedCodeLines = this.theme.highlightCode
			? this.theme.highlightCode(token.text, lang)
			: token.text.split("\n").map((codeLine) => this.theme.codeBlock(codeLine));
		const codeLines = renderedCodeLines.length > 0 ? renderedCodeLines : [this.theme.codeBlock("")];

		return codeLines.map((codeLine) => `${indent}${codeLine}`);
	}

	/** Render display math: converted to Unicode, indented like a code block. */
	private renderMathBlock(token: MathToken): string[] {
		const indent = this.theme.codeBlockIndent ?? "  ";
		const style = this.theme.mathBlock ?? this.theme.codeBlock;
		const mathLines = latexToUnicode(token.text)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return mathLines.map((line) => indent + style(line));
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Token & { header: any[]; rows: any[][]; raw?: string },
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(markTableStart(`┌─${topBorderCells.join("─┬─")}─┐`));

		const headerCells = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return { lines: this.wrapCellText(text, columnWidths[i]), content: stripAnsi(text) };
		});
		const headerLineCount = Math.max(...headerCells.map((cell) => cell.lines.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCells.map((cell, colIdx) => {
				const text = cell.lines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return markTableCell(this.theme.bold(padded), 0, colIdx, lineIdx, cell.content);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCells = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return { lines: this.wrapCellText(text, columnWidths[i]), content: stripAnsi(text) };
			});
			const rowLineCount = Math.max(...rowCells.map((cell) => cell.lines.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCells.map((cell, colIdx) => {
					const text = cell.lines[lineIdx] || "";
					const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
					return markTableCell(padded, rowIndex + 1, colIdx, lineIdx, cell.content);
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(markTableEnd(`└─${bottomBorderCells.join("─┴─")}─┘`));

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
