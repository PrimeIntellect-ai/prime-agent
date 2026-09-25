import type { TextContent } from "@earendil-works/pi-ai";
import { Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.js";
import type { CustomMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { customMessageLabel, type EventView, ExpandableEventMessage } from "./expandable-event-message.js";

/** Generic [customType] message; an extension renderer replaces the whole display. */
export class CustomMessageComponent extends ExpandableEventMessage {
	constructor(
		private readonly message: CustomMessage<unknown>,
		private readonly customRenderer?: MessageRenderer,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super(true);
		this.updateDisplay();
	}

	protected override updateDisplay(): void {
		if (this.customRenderer) {
			try {
				const custom = this.customRenderer(this.message, { expanded: this.expanded }, theme);
				if (custom) {
					this.clear();
					this.addChild(new Spacer(1));
					this.addChild(custom);
					return;
				}
			} catch {
				// Fall back to the default renderer.
			}
		}
		super.updateDisplay();
	}

	protected override view(): EventView {
		const text =
			typeof this.message.content === "string"
				? this.message.content
				: this.message.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		return {
			header: customMessageLabel(this.message.customType),
			body: new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		};
	}
}
