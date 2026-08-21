import type { Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActProjectionEvent } from "../src/core/act-events.js";
import { ActExecutionComponent } from "../src/modes/interactive/components/act-execution.js";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { setWorkingPulseFrame } from "../src/modes/interactive/theme/working-icon.js";

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
function event(body: Record<string, unknown>): ActProjectionEvent {
	return { type: "act_event", actId: "act-a", outerToolCallId: "outer-a", ...body } as ActProjectionEvent;
}
function start(): ActProjectionEvent {
	return event({
		sequence: 1,
		event: "start",
		prompt: "inspect retained state",
		promptTruncated: false,
		model: { provider: "test", id: "luna", name: "Luna" },
		thinkingLevel: "medium",
		directingModel: { provider: "test", id: "sol", name: "Sol" },
		directingThinkingLevel: "low",
		cancellationCapability: "posix-managed",
	});
}
function terminal(sequence: number, status: "done" | "cancelled" | "error" = "done"): ActProjectionEvent {
	return event({
		sequence,
		event: "terminal",
		status,
		prompt: "inspect retained state",
		promptTruncated: false,
		model: { provider: "test", id: "luna", name: "Luna" },
		thinkingLevel: "medium",
		directingModel: { provider: "test", id: "sol", name: "Sol" },
		directingThinkingLevel: "low",
		cancellationCapability: "posix-managed",
		usage,
		errorTruncated: false,
	});
}
function render(value: { render(width: number): string[] }, width = 120): string {
	return stripAnsi(value.render(width).join("\n"));
}

describe("ActExecutionComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setWorkingPulseFrame(0);
	});

	it("uses the parent IPython renderer for identical concise event rows", () => {
		const act = new ActExecutionComponent(start());
		act.update(
			event({ sequence: 2, event: "cell_start", cellId: "cell-1", code: "print(source)", codeTruncated: false }),
		);
		act.update(
			event({
				sequence: 3,
				event: "cell_terminal",
				cellId: "cell-1",
				status: "ok",
				durationMs: 12,
				stdout: "line 1\nline 2",
				stdoutTruncated: false,
				stderr: "",
				stderrTruncated: false,
				resultTruncated: false,
				errorTruncated: false,
			}),
		);
		act.update(terminal(4));
		const parent = new IPythonCellComponent({
			code: "print(source)",
			details: { status: "ok", durationMs: 12, stdout: "line 1\nline 2", stderr: "" },
			isPartial: false,
			isError: false,
			expanded: false,
			executionStarted: true,
			argsComplete: true,
			showExpandHint: false,
		});
		const parentRow = render(parent);
		expect(render(act)).toContain(parentRow);
		expect(parentRow).toContain("✓ python · print(source) · ↑ 1 ↓ 2 lines · 12ms");
		expect(render(act)).not.toContain("● IPython");
	});

	it("keeps adjacent successful cells ordered and folded through the shared renderer", () => {
		const act = new ActExecutionComponent(start());
		for (const [index, code] of ["a = source.read_text()", "len(a)"].entries()) {
			const sequence = 2 + index * 2;
			act.update(event({ sequence, event: "cell_start", cellId: `cell-${index}`, code, codeTruncated: false }));
			act.update(
				event({
					sequence: sequence + 1,
					event: "cell_terminal",
					cellId: `cell-${index}`,
					status: "ok",
					stdout: "",
					stdoutTruncated: false,
					stderr: "",
					stderrTruncated: false,
					result: index ? "42" : undefined,
					resultTruncated: false,
					errorTruncated: false,
				}),
			);
		}
		act.update(terminal(6));
		const output = render(act);
		expect(output.indexOf("a = source.read_text()")).toBeLessThan(output.indexOf("len(a)"));
		expect(output.match(/✓ python/g)).toHaveLength(2);
	});

	it("folds long output exactly as the parent and exposes it only when expanded", () => {
		const output = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
		const act = new ActExecutionComponent(start());
		act.update(
			event({ sequence: 2, event: "cell_start", cellId: "cell", code: "print(long_output)", codeTruncated: false }),
		);
		act.update(
			event({
				sequence: 3,
				event: "cell_terminal",
				cellId: "cell",
				status: "ok",
				stdout: output,
				stdoutTruncated: false,
				stderr: "",
				stderrTruncated: false,
				resultTruncated: false,
				errorTruncated: false,
			}),
		);
		act.update(terminal(4));
		expect(render(act)).not.toContain("line 79");
		act.setExpanded(true);
		expect(render(act)).toContain("line 79");
		expect(render(act)).not.toContain("Additional Act progress omitted");
	});

	it("labels nested start and return boundaries with explicit depth", () => {
		const nestedStart = event({
			depth: 2,
			parentActId: "act-parent",
			sequence: 1,
			event: "start",
			prompt: "inspect one nested owner",
			promptTruncated: false,
			model: { provider: "test", id: "deepseek", name: "DeepSeek" },
			thinkingLevel: "high",
			directingModel: { provider: "test", id: "luna", name: "Luna" },
			directingThinkingLevel: "medium",
			cancellationCapability: "posix-managed",
		});
		const act = new ActExecutionComponent(nestedStart);
		act.update(
			event({
				depth: 2,
				parentActId: "act-parent",
				sequence: 2,
				event: "terminal",
				status: "done",
				prompt: "inspect one nested owner",
				promptTruncated: false,
				model: { provider: "test", id: "deepseek", name: "DeepSeek" },
				thinkingLevel: "high",
				directingModel: { provider: "test", id: "luna", name: "Luna" },
				directingThinkingLevel: "medium",
				cancellationCapability: "posix-managed",
				usage,
				errorTruncated: false,
			}),
		);
		const output = render(act);
		expect(output).toContain("act 2  DeepSeek • high");
		expect(output).toContain("return 2  Luna • medium");
	});

	it("frames cancellation without replacing shared event rendering", () => {
		const act = new ActExecutionComponent(start());
		act.update(terminal(2, "cancelled"));
		expect(render(act)).toContain("Act cancelled · return  Sol • low");
	});
});
