#!/usr/bin/env node
import { matchesKey } from "../src/keys.js";
import { ProcessTerminal } from "../src/terminal.js";
import { type Component, TUI } from "../src/tui.js";

class KeyLogger implements Component {
	private log: string[] = [];
	private maxLines = 20;
	private tui: TUI;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.tui.stop();
			console.log("\nExiting...");
			process.exit(0);
		}

		const hex = Buffer.from(data).toString("hex");
		const charCodes = Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(", ");
		const repr = data
			.replace(/\x1b/g, "\\x1b")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/\x7f/g, "\\x7f");

		const logLine = `Hex: ${hex.padEnd(20)} | Chars: [${charCodes.padEnd(15)}] | Repr: "${repr}"`;

		this.log.push(logLine);

		if (this.log.length > this.maxLines) {
			this.log.shift();
		}

		this.tui.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push("=".repeat(width));
		lines.push("Key Code Tester - Press keys to see their codes (Ctrl+C to exit)".padEnd(width));
		lines.push("=".repeat(width));
		lines.push("");

		for (const entry of this.log) {
			lines.push(entry.padEnd(width));
		}

		const remaining = Math.max(0, 25 - lines.length);
		for (let i = 0; i < remaining; i++) {
			lines.push("".padEnd(width));
		}

		lines.push("=".repeat(width));
		lines.push("Test these:".padEnd(width));
		lines.push("  - Shift + Enter (should show: \\x1b[13;2u with Kitty protocol)".padEnd(width));
		lines.push("  - Alt/Option + Enter".padEnd(width));
		lines.push("  - Option/Alt + Backspace".padEnd(width));
		lines.push("  - Cmd/Ctrl + Backspace".padEnd(width));
		lines.push("  - Regular Backspace".padEnd(width));
		lines.push("=".repeat(width));

		return lines;
	}
}

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const logger = new KeyLogger(tui);

tui.addChild(logger);
tui.setFocus(logger);

process.on("SIGINT", () => {
	tui.stop();
	console.log("\nExiting...");
	process.exit(0);
});

tui.start();
