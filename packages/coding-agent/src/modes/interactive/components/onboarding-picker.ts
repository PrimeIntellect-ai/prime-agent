import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getResolvedThemeColors, theme } from "../theme/theme.js";
import { MenuSearchInput } from "./menu-panel.js";
import { isOnboardingExitKey } from "./onboarding-exit.js";
import { onboardingHighlightBackground } from "./onboarding-highlight.js";

export interface OnboardingPickerItem {
	id: string;
	label: string;
	/** Already signed in: the row is marked with a check rather than a note. */
	connected?: boolean;
}

interface OnboardingPickerOptions {
	prompt?: string;
	searchPlaceholder?: string;
	note?: string;
	continueLabel?: string;
	visibleRows?: number;
	rowWidth?: number;
	requestRender?: () => void;
	/** Quits the app while onboarding owns the screen. */
	onExit?: () => void;
}

const MARKER_WIDTH = 2;
const MIN_ROW_WIDTH = 34;
const ROW_TRAILING = 6;
const DEFAULT_VISIBLE_ROWS = 6;

/**
 * A searchable list in the onboarding block: a pinned continue action, then the
 * matching entries in a scrolling viewport. Entries stay selectable repeatedly,
 * so a user can connect several providers before moving on.
 */
export class OnboardingPickerComponent implements Component, Focusable {
	/** The list marks selection with its own caret, so the field hides the prompt. */
	private readonly search: MenuSearchInput;
	private selectedIndex = 0;
	private scrollTop = 0;
	private _focused = false;

	constructor(
		private readonly items: readonly OnboardingPickerItem[],
		private readonly onSelect: (id: string) => void,
		private readonly onContinue: () => void,
		private readonly onCancel: () => void,
		private readonly config: OnboardingPickerOptions = {},
	) {
		this.search = new MenuSearchInput(config.searchPlaceholder ?? "Search", true, true, true);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	invalidate(): void {
		this.search.invalidate();
	}

	handleInput(keyData: string): void {
		if (isOnboardingExitKey(keyData)) {
			this.config.onExit?.();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.selectedIndex === 0) {
				this.onContinue();
				return;
			}
			const item = this.getFiltered()[this.selectedIndex - 1];
			if (item) {
				this.onSelect(item.id);
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.search.handleInput(keyData);
		this.selectedIndex = Math.min(this.selectedIndex, this.getFiltered().length);
		this.scrollTop = 0;
		this.config.requestRender?.();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const filtered = this.getFiltered();
		const visibleRows = this.config.visibleRows ?? DEFAULT_VISIBLE_ROWS;
		this.clampScroll(filtered.length, visibleRows);

		const rowWidth = this.getRowWidth(safeWidth);
		const background = onboardingHighlightBackground(getResolvedThemeColors());
		const lines: string[] = [this.line(safeWidth, "")];
		if (this.config.prompt) {
			lines.push(this.line(safeWidth, theme.fg("text", this.config.prompt)));
			lines.push(this.line(safeWidth, ""));
		}
		// The field renders its own single-column indent, matching the prompt above.
		const field = this.search.render(safeWidth)[0] ?? "";
		lines.push(
			truncateToWidth(field, safeWidth, "", true) + " ".repeat(Math.max(0, safeWidth - visibleWidth(field))),
		);
		lines.push(this.line(safeWidth, ""));
		lines.push(
			this.renderRow(
				safeWidth,
				rowWidth,
				this.config.continueLabel ?? "Continue",
				false,
				this.selectedIndex === 0,
				background,
			),
		);

		const end = Math.min(filtered.length, this.scrollTop + visibleRows);
		for (let index = this.scrollTop; index < end; index++) {
			const item = filtered[index];
			if (!item) continue;
			lines.push(
				this.renderRow(
					safeWidth,
					rowWidth,
					item.label,
					item.connected === true,
					this.selectedIndex === index + 1,
					background,
				),
			);
		}
		const remaining = filtered.length - end;
		if (remaining > 0 || this.scrollTop > 0) {
			const hint = remaining > 0 ? `${remaining} more below` : "top of list";
			lines.push(this.line(safeWidth, theme.fg("dim", `  ${hint}`)));
		}
		if (this.config.note) {
			lines.push(this.line(safeWidth, ""));
			lines.push(this.line(safeWidth, theme.fg("dim", this.config.note)));
		}
		return lines;
	}

	private renderRow(
		width: number,
		rowWidth: number,
		label: string,
		connected: boolean,
		selected: boolean,
		background: (value: string) => string,
	): string {
		const name = `${selected ? "> " : "  "}${label}`;
		const mark = connected ? "  \u2713" : "";
		const pad = " ".repeat(Math.max(0, rowWidth - visibleWidth(truncateToWidth(`${name}${mark}`, rowWidth, ""))));
		const styledMark = connected ? theme.fg("success", "  \u2713") : "";
		const styled = selected
			? background(theme.bold(theme.fg("text", name)) + styledMark + theme.fg("dim", pad))
			: theme.fg("muted", name) + styledMark + theme.fg("dim", pad);
		return this.line(width, styled);
	}

	private getRowWidth(width: number): number {
		const longest = this.items.reduce(
			(max, item) => Math.max(max, visibleWidth(item.label) + (item.connected ? 3 : 0)),
			0,
		);
		return Math.min(
			Math.max(1, width - 1),
			this.config.rowWidth ?? Math.max(MIN_ROW_WIDTH, MARKER_WIDTH + longest + ROW_TRAILING),
		);
	}

	private getFiltered(): readonly OnboardingPickerItem[] {
		const query = this.search.getValue().trim().toLowerCase();
		if (!query) {
			return this.items;
		}
		return this.items.filter(
			(item) => item.label.toLowerCase().includes(query) || item.id.toLowerCase().includes(query),
		);
	}

	private move(delta: number): void {
		const filtered = this.getFiltered();
		const next = this.selectedIndex + delta;
		if (next < 0 || next > filtered.length) {
			return;
		}
		this.selectedIndex = next;
		const visibleRows = this.config.visibleRows ?? DEFAULT_VISIBLE_ROWS;
		if (next >= 1) {
			const itemIndex = next - 1;
			if (itemIndex < this.scrollTop) {
				this.scrollTop = itemIndex;
			} else if (itemIndex >= this.scrollTop + visibleRows) {
				this.scrollTop = itemIndex - visibleRows + 1;
			}
		}
		this.config.requestRender?.();
	}

	private clampScroll(total: number, visibleRows: number): void {
		const maxScroll = Math.max(0, total - visibleRows);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
	}

	private line(width: number, content: string): string {
		const truncated = truncateToWidth(content ? ` ${content}` : "", width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}
}
