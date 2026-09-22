import assert from "node:assert";
import { describe, it } from "node:test";
import { deleteKittyImage, encodeKitty } from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

type RenderMode = "diff" | "full" | "preserve";

interface Harness {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	component: TestComponent;
	update: (lines: string[], mode?: RenderMode) => Promise<void>;
	resize: (cols: number, rows: number) => Promise<void>;
}

interface MountOptions {
	cols?: number;
	rows?: number;
	clearOnShrink?: boolean;
}

async function withHarness(
	initialLines: string[],
	body: (harness: Harness) => Promise<void>,
	{ cols = 40, rows = 10, clearOnShrink = false }: MountOptions = {},
): Promise<void> {
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	if (clearOnShrink) tui.setClearOnShrink(true);
	const component = new TestComponent();
	tui.addChild(component);
	component.lines = initialLines;
	tui.start();
	await terminal.waitForRender();

	const update = async (lines: string[], mode: RenderMode = "diff") => {
		component.lines = lines;
		if (mode === "preserve") tui.requestRenderPreservingViewport();
		else tui.requestRender(mode === "full");
		await terminal.waitForRender();
	};
	const resize = async (nextCols: number, nextRows: number) => {
		terminal.resize(nextCols, nextRows);
		await terminal.waitForRender();
	};

	try {
		await body({ terminal, tui, component, update, resize });
	} finally {
		tui.stop();
	}
}

function numbered(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

function kitty(imageId: number, data: string, rows = 1): string {
	return encodeKitty(data, { columns: 2, rows, imageId, moveCursor: false });
}

describe("TUI Kitty image cleanup", () => {
	const OLD_42 = kitty(42, "AAAA", 2);
	const NEW_42 = kitty(42, "BBBB", 1);
	const IMAGE_88 = kitty(88, "AAAA", 2);
	const IMAGE_77 = kitty(77, "AAAA", 2);
	const IMAGE_303 = kitty(303, "AAAA");

	const cases: Array<{
		name: string;
		initial: string[];
		act: (harness: Harness) => Promise<void>;
		first: string;
		second: string;
		forbidden?: string;
	}> = [
		{
			name: "deletes a changed image id before drawing the moved placement",
			initial: ["top", OLD_42],
			act: (h) => h.update([NEW_42, ""]),
			first: deleteKittyImage(42),
			second: NEW_42,
		},
		{
			name: "deletes and redraws an image when an earlier reserved row changes",
			initial: ["", IMAGE_88],
			act: (h) => h.update(["covered", IMAGE_88]),
			first: deleteKittyImage(88),
			second: IMAGE_88,
			forbidden: "\x1b[2J",
		},
		{
			name: "deletes previously rendered image ids before a full redraw clears the screen",
			initial: [IMAGE_77],
			act: (h) => h.update(["plain text"], "full"),
			first: deleteKittyImage(77),
			second: "\x1b[2J",
		},
		{
			name: "deletes bottom visible images when a height shrink clamps the previous viewport",
			initial: ["Line 0", "Line 1", IMAGE_303],
			act: (h) => h.resize(40, 2),
			first: deleteKittyImage(303),
			second: "\x1b[2J",
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			await withHarness(testCase.initial, async (harness) => {
				harness.terminal.clearWrites();
				await testCase.act(harness);

				const writes = harness.terminal.getWrites();
				const firstIndex = writes.indexOf(testCase.first);
				const secondIndex = writes.indexOf(testCase.second);
				assert.ok(firstIndex >= 0, "expected the stale placement to be deleted");
				assert.ok(secondIndex >= 0, "expected the follow-up write");
				assert.ok(firstIndex < secondIndex, "deletion must happen before the redraw");
				if (testCase.forbidden) assert.ok(!writes.includes(testCase.forbidden), "unexpected screen clear");
			});
		});
	}
});

describe("TUI resize handling", () => {
	const cases: Array<{
		name: string;
		env: Record<string, string | undefined>;
		resizes: Array<[number, number]>;
		fullRedraw: boolean;
		forbidden?: string[];
	}> = [
		{
			name: "triggers a full re-render when the terminal height changes",
			env: { TERMUX_VERSION: undefined },
			resizes: [[40, 15]],
			fullRedraw: true,
		},
		{
			name: "triggers a full re-render when the terminal width changes",
			env: { TERMUX_VERSION: undefined },
			resizes: [[60, 10]],
			fullRedraw: true,
		},
		{
			name: "skips full re-renders on height changes in Termux",
			env: { TERMUX_VERSION: "1" },
			resizes: [
				[40, 15],
				[40, 8],
				[40, 14],
				[40, 11],
			],
			fullRedraw: false,
			forbidden: ["\x1b[2J", "\x1b[3J"],
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			await withEnv(testCase.env, async () => {
				await withHarness(numbered(20), async ({ terminal, tui, resize }) => {
					terminal.clearWrites();
					const initialRedraws = tui.fullRedraws;
					for (const [cols, rows] of testCase.resizes) await resize(cols, rows);

					if (testCase.fullRedraw) assert.ok(tui.fullRedraws > initialRedraws, "expected a full redraw");
					else assert.strictEqual(tui.fullRedraws, initialRedraws, "expected no full redraw");
					for (const forbidden of testCase.forbidden ?? []) {
						assert.ok(!terminal.getWrites().includes(forbidden), `unexpected control sequence in writes`);
					}
					assert.ok(terminal.getViewport().join("\n").includes("Line 19"), "latest content stays visible");
				});
			});
		});
	}
});

describe("TUI differential rendering", () => {
	const cases: Array<{
		name: string;
		initial: string[];
		updates: Array<{ lines: string[]; fullRedraw?: boolean }>;
		expected: string[];
		exact?: boolean;
		clearOnShrink?: boolean;
		cols?: number;
		rows?: number;
	}> = [
		{
			name: "clears vacated rows when content shrinks significantly",
			clearOnShrink: true,
			initial: numbered(6),
			updates: [{ lines: ["Line 0", "Line 1"], fullRedraw: true }],
			expected: ["Line 0", "Line 1", "", ""],
		},
		{
			name: "clears vacated rows when content shrinks to a single line",
			clearOnShrink: true,
			initial: numbered(4),
			updates: [{ lines: ["Only line"] }],
			expected: ["Only line", ""],
		},
		{
			name: "clears every row when content shrinks to empty",
			clearOnShrink: true,
			initial: numbered(3),
			updates: [{ lines: [] }],
			expected: ["", "", ""],
		},
		{
			name: "tracks the cursor when a line changes after a shrink",
			initial: numbered(5),
			updates: [{ lines: numbered(3) }, { lines: ["Line 0", "CHANGED", "Line 2"] }],
			expected: ["Line 0", "CHANGED", "Line 2"],
		},
		{
			name: "repaints a changing middle line across spinner frames",
			initial: ["Header", "Working...", "Footer"],
			updates: ["|", "/", "-", "\\"].map((frame) => ({ lines: ["Header", `Working ${frame}`, "Footer"] })),
			expected: ["Header", "Working \\", "Footer"],
		},
		{
			name: "repaints first, last and non-adjacent changed rows without touching the others",
			initial: numbered(5),
			updates: [
				{ lines: ["FIRST", "Line 1", "Line 2", "Line 3", "Line 4"], fullRedraw: false },
				{ lines: ["FIRST", "Line 1", "Line 2", "Line 3", "LAST"], fullRedraw: false },
				{ lines: ["FIRST", "CHANGED 1", "Line 2", "CHANGED 3", "LAST"], fullRedraw: false },
			],
			expected: ["FIRST", "CHANGED 1", "Line 2", "CHANGED 3", "LAST"],
		},
		{
			name: "recovers when content goes empty and comes back",
			initial: numbered(3),
			updates: [{ lines: [] }, { lines: ["New Line 0", "New Line 1"] }],
			expected: ["New Line 0", "New Line 1", ""],
		},
		{
			name: "full re-renders when deleted lines move the viewport upward",
			cols: 20,
			rows: 5,
			initial: numbered(12),
			updates: [{ lines: numbered(7), fullRedraw: true }],
			expected: ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"],
			exact: true,
		},
		{
			name: "appends after a shrink without another full redraw",
			cols: 20,
			rows: 5,
			initial: numbered(8),
			updates: [
				{ lines: numbered(2), fullRedraw: true },
				{ lines: numbered(3), fullRedraw: false },
			],
			expected: ["Line 0", "Line 1", "Line 2", "", ""],
			exact: true,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			await withHarness(
				testCase.initial,
				async ({ terminal, tui, update }) => {
					for (const step of testCase.updates) {
						const redrawsBefore = tui.fullRedraws;
						await update(step.lines);
						if (step.fullRedraw === true) {
							assert.ok(tui.fullRedraws > redrawsBefore, "expected a full redraw for this step");
						} else if (step.fullRedraw === false) {
							assert.strictEqual(tui.fullRedraws, redrawsBefore, "expected the differential path");
						}
					}

					const viewport = terminal.getViewport();
					if (testCase.exact) {
						assert.deepStrictEqual(viewport, testCase.expected);
					} else {
						testCase.expected.forEach((expected, index) => {
							assert.strictEqual(viewport[index], expected, `row ${index}: ${JSON.stringify(viewport[index])}`);
						});
					}
				},
				{ cols: testCase.cols, rows: testCase.rows, clearOnShrink: testCase.clearOnShrink },
			);
		});
	}

	it("expands tabs before writing rendered lines to the terminal", async () => {
		await withHarness([], async ({ terminal, update }) => {
			await update(["\x1b[48;5;236m512:\t\tcode\x1b[49m"]);

			const writes = terminal.getWrites();
			assert.ok(!writes.includes("\t"), "rendered terminal output should not contain raw tabs");
			assert.ok(writes.includes("512:      code"), "tabs should expand to the measured three-column width");
		});
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];

		chat.lines = numbered(15, "Chat");
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		try {
			for (const lines of [numbered(8, "Selector"), editorLines]) {
				editor.lines = lines;
				tui.requestRender();
				await terminal.waitForRender();
			}

			const redrawsBeforeSwitch = tui.fullRedraws;
			chat.lines = numbered(12, "Chat");
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");
			assert.deepStrictEqual(terminal.getViewport(), [
				"Chat 5",
				"Chat 6",
				"Chat 7",
				"Chat 8",
				"Chat 9",
				"Chat 10",
				"Chat 11",
				"Editor 0",
				"Editor 1",
				"Editor 2",
			]);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI viewport-preserving render", () => {
	const ABOVE_IMAGE = kitty(101, "AAAA");
	const VISIBLE_IMAGE = kitty(202, "BBBB");

	function withImages(): string[] {
		const lines = numbered(30);
		lines[2] = ABOVE_IMAGE; // scrollback, above the 10-row viewport
		lines[25] = VISIBLE_IMAGE; // inside the visible slice
		return lines;
	}

	function expandAt(lines: string[], index: number): string[] {
		const expanded = [...lines];
		expanded.splice(index, 0, "Expanded A", "Expanded B", "Expanded C");
		return expanded;
	}

	const cases: Array<{
		name: string;
		initial?: string[];
		act: (harness: Harness) => Promise<void>;
		requires?: string[];
		forbids?: string[];
		check?: (harness: Harness) => void;
	}> = [
		{
			name: "repaints in place without clearing scrollback when content above the viewport grows",
			act: (h) => h.update(expandAt(h.component.lines, 3), "preserve"),
			forbids: ["\x1b[2J", "\x1b[3J"],
			check: ({ terminal }) => {
				assert.ok(terminal.getViewport().at(-1)?.includes("Line 29"), "latest line stays at the bottom");
				assert.ok(
					terminal.getScrollBuffer().some((line) => line.includes("Line 0")),
					"original scrollback content is preserved",
				);
			},
		},
		{
			name: "clears the screen but not scrollback when a tall transcript shrinks below the viewport",
			act: (h) => h.update(["Summary A", "Summary B", "Summary C"]),
			requires: ["\x1b[2J"],
			forbids: ["\x1b[3J"],
		},
		{
			name: "clears the screen but not scrollback when a still-tall transcript is rebuilt",
			act: (h) => h.update(numbered(15, "Rebuilt")),
			requires: ["\x1b[2J"],
			forbids: ["\x1b[3J"],
		},
		{
			name: "repaints in place instead of clearing scrollback when off-screen content changes",
			act: async (h) => {
				for (const index of [3, 7, 12]) {
					const lines = [...h.component.lines];
					lines[index] = `Line ${index} (updated)`;
					await h.update(lines);
				}
			},
			forbids: ["\x1b[2J", "\x1b[3J"],
			check: ({ terminal }) => {
				const viewport = terminal.getViewport().join("\n");
				assert.ok(viewport.includes("Line 29"), "viewport stays anchored at the latest content");
				assert.ok(viewport.includes("Line 20"), "bottom window remains visible");
				assert.ok(!viewport.includes("Line 0 "), "did not scroll back to the top");
			},
		},
		{
			name: "repaints only the visible window during screen-clearing redraws",
			act: (h) => h.resize(60, 10),
			requires: ["\x1b[2J", "Line 20", "Line 29"],
			forbids: ["Line 0", "Line 19"],
		},
		{
			name: "only deletes Kitty images inside the repainted viewport",
			initial: withImages(),
			act: (h) => h.update(expandAt(h.component.lines, 6), "preserve"),
			requires: [deleteKittyImage(202)],
			forbids: [deleteKittyImage(101)],
		},
		{
			name: "only deletes visible Kitty images during screen-clearing redraws",
			initial: withImages(),
			act: (h) => h.resize(60, 10),
			requires: ["\x1b[2J", deleteKittyImage(202)],
			forbids: [deleteKittyImage(101)],
		},
	];

	for (const testCase of cases) {
		it(testCase.name, async () => {
			await withHarness(testCase.initial ?? numbered(30), async (harness) => {
				harness.terminal.clearWrites();
				await testCase.act(harness);

				const writes = harness.terminal.getWrites();
				for (const required of testCase.requires ?? []) {
					assert.ok(writes.includes(required), `expected ${JSON.stringify(required)} in the writes`);
				}
				for (const forbidden of testCase.forbids ?? []) {
					assert.ok(!writes.includes(forbidden), `unexpected ${JSON.stringify(forbidden)} in the writes`);
				}
				testCase.check?.(harness);
			});
		});
	}

	it("does not leave maxLinesRendered inflated after a preserving collapse", async () => {
		await withHarness(
			numbered(30),
			async ({ terminal, tui, update }) => {
				await update(numbered(12), "preserve");
				const redrawsAfterCollapse = tui.fullRedraws;
				terminal.clearWrites();

				await update(numbered(12));
				assert.strictEqual(
					tui.fullRedraws,
					redrawsAfterCollapse,
					"no extra full redraw after the collapse settled",
				);
				assert.ok(!terminal.getWrites().includes("\x1b[3J"), "must not clear scrollback on the follow-up render");
			},
			{ clearOnShrink: true },
		);
	});
});
