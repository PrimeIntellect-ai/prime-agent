import { type Component, Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";

const METADATA_MAX_LINES = 3;

class EventSummary implements Component {
	constructor(
		private readonly summary: string,
		private readonly expanded: boolean,
		private readonly color: ThemeColor,
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
		return lines.map((line) => theme.fg(this.color, ` ${line}`));
	}

	invalidate(): void {}
}

class EventMetadata implements Component {
	constructor(private readonly text: string) {}

	render(width: number): string[] {
		if (width < 1) return [];
		const contentWidth = Math.max(1, width - 1);
		const lines = wrapTextWithAnsi(this.text, contentWidth);
		if (lines.length > METADATA_MAX_LINES) {
			lines.splice(METADATA_MAX_LINES);
			lines[METADATA_MAX_LINES - 1] = truncateToWidth(`${lines[METADATA_MAX_LINES - 1]} …`, contentWidth, "…");
		}
		return lines.map((line) => theme.fg("dim", ` ${line}`));
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

	protected addSummary(summary: string, metadata?: string, color: ThemeColor = "customMessageText"): void {
		this.addChild(new EventSummary(summary, this.expanded, color));
		if (metadata) this.addMetadata(metadata);
	}

	/** Quiet trailing metadata, clamped: it can carry unbounded author-supplied text. */
	protected addMetadata(text: string): void {
		this.addChild(new EventMetadata(text));
	}

	protected abstract updateDisplay(): void;
}
