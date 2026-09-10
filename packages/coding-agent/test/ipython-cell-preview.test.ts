import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme, preloadCodeHighlighter, theme } from "../src/modes/interactive/theme/theme.js";

type CellState = ConstructorParameters<typeof IPythonCellComponent>[0];

/**
 * The collapsed summary row shows a one-line code preview next to the status
 * marker. It renders plain and dim (matching the quieted thinking trace) so it
 * reads as metadata; the expanded block keeps full highlighting.
 */
describe("IPythonCellComponent collapsed preview styling", () => {
	let previousColorTerm: string | undefined;

	beforeAll(async () => {
		previousColorTerm = process.env.COLORTERM;
		await preloadCodeHighlighter();
	});

	afterAll(() => {
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
	});

	function useTruecolor(): void {
		process.env.COLORTERM = "truecolor";
		initTheme("dark");
	}

	function renderCell(state: CellState): string {
		return new IPythonCellComponent(state).render(100).join("\n");
	}

	it("renders the collapsed python preview plain and dim, without syntax colors", () => {
		useTruecolor();
		const raw = renderCell({
			code: 'print("hello world")',
			content: [{ type: "text", text: "hello world" }],
			details: { status: "ok", durationMs: 12, stdout: "hello world" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		expect(raw).toContain(theme.fg("dim", 'print("hello world")'));
		expect(raw).not.toContain(theme.getFgAnsi("syntaxString"));
	});

	it("renders the collapsed bash preview dim instead of bash-mode green", () => {
		useTruecolor();
		const raw = renderCell({
			code: "!git status --short",
			content: [{ type: "text", text: "ok" }],
			details: { status: "ok", durationMs: 12, stdout: "ok" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		expect(raw).toContain(theme.fg("dim", "!git status --short"));
		expect(raw).not.toContain(theme.fg("bashMode", "!git status --short"));
	});

	it("keeps syntax highlighting on the expanded python code block", () => {
		useTruecolor();
		const raw = renderCell({
			code: 'print("hello world")',
			content: [{ type: "text", text: "hello world" }],
			details: { status: "ok", durationMs: 12, stdout: "hello world" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(raw).toContain(theme.getFgAnsi("syntaxString"));
	});

	it("keeps bash-mode green on the expanded bash code block", () => {
		useTruecolor();
		const raw = renderCell({
			code: "!git status --short",
			content: [{ type: "text", text: "ok" }],
			details: { status: "ok", durationMs: 12, stdout: "ok" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(raw).toContain(theme.fg("bashMode", "!git status --short"));
	});
});
