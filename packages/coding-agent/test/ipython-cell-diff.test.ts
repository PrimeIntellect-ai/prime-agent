import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderRichDiff } from "../src/modes/interactive/components/diff.js";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme, preloadCodeHighlighter, theme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function hasBackground(line: string): boolean {
	return /\x1b\[4[0-9]m|\x1b\[48[;:]/.test(line);
}

type ThemeFg = Parameters<typeof theme.fg>[0];
type ThemeBg = Parameters<typeof theme.bg>[0];

function fgAnsi(color: ThemeFg): string {
	return theme.fg(color, "").replace(/\x1b\[39m$/, "");
}

function bgAnsi(color: ThemeBg): string {
	return theme.bg(color, "").replace(/\x1b\[49m$/, "");
}

function changedRow(rows: readonly string[], prefix: "+" | "-"): string {
	const row = rows.find((line) => stripAnsi(line).startsWith(` 1 ${prefix} `));
	expect(row).toBeDefined();
	return row ?? "";
}

function renderCell(state: ConstructorParameters<typeof IPythonCellComponent>[0]): string {
	return stripAnsi(new IPythonCellComponent(state).render(80).join("\n"));
}

describe("IPythonCellComponent diff rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a diff with absolute line numbers and suppresses the Edited confirmation", () => {
		const out = renderCell({
			code: 'await edit(path="sample.py", old_str="gamma", new_str="GAMMA")',
			details: {
				status: "ok",
				durationMs: 12,
				// IPython reprs the returned string, so the confirmation arrives quoted.
				result: "'Edited sample.py'",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 10 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		// Header carries the path (no "edit" label) and the +/- line counts.
		expect(out).toContain("sample.py");
		expect(out).not.toMatch(/edit sample\.py/);
		expect(out).toMatch(/\+1\s+-1/);
		// Removed line keeps the old line number; added line the new one.
		expect(out).toMatch(/11 - .*gamma/);
		expect(out).toMatch(/11 \+ .*GAMMA/);
		expect(out).toMatch(/10 .*alpha/);
		// The redundant "Edited sample.py" confirmation must not render as its own line.
		expect(out.split("\n").some((line) => /^\s*'?Edited sample\.py'?\s*$/.test(line.trim()))).toBe(false);
		// Expanded edit cells still show the full source that produced the diff.
		expect(out).toContain('await edit(path="sample.py", old_str="gamma", new_str="GAMMA")');
	});

	it("renders diff rows as full-width colored blocks", () => {
		const width = 72;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(width);
		const diffRows = lines.filter((line) => /alpha|gamma|GAMMA/.test(stripAnsi(line)));
		expect(diffRows.length).toBeGreaterThan(0);
		// Each changed row is a background block spanning the full width.
		expect(diffRows.every((line) => visibleWidth(line) === width)).toBe(true);
		expect(diffRows.some(hasBackground)).toBe(true);
	});

	it("prefixes the header with the cell's status marker and aligns it with the summary line", () => {
		const done = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).split("\n");
		// Summary line and header share the same single-space indent.
		expect(done[0]).toMatch(/^ ✓ python/);
		expect(done.find((l) => l.includes("a.ts"))).toMatch(/^ ✓ a\.ts/);

		const failed = renderCell({
			code: "await edit(...)",
			details: { status: "error", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			isError: true,
		});
		expect(failed).toMatch(/✗ a\.ts/);
	});

	it("renders an edit path relative to the session cwd, or absolute when outside it", () => {
		const cwd = "/home/me/project";
		const inside = renderCell({
			code: "await edit(...)",
			cwd,
			details: { status: "ok", diffs: [{ path: `${cwd}/src/app.ts`, oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(inside).toContain("src/app.ts");
		expect(inside).not.toContain(`${cwd}/src/app.ts`);

		const outside = renderCell({
			code: "await edit(...)",
			cwd,
			details: { status: "ok", diffs: [{ path: "/etc/hosts", oldStr: "a", newStr: "b", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(outside).toContain("/etc/hosts");
	});

	it("wraps a long diff line across rows without truncating or overflowing the width", () => {
		const width = 92;
		const longLine = `const x = ${Array.from({ length: 30 }, (_, i) => `arg${i}`).join(", ")};`;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "const x = 1;", newStr: longLine, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(width);

		// No rendered row may exceed the terminal width (the TUI throws if one does).
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		// The full content survives across the wrapped rows (nothing truncated away).
		const joined = lines.map(stripAnsi).join("");
		expect(joined).toContain("arg0");
		expect(joined).toContain("arg29");
		// The added line spilled onto at least one continuation row.
		expect(lines.filter((line) => /arg\d/.test(stripAnsi(line))).length).toBeGreaterThan(1);
	});

	it("truncates a long header path so it never overflows the width, keeping the counts", () => {
		const width = 40;
		const longPath = `src/${"very-long-directory-name/".repeat(8)}file.ts`;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: longPath, oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const header = lines.map(stripAnsi).find((line) => line.includes("…"));
		expect(header).toBeDefined();
		// The +/- counts survive truncation; only the path is shortened.
		expect(header).toMatch(/\+1 -1\s*$/);
	});

	it("renders a large diff without spreading the row array (no RangeError)", () => {
		const n = 5000;
		const oldStr = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
		const newStr = Array.from({ length: n }, (_, i) => `LINE ${i}`).join("\n");
		expect(() =>
			new IPythonCellComponent({
				code: "await edit(...)",
				details: { status: "ok", diffs: [{ path: "big.txt", oldStr, newStr, startLine: 1 }] },
				executionStarted: true,
				argsComplete: true,
				expanded: true,
			}).render(80),
		).not.toThrow();
	});

	it("uses a blank hanging gutter for wrapped diff rows", () => {
		const longLine = `const x = ${Array.from({ length: 20 }, (_, i) => `arg${i}`).join(", ")};`;
		const out = renderCell({
			code: "await edit(...) ",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "const x = 1;", newStr: longLine, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).split("\n");
		const addedRows = out.filter((line) => /arg\d/.test(line));
		expect(addedRows.length).toBeGreaterThan(1);
		expect(addedRows[0]).toMatch(/\d+ \+ /);
		expect(addedRows.slice(1).every((line) => !line.includes("+"))).toBe(true);
	});

	it("renders expanded source before the always-visible diff", () => {
		const out = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 4, diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).split("\n");
		expect(out[0]).toContain("to collapse");
		expect(out[1].trim()).toBe("");
		expect(out[2]).toContain("await edit(...)");
		expect(out.findIndex((line) => line.includes("a.ts"))).toBeGreaterThan(2);
	});

	it("shows the full diff when collapsed", () => {
		const collapsed = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "big.py", oldStr: "old", newStr: "NEW", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("big.py");
		expect(collapsed).not.toContain("old");
		expect(collapsed).not.toContain("NEW");
	});

	it("hides edit source when collapsed and shows it when globally expanded", () => {
		const state = {
			code: 'hidden_side_effect = "only in full source"\nawait edit(path="a.py", old_str="old", new_str="new")',
			details: { status: "ok", diffs: [{ path: "a.py", oldStr: "old", newStr: "new", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
		};
		const collapsed = renderCell({ ...state, expanded: false });
		const expanded = renderCell({ ...state, expanded: true });

		expect(collapsed).not.toContain("hidden_side_effect");
		expect(collapsed).toContain("a.py");
		expect(expanded).toContain('hidden_side_effect = "only in full source"');
		expect(expanded).toContain("a.py");
		const expandedLines = expanded.split("\n");
		expect(expandedLines.findIndex((line) => line.includes("hidden_side_effect ="))).toBeLessThan(
			expandedLines.findIndex((line) => /✓ a\.py\s+\+1 -1/.test(line)),
		);
	});

	it("keeps non-edit cells collapsed to a single summary line", () => {
		const collapsed = renderCell({
			code: "print('hello')",
			details: { status: "ok", durationMs: 3, stdout: "hello\nworld\nmore\noutput\nlines" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		// No diffs → the collapsed view stays a single line; output hides behind expand.
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("world");
	});

	it("coalesces multiple edits to one file into a single block with hunk separators", () => {
		const out = renderCell({
			code: "await edit(...); await edit(...); await edit(...)",
			expanded: true,
			details: {
				status: "ok",
				diffs: [
					{ path: "app.py", oldStr: "a = 1", newStr: "a = 2", startLine: 1 },
					{ path: "app.py", oldStr: "b = 1", newStr: "b = 2", startLine: 50 },
					{ path: "app.py", oldStr: "c = 1", newStr: "c = 2", startLine: 90 },
				],
			},
			executionStarted: true,
			argsComplete: true,
		});
		// One consolidated header for the file, with summed counts.
		expect(out.split("\n").filter((l) => l.includes("app.py")).length).toBe(1);
		expect(out).toMatch(/app\.py\s+\+3\s+-3/);
		// Hunks are separated by the vertical-ellipsis marker.
		expect((out.match(/⋮/g) ?? []).length).toBe(2);
	});

	it("keeps the top line stable when expanded — only the hint flips, no header line, no layout shift", () => {
		const state = {
			code: "print(55)",
			content: [{ type: "text", text: "55" }],
			details: { status: "ok", durationMs: 780_000 },
			executionStarted: true,
			argsComplete: true,
		};
		const collapsed = new IPythonCellComponent({ ...state, expanded: false }).render(80);
		const expanded = new IPythonCellComponent({ ...state, expanded: true }).render(80);

		// Top line is unchanged through the duration; only the trailing hint flips
		// "to expand" → "to collapse", so nothing before it can shift.
		expect(stripAnsi(collapsed[0])).toMatch(/^ ✓ python · .* · ↑ 1 ↓ 1 lines · 780\.0s · \(.*to expand\)$/);
		expect(stripAnsi(expanded[0])).toMatch(/^ ✓ python · .* · ↑ 1 ↓ 1 lines · 780\.0s · \(.*to collapse\)$/);
		const upToHint = (line: string) => stripAnsi(line).replace(/· \([^·]*to (expand|collapse)\)$/, "");
		expect(upToHint(expanded[0])).toBe(upToHint(collapsed[0]));

		// No separate "python · done · 780.0s" header line below the top line.
		const stripped = expanded.map(stripAnsi);
		expect(stripped.filter((l) => /python · done/.test(l)).length).toBe(0);

		// Expanding only attaches code + output below, backgroundless like the top.
		expect(stripped.join("\n")).toContain("print(55)");
		expect(stripped.join("\n")).toContain("55");
		expect(expanded.some(hasBackground)).toBe(false);
	});

	it("does not show a 'no output' line under an edit-only diff", () => {
		const out = renderCell({
			code: 'await edit(path="a.ts", old_str="x", new_str="X")',
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(out).toContain("a.ts");
		expect(out).not.toContain("no output");
	});

	it("never emits a line wider than the viewport, even in a very narrow pane", () => {
		for (const width of [1, 2, 3, 5, 8]) {
			const lines = new IPythonCellComponent({
				code: "import numpy as np\nresult = np.linspace(0, 100, 50)",
				content: [{ type: "text", text: "a fairly long line of output that must wrap" }],
				details: { status: "ok", durationMs: 12, stdout: "a fairly long line of output that must wrap" },
				executionStarted: true,
				argsComplete: true,
				expanded: true,
			}).render(width);
			expect(
				lines.every((line) => visibleWidth(line) <= width),
				`width=${width}`,
			).toBe(true);
		}
	});
});

describe("renderRichDiff syntax highlighting", () => {
	let previousColorTerm: string | undefined;
	let previousTerm: string | undefined;
	let previousWtSession: string | undefined;

	beforeAll(async () => {
		previousColorTerm = process.env.COLORTERM;
		previousTerm = process.env.TERM;
		previousWtSession = process.env.WT_SESSION;
		await preloadCodeHighlighter();
	});

	afterAll(() => {
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
		if (previousTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = previousTerm;
		}
		if (previousWtSession === undefined) {
			delete process.env.WT_SESSION;
		} else {
			process.env.WT_SESSION = previousWtSession;
		}
		initTheme("dark");
	});

	function useTruecolor(themeName: "dark" | "light" = "dark"): void {
		process.env.COLORTERM = "truecolor";
		process.env.TERM = "xterm-256color";
		initTheme(themeName);
	}

	function use256Color(): void {
		delete process.env.COLORTERM;
		delete process.env.WT_SESSION;
		process.env.TERM = "dumb";
		initTheme("dark");
	}

	it("keeps syntax token foregrounds on truecolor added and removed backgrounds", () => {
		useTruecolor();
		const rows = renderRichDiff("-1 const answer: number = 1;\n+1 const answer: number = 2;", 72, {
			language: "typescript",
		});
		const removed = changedRow(rows, "-");
		const added = changedRow(rows, "+");

		expect(removed).toContain(bgAnsi("toolDiffRemovedBg"));
		expect(added).toContain(bgAnsi("toolDiffAddedBg"));
		for (const row of [removed, added]) {
			expect(row).toContain(fgAnsi("syntaxKeyword"));
			expect(row).toContain(fgAnsi("syntaxType"));
			expect(row).toContain(fgAnsi("syntaxNumber"));
			expect(row).not.toContain(fgAnsi("toolDiffText"));
		}
	});

	it("uses the code-block foreground when the language is unknown", () => {
		useTruecolor();
		const rows = renderRichDiff("-1 old value\n+1 new value", 48, { language: "not-a-language" });

		expect(changedRow(rows, "-")).toContain(fgAnsi("mdCodeBlock"));
		expect(changedRow(rows, "+")).toContain(fgAnsi("mdCodeBlock"));
	});

	it("keeps the flat red and green fallback in 256-color mode", () => {
		use256Color();
		const rows = renderRichDiff("-1 const answer: number = 1;\n+1 const answer: number = 2;", 72, {
			language: "typescript",
		});
		const removed = changedRow(rows, "-");
		const added = changedRow(rows, "+");

		expect(removed).toContain(bgAnsi("toolPanelBg"));
		expect(removed).toContain(fgAnsi("toolDiffRemoved"));
		expect(added).toContain(bgAnsi("toolPanelBg"));
		expect(added).toContain(fgAnsi("toolDiffAdded"));
		expect(removed).not.toContain(fgAnsi("syntaxKeyword"));
		expect(added).not.toContain(fgAnsi("syntaxKeyword"));
	});

	it("preserves themed syntax and the diff background across wrapped rows", () => {
		const source = `const values: number[] = [${Array.from({ length: 20 }, (_, index) => index).join(", ")}];`;
		for (const themeName of ["dark", "light"] as const) {
			useTruecolor(themeName);
			const keyword = fgAnsi("syntaxKeyword");
			const background = bgAnsi("toolDiffAddedBg");
			const rows = renderRichDiff(`+1 ${source}`, 28, { language: "typescript" });

			expect(rows.length).toBeGreaterThan(1);
			expect(rows.map(stripAnsi).join("")).toContain("19");
			for (const row of rows) {
				expect(visibleWidth(row)).toBe(28);
				expect(row).toContain(background);
				expect(row).not.toContain("\x1b[0m");
				expect(row.match(/\x1b\[49m/g)).toHaveLength(1);
				expect(row.endsWith("\x1b[49m")).toBe(true);
			}
			expect(rows.join("")).toContain(keyword);
		}
	});
});
