import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";
import { parseOscColorResponse } from "../src/terminal-colors.js";

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal alternate screen handoff", () => {
	it("keeps raw input active and discards keys until the next fullscreen TUI starts", () => {
		const originalWrite = process.stdout.write;
		const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
		const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
		const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
		let isRaw = false;
		const rawModeChanges: boolean[] = [];
		const firstInputs: string[] = [];
		const secondInputs: string[] = [];

		Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: (enabled: boolean) => {
				isRaw = enabled;
				rawModeChanges.push(enabled);
				return process.stdin;
			},
		});
		Object.defineProperty(process.stdin, "resume", { configurable: true, value: () => process.stdin });
		Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
		process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		try {
			const first = new ProcessTerminal();
			first.start(
				(data) => firstInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			assert.equal(isRaw, true);
			process.stdin.emit("data", "\x1b[B");
			assert.deepEqual(firstInputs, []);

			const second = new ProcessTerminal();
			second.start(
				(data) => secondInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			process.stdin.emit("data", "x");

			assert.equal(isRaw, true);
			assert.deepEqual(secondInputs, ["x"]);
			second.stop();
			assert.equal(isRaw, false);
			assert.deepEqual(rawModeChanges, [true, true, false]);
		} finally {
			process.stdout.write = originalWrite;
			restoreProperty(process.stdin, "isRaw", originalIsRaw);
			restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
			restoreProperty(process.stdin, "resume", originalResume);
			restoreProperty(process.stdin, "pause", originalPause);
		}
	});

	it("does not inherit an active alternate screen before it is preserved", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
			second.stop();

			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 0);
			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("inherits a preserved alternate screen into the next terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			second.stop();
			assert.equal(second.altScreenActive, false);

			const third = new ProcessTerminal();
			assert.equal(third.altScreenActive, false);
			assert.ok(writes.includes("\x1b[?1049h"));
			assert.ok(writes.includes("\x1b[?1049l"));
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("lets the preserving terminal cancel a handoff before it is consumed", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });
			assert.equal(first.altScreenActive, false);

			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("only hands a preserved alternate screen to one terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			const third = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			assert.equal(third.altScreenActive, false);

			second.stop();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});
});

describe("OSC 10/11 color replies", () => {
	const cases: Array<[name: string, reply: string, parsed: ReturnType<typeof parseOscColorResponse>]> = [
		[
			"OSC 10 foreground with 16-bit components and an ST terminator",
			"\x1b]10;rgb:ffff/8000/0000\x1b\\",
			{ kind: "foreground", rgb: { r: 255, g: 128, b: 0 } },
		],
		[
			"OSC 10 foreground with 12-bit components",
			"\x1b]10;rgb:fff/800/000\x1b\\",
			{ kind: "foreground", rgb: { r: 255, g: 128, b: 0 } },
		],
		[
			"OSC 11 background with 8-bit components and a BEL terminator",
			"\x1b]11;rgb:00/5f/87\x07",
			{ kind: "background", rgb: { r: 0, g: 95, b: 135 } },
		],
		["an unsupported OSC number", "\x1b]12;rgb:ffff/ffff/ffff\x1b\\", undefined],
		["a malformed color payload", "\x1b]11;not-a-color\x1b\\", undefined],
	];

	for (const [name, reply, parsed] of cases) {
		it(`parses ${name}`, () => {
			assert.deepStrictEqual(parseOscColorResponse(reply), parsed);
		});
	}
});

function restoreProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}
