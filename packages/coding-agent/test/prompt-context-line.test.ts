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
		"shares one plain row between recap and detail status with one blank line above the context row in the %s theme",
		(name) => {
			initTheme(name);
			const line = new PromptContextLine(
				() => "Updated the prompt layout",
				() => theme.fg("dim", "Collapsed mode (Ctrl+O to expand)"),
			);
			const rows = line.render(80);

			expect(rows).toHaveLength(2);
			expect(stripAnsi(rows[1]!)).toMatch(
				/^ Recap: Updated the prompt layout\s{2,}Collapsed mode \(Ctrl\+O to expand\) $/,
			);
			expect(rows[0]).toBe("");
			expect(visibleWidth(rows[1]!)).toBe(80);
			expect(rows[1]).not.toMatch(/\x1b\[(?:4\d|10[0-7])(?:;[\d;]*)?m/);
		},
	);

	it("keeps detail status aligned right above the prompt", () => {
		const line = new PromptContextLine(
			() => undefined,
			() => "Collapsed mode (Ctrl+O to expand)",
		);

		const rows = line.render(40);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[1]!)).toBe(`${"Collapsed mode (Ctrl+O to expand)".padStart(39)} `);
		expect(rows[0]).toBe("");
	});

	it("uses the full row for recap when the status is unavailable", () => {
		const line = new PromptContextLine(
			() => "Updated files\n  and checked the result",
			() => undefined,
		);

		const rows = line.render(48);
		expect(rows).toHaveLength(2);
		expect(stripAnsi(rows[1]!).trim()).toBe("Recap: Updated files and checked the result");
		expect(visibleWidth(rows[1]!)).toBe(48);
		expect(rows[0]).toBe("");
	});

	it("keeps long Unicode recaps and detail status within narrow terminal widths", () => {
		const line = new PromptContextLine(
			() => "Updated 界面 files and checked the résumé with a long recap",
			() => theme.fg("dim", "Details mode"),
		);

		for (const width of [1, 2, 3, 4, 8, 16, 24, 40, 80, 120]) {
			const rows = line.render(width);
			const plain = stripAnsi(rows[1]!);
			expect(rows).toHaveLength(2);
			expect(visibleWidth(rows[1]!)).toBe(width);
			expect(plain).toContain("D");
			expect(rows[0]).toBe("");
			if (width >= 40) {
				expect(plain).toMatch(/^ Recap: .+ {2,}Details mode $/);
			}
		}
	});

	it("fits detail status beside recap while preserving the recap and narrow widths", () => {
		const line = new PromptContextLine(
			() => "Updated the interface",
			() => theme.fg("dim", "All output mode (Ctrl+O to collapse)"),
		);
		expect(stripAnsi(line.render(100)[1]!)).toMatch(
			/^ Recap: Updated the interface\s{2,}All output mode \(Ctrl\+O to collapse\) $/,
		);
		for (const width of [1, 2, 3, 8, 24, 40, 80]) {
			const rows = line.render(width);
			expect(rows).toHaveLength(2);
			expect(visibleWidth(rows[1]!)).toBe(width);
			expect(rows[0]).toBe("");
		}
	});

	it("reserves the full detail status before ellipsizing the recap", () => {
		const metadata = "All output mode (Ctrl+O to collapse)";
		const line = new PromptContextLine(
			() => "Updated the interface and verified all of the layout changes",
			(maxWidth) => {
				expect(maxWidth).toBeGreaterThanOrEqual(visibleWidth(metadata));
				return metadata;
			},
		);

		const rows = line.render(56);
		expect(rows[0]).toBe("");
		expect(stripAnsi(rows[1]!)).toMatch(/^ Recap: .+… {2}All output mode \(Ctrl\+O to collapse\) $/);
		expect(visibleWidth(rows[1]!)).toBe(56);
	});

	it("does not reserve a row when neither recap nor status is available", () => {
		const line = new PromptContextLine(
			() => "  ",
			() => undefined,
		);

		expect(line.render(80)).toEqual([]);
		expect(line.render(0)).toEqual([]);
	});
});
