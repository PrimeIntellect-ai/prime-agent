import { performance } from "node:perf_hooks";
import type { Terminal, TerminalStopOptions } from "../src/terminal.js";
import { type Component, type Focusable, TUI } from "../src/tui.js";

const HEIGHT = 40;
const ITERATIONS = 200;
const WIDTHS = [80, 120, 200];

class BenchmarkTerminal implements Terminal {
	altScreenActive = false;
	mouseTrackingActive = false;
	readonly kittyProtocolActive = false;

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(_options?: TerminalStopOptions): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	enterAltScreen(): void {
		this.altScreenActive = true;
	}

	leaveAltScreen(): void {
		this.altScreenActive = false;
	}

	setMouseTracking(enabled: boolean): void {
		this.mouseTrackingActive = enabled;
	}
}

class StaticComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class FullPaneSelector implements Component, Focusable {
	focused = false;
	private selected = 0;

	constructor(private readonly rows: number) {}

	handleInput(_data: string): void {
		this.selected = (this.selected + 1) % 10;
	}

	render(width: number): string[] {
		const lines = Array.from({ length: this.rows }, () => `\x1b[48;5;235m${" ".repeat(width)}\x1b[49m`);
		for (let index = 0; index < 10; index++) {
			const label = `  model-${index}  provider`.padEnd(width);
			const background = index === this.selected ? 238 : 235;
			lines[index + 5] = `\x1b[48;5;${background}m${label}\x1b[49m`;
		}
		return lines;
	}

	invalidate(): void {}
}

interface ImmediateTuiRender {
	doRender(): void;
}

function percentile(sorted: number[], percentileValue: number): number {
	const index = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
	return sorted[index];
}

function run(width: number, fullscreen: boolean): { p50: number; p95: number } {
	const terminal = new BenchmarkTerminal(width, HEIGHT);
	const tui = new TUI(terminal);
	const transcript = new StaticComponent(Array.from({ length: 100 }, (_, index) => `line-${index}`));
	const dock = new StaticComponent(["> prompt", "footer"]);
	const overlay = new FullPaneSelector(HEIGHT);

	if (fullscreen) {
		tui.enterFullscreen({ scroll: [transcript], dock, mouse: false });
	} else {
		tui.addChild(transcript);
		tui.addChild(dock);
	}
	tui.showOverlay(overlay, { width: "100%", maxHeight: "100%", row: 0, col: 0 });

	const render = (tui as unknown as ImmediateTuiRender).doRender.bind(tui);
	render();
	const durations: number[] = [];
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		overlay.handleInput("down");
		const start = performance.now();
		render();
		durations.push(performance.now() - start);
	}
	tui.stop({ flushFullscreen: false });

	durations.sort((a, b) => a - b);
	return { p50: percentile(durations, 50), p95: percentile(durations, 95) };
}

console.log(`focused overlay navigation (${HEIGHT} rows, ${ITERATIONS} updates)`);
for (const fullscreen of [false, true]) {
	const mode = fullscreen ? "fullscreen" : "inline";
	for (const width of WIDTHS) {
		const result = run(width, fullscreen);
		console.log(
			`${mode.padEnd(10)} ${String(width).padStart(3)} cols  p50 ${result.p50.toFixed(3)} ms  p95 ${result.p95.toFixed(3)} ms`,
		);
	}
}
