import assert from "node:assert";
import { describe, it } from "node:test";
import type { TerminalStopOptions } from "../src/terminal.js";
import { type Component, TUI } from "../src/tui.js";
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
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	return { terminal, tui, chat, dock };
}

function lines(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
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

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 12");
		assert.strictEqual(viewport[7], "Line 19");
		assert.strictEqual(viewport[8], "> prompt");
		assert.strictEqual(viewport[9], "footer");

		tui.stop();
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
});
