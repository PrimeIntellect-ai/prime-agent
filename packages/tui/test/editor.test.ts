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

function newEditor(cols = 80): Editor {
	return new Editor(createTestTUI(cols), defaultEditorTheme);
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
	return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

const K = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	wordLeft: "\x1b[1;5D",
	wordRight: "\x1b[1;5C",
	home: "\x01",
	end: "\x05",
	backspace: "\x7f",
	del: "\x1b[3~",
	enter: "\r",
	tab: "\t",
	esc: "\x1b",
	killWord: "\x17",
	killToStart: "\x15",
	killToEnd: "\x0b",
	killWordForward: "\x1bd",
	yank: "\x19",
	yankPop: "\x1by",
	undo: "\x1b[45;5u",
	jump: "\x1d",
	jumpBack: "\x1b\x1d",
} as const;

/** Assertions that can ride along with an input step: resulting text and/or cursor position. */
interface Expect {
	expect?: string;
	at?: [line: number, col: number];
}

/** One step of an editor scenario: an input, a state change, or a standalone assertion. */
type Step =
	| ({ in: string; times?: number } & Expect)
	| ({ type: string } & Expect)
	| ({ set: string } & Expect)
	| { hist: string[] }
	| { render: number }
	| { submitted: string[] };

const key = (input: string, expect?: string): Step => ({ in: input, expect });
const keyAt = (input: string, line: number, col: number): Step => ({ in: input, at: [line, col] });
const keys = (input: string, times: number, expect?: string): Step => ({ in: input, times, expect });
const keysAt = (input: string, times: number, line: number, col: number): Step => ({
	in: input,
	times,
	at: [line, col],
});
const typed = (value: string, expect?: string): Step => ({ type: value, expect });
const typedAt = (value: string, line: number, col: number): Step => ({ type: value, at: [line, col] });
const set = (value: string, expect?: string): Step => ({ set: value, expect });
const setAt = (value: string, line: number, col: number): Step => ({ set: value, at: [line, col] });
const hist = (entries: string[]): Step => ({ hist: entries });
const render = (width: number): Step => ({ render: width });
const submitted = (values: string[]): Step => ({ submitted: values });

function checkExpect(editor: Editor, step: Expect): void {
	if (step.expect !== undefined) assert.strictEqual(editor.getText(), step.expect);
	if (step.at) assert.deepStrictEqual(editor.getCursor(), { line: step.at[0], col: step.at[1] });
}

function runSteps(editor: Editor, steps: Step[], submissions: string[] = []): void {
	for (const step of steps) {
		if ("in" in step) {
			for (let i = 0; i < (step.times ?? 1); i++) editor.handleInput(step.in);
			checkExpect(editor, step);
		} else if ("type" in step) {
			for (const char of step.type) editor.handleInput(char);
			checkExpect(editor, step);
		} else if ("set" in step) {
			editor.setText(step.set);
			checkExpect(editor, step);
		} else if ("hist" in step) {
			for (const entry of step.hist) editor.addToHistory(entry);
		} else if ("render" in step) {
			editor.render(step.render);
		} else {
			assert.deepStrictEqual(submissions, step.submitted);
		}
	}
}

/** [test name, steps] - one row per scenario. */
type Case = [name: string, steps: Step[]];

function runCases(cases: Case[], cols = 80): void {
	for (const [name, steps] of cases) {
		it(name, () => {
			const editor = newEditor(cols);
			const submissions: string[] = [];
			editor.onSubmit = (value) => submissions.push(value);
			runSteps(editor, steps, submissions);
		});
	}
}

describe("Editor component", () => {
	describe("Prompt history navigation", () => {
		const multi = "line1\nline2\nline3";
		runCases([
			["does nothing on Up arrow when history is empty", [key(K.up, "")]],
			["shows most recent history entry on Up arrow", [hist(["first", "second"]), key(K.up, "second")]],
			[
				"cycles up through history and stops at the oldest",
				[
					hist(["first", "second", "third"]),
					key(K.up, "third"),
					key(K.up, "second"),
					key(K.up, "first"),
					key(K.up, "first"),
				],
			],
			[
				"returns to an empty editor on Down arrow after browsing history",
				[hist(["prompt"]), key(K.up, "prompt"), key(K.down, "")],
			],
			[
				"navigates forward through history with Down arrow",
				[
					hist(["first", "second", "third"]),
					keys(K.up, 3),
					key(K.down, "second"),
					key(K.down, "third"),
					key(K.down, ""),
				],
			],
			["exits history mode when typing a character", [hist(["old prompt"]), key(K.up), typed("x", "old promptx")]],
			[
				"does not add empty or whitespace-only strings to history",
				[hist(["", "   ", "valid"]), key(K.up, "valid"), key(K.up, "valid")],
			],
			[
				"allows non-consecutive duplicates in history",
				[hist(["first", "second", "first"]), key(K.up, "first"), key(K.up, "second"), key(K.up, "first")],
			],
			[
				"uses cursor movement instead of history when the editor has content",
				[hist(["item"]), set("line1\nline2"), key(K.up), typed("X", "line1X\nline2")],
			],
			[
				"moves the cursor inside a multi-line entry before reaching older entries",
				[hist(["older entry", multi]), keys(K.up, 3, multi), key(K.up, "older entry")],
			],
		]);

		it("limits history to 100 entries", () => {
			const editor = newEditor();

			for (let i = 0; i < 105; i++) editor.addToHistory(`prompt ${i}`);
			for (let i = 0; i < 100; i++) editor.handleInput(K.up);
			assert.strictEqual(editor.getText(), "prompt 5");

			editor.handleInput(K.up);
			assert.strictEqual(editor.getText(), "prompt 5");
		});
	});

	describe("public state accessors", () => {
		it("returns cursor position", () => {
			const editor = newEditor();

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
			for (const char of "abc") editor.handleInput(char);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
			editor.handleInput(K.left);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
		});

		it("returns lines as a defensive copy", () => {
			const editor = newEditor();
			editor.setText("a\nb");

			const lines = editor.getLines();
			assert.deepStrictEqual(lines, ["a", "b"]);
			lines[0] = "mutated";

			assert.deepStrictEqual(editor.getLines(), ["a", "b"]);
		});
	});

	describe("Backslash+Enter newline workaround", () => {
		runCases([
			["inserts a backslash immediately (no buffering)", [typed("\\", "\\")]],
			["converts a standalone backslash to a newline on Enter", [typed("\\"), key(K.enter, "\n")]],
			[
				"submits normally when the backslash is not immediately before the cursor",
				[typed("\\x"), key(K.enter), submitted(["\\x"])],
			],
			["only removes one backslash when multiple are present", [typed("\\\\\\", "\\\\\\"), key(K.enter, "\\\\\n")]],
		]);
	});

	describe("Kitty CSI-u handling", () => {
		runCases([
			["ignores printable CSI-u sequences with unsupported modifiers", [key("\x1b[99;9u", "")]],
			["inserts shifted CSI-u letters as text", [key("\x1b[69;2u", "E")]],
			["inserts shifted xterm modifyOtherKeys letters as text", [key("\x1b[27;2;69~", "E")]],
		]);
	});

	describe("Unicode text editing behavior", () => {
		runCases([
			["inserts mixed ASCII, umlauts, and emojis as literal text", [typed("Hello äöü "), key("😀", "Hello äöü 😀")]],
			["deletes single-code-unit unicode characters with Backspace", [typed("äöü"), key(K.backspace, "äö")]],
			["deletes multi-code-unit emojis with a single Backspace", [key("😀"), key("👍"), key(K.backspace, "😀")]],
			[
				"inserts at the correct position after cursor movement over umlauts",
				[typed("äöü"), keys(K.left, 2), typed("x", "äxöü")],
			],
			[
				"moves the cursor across multi-code-unit emojis with a single arrow key",
				[key("😀"), key("👍"), key("🎉"), keys(K.left, 2), typed("x", "😀x👍🎉")],
			],
			["preserves umlauts across line breaks", [typed("äöü"), key("\n"), typed("ÄÖÜ", "äöü\nÄÖÜ")]],
			[
				"replaces the whole document with unicode text via setText",
				[set("Hällö Wörld! 😀 äöüÄÖÜß", "Hällö Wörld! 😀 äöüÄÖÜß")],
			],
			[
				"moves to document start on Ctrl+A and inserts at the beginning",
				[typed("ab"), key(K.home), typed("x", "xab")],
			],
			[
				"deletes the previous word with Ctrl+W across separators",
				[
					set("foo bar baz"),
					key(K.killWord, "foo bar "),
					set("foo bar   "),
					key(K.killWord, "foo "),
					set("foo bar..."),
					key(K.killWord, "foo bar"),
				],
			],
			[
				"deletes whole emoji words with Ctrl+W",
				[set("foo 😀😀 bar"), key(K.killWord, "foo 😀😀 "), key(K.killWord, "foo ")],
			],
			["deletes the previous word with legacy Alt+Backspace", [set("foo bar"), key("\x1b\x7f", "foo ")]],
			[
				"navigates words backward with Ctrl+Left",
				[
					setAt("foo bar... baz", 0, 14),
					keyAt(K.wordLeft, 0, 11),
					keyAt(K.wordLeft, 0, 7),
					keyAt(K.wordLeft, 0, 4),
				],
			],
			[
				"navigates words forward with Ctrl+Right",
				[
					set("foo bar... baz"),
					keysAt(K.wordLeft, 3, 0, 4),
					keyAt(K.wordRight, 0, 7),
					keyAt(K.wordRight, 0, 10),
					keyAt(K.wordRight, 0, 14),
				],
			],
			[
				"skips leading whitespace on Ctrl+Right from line start",
				[set("   foo bar"), key(K.home), keyAt(K.wordRight, 0, 6)],
			],
		]);
	});

	describe("Grapheme-aware text wrapping", () => {
		const widthCases: { name: string; text: string; width: number; content: string[] }[] = [
			{ name: "wide emojis", text: "Hello ✅ World", width: 20, content: ["Hello ✅ World"] },
			{ name: "emoji-only text", text: "✅✅✅✅✅✅", width: 10, content: ["✅✅✅✅", "✅✅"] },
			{ name: "an isolated Thai AM cluster", text: "ำabc", width: 8, content: ["ำabc"] },
			{ name: "an isolated Lao AM cluster", text: "ຳabc", width: 8, content: ["ຳabc"] },
			{ name: "CJK characters (2 columns each)", text: "日本語テスト", width: 11, content: ["日本語テス", "ト"] },
			{ name: "mixed ASCII and wide characters", text: "Test ✅ OK 日本", width: 16, content: ["Test ✅ OK 日本"] },
			{
				name: "a long URL broken at character level",
				text: "Check https://example.com/very/long/path here",
				width: 30,
				content: ["Check", "https://example.com/very/long", "/path here"],
			},
			{ name: "an emoji at the wrap boundary", text: "0123456789✅", width: 11, content: ["0123456789", "✅"] },
		];

		for (const testCase of widthCases) {
			it(`renders ${testCase.name} without width drift`, () => {
				const editor = newEditor();
				editor.setText(testCase.text);

				const contentLines = editor.render(testCase.width).slice(1, -1);
				for (const line of contentLines) {
					assert.strictEqual(
						visibleWidth(line),
						testCase.width,
						`visible width of ${JSON.stringify(stripVTControlCharacters(line))}`,
					);
				}
				assert.deepStrictEqual(
					contentLines.map((line) => stripVTControlCharacters(line).trimEnd()),
					testCase.content,
				);
			});
		}

		it("renders an empty document as a single empty content line", () => {
			assert.strictEqual(newEditor().render(40).length, 3);
		});
	});

	describe("Image marker atomicity", () => {
		runCases([
			[
				"deletes a whole [image #N] marker with a single Backspace",
				[set("look [image #1]"), key(K.backspace, "look ")],
			],
			[
				"deletes a whole [image #N] marker with a single forward Delete",
				[set("[image #12] tail"), key(K.home), key(K.del, " tail")],
			],
			[
				"leaves surrounding text intact when deleting a marker",
				[set("a [image #1] b"), keys(K.left, 2), key(K.backspace, "a  b")],
			],
		]);
	});

	describe("wordWrapLine", () => {
		const lorem = "Lorem ipsum dolor sit amet,";
		const loremHead = "Lorem ipsum dolor sit ";

		function assertWrappedLine(
			line: string,
			width: number,
			expectedTexts: string[],
			segments?: Intl.SegmentData[],
		): void {
			const chunks = wordWrapLine(line, width, segments);
			assert.deepStrictEqual(
				chunks.map((chunk) => chunk.text),
				expectedTexts,
			);

			let expectedStart = 0;
			for (const chunk of chunks) {
				assert.strictEqual(chunk.startIndex, expectedStart, `gap or overlap before ${JSON.stringify(chunk.text)}`);
				assert.strictEqual(chunk.text, line.slice(chunk.startIndex, chunk.endIndex));
				expectedStart = chunk.endIndex;
			}
			assert.strictEqual(expectedStart, line.length, "chunks must cover the complete source line");
		}

		const wrapCases: [name: string, line: string, width: number, chunks: string[]][] = [
			[
				"wraps a word to the next line when it ends exactly at the width",
				"hello world test",
				11,
				["hello ", "world test"],
			],
			["keeps whitespace at the width boundary on the same line", "hello world test", 12, ["hello world ", "test"]],
			[
				"handles an unbreakable word filling the width followed by a space",
				"aaaaaaaaaaaa aaaa",
				12,
				["aaaaaaaaaaaa", " aaaa"],
			],
			[
				"wraps a word that fits the width but not the remaining space",
				"      aaaaaaaaaaaa",
				12,
				["      ", "aaaaaaaaaaaa"],
			],
			[
				"keeps multi-space plus following word together when they fit",
				`${lorem}    consectetur`,
				30,
				[loremHead, "amet,    consectetur"],
			],
			[
				"keeps multi-space plus following word when they fill the width",
				`${lorem}              consectetur`,
				30,
				[loremHead, "amet,              consectetur"],
			],
			[
				"splits when word plus multi-space plus word exceeds the width",
				`${lorem}               consectetur`,
				30,
				[loremHead, "amet,               ", "consectetur"],
			],
			[
				"breaks long whitespace at the line boundary",
				`${lorem}                         consectetur`,
				30,
				[loremHead, "amet,                         ", "consectetur"],
			],
			[
				"breaks long whitespace one column past the boundary",
				`${lorem}                          consectetur`,
				30,
				[loremHead, "amet,                         ", " consectetur"],
			],
			[
				"breaks whitespace spanning full lines",
				`${lorem}                                     consectetur`,
				30,
				[loremHead, "amet,                         ", "            consectetur"],
			],
		];

		for (const [name, line, width, chunks] of wrapCases) {
			it(name, () => {
				assertWrappedLine(line, width, chunks);
			});
		}

		function segmentsFor(parts: string[]): { line: string; segments: Intl.SegmentData[] } {
			const line = parts.join("");
			let index = 0;
			const segments = parts.map((segment) => {
				const data: Intl.SegmentData = { segment, index, input: line };
				index += segment.length;
				return data;
			});
			return { line, segments };
		}

		const marker = "[paste #1 +20 lines]";
		const atomicCases: [name: string, parts: string[], chunks: string[]][] = [
			[
				"splits an oversized atomic segment across multiple chunks",
				["A", marker, "B"],
				["A", "[paste #1 ", "+20 lines]", "B"],
			],
			[
				"splits an oversized atomic segment at the start of the line",
				[marker, "B"],
				["[paste #1 ", "+20 lines]", "B"],
			],
			[
				"splits an oversized atomic segment at the end of the line",
				["A", marker],
				["A", "[paste #1 ", "+20 lines]"],
			],
			[
				"splits consecutive oversized atomic segments",
				[marker, "[paste #2 +30 lines]"],
				["[paste #1 ", "+20 lines]", "[paste #2 ", "+30 lines]"],
			],
			[
				"wraps normally after an oversized atomic segment",
				[marker, ..." hello world"],
				["[paste #1 ", "+20 lines]", " hello ", "world"],
			],
		];

		for (const [name, parts, expectedChunks] of atomicCases) {
			it(name, () => {
				const { line, segments } = segmentsFor(parts);
				assertWrappedLine(line, 10, expectedChunks, segments);
				for (const chunk of expectedChunks) {
					assert.ok(visibleWidth(chunk) <= 10, `chunk "${chunk}" is wider than 10 columns`);
				}
			});
		}

		it("force-breaks when a wide char after a word-boundary wrap still overflows", () => {
			const line = ` ${"a".repeat(186)}你`;
			const expectedChunks = [line.slice(0, 187), "你"];
			assertWrappedLine(line, 187, expectedChunks);
			for (const chunk of expectedChunks) {
				assert.ok(visibleWidth(chunk) <= 187, `visible width ${visibleWidth(chunk)}, expected <= 187`);
			}
		});
	});

	describe("Kill ring", () => {
		runCases([
			[
				"Ctrl+W saves deleted text to the kill ring and Ctrl+Y yanks it",
				[set("foo bar baz"), key(K.killWord, "foo bar "), key(K.home), key(K.yank, "bazfoo bar ")],
			],
			[
				"Ctrl+U saves deleted text to the kill ring",
				[
					set("hello world"),
					key(K.home),
					keys(K.right, 6),
					key(K.killToStart, "world"),
					key(K.yank, "hello world"),
				],
			],
			[
				"Ctrl+K saves deleted text to the kill ring",
				[set("hello world"), key(K.home), key(K.killToEnd, ""), key(K.yank, "hello world")],
			],
			["Ctrl+Y does nothing when the kill ring is empty", [set("test"), key(K.yank, "test")]],
			[
				"Alt+Y cycles through the kill ring after Ctrl+Y",
				[
					set("first"),
					key(K.killWord),
					set("second"),
					key(K.killWord),
					set("third"),
					key(K.killWord, ""),
					key(K.yank, "third"),
					key(K.yankPop, "second"),
					key(K.yankPop, "first"),
					key(K.yankPop, "third"),
				],
			],
			[
				"Alt+Y does nothing if not preceded by a yank",
				[set("test"), key(K.killWord), set("other"), typed("x"), key(K.yankPop, "otherx")],
			],
			[
				"consecutive Ctrl+W accumulates into one kill ring entry",
				[set("one two three"), keys(K.killWord, 3, ""), key(K.yank, "one two three")],
			],
			[
				"Ctrl+U accumulates multiline deletes including newlines",
				[
					set("line1\nline2\nline3"),
					key(K.killToStart, "line1\nline2\n"),
					keys(K.killToStart, 4, ""),
					key(K.yank, "line1\nline2\nline3"),
				],
			],
			[
				"non-delete actions break kill accumulation",
				[
					set("foo bar baz"),
					key(K.killWord),
					typed("x", "foo bar x"),
					key(K.killWord, "foo bar "),
					key(K.yank, "foo bar x"),
					key(K.yankPop, "foo bar baz"),
				],
			],
			[
				"non-yank actions break the Alt+Y chain",
				[
					set("first"),
					key(K.killWord),
					set("second"),
					key(K.killWord),
					set(""),
					key(K.yank, "second"),
					typed("x"),
					key(K.yankPop, "secondx"),
				],
			],
			[
				"consecutive deletions across lines coalesce into one entry",
				[set("1\n2\n3"), keys(K.killWord, 5, ""), key(K.yank, "1\n2\n3")],
			],
			[
				"Ctrl+K at line end deletes the newline and coalesces",
				[
					typed("ab"),
					key("\n"),
					typed("cd"),
					key(K.up),
					key(K.end),
					key(K.killToEnd, "abcd"),
					key(K.killToEnd, "ab"),
					key(K.yank, "ab\ncd"),
				],
			],
			[
				"yank-pop replaces the yanked text in the middle of a line",
				[
					set("FIRST"),
					key(K.killWord),
					set("SECOND"),
					key(K.killWord),
					set("hello world"),
					key(K.home),
					keys(K.right, 6),
					key(K.yank, "hello SECONDworld"),
					key(K.yankPop, "hello FIRSTworld"),
				],
			],
			[
				"Alt+D deletes a word forward and saves it to the kill ring",
				[
					set("hello world test"),
					key(K.home),
					key(K.killWordForward, " world test"),
					key(K.killWordForward, " test"),
					key(K.yank, "hello world test"),
				],
			],
			[
				"Alt+D at end of line deletes the newline",
				[
					set("line1\nline2"),
					key(K.up),
					key(K.end),
					key(K.killWordForward, "line1line2"),
					key(K.yank, "line1\nline2"),
				],
			],
		]);
	});

	describe("Undo", () => {
		runCases([
			["does nothing when the undo stack is empty", [key(K.undo, "")]],
			[
				"coalesces consecutive word characters into one undo unit",
				[typed("hello world"), key(K.undo, "hello"), key(K.undo, "")],
			],
			[
				"undoes newlines and signals the next word to capture state",
				[typed("hello"), key("\n"), typed("world"), key(K.undo, "hello\n"), key(K.undo, "hello"), key(K.undo, "")],
			],
			["undoes backspace", [typed("hello"), key(K.backspace, "hell"), key(K.undo, "hello")]],
			[
				"undoes Ctrl+W (delete word backward)",
				[typed("hello world"), key(K.killWord, "hello "), key(K.undo, "hello world")],
			],
			[
				"undoes Ctrl+K and restores the cursor",
				[
					typed("hello world"),
					key(K.home),
					keys(K.right, 6),
					key(K.killToEnd, "hello "),
					key(K.undo, "hello world"),
					typed("|", "hello |world"),
				],
			],
			["undoes yank", [typed("hello "), key(K.killWord), key(K.yank, "hello "), key(K.undo, "")]],
			[
				"undoes a single-line paste atomically",
				[
					set("hello world"),
					key(K.home),
					keys(K.right, 5),
					key("\x1b[200~beep boop\x1b[201~", "hellobeep boop world"),
					key(K.undo, "hello world"),
					typed("|", "hello| world"),
				],
			],
			[
				"undoes a multi-line paste atomically",
				[
					set("hello world"),
					key(K.home),
					keys(K.right, 5),
					key("\x1b[200~line1\nline2\nline3\x1b[201~", "helloline1\nline2\nline3 world"),
					key(K.undo, "hello world"),
					typed("|", "hello| world"),
				],
			],
			[
				"decodes CSI-u Ctrl+letter sequences inside bracketed paste (tmux popup)",
				[key("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~", "line1\nline2\nline3")],
			],
			["undoes setText to an empty string", [typed("hello world"), set("", ""), key(K.undo, "hello world")]],
			["clears the undo stack on submit", [typed("hello"), key(K.enter, ""), submitted(["hello"]), key(K.undo, "")]],
			[
				"exits history browsing mode on undo",
				[
					hist(["hello"]),
					typed("world"),
					key(K.killWord, ""),
					key(K.up, "hello"),
					key(K.undo, ""),
					key(K.undo, "world"),
				],
			],
			[
				"cursor movement starts a new undo unit",
				[
					typed("hello world"),
					keys(K.left, 5),
					typed("lol", "hello lolworld"),
					key(K.undo, "hello world"),
					typed("|", "hello |world"),
				],
			],
			[
				"no-op delete operations do not push undo snapshots",
				[typed("hello"), keys(K.killWord, 3, ""), key(K.undo, "hello")],
			],
		]);

		it("undoes insertTextAtCursor atomically and normalizes CRLF and CR", () => {
			const editor = newEditor();
			editor.setText("hello world");
			editor.handleInput(K.home);
			for (let i = 0; i < 5; i++) editor.handleInput(K.right);

			editor.insertTextAtCursor("/tmp/image.png");
			assert.strictEqual(editor.getText(), "hello/tmp/image.png world");
			editor.handleInput(K.undo);
			assert.strictEqual(editor.getText(), "hello world");
			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");

			editor.setText("");
			editor.insertTextAtCursor("a\r\nb\r\nc");
			assert.strictEqual(editor.getText(), "a\nb\nc");
			editor.handleInput(K.undo);
			assert.strictEqual(editor.getText(), "");
			editor.insertTextAtCursor("x\ry\rz");
			assert.strictEqual(editor.getText(), "x\ny\nz");
		});

		it("insertTextAtCursor places the cursor at the end of multiline text", () => {
			const editor = newEditor();
			editor.setText("hello world");
			editor.handleInput(K.home);
			for (let i = 0; i < 5; i++) editor.handleInput(K.right);

			editor.insertTextAtCursor("line1\nline2\nline3");

			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });
		});
	});

	describe("Autocomplete", () => {
		interface Command {
			name: string;
			description: string;
			takesArgument?: boolean;
		}

		function prefixProvider(
			items: { value: string; label: string }[],
			options: { forceOnly?: boolean } = {},
		): AutocompleteProvider {
			return {
				getSuggestions: async (lines, cursorLine, cursorCol, requestOptions) => {
					if (options.forceOnly && !requestOptions.force) return null;
					const prefix = (lines[cursorLine] || "").slice(0, cursorCol);
					const filtered = items.filter((item) => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
					return filtered.length > 0 ? { items: filtered, prefix } : null;
				},
				applyCompletion,
			};
		}

		function argumentProvider(command: string, values: string[], filter: boolean): AutocompleteProvider {
			return {
				getSuggestions: async (lines, cursorLine, cursorCol) => {
					const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
					const match = beforeCursor.match(new RegExp(`^/${command}\\s+(\\S+)$`));
					if (!match) return null;
					const argumentText = match[1] ?? "";
					const items = values.map((value) => ({ value, label: value }));
					const filtered = filter ? items.filter((item) => item.value.startsWith(argumentText)) : items;
					return filtered.length > 0 ? { items: filtered, prefix: argumentText } : null;
				},
				applyCompletion,
			};
		}

		async function completeCommand(
			command: Command,
			initial: string,
			typedText: string,
			accept: string,
		): Promise<{ editor: Editor; submissions: string[] }> {
			const editor = newEditor();
			const submissions: string[] = [];
			editor.onSubmit = (value) => submissions.push(value);
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([command], process.cwd()));
			if (initial) editor.setText(initial);
			for (const char of typedText) editor.handleInput(char);
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			editor.handleInput(accept);
			return { editor, submissions };
		}

		const help: Command = { name: "help", description: "Show help" };
		const model: Command = { name: "model", description: "Select model" };
		const goal: Command = { name: "goal", description: "Set a goal", takesArgument: true };

		it("shows suggestions in an overlay without changing editor height", async () => {
			const tui = createTestTUI(60, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			tui.setFocus(editor);
			editor.setAutocompleteProvider(
				prefixProvider([
					{ value: "/model", label: "model" },
					{ value: "/help", label: "help" },
				]),
			);
			const editorHeight = editor.render(60).length;

			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.render(60).length, editorHeight);
			assert.strictEqual(tui.hasOverlay(), true);

			editor.handleInput(K.killToStart);
			assert.strictEqual(editor.getText(), "");
			assert.strictEqual(tui.hasOverlay(), false);
		});

		it("auto-applies single force-file suggestion without showing menu", async () => {
			const editor = newEditor();
			editor.setAutocompleteProvider(
				prefixProvider([{ value: "Workspace/", label: "Workspace/" }], { forceOnly: true }),
			);

			for (const char of "Work") editor.handleInput(char);
			editor.handleInput(K.tab);
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "Workspace/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			editor.handleInput(K.undo);
			assert.strictEqual(editor.getText(), "Work");
		});

		it("shows a menu when force-file has multiple suggestions", async () => {
			const editor = newEditor();
			const items = [
				{ value: "src/", label: "src/" },
				{ value: "src.txt", label: "src.txt" },
			];
			editor.setAutocompleteProvider(prefixProvider(items, { forceOnly: true }));

			for (const char of "src") editor.handleInput(char);
			editor.handleInput(K.tab);
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "src");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput(K.tab);
			assert.strictEqual(editor.getText(), "src/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("keeps suggestions open when typing in force mode (Tab-triggered)", async () => {
			const editor = newEditor();
			editor.setAutocompleteProvider(
				prefixProvider([
					{ value: "readme.md", label: "readme.md" },
					{ value: "package.json", label: "package.json" },
					{ value: "dist/", label: "dist/" },
				]),
			);

			editor.handleInput(K.tab);
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			for (const char of "re") {
				editor.handleInput(char);
				await flushAutocomplete();
				assert.strictEqual(editor.isShowingAutocomplete(), true);
			}

			editor.handleInput(K.tab);
			assert.strictEqual(editor.getText(), "readme.md");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		for (const trigger of [
			{ name: "@", typed: "@mai", item: { value: "@main.ts", label: "main.ts" } },
			{ name: "#", typed: "#298", item: { value: "#2983", label: "#2983" } },
		]) {
			it(`debounces ${trigger.name} autocomplete while typing`, async (t) => {
				t.mock.timers.enable({ apis: ["setTimeout"] });
				const editor = newEditor();
				let suggestionCalls = 0;
				editor.setAutocompleteProvider({
					getSuggestions: async (lines, cursorLine, cursorCol) => {
						suggestionCalls += 1;
						return { items: [trigger.item], prefix: (lines[cursorLine] || "").slice(0, cursorCol) };
					},
					applyCompletion,
				});

				for (const char of trigger.typed) editor.handleInput(char);
				t.mock.timers.tick(19);
				await flushAutocomplete();
				assert.strictEqual(suggestionCalls, 0);
				assert.strictEqual(editor.isShowingAutocomplete(), false);

				t.mock.timers.tick(1);
				await flushAutocomplete();
				assert.strictEqual(suggestionCalls, 1);
				assert.strictEqual(editor.isShowingAutocomplete(), true);
			});
		}

		it("aborts active @ autocomplete when typing continues", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const editor = newEditor();
			let aborts = 0;
			let markProviderStarted!: () => void;
			const providerStarted = new Promise<void>((resolve) => {
				markProviderStarted = resolve;
			});
			editor.setAutocompleteProvider({
				getSuggestions: (_lines, _cursorLine, _cursorCol, options) =>
					new Promise((resolve) => {
						markProviderStarted();
						options.signal.addEventListener(
							"abort",
							() => {
								aborts += 1;
								resolve(null);
							},
							{ once: true },
						);
					}),
				applyCompletion,
			});

			for (const char of "@mai") editor.handleInput(char);
			t.mock.timers.tick(20);
			await providerStarted;
			editor.handleInput("n");
			await flushAutocomplete();

			assert.strictEqual(aborts, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("does not trigger autocomplete during a bracketed paste", () => {
			const editor = newEditor();
			let suggestionCalls = 0;
			editor.setAutocompleteProvider({
				getSuggestions: async () => {
					suggestionCalls += 1;
					return null;
				},
				applyCompletion,
			});

			editor.handleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~");

			assert.strictEqual(editor.getText(), "look at @node_modules/react/index.js please");
			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("hides autocomplete when backspacing slash command to empty", async () => {
			const editor = newEditor();
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([model], process.cwd()));

			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput(K.backspace);
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("does not trigger slash command autocomplete inside URLs or paths", async () => {
			const editor = newEditor();
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([help], process.cwd()));

			for (const before of ["Visit https:/", "Open src"]) {
				editor.setText(before);
				editor.handleInput("/");
				await flushAutocomplete();
				assert.strictEqual(editor.isShowingAutocomplete(), false);
			}
		});

		const acceptCases: [
			name: string,
			command: Command,
			initial: string,
			typed: string,
			accept: string,
			expected: string,
		][] = [
			["an inline command with Enter", help, "Please use ", "/he", K.enter, "Please use /help"],
			[
				"an inline command on a later line with Tab",
				help,
				"First line\nThen ",
				"/he",
				K.tab,
				"First line\nThen /help",
			],
			["a standalone command with Enter", help, "", "/he", K.enter, "/help"],
			["a no-argument command with Tab", model, "", "/mo", K.tab, "/model"],
			["an argument-taking command with Tab", goal, "", "/go", K.tab, "/goal "],
			["an argument-taking command with Enter", goal, "", "/go", K.enter, "/goal "],
		];

		for (const [name, command, initial, typedText, accept, expected] of acceptCases) {
			it(`completes ${name} without submitting`, async () => {
				const { editor, submissions } = await completeCommand(command, initial, typedText, accept);

				assert.strictEqual(editor.getText(), expected);
				assert.deepStrictEqual(submissions, []);
				assert.strictEqual(editor.isShowingAutocomplete(), false);
			});
		}

		it("cancels the slash command autocomplete with Escape without submitting", async () => {
			const { editor, submissions } = await completeCommand(model, "", "/mo", K.esc);

			assert.strictEqual(editor.getText(), "/mo");
			assert.deepStrictEqual(submissions, []);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("submits a completed command on the next Enter", async () => {
			const { editor, submissions } = await completeCommand(model, "", "/mo", K.enter);
			assert.deepStrictEqual(submissions, []);

			editor.handleInput(K.enter);
			assert.deepStrictEqual(submissions, ["/model"]);
			assert.strictEqual(editor.getText(), "");
		});

		const argumentCases: [
			name: string,
			command: string,
			values: string[],
			filter: boolean,
			typed: string,
			expected: string,
		][] = [
			[
				"applies the exact typed argument on Enter",
				"argtest",
				["one", "two", "three"],
				true,
				"/argtest two",
				"/argtest two",
			],
			[
				"selects the first prefix match on Enter",
				"argtest",
				["two", "three", "twelve"],
				true,
				"/argtest t",
				"/argtest two",
			],
			[
				"highlights the unique prefix match while typing",
				"argtest",
				["one", "two", "three"],
				false,
				"/argtest tw",
				"/argtest two",
			],
			[
				"selects the first prefix match when many items match",
				"argtest",
				["one", "two", "three"],
				false,
				"/argtest t",
				"/argtest two",
			],
			[
				"completes model-like arguments",
				"model",
				["gpt-4o", "gpt-4o-mini", "claude-sonnet"],
				true,
				"/model gpt-4o-mini",
				"/model gpt-4o-mini",
			],
		];

		for (const [name, command, values, filter, typedText, expected] of argumentCases) {
			it(name, async () => {
				const editor = newEditor();
				editor.setAutocompleteProvider(argumentProvider(command, values, filter));

				for (const char of typedText) editor.handleInput(char);
				await flushAutocomplete();
				assert.strictEqual(editor.isShowingAutocomplete(), true);

				editor.handleInput(K.enter);
				assert.strictEqual(editor.getText(), expected);
			});
		}

		it("awaits async slash command argument completions", async () => {
			const editor = newEditor();
			const command = {
				name: "load-skills",
				description: "Load skills",
				getArgumentCompletions: async (prefix: string) =>
					prefix.startsWith("s") ? [{ value: "skill-a", label: "skill-a" }] : null,
			};
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([command], process.cwd()));
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput(K.tab);
			assert.strictEqual(editor.getText(), "/load-skills skill-a");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("ignores invalid slash command argument completion results", async () => {
			const editor = newEditor();
			const command = {
				name: "load-skills",
				description: "Load skills",
				getArgumentCompletions: (() => "not-an-array") as unknown as (
					argumentPrefix: string,
				) => Promise<{ value: string; label: string }[] | null>,
			};
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([command], process.cwd()));
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();

			assert.strictEqual(editor.isShowingAutocomplete(), false);
			assert.strictEqual(editor.getText(), "/load-skills s");
		});

		it("does not show argument completions when a command has no argument completer", async () => {
			const { editor } = await completeCommand(help, "", "/he", K.tab);

			assert.strictEqual(editor.getText(), "/help");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});
	});

	describe("Character jump (Ctrl+])", () => {
		runCases([
			[
				"jumps forward to the first occurrence on the same line",
				[set("hello world"), key(K.home), key(K.jump), typedAt("o", 0, 4)],
			],
			[
				"jumps forward across multiple lines",
				[set("abc\ndef\nghi"), keys(K.up, 2), key(K.home), key(K.jump), typedAt("g", 2, 0)],
			],
			[
				"jumps backward to the first occurrence before the cursor",
				[setAt("hello world", 0, 11), key(K.jumpBack), typedAt("o", 0, 7)],
			],
			[
				"does nothing when the character is not found",
				[set("hello world"), key(K.home), key(K.jump), typedAt("z", 0, 0), key(K.jumpBack), typedAt("z", 0, 0)],
			],
			[
				"is case-sensitive",
				[set("Hello World"), key(K.home), key(K.jump), typedAt("h", 0, 0), key(K.jump), typedAt("W", 0, 6)],
			],
			[
				"cancels jump mode on Escape and processes the Escape",
				[set("hello world"), key(K.home), key(K.jump), keyAt(K.esc, 0, 0), typed("o", "ohello world")],
			],
			["handles empty text gracefully", [set(""), key(K.jump), typedAt("x", 0, 0)]],
			[
				"resets lastAction when jumping so undo splits units",
				[
					set("hello world"),
					key(K.home),
					typed("x"),
					key(K.jump),
					typed("o"),
					typed("Y", "xhellYo world"),
					key(K.undo, "xhello world"),
				],
			],
		]);
	});

	describe("Sticky column", () => {
		const threeLines = "1234567890\n\n1234567890";
		runCases([
			[
				"preserves the target column when moving up through a shorter line",
				[
					setAt("2222222222x222\n\n1111111111_111111111111", 2, 23),
					key(K.home),
					keys(K.right, 10),
					keyAt(K.up, 1, 0),
					keyAt(K.up, 0, 10),
				],
			],
			[
				"preserves the target column when moving down through a shorter line",
				[
					set("1111111111_111\n\n2222222222x222222222222"),
					keys(K.up, 2),
					key(K.home),
					keys(K.right, 10),
					keyAt(K.down, 1, 0),
					keyAt(K.down, 2, 10),
				],
			],
			[
				"resets the sticky column on left arrow",
				[
					set(threeLines),
					key(K.home),
					keys(K.right, 5),
					keysAt(K.up, 2, 0, 5),
					key(K.left),
					keysAt(K.down, 2, 2, 4),
				],
			],
			[
				"resets the sticky column on typing",
				[
					set(threeLines),
					key(K.home),
					keys(K.right, 8),
					keysAt(K.up, 2, 0, 8),
					typedAt("X", 0, 9),
					keysAt(K.down, 2, 2, 9),
				],
			],
			[
				"resets the sticky column on Ctrl+Left",
				[
					set("hello world\n\nhello world"),
					keysAt(K.up, 2, 0, 11),
					keyAt(K.wordLeft, 0, 6),
					keysAt(K.down, 2, 2, 6),
				],
			],
			[
				"resets the sticky column on undo",
				[
					set(threeLines),
					keys(K.up, 2),
					key(K.home),
					keys(K.right, 8),
					keysAt(K.down, 2, 2, 8),
					typedAt("X", 2, 9),
					keysAt(K.up, 2, 0, 9),
					key(K.undo, threeLines),
					keysAt(K.up, 2, 0, 8),
				],
			],
			[
				"restores the column after consecutive moves through short lines",
				[
					set("1234567890\nab\ncd\nef\n1234567890"),
					key(K.home),
					keysAt(K.right, 7, 4, 7),
					keysAt(K.up, 4, 0, 7),
					keysAt(K.down, 4, 4, 7),
				],
			],
			[
				"sets the preferred column when pressing right at the end of the prompt",
				[
					set("111111111x1111111111\n\n333333333_"),
					keys(K.up, 2),
					keyAt(K.end, 0, 20),
					keysAt(K.down, 2, 2, 10),
					keyAt(K.right, 2, 10),
					keysAt(K.up, 2, 0, 10),
				],
			],
			[
				"clamps the preferred column after a narrower resize on the same line",
				[
					set("12345678901234567890\n\n12345678901234567890"),
					key(K.home),
					keys(K.right, 15),
					keysAt(K.up, 2, 0, 15),
					render(12),
					keysAt(K.down, 2, 2, 4),
				],
			],
			[
				"restores the preferred column across resizes on another line",
				[
					set("short\n12345678901234567890"),
					key(K.home),
					keysAt(K.right, 15, 1, 15),
					keyAt(K.up, 0, 5),
					render(10),
					keyAt(K.down, 1, 8),
					keyAt(K.up, 0, 5),
					render(80),
					keyAt(K.down, 1, 15),
				],
			],
			[
				"rewrapped lines: target fits the current visual column",
				[
					set("abcdefghijklmnopqr\n123456789012345678"),
					keys(K.up, 2),
					key(K.home),
					keysAt(K.right, 18, 0, 18),
					render(10),
					keyAt(K.down, 1, 8),
					render(80),
					keyAt(K.up, 0, 8),
					keyAt(K.down, 1, 8),
				],
			],
			[
				"rewrapped lines: target shorter than the current visual column",
				[
					set("abcdefghijklmnopqr\n123456789012345678\nab"),
					keys(K.up, 3),
					key(K.home),
					keysAt(K.right, 18, 0, 18),
					render(10),
					keyAt(K.down, 1, 8),
					render(80),
					keyAt(K.down, 2, 2),
					keyAt(K.up, 1, 8),
				],
			],
		]);

		it("moves up out of a wrapped visual line into the previous logical line", () => {
			const editor = newEditor(15);
			editor.setText("short\n123456789012345678901234567890");
			editor.render(15);
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 30 });

			editor.handleInput(K.up);
			assert.strictEqual(editor.getCursor().line, 1);
			editor.handleInput(K.up);
			assert.strictEqual(editor.getCursor().line, 1);
			editor.handleInput(K.up);
			assert.strictEqual(editor.getCursor().line, 0);
		});
	});

	describe("Paste marker atomic behavior", () => {
		const MARKER = /\[paste #\d+ \+\d+ lines\]/;

		function pasteWithMarker(editor: Editor, lines = 20): void {
			editor.handleInput(`\x1b[200~${"line\n".repeat(lines).trimEnd()}\x1b[201~`);
		}

		function markerLength(editor: Editor): number {
			const match = editor.getText().match(MARKER);
			assert.ok(match, "paste marker should be created");
			return match[0].length;
		}

		it("creates a paste marker for large pastes", () => {
			const editor = newEditor();
			pasteWithMarker(editor);

			assert.match(editor.getText(), MARKER);
		});

		const atomicCases: [name: string, steps: (marker: number) => Step[]][] = [
			[
				"right arrow",
				(marker) => [
					keyAt(K.home, 0, 0),
					keyAt(K.right, 0, 1),
					keyAt(K.right, 0, 1 + marker),
					keyAt(K.right, 0, 2 + marker),
				],
			],
			["left arrow", (marker) => [keyAt(K.left, 0, 1 + marker), keyAt(K.left, 0, 1), keyAt(K.left, 0, 0)]],
			[
				"backspace",
				(marker) => [key(K.home), keysAt(K.right, 2, 0, 1 + marker), { in: K.backspace, expect: "AB", at: [0, 1] }],
			],
			["forward delete", () => [key(K.home), key(K.right), { in: K.del, expect: "AB", at: [0, 1] }]],
		];

		for (const [name, steps] of atomicCases) {
			it(`treats a paste marker as a single unit for ${name}`, () => {
				const editor = newEditor();
				editor.handleInput("A");
				pasteWithMarker(editor);
				editor.handleInput("B");

				runSteps(editor, steps(markerLength(editor)));
			});
		}

		it("treats paste marker as a single unit for word movement", () => {
			const editor = newEditor();
			editor.handleInput("X");
			editor.handleInput(" ");
			pasteWithMarker(editor);
			editor.handleInput(" ");
			editor.handleInput("Y");
			const marker = markerLength(editor);

			editor.handleInput(K.home);
			editor.handleInput(K.wordRight);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
			editor.handleInput(K.wordRight);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 + marker });
		});

		it("undo restores marker after backspace deletion", () => {
			const editor = newEditor();
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");
			const textBefore = editor.getText();

			editor.handleInput(K.home);
			editor.handleInput(K.right);
			editor.handleInput(K.right);
			editor.handleInput(K.backspace);
			assert.strictEqual(editor.getText(), "AB");

			editor.handleInput(K.undo);
			assert.strictEqual(editor.getText(), textBefore);
		});

		it("handles multiple paste markers in same line", () => {
			const editor = newEditor();
			pasteWithMarker(editor);
			editor.handleInput(" ");
			pasteWithMarker(editor);

			const markers = [...editor.getText().matchAll(new RegExp(MARKER, "g"))];
			assert.strictEqual(markers.length, 2);
			const first = markers[0]![0].length;
			const second = markers[1]![0].length;

			editor.handleInput(K.home);
			editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: first });
			editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: first + 1 });
			editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: first + 1 + second });
		});

		it("does not treat manually typed marker-like text as atomic (no valid paste ID)", () => {
			const editor = newEditor();
			const fakeMarker = "[paste #99 +5 lines]";
			for (const char of fakeMarker) editor.handleInput(char);

			assert.strictEqual(editor.getText(), fakeMarker);
			editor.handleInput(K.home);
			editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		const overflowCases: { name: string; before: string; lines: number; after: string; width: number }[] = [
			{ name: "paste marker is wider than terminal width", before: "", lines: 47, after: "", width: 8 },
			{
				name: "text plus paste marker exceeds terminal width",
				before: "b".repeat(35),
				lines: 27,
				after: "bbbb",
				width: 54,
			},
			{
				name: "backtracking to a wrap opportunity re-checks overflow",
				before: ` ${"b".repeat(35)}`,
				lines: 27,
				after: "bbbb",
				width: 54,
			},
		];

		for (const testCase of overflowCases) {
			it(`does not exceed the render width when ${testCase.name}`, () => {
				const editor = newEditor();
				for (const char of testCase.before) editor.handleInput(char);
				pasteWithMarker(editor, testCase.lines);
				for (const char of testCase.after) editor.handleInput(char);
				assert.ok(markerLength(editor) > 0);

				for (const line of editor.render(testCase.width)) {
					assert.ok(
						visibleWidth(line) <= testCase.width,
						`line exceeds width ${testCase.width}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
					);
				}
			});
		}

		it("expands large pasted content literally in getExpandedText and on submit", () => {
			const editor = newEditor();
			const submissions: string[] = [];
			editor.onSubmit = (value) => submissions.push(value);
			const pastedText = [...Array(10).keys()]
				.map((index) => `line ${index + 1}`)
				.concat("tokens $1 $2 $& $$ $` $' end")
				.join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			assert.match(editor.getText(), MARKER);
			assert.strictEqual(editor.getExpandedText(), pastedText);

			editor.handleInput(K.enter);
			assert.deepStrictEqual(submissions, [pastedText]);
		});

		it("restores expanded pasted content from a paste snapshot", () => {
			const editor = newEditor();
			const pastedText = [...Array(11).keys()].map((index) => `line ${index + 1}`).join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			const markerText = editor.getText();
			const snapshot = editor.getPasteSnapshot();

			const restored = newEditor();
			restored.setText(markerText);
			restored.restorePasteSnapshot(snapshot);

			assert.match(markerText, MARKER);
			assert.strictEqual(restored.getExpandedText(), pastedText);
		});

		it("restores paste snapshot state on undo", () => {
			const editor = newEditor();
			const originalText = [...Array(11).keys()].map((index) => `original ${index + 1}`).join("\n");
			const restoredText = [...Array(12).keys()].map((index) => `restored ${index + 1}`).join("\n");
			const restoredSource = newEditor();

			editor.handleInput(`\x1b[200~${originalText}\x1b[201~`);
			const originalMarker = editor.getText();
			restoredSource.handleInput(`\x1b[200~${restoredText}\x1b[201~`);

			editor.setText(restoredSource.getText());
			editor.restorePasteSnapshot(restoredSource.getPasteSnapshot());
			assert.strictEqual(editor.getExpandedText(), restoredText);

			editor.handleInput(K.undo);
			assert.strictEqual(editor.getText(), originalMarker);
			assert.strictEqual(editor.getExpandedText(), originalText);
		});

		it("snaps to the paste marker start when navigating down into it", () => {
			const editor = newEditor();
			editor.setText("12345678901234567890\n\nhello ");
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			editor.render(80);

			editor.handleInput(K.up);
			editor.handleInput(K.up);
			editor.handleInput(K.home);
			for (let i = 0; i < 10; i++) editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		it("preserves sticky column when navigating through paste marker line", () => {
			const editor = newEditor(30);
			for (const char of "1234567890123456") editor.handleInput(char);
			editor.handleInput("\n");
			editor.handleInput("\n");
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			editor.handleInput("\n");
			editor.handleInput("\n");
			for (const char of "abcdefghijklmnop") editor.handleInput(char);
			editor.render(30);

			for (let i = 0; i < 4; i++) editor.handleInput(K.up);
			editor.handleInput(K.home);
			for (let i = 0; i < 10; i++) editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			for (const line of [1, 2, 3]) {
				editor.handleInput(K.down);
				assert.deepStrictEqual(editor.getCursor(), { line, col: 0 });
			}
			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 10 });
		});

		function multiVisualLineMarkerEditor(): { editor: Editor; markerStart: number; markerEnd: number } {
			const editor = newEditor(20);
			for (const char of "abcdefgh") editor.handleInput(char);
			pasteWithMarker(editor, 100);
			for (const char of "ijklmnopqr") editor.handleInput(char);
			editor.handleInput("\n");
			for (const char of "123456789012345678") editor.handleInput(char);
			editor.render(20);

			const marker = markerLength(editor);
			assert.ok(marker > 20, "marker should be wider than the terminal");
			return { editor, markerStart: 8, markerEnd: 8 + marker };
		}

		it("does not get stuck moving down from a multi-visual-line paste marker", () => {
			const { editor, markerStart, markerEnd } = multiVisualLineMarkerEditor();

			editor.handleInput(K.up);
			editor.handleInput(K.home);
			for (let i = 0; i < 6; i++) editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });

			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });
			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerEnd });
			editor.handleInput(K.up);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });
			editor.handleInput(K.up);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		it("skips marker continuation VLs when preferred col falls in marker tail", () => {
			const { editor, markerStart } = multiVisualLineMarkerEditor();

			editor.handleInput(K.up);
			editor.handleInput(K.home);
			for (let i = 0; i < 3; i++) editor.handleInput(K.right);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput(K.down);
			assert.strictEqual(editor.getCursor().col, markerStart);
			editor.handleInput(K.down);
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 3 });
			editor.handleInput(K.up);
			assert.strictEqual(editor.getCursor().col, markerStart);
			editor.handleInput(K.up);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		});
	});

	describe("Hidden bash prompt prefix", () => {
		/** Mirrors the coding agent editor: "!"/"!!" become a prompt gutter and are hidden from the input text. */
		class BashPromptEditor extends Editor {
			protected override getPromptPrefix(): string {
				return this.getBashPromptInfo(this.getLines()[0] ?? "")?.promptPrefix ?? "> ";
			}

			protected override getHiddenTextPrefixLength(lineIndex: number, line: string): number {
				if (lineIndex !== 0) return 0;
				return this.getBashPromptInfo(line)?.hiddenTextPrefixLength ?? 0;
			}

			private getBashPromptInfo(line: string): { promptPrefix: string; hiddenTextPrefixLength: number } | undefined {
				const trimmedLine = line.trimStart();
				const leadingWhitespaceLength = line.length - trimmedLine.length;
				if (trimmedLine.startsWith("!!")) {
					return {
						promptPrefix: "!! ",
						hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("!! ") ? 3 : 2),
					};
				}
				if (trimmedLine.startsWith("!")) {
					return {
						promptPrefix: "! ",
						hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("! ") ? 2 : 1),
					};
				}
				return undefined;
			}
		}

		const guardCases: [name: string, initial: string, steps: Step[], expected: string][] = [
			["treats the hidden prefix as the visual line start", "!echo", [key(K.home), typed("x")], "!xecho"],
			["keeps left navigation out of hidden bash prefixes", "!echo", [keys(K.left, 10), typed("x")], "!xecho"],
			[
				"keeps word-left navigation out of hidden bash prefixes",
				"! foo bar",
				[keys(K.wordLeft, 4), typed("x")],
				"! xfoo bar",
			],
			[
				"keeps backspace at the command boundary from deleting hidden prefixes",
				"!echo",
				[key(K.home), key(K.backspace)],
				"!echo",
			],
			["allows backspace to clear an empty bash marker", "!", [key(K.backspace)], ""],
			["hides the double-bang prefix from the input text", "  !! pwd", [key(K.home), typed("x")], "  !! xpwd"],
		];

		for (const [name, initial, steps, expected] of guardCases) {
			it(name, () => {
				const editor = new BashPromptEditor(createTestTUI(), defaultEditorTheme);
				editor.setText(initial);

				runSteps(editor, steps);

				assert.strictEqual(editor.getText(), expected);
			});
		}
	});
});
