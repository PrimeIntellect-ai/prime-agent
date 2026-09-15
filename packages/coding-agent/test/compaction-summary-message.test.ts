import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../src/core/messages.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { initTheme, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";

const FOREGROUND_COLOR = /\x1b\[(?:38;2;\d+;\d+;\d+|38;5;\d+|3[0-7]|9[0-7])m/g;

const SUMMARY = [
	"### Heading three",
	"",
	"- bullet with `inline code` and [a link](http://example.com)",
	"",
	"```python",
	'value = json.loads("payload")',
	"```",
	"",
	"> quoted note",
].join("\n");

function foregroundColors(lines: string[]): Set<string> {
	return new Set(lines.join("\n").match(FOREGROUND_COLOR) ?? []);
}

function colorOf(name: ThemeColor): string {
	const [color] = foregroundColors([theme.fg(name, "x")]);
	if (!color) {
		throw new Error(`${name} must resolve to an explicit color`);
	}
	return color;
}

function compactionCard(summary: string, customInstructions?: string): CompactionSummaryMessageComponent {
	const message = createCompactionSummaryMessage(summary, 120_000, new Date(0).toISOString(), customInstructions);
	return new CompactionSummaryMessageComponent(message);
}

describe("CompactionSummaryMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("renders the expanded summary as notice text, not as highlighted source", () => {
		const component = compactionCard(SUMMARY);
		component.setExpanded(true);

		const lines = component.render(100);
		expect(foregroundColors(lines)).toEqual(
			new Set([colorOf("refinementHeader"), colorOf("refinementSummary"), colorOf("dim")]),
		);

		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("Heading three");
		expect(text).toContain("inline code");
		expect(text).toContain('value = json.loads("payload")');
		expect(text).toContain("quoted note");
	});

	test("clamps focus instructions that arrive as one long line", () => {
		const instructions = "Prioritize the new task. ".repeat(200);
		const component = compactionCard("Body.", instructions);
		component.setExpanded(true);

		const lines = component.render(100);
		const metadata = lines.filter((line) => stripAnsi(line).includes("focus:") || stripAnsi(line).includes("task."));
		expect(metadata.length).toBeLessThanOrEqual(3);
		expect(stripAnsi(metadata.at(-1) ?? "")).toContain("…");
		expect(stripAnsi(lines.join("\n"))).toContain("Compacted from 120,000 tokens · focus:");
	});

	test("keeps the collapsed card short regardless of focus length", () => {
		const component = compactionCard(SUMMARY, "Prioritize the new task. ".repeat(200));

		const lines = component.render(100);
		expect(lines.length).toBeLessThanOrEqual(3);
		expect(stripAnsi(lines.join("\n"))).not.toContain("focus:");
	});
});

describe("BranchSummaryMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("renders the expanded summary as notice text, not as highlighted source", () => {
		const component = new BranchSummaryMessageComponent(
			createBranchSummaryMessage(SUMMARY, "from-id", new Date(0).toISOString()),
		);
		component.setExpanded(true);

		expect(foregroundColors(component.render(100))).toEqual(new Set([colorOf("customMessageLabel")]));
	});
});
