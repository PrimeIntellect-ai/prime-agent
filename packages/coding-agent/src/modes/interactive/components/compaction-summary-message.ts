import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { type EventView, ExpandableEventMessage } from "./expandable-event-message.js";

/** Compact context outcome with the full markdown summary available on demand. */
export class CompactionSummaryMessageComponent extends ExpandableEventMessage {
	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected override view(): EventView {
		const header = theme.fg("refinementHeader", "◆ Context compacted");
		const summary = this.message.summary.trim()
			? this.message.summary
			: "No summary was recorded for this compaction.";
		if (!this.expanded) {
			return { header, preview: { text: summary, color: "refinementSummary" } };
		}
		const focus = this.message.customInstructions ? ` · focus: ${this.message.customInstructions}` : "";
		return {
			header,
			metadata: `Compacted from ${this.message.tokensBefore.toLocaleString()} tokens${focus}`,
			body: new Markdown(summary, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("refinementSummary", text),
			}),
		};
	}
}
