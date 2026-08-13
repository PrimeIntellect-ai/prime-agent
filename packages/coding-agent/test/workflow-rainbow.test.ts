import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import {
	containsWorkflowUiKeyword,
	styleWorkflowUiKeywords,
} from "../src/modes/interactive/components/workflow-rainbow.js";

describe("workflow rainbow styling", () => {
	it.each(["workflow", "workflows", "Workflow", "ultracode", "ULTRACODE"])(
		"styles the whole-word UI keyword %s without changing its text",
		(keyword) => {
			const styled = styleWorkflowUiKeywords(`before ${keyword} after`);

			expect(stripAnsi(styled)).toBe(`before ${keyword} after`);
			expect(styled).toContain("\x1b[38;2;");
			expect(styled).not.toContain("\x1b[0m");
		},
	);

	it.each(["agent", "agents", "subagent", "multiple agents", "workflowish", "ultracoder"])(
		"does not style the non-keyword text %s",
		(text) => {
			expect(containsWorkflowUiKeyword(text)).toBe(false);
			expect(styleWorkflowUiKeywords(text)).toBe(text);
		},
	);

	it("does not rewrite workflow text inside OSC hyperlink payloads", () => {
		const hyperlink = "\x1b]8;;https://example.com/workflow\x1b\\docs\x1b]8;;\x1b\\";

		expect(styleWorkflowUiKeywords(hyperlink)).toBe(hyperlink);
	});

	it("restores the active foreground after a rainbow keyword", () => {
		const dimForeground = "\x1b[38;2;10;20;30m";
		const styled = styleWorkflowUiKeywords(`${dimForeground}before workflow after\x1b[39m`);

		expect(styled).toContain(`w`);
		expect(styled).toContain(`${dimForeground} after`);
		expect(stripAnsi(styled)).toBe("before workflow after");
	});

	it("changes only ANSI colors when the animation frame advances", () => {
		const first = styleWorkflowUiKeywords("workflow", 0);
		const next = styleWorkflowUiKeywords("workflow", 1);

		expect(next).not.toBe(first);
		expect(stripAnsi(next)).toBe(stripAnsi(first));
	});
	it("uses 256-color SGR in limited terminals", () => {
		const priorColorTerm = process.env.COLORTERM;
		const priorTerm = process.env.TERM;
		delete process.env.COLORTERM;
		process.env.TERM = "linux";
		try {
			const styled = styleWorkflowUiKeywords("workflow");
			expect(styled).toContain("\x1b[38;5;");
			expect(styled).not.toContain("\x1b[38;2;");
		} finally {
			if (priorColorTerm === undefined) delete process.env.COLORTERM;
			else process.env.COLORTERM = priorColorTerm;
			if (priorTerm === undefined) delete process.env.TERM;
			else process.env.TERM = priorTerm;
		}
	});
});
