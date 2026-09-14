import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface TopBarOptions {
	getChatName: () => string | undefined;
}

/**
 * Pinned top bar for fullscreen chats: identifies the chat by name while the
 * transcript scrolls underneath. Rendered as the fullscreen viewport's pinned
 * header, so it stays on screen in every scroll position.
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
		const name = (this.options.getChatName() ?? "").trim();
		if (!name) {
			return [""];
		}
		const label = theme.fg("accent", name);
		const lead = theme.fg("border", "─ ");
		const labelWidth = visibleWidth(name);
		const ruleWidth = Math.max(0, safeWidth - 2 - labelWidth);
		const rule = theme.fg("border", "─".repeat(ruleWidth));
		const line = `${lead}${label} ${rule}`;
		return [truncateToWidth(line, safeWidth, "")];
	}
}
