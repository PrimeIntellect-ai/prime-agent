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

	it.each(["dark", "light"])(
		"shares one plain row between recap and model/effort/context with one blank line above the prompt in the %s theme",
		(name) => {
			initTheme(name);
			const line = new PromptContextLine(
				() => "Updated the prompt layout",
				() => theme.fg("dim", "GLM 5.3 · high · 175k (44%)"),
			);
			const rows = line.render(80);

			expect(rows).toHaveLength(2);
			expect(stripAnsi(rows[0]!)).toMatch(/^ Recap: Updated the prompt layout\s{2,}GLM 5.3 · high · 175k \(44%\) $/);
			expect(rows[1]).toBe("");
			expect(visibleWidth(rows[0]!)).toBe(80);
			expect(rows[0]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
		},
	);

	it("keeps model, effort, and context usage aligned right above the prompt", () => {
		const line = new PromptContextLine(
			() => undefined,
			() => "GLM 5.3 · high · 175k (44%)",
		);

		const rows = line.render(40);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[0]!)).toBe(`${"GLM 5.3 · high · 175k (44%)".padStart(39)} `);
		expect(rows[1]).toBe("");
	});

	it("uses the full row for recap when the model is unavailable", () => {
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

	it("keeps long Unicode recaps and model/effort within narrow terminal widths", () => {
		const line = new PromptContextLine(
			() => "Updated 界面 files and checked the résumé with a long recap",
			() => theme.fg("dim", "GLM 5.3 · xhigh"),
		);

		for (const width of [1, 2, 3, 4, 8, 16, 24, 40, 80, 120]) {
			const rows = line.render(width);
			const plain = stripAnsi(rows[0]!);
			expect(rows).toHaveLength(2);
			expect(visibleWidth(rows[0]!)).toBe(width);
			expect(plain).toContain("G");
			expect(rows[1]).toBe("");
			if (width >= 40) {
				expect(plain).toMatch(/^ Recap: .+ {2,}GLM 5.3 · xhigh $/);
			}
		}
	});

	it("fits context usage beside the model while preserving the recap and narrow widths", () => {
		const line = new PromptContextLine(
			() => "Updated the interface",
			() => theme.fg("dim", "GLM 5.3 Fast · high · 175k (44%)"),
		);
		expect(stripAnsi(line.render(100)[0]!)).toMatch(
			/^ Recap: Updated the interface\s{2,}GLM 5.3 Fast · high · 175k \(44%\) $/,
		);
		for (const width of [1, 2, 3, 8, 24, 40, 80]) {
			const rows = line.render(width);
			expect(rows).toHaveLength(2);
			expect(visibleWidth(rows[0]!)).toBe(width);
			expect(rows[1]).toBe("");
		}
	});

	it("does not reserve a row when neither recap nor model is available", () => {
		const line = new PromptContextLine(
			() => "  ",
			() => undefined,
		);

		expect(line.render(80)).toEqual([]);
		expect(line.render(0)).toEqual([]);
	});
});
