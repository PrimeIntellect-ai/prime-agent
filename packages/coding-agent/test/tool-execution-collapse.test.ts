import type { TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCollapsedOutputPreview } from "../src/modes/interactive/components/collapsed-output.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createMcpStyleToolDefinition(name = "mcp_tool"): ToolDefinition {
	// Mimics an MCP tool: metadata only, no custom renderCall/renderResult.
	return {
		name,
		label: name,
		description: "tool without custom renderers",
		parameters: Type.Object({ code: Type.String() }),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

const MANY_LINES = Array.from({ length: 50 }, (_, i) => `out-line-${String(i + 1).padStart(2, "0")}`).join("\n");

function plain(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line));
}

describe("ToolExecutionComponent collapsed output (Ctrl+O)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("tool without custom renderers collapses result output when not expanded", () => {
		const component = new ToolExecutionComponent(
			"mcp_tool",
			"tool-1",
			{ code: "x" },
			{},
			createMcpStyleToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: MANY_LINES }], isError: false }, false);

		const collapsed = plain(component.render(80));
		const collapsedText = collapsed.join("\n");
		expect(collapsedText).toContain("earlier lines");
		expect(collapsedText).toContain("Ctrl+O to expand");
		// Last 5 lines visible, earlier ones hidden.
		expect(collapsedText).toContain("out-line-50");
		expect(collapsedText).not.toContain("out-line-01");
		expect(collapsedText).not.toContain("out-line-45");

		component.setExpanded(true);
		const expanded = plain(component.render(80)).join("\n");
		for (const line of MANY_LINES.split("\n")) {
			expect(expanded).toContain(line);
		}

		// Collapse again restores the preview.
		component.setExpanded(false);
		expect(plain(component.render(80)).join("\n")).toContain("earlier lines");
	});

	test("collapsed preview respects showExpandHint", () => {
		const component = new ToolExecutionComponent(
			"mcp_tool",
			"tool-2",
			{ code: "x" },
			{},
			createMcpStyleToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: MANY_LINES }], isError: false }, false);
		component.setShowExpandHint(false);

		const collapsedText = plain(component.render(80)).join("\n");
		expect(collapsedText).toContain("earlier lines");
		expect(collapsedText).not.toContain("Ctrl+O");
	});

	test("short output is not truncated and gets no hint", () => {
		const component = new ToolExecutionComponent(
			"mcp_tool",
			"tool-3",
			{ code: "x" },
			{},
			createMcpStyleToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false }, false);

		const collapsedText = plain(component.render(80)).join("\n");
		expect(collapsedText).toContain("a");
		expect(collapsedText).toContain("c");
		expect(collapsedText).not.toContain("earlier lines");
	});

	test("no-definition fallback collapses args to one line plus output preview", () => {
		const component = new ToolExecutionComponent(
			"unknown_tool",
			"tool-4",
			{ code: "let x = 1", other: "y" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: MANY_LINES }], isError: false }, false);

		const collapsed = plain(component.render(80));
		const collapsedText = collapsed.join("\n");
		// Args summary is a single line, no multi-line pretty JSON.
		expect(collapsedText).toContain('"code":"let x = 1"');
		expect(collapsedText).not.toMatch(/\{\n\s+"code"/);
		// Output preview is collapsed.
		expect(collapsedText).toContain("earlier lines");
		expect(collapsedText).toContain("out-line-50");
		expect(collapsedText).not.toContain("out-line-01");

		component.setExpanded(true);
		const expanded = plain(component.render(80)).join("\n");
		expect(expanded).toContain('"code": "let x = 1"');
		expect(expanded).toContain("out-line-01");
		expect(expanded).toContain("out-line-50");
	});

	test("collapsed preview recomputes when render width changes", () => {
		const preview = createCollapsedOutputPreview(MANY_LINES, { previewLines: 5 });
		const at80 = plain(preview.render(80));
		const at40 = plain(preview.render(40));
		preview.invalidate();
		const afterInvalidate = plain(preview.render(80));
		expect(afterInvalidate.join("\n")).toContain("out-line-50");
		// Both widths keep exactly 5 output lines (plus the hint line).
		const countOutput = (lines: string[]) => lines.filter((l) => l.includes("out-line-")).length;
		expect(countOutput(at80)).toBe(5);
		expect(countOutput(at40)).toBe(5);
		expect(countOutput(afterInvalidate)).toBe(5);
	});
});
