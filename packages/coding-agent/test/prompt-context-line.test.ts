import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { PromptContextLine } from "../src/modes/interactive/components/prompt-context-line.js";
import { initTheme, preloadCodeHighlighter, theme } from "../src/modes/interactive/theme/theme.js";

describe("PromptContextLine", () => {
	beforeAll(async () => {
		initTheme("dark");
		await preloadCodeHighlighter();
	});

	it.each(["dark", "light"])("stacks recap and effort rows with breathing room in the %s theme", (name) => {
		initTheme(name);
		const line = new PromptContextLine(
			() => "Updated the prompt layout",
			() => theme.fg("dim", "high · /effort"),
		);
		const rows = line.render(80);

		expect(rows).toHaveLength(4);
		expect(stripAnsi(rows[0]!)).toBe(" Recap: Updated the prompt layout".padEnd(80));
		expect(rows[1]).toBe("");
		expect(stripAnsi(rows[2]!)).toBe(`${"high · /effort".padStart(79)} `);
		expect(rows[3]).toBe("");
		expect(visibleWidth(rows[0]!)).toBe(80);
		expect(visibleWidth(rows[2]!)).toBe(80);
		expect(rows[0]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
	});

	it("keeps effort aligned right above the prompt", () => {
		const line = new PromptContextLine(
			() => undefined,
			() => "high · /effort",
		);

		const rows = line.render(40);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0]!)).toBe(`${"high · /effort".padStart(39)} `);
		expect(rows[1]).toBe("");
	});

	it("uses the full row for recap when the model does not support effort", () => {
		const line = new PromptContextLine(
			() => "Updated files\n  and checked the result",
			() => undefined,
		);

		const rows = line.render(48);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0]!).trim()).toBe("Recap: Updated files and checked the result");
		expect(visibleWidth(rows[0]!)).toBe(48);
		expect(rows[1]).toBe("");
	});

	it("keeps long Unicode recaps and effort within narrow terminal widths", () => {
		const line = new PromptContextLine(
			() => "Updated 界面 files and checked the résumé with a long recap",
			() => theme.fg("dim", "xhigh · /effort"),
		);

		for (const width of [1, 2, 3, 4, 8, 16, 24, 40, 80, 120]) {
			const rows = line.render(width);
			expect(rows).toHaveLength(4);
			expect(visibleWidth(rows[0]!)).toBe(width);
			expect(visibleWidth(rows[2]!)).toBe(width);
			expect(stripAnsi(rows[2]!)).toContain("x");
			if (width >= 40) {
				expect(stripAnsi(rows[0]!)).toMatch(/^ Recap: .+$/);
				expect(stripAnsi(rows[2]!)).toMatch(/^ *xhigh · \/effort $/);
			}
		}
	});

	it("does not reserve a row when neither recap nor effort is available", () => {
		const line = new PromptContextLine(
			() => "  ",
			() => undefined,
		);

		expect(line.render(80)).toEqual([]);
		expect(line.render(0)).toEqual([]);
	});
});
