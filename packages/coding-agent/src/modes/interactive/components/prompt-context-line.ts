import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/** Rows immediately above the prompt: recap and effort stacked with breathing room. */
export class PromptContextLine implements Component {
	constructor(
		private readonly getRecap: () => string | undefined,
		private readonly getEffortLabel: (maxWidth: number) => string | undefined,
	) {}

	render(width: number): string[] {
		if (width < 1) return [];
		const paddingX = width > 2 ? 1 : 0;
		const contentWidth = width - paddingX * 2;
		const recap = this.getRecap()?.replace(/\s+/g, " ").trim();
		const left = recap ? `Recap: ${recap}` : "";
		const right = truncateToWidth(this.getEffortLabel(contentWidth) ?? "", contentWidth, "");
		if (!left && !right) return [];
		const padding = " ".repeat(paddingX);
		const rows: string[] = [];
		if (left) {
			const renderedLeft = truncateToWidth(left, contentWidth, "…");
			const trailing = " ".repeat(Math.max(0, contentWidth - visibleWidth(renderedLeft)));
			rows.push(padding + theme.fg("dim", renderedLeft) + trailing + padding);
		}
		if (left && right) {
			rows.push("");
		}
		if (right) {
			const leading = " ".repeat(Math.max(0, contentWidth - visibleWidth(right)));
			rows.push(padding + leading + right + padding);
		}
		// Breathing room between the header block and the prompt bar.
		rows.push("");
		return rows;
	}

	invalidate(): void {
		// Read live recap and effort values on every render.
	}
}
