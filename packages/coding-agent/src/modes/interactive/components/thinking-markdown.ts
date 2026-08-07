import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function getThinkingMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	const quiet = (text: string) => theme.fg("thinkingText", text);
	return {
		...baseTheme,
		heading: quiet,
		link: quiet,
		linkUrl: quiet,
		code: quiet,
		codeBlock: quiet,
		codeBlockBorder: quiet,
		quote: quiet,
		quoteBorder: quiet,
		hr: quiet,
		listBullet: quiet,
		highlightCode: (code: string) => code.split("\n").map((line) => quiet(line)),
	};
}

export function createThinkingMarkdown(text: string, baseTheme: MarkdownTheme = getMarkdownTheme()): Markdown {
	return new Markdown(text.trim(), 1, 0, getThinkingMarkdownTheme(baseTheme), {
		color: (value: string) => theme.fg("thinkingText", value),
	});
}
