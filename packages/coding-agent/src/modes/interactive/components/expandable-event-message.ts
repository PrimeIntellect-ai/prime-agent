import { type Component, Container, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

class EventSummary implements Component {
	constructor(
		private readonly summary: string,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		if (width < 1) return [];
		const text = this.expanded ? this.summary : this.summary.replace(/\s+/g, " ").trim();
		// Keep the standard one-column chat inset on every summary line.
		const contentWidth = Math.max(1, width - 1);
		const lines = wrapTextWithAnsi(text, contentWidth);
		if (!this.expanded && lines.length > 2) {
			lines.splice(2);
			lines[1] = truncateToWidth(`${lines[1]} …`, contentWidth, "…");
		}
		return lines.map((line) => theme.fg("customMessageText", ` ${line}`));
	}

	invalidate(): void {}
}

/** Compact outcome first, with quiet metadata and the existing details toggle. */
export abstract class ExpandableEventMessage extends Container {
	protected expanded = false;

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	protected addSummary(summary: string, metadata?: string): void {
		this.addChild(new EventSummary(summary, this.expanded));
		if (metadata) this.addChild(new Text(theme.fg("dim", metadata), 1, 0));
	}

	protected abstract updateDisplay(): void;
}
