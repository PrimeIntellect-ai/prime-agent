import { Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { ExpandableEventMessage } from "./expandable-event-message.js";

/** Compact context outcome with the full markdown summary available on demand. */
export class CompactionSummaryMessageComponent extends ExpandableEventMessage {
	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Text(theme.fg("refinementHeader", "◆ Context compacted"), 1, 0));
		const summary = this.message.summary.trim()
			? this.message.summary
			: "No summary was recorded for this compaction.";
		if (!this.expanded) {
			this.addSummary(summary, undefined, "refinementSummary");
			return;
		}

		this.addChild(
			new Markdown(summary, 1, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("refinementSummary", text),
			}),
		);

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const instructions = this.message.customInstructions;
		const focus = instructions ? ` · focus: ${instructions}` : "";
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `Compacted from ${tokenStr} tokens${focus}`), 1, 0));
	}
}
