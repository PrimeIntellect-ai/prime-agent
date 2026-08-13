import assert from "node:assert";
import { describe, it } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.js";

describe("KeybindingsManager", () => {
	it("keeps shared defaults when a user binding repeats its own default", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	it("keeps shared cursor defaults when a user binding repeats its own default", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	it("evicts defaults claimed as an added user binding", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.cursorUp": ["up", "ctrl+b"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up", "ctrl+b"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left"]);
	});

	it("still reports direct user binding conflicts", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});

	it("reports conflicts when an explicit binding restates its default", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.cursorUp": ["up", "ctrl+b"],
			"tui.editor.cursorLeft": ["left", "ctrl+b"],
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+b",
				keybindings: ["tui.editor.cursorUp", "tui.editor.cursorLeft"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up", "ctrl+b"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});
});
