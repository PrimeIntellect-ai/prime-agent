import chalk from "chalk";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { Loader } from "../src/components/loader.js";
import { Markdown } from "../src/components/markdown.js";
import { Text } from "../src/components/text.js";
import { ProcessTerminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.js";

const terminal = new ProcessTerminal();

const tui = new TUI(terminal);

tui.addChild(
	new Text("Welcome to Simple Chat!\n\nType your messages below. Type '/' for commands. Press Ctrl+C to exit."),
);

const editor = new Editor(tui, defaultEditorTheme);

const autocompleteProvider = new CombinedAutocompleteProvider(
	[
		{ name: "delete", description: "Delete the last message" },
		{ name: "clear", description: "Clear all messages" },
	],
	process.cwd(),
);
editor.setAutocompleteProvider(autocompleteProvider);

tui.addChild(editor);

tui.setFocus(editor);

let isResponding = false;

editor.onSubmit = (value: string) => {
	if (isResponding) {
		return;
	}

	const trimmed = value.trim();

	if (trimmed === "/delete") {
		const children = tui.children;
		if (children.length > 3) {
			children.splice(children.length - 2, 1);
		}
		tui.requestRender();
		return;
	}

	if (trimmed === "/clear") {
		const children = tui.children;
		children.splice(2, children.length - 3);
		tui.requestRender();
		return;
	}

	if (trimmed) {
		isResponding = true;
		editor.disableSubmit = true;

		const userMessage = new Markdown(value, 1, 1, defaultMarkdownTheme);

		const children = tui.children;
		children.splice(children.length - 1, 0, userMessage);

		const loader = new Loader(
			tui,
			(s) => chalk.cyan(s),
			(s) => chalk.dim(s),
			"Thinking...",
		);
		children.splice(children.length - 1, 0, loader);

		tui.requestRender();

		setTimeout(() => {
			tui.removeChild(loader);

			const responses = [
				"That's interesting! Tell me more.",
				"I see what you mean.",
				"Fascinating perspective!",
				"Could you elaborate on that?",
				"That makes sense to me.",
				"I hadn't thought of it that way.",
				"Great point!",
				"Thanks for sharing that.",
			];
			const randomResponse = responses[Math.floor(Math.random() * responses.length)];

			const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
			children.splice(children.length - 1, 0, botMessage);

			isResponding = false;
			editor.disableSubmit = false;

			tui.requestRender();
		}, 1000);
	}
};

tui.start();
