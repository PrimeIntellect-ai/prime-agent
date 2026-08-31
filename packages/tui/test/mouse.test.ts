import assert from "node:assert";
import { describe, it } from "node:test";
import { isMouseSequence, isWheelDown, isWheelUp, parseSgrMouseEvent } from "../src/mouse.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

describe("parseSgrMouseEvent", () => {
	it("parses wheel up and wheel down", () => {
		const up = parseSgrMouseEvent("\x1b[<64;10;5M");
		assert.deepStrictEqual(up, {
			button: 64,
			x: 10,
			y: 5,
			press: true,
			motion: false,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(isWheelUp(up!), true);
		assert.strictEqual(isWheelDown(up!), false);

		const down = parseSgrMouseEvent("\x1b[<65;1;1M");
		assert.strictEqual(isWheelDown(down!), true);
		assert.strictEqual(isWheelUp(down!), false);
	});

	it("strips modifier bits into flags", () => {
		const event = parseSgrMouseEvent("\x1b[<84;3;7M");
		assert.strictEqual(event!.button, 64);
		assert.strictEqual(event!.shift, true);
		assert.strictEqual(event!.ctrl, true);
		assert.strictEqual(event!.alt, false);
		assert.strictEqual(isWheelUp(event!), true);
	});

	it("distinguishes press from release", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5M")?.press, true);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5m")?.press, false);
	});

	it("flags drag motion and strips the motion bit from the button", () => {
		const drag = parseSgrMouseEvent("\x1b[<32;5;5M");
		assert.strictEqual(drag?.motion, true);
		assert.strictEqual(drag?.button, 0);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;5;5M")?.motion, false);
	});

	it("returns null for non-mouse input", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[A"), null);
		assert.strictEqual(parseSgrMouseEvent("a"), null);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<64;10M"), null);
	});
});

describe("isMouseSequence", () => {
	it("matches SGR and legacy mouse reports", () => {
		assert.strictEqual(isMouseSequence("\x1b[<64;10;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[M   "), true);
		assert.strictEqual(isMouseSequence("\x1b[A"), false);
	});
});

describe("SGR mouse through StdinBuffer", () => {
	it("assembles a sequence that arrives split across chunks", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const received: string[] = [];
		buffer.on("data", (seq) => received.push(seq));

		buffer.process("\x1b");
		buffer.process("[<64");
		buffer.process(";20;5M");

		assert.deepStrictEqual(received, ["\x1b[<64;20;5M"]);
		const event = parseSgrMouseEvent(received[0]!);
		assert.strictEqual(event!.button, 64);
		assert.strictEqual(event!.x, 20);
		assert.strictEqual(event!.y, 5);
		buffer.destroy();
	});

	it("assembles a DECRPM mouse-probe response", () => {
		const buffer = new StdinBuffer({ timeout: 10 });
		const received: string[] = [];
		buffer.on("data", (seq) => received.push(seq));

		buffer.process("\x1b[?1006;");
		buffer.process("2$y");

		assert.deepStrictEqual(received, ["\x1b[?1006;2$y"]);
		buffer.destroy();
	});
});
