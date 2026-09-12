import assert from "node:assert";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.js";
import {
	getCellDimensions,
	getCellDimensionsVersion,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

class InvalidateRecorder implements Component {
	readonly invalidateCalls: number[] = [];
	private renderCount = 0;

	render(): string[] {
		this.renderCount++;
		return [""];
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.invalidateCalls.push(this.renderCount);
	}
}

describe("cell dimension versioning", () => {
	it("bumps the version only when the dimensions change", () => {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const initialVersion = getCellDimensionsVersion();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		assert.strictEqual(getCellDimensionsVersion(), initialVersion);
		setCellDimensions({ widthPx: 8, heightPx: 18 });
		assert.strictEqual(getCellDimensionsVersion(), initialVersion + 1);
		assert.deepStrictEqual(getCellDimensions(), { widthPx: 8, heightPx: 18 });
	});

	it("re-renders images when cell dimensions change", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const image = new Image(
			"aGVsbG8=",
			"image/png",
			{ fallbackColor: (value) => value },
			{},
			{
				widthPx: 100,
				heightPx: 100,
			},
		);
		const initialLines = image.render(80);
		const cachedLines = image.render(80);
		assert.strictEqual(cachedLines, initialLines);

		setCellDimensions({ widthPx: 8, heightPx: 18 });
		const reRenderedLines = image.render(80);
		// 60 cells wide: 9px cells scale 100px to 540px -> 30 rows at 18px rows;
		// 8px cells scale to 480px -> 27 rows. The cache key must pick up the change.
		assert.strictEqual(initialLines.length, 30);
		assert.strictEqual(reRenderedLines.length, 27);
		resetCapabilitiesCache();
	});
});

describe("TUI cell size responses", () => {
	it("does not invalidate sibling components when a cell size response arrives", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InvalidateRecorder();

			tui.addChild(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;36;18t");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 18, heightPx: 36 });
			assert.deepStrictEqual(recorder.invalidateCalls, []);

			tui.stop();
		});
	});

	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});
});
