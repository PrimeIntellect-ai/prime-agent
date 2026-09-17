import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

type Region = ReturnType<Editor["getClickRegions"]>[number];
type Cursor = ReturnType<Editor["getCursor"]>;
const makeEditor = (width = 40) => new Editor(new TUI(new VirtualTerminal(width, 24)), defaultEditorTheme);
const singleRegion = (editor: Editor) => {
	const regions = editor.getClickRegions();
	assert.strictEqual(regions.length, 1);
	return regions[0]!;
};
const click = (editor: Editor, region: Region, row: number, col: number, expected: Cursor, message?: string) => {
	region.onClick({ row, col });
	assert.deepStrictEqual(editor.getCursor(), expected, message);
};
describe("editor click regions", () => {
	it("maps region clicks to logical cursor positions and focuses the editor", () => {
		const cases: {
			width: number;
			text: string;
			check?: (lines: string[], region: Region) => void;
			clicks: number[];
		}[] = [
			{ width: 40, text: "hello world", clicks: [0, 4, 0, 4] },
			{
				width: 10,
				text: "aaaa bbbb cccc dddd",
				check: (lines, region) => assert.ok(lines.length > 3 && region.line === 1, "text wraps after the prefix"),
				clicks: [0, 0, 0, 0, 1, 2, 0, 7, 2, 3, 0, 13],
			},
			{ width: 40, text: "a\u{1F389}b", clicks: [0, 1, 0, 1, 0, 2, 0, 3] },
			{
				width: 40,
				text: Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
				check: (_lines, region) => assert.strictEqual(region.height, 7, "only the visible slice is clickable"),
				clicks: [0, 0, 3, 0, 5, 2, 8, 2],
			},
		];
		for (const { width, text, check, clicks } of cases) {
			const editor = makeEditor(width);
			editor.setText(text);
			const lines = editor.render(width);
			const region = singleRegion(editor);
			check?.(lines, region);
			assert.strictEqual(editor.focused, false, "editor starts unfocused");
			for (let i = 0; i < clicks.length; i += 4)
				click(editor, region, clicks[i]!, clicks[i + 1]!, { line: clicks[i + 2]!, col: clicks[i + 3]! });
			assert.strictEqual(editor.focused, true, "clicking focuses the editor");
		}
	});
	it("snaps clicks inside an atomic paste marker to its boundary, split or not", () => {
		const editor = makeEditor();
		editor.handleInput(`\x1b[200~${Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")}\x1b[201~`);
		assert.strictEqual(editor.getText(), "[paste #1 +15 lines]");
		editor.render(40);
		const whole = singleRegion(editor);
		click(editor, whole, 0, 9, { line: 0, col: 0 }, "left half lands before");
		click(editor, whole, 0, 10, { line: 0, col: 20 }, "right half lands after");
		editor.render(12); // narrow width force-splits the marker across two rows
		const split = singleRegion(editor);
		assert.strictEqual(split.height, 2, "marker wraps onto two visual rows");
		click(editor, split, 0, 9, { line: 0, col: 0 }, "first chunk lands before");
		click(editor, split, 1, 0, { line: 0, col: 20 }, "continuation chunk lands after");
		split.onClick({ row: 0, col: 11 });
		const { line, col } = editor.getCursor();
		assert.ok(
			line === 0 && (col === 0 || col === 20),
			`padding click lands on a marker boundary, not mid-marker (got ${col})`,
		);
	});
});
