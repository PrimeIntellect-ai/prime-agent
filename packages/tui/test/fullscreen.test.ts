import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.js";
import { Image } from "../src/components/image.js";
import { Markdown } from "../src/components/markdown.js";
import type { TerminalStopOptions } from "../src/terminal.js";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image.js";
import { type Component, Container, TUI } from "../src/tui.js";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class InputComponent extends TestComponent {
	inputs: string[] = [];
	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class SelectionOverlay extends TestComponent {
	private selected = 0;

	override render(width: number): string[] {
		return ["first", "second"].map((label, index) => {
			const line = label.padEnd(width);
			return index === this.selected ? `\x1b[48;5;238m${line}\x1b[49m` : line;
		});
	}

	handleInput(_data: string): void {
		this.selected = (this.selected + 1) % 2;
	}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	lastStopOptions: TerminalStopOptions | undefined;

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(options?: TerminalStopOptions): void {
		this.lastStopOptions = options;
		super.stop(options);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";
const PAGE_UP = "\x1b[5~";
const VIEWPORT_TOP = "\x1b[1;4A"; // shift+alt+up
const FOLLOW = "\x1b[1;6B"; // ctrl+shift+down

interface Setup {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	chat: TestComponent;
	dock: TestComponent;
}

function setup(transcriptLines: string[], cols = 40, rows = 10): Setup {
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	const chat = new TestComponent();
	chat.lines = transcriptLines;
	const dock = new TestComponent();
	dock.lines = ["> prompt", "footer"];
	// Children drive inline rendering (before enter / after exit); the same
	// components are passed explicitly as fullscreen scroll/dock roots.
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	return { terminal, tui, chat, dock };
}

function lines(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("TUI fullscreen mode", () => {
	it("enters the alt screen and lays out transcript window above the dock", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), true);
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");
		assert.strictEqual(terminal.mouseTrackingActive, true, "probe succeeds → wheel tracking enabled");

		// rows=10, dock=2 → window shows the last 8 of 20 transcript lines
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 12");
		assert.strictEqual(viewport[7], "Line 19");
		assert.strictEqual(viewport[8], "> prompt");
		assert.strictEqual(viewport[9], "footer");

		tui.stop();
	});

	it("renders terminal images as compact metadata fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const { terminal, tui, chat, dock } = setup(["before"], 80);
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 120, heightPx: 80 },
			);
			tui.enterFullscreen({ scroll: [chat, image], dock });
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			const imageRow = viewport.indexOf("[image/png · 120×80]");
			assert.strictEqual(viewport.indexOf("before") + 1, imageRow);
			assert.strictEqual(viewport.filter((line) => line.includes("/fullscreen off to view")).length, 0);
			assert.ok(!terminal.getWrites().includes("\x1b_G"));

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("restores inline rendering after leaving fullscreen", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(80, 10);
			const tui = new TUI(terminal);
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2, fallbackOnly: false },
				{ widthPx: 20, heightPx: 20 },
			);
			const dock = new TestComponent();
			dock.lines = ["> prompt"];
			tui.addChild(image);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getWrites().includes("\x1b_G"));

			tui.enterFullscreen({ scroll: [image], dock });
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().includes("[image/png · 20×20]"));

			tui.exitFullscreen({ flush: false });
			assert.strictEqual(image.render(80).length, 2);
			assert.ok(image.render(80).some((line) => line.includes("\x1b_G")));

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("uses compact metadata for images in fullscreen overlays", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const { terminal, tui, chat, dock } = setup(["history"], 80);
			tui.enterFullscreen({ scroll: [chat], dock });
			tui.showOverlay(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ fallbackOnly: false },
					{ widthPx: 20, heightPx: 20 },
				),
				{ width: 30 },
			);
			await terminal.waitForRender();

			assert.ok(!terminal.getWrites().includes("\x1b_G"));
			assert.ok(terminal.getViewport().some((line) => line.includes("[image/png · 20×20]")));

			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("keeps the window pinned to the bottom while following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		chat.lines = lines(25);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[7], "Line 24", "window follows appended content");
		assert.strictEqual(viewport[8], "> prompt", "dock stays pinned");

		tui.stop();
	});

	it("wheel up unfollows and freezes the window while content appends", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "wheel scrolls up 3 lines");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		chat.lines = lines(40);
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "appended content does not move the window");
		assert.strictEqual(viewport[8], "> prompt", "dock still visible");
		assert.strictEqual(tui.getScrollInfo()?.linesBelow, 23);
		assert.ok(viewport[7]?.includes("ctrl+shift+down to follow"), "follow hint composited above the dock");

		tui.stop();
	});

	it("hides the follow hint while following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		assert.ok(!terminal.getViewport().join("\n").includes("to follow"));

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().join("\n").includes("to follow"));

		terminal.sendInput(FOLLOW);
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().join("\n").includes("to follow"));

		tui.stop();
	});

	it("scrolling back to the bottom resumes following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(WHEEL_DOWN);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		chat.lines = lines(22);
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 21");

		tui.stop();
	});

	it("page and home/end keys scroll the window while the editor keeps focus", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const editor = new TestComponent();
		tui.setFocus(editor);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();
		// window height 8 → page size 7; top was 22, now 15
		assert.strictEqual(terminal.getViewport()[0], "Line 15");

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 0");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(FOLLOW);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 29");
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		tui.stop();
	});

	it("row-diffs frames: only changed rows are repainted", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.clearWrites();

		chat.lines = [...lines(19), "Line 19 changed"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "no full clear for a single-line change");
		assert.ok(writes.includes("\x1b[8;1H"), "repaints the changed row (window row 8)");
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.strictEqual(repaintedRows.length, 1, "exactly one row repainted");
		assert.strictEqual(terminal.getViewport()[7], "Line 19 changed");

		tui.stop();
	});

	it("resize repaints the whole frame and clamps the scroll position", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 20);
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "resize forces a full frame repaint");
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 0", "scroll position clamped, still at top");
		assert.strictEqual(viewport[18], "> prompt", "dock re-anchored to the new bottom");

		tui.stop();
	});

	it("composites overlays onto the fullscreen frame", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const overlay = new TestComponent();
		overlay.lines = ["OVERLAY CONTENT"];
		const handle = tui.showOverlay(overlay, { anchor: "center", width: 20 });
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("OVERLAY CONTENT")),
			"overlay visible on the fullscreen frame",
		);

		handle.hide();
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("OVERLAY CONTENT")));

		tui.stop();
	});

	it("repaints only changed rows when navigating a focused overlay", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		tui.showOverlay(new SelectionOverlay(), { anchor: "center", width: 20 });
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.sendInput("j");
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.ok(!writes.includes("\x1b[2J"), "overlay navigation should not clear the screen");
		assert.strictEqual(repaintedRows.length, 2, "only the old and new selected rows should repaint");

		tui.stop();
	});

	it("suspends fullscreen mouse tracking while a visible overlay requests native mouse", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, true);

		const overlay = new InputComponent();
		overlay.lines = ["https://example.com/login"];
		const handle = tui.showOverlay(overlay, {
			anchor: "center",
			width: 40,
			suspendFullscreenMouse: true,
		});
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, false);

		handle.setHidden(true);
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, true);

		handle.setHidden(false);
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, false);

		handle.hide();
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, true);

		tui.stop();
	});

	it("drag-selecting focused overlay text copies from the fullscreen frame", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const url = "https://example.com/login";
		const overlay = new InputComponent();
		overlay.lines = ["Sign-in link", url];
		tui.showOverlay(overlay, { anchor: "center", width: 40 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible in the focused overlay");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "overlay selection is highlighted while dragging");

		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);
		assert.deepStrictEqual(overlay.inputs, [], "mouse reports are consumed before overlay input handlers");

		tui.stop();
	});

	it("drag-selects ANSI-styled wide text from a focused overlay", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 40, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const overlay = new InputComponent();
		overlay.lines = ["\x1b[48;5;236m  界🙂  \x1b[49m"];
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["界🙂"]);
		tui.stop();
	});

	it("maps focused overlay selection to the painted viewport slice", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 5);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const url = "https://example.com/visible";
		const overlay = new InputComponent();
		overlay.lines = [url, "overlay row 1", "overlay row 2", "overlay row 3", "overlay row 4", "overlay row 5"];
		tui.showOverlay(overlay, { anchor: "top-left", width: 40 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible after the over-tall frame is sliced");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("copies an active frame selection if focus changes before release", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const url = "https://example.com/focus-change";
		const overlay = new InputComponent();
		overlay.lines = ["Sign-in link", url];
		tui.showOverlay(overlay, { anchor: "center", width: 44 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible in the focused overlay");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		tui.setFocus(chat);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("keeps focused overlay selection within visible overlay text", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const url = "https://example.com/clamped";
		const overlay = new InputComponent();
		overlay.lines = ["Sign-in link", url];
		tui.showOverlay(overlay, { anchor: "center", width: 44 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible in the focused overlay");
		const outsideRow = viewport.findIndex((line, index) => index !== row && line.includes("Line "));
		assert.notStrictEqual(outsideRow, -1, "transcript row is visible outside the overlay");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const paddedEndX = startX + url.length + 6;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${paddedEndX};${y}M`);
		terminal.sendInput(`\x1b[<32;1;${outsideRow + 1}M`);
		terminal.sendInput(`\x1b[<0;1;${outsideRow + 1}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("does not select lower overlay text covered by a higher overlay", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const lower = new InputComponent();
		lower.lines = ["https://lower.example/login"];
		tui.showOverlay(lower, { anchor: "bottom-left", width: 32 });

		const upper = new InputComponent();
		upper.lines = ["TOP"];
		tui.showOverlay(upper, { anchor: "bottom-left", width: 32 });
		await terminal.waitForRender();

		const row = terminal.getViewport().findIndex((line) => line.startsWith("TOP"));
		assert.notStrictEqual(row, -1, "higher overlay is visible");
		const hiddenLowerTextX = 11;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${hiddenLowerTextX};${y}M`);
		terminal.sendInput(`\x1b[<32;1;${y}M`);
		terminal.sendInput(`\x1b[<0;1;${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("maps focused overlay transcript fallback to the painted viewport slice", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 40, 5);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const overlay = new InputComponent();
		overlay.lines = ["", "", "", "", "", ""];
		tui.showOverlay(overlay, { anchor: "top-left", width: 1 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("18"), "top painted row is shifted by the over-tall overlay");
		const col = viewport[0]!.indexOf("18");
		const startX = col + 1;
		const endX = startX + 2;

		terminal.sendInput(`\x1b[<0;${startX};1M`);
		terminal.sendInput(`\x1b[<32;${endX};1M`);
		terminal.sendInput(`\x1b[<0;${endX};1m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["18"]);

		tui.stop();
	});

	it("does not select text from an unfocused visible overlay", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20), 80, 10);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const lowerUrl = "https://lower.example/login";
		const lower = new InputComponent();
		lower.lines = [lowerUrl];
		tui.showOverlay(lower, { anchor: "bottom-left", width: 32 });

		const upper = new InputComponent();
		upper.lines = ["Focused dialog"];
		tui.showOverlay(upper, { anchor: "top-right", width: 24 });
		await terminal.waitForRender();

		const row = terminal.getViewport().findIndex((line) => line.includes(lowerUrl));
		assert.notStrictEqual(row, -1, "unfocused lower overlay is visible");
		const col = terminal.getViewport()[row]!.indexOf(lowerUrl);
		const startX = col + 1;
		const endX = startX + lowerUrl.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("exit restores the primary screen and flushes fullscreen-era content into scrollback", async () => {
		const { terminal, tui, chat, dock } = setup(lines(5));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");

		chat.lines = lines(30);
		tui.requestRender();
		await terminal.waitForRender();

		tui.exitFullscreen();
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), false);
		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
		const scrollBuffer = terminal.getScrollBuffer().join("\n");
		assert.ok(scrollBuffer.includes("Line 29"), "content appended while fullscreen reached the primary buffer");
		assert.ok(scrollBuffer.includes("Line 0"), "pre-fullscreen content still present");

		tui.stop();
	});

	it("stop() leaves the alt screen and disables mouse tracking", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		tui.stop();
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
	});

	it("drag-selecting copies the selected text on release", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// window shows lines 12-19; press on row 1 col 1, drag to row 2 col 6
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection highlighted while dragging");

		terminal.sendInput("\x1b[<0;6;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Line 12\nLine"]);

		tui.stop();
	});

	it("keeps wrapped table-cell selection inside the originating cell", async () => {
		const terminal = new LoggingVirtualTerminal(40, 12);
		const tui = new TUI(terminal);
		const markdown = new Markdown(
			`| URL | Status |
| --- | --- |
| https://example.com/this/is/a/very/long/path | should-not-copy |`,
			0,
			0,
			defaultMarkdownTheme,
		);
		const box = new Box(1, 0);
		box.addChild(markdown);
		const chat = new Container();
		chat.addChild(box);
		const dock = new TestComponent();
		dock.lines = ["> prompt", "footer"];
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.start();
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const lines = chat.render(40);
		const regions = chat
			.getSelectionRegions()
			.filter((region) => region.row === 1 && region.column === 0)
			.sort((a, b) => a.segment - b.segment);
		assert.ok(regions.length > 1, "URL cell should wrap across physical lines");
		assert.ok(lines.length <= 10, "table should fit without scrolling");

		const first = regions[0];
		const last = regions.at(-1)!;
		const expected = first.content;
		terminal.sendInput(`\x1b[<0;${first.col + 1};${first.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${last.col + last.width + 1};${last.line + 1}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "cell selection should be highlighted");

		terminal.sendInput(`\x1b[<0;${last.col + last.width + 1};${last.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [expected]);
		assert.ok(!copies[0].includes("should-not-copy"));

		tui.stop();
	});

	it("copies table selections as tab-separated content without borders", async () => {
		const terminal = new LoggingVirtualTerminal(40, 12);
		const tui = new TUI(terminal);
		const markdown = new Markdown(
			`| Name | Score | City |
| --- | --- | --- |
| Avery | 87 | Seattle |
| Jordan | 92 | Austin |
| Morgan | 74 | Boston |`,
			0,
			0,
			defaultMarkdownTheme,
		);
		const box = new Box(1, 0);
		box.addChild(markdown);
		const chat = new Container();
		chat.addChild(box);
		const dock = new TestComponent();
		dock.lines = ["> prompt", "footer"];
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.start();
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const tableRegions = chat.getSelectionRegions();
		const { tableTop: top, tableBottom: bottom, tableLeft: left, tableRight: right } = tableRegions[0];
		terminal.sendInput(`\x1b[<0;${left};${top + 1}M`);
		terminal.sendInput(`\x1b[<32;${right};${bottom + 1}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "table cell contents should be highlighted");

		terminal.sendInput(`\x1b[<0;${right};${bottom + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\tCity\nAvery\t87\tSeattle\nJordan\t92\tAustin\nMorgan\t74\tBoston"]);
		assert.ok(!/[┌┬┐├┼┤└┴┘│─]/.test(copies[0]));

		tui.stop();
	});

	it("auto-scrolls upward while selecting at the transcript edge", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<32;1;1M");
		await waitFor(() => (tui.getScrollInfo()?.linesAbove ?? 22) < 22);
		await terminal.waitForRender();

		const scrollInfo = tui.getScrollInfo();
		assert.ok(scrollInfo);
		const { linesAbove } = scrollInfo;
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [lines(26).slice(linesAbove).join("\n")]);

		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(tui.getScrollInfo()?.linesAbove, linesAbove, "release stops auto-scrolling");

		tui.stop();
	});

	it("auto-scrolls downward while selecting at the transcript edge", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<32;8;8M");
		await waitFor(() => (tui.getScrollInfo()?.linesAbove ?? 0) > 0);
		await terminal.waitForRender();

		const scrollInfo = tui.getScrollInfo();
		assert.ok(scrollInfo);
		const { linesAbove } = scrollInfo;
		terminal.sendInput("\x1b[<0;8;8m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [
			lines(30)
				.slice(3, linesAbove + 8)
				.join("\n"),
		]);

		tui.stop();
	});

	it("does not auto-scroll a horizontal selection on the top row", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.strictEqual(tui.getScrollInfo()?.linesAbove, 22);

		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Line 22"]);

		tui.stop();
	});

	it("drag-selecting dock text copies from the user input area", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// rows=10 and dock=2, so the user prompt is visible at screen row 9.
		terminal.sendInput("\x1b[<0;3;9M");
		terminal.sendInput("\x1b[<32;9;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "dock selection highlighted while dragging");

		terminal.sendInput("\x1b[<0;9;9m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["prompt"]);

		tui.stop();
	});

	it("writes OSC 52 when no copy handler is set", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();

		const expected = Buffer.from("Line 12", "utf8").toString("base64");
		assert.ok(terminal.getWrites().includes(`\x1b]52;c;${expected}\x07`));

		tui.stop();
	});

	it("a plain click copies nothing and clears any selection", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;3M");
		terminal.sendInput("\x1b[<0;5;3m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("mouse reports are consumed and never reach the focused component", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const received: string[] = [];
		const editor: Component = {
			render: () => [],
			invalidate: () => {},
			handleInput: (data: string) => received.push(data),
		};
		tui.setFocus(editor);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		terminal.sendInput("\x1b[<0;3;3M"); // left click
		terminal.sendInput("a");
		await terminal.waitForRender();

		assert.deepStrictEqual(received, ["a"], "only keyboard input reaches the editor");

		tui.stop();
	});

	it("can stop without leaving alt screen or flushing fullscreen content", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.clearWrites();
		tui.stop({ preserveAltScreen: true, flushFullscreen: false });
		await terminal.flush();

		assert.strictEqual(tui.isFullscreen(), false);
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");
		assert.strictEqual(terminal.mouseTrackingActive, false);
		assert.ok(!terminal.getWrites().includes("\x1b[?1049l"));
		assert.ok(!terminal.getWrites().includes("Line 29"));

		const next = new TUI(terminal);
		const nextContent = new TestComponent();
		nextContent.lines = ["Agents View"];
		const nextDock = new TestComponent();
		nextDock.lines = ["> prompt"];
		next.start();
		next.enterFullscreen({ scroll: [nextContent], dock: nextDock, mouse: false });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Agents View");
		assert.strictEqual(viewport.at(-1), "> prompt");

		next.stop({ flushFullscreen: false });
		await terminal.flush();
		assert.strictEqual(terminal.getActiveBufferType(), "normal");
	});

	it("ignores preserve requests when no alternate screen is active", async () => {
		const { terminal, tui } = setup(lines(3));
		await terminal.waitForRender();

		terminal.clearWrites();
		tui.stop({ preserveAltScreen: true });
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.lastStopOptions?.preserveAltScreen, false);
	});

	it("can pass viewport keys to the focused component", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const input = new InputComponent();
		tui.setFocus(input);
		tui.enterFullscreen({ scroll: [chat], dock, viewportControls: false });
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();

		assert.deepStrictEqual(input.inputs, [PAGE_UP]);

		tui.stop();
	});

	it("double-click selects a word", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Screen row 3 = transcript line 15 ("hello world foo bar")
		// "world" is at cols 6-10 (0-based). Click at col 7 -> SGR col=8, row=4.
		// First click (press + release)
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		// Second click (press + release) -- double-click
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["world"]);

		tui.stop();
	});

	it("triple-click selects a full line", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Triple-click at the same position
		// Click 1
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();
		// Click 2 (double-click)
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();
		copies.length = 0; // double-click already copied the word
		// Click 3 (triple-click)
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["hello world foo bar"]);

		tui.stop();
	});

	it("double-click and drag extends selection by words", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Double-click on "world" then drag right into "foo" without releasing
		// Click 1
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();
		// Click 2 -- double-click starts word selection
		terminal.sendInput("\x1b[<0;8;4M");
		// Drag to "foo" at col 13 -> SGR col=14
		terminal.sendInput("\x1b[<32;14;4M");
		// Release
		terminal.sendInput("\x1b[<0;14;4m");
		await terminal.waitForRender();

		// Should select "world foo" (word boundary snapping)
		assert.deepStrictEqual(copies, ["world foo"]);

		tui.stop();
	});

	it("double-click and drag left extends backward by words", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Double-click on "world" then drag left into "hello"
		// Click 1
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();
		// Click 2 -- double-click starts word selection
		terminal.sendInput("\x1b[<0;8;4M");
		// Drag left to "hello" at col 2 -> SGR col=3
		terminal.sendInput("\x1b[<32;3;4M");
		// Release
		terminal.sendInput("\x1b[<0;3;4m");
		await terminal.waitForRender();

		// Should select "hello world" (from start of "hello" to end of "world")
		assert.deepStrictEqual(copies, ["hello world"]);

		tui.stop();
	});

	it("click count resets after the double-click interval", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// First click
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		// Wait past the 500ms double-click interval
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Second click -- should be treated as a new single click, not a double-click
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		// No word selection -- single click copies nothing
		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("click count resets on a different row", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Click at row 4, col 8
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		// Click at row 5, col 8 -- different row
		terminal.sendInput("\x1b[<0;8;5M");
		terminal.sendInput("\x1b[<0;8;5m");
		await terminal.waitForRender();

		// No word selection
		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("double-click and drag across lines extends by words", async () => {
		const testLines = lines(20);
		testLines[14] = "alpha beta gamma";
		testLines[15] = "delta epsilon zeta";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Double-click on "beta" (line 14, col 7 → SGR col 8, row 3)
		// Click 1
		terminal.sendInput("\x1b[<0;8;3M");
		terminal.sendInput("\x1b[<0;8;3m");
		await terminal.waitForRender();
		// Click 2 -- double-click starts word selection on "beta"
		terminal.sendInput("\x1b[<0;8;3M");
		// Drag to "epsilon" (line 15, col 10 → SGR col 11, row 4)
		terminal.sendInput("\x1b[<32;11;4M");
		// Release
		terminal.sendInput("\x1b[<0;11;4m");
		await terminal.waitForRender();

		// Should select from "beta" start through "epsilon" end, spanning both lines
		assert.deepStrictEqual(copies, ["beta gamma\ndelta epsilon"]);

		tui.stop();
	});

	it("triple-click and drag extends by whole lines", async () => {
		const testLines = lines(20);
		testLines[14] = "alpha beta gamma";
		testLines[15] = "delta epsilon zeta";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Triple-click on line 14 (col 3, row 3 → SGR col 4, row 3)
		// Click 1
		terminal.sendInput("\x1b[<0;4;3M");
		terminal.sendInput("\x1b[<0;4;3m");
		await terminal.waitForRender();
		// Click 2 (double-click)
		terminal.sendInput("\x1b[<0;4;3M");
		terminal.sendInput("\x1b[<0;4;3m");
		await terminal.waitForRender();
		copies.length = 0;
		// Click 3 (triple-click -- selects full line)
		terminal.sendInput("\x1b[<0;4;3M");
		// Drag down to line 15 (col 5, row 4 → SGR col 6, row 4)
		terminal.sendInput("\x1b[<32;6;4M");
		// Release
		terminal.sendInput("\x1b[<0;6;4m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["alpha beta gamma\ndelta epsilon zeta"]);

		tui.stop();
	});

	it("double-clicking whitespace copies nothing", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Double-click on the space between "hello" and "world" (col 5 → SGR col 6, row 4)
		// Click 1
		terminal.sendInput("\x1b[<0;6;4M");
		terminal.sendInput("\x1b[<0;6;4m");
		await terminal.waitForRender();
		// Click 2
		terminal.sendInput("\x1b[<0;6;4M");
		terminal.sendInput("\x1b[<0;6;4m");
		await terminal.waitForRender();

		// Whitespace selection trims to null -- nothing copied
		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("double-click selects CJK wide-character words", async () => {
		const testLines = lines(20);
		testLines[15] = "hello \u4e16\u754c bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// "世界" occupies visible cols 6-9. Click at col 7 → SGR col 8, row 4.
		// Click 1
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();
		// Click 2
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["\u4e16\u754c"]);

		tui.stop();
	});

	it("selection remains highlighted after mouse release", async () => {
		const testLines = lines(20);
		testLines[15] = "hello world foo bar";
		const { terminal, tui, chat, dock } = setup(testLines);
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// Drag-select "hello" (cols 0-4 on line 15 = screen row 3)
		// SGR col 1 → internal col 0, SGR col 6 → internal col 5
		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<32;6;4M");
		await terminal.waitForRender();

		// Release
		terminal.sendInput("\x1b[<0;6;4m");
		await terminal.waitForRender();

		// Text was copied
		assert.deepStrictEqual(copies, ["hello"]);

		// Selection highlight persists after release — force a full repaint
		// and verify the highlight is re-applied
		terminal.clearWrites();
		terminal.resize(40, 11);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection highlight visible after release");

		// A plain click clears the persisted selection
		terminal.clearWrites();
		terminal.resize(40, 10);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;8;4M");
		terminal.sendInput("\x1b[<0;8;4m");
		await terminal.waitForRender();

		// Force repaint to check the highlight is gone
		terminal.clearWrites();
		terminal.resize(40, 11);
		await terminal.waitForRender();
		assert.ok(!terminal.getWrites().includes("\x1b[7m"), "selection cleared by plain click");

		tui.stop();
	});
});
