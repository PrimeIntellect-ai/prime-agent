import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface TopBarOptions {
	getChatName: () => string | undefined;
	/** Total session spend in USD (branch total, subagents included). */
	getCostUsd?: () => number | undefined;
	/** /speed readout: output tok/sec for the latest response plus the session average. */
	getSpeedText?: () => string | undefined;
}

/**
 * Pinned top bar for fullscreen chats: the optional /speed tok/sec readout
 * flush left, the chat name centered in plain text on the terminal background,
 * and the session's spend beside it. Rendered as the fullscreen viewport's
 * pinned header, so it stays on screen in every scroll position.
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
		// Strip terminal control characters (C0, DEL, C1): a persisted session
		// name could carry escape sequences that would execute on every bar
		// repaint. Then collapse all whitespace: an embedded newline in the
		// name would emit multiple rows and break the fixed fullscreen frame.
		const name = (this.options.getChatName() ?? "")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		// The name stays centered; the cost trails it with a small gap. The speed
		// readout, when on, leads the line in the cost's dim style, so it reads as
		// telemetry on the bar rather than part of the title. The name is pushed
		// right only when centering would collide with that leading readout.
		const speedText = this.options.getSpeedText?.();
		const speed = speedText ? theme.fg("dim", speedText) : "";
		// A chat with no name (no session name, no cwd basename) shows the readout
		// alone; with neither, the bar stays a blank row rather than a padded one.
		if (!name && !speed) {
			return [""];
		}
		const nameWidth = visibleWidth(name);
		const speedWidth = speedText ? visibleWidth(speedText) : 0;
		const cost = this.options.getCostUsd?.();
		const costText =
			typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? theme.fg("dim", `$${cost.toFixed(2)}`) : "";
		const centered = Math.max(0, Math.floor((safeWidth - nameWidth) / 2));
		const nameStart = Math.max(centered, speedWidth ? speedWidth + 2 : 0);
		const title = name ? `${" ".repeat(Math.max(0, nameStart - speedWidth))}${theme.fg("text", name)}` : "";
		// The spend only trails a name: without one, the readout stands alone.
		const line = `${speed}${title}${name && costText ? `  ${costText}` : ""}`;
		return [truncateToWidth(line, safeWidth, "")];
	}
}
