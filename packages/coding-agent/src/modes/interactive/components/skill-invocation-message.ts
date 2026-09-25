import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/skill-blocks.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, type EventView, ExpandableEventMessage } from "./expandable-event-message.js";

/** Skill invocation card; the user message is rendered separately. */
export class SkillInvocationMessageComponent extends ExpandableEventMessage {
	constructor(
		private readonly skillBlock: ParsedSkillBlock,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected override view(): EventView {
		return {
			header: `${customMessageLabel("skill")} ${theme.fg("customMessageText", this.skillBlock.name)}`,
			body: this.expanded
				? new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: undefined,
		};
	}
}
