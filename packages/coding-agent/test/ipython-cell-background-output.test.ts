import { beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderCell(state: ConstructorParameters<typeof IPythonCellComponent>[0]): string {
	return stripAnsi(new IPythonCellComponent(state).render(80).join("\n"));
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("IPythonCellComponent background output rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders background-only output with a label instead of 'no output'", () => {
		const out = renderCell({
			code: "run_thread()",
			content: [{ type: "text", text: "[background output (unattributed)]\norphan-line" }],
			details: { status: "ok", durationMs: 1, stdout: "", stderr: "", backgroundOutput: "orphan-line" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(countOccurrences(out, "orphan-line")).toBe(1);
		expect(out).toContain("background output (unattributed)");
		expect(out).not.toContain("no output");
	});

	it("renders stdout before background output, each exactly once", () => {
		const out = renderCell({
			code: "run_thread()",
			content: [{ type: "text", text: "main-line\n[background output (unattributed)]\nbg-line" }],
			details: { status: "ok", durationMs: 1, stdout: "main-line", stderr: "", backgroundOutput: "bg-line" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(countOccurrences(out, "main-line")).toBe(1);
		expect(countOccurrences(out, "bg-line")).toBe(1);
		const lines = out.split("\n");
		const stdoutIndex = lines.findIndex((line) => line.includes("main-line"));
		const labelIndex = lines.findIndex((line) => line.includes("background output (unattributed)"));
		expect(stdoutIndex).toBeGreaterThanOrEqual(0);
		expect(labelIndex).toBeGreaterThan(stdoutIndex);
	});

	it("renders old structured details without a background label", () => {
		const out = renderCell({
			code: "print('x')",
			content: [{ type: "text", text: "plain" }],
			details: { status: "ok", stdout: "plain" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(countOccurrences(out, "plain")).toBe(1);
		expect(out).not.toContain("background output");
	});

	it("renders unstructured old details via the content fallback exactly once", () => {
		const out = renderCell({
			code: "run_thread()",
			content: [{ type: "text", text: "main-line\n[background output (unattributed)]\nbg-line" }],
			details: {},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(countOccurrences(out, "main-line")).toBe(1);
		expect(countOccurrences(out, "bg-line")).toBe(1);
		expect(countOccurrences(out, "background output (unattributed)")).toBe(1);
	});

	it("renders the traceback before background output on error cells, each exactly once", () => {
		const out = renderCell({
			code: "run_thread(); boom()",
			content: [
				{
					type: "text",
					text: "Traceback line\nNameError: boom\n[background output (unattributed)]\nbg-line",
				},
			],
			details: {
				status: "error",
				durationMs: 1,
				stdout: "",
				stderr: "",
				backgroundOutput: "bg-line",
				error: { ename: "NameError", evalue: "boom", traceback: ["Traceback line", "NameError: boom"] },
			},
			executionStarted: true,
			argsComplete: true,
			isError: true,
			expanded: true,
		});

		expect(countOccurrences(out, "bg-line")).toBe(1);
		expect(countOccurrences(out, "background output (unattributed)")).toBe(1);
		expect(countOccurrences(out, "NameError: boom")).toBe(1);
		const lines = out.split("\n");
		const tracebackIndex = lines.findIndex((line) => line.includes("NameError: boom"));
		const labelIndex = lines.findIndex((line) => line.includes("background output (unattributed)"));
		expect(tracebackIndex).toBeGreaterThanOrEqual(0);
		expect(labelIndex).toBeGreaterThan(tracebackIndex);
	});

	it("counts background lines in the collapsed output line count", () => {
		const out = renderCell({
			code: "run_thread()",
			content: [{ type: "text", text: "main-line\n[background output (unattributed)]\nbg-line" }],
			details: { status: "ok", durationMs: 1, stdout: "main-line", stderr: "", backgroundOutput: "bg-line" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		expect(out).toContain("\u2193 2 lines");
	});
});
