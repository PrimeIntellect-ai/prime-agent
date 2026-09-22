import assert from "node:assert";
import { describe, it } from "node:test";
import type { ClickPosition, ClickRegion } from "../src/click-regions.js";
import { Box } from "../src/components/box.js";
import { Editor } from "../src/components/editor.js";
import { hyperlink } from "../src/terminal-image.js";
import { type Component, Container, type FullscreenOptions, TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const numbered = (count: number, prefix = "row") => Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
type Recorder = (position: ClickPosition) => void;

const region = (handler: Recorder, count: number, line: number, col: number, width = 10, height = 1) => {
	const rendered = numbered(count);
	let regions: ClickRegion[] = [];
	return {
		rendered,
		render: () => {
			regions = rendered.length > line ? [{ line, col, width, height, onClick: handler }] : [];
			return rendered;
		},
		invalidate: () => {},
		getClickRegions: () => regions,
	};
};
const plain = (lines: string[]): Component => ({ render: () => lines, invalidate: () => {} });
const chatSession = (rec: Recorder) => ({ scroll: [region(rec, 20, 15, 5)], dock: plain(["> prompt"]) });

async function withFullscreen<T extends FullscreenOptions>(
	build: (tui: TUI) => T,
	test: (
		ctx: T & { terminal: VirtualTerminal; tui: TUI; click: (x: number, y: number) => Promise<void> },
	) => Promise<void>,
): Promise<void> {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new TUI(terminal);
	tui.start();
	const spec = build(tui);
	tui.enterFullscreen(spec);
	await terminal.waitForRender();
	const click = async (x: number, y: number) => {
		terminal.sendInput(`\x1b[<0;${x};${y}M`);
		terminal.sendInput(`\x1b[<0;${x};${y}m`);
		await terminal.waitForRender();
	};
	try {
		await test({ ...spec, terminal, tui, click });
	} finally {
		tui.stop();
	}
}

describe("fullscreen click regions", () => {
	it("dispatches region clicks at region-relative positions, prefers hyperlinks, and ignores mouse-disabled sessions", async () => {
		const calls: ClickPosition[] = [];
		const urls: string[] = [];
		const rec = (p: ClickPosition) => calls.push(p);
		const prompt = plain(["> prompt"]);
		const footer = plain(["> prompt", "footer"]);
		const chatLines = plain(numbered(6, "chat"));
		const hyperlinkLayout = (tui: TUI) => {
			const chat = region(rec, 20, 15, 5);
			chat.rendered[15] = hyperlink("open docs", "https://example.com/docs");
			tui.onOpenUrl = (url) => urls.push(url);
			return { scroll: [chat], dock: prompt };
		};
		for (const {
			layout,
			click: [x, y, row, col],
			mouseOff,
			urls: opened,
		} of [
			{ layout: () => ({ ...chatSession(rec), dock: footer }), click: [8, 4, 0, 2] },
			{ layout: () => ({ scroll: [chatLines], dock: prompt, pin: region(rec, 1, 0, 2) }), click: [3, 1, 0, 0] },
			{ layout: () => ({ ...chatSession(rec), mouse: false }), click: [8, 5, 0, 0], mouseOff: true },
			{ layout: hyperlinkLayout, click: [8, 5, 0, 0], urls: ["https://example.com/docs"] },
		]) {
			calls.length = 0;
			await withFullscreen<FullscreenOptions>(layout, async ({ terminal, click }) => {
				if (mouseOff) assert.strictEqual(terminal.mouseTrackingActive, false);
				await click(x, y);
			});
			assert.deepStrictEqual(calls, mouseOff || opened ? [] : [{ row, col }]);
			if (opened) assert.deepStrictEqual(urls, opened);
		}
	});

	it("re-maps regions after scrolling and ignores drags, mismatched releases, non-left and modified clicks", async () => {
		const calls: ClickPosition[] = [];
		await withFullscreen(
			() => chatSession((p) => calls.push(p)),
			async ({ terminal, click }) => {
				for (const inputs of [
					["\x1b[<0;8;5M", "\x1b[<32;9;5M", "\x1b[<0;9;5m"],
					["\x1b[<0;8;5M", "\x1b[<0;8;2m"],
					["\x1b[<2;8;5M", "\x1b[<2;8;5m"],
					["\x1b[<4;8;5M", "\x1b[<4;8;5m"],
				]) {
					for (const input of inputs) terminal.sendInput(input);
					await terminal.waitForRender();
				}
				terminal.sendInput("\x1b[<64;5;5M");
				await terminal.waitForRender();
				await click(8, 5);
				await click(8, 8);
			},
		);
		assert.deepStrictEqual(calls, [{ row: 0, col: 2 }]);
	});

	it("drops dock regions clipped away and keeps the visible ones", async () => {
		const top: ClickPosition[] = [];
		const bottom: ClickPosition[] = [];
		const dock = new Container();
		dock.addChild(region((p) => top.push(p), 1, 0, 0));
		dock.addChild(plain(numbered(6, "mid")));
		dock.addChild(region((p) => bottom.push(p), 1, 0, 3));
		await withFullscreen(
			() => ({ scroll: [plain(numbered(6, "chat"))], dock }),
			async ({ click }) => {
				await click(4, 4);
				await click(5, 10);
			},
		);
		assert.deepStrictEqual(top, []);
		assert.deepStrictEqual(bottom, [{ row: 0, col: 1 }]);
	});

	it("blocks covered regions, dispatches overlay regions, and clips them to the rows actually rendered", async () => {
		for (const { covered, overlay, maxHeight, clicks, expected } of [
			{ covered: true, overlay: [12, 0, 4, 10, 1], clicks: [7, 4, 7, 1], expected: [{ row: 0, col: 2 }] },
			{ overlay: [5, 0, 0, 10, 5], maxHeight: 4, clicks: [5, 5, 5, 1], expected: [{ row: 0, col: 4 }] },
		]) {
			const baseCalls: ClickPosition[] = [];
			const overlayCalls: ClickPosition[] = [];
			const [count, line, col, width, height] = overlay;
			const overlayComponent = region((p) => overlayCalls.push(p), count, line, col, width, height);
			await withFullscreen(
				() =>
					covered
						? { ...chatSession((p) => baseCalls.push(p)), dock: plain(["> prompt", "footer"]) }
						: { scroll: [plain(numbered(20))], dock: plain(["> prompt", "footer"]) },
				async ({ terminal, tui, click }) => {
					tui.showOverlay(overlayComponent, { width: 20, anchor: "top-left", nonCapturing: true, maxHeight });
					await terminal.waitForRender();
					for (let i = 0; i < clicks.length; i += 2) await click(clicks[i]!, clicks[i + 1]!);
				},
			);
			assert.deepStrictEqual(baseCalls, [], "covered base regions never fire");
			assert.deepStrictEqual(overlayCalls, expected);
		}
	});

	it("places the editor cursor through real dock clicks, including where the dock clips top rows", async () => {
		for (const { text, footer, clicks } of [
			{ text: "hello world", footer: false, clicks: [7, 9, 0, 6] },
			{ text: "alpha\nbeta\ngamma\ndelta\nepsilon", footer: true, clicks: [3, 4, 1, 2, 2, 6, 3, 1, 3, 9, 3, 1] },
		]) {
			await withFullscreen(
				(tui) => {
					const editor = new Editor(tui, defaultEditorTheme);
					editor.setText(text);
					const dock = new Container();
					dock.addChild(editor);
					if (footer) dock.addChild(plain(["foot a", "foot b"]));
					return { scroll: [plain(numbered(20))], dock, editor };
				},
				async ({ editor, click }) => {
					for (let i = 0; i < clicks.length; i += 4) {
						await click(clicks[i]!, clicks[i + 1]!);
						assert.deepStrictEqual(editor.getCursor(), { line: clicks[i + 2]!, col: clicks[i + 3]! });
					}
					assert.strictEqual(editor.focused, true);
				},
			);
		}
	});

	it("drops Box click regions when a child later renders empty", () => {
		const calls: ClickPosition[] = [];
		const child = region((p) => calls.push(p), 1, 0, 0);
		const box = new Box(1, 1);
		box.addChild(child);
		assert.ok(box.render(20).length > 0);
		assert.strictEqual(box.getClickRegions().length, 1);
		child.rendered.length = 0;
		assert.deepStrictEqual(box.render(20), []);
		assert.strictEqual(box.getClickRegions().length, 0);
		assert.deepStrictEqual(calls, []);
	});
});
