import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface TopBarOptions {
	getChatName: () => string | undefined;
	/** Total session spend in USD (branch total, subagents included). */
	getCostUsd?: () => number | undefined;
}

/**
 * Pinned top bar for fullscreen chats: the chat name centered in plain text on
 * the terminal background, with the session's spend beside it. Rendered as the
 * fullscreen viewport's pinned header, so it stays on screen in every scroll
 * position.
 */
export class TopBar implements Component {
	private readonly options: TopBarOptions;

	constructor(options: TopBarOptions) {
		this.options = options;
	}

	invalidate(): void {
		// Render output is derived from live session state via getters.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// Collapse all whitespace: an embedded newline in the name would emit
		// multiple rows and break the fixed fullscreen frame.
		const name = (this.options.getChatName() ?? "").replace(/\s+/g, " ").trim();
		if (!name) {
			return [""];
		}
		// Center the name; the cost trails it with a small gap. No background,
		// no rules: the bar should read as plain text on the terminal.
		const nameWidth = visibleWidth(name);
		const cost = this.options.getCostUsd?.();
		const costText =
			typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? theme.fg("dim", `$${cost.toFixed(2)}`) : "";
		const start = Math.max(0, Math.floor((safeWidth - nameWidth) / 2));
		const line = `${" ".repeat(start)}${theme.fg("text", name)}${costText ? `  ${costText}` : ""}`;
		return [truncateToWidth(line, safeWidth, "")];
	}
}
