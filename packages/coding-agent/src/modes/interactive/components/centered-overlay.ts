import {
	type Component,
	type Focusable,
	isFocusable,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@prime-intellect/prime-agent-tui";

interface CenteredOverlayOptions {
	getRows: () => number;
	maxContentWidth?: number;
	verticalOffset?: number;
}

interface InputHandler {
	handleInput(data: string): void;
}

export interface FullPaneOverlayOptions {
	maxContentWidth?: number;
	fullWidth?: boolean;
	suspendFullscreenMouse?: boolean;
}

function hasInputHandler(component: Component): component is Component & InputHandler {
	return typeof (component as { handleInput?: unknown }).handleInput === "function";
}

/** Shows a component as a full-pane centered overlay on the given TUI. */
export function showFullPaneOverlay(
	ui: TUI,
	component: Component,
	options: number | FullPaneOverlayOptions = 80,
): OverlayHandle {
	const { maxContentWidth, suspendFullscreenMouse } =
		typeof options === "number"
			? { maxContentWidth: options, suspendFullscreenMouse: undefined }
			: {
					maxContentWidth: options.fullWidth ? undefined : (options.maxContentWidth ?? 80),
					suspendFullscreenMouse: options.suspendFullscreenMouse,
				};
	const overlayOptions: OverlayOptions = {
		width: "100%",
		maxHeight: "100%",
		row: 0,
		col: 0,
	};
	if (suspendFullscreenMouse) {
		overlayOptions.suspendFullscreenMouse = true;
	}

	return ui.showOverlay(
		new CenteredOverlayComponent(component, {
			getRows: () => ui.terminal.rows,
			maxContentWidth,
		}),
		overlayOptions,
	);
}

export class CenteredOverlayComponent implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly component: Component,
		private readonly options: CenteredOverlayOptions,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.component)) {
			this.component.focused = value;
		}
	}

	invalidate(): void {
		this.component.invalidate?.();
	}

	handleInput(data: string): void {
		if (hasInputHandler(this.component)) {
			this.component.handleInput(data);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.min(safeWidth, this.options.maxContentWidth ?? safeWidth);
		const left = Math.max(0, Math.floor((safeWidth - contentWidth) / 2));
		const contentLines = this.component.render(contentWidth).map((line) => this.place(line, safeWidth, left));
		const requestedRows = this.options.getRows();
		const targetRows =
			Number.isFinite(requestedRows) && requestedRows > 0
				? Math.max(contentLines.length, Math.floor(requestedRows))
				: contentLines.length;
		const centeredTop = Math.floor((targetRows - contentLines.length) / 2) + (this.options.verticalOffset ?? 0);
		const topPadding = Math.max(0, Math.min(centeredTop, targetRows - contentLines.length));
		const bottomPadding = Math.max(0, targetRows - contentLines.length - topPadding);

		return [
			...Array.from({ length: topPadding }, () => this.blank(safeWidth)),
			...contentLines,
			...Array.from({ length: bottomPadding }, () => this.blank(safeWidth)),
		];
	}

	private place(text: string, width: number, left: number): string {
		const safeLeft = Math.max(0, Math.min(left, width));
		const contentWidth = Math.max(0, width - safeLeft);
		const content = truncateToWidth(text, contentWidth, "");
		const right = Math.max(0, width - safeLeft - visibleWidth(content));
		return " ".repeat(safeLeft) + content + " ".repeat(right);
	}

	private blank(width: number): string {
		return " ".repeat(width);
	}
}
