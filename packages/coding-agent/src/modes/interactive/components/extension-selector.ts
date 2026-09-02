/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@prime-intellect/prime-agent-tui";
import { theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import { getMenuListLayout, MenuList, MenuPanel, MenuRow, type MenuViewportProvider } from "./menu-panel.js";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	getRows?: () => number;
}

const PREFERRED_VISIBLE_OPTIONS = 8;
const OPTION_LIST_RESERVED_BASE_ROWS = 5;
const OPTION_SCROLL_INDICATOR_ROWS = 1;

function splitTitleAndDescription(value: string): { title: string; description?: string; descriptionRows: number } {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const [title = "", ...descriptionLines] = lines;
	return {
		title,
		description: descriptionLines.length > 0 ? descriptionLines.join("\n") : undefined,
		descriptionRows: descriptionLines.length,
	};
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private panel: MenuPanel;
	private readonly reservedRows: number;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_OPTIONS,
		reservedRows: OPTION_LIST_RESERVED_BASE_ROWS,
		comfortableItemRows: 1,
		compactItemRows: 1,
	});
	private readonly viewport: MenuViewportProvider;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		const header = splitTitleAndDescription(title);
		this.baseTitle = header.title;
		this.reservedRows = OPTION_LIST_RESERVED_BASE_ROWS + header.descriptionRows;
		const tui = opts?.tui;
		this.viewport = { getRows: opts?.getRows ?? (tui ? () => tui.terminal.rows : undefined) };

		this.panel = new MenuPanel({
			title: header.title,
			subtitle: header.description,
		});
		this.addChild(this.panel);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.panel.setTitle(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new MenuList({ compact: true });
		this.panel.addChild(this.listContainer);
		this.panel.addChild(new Spacer(1));
		this.panel.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);

		this.updateList();
	}

	override render(width: number): string[] {
		const previousLayout = this.listLayout;
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems
		) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.updateLayout();
		this.listContainer.clear();
		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.options.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.options.length);
		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			this.listContainer.addChild(
				new MenuRow({
					primary: this.options[i] ?? "",
					selected: isSelected,
				}),
			);
		}
		if (startIndex > 0 || endIndex < this.options.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.options.length})`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_OPTIONS,
			totalItems: this.options.length,
			reservedRows: this.reservedRows,
			comfortableItemRows: 1,
			compactItemRows: 1,
			scrollIndicatorRows: OPTION_SCROLL_INDICATOR_ROWS,
		});
	}
}
