import { Box, type Component, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { parseSlashCommand } from "../../../core/slash-commands.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { PromptTokenMask } from "./prompt-highlight.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class HighlightedMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly mask: PromptTokenMask;

	constructor(text: string, markdownTheme: MarkdownTheme, commandEnd = 0) {
		this.mask = new PromptTokenMask(text, commandEnd);
		this.markdown = new Markdown(this.mask.text, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	render(width: number): string[] {
		this.mask.reset();
		return this.markdown.render(width).map((line) => this.mask.restoreLine(line));
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
	) {
		super();
		const command = parseSlashCommand(text);
		const commandEnd = command && isRecognizedSlashCommand(command.name) ? command.name.length + 1 : 0;
		this.contentBox = new Box(2, 1, (content: string) => theme.getUserMessageBackgroundColor()(content));
		this.contentBox.addChild(new HighlightedMarkdown(text, markdownTheme, commandEnd));
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
