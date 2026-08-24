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

	it("renders a multiline prompt with compact option rows", () => {
		const selector = new ExtensionSelectorComponent(
			[
				"Interrupted Python cell is still running",
				"Ctrl+C sent an interrupt, but the previous cell has not stopped yet.",
				"Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables.",
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

		expect(output).toContain("Interrupted Python cell is still running");
		expect(output).toContain("Ctrl+C sent an interrupt");
		expect(output).toContain("Waiting preserves the current kernel state");
		expect(waitIndex).toBeGreaterThan(-1);
		expect(killIndex).toBe(waitIndex + 1);
		expectTrailingBackground(
			lines.find((line) => line.includes("Interrupted Python cell is still running")),
			"Interrupted Python cell is still running",
		);
		expectTrailingBackground(lines[waitIndex], "Wait and preserve state");
		expectTrailingBackground(lines[killIndex], "Kill kernel and restart");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(88);
		}
	});
});
