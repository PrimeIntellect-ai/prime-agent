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

	it.each(["dark", "light"])("shares a plain row between recap and effort in the %s theme", (name) => {
		initTheme(name);
		const line = new PromptContextLine(
			() => "Updated the prompt layout",
			() => theme.fg("dim", "high · /effort"),
		);
		const rows = line.render(80);

		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0]!)).toMatch(/^ Recap: Updated the prompt layout\s{2,}high · \/effort $/);
		expect(visibleWidth(rows[0]!)).toBe(80);
		expect(rows[0]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
	});

	it("keeps effort aligned right before the first recap", () => {
		const line = new PromptContextLine(
			() => undefined,
			() => "high · /effort",
		);

		expect(stripAnsi(line.render(40)[0]!)).toBe(`${"high · /effort".padStart(39)} `);
	});

	it("uses the full row for recap when the model does not support effort", () => {
		const line = new PromptContextLine(
			() => "Updated files\n  and checked the result",
			() => undefined,
		);

		const rendered = line.render(48)[0]!;
		expect(stripAnsi(rendered).trim()).toBe("Recap: Updated files and checked the result");
		expect(visibleWidth(rendered)).toBe(48);
	});

	it("keeps long Unicode recaps and effort within narrow terminal widths", () => {
		const line = new PromptContextLine(
			() => "Updated 界面 files and checked the résumé with a long recap",
			() => theme.fg("dim", "xhigh · /effort"),
		);

		for (const width of [1, 2, 3, 4, 8, 16, 24, 40, 80, 120]) {
			const rows = line.render(width);
			const plain = stripAnsi(rows[0]!);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBe(width);
			expect(plain).toContain("x");
			if (width >= 40) {
				expect(plain).toMatch(/^ Recap: .+ {2,}xhigh · \/effort $/);
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
