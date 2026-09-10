import { Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
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

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const instructions = this.message.customInstructions;
		const focus = instructions ? ` · focus: ${instructions}` : "";
		this.addSummary(`Compacted from ${tokenStr} tokens${focus}`, "Compaction");
		if (!this.expanded) return;

		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
