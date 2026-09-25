import {
	Clickable,
	type Component,
	Container,
	Spacer,
	type TableCellSelectionRegion,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";

/** What a subclass shows in its current state. */
export interface EventView {
	/** Styled first row. It is clickable in both states. */
	header: string;
	/** Plain text. The base appends it to the header as dim ` · ${metadata}`. */
	metadata?: string;
	/** Whitespace-collapsed preview, at most 2 rows, clickable. */
	preview?: { text: string; color: ThemeColor };
	/** Rendered at width - 4 under the ` ╰─ ` gutter. */
	body?: Component;
}

/** Bold custom-message label like `[refinement]`. */
export function customMessageLabel(name: string): string {
	return theme.fg("customMessageLabel", `\x1b[1m[${name}]\x1b[22m`);
}

const GUTTER_WIDTH = 4;

/** ` ╰─ ` on the first body row, 4 spaces on the rest; each row is truncated to width. */
export function guttered(width: number, renderBody: (bodyWidth: number) => string[]): string[] {
	const lines = renderBody(Math.max(1, width - GUTTER_WIDTH));
	return lines.map((line, index) =>
		truncateToWidth(` ${index === 0 ? theme.fg("dim", "╰─ ") : "   "}${line}`, Math.max(1, width), ""),
	);
}

/** Two-row preview of the collapsed summary, with the standard one-column chat inset. */
class EventPreview implements Component {
	constructor(
		private readonly summary: string,
		private readonly color: ThemeColor,
	) {}

	render(width: number): string[] {
		if (width < 1) return [];
		const text = this.summary.replace(/\s+/g, " ").trim();
		const contentWidth = Math.max(1, width - 1);
		const lines = wrapTextWithAnsi(text, contentWidth);
		if (lines.length > 2) {
			lines.splice(2);
			lines[1] = truncateToWidth(`${lines[1]} …`, contentWidth, "…");
		}
		return lines.map((line) => theme.fg(this.color, ` ${line}`));
	}

	invalidate(): void {}
}

/** Renders a body component under the shared gutter and keeps its table cells selectable. */
class GutteredBody implements Component {
	constructor(private readonly body: Component) {}

	render(width: number): string[] {
		return guttered(width, (bodyWidth) => this.body.render(bodyWidth));
	}

	invalidate(): void {
		this.body.invalidate?.();
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return (this.body.getSelectionRegions?.() ?? []).map((region) => ({
			...region,
			col: region.col + GUTTER_WIDTH,
			tableLeft: region.tableLeft + GUTTER_WIDTH,
			tableRight: region.tableRight + GUTTER_WIDTH,
		}));
	}
}

/** Event message base: clickable header row, optional preview, guttered body. */
export abstract class ExpandableEventMessage extends Container {
	protected expanded = false;

	constructor(private readonly leadingSpace = false) {
		super();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		const { header, metadata, preview, body } = this.view();
		const toggle = () => this.setExpanded(!this.expanded);
		if (this.leadingSpace) this.addChild(new Spacer(1));
		this.addChild(
			new Clickable(new Text(metadata ? `${header}${theme.fg("dim", ` · ${metadata}`)}` : header, 1, 0), toggle),
		);
		if (preview) this.addChild(new Clickable(new EventPreview(preview.text, preview.color), toggle));
		if (body) this.addChild(new GutteredBody(body));
	}

	protected abstract view(): EventView;
}
