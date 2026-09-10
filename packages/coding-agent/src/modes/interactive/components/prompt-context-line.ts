import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/** Plain terminal row immediately above the prompt, shared by recap, model, and effort. */
export class PromptContextLine implements Component {
	constructor(
		private readonly getRecap: () => string | undefined,
		private readonly getModelLabel: (maxWidth: number) => string | undefined,
	) {}

	render(width: number): string[] {
		if (width < 1) return [];
		const paddingX = width > 2 ? 1 : 0;
		const contentWidth = width - paddingX * 2;
		const recap = this.getRecap()?.replace(/\s+/g, " ").trim();
		const left = recap ? `Recap: ${recap}` : "";
		const maxRightWidth = left ? Math.max(1, Math.floor(contentWidth / 2)) : contentWidth;
		const right = truncateToWidth(this.getModelLabel(maxRightWidth) ?? "", maxRightWidth, "");
		if (!left && !right) return [];
		const gap = left && right ? 2 : 0;
		const leftWidth = Math.max(0, contentWidth - visibleWidth(right) - gap);
		const renderedLeft = truncateToWidth(left, leftWidth, "…");
		const space = " ".repeat(Math.max(0, contentWidth - visibleWidth(renderedLeft) - visibleWidth(right)));
		const row = " ".repeat(paddingX) + theme.fg("dim", renderedLeft) + space + right + " ".repeat(paddingX);
		// One blank line of breathing room between the context line and the prompt bar.
		return [row, ""];
	}

	invalidate(): void {
		// Read live recap, model, and effort values on every render.
	}
}
