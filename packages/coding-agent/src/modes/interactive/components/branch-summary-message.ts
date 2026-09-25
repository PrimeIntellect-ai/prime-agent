import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, type EventView, ExpandableEventMessage } from "./expandable-event-message.js";

/** Branch summary with the full markdown available on demand. */
export class BranchSummaryMessageComponent extends ExpandableEventMessage {
	constructor(
		private readonly message: BranchSummaryMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected override view(): EventView {
		return {
			header: `${customMessageLabel("branch")} ${theme.fg("customMessageText", "Branch summary")}`,
			body: this.expanded
				? new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: undefined,
		};
	}
}
