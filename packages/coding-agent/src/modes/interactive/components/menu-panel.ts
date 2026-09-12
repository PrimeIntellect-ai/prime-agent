import {
	type Component,
	Container,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

interface MenuPanelOptions {
	title: string;
	subtitle?: string;
	inline?: boolean;
}

export interface MenuViewportProvider {
	getRows?: () => number;
}

interface MenuListOptions {
	compact?: boolean | (() => boolean);
	inline?: boolean;
}

interface MenuListLayoutOptions extends MenuViewportProvider {
	preferredVisibleItems: number;
	minVisibleItems?: number;
	totalItems?: number;
	reservedRows: number;
	comfortableItemRows: number;
	compactItemRows?: number;
	scrollIndicatorRows?: number;
	comfortableListPaddingRows?: number;
	compactListPaddingRows?: number;
}

export interface MenuListLayout {
	compact: boolean;
	visibleItems: number;
}

const PANEL_PADDING_X = 2;
const PANEL_PADDING_Y = 1;
const FIELD_PADDING_X = 2;
const ROW_PADDING_X = 2;
const ROW_PADDING_Y = 1;
const ANSI_RESET = "\x1b[0m";

export function getMenuPanelInnerWidth(width: number, inline = false): number {
	const padding = inline ? 1 : PANEL_PADDING_X;
	return Math.max(1, width - padding * 2);
}

interface FullWidthMenuComponent {
	readonly fillsMenuPanel: true;
}

function fillsMenuPanel(component: Component): component is Component & FullWidthMenuComponent {
	return (component as { fillsMenuPanel?: unknown }).fillsMenuPanel === true;
}

function getViewportRows(getRows: (() => number) | undefined): number | undefined {
	const rows = getRows?.();
	if (rows === undefined || !Number.isFinite(rows) || rows <= 0) {
		return undefined;
	}
	return Math.floor(rows);
}

function visibleItemCount(
	rows: number,
	options: {
		preferredVisibleItems: number;
		minVisibleItems: number;
		reservedRows: number;
		itemRows: number;
		listPaddingRows: number;
		extraRows: number;
	},
): number {
	const capacityRows = Math.max(0, rows - options.reservedRows - options.listPaddingRows - options.extraRows);
	const itemCapacity = Math.floor(capacityRows / options.itemRows);
	return Math.max(options.minVisibleItems, Math.min(options.preferredVisibleItems, itemCapacity));
}

function listRowsUsed(options: {
	reservedRows: number;
	listPaddingRows: number;
	visibleItems: number;
	itemRows: number;
	extraRows: number;
}): number {
	return options.reservedRows + options.listPaddingRows + options.extraRows + options.visibleItems * options.itemRows;
}

function scrollIndicatorRows(options: {
	totalItems: number | undefined;
	visibleItems: number;
	scrollIndicatorRows: number;
}): number {
	if (options.totalItems === undefined || options.scrollIndicatorRows <= 0) {
		return 0;
	}
	return options.totalItems > options.visibleItems ? options.scrollIndicatorRows : 0;
}

function getLayoutCandidate(
	rows: number,
	options: MenuListLayoutOptions,
	itemRows: number,
	listPaddingRows: number,
	compact: boolean,
): MenuListLayout & { rowsUsed: number; fits: boolean } {
	const minVisibleItems = options.minVisibleItems ?? 1;
	const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
	const visibleItemsWithoutScroll = visibleItemCount(rows, {
		preferredVisibleItems,
		minVisibleItems,
		reservedRows: options.reservedRows,
		itemRows,
		listPaddingRows,
		extraRows: 0,
	});
	const extraRows = scrollIndicatorRows({
		totalItems: options.totalItems,
		visibleItems: visibleItemsWithoutScroll,
		scrollIndicatorRows: options.scrollIndicatorRows ?? 0,
	});
	const visibleItems =
		extraRows > 0
			? visibleItemCount(rows, {
					preferredVisibleItems,
					minVisibleItems,
					reservedRows: options.reservedRows,
					itemRows,
					listPaddingRows,
					extraRows,
				})
			: visibleItemsWithoutScroll;
	const rowsUsed = listRowsUsed({
		reservedRows: options.reservedRows,
		listPaddingRows,
		visibleItems,
		itemRows,
		extraRows,
	});
	return {
		compact,
		visibleItems,
		rowsUsed,
		fits: rowsUsed <= rows,
	};
}

export function getMenuListLayout(options: MenuListLayoutOptions): MenuListLayout {
	const minVisibleItems = options.minVisibleItems ?? 1;
	const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
	const rows = getViewportRows(options.getRows);
	if (rows === undefined) {
		return { compact: false, visibleItems: preferredVisibleItems };
	}

	const comfortableLayout = getLayoutCandidate(
		rows,
		options,
		Math.max(1, options.comfortableItemRows),
		options.comfortableListPaddingRows ?? 1,
		false,
	);
	if (options.compactItemRows === undefined) {
		return { compact: false, visibleItems: comfortableLayout.visibleItems };
	}

	const compactLayout = getLayoutCandidate(
		rows,
		options,
		Math.max(1, options.compactItemRows),
		options.compactListPaddingRows ?? 0,
		true,
	);
	if (compactLayout.fits && (!comfortableLayout.fits || compactLayout.visibleItems > comfortableLayout.visibleItems)) {
		return { compact: true, visibleItems: compactLayout.visibleItems };
	}
	if (comfortableLayout.fits) {
		return { compact: false, visibleItems: comfortableLayout.visibleItems };
	}
	return compactLayout.rowsUsed <= comfortableLayout.rowsUsed
		? { compact: true, visibleItems: compactLayout.visibleItems }
		: { compact: false, visibleItems: comfortableLayout.visibleItems };
}

function reduceInlineTrailingSegments(segments: ReadonlyArray<string>, budget: number): string[] {
	let current = segments.filter((segment) => segment.length > 0);
	while (current.length > 1 && visibleWidth(current.join(" · ")) > budget) {
		current = current.slice(1);
	}
	return current;
}

/**
 * Rendered width of a trailing cluster at the given row width, mirroring how
 * MenuRow degrades and truncates it. Pickers use this to budget row content.
 */
export function getInlineTrailingWidth(segments: ReadonlyArray<string>, width: number): number {
	const innerWidth = Math.max(1, width - 2);
	const budget = Math.max(1, innerWidth - 5);
	const reduced = reduceInlineTrailingSegments(segments, budget);
	if (reduced.length === 0) return 0;
	return Math.min(visibleWidth(reduced.join(" · ")), budget);
}

function paddedBackgroundLine(
	text: string,
	width: number,
	paddingX: number,
	background: ((text: string) => string) | undefined,
): string {
	const innerWidth = Math.max(1, width - paddingX * 2);
	const content = truncateToWidth(text, innerWidth, "");
	const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	const contentSpan = " ".repeat(paddingX) + content;
	const trailingSpan = rightPadding + " ".repeat(paddingX);
	if (!background) {
		return contentSpan + trailingSpan;
	}
	return applyBackground(contentSpan, background) + background(trailingSpan);
}

function applyBackground(text: string, background: (text: string) => string): string {
	return text
		.split(ANSI_RESET)
		.map((segment) => background(segment))
		.join(ANSI_RESET);
}

function surfaceLine(text: string, width: number, paddingX = PANEL_PADDING_X): string {
	return paddedBackgroundLine(text, width, paddingX, theme.getEditorBackgroundColor());
}

function surfaceWrappedLines(text: string, width: number, paddingX = PANEL_PADDING_X): string[] {
	const innerWidth = Math.max(1, width - paddingX * 2);
	return wrapTextWithAnsi(text, innerWidth).map((content) => surfaceLine(content, width, paddingX));
}

export class MenuPanel extends Container {
	private title: string;

	constructor(private readonly options: MenuPanelOptions) {
		super();
		this.title = options.title;
	}

	setTitle(title: string): void {
		this.title = title;
	}

	override render(width: number): string[] {
		if (this.options.inline) {
			const lines: string[] = [];
			if (this.title) lines.push(theme.fg("muted", ` ${this.title}`));
			for (const child of this.children) {
				lines.push(
					...child
						.render(fillsMenuPanel(child) ? width : getMenuPanelInnerWidth(width, true))
						.map((line) => (fillsMenuPanel(child) ? line : ` ${line}`)),
				);
			}
			return lines.map((line) => truncateToWidth(line, width, "", true));
		}
		const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
		const innerWidth = getMenuPanelInnerWidth(width);
		const lines: string[] = [];

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(surfaceLine("", safeWidth));
		}
		const hasTitle = this.title.trim().length > 0;
		const subtitle = this.options.subtitle?.trim();
		const hasSubtitle = subtitle !== undefined && subtitle.length > 0;
		const hasHeader = hasTitle || hasSubtitle;
		if (hasTitle) {
			lines.push(surfaceLine(theme.fg("text", this.title), safeWidth));
		}
		if (hasSubtitle) {
			lines.push(...surfaceWrappedLines(theme.fg("muted", subtitle), safeWidth));
		}
		if (hasHeader) {
			lines.push(surfaceLine("", safeWidth));
		}

		for (const child of this.children) {
			const childLines = fillsMenuPanel(child) ? child.render(safeWidth) : child.render(innerWidth);
			for (const line of childLines) {
				lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, safeWidth));
			}
		}

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(surfaceLine("", safeWidth));
		}
		return lines;
	}
}

export class MenuSearchInput implements Component, Focusable, FullWidthMenuComponent {
	readonly fillsMenuPanel = true;
	private readonly input = new Input();

	constructor(
		private readonly placeholder: string,
		private readonly inline = false,
	) {}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	set onSubmit(handler: ((value: string) => void) | undefined) {
		this.input.onSubmit = handler;
	}

	getValue(): string {
		return this.input.getValue();
	}

	getCursor(): number {
		return this.input.getCursor();
	}

	setValue(value: string): void {
		this.input.setValue(value);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		if (this.inline) {
			const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
			let content = this.input.render(Math.max(1, width - 2))[0] ?? "";
			if (this.getValue() === "") {
				content = this.focused
					? `${content.trimEnd()}${theme.fg("dim", this.placeholder)}`
					: `> ${theme.fg("dim", this.placeholder)}`;
			}
			return [border, truncateToWidth(` ${content}`, width, "", true), border];
		}
		const safeWidth = Math.max(FIELD_PADDING_X * 2 + 1, width);
		const innerWidth = Math.max(1, safeWidth - FIELD_PADDING_X * 2);
		const content =
			this.getValue() === "" && !this.focused
				? theme.fg("dim", this.placeholder)
				: this.stripInputPrompt(this.input.render(innerWidth + 2)[0] ?? "");
		return [paddedBackgroundLine(content, safeWidth, FIELD_PADDING_X, theme.getEditorBackgroundColor())];
	}

	private stripInputPrompt(line: string): string {
		return line.startsWith("> ") ? line.slice(2) : line;
	}
}

interface MenuRowOptions {
	primary: string;
	secondary?: string;
	meta?: string;
	/**
	 * Inline-only segments rendered right-aligned; the last segment sits flush against the
	 * row's right edge. Earlier segments drop first when the row is too narrow.
	 */
	trailing?: ReadonlyArray<string>;
	selected: boolean;
	inline?: boolean;
}

export class MenuRow implements Component, FullWidthMenuComponent {
	readonly fillsMenuPanel = true;

	constructor(private readonly options: MenuRowOptions) {}

	get selected(): boolean {
		return this.options.selected;
	}

	invalidate(): void {
		// Row render is derived from constructor options.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		return [
			...this.renderPadding(safeWidth, this.selected),
			...this.renderContent(safeWidth),
			...this.renderPadding(safeWidth, this.selected),
		];
	}

	renderContent(width: number): string[] {
		if (this.options.inline) {
			// Trailing rows run flush to the right edge; legacy rows keep a one-column margin.
			const hasTrailing = this.options.trailing !== undefined;
			const innerWidth = Math.max(1, hasTrailing ? width - 2 : width - 3);
			const trailing = this.getInlineTrailing(width, innerWidth);
			const trailingWidth = visibleWidth(trailing);
			const gap = trailingWidth > 0 ? 2 : 0;
			const primaryWidth = Math.max(1, innerWidth - trailingWidth - gap);
			const primaryText = theme.fg("text", this.options.primary);
			const primary = truncateToWidth(
				this.selected ? theme.bold(primaryText) : primaryText,
				primaryWidth,
				"…",
				true,
			);
			const filler = " ".repeat(Math.max(0, innerWidth - visibleWidth(primary) - trailingWidth));
			const content = `${this.selected ? "›" : " "} ${primary}${filler}${trailing}`;
			return [
				paddedBackgroundLine(
					content,
					width,
					0,
					this.selected ? theme.getSoftSelectionBackgroundColor() : undefined,
				),
			];
		}
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		const meta = this.options.meta ? theme.fg("muted", this.options.meta) : "";
		const secondary = this.options.secondary ? theme.fg("muted", this.options.secondary) : "";
		const primary = this.options.selected
			? theme.bold(theme.fg("text", this.options.primary))
			: theme.fg("text", this.options.primary);
		const innerWidth = Math.max(1, safeWidth - ROW_PADDING_X * 2);
		const metaWidth = visibleWidth(meta);
		const gap = meta ? 2 : 0;
		const primaryWidth = Math.max(1, innerWidth - metaWidth - gap);
		const primaryText = truncateToWidth(primary, primaryWidth, "", true);
		const primaryLine = meta ? primaryText + " ".repeat(gap) + meta : primaryText;
		const lines: string[] = [];
		lines.push(this.rowLine(primaryLine, safeWidth, this.selected));
		if (secondary) {
			lines.push(this.rowLine(truncateToWidth(secondary, innerWidth, "", true), safeWidth, this.selected));
		}
		return lines;
	}

	renderPadding(width: number, selected: boolean): string[] {
		const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
		const lines: string[] = [];
		for (let i = 0; i < ROW_PADDING_Y; i++) {
			lines.push(this.rowLine("", safeWidth, selected));
		}
		return lines;
	}

	private rowLine(text: string, width: number, selected: boolean): string {
		const background = selected ? theme.getSoftSelectionBackgroundColor() : theme.getEditorBackgroundColor();
		return paddedBackgroundLine(text, width, ROW_PADDING_X, background);
	}

	private getInlineTrailing(width: number, innerWidth: number): string {
		if (this.options.trailing === undefined) {
			const secondary = width >= 60 ? this.options.secondary : undefined;
			const details = [secondary, this.options.meta].filter(Boolean).join(" · ");
			return details ? truncateToWidth(theme.fg("muted", details), Math.floor(innerWidth / 2), "…") : "";
		}
		const budget = Math.max(1, innerWidth - 5);
		const segments = reduceInlineTrailingSegments(this.options.trailing, budget);
		if (segments.length === 0) return "";
		return truncateToWidth(theme.fg("muted", segments.join(" · ")), budget, "…");
	}
}

export class MenuList extends Container implements FullWidthMenuComponent {
	readonly fillsMenuPanel = true;

	constructor(private readonly options: MenuListOptions = {}) {
		super();
	}

	override render(width: number): string[] {
		if (this.options.inline) {
			return this.children.flatMap((child) =>
				child instanceof MenuRow ? child.renderContent(width) : child.render(width),
			);
		}
		const lines: string[] = [];
		const compact = this.isCompact();
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (child instanceof MenuRow) {
				if (compact) {
					lines.push(...child.renderContent(width));
					continue;
				}
				const previousChild = this.children[index - 1];
				const nextChild = this.children[index + 1];
				const previousRow = previousChild instanceof MenuRow ? previousChild : undefined;
				const nextRow = nextChild instanceof MenuRow ? nextChild : undefined;
				lines.push(...child.renderPadding(width, child.selected || previousRow?.selected === true));
				lines.push(...child.renderContent(width));
				if (!nextRow) {
					lines.push(...child.renderPadding(width, child.selected));
				}
				continue;
			}
			const childLines = fillsMenuPanel(child)
				? child.render(width)
				: child.render(Math.max(1, width - PANEL_PADDING_X * 2));
			for (const line of childLines) {
				lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, width));
			}
		}
		return lines;
	}

	private isCompact(): boolean {
		const compact = this.options.compact;
		return typeof compact === "function" ? compact() : compact === true;
	}
}
