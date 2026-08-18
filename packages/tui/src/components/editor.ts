import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.js";
import type { EditorPasteSnapshot } from "../editor-component.js";
import { getKeybindings } from "../keybindings.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import { KillRing } from "../kill-ring.js";
import { getSlashCommandContext, type SlashCommandContext } from "../slash-command-context.js";
import { type Component, CURSOR_MARKER, type Focusable, type OverlayHandle, type TUI } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, truncateToWidth, visibleWidth } from "../utils.js";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.js";

const baseSegmenter = getSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/**
 * Regex matching image markers like `[image #1]`. Kept in sync with the marker
 * format produced by the coding agent's image-markers helper; the tui package
 * can't depend on the coding agent, so the pattern is duplicated here.
 */
const IMAGE_MARKER_REGEX = /\[image #(\d+)\]/g;

/** Non-global version for single-segment testing. */
const IMAGE_MARKER_SINGLE = /^\[image #(\d+)\]$/;

/** Check if a segment is an atomic marker (paste or image) merged by segmentWithMarkers. */
function isAtomicMarker(segment: string): boolean {
	return segment.length >= 10 && (PASTE_MARKER_SINGLE.test(segment) || IMAGE_MARKER_SINGLE.test(segment));
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste or image markers into single atomic segments. This makes cursor
 * movement, deletion, word-wrap, etc. treat the markers as single units.
 *
 * Paste markers are only merged when their numeric ID exists in `validPasteIds`
 * (so a stale `[paste #N]` typed by the user isn't treated as atomic). Image
 * markers are self-contained and always merged.
 */
function segmentWithMarkers(text: string, validPasteIds: Set<number>): Iterable<Intl.SegmentData> {
	const hasPaste = validPasteIds.size > 0 && text.includes("[paste #");
	const hasImage = text.includes("[image #");

	if (!hasPaste && !hasImage) {
		return baseSegmenter.segment(text);
	}

	const markers: Array<{ start: number; end: number }> = [];
	if (hasPaste) {
		for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
			const id = Number.parseInt(m[1]!, 10);
			if (!validPasteIds.has(id)) continue;
			markers.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	if (hasImage) {
		for (const m of text.matchAll(IMAGE_MARKER_REGEX)) {
			markers.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}
	markers.sort((a, b) => a.start - b.start);

	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...baseSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isAtomicMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && (isAtomicMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface EditorUndoSnapshot extends EditorState {
	pastes: Map<number, string>;
	pasteCounter: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	backgroundColor?: (str: string) => string;
	autocompleteBackgroundColor?: (str: string) => string;
	selectList: SelectListTheme;
	commandColor?: (str: string) => string;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
	promptPrefix?: string;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	showItemMetadata: true,
	showDirectionalScrollInfo: true,
	showSelectedDescription: true,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
let autocompleteAnchorId = 0;

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;
	private promptPrefix: string = "";

	private lastWidth: number = 80;

	private scrollOffset: number = 0;

	public borderColor: (str: string) => string;
	public backgroundColor: ((str: string) => string) | undefined;
	public autocompleteBackgroundColor: ((str: string) => string) | undefined;
	public commandColor: ((str: string) => string) | undefined;

	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteKind?: AutocompleteSuggestions["kind"];
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;
	private autocompleteOverlay?: OverlayHandle;
	private readonly autocompleteAnchorMarker = `\x1b_pi:autocomplete:${++autocompleteAnchorId}\x07`;
	private readonly autocompleteOverlayComponent: Component = {
		render: (width) => this.renderAutocompleteOverlay(width),
		invalidate: () => this.autocompleteList?.invalidate(),
	};

	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	private jumpMode: "forward" | "backward" | null = null;

	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	private snappedFromCursorCol: number | null = null;

	private undoStack = new UndoStack<EditorUndoSnapshot>((snapshot) => ({
		lines: [...snapshot.lines],
		cursorLine: snapshot.cursorLine,
		cursorCol: snapshot.cursorCol,
		pastes: new Map(snapshot.pastes),
		pasteCounter: snapshot.pasteCounter,
	}));

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		this.backgroundColor = theme.backgroundColor;
		this.autocompleteBackgroundColor = theme.autocompleteBackgroundColor;
		this.commandColor = theme.commandColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		this.promptPrefix = options.promptPrefix ?? "";
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	private segment(text: string): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	protected getPromptPrefix(): string {
		return this.promptPrefix;
	}

	protected formatPromptPrefix(prefix: string): string {
		return prefix;
	}

	protected getHiddenTextPrefixLength(_lineIndex: number, _line: string): number {
		return 0;
	}

	protected styleDisplayText(
		displayText: string,
		_layoutLineIndex: number,
		_lineText: string,
		_cursorCol: number | undefined,
	): string {
		return displayText;
	}

	private getLineHiddenTextPrefixLength(lineIndex: number, line: string): number {
		const hiddenLength = this.getHiddenTextPrefixLength(lineIndex, line);
		if (!Number.isFinite(hiddenLength)) {
			return 0;
		}
		return Math.max(0, Math.min(line.length, Math.floor(hiddenLength)));
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	/** Prompt history entries (most recent first). */
	getHistory(): readonly string[] {
		return this.history;
	}

	/** Clear prompt history (e.g. when switching to a different session). */
	clearHistory(): void {
		this.history = [];
		this.historyIndex = -1;
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	protected isHistoryNavigationActive(): boolean {
		return this.historyIndex > -1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			this.setTextInternal("");
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "");
		}
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
		this.scrollOffset = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {}

	private getRenderMetrics(width: number): {
		useBackgroundSurface: boolean;
		paddingX: number;
		promptPrefixText: string;
		promptPrefixWidth: number;
		inputWidth: number;
	} {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const useBackgroundSurface = this.backgroundColor !== undefined;
		const configuredPaddingX = Math.min(this.paddingX, maxPadding);
		const paddingX = useBackgroundSurface
			? Math.min(Math.max(configuredPaddingX, 2), maxPadding)
			: configuredPaddingX;
		const contentWidth = Math.max(1, width - paddingX * 2);
		const promptPrefixText = this.getPromptPrefix();
		const promptPrefixWidth = Math.min(visibleWidth(promptPrefixText), Math.max(0, contentWidth - 1));

		return {
			useBackgroundSurface,
			paddingX,
			promptPrefixText,
			promptPrefixWidth,
			inputWidth: Math.max(1, contentWidth - promptPrefixWidth),
		};
	}

	protected getAutocompleteAnchorMarker(): string {
		return this.autocompleteOverlay && this.focused ? this.autocompleteAnchorMarker : "";
	}

	render(width: number): string[] {
		const { useBackgroundSurface, paddingX, promptPrefixText, promptPrefixWidth, inputWidth } =
			this.getRenderMetrics(width);
		const promptPrefix =
			promptPrefixWidth > 0 ? this.formatPromptPrefix(truncateToWidth(promptPrefixText, promptPrefixWidth, "")) : "";

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, inputWidth - (paddingX ? 0 : 1));

		this.lastWidth = layoutWidth;

		const horizontal = this.borderColor("─");

		const layoutLines = this.layoutText(layoutWidth);

		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		const promptPrefixInset = promptPrefixWidth > 0 ? Math.min(1, paddingX) : 0;
		const promptLeadingPadding = " ".repeat(promptPrefixInset);
		const promptTrailingPadding = " ".repeat(Math.max(0, paddingX - promptPrefixInset));
		const cursorReset = useBackgroundSurface ? "\x1b[27m" : "\x1b[0m";
		const renderSurfaceLine = (line: string): string => {
			const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
			return this.backgroundColor ? this.backgroundColor(padded) : padded;
		};

		if (!useBackgroundSurface) {
			if (this.scrollOffset > 0) {
				const indicator = `─── ↑ ${this.scrollOffset} more `;
				const remaining = width - visibleWidth(indicator);
				if (remaining >= 0) {
					result.push(this.borderColor(indicator + "─".repeat(remaining)));
				} else {
					result.push(this.borderColor(truncateToWidth(indicator, width)));
				}
			} else {
				result.push(horizontal.repeat(width));
			}
		} else {
			const line = this.scrollOffset > 0 ? this.borderColor(` ↑ ${this.scrollOffset} more`) : "";
			result.push(renderSurfaceLine(truncateToWidth(line, width)));
		}
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.autocompleteState;

		for (let visibleLineIndex = 0; visibleLineIndex < visibleLines.length; visibleLineIndex++) {
			const layoutLine = visibleLines[visibleLineIndex]!;
			const absoluteLineIndex = this.scrollOffset + visibleLineIndex;
			const linePromptPrefix = absoluteLineIndex === 0 ? promptPrefix : " ".repeat(promptPrefixWidth);
			let displayText = layoutLine.text;
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					const afterGraphemes = [...this.segment(after)];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}${cursorReset}`;
					displayText = before + marker + cursor + restAfter;
				} else {
					const cursor = `\x1b[7m ${cursorReset}`;
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					if (lineVisibleWidth > inputWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			displayText = this.styleDisplayText(
				displayText,
				absoluteLineIndex,
				layoutLine.text,
				layoutLine.hasCursor ? layoutLine.cursorPos : undefined,
			);

			const padding = " ".repeat(Math.max(0, inputWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			const contentLine = `${promptLeadingPadding}${linePromptPrefix}${promptTrailingPadding}${displayText}${padding}${lineRightPadding}`;
			const anchorMarker = layoutLine.hasCursor ? this.getAutocompleteAnchorMarker() : "";
			result.push(anchorMarker + (useBackgroundSurface ? renderSurfaceLine(contentLine) : contentLine));
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		if (!useBackgroundSurface) {
			if (linesBelow > 0) {
				const indicator = `─── ↓ ${linesBelow} more `;
				const remaining = width - visibleWidth(indicator);
				result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
			} else {
				result.push(horizontal.repeat(width));
			}
		} else {
			const line = linesBelow > 0 ? this.borderColor(` ↓ ${linesBelow} more`) : "";
			result.push(renderSurfaceLine(truncateToWidth(line, width)));
		}

		return result;
	}

	private renderAutocompleteOverlay(width: number): string[] {
		if (!(this.autocompleteState && this.autocompleteList)) return [];

		const { useBackgroundSurface, paddingX, promptPrefixWidth, inputWidth } = this.getRenderMetrics(width);
		const leftPadding = " ".repeat(paddingX + promptPrefixWidth);
		const rightPadding = " ".repeat(paddingX);
		const backgroundColor =
			this.autocompleteBackgroundColor ?? (useBackgroundSurface ? this.backgroundColor : undefined);

		return ["", ...this.autocompleteList.render(inputWidth), ""].map((line) => {
			const linePadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(line)));
			const contentLine = `${leftPadding}${line}${linePadding}${rightPadding}`;
			return backgroundColor ? backgroundColor(contentLine) : contentLine;
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.jumpMode !== null) {
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			this.jumpMode = null;
		}

		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.cancelAutocomplete();
					if (this.onChange) this.onChange(this.getText());
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					const slashContext = this.getCurrentSlashCommandContext();
					const isSlashCommandCompletion =
						this.autocompleteKind === "slash-command" ||
						(this.autocompleteKind === undefined &&
							this.autocompleteState === "regular" &&
							this.autocompletePrefix.startsWith("/"));
					const shouldSubmitSlashCommand =
						isSlashCommandCompletion && slashContext?.kind === "name" && slashContext.isAtPromptStart;
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);

					if (isSlashCommandCompletion) {
						this.cancelAutocomplete();
						if (!shouldSubmitSlashCommand || selected.takesArgument) {
							if (this.onChange) this.onChange(this.getText());
							return;
						}
					} else {
						this.cancelAutocomplete();
						if (this.onChange) this.onChange(this.getText());
						return;
					}
				}
			}
		}

		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (this.isEditorEmpty()) {
				this.navigateHistory(-1);
			} else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const hiddenPrefixLength = this.getLineHiddenTextPrefixLength(i, line);
			const displayLine = line.slice(hiddenPrefixLength);
			const isCurrentLine = i === this.state.cursorLine;
			const lineVisibleWidth = visibleWidth(displayLine);

			if (displayLine.length === 0) {
				layoutLines.push({
					text: "",
					hasCursor: isCurrentLine,
					cursorPos: isCurrentLine ? 0 : undefined,
				});
				continue;
			}

			if (lineVisibleWidth <= contentWidth) {
				if (isCurrentLine) {
					layoutLines.push({
						text: displayLine,
						hasCursor: true,
						cursorPos: Math.max(0, this.state.cursorCol - hiddenPrefixLength),
					});
				} else {
					layoutLines.push({
						text: displayLine,
						hasCursor: false,
					});
				}
			} else {
				const chunks = wordWrapLine(displayLine, contentWidth, [...this.segment(displayLine)]);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = Math.max(0, this.state.cursorCol - hiddenPrefixLength);
					const isLastChunk = chunkIndex === chunks.length - 1;

					// For word-wrapped chunks, we need to handle the case where
					// cursor might be in trimmed whitespace at end of chunk
					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						if (isLastChunk) {
							hasCursorInChunk = cursorPos >= chunk.startIndex;
							adjustedCursorPos = cursorPos - chunk.startIndex;
						} else {
							hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
							if (hasCursorInChunk) {
								adjustedCursorPos = cursorPos - chunk.startIndex;
								if (adjustedCursorPos > chunk.text.length) {
									adjustedCursorPos = chunk.text.length;
								}
							}
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getPasteSnapshot(): EditorPasteSnapshot {
		return {
			pastes: [...this.pastes],
			pasteCounter: this.pasteCounter,
		};
	}

	restorePasteSnapshot(snapshot: EditorPasteSnapshot): void {
		this.pastes = new Map(snapshot.pastes);
		this.pasteCounter = snapshot.pasteCounter;
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.historyIndex = -1; // Exit history browsing mode
		const normalized = this.normalizeText(text);
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.historyIndex = -1;
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			this.state.lines = [
				...this.state.lines.slice(0, this.state.cursorLine),

				beforeCursor + insertedLines[0],

				...insertedLines.slice(1, -1),

				insertedLines[insertedLines.length - 1] + afterCursor,

				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.historyIndex = -1; // Exit history browsing mode

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (!this.autocompleteState) {
			const slashContext = this.getCurrentSlashCommandContext();
			if (char === "/" && slashContext?.kind === "name") {
				this.tryTriggerAutocomplete();
			} else if (char === "@" || char === "#") {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
					this.tryTriggerAutocomplete();
				}
			} else if (/[a-zA-Z0-9.\-_]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				if (slashContext) {
					this.tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.refreshAutocompleteAfterEdit();
		}
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		const cleanText = this.normalizeText(decodedText);

		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		this.state.cursorLine++;
		this.setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.historyIndex = -1;
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private handleBackspace(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const line = this.state.lines[this.state.cursorLine] || "";
		const lineStartCol = this.getLineHiddenTextPrefixLength(this.state.cursorLine, line);

		if (this.state.cursorCol > lineStartCol) {
			this.pushUndoSnapshot();

			const beforeCursor = line.slice(lineStartCol, this.state.cursorCol);

			const graphemes = [...this.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
		} else if (lineStartCol > 0 && line.length === lineStartCol) {
			this.pushUndoSnapshot();

			this.state.lines[this.state.cursorLine] = "";
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		this.refreshAutocompleteAfterEdit(true);
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	private moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];
		if (!(currentVL && targetVL)) return;

		// When the cursor was snapped to a segment start, resolve the pre-snap
		// position against the VL it belongs to. This gives the correct visual
		// column even after a resize reshuffles VLs.
		let currentVisualCol: number;
		if (this.snappedFromCursorCol !== null) {
			const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
			currentVisualCol = this.snappedFromCursorCol - visualLines[vlIndex].startCol;
		} else {
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// For non-last segments, clamp to length-1 to stay within the segment
		const isLastSourceSegment =
			currentVisualLine === visualLines.length - 1 ||
			visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		const isLastTargetSegment =
			targetVisualLine === visualLines.length - 1 ||
			visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// Snap cursor to atomic segment boundary (e.g. paste markers)
		// so the cursor never lands in the middle of a multi-grapheme unit.
		// Single-grapheme segments don't need snapping.
		const segments = [...this.segment(logicalLine)];
		for (const seg of segments) {
			if (seg.index > this.state.cursorCol) break;
			if (seg.segment.length <= 1) continue;
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				const isContinuation = seg.index < targetVL.startCol;
				const isMovingDown = targetVisualLine > currentVisualLine;

				if (isContinuation && isMovingDown) {
					// The segment started on a previous visual line, and we
					// already visited it on the way down. Skip all remaining
					// continuation VLs and land on the first VL past it.
					const segEnd = seg.index + seg.segment.length;
					let next = targetVisualLine + 1;
					while (
						next < visualLines.length &&
						visualLines[next].logicalLine === targetVL.logicalLine &&
						visualLines[next].startCol < segEnd
					) {
						next++;
					}
					if (next < visualLines.length) {
						this.moveToVisualLine(visualLines, currentVisualLine, next);
						return;
					}
				}

				// Snap to the start of the segment so it gets highlighted.
				// Store the pre-snap position so the next vertical move can
				// resolve it to the correct visual column.
				this.snappedFromCursorCol = this.state.cursorCol;
				this.state.cursorCol = seg.index;
				return;
			}
		}

		// No snap occurred – we moved out of the atomic segment.
		this.snappedFromCursorCol = null;
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(this.getLineHiddenTextPrefixLength(this.state.cursorLine, currentLine));
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const lineStartCol = this.getLineHiddenTextPrefixLength(this.state.cursorLine, currentLine);

		if (this.state.cursorCol > lineStartCol) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			const deletedText = currentLine.slice(lineStartCol, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, lineStartCol) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(lineStartCol);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.refreshAutocompleteAfterEdit();
	}

	private deleteToEndOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.refreshAutocompleteAfterEdit();
	}

	private deleteWordBackwards(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.refreshAutocompleteAfterEdit();
	}

	private deleteWordForward(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.refreshAutocompleteAfterEdit();
	}

	private handleForwardDelete(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			const afterCursor = currentLine.slice(this.state.cursorCol);

			const graphemes = [...this.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		this.refreshAutocompleteAfterEdit(true);
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const hiddenPrefixLength = this.getLineHiddenTextPrefixLength(i, line);
			const displayLine = line.slice(hiddenPrefixLength);
			const lineVisWidth = visibleWidth(displayLine);
			if (displayLine.length === 0) {
				visualLines.push({ logicalLine: i, startCol: hiddenPrefixLength, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: hiddenPrefixLength, length: displayLine.length });
			} else {
				const chunks = wordWrapLine(displayLine, width, [...this.segment(displayLine)]);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: hiddenPrefixLength + chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index that contains the given logical position.
	 */
	private findVisualLineAt(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		line: number,
		col: number,
	): number {
		const hiddenPrefixLength = this.getLineHiddenTextPrefixLength(line, this.state.lines[line] || "");
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl || vl.logicalLine !== line) continue;
			if (hiddenPrefixLength > 0 && col < hiddenPrefixLength && vl.startCol === hiddenPrefixLength) {
				return i;
			}
			const offset = col - vl.startCol;
			// Cursor is in this segment if it's within range. For the last
			// segment of a logical line, cursor can be at length (end position)
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return visualLines.length - 1;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	private findCurrentVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	): number {
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const lineStartCol = this.getLineHiddenTextPrefixLength(this.state.cursorLine, currentLine);

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					const graphemes = [...this.segment(afterCursor)];
					const firstGrapheme = graphemes[0];
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol > lineStartCol) {
					const beforeCursor = currentLine.slice(lineStartCol, this.state.cursorCol);
					const graphemes = [...this.segment(beforeCursor)];
					const lastGrapheme = graphemes[graphemes.length - 1];
					const previousCol = this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1);
					this.setCursorCol(Math.max(lineStartCol, previousCol));
				} else if (this.state.cursorLine > 0) {
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const lineStartCol = this.getLineHiddenTextPrefixLength(this.state.cursorLine, currentLine);

		if (this.state.cursorCol <= lineStartCol) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		const textBeforeCursor = currentLine.slice(lineStartCol, this.state.cursorCol);
		const graphemes = [...this.segment(textBeforeCursor)];
		let newCol = this.state.cursorCol;

		while (
			graphemes.length > 0 &&
			!isAtomicMarker(graphemes[graphemes.length - 1]?.segment || "") &&
			isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")
		) {
			newCol -= graphemes.pop()?.segment.length || 0;
		}

		if (graphemes.length > 0) {
			const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
			if (isAtomicMarker(lastGrapheme)) {
				newCol -= graphemes.pop()?.segment.length || 0;
			} else if (isPunctuationChar(lastGrapheme)) {
				while (
					graphemes.length > 0 &&
					isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isAtomicMarker(graphemes[graphemes.length - 1]?.segment || "")
				) {
					newCol -= graphemes.pop()?.segment.length || 0;
				}
			} else {
				while (
					graphemes.length > 0 &&
					!isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isAtomicMarker(graphemes[graphemes.length - 1]?.segment || "")
				) {
					newCol -= graphemes.pop()?.segment.length || 0;
				}
			}
		}

		this.setCursorCol(Math.max(lineStartCol, newCol));
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
		this.refreshAutocompleteAfterEdit();
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		this.deleteYankedText();

		this.killRing.rotate();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
		this.refreshAutocompleteAfterEdit();
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	private insertYankedText(text: string): void {
		this.historyIndex = -1; // Exit history browsing mode
		const lines = text.split("\n");

		if (lines.length === 1) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push({
			lines: this.state.lines,
			cursorLine: this.state.cursorLine,
			cursorCol: this.state.cursorCol,
			pastes: this.pastes,
			pasteCounter: this.pasteCounter,
		});
	}

	private undo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.state = {
			lines: snapshot.lines,
			cursorLine: snapshot.cursorLine,
			cursorCol: snapshot.cursorCol,
		};
		this.pastes = new Map(snapshot.pastes);
		this.pasteCounter = snapshot.pasteCounter;
		this.lastAction = null;
		this.preferredVisualCol = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.refreshAutocompleteAfterEdit();
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		const textAfterCursor = currentLine.slice(this.state.cursorCol);
		const segments = this.segment(textAfterCursor);
		const iterator = segments[Symbol.iterator]();
		let next = iterator.next();
		let newCol = this.state.cursorCol;

		while (!next.done && !isAtomicMarker(next.value.segment) && isWhitespaceChar(next.value.segment)) {
			newCol += next.value.segment.length;
			next = iterator.next();
		}

		if (!next.done) {
			const firstGrapheme = next.value.segment;
			if (isAtomicMarker(firstGrapheme)) {
				newCol += firstGrapheme.length;
			} else if (isPunctuationChar(firstGrapheme)) {
				while (!next.done && isPunctuationChar(next.value.segment) && !isAtomicMarker(next.value.segment)) {
					newCol += next.value.segment.length;
					next = iterator.next();
				}
			} else {
				while (
					!next.done &&
					!isWhitespaceChar(next.value.segment) &&
					!isPunctuationChar(next.value.segment) &&
					!isAtomicMarker(next.value.segment)
				) {
					newCol += next.value.segment.length;
					next = iterator.next();
				}
			}
		}

		this.setCursorCol(newCol);
	}

	private getCurrentSlashCommandContext(): SlashCommandContext | null {
		return getSlashCommandContext(this.state.lines, this.state.cursorLine, this.state.cursorCol);
	}

	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(suggestions: AutocompleteSuggestions): SelectList {
		const layout =
			suggestions.kind === "slash-command" || (suggestions.kind === undefined && suggestions.prefix.startsWith("/"))
				? SLASH_COMMAND_SELECT_LIST_LAYOUT
				: undefined;
		return new SelectList(suggestions.items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		if (this.getCurrentSlashCommandContext()?.kind === "name") {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isSymbolAutocompleteContext = /(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$/.test(textBeforeCursor);
		return isSymbolAutocompleteContext ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			if (this.onChange) this.onChange(this.getText());
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteKind = suggestions.kind;
		this.autocompleteList = this.createAutocompleteList(suggestions);

		const matchingPrefix = suggestions.kind === "slash-command" ? suggestions.prefix.slice(1) : suggestions.prefix;
		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, matchingPrefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
		if (!this.autocompleteOverlay) {
			this.autocompleteOverlay = this.tui.showOverlay(this.autocompleteOverlayComponent, {
				width: "100%",
				aboveMarker: this.autocompleteAnchorMarker,
				offsetY: -1,
				nonCapturing: true,
				visible: () => this.focused && this.autocompleteState !== null,
			});
		}
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteOverlay?.hide();
		this.autocompleteOverlay = undefined;
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
		this.autocompleteKind = undefined;
	}

	protected cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private refreshAutocompleteAfterEdit(retrigger = false): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const hasCompletionContext =
			this.getCurrentSlashCommandContext() !== null || /(?:^|[\s])[@#][^\s]*$/.test(textBeforeCursor);

		if (this.autocompleteState) {
			if (this.getText().trim().length === 0 || (this.autocompleteState === "regular" && !hasCompletionContext)) {
				this.cancelAutocomplete();
				return;
			}
			this.updateAutocomplete();
			return;
		}

		if (retrigger && hasCompletionContext) {
			this.tryTriggerAutocomplete();
		}
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
