import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable, OverlayHandle, OverlayOptions } from "../src/tui.js";
import { TUI } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticOverlay implements Component {
	constructor(private lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class LineContent implements Component {
	constructor(private build: (width: number) => string) {}

	render(width: number): string[] {
		const line = this.build(width);
		return [line, line, line];
	}

	invalidate(): void {}
}

class FocusableOverlay implements Component, Focusable {
	focused = false;
	inputs: string[] = [];

	constructor(private lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

interface Harness {
	terminal: VirtualTerminal;
	tui: TUI;
	editor: FocusableOverlay;
	flush: () => Promise<void>;
}

async function withTui(body: (harness: Harness) => Promise<void>): Promise<void> {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	const editor = new FocusableOverlay(["EDITOR"]);
	tui.addChild(new EmptyContent());
	tui.setFocus(editor);
	tui.start();
	try {
		await body({ terminal, tui, editor, flush: () => renderAndFlush(tui, terminal) });
	} finally {
		tui.stop();
	}
}

describe("TUI overlays", () => {
	describe("clipping and compositing", () => {
		const STYLED = (width: number) => `\x1b[1m\x1b[38;2;255;0;0m${"X".repeat(width)}\x1b[0m`;
		const HYPERLINK = (width: number) =>
			`See \x1b]8;;file:///path/to/file.ts\x07file.ts\x1b]8;;\x07 for details ${"X".repeat(width - 30)}`;
		const COMPLEX_OVERLAY_LINE =
			"\x1b[48;2;40;50;40m \x1b[38;2;128;128;128mSome styled content\x1b[39m\x1b[49m" +
			"\x1b]8;;http://example.com\x07link\x1b]8;;\x07" +
			" more content ".repeat(10);

		const cases: Array<{
			name: string;
			base?: (width: number) => string;
			overlayLines: string[];
			options: OverlayOptions;
			check?: (viewport: string[]) => void;
		}> = [
			{
				name: "truncates overlay lines wider than the declared width",
				overlayLines: ["X".repeat(100)],
				options: { width: 20 },
				check: (viewport) => {
					const longest = Math.max(...viewport.map((line) => line.match(/X+/)?.[0].length ?? 0));
					assert.strictEqual(longest, 20, "overlay content must be clipped to its declared width");
				},
			},
			{
				name: "clips overlay lines carrying SGR and OSC 8 sequences",
				overlayLines: [COMPLEX_OVERLAY_LINE, COMPLEX_OVERLAY_LINE, COMPLEX_OVERLAY_LINE],
				options: { width: 60 },
			},
			{
				name: "composites over styled base content",
				base: STYLED,
				overlayLines: ["OVERLAY"],
				options: { width: 20, anchor: "center" },
				check: (viewport) => assert.ok(viewport.some((line) => line.includes("OVERLAY"))),
			},
			{
				name: "composites over base content containing OSC 8 hyperlinks",
				base: HYPERLINK,
				overlayLines: ["OVERLAY"],
				options: { width: 20, anchor: "center" },
				check: (viewport) => assert.ok(viewport.some((line) => line.includes("OVERLAY"))),
			},
			{
				name: "clips wide characters at the overlay boundary",
				overlayLines: ["中文日本語한글テスト漢字"],
				options: { width: 15 },
				check: (viewport) => {
					const row = viewport.find((line) => line.includes("中"));
					assert.ok(row, "wide-character overlay should render");
					const content = row.trim();
					assert.ok(
						visibleWidth(content) <= 15,
						`wide characters not clipped to width: ${JSON.stringify(content)}`,
					);
				},
			},
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				tui.addChild(testCase.base ? new LineContent(testCase.base) : new EmptyContent());
				tui.showOverlay(new StaticOverlay(testCase.overlayLines), testCase.options);
				tui.start();
				try {
					await renderAndFlush(tui, terminal);
					const viewport = terminal.getViewport();
					assert.strictEqual(viewport.length, 24, "overlay must not add or drop rows");
					for (const line of viewport) {
						assert.ok(visibleWidth(line) <= 80, `row overflows the terminal: ${JSON.stringify(line)}`);
					}
					testCase.check?.(viewport);
				} finally {
					tui.stop();
				}
			});
		}
	});

	describe("focus restore", () => {
		const singleOverlayCases: Array<{
			name: string;
			act: (handle: OverlayHandle) => void;
			editorFocused: boolean;
			overlayFocused: boolean;
		}> = [
			{
				name: "showing a non-capturing overlay preserves focus",
				act: () => {},
				editorFocused: true,
				overlayFocused: false,
			},
			{
				name: "focus() transfers focus to the overlay",
				act: (h) => h.focus(),
				editorFocused: false,
				overlayFocused: true,
			},
			{
				name: "unfocus() restores previous focus",
				act: (h) => {
					h.focus();
					h.unfocus();
				},
				editorFocused: true,
				overlayFocused: false,
			},
			{
				name: "setHidden(false) does not auto-focus",
				act: (h) => {
					h.setHidden(true);
					h.setHidden(false);
				},
				editorFocused: true,
				overlayFocused: false,
			},
			{
				name: "hide() while unfocused leaves focus alone",
				act: (h) => h.hide(),
				editorFocused: true,
				overlayFocused: false,
			},
			{
				name: "hide() while focused restores previous focus",
				act: (h) => {
					h.focus();
					h.hide();
				},
				editorFocused: true,
				overlayFocused: false,
			},
		];

		for (const testCase of singleOverlayCases) {
			it(testCase.name, async () => {
				await withTui(async ({ tui, editor, flush }) => {
					const overlay = new FocusableOverlay(["OVERLAY"]);
					const handle = tui.showOverlay(overlay, { nonCapturing: true });
					testCase.act(handle);
					await flush();
					assert.strictEqual(editor.focused, testCase.editorFocused);
					assert.strictEqual(overlay.focused, testCase.overlayFocused);
					assert.strictEqual(handle.isFocused(), testCase.overlayFocused);
				});
			});
		}

		it("hiding a capturing overlay skips the non-capturing overlay below it", async () => {
			await withTui(async ({ tui, editor, flush }) => {
				const nonCapturing = new FocusableOverlay(["NC"]);
				const capturing = new FocusableOverlay(["CAP"]);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				const handle = tui.showOverlay(capturing);
				assert.strictEqual(capturing.focused, true);
				handle.hide();
				await flush();
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(nonCapturing.focused, false);
			});
		});

		it("unfocus() on the topmost capturing overlay falls back to the pre-overlay focus", async () => {
			await withTui(async ({ tui, editor, flush }) => {
				const capturing = new FocusableOverlay(["CAP"]);
				const handle = tui.showOverlay(capturing);
				assert.strictEqual(capturing.focused, true);
				handle.unfocus();
				await flush();
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(capturing.focused, false);
			});
		});

		it("hideOverlay() does not reassign focus when the topmost overlay is non-capturing", async () => {
			await withTui(async ({ tui, flush }) => {
				const capturing = new FocusableOverlay(["CAP"]);
				tui.showOverlay(capturing);
				tui.showOverlay(new FocusableOverlay(["NC"]), { nonCapturing: true });
				assert.strictEqual(capturing.focused, true);
				tui.hideOverlay();
				await flush();
				assert.strictEqual(capturing.focused, true);
			});
		});

		it("restores focus down a stack of mixed capturing and non-capturing overlays", async () => {
			await withTui(async ({ tui, editor, flush }) => {
				const c1 = new FocusableOverlay(["C1"]);
				const c2 = new FocusableOverlay(["C2"]);
				const c1Handle = tui.showOverlay(c1);
				tui.showOverlay(new FocusableOverlay(["N1"]), { nonCapturing: true });
				const c2Handle = tui.showOverlay(c2);
				tui.showOverlay(new FocusableOverlay(["N2"]), { nonCapturing: true });
				assert.strictEqual(c2.focused, true);
				c2Handle.hide();
				await flush();
				assert.strictEqual(c1.focused, true);
				c1Handle.hide();
				await flush();
				assert.strictEqual(editor.focused, true);
			});
		});

		it("returns focus to the editor after toggling between non-capturing overlays", async () => {
			await withTui(async ({ tui, editor, flush }) => {
				const a = new FocusableOverlay(["A"]);
				const b = new FocusableOverlay(["B"]);
				const aHandle = tui.showOverlay(a, { nonCapturing: true });
				const bHandle = tui.showOverlay(b, { nonCapturing: true });
				aHandle.focus();
				bHandle.focus();
				aHandle.focus();
				aHandle.unfocus();
				await flush();
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(a.focused, false);
				assert.strictEqual(b.focused, false);
			});
		});

		it("routes input past invisible and non-capturing overlays to the capturing overlay below", async () => {
			await withTui(async ({ terminal, tui, flush }) => {
				const fallbackCapturing = new FocusableOverlay(["FALLBACK"]);
				const nonCapturing = new FocusableOverlay(["NC"]);
				const primary = new FocusableOverlay(["PRIMARY"]);
				let isVisible = true;
				tui.showOverlay(fallbackCapturing);
				tui.showOverlay(nonCapturing, { nonCapturing: true });
				tui.showOverlay(primary, { visible: () => isVisible });
				assert.strictEqual(primary.focused, true);
				isVisible = false;
				terminal.sendInput("x");
				await flush();
				assert.deepStrictEqual(primary.inputs, []);
				assert.deepStrictEqual(nonCapturing.inputs, []);
				assert.deepStrictEqual(fallbackCapturing.inputs, ["x"]);
				assert.strictEqual(fallbackCapturing.focused, true);
			});
		});

		it("restores focus and input to the editor after a sub-overlay and its parent close", async () => {
			await withTui(async ({ terminal, tui, editor, flush }) => {
				const timer = new FocusableOverlay(["TIMER"]);
				const controller = new FocusableOverlay(["CTRL"]);
				const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
				tui.showOverlay(controller);
				assert.strictEqual(controller.focused, true);
				assert.strictEqual(editor.focused, false);
				timerHandle.hide();
				tui.hideOverlay();
				await flush();
				assert.strictEqual(editor.focused, true);
				assert.strictEqual(controller.focused, false);
				assert.strictEqual(timer.focused, false);
				terminal.sendInput("x");
				await flush();
				assert.deepStrictEqual(editor.inputs, ["x"]);
				assert.deepStrictEqual(controller.inputs, []);
				assert.deepStrictEqual(timer.inputs, []);
			});
		});

		it("restores focus when the sub-overlay is shown from a microtask", async () => {
			await withTui(async ({ terminal, tui, editor, flush }) => {
				const timer = new FocusableOverlay(["TIMER"]);
				const controller = new FocusableOverlay(["CTRL"]);
				const timerHandle = tui.showOverlay(timer, { nonCapturing: true });
				await Promise.resolve().then(() => {
					tui.showOverlay(controller);
				});
				await flush();
				assert.strictEqual(controller.focused, true);
				assert.strictEqual(editor.focused, false);

				timerHandle.hide();
				tui.hideOverlay();
				await flush();
				assert.strictEqual(editor.focused, true, "editor should regain focus");
				assert.strictEqual(controller.focused, false);
				assert.strictEqual(timer.focused, false);

				terminal.sendInput("x");
				await flush();
				assert.deepStrictEqual(editor.inputs, ["x"], "editor should receive input after close");
				assert.deepStrictEqual(controller.inputs, []);
			});
		});
	});
});
