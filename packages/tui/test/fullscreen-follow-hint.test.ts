import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getKeybindings } from "../src/keybindings.js";
import { type Component, TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class Transcript implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("fullscreen follow hint alignment", () => {
	for (const columns of [32, 80, 161]) {
		it(`keeps the hint centered while scrolling expanded output at ${columns} columns`, async () => {
			const terminal = new VirtualTerminal(columns, 10);
			const tui = new TUI(terminal);
			const transcript = new Transcript();
			const dock = new Transcript();
			dock.lines = ["> prompt", "footer"];
			const followKey = getKeybindings().getKeys("tui.viewport.follow")[0]!;
			const label = ` ${followKey} to follow `;
			const column = Math.floor((columns - visibleWidth(label)) / 2);
			const output = [
				"",
				"short",
				"\tvalue = 1",
				"\x1b[32m\t\treturn result\x1b[0m",
				`${"x".repeat(Math.max(0, column - 1))}界 rest`,
				"x".repeat(columns),
			];
			transcript.lines = [...output, ...output, ...output];
			tui.start();
			tui.enterFullscreen({ scroll: [transcript], dock });
			try {
				await terminal.waitForRender();
				tui.scrollToTop();
				await terminal.waitForRender();
				for (let index = 0; index < output.length; index++) {
					const row = terminal.getViewport()[7]!;
					const prefix = row.slice(0, row.indexOf(followKey));
					assert.equal(visibleWidth(prefix), column + 1, `scroll row ${index}: ${JSON.stringify(row)}`);
					assert.equal(terminal.getViewport().filter((line) => line.includes("to follow")).length, 1);
					transcript.lines.push(`new output ${index}`);
					tui.requestRender();
					await terminal.waitForRender();
					assert.equal(terminal.getViewport()[7], row, "new output must not move the hint");
					tui.scrollBy(1);
					await terminal.waitForRender();
				}
				tui.scrollToBottom();
				await terminal.waitForRender();
				assert.ok(terminal.getViewport().every((line) => !line.includes("to follow")));
			} finally {
				tui.stop();
			}
		});
	}
	it("uses the configured follow binding without shifting over tabbed output", async () => {
		const keybindings = getKeybindings();
		const previousBindings = keybindings.getUserBindings();
		const terminal = new VirtualTerminal(60, 10);
		const tui = new TUI(terminal);
		const transcript = new Transcript();
		transcript.lines = Array.from({ length: 20 }, () => "\t\toutput");
		const dock = new Transcript();
		dock.lines = ["> prompt"];
		try {
			keybindings.setUserBindings({ ...previousBindings, "tui.viewport.follow": "ctrl+f" });
			tui.start();
			tui.enterFullscreen({ scroll: [transcript], dock });
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const row = terminal.getViewport()[8]!;
			assert.equal(row.indexOf("ctrl+f"), Math.floor((60 - " ctrl+f to follow ".length) / 2) + 1);
			assert.ok(!row.includes("ctrl+shift+down"));
			terminal.sendInput("\x06");
			await terminal.waitForRender();
			assert.equal(tui.getScrollInfo()?.following, true);
		} finally {
			tui.stop();
			keybindings.setUserBindings(previousBindings);
		}
	});
});
