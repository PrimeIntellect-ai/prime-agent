import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		const instructions = this.message.customInstructions;
		if (this.expanded) {
			let header = `**Compacted from ${tokenStr} tokens**\n\n`;
			if (instructions) {
				header += `**Focus:** ${instructions}\n\n`;
			}
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const focus = instructions ? ` · focus: ${instructions}` : "";
			this.addChild(
				new Text(
					`${theme.fg("customMessageText", `Compacted from ${tokenStr} tokens${focus}`)} ${expandCollapseHint("app.tools.expand", false)}`,
					0,
					0,
				),
			);
		}
	}
}
