import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const BACKGROUND_START = /\x1b\[(?:4[0-8]|48;5;\d+|48;2;\d+;\d+;\d+)m/;

function expectTrailingBackground(line: string | undefined, text: string): void {
	const renderedLine = line ?? "";
	const textEnd = renderedLine.indexOf(text) + text.length;
	expect(textEnd).toBeGreaterThanOrEqual(text.length);
	expect(renderedLine.slice(textEnd)).toMatch(BACKGROUND_START);
}

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("wraps a long single-line prompt to the available width", () => {
		const prompt =
			"This long question must remain fully visible when the daemon client renders it in a narrow terminal window.";
		const selector = new ExtensionSelectorComponent(prompt, ["Yes", "No"], vi.fn(), vi.fn(), {
			getRows: () => 24,
		});

		const outputLines = selector.render(40).map((line) => stripAnsi(line));
		const promptEnd = outputLines.findIndex((line, index) => index > 1 && line.trim() === "");
		const renderedPrompt = outputLines
			.slice(1, promptEnd)
			.map((line) => line.trim())
			.join(" ");

		expect(renderedPrompt).toBe(prompt);
	});

	it("renders a multiline prompt with compact option rows", () => {
		const selector = new ExtensionSelectorComponent(
			[
				"Interrupted IPython cell is still running",
				"Ctrl+C sent an interrupt, but the previous cell has not stopped yet.",
				"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables.",
			].join("\n"),
			["Wait and preserve state", "Kill kernel and restart"],
			vi.fn(),
			vi.fn(),
			{ getRows: () => 24 },
		);

		const lines = selector.render(88);
		const outputLines = lines.map((line) => stripAnsi(line));
		const output = outputLines.join("\n");
		const waitIndex = outputLines.findIndex((line) => line.includes("Wait and preserve state"));
		const killIndex = outputLines.findIndex((line) => line.includes("Kill kernel and restart"));

		expect(output).toContain("Interrupted IPython cell is still running");
		expect(output).toContain("Ctrl+C sent an interrupt");
		expect(output).toContain("Waiting preserves the current kernel state");
		expect(waitIndex).toBeGreaterThan(-1);
		expect(killIndex).toBe(waitIndex + 1);
		expectTrailingBackground(
			lines.find((line) => line.includes("Interrupted IPython cell is still running")),
			"Interrupted IPython cell is still running",
		);
		expectTrailingBackground(lines[waitIndex], "Wait and preserve state");
		expectTrailingBackground(lines[killIndex], "Kill kernel and restart");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(88);
		}
	});
});
