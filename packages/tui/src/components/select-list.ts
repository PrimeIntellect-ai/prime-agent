import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	argumentHint?: string;
	sourceTag?: string;
	takesArgument?: boolean;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	argumentHint?: (text: string) => string;
	sourceTag?: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	showItemMetadata?: boolean;
	showDirectionalScrollInfo?: boolean;
	showSelectedDescription?: boolean;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = this.layout.showDirectionalScrollInfo
				? this.formatDirectionalScrollInfo(startIndex, this.filteredItems.length - endIndex)
				: `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		if (this.layout.showSelectedDescription) {
			this.renderSelectedDescription(lines, width);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "› " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (this.layout.showItemMetadata) {
			return this.renderMetadataItem(item, isSelected, width, primaryColumnWidth, prefix, prefixWidth);
		}

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private formatDirectionalScrollInfo(hiddenAbove: number, hiddenBelow: number): string {
		const indicators = [
			hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : undefined,
			hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : undefined,
		].filter((indicator): indicator is string => indicator !== undefined);
		return `  ${indicators.join("  ")}`;
	}

	private renderMetadataItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		primaryColumnWidth: number,
		prefix: string,
		prefixWidth: number,
	): string {
		const argumentHint = item.argumentHint ? normalizeToSingleLine(item.argumentHint) : undefined;
		const sourceTag = item.sourceTag ? normalizeToSingleLine(item.sourceTag) : undefined;
		const hasMetadata = Boolean(argumentHint || sourceTag);
		const contentWidth = Math.max(1, width - prefixWidth - 2);
		const showMetadata = hasMetadata && contentWidth > primaryColumnWidth;
		const effectivePrimaryColumnWidth = showMetadata ? primaryColumnWidth : contentWidth;
		const maxPrimaryWidth = showMetadata
			? Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP)
			: effectivePrimaryColumnWidth;
		const primary = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
		const styledPrefix = isSelected ? this.theme.selectedPrefix(prefix) : prefix;
		const styledPrimary = isSelected ? this.theme.selectedText(primary) : primary;
		if (!showMetadata) {
			return truncateToWidth(`${styledPrefix}${styledPrimary}`, width, "");
		}

		const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - visibleWidth(primary)));
		let remainingWidth = Math.max(0, width - prefixWidth - visibleWidth(primary) - spacing.length - 2);
		const metadata: string[] = [];
		if (argumentHint && remainingWidth > 0) {
			const truncatedArgumentHint = truncateToWidth(argumentHint, remainingWidth, "…");
			metadata.push((this.theme.argumentHint ?? this.theme.description)(truncatedArgumentHint));
			remainingWidth -= visibleWidth(truncatedArgumentHint);
		}
		if (sourceTag && remainingWidth > (metadata.length > 0 ? PRIMARY_COLUMN_GAP : 0)) {
			if (metadata.length > 0) {
				metadata.push(" ".repeat(PRIMARY_COLUMN_GAP));
				remainingWidth -= PRIMARY_COLUMN_GAP;
			}
			metadata.push(
				(this.theme.sourceTag ?? this.theme.description)(truncateToWidth(sourceTag, remainingWidth, "…")),
			);
		}
		return truncateToWidth(`${styledPrefix}${styledPrimary}${spacing}${metadata.join("")}`, width, "");
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private renderSelectedDescription(lines: string[], width: number): void {
		const description = this.filteredItems[this.selectedIndex]?.description?.trim();
		if (!description) return;

		const indent = width >= 4 ? "  " : "";
		const contentWidth = Math.max(1, width - visibleWidth(indent) - 2);
		lines.push("");
		for (const line of wrapTextWithAnsi(description, contentWidth)) {
			lines.push(this.theme.description(indent + line));
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
