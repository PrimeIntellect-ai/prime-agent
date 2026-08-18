import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		component.setComplete(0, false);

		const lines = component.render(narrowWidth);

		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("renders an inline failure state via setFailed", () => {
		const { stub } = createTuiStub(120);
		const component = new BashExecutionComponent("boom", stub);

		component.setFailed("spawn failure");

		const rendered = component
			.render(120)
			.map((line) => line.replace(/\[[0-9;]*m/g, ""))
			.join("\n");
		expect(rendered).toContain("failed: spawn failure");
		expect(rendered).not.toContain("Running...");
	});
});
