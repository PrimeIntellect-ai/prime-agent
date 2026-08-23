import { Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/skill-blocks.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";
import { expandCollapseHint } from "./keybinding-hints.js";

/** Skill invocation card; the user message is rendered separately. */
export class SkillInvocationMessageComponent extends ExpandableCustomMessageBox {
	constructor(
		private readonly skillBlock: ParsedSkillBlock,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		if (this.expanded) {
			this.addChild(new Text(customMessageLabel("skill"), 0, 0));
			const header = `**${this.skillBlock.name}**\n\n`;
			this.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const line =
				`${customMessageLabel("skill")} ` +
				theme.fg("customMessageText", this.skillBlock.name) +
				` ${expandCollapseHint("app.tools.expand", false)}`;
			this.addChild(new Text(line, 0, 0));
		}
	}
}
