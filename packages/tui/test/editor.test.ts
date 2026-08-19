import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { Editor, wordWrapLine } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] || "";
	const before = line.slice(0, cursorCol - prefix.length);
	const after = line.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = before + item.value + after;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("Editor component", () => {
	describe("Prompt history navigation", () => {
		it("does nothing on Up arrow when history is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[A"); // Up arrow

			assert.strictEqual(editor.getText(), "");
		});

		it("shows most recent history entry on Up arrow when editor is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first prompt");
			editor.addToHistory("second prompt");

			editor.handleInput("\x1b[A"); // Up arrow

			assert.strictEqual(editor.getText(), "second prompt");
		});

		it("cycles through history entries on repeated Up arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("\x1b[A"); // Up - shows "third"
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[A"); // Up - shows "first"
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1b[A"); // Up - stays at "first" (oldest)
			assert.strictEqual(editor.getText(), "first");
		});

		it("returns to empty editor on Down arrow after browsing history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("prompt");

			editor.handleInput("\x1b[A"); // Up - shows "prompt"
			assert.strictEqual(editor.getText(), "prompt");

			editor.handleInput("\x1b[B"); // Down - clears editor
			assert.strictEqual(editor.getText(), "");
		});

		it("navigates forward through history with Down arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("\x1b[A"); // third
			editor.handleInput("\x1b[A"); // second
			editor.handleInput("\x1b[A"); // first

			editor.handleInput("\x1b[B"); // second
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[B"); // third
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1b[B"); // empty
			assert.strictEqual(editor.getText(), "");
		});

		it("exits history mode when typing a character", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("old prompt");

			editor.handleInput("\x1b[A"); // Up - shows "old prompt"
			editor.handleInput("x"); // Type a character - exits history mode

			assert.strictEqual(editor.getText(), "old promptx");
		});

		it("exits history mode on setText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			editor.setText(""); // External clear

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "second");
		});

		it("does not add empty strings to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("");
			editor.addToHistory("   ");
			editor.addToHistory("valid");

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "valid");

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "valid");
		});

		it("does not add consecutive duplicates to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("same");
			editor.addToHistory("same");
			editor.addToHistory("same");

			editor.handleInput("\x1b[A"); // "same"
			assert.strictEqual(editor.getText(), "same");

			editor.handleInput("\x1b[A"); // stays at "same" (only one entry)
			assert.strictEqual(editor.getText(), "same");
		});

		it("allows non-consecutive duplicates in history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("first"); // Not consecutive, should be added

			editor.handleInput("\x1b[A"); // "first"
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1b[A"); // "second"
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[A"); // "first" (older one)
			assert.strictEqual(editor.getText(), "first");
		});

		it("uses cursor movement instead of history when editor has content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("history item");
			editor.setText("line1\nline2");

			editor.handleInput("\x1b[A"); // Up - cursor movement

			editor.handleInput("X");

			assert.strictEqual(editor.getText(), "line1X\nline2");
		});

		it("limits history to 100 entries", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			for (let i = 0; i < 105; i++) {
				editor.addToHistory(`prompt ${i}`);
			}

			for (let i = 0; i < 100; i++) {
				editor.handleInput("\x1b[A");
			}

			assert.strictEqual(editor.getText(), "prompt 5");

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "prompt 5");
		});

		it("allows cursor movement within multi-line history entry with Down", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // Up - shows entry, cursor at end of line3
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");

			editor.handleInput("\x1b[B"); // Down
			assert.strictEqual(editor.getText(), ""); // Exited to empty
		});

		it("allows cursor movement within multi-line history entry with Up", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("older entry");
			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // Up - shows multi-line, cursor at end of line3

			editor.handleInput("\x1b[A"); // Up - cursor moves to line2
			assert.strictEqual(editor.getText(), "line1\nline2\nline3"); // Still same entry

			editor.handleInput("\x1b[A"); // Up - cursor moves to line1 (now on first visual line)
			assert.strictEqual(editor.getText(), "line1\nline2\nline3"); // Still same entry

			editor.handleInput("\x1b[A"); // Up - navigate to older
			assert.strictEqual(editor.getText(), "older entry");
		});

		it("navigates from multi-line entry back to newer via Down after cursor movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // Up - shows entry, cursor at end
			editor.handleInput("\x1b[A"); // Up - cursor to line2
			editor.handleInput("\x1b[A"); // Up - cursor to line1

			editor.handleInput("\x1b[B"); // Down - cursor to line2
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");

			editor.handleInput("\x1b[B"); // Down - cursor to line3
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");

			editor.handleInput("\x1b[B"); // Down - exit to empty
			assert.strictEqual(editor.getText(), "");
		});
	});

	describe("public state accessors", () => {
		it("returns cursor position", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x1b[D"); // Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
		});

		it("returns lines as a defensive copy", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("a\nb");

			const lines = editor.getLines();
			assert.deepStrictEqual(lines, ["a", "b"]);

			lines[0] = "mutated";
			assert.deepStrictEqual(editor.getLines(), ["a", "b"]);
		});
	});

	describe("Backslash+Enter newline workaround", () => {
		it("inserts backslash immediately (no buffering)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");

			assert.strictEqual(editor.getText(), "\\");
		});

		it("converts standalone backslash to newline on Enter", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\r");

			assert.strictEqual(editor.getText(), "\n");
		});

		it("inserts backslash normally when followed by other characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("x");

			assert.strictEqual(editor.getText(), "\\x");
		});

		it("does not trigger newline when backslash is not immediately before cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = false;

			editor.onSubmit = () => {
				submitted = true;
			};

			editor.handleInput("\\");
			editor.handleInput("x");
			editor.handleInput("\r");

			assert.strictEqual(submitted, true);
		});

		it("only removes one backslash when multiple are present", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\\");
			editor.handleInput("\\");
			assert.strictEqual(editor.getText(), "\\\\\\");

			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "\\\\\n");
		});
	});

	describe("Kitty CSI-u handling", () => {
		it("ignores printable CSI-u sequences with unsupported modifiers", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[99;9u");

			assert.strictEqual(editor.getText(), "");
		});

		it("inserts shifted CSI-u letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[69;2u");

			assert.strictEqual(editor.getText(), "E");
		});

		it("inserts shifted xterm modifyOtherKeys letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[27;2;69~");

			assert.strictEqual(editor.getText(), "E");
		});
	});

	describe("Unicode text editing behavior", () => {
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("H");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput(" ");
			editor.handleInput("😀");

			const text = editor.getText();
			assert.strictEqual(text, "Hello äöü 😀");
		});

		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			assert.strictEqual(text, "äö");
		});

		it("deletes multi-code-unit emojis with single Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");

			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			assert.strictEqual(text, "😀");
		});

		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("\x1b[D"); // Left arrow

			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "äxöü");
		});

		it("moves cursor across multi-code-unit emojis with single arrow key", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");
			editor.handleInput("🎉");

			editor.handleInput("\x1b[D"); // Left arrow

			editor.handleInput("\x1b[D");

			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "😀x👍🎉");
		});

		it("preserves umlauts across line breaks", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput("\n"); // new line
			editor.handleInput("Ä");
			editor.handleInput("Ö");
			editor.handleInput("Ü");

			const text = editor.getText();
			assert.strictEqual(text, "äöü\nÄÖÜ");
		});

		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			const text = editor.getText();
			assert.strictEqual(text, "Hällö Wörld! 😀 äöüÄÖÜß");
		});

		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\x01"); // Ctrl+A (move to start)
			editor.handleInput("x"); // Insert at start

			const text = editor.getText();
			assert.strictEqual(text, "xab");
		});

		it("deletes words correctly with Ctrl+W and Alt+Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "foo bar ");

			editor.setText("foo bar   ");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo ");

			editor.setText("foo bar...");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo bar");

			editor.setText("line one\nline two");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "line one\nline ");

			editor.setText("line one\n");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "line one");

			editor.setText("foo 😀😀 bar");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo 😀😀 ");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo ");

			editor.setText("foo bar");
			editor.handleInput("\x1b\x7f"); // Alt+Backspace (legacy)
			assert.strictEqual(editor.getText(), "foo ");
		});

		it("navigates words correctly with Ctrl+Left/Right", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar... baz");

			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // after '...'

			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // after 'bar'

			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // after 'foo '

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // at end of 'bar'

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 }); // after '...'

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 }); // end of line

			editor.setText("   foo bar");
			editor.handleInput("\x01"); // Ctrl+A to go to start
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // after 'foo'
		});
	});

	describe("Grapheme-aware text wrapping", () => {
		it("wraps lines correctly when text contains wide emojis", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("Hello ✅ World");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("wraps long text with emojis at correct positions", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10;

			editor.setText("✅✅✅✅✅✅");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("renders isolated Thai and Lao AM clusters without width drift", () => {
			for (const text of ["ำabc", "ຳabc"]) {
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				const width = 8;
				editor.setText(text);

				for (const line of editor.render(width)) {
					assert.strictEqual(visibleWidth(line), width, `line width drift for ${JSON.stringify(text)}: ${line}`);
				}
			}
		});

		it("wraps CJK characters correctly (each is 2 columns wide)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // +1 col reserved for cursor

			editor.setText("日本語テスト");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}

			const contentLines = lines.slice(1, -1).map((l) => stripVTControlCharacters(l).trim());
			assert.strictEqual(contentLines.length, 2);
			assert.strictEqual(contentLines[0], "日本語テス"); // 5 chars = 10 columns
			assert.strictEqual(contentLines[1], "ト"); // 1 char = 2 columns (+ padding)
		});

		it("handles mixed ASCII and wide characters in wrapping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 15 + 1; // +1 col reserved for cursor

			editor.setText("Test ✅ OK 日本");
			const lines = editor.render(width);

			const contentLines = lines.slice(1, -1);
			assert.strictEqual(contentLines.length, 1);

			const lineWidth = visibleWidth(contentLines[0]!);
			assert.strictEqual(lineWidth, width);
		});

		it("renders cursor correctly on wide characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("A✅B");
			const lines = editor.render(width);

			const contentLine = lines[1]!;
			assert.ok(contentLine.includes("\x1b[7m"), "Should have reverse video cursor");

			assert.strictEqual(visibleWidth(contentLine), width);
		});

		it("does not exceed terminal width with emoji at wrap boundary", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 11;

			editor.setText("0123456789✅");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.ok(lineWidth <= width, `Line ${i} has width ${lineWidth}, exceeds max ${width}`);
			}
		});

		it("shows cursor at end of line before wrap, wraps on next char", () => {
			const width = 10;
			for (const paddingX of [0, 1]) {
				const editor = new Editor(createTestTUI(width + paddingX), defaultEditorTheme, { paddingX });

				for (const ch of "aaaaaaaaa") editor.handleInput(ch);
				let lines = editor.render(width + paddingX);
				let contentLines = lines.slice(1, -1);
				assert.strictEqual(contentLines.length, 1, "Should be 1 content line before wrap");
				assert.ok(contentLines[0]!.endsWith("\x1b[7m \x1b[0m"), "Cursor should be at end of line");

				editor.handleInput("a");
				lines = editor.render(width + paddingX);
				contentLines = lines.slice(1, -1);
				assert.strictEqual(contentLines.length, 2, "Should wrap to 2 content lines");
			}
		});
	});

	describe("Image marker atomicity", () => {
		it("deletes a whole [image #N] marker with a single Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("look [image #1]");
			editor.handleInput("\x7f"); // Backspace

			assert.strictEqual(editor.getText(), "look ");
		});

		it("deletes a whole [image #N] marker with a single forward Delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("[image #12] tail");
			editor.handleInput("\x01"); // Ctrl+A (move to start of line)
			editor.handleInput("\x1b[3~"); // Delete (forward)

			assert.strictEqual(editor.getText(), " tail");
		});

		it("leaves surrounding text intact when deleting a marker", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("a [image #1] b");
			editor.handleInput("\x1b[D"); // Left past trailing " b" word
			editor.handleInput("\x1b[D");
			editor.handleInput("\x7f"); // Backspace deletes the marker, not a single char

			assert.strictEqual(editor.getText(), "a  b");
		});
	});

	describe("Word wrapping", () => {
		it("wraps at word boundaries instead of mid-word", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("Hello world this is a test of word wrapping functionality");
			const lines = editor.render(width);

			const contentLines = lines.slice(1, -1).map((l) => stripVTControlCharacters(l).trim());

			assert.ok(!contentLines[0]!.endsWith("-"), "Line should not end with hyphen (mid-word break)");

			for (const line of contentLines) {
				const lastChar = line.trimEnd().slice(-1);
				assert.ok(lastChar === "" || /[\w.,!?;:]/.test(lastChar), `Line ends unexpectedly with: "${lastChar}"`);
			}
		});

		it("does not start lines with leading whitespace after word wrap", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("Word1 Word2 Word3 Word4 Word5 Word6");
			const lines = editor.render(width);

			const contentLines = lines.slice(1, -1);

			for (let i = 0; i < contentLines.length; i++) {
				const line = stripVTControlCharacters(contentLines[i]!);
				const trimmedStart = line.trimStart();
				if (trimmedStart.length > 0) {
					assert.ok(!/^\s+\S/.test(line.trimEnd()), `Line ${i} starts with unexpected whitespace before content`);
				}
			}
		});

		it("breaks long words (URLs) at character level", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 30;

			editor.setText("Check https://example.com/very/long/path/that/exceeds/width here");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("preserves multiple spaces within words on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 50;

			editor.setText("Word1   Word2    Word3");
			const lines = editor.render(width);

			const contentLine = stripVTControlCharacters(lines[1]!).trim();
			assert.ok(contentLine.includes("Word1   Word2"), "Multiple spaces should be preserved");
		});

		it("handles empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("");
			const lines = editor.render(width);

			assert.strictEqual(lines.length, 3);
		});

		it("handles single word that fits exactly", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // +1 col reserved for cursor

			editor.setText("1234567890");
			const lines = editor.render(width);

			assert.strictEqual(lines.length, 3);
			const contentLine = stripVTControlCharacters(lines[1]!);
			assert.ok(contentLine.includes("1234567890"), "Content should contain the word");
		});

		it("wraps word to next line when it ends exactly at terminal width", () => {
			const chunks = wordWrapLine("hello world test", 11);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "hello ");
			assert.strictEqual(chunks[1]!.text, "world test");
		});

		it("keeps whitespace at terminal width boundary on same line", () => {
			const chunks = wordWrapLine("hello world test", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "hello world ");
			assert.strictEqual(chunks[1]!.text, "test");
		});

		it("handles unbreakable word filling width exactly followed by space", () => {
			const chunks = wordWrapLine("aaaaaaaaaaaa aaaa", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "aaaaaaaaaaaa");
			assert.strictEqual(chunks[1]!.text, " aaaa");
		});

		it("wraps word to next line when it fits width but not remaining space", () => {
			const chunks = wordWrapLine("      aaaaaaaaaaaa", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "      ");
			assert.strictEqual(chunks[1]!.text, "aaaaaaaaaaaa");
		});

		it("keeps word with multi-space and following word together when they fit", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,    consectetur", 30);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,    consectetur");
		});

		it("keeps word with multi-space and following word when they fill width exactly", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,              consectetur", 30);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,              consectetur");
		});

		it("splits when word plus multi-space plus word exceeds width", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,               consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,               ");
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		it("breaks long whitespace at line boundary", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                         consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		it("breaks long whitespace at line boundary 2", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                          consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, " consectetur");
		});

		it("breaks whitespace spanning full lines", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                                     consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, "            consectetur");
		});

		it("force-breaks when wide char after word boundary wrap still overflows", () => {
			const line = ` ${"a".repeat(186)}你`;
			const chunks = wordWrapLine(line, 187);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 187,
					`chunk "${chunk.text.slice(0, 20)}..." has visible width ${visibleWidth(chunk.text)}, expected <= 187`,
				);
			}
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment across multiple chunks", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `A${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
				{ segment: "B", index: 1 + marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment at start of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: "B", index: marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			assert.strictEqual(chunks[chunks.length - 1]!.text.includes("B"), true);

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment at end of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `A${marker}`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			assert.strictEqual(chunks[0]!.text, "A");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits consecutive oversized atomic segments", () => {
			const m1 = "[paste #1 +20 lines]"; // 21 chars
			const m2 = "[paste #2 +30 lines]"; // 21 chars
			const line = `${m1}${m2}`;
			const segments: Intl.SegmentData[] = [
				{ segment: m1, index: 0, input: line },
				{ segment: m2, index: m1.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("wraps normally after oversized atomic segment", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker} hello world`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: " ", index: marker.length, input: line },
				{ segment: "h", index: marker.length + 1, input: line },
				{ segment: "e", index: marker.length + 2, input: line },
				{ segment: "l", index: marker.length + 3, input: line },
				{ segment: "l", index: marker.length + 4, input: line },
				{ segment: "o", index: marker.length + 5, input: line },
				{ segment: " ", index: marker.length + 6, input: line },
				{ segment: "w", index: marker.length + 7, input: line },
				{ segment: "o", index: marker.length + 8, input: line },
				{ segment: "r", index: marker.length + 9, input: line },
				{ segment: "l", index: marker.length + 10, input: line },
				{ segment: "d", index: marker.length + 11, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			assert.strictEqual(chunks[chunks.length - 1]!.text, "world");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(editor.getText(), "foo bar ");

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "bazfoo bar ");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A (start)
			editor.handleInput("\x1b[C"); // Right 5 times
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C"); // After "hello "

			editor.handleInput("\x15"); // Ctrl+U - deletes "hello "
			assert.strictEqual(editor.getText(), "world");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A (start)
			editor.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W - deletes "first"
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W - deletes "second"
			editor.setText("third");
			editor.handleInput("\x17"); // Ctrl+W - deletes "third"

			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y - yanks "third" (most recent)
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1by"); // Alt+Y - cycles to "second"
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1by"); // Alt+Y - cycles to "first"
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			assert.strictEqual(editor.getText(), "third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x17"); // Ctrl+W - deletes "test"
			editor.setText("other");

			editor.handleInput("x");
			assert.strictEqual(editor.getText(), "otherx");

			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "otherx");
		});

		it("Alt+Y does nothing if kill ring has ≤1 entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("only");
			editor.handleInput("\x17"); // Ctrl+W - deletes "only"

			editor.handleInput("\x19"); // Ctrl+Y - yanks "only"
			assert.strictEqual(editor.getText(), "only");

			editor.handleInput("\x1by"); // Alt+Y - should do nothing (only 1 entry)
			assert.strictEqual(editor.getText(), "only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("one two three");
			editor.handleInput("\x17"); // Ctrl+W - deletes "three"
			editor.handleInput("\x17"); // Ctrl+W - deletes "two " (prepended)
			editor.handleInput("\x17"); // Ctrl+W - deletes "one " (prepended)

			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "one two three");
		});

		it("Ctrl+U accumulates multiline deletes including newlines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("line1\nline2\nline3");

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\nline2\n");

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\nline2");

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\n");

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1");

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("prefix|suffix");
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x0b"); // Ctrl+K - deletes "suffix" (forward)
			editor.handleInput("\x0b"); // Ctrl+K - deletes "|" (forward, appended)
			assert.strictEqual(editor.getText(), "prefix");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "prefix|suffix");
		});

		it("non-delete actions break kill accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(editor.getText(), "foo bar ");

			editor.handleInput("x"); // Typing breaks accumulation
			assert.strictEqual(editor.getText(), "foo bar x");

			editor.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry, not accumulated)
			assert.strictEqual(editor.getText(), "foo bar ");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "foo bar x");

			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("");

			editor.handleInput("\x19"); // Ctrl+Y - yanks "second"
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("x"); // Type breaks yank chain
			assert.strictEqual(editor.getText(), "secondx");

			editor.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(editor.getText(), "secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // deletes "first"
			editor.setText("second");
			editor.handleInput("\x17"); // deletes "second"
			editor.setText("third");
			editor.handleInput("\x17"); // deletes "third"
			editor.setText("");

			editor.handleInput("\x19"); // Ctrl+Y - yanks "third"
			editor.handleInput("\x1by"); // Alt+Y - cycles to "second", ring rotates

			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("x");
			editor.setText("");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "second");
		});

		it("consecutive deletions across lines coalesce into one entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1\n2\n3");
			editor.handleInput("\x17"); // Ctrl+W - deletes "3"
			assert.strictEqual(editor.getText(), "1\n2\n");

			editor.handleInput("\x17"); // Ctrl+W - deletes newline (merge with prev line)
			assert.strictEqual(editor.getText(), "1\n2");

			editor.handleInput("\x17"); // Ctrl+W - deletes "2"
			assert.strictEqual(editor.getText(), "1\n");

			editor.handleInput("\x17"); // Ctrl+W - deletes newline
			assert.strictEqual(editor.getText(), "1");

			editor.handleInput("\x17"); // Ctrl+W - deletes "1"
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "1\n2\n3");
		});

		it("Ctrl+K at line end deletes newline and coalesces", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");
			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\n");
			editor.handleInput("c");
			editor.handleInput("d");
			editor.handleInput("\x1b[A"); // Up arrow
			editor.handleInput("\x05"); // Ctrl+E - end of line

			editor.handleInput("\x0b"); // Ctrl+K - deletes newline
			assert.strictEqual(editor.getText(), "abcd");

			editor.handleInput("\x0b"); // Ctrl+K - deletes "cd"
			assert.strictEqual(editor.getText(), "ab");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "ab\ncd");
		});

		it("handles yank in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("word");
			editor.handleInput("\x17"); // Ctrl+W - deletes "word"
			editor.setText("hello world");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("FIRST");
			editor.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			editor.setText("SECOND");
			editor.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello SECONDworld");

			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "hello FIRSTworld");
		});

		it("multiline yank and yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("SINGLE");
			editor.handleInput("\x17"); // Ctrl+W - deletes "SINGLE"

			editor.setText("A\nB");
			editor.handleInput("\x15"); // Ctrl+U - deletes "B"
			editor.handleInput("\x15"); // Ctrl+U - deletes newline
			editor.handleInput("\x15"); // Ctrl+U - deletes "A"

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello A\nBworld");

			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "hello SINGLEworld");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world test");
			editor.handleInput("\x01"); // Ctrl+A - go to start

			editor.handleInput("\x1bd"); // Alt+D - deletes "hello"
			assert.strictEqual(editor.getText(), " world test");

			editor.handleInput("\x1bd"); // Alt+D - deletes " world" (skips whitespace, then word)
			assert.strictEqual(editor.getText(), " test");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world test");
		});

		it("Alt+D at end of line deletes newline", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("line1\nline2");
			editor.handleInput("\x1b[A"); // Up arrow - go to first line
			editor.handleInput("\x05"); // Ctrl+E - end of line

			editor.handleInput("\x1bd"); // Alt+D - deletes newline (merges lines)
			assert.strictEqual(editor.getText(), "line1line2");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "line1\nline2");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes spaces one at a time", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput(" ");
			assert.strictEqual(editor.getText(), "hello  ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes newlines and signals next word to capture state", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\n");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello\nworld");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello\n");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x7f"); // Backspace
			assert.strictEqual(editor.getText(), "hell");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			editor.handleInput("\x1b[C"); // Right arrow
			editor.handleInput("\x1b[3~"); // Delete key
			assert.strictEqual(editor.getText(), "hllo");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x0b"); // Ctrl+K
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello |world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Move right 6 times

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("undoes yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("\x17"); // Ctrl+W - delete "hello "
			editor.handleInput("\x19"); // Ctrl+Y - yank
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes single-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			editor.handleInput("\x1b[200~beep boop\x1b[201~");
			assert.strictEqual(editor.getText(), "hellobeep boop world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("does not trigger autocomplete during single-line paste", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async () => {
					suggestionCalls += 1;
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);
			editor.handleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~");

			assert.strictEqual(editor.getText(), "look at @node_modules/react/index.js please");
			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("decodes CSI-u Ctrl+letter sequences inside bracketed paste (tmux popup)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~");
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		it("undoes multi-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			editor.handleInput("\x1b[200~line1\nline2\nline3\x1b[201~");
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("undoes insertTextAtCursor atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			editor.insertTextAtCursor("/tmp/image.png");
			assert.strictEqual(editor.getText(), "hello/tmp/image.png world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("insertTextAtCursor handles multiline text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // Move right 5 (after "hello", before space)

			editor.insertTextAtCursor("line1\nline2\nline3");
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			const cursor = editor.getCursor();
			assert.strictEqual(cursor.line, 2);
			assert.strictEqual(cursor.col, 5); // "line3".length

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("insertTextAtCursor normalizes CRLF and CR line endings", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");

			editor.insertTextAtCursor("a\r\nb\r\nc");
			assert.strictEqual(editor.getText(), "a\nb\nc");

			editor.handleInput("\x1b[45;5u"); // Undo
			assert.strictEqual(editor.getText(), "");

			editor.insertTextAtCursor("x\ry\rz");
			assert.strictEqual(editor.getText(), "x\ny\nz");
		});

		it("undoes setText to empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			editor.setText("");
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("clears undo stack on submit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\r"); // Enter - submit

			assert.strictEqual(submitted, "hello");
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");
		});

		it("exits history browsing mode on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("hello");
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "world");

			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[A"); // Up arrow
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "world");
		});

		it("undo restores to pre-history state even after multiple history navigations", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("c");
			editor.handleInput("u");
			editor.handleInput("r");
			editor.handleInput("r");
			editor.handleInput("e");
			editor.handleInput("n");
			editor.handleInput("t");
			assert.strictEqual(editor.getText(), "current");

			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[A"); // Up - "third"
			assert.strictEqual(editor.getText(), "third");
			editor.handleInput("\x1b[A"); // Up - "second"
			assert.strictEqual(editor.getText(), "second");
			editor.handleInput("\x1b[A"); // Up - "first"
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "current");
		});

		it("cursor movement starts new undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[D");

			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("l");
			assert.strictEqual(editor.getText(), "hello lolworld");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello |world");
		});

		it("no-op delete operations do not push undo snapshots", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x17"); // Ctrl+W - deletes "hello"
			assert.strictEqual(editor.getText(), "");
			editor.handleInput("\x17"); // Ctrl+W - no-op (nothing to delete)
			editor.handleInput("\x17"); // Ctrl+W - no-op

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes autocomplete", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "di") {
						return {
							items: [{ value: "dist/", label: "dist/" }],
							prefix: "di",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("d");
			editor.handleInput("i");
			assert.strictEqual(editor.getText(), "di");

			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "dist/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "di");
		});
	});

	describe("Autocomplete", () => {
		it("shows suggestions in an overlay without changing editor height", async () => {
			const tui = createTestTUI(60, 24);
			const popupBackground = (text: string) => `\x1b[48;2;12;12;16m${text}\x1b[49m`;
			const editor = new Editor(tui, {
				...defaultEditorTheme,
				autocompleteBackgroundColor: popupBackground,
			});
			tui.setFocus(editor);
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({
					items: [
						{ value: "/model", label: "model", description: "Change model" },
						{ value: "/help", label: "help", description: "Show help" },
					],
					prefix: "/",
				}),
				applyCompletion,
			});
			const editorHeight = editor.render(60).length;

			editor.handleInput("/");
			await flushAutocomplete();

			assert.equal(editor.render(60).length, editorHeight);
			assert.equal(tui.hasOverlay(), true);
			assert.ok(!editor.render(60).some((line) => line.includes("Change model")));
			const overlayLines = (
				editor as unknown as { renderAutocompleteOverlay: (width: number) => string[] }
			).renderAutocompleteOverlay(60);
			assert.equal(stripVTControlCharacters(overlayLines[0] ?? "").trim(), "");
			assert.match(stripVTControlCharacters(overlayLines[1] ?? ""), /model/);
			assert.equal(stripVTControlCharacters(overlayLines.at(-1) ?? "").trim(), "");
			assert.ok(overlayLines.every((line) => line.startsWith("\x1b[48;2;12;12;16m")));

			editor.handleInput("\x15");
			assert.equal(editor.getText(), "");
			assert.equal(tui.hasOverlay(), false);
		});

		it("keeps the prompt top edge visible below autocomplete", async () => {
			const terminal = new VirtualTerminal(60, 12);
			const tui = new TUI(terminal);
			const editor = new Editor(tui, defaultEditorTheme);
			tui.addChild(editor);
			tui.start();
			tui.enterFullscreen({ scroll: [], dock: editor, mouse: false });
			tui.setFocus(editor);
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({
					items: [
						{ value: "/model", label: "model", description: "Change model" },
						{ value: "/help", label: "help", description: "Show help" },
					],
					prefix: "/",
				}),
				applyCompletion,
			});

			editor.handleInput("/");
			await flushAutocomplete();
			tui.requestRender(true);
			await new Promise<void>((resolve) => process.nextTick(resolve));
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.match(viewport[9] ?? "", /^─+$/);
			tui.stop();
		});

		it("auto-applies single force-file suggestion without showing menu", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "Work") {
						return {
							items: [{ value: "Workspace/", label: "Workspace/" }],
							prefix: "Work",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("W");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("k");
			assert.strictEqual(editor.getText(), "Work");

			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "Workspace/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "Work");
		});

		it("shows menu when force-file has multiple suggestions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "src") {
						return {
							items: [
								{ value: "src/", label: "src/" },
								{ value: "src.txt", label: "src.txt" },
							],
							prefix: "src",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("s");
			editor.handleInput("r");
			editor.handleInput("c");
			assert.strictEqual(editor.getText(), "src");

			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "src");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "src/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("keeps suggestions open when typing in force mode (Tab-triggered)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const allFiles = [
				{ value: "readme.md", label: "readme.md" },
				{ value: "package.json", label: "package.json" },
				{ value: "src/", label: "src/" },
				{ value: "dist/", label: "dist/" },
			];

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					const shouldMatch = options.force || prefix.includes("/") || prefix.startsWith(".");
					if (!shouldMatch) {
						return null;
					}
					const filtered = allFiles.filter((f) => f.value.toLowerCase().startsWith(prefix.toLowerCase()));
					if (filtered.length > 0) {
						return { items: filtered, prefix };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("r");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "r");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "re");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "readme.md");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("debounces @ autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "@main.ts", label: "main.ts" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");

			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		it("debounces # autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "#2983", label: "#2983" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("#");
			editor.handleInput("2");
			editor.handleInput("9");
			editor.handleInput("8");

			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		it("aborts active @ autocomplete when typing continues", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let aborts = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
					return await new Promise((resolve) => {
						const timeout = setTimeout(() => {
							resolve({ items: [{ value: "@main.ts", label: "main.ts" }], prefix: "@main" });
						}, 500);
						options.signal.addEventListener(
							"abort",
							() => {
								aborts += 1;
								clearTimeout(timeout);
								resolve(null);
							},
							{ once: true },
						);
					});
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");
			await new Promise((resolve) => setTimeout(resolve, 250));
			editor.handleInput("n");
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.strictEqual(aborts, 1);
		});

		it("hides autocomplete when backspacing slash command to empty", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix.startsWith("/")) {
						const commands = [
							{ value: "/model", label: "model", description: "Change model" },
							{ value: "/help", label: "help", description: "Show help" },
						];
						const query = prefix.slice(1); // Remove leading /
						const filtered = commands.filter((c) => c.value.startsWith(query));
						if (filtered.length > 0) {
							return { items: filtered, prefix };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "/");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\x7f"); // Backspace
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("accepts an inline slash command with Enter without submitting the prompt", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const submitted: string[] = [];
			editor.onSubmit = (text) => submitted.push(text);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()),
			);
			editor.setText("Please use ");

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "Please use /help ");
			assert.deepStrictEqual(submitted, []);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("accepts inline slash commands with Tab on later prompt lines", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()),
			);
			editor.setText("First line\nThen ");

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "First line\nThen /help ");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("preserves standalone slash command submission", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const submitted: string[] = [];
			editor.onSubmit = (text) => submitted.push(text);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()),
			);

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			editor.handleInput("\r");

			assert.deepStrictEqual(submitted, ["/help"]);
			assert.strictEqual(editor.getText(), "");
		});

		it("does not trigger slash command autocomplete inside URLs or paths", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()),
			);

			editor.setText("Visit https:/");
			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			editor.setText("Open src");
			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("applies exact typed slash-argument value on Enter even when first item is highlighted", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");
			editor.handleInput("o");

			assert.strictEqual(editor.getText(), "/argtest two");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");

			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("selects first prefix match on Enter when typed arg is not exact match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
							{ value: "twelve", label: "twelve" },
						];
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("highlights unique prefix match as user types (before full exact match)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");

			assert.strictEqual(editor.getText(), "/argtest tw");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("selects first prefix match when multiple items match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("works for built-in-style command argument completion path (model-like)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const modelMatch = beforeCursor.match(/^\/model\s+(\S+)$/);
					if (modelMatch) {
						const modelText = modelMatch[1]!;
						const allModels = [
							{ value: "gpt-4o", label: "gpt-4o" },
							{ value: "gpt-4o-mini", label: "gpt-4o-mini" },
							{ value: "claude-sonnet", label: "claude-sonnet" },
						];
						const filtered = allModels.filter((m) => m.value.startsWith(modelText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: modelText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("/");
			editor.handleInput("m");
			editor.handleInput("o");
			editor.handleInput("d");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput(" ");
			editor.handleInput("g");
			editor.handleInput("p");
			editor.handleInput("t");
			editor.handleInput("-");
			editor.handleInput("4");
			editor.handleInput("o");
			editor.handleInput("-");
			editor.handleInput("m");
			editor.handleInput("i");
			editor.handleInput("n");
			editor.handleInput("i");

			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\r");

			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
		});

		it("awaits async slash command argument completions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: async (prefix) =>
							prefix.startsWith("s") ? [{ value: "skill-a", label: "skill-a" }] : null,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "/load-skills skill-a");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("ignores invalid slash command argument completion results", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: (() => "not-an-array") as unknown as (
							argumentPrefix: string,
						) => Promise<{ value: string; label: string }[] | null>,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), false);
			assert.strictEqual(editor.getText(), "/load-skills s");
		});

		it("does not show argument completions when command has no argument completer", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show help" },
					{
						name: "model",
						description: "Switch model",
						getArgumentCompletions: () => [{ value: "claude-opus", label: "claude-opus" }],
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "/help ");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});
	});

	describe("Character jump (Ctrl+])", () => {
		it("jumps forward to first occurrence of character on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] (legacy sequence for ctrl+])
			editor.handleInput("o"); // Jump to first 'o'

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // 'o' in "hello"
		});

		it("jumps forward to next occurrence after cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o"); // Jump to next 'o' (in "world")

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps forward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - now on line 0
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("g"); // Jump to 'g' on line 3

			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });
		});

		it("jumps backward to first occurrence before cursor on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] (ESC followed by Ctrl+])
			editor.handleInput("o"); // Jump to last 'o' before cursor

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps backward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 3 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("a"); // Jump to 'a' on line 1

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("does nothing when character is not found (forward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("z"); // 'z' doesn't exist

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		it("does nothing when character is not found (backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("z"); // 'z' doesn't exist

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // Cursor unchanged
		});

		it("is case-sensitive", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("Hello World");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("h");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("W");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // 'W' in "World"
		});

		it("cancels jump mode when Ctrl+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1d"); // Ctrl+] again - cancel

			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "ohello world");
		});

		it("cancels jump mode on Escape and processes the Escape", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1b"); // Escape - cancel jump mode

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "ohello world");
		});

		it("cancels backward jump mode when Ctrl+Alt+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] - enter backward jump mode
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] again - cancel

			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "hello worldo");
		});

		it("searches for special characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo(bar) = baz;");
			editor.handleInput("\x01"); // Ctrl+A - go to start
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("(");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("=");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });
		});

		it("handles empty text gracefully", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("x");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		it("resets lastAction when jumping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A - go to start

			editor.handleInput("x");
			assert.strictEqual(editor.getText(), "xhello world");

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o");

			editor.handleInput("Y");
			assert.strictEqual(editor.getText(), "xhellYo world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "xhello world");
		});
	});

	describe("Sticky column", () => {
		function positionCursor(editor: Editor, line: number, col: number): void {
			for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
			for (let i = 0; i < line; i++) editor.handleInput("\x1b[B");
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < col; i++) editor.handleInput("\x1b[C");
		}

		it("preserves target column when moving up through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("2222222222x222\n\n1111111111_111111111111");

			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 23 }); // At end
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Move right to col 10
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			editor.handleInput("\x1b[A"); // Up arrow
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[A"); // Up arrow
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("preserves target column when moving down through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1111111111_111\n\n2222222222x222222222222");

			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			editor.handleInput("\x1b[B"); // Down arrow
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[B"); // Down arrow
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });
		});

		it("resets sticky column on horizontal movement (left arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (sticky)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			editor.handleInput("\x1b[D"); // Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 4 (new sticky from col 4)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 4 });
		});

		it("resets sticky column on horizontal movement (right arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (sticky)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			editor.handleInput("\x1b[C"); // Right
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 6 (new sticky from col 6)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		it("resets sticky column on typing", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			editor.handleInput("X");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 9 (new sticky from col 9)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });
		});

		it("resets sticky column on backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			editor.handleInput("\x7f"); // Backspace
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 7 (new sticky from col 7)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 7 });
		});

		it("resets sticky column on Ctrl+A (move to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x1b[A"); // Up - line 1, col 0

			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[A"); // Up - line 0, col 0 (new sticky from col 0)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("resets sticky column on Ctrl+E (move to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("12345\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 3
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x05"); // Ctrl+E
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (new sticky from col 5)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });
		});

		it("resets sticky column on word movement (Ctrl+Left)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 11 });

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 11
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // Before "world"

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 6 (new sticky from col 6)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		it("resets sticky column on word movement (Ctrl+Right)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 0
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 }); // After "hello"

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (new sticky from col 5)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		});

		it("resets sticky column on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 8 (sticky)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "1234567890\n\n12345678X90");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 9
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(editor.getText(), "1234567890\n\n1234567890");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 8 (new sticky from restored position)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
		});

		it("handles multiple consecutive up/down movements", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\nab\ncd\nef\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });

			editor.handleInput("\x1b[A"); // Up - line 3, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 2, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 1, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 0, col 7 (restored)
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			editor.handleInput("\x1b[B"); // Down - line 1, col 2
			editor.handleInput("\x1b[B"); // Down - line 2, col 2
			editor.handleInput("\x1b[B"); // Down - line 3, col 2
			editor.handleInput("\x1b[B"); // Down - line 4, col 7 (restored)
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });
		});

		it("moves correctly through wrapped visual lines without getting stuck", () => {
			const tui = createTestTUI(15, 24); // Narrow terminal
			const editor = new Editor(tui, defaultEditorTheme);

			editor.setText("short\n123456789012345678901234567890");
			editor.render(15); // This gives 14 layout width

			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 30 });

			editor.handleInput("\x1b[A"); // Up - to previous visual line within line 1
			assert.strictEqual(editor.getCursor().line, 1);

			editor.handleInput("\x1b[A"); // Up - another visual line
			assert.strictEqual(editor.getCursor().line, 1);

			editor.handleInput("\x1b[A"); // Up - should reach line 0
			assert.strictEqual(editor.getCursor().line, 0);
		});

		it("handles setText resetting sticky column", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[A"); // Up

			editor.setText("abcdefghij\n\nabcdefghij");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // At end

			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 10
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("sets preferredVisualCol when pressing right at end of prompt (last line)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("111111111x1111111111\n\n333333333_");

			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x05"); // Ctrl+E - move to end of line
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 20 });

			editor.handleInput("\x1b[B"); // Down to line 1, col 0
			editor.handleInput("\x1b[B"); // Down to line 2, col 10 (clamped)
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			editor.handleInput("\x1b[C"); // Right - can't move, but sets preferredVisualCol
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // Still at same position

			editor.handleInput("\x1b[A"); // Up to line 1, col 0
			editor.handleInput("\x1b[A"); // Up to line 0, col 10 (on 'x')
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("handles editor resizes when preferredVisualCol is on the same line", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			editor.setText("12345678901234567890\n\n12345678901234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 15
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 15 });

			editor.render(12); // Width 12

			editor.handleInput("\x1b[B"); // Down - line 1
			editor.handleInput("\x1b[B"); // Down - line 2, col should be clamped
			assert.equal(editor.getCursor().col, 4);
		});

		it("handles editor resizes when preferredVisualCol is on a different line", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			editor.setText("short\n12345678901234567890");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });

			editor.handleInput("\x1b[A"); // Up to line 0
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			editor.render(10);

			editor.handleInput("\x1b[B"); // Down to line 1
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			editor.handleInput("\x1b[A"); // Up - should go to line 0
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // Line 0 only has 5 chars

			editor.render(80);

			editor.handleInput("\x1b[B"); // Down to line 1
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });
		});

		it("rewrapped lines: target fits current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678");

			positionCursor(editor, 0, 18);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			editor.render(10);

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			editor.render(80);
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});

		it("rewrapped lines: target shorter than current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678\nab");

			positionCursor(editor, 0, 18);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			editor.render(10);
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			editor.render(80);

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 2 });

			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});
	});

	describe("Paste marker atomic behavior", () => {
		function pasteWithMarker(editor: Editor): string {
			const bigContent = "line\n".repeat(20).trimEnd(); // 20 lines
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			return editor.getText();
		}

		it("creates a paste marker for large pastes", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const text = pasteWithMarker(editor);
			assert.match(text, /\[paste #\d+ \+\d+ lines\]/);
		});

		it("treats paste marker as single unit for right arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			editor.handleInput("\x1b[C");
			const marker = editor.getText().match(/\[paste #\d+ \+\d+ lines\]/)![0];
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length + 1 });
		});

		it("treats paste marker as single unit for left arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			editor.handleInput("\x1b[D");
			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			editor.handleInput("\x1b[D");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			editor.handleInput("\x1b[D");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("treats paste marker as single unit for backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // past "A"
			editor.handleInput("\x1b[C"); // past marker
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			editor.handleInput("\x7f");
			assert.strictEqual(editor.getText(), "AB");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		it("treats paste marker as single unit for forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // past "A", now at col 1 (start of marker)

			editor.handleInput("\x1b[3~"); // Delete key
			assert.strictEqual(editor.getText(), "AB");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		it("treats paste marker as single unit for word movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("X");
			editor.handleInput(" ");
			pasteWithMarker(editor);
			editor.handleInput(" ");
			editor.handleInput("Y");

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			editor.handleInput("\x01"); // Ctrl+A

			editor.handleInput("\x1b[1;5C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			editor.handleInput("\x1b[1;5C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 + marker.length });
		});

		it("undo restores marker after backspace deletion", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const textBefore = editor.getText();

			editor.handleInput("\x01");
			editor.handleInput("\x1b[C"); // past A
			editor.handleInput("\x1b[C"); // past marker

			editor.handleInput("\x7f");
			assert.strictEqual(editor.getText(), "AB");

			editor.handleInput("\x1b[45;5u");
			assert.strictEqual(editor.getText(), textBefore);
		});

		it("handles multiple paste markers in same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			pasteWithMarker(editor);
			editor.handleInput(" ");
			pasteWithMarker(editor);

			const text = editor.getText();
			const markers = [...text.matchAll(/\[paste #\d+ \+\d+ lines\]/g)];
			assert.strictEqual(markers.length, 2);

			editor.handleInput("\x01");

			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length });

			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length + 1 });

			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), {
				line: 0,
				col: markers[0]![0].length + 1 + markers[1]![0].length,
			});
		});

		it("does not treat manually typed marker-like text as atomic (no valid paste ID)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const fakeMarker = "[paste #99 +5 lines]";
			for (const ch of fakeMarker) editor.handleInput(ch);

			assert.strictEqual(editor.getText(), fakeMarker);

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 }); // Just past "["
		});

		it("does not crash when paste marker is wider than terminal width", () => {
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);
			const bigContent = "line\n".repeat(47).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/);
			assert.ok(marker, "paste marker should be created");
			assert.ok(visibleWidth(marker[0]) > 8, "marker should be wider than render width");

			const lines = editor.render(8);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= 8,
					`line exceeds width 8: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("does not crash when text + paste marker exceeds terminal width with cursor on marker", () => {
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			for (let i = 0; i < 35; i++) editor.handleInput("b");

			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			for (let i = 0; i < 4; i++) editor.handleInput("b");

			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // past last 'b'
			editor.handleInput("\x1b[D"); // now on the paste marker

			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= renderWidth,
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("wordWrapLine re-checks overflow after backtracking to wrap opportunity", () => {
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			editor.handleInput(" ");
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			for (let i = 0; i < 4; i++) editor.handleInput("b");

			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= renderWidth,
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("expands large pasted content literally in getExpandedText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			assert.match(editor.getText(), /\[paste #\d+ \+\d+ lines\]/);
			assert.strictEqual(editor.getExpandedText(), pastedText);
		});

		it("restores expanded pasted content from a paste snapshot", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"line 11",
			].join("\n");
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			const markerText = editor.getText();
			const snapshot = editor.getPasteSnapshot();
			editor.handleInput("\r");

			const restored = new Editor(createTestTUI(), defaultEditorTheme);
			restored.setText(markerText);
			restored.restorePasteSnapshot(snapshot);

			assert.match(markerText, /\[paste #\d+ \+\d+ lines\]/);
			assert.strictEqual(submitted, pastedText);
			assert.strictEqual(restored.getExpandedText(), pastedText);
		});

		it("restores paste snapshot state on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const originalText = [
				"original 1",
				"original 2",
				"original 3",
				"original 4",
				"original 5",
				"original 6",
				"original 7",
				"original 8",
				"original 9",
				"original 10",
				"original 11",
			].join("\n");
			const restoredText = [
				"restored 1",
				"restored 2",
				"restored 3",
				"restored 4",
				"restored 5",
				"restored 6",
				"restored 7",
				"restored 8",
				"restored 9",
				"restored 10",
				"restored 11",
				"restored 12",
			].join("\n");
			const restoredSource = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput(`\x1b[200~${originalText}\x1b[201~`);
			const originalMarker = editor.getText();
			restoredSource.handleInput(`\x1b[200~${restoredText}\x1b[201~`);

			editor.setText(restoredSource.getText());
			editor.restorePasteSnapshot(restoredSource.getPasteSnapshot());
			assert.strictEqual(editor.getExpandedText(), restoredText);

			editor.handleInput("\x1b[45;5u");

			assert.strictEqual(editor.getText(), originalMarker);
			assert.strictEqual(editor.getExpandedText(), originalText);
		});

		it("snaps to the paste marker start when navigating down into it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("12345678901234567890\n\nhello ");

			const bigContent = "x".repeat(2000);
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			editor.render(80);

			const text = editor.getText();
			const _marker = text.match(/\[paste #\d+ \d+ chars\]/)![0];

			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Right 10
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		it("preserves sticky column when navigating through paste marker line", () => {
			const tui = createTestTUI(30, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			for (const ch of "1234567890123456") editor.handleInput(ch);
			editor.handleInput("\n");
			editor.handleInput("\n");
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			editor.handleInput("\n");
			editor.handleInput("\n");
			for (const ch of "abcdefghijklmnop") editor.handleInput(ch);
			editor.render(30);

			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 0 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 10 });
		});

		it("does not get stuck moving down from a multi-visual-line paste marker", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			const text = editor.getText();
			const markerMatch = text.match(/\[paste #\d+ \+\d+ lines]/);
			assert.ok(markerMatch, "paste marker should be created");
			const markerLen = markerMatch[0].length; // 21
			assert.ok(markerLen > 20, "marker should be wider than terminal");
			const markerStart = 8;
			const markerEnd = markerStart + markerLen; // 29

			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A (start of line)
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // Right to col 6
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			editor.handleInput("\x1b[B");
			assert.strictEqual(editor.getCursor().line, 0);
			assert.strictEqual(editor.getCursor().col, markerEnd); // col 29 = "i"

			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		it("skips marker continuation VLs when preferred col falls in marker tail", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x1b[B");
			assert.strictEqual(editor.getCursor().col, 8);

			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 3 });

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getCursor().col, 8); // marker
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		});

		it("submits large pasted content literally", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			editor.handleInput("\r");

			assert.strictEqual(submitted, pastedText);
		});
	});
});
