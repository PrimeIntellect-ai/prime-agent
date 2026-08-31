import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal, TerminalStopOptions } from "../src/terminal.js";

const XtermTerminal = xterm.Terminal;

export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;
	private _altScreenActive = false;
	private _mouseTrackingActive = false;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;

		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.xterm.write("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	stop(_options?: TerminalStopOptions): void {
		this.xterm.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		return true;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.xterm.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.xterm.write(`\x1b[${-lines}A`);
		}
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	enterAltScreen(): void {
		this._altScreenActive = true;
		this.write("\x1b[?1049h");
	}

	leaveAltScreen(): void {
		this._altScreenActive = false;
		this.write("\x1b[?1049l");
	}

	get altScreenActive(): boolean {
		return this._altScreenActive;
	}

	setMouseTracking(enabled: boolean): void {
		this._mouseTrackingActive = enabled;
	}

	get mouseTrackingActive(): boolean {
		return this._mouseTrackingActive;
	}

	setTitle(title: string): void {
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}

	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}

	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	async flush(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.xterm.write("", () => resolve());
		});
	}

	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	clear(): void {
		this.xterm.clear();
	}

	reset(): void {
		this.xterm.reset();
	}

	getCursorPosition(): { x: number; y: number } {
		const buffer = this.xterm.buffer.active;
		return {
			x: buffer.cursorX,
			y: buffer.cursorY,
		};
	}

	getActiveBufferType(): "normal" | "alternate" {
		return this.xterm.buffer.active.type;
	}

	async waitForRender(): Promise<void> {
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await this.flush();
	}
}
