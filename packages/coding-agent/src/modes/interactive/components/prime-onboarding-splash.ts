import {
	blendColor,
	type Component,
	getKeybindings,
	isLightColor,
	type Rgb,
	rgbTo256,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { PRIME_COMPACT_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { getResolvedThemeColors, type ThemeColor, theme } from "../theme/theme.js";

interface PrimeOnboardingSplashOptions {
	/** Kept for call-site compatibility; the block sizes itself to its content. */
	getRows?: () => number;
	requestRender?: () => void;
	animationIntervalMs?: number;
	/** Primary action wording when the account is already authenticated. */
	continueActionLabel?: string;
}

const LOGO_LINES = PRIME_COMPACT_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const ANIMATION_INTERVAL_MS = 120;
/** Matches BrandSplashHeader so the mark keeps its place when the block unmounts. */
const PADDING_X = 1;
/** The mark sits a little further right than the text column. */
const LOGO_INDENT = 5;
const MARKER_WIDTH = 2;
const MIN_HIGHLIGHT_WIDTH = 44;
const HIGHLIGHT_TRAILING = 16;
/** How far the selected row lifts off the canvas; lower reads more transparent. */
const HIGHLIGHT_LIFT = 0.08;
/** Canvas assumed when the theme leaves the background to the terminal. */
const DARK_CANVAS: Rgb = { r: 16, g: 16, b: 16 };
const LIGHT_CANVAS: Rgb = { r: 255, g: 255, b: 255 };

type SplashTone = Extract<ThemeColor, "accent" | "borderMuted" | "dim" | "mdLink" | "muted" | "text" | "warning">;

interface SplashCell {
	char: string;
	tone: SplashTone;
	priority: number;
}

interface QuietZone {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * First-run onboarding, rendered as an inline block anchored to the top left
 * rather than a full-screen modal: the compact brand mark over its lab field,
 * the welcome line beneath it, and two actions in the same selection language
 * as the model and provider pickers.
 */
export class PrimeOnboardingSplashComponent implements Component {
	private frame = 0;
	private animationInterval?: ReturnType<typeof setInterval>;
	private progressMessage?: string;
	private selectedIndex = 0;

	constructor(
		private readonly onSelect: () => void,
		private readonly onCancel: () => void,
		private readonly options: PrimeOnboardingSplashOptions = {},
	) {
		if (options.requestRender) {
			this.animationInterval = setInterval(() => {
				this.frame++;
				options.requestRender?.();
			}, options.animationIntervalMs ?? ANIMATION_INTERVAL_MS);
		}
	}

	invalidate(): void {
		// Render output is derived from current theme and selection state.
	}

	dispose(): void {
		if (!this.animationInterval) {
			return;
		}
		clearInterval(this.animationInterval);
		this.animationInterval = undefined;
	}

	showProgress(message: string): void {
		this.progressMessage = message;
		this.dispose();
		this.options.requestRender?.();
	}

	handleInput(keyData: string): void {
		if (this.progressMessage) {
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.selectedIndex === 0) {
				this.onSelect();
			} else {
				this.onCancel();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const layout = this.getLayout(safeWidth);
		const lines = [this.line(safeWidth, 0, "")];
		lines.push(...this.renderMarkRows(layout.fieldWidth).map((row) => this.line(safeWidth, layout.fieldLeft, row)));
		lines.push(this.line(safeWidth, 0, ""));
		lines.push(this.line(safeWidth, layout.contentLeft, this.renderBrandLine()));
		lines.push(this.line(safeWidth, 0, ""));
		if (this.progressMessage) {
			lines.push(this.line(safeWidth, layout.contentLeft + MARKER_WIDTH, theme.fg("muted", this.progressMessage)));
		} else {
			lines.push(...this.renderActions(safeWidth, layout));
		}
		// The block owns the pane while it is mounted: pad out the remaining rows
		// so the prompt dock underneath stays covered.
		const rows = this.options.getRows?.();
		if (rows !== undefined && Number.isFinite(rows)) {
			while (lines.length < Math.floor(rows)) {
				lines.push(this.line(safeWidth, 0, ""));
			}
		}
		return lines;
	}

	/**
	 * The field spans the full pane width; the mark, the welcome line and the
	 * actions are all left aligned at the pane edge.
	 */
	private getLayout(width: number): {
		contentLeft: number;
		contentWidth: number;
		fieldLeft: number;
		fieldWidth: number;
	} {
		const labels = [this.getPrimaryActionLabel(), "Continue later"];
		const labelWidth = labels.reduce((max, label) => Math.max(max, visibleWidth(label)), 0);
		const contentWidth = Math.min(
			Math.max(1, width - PADDING_X * 2),
			Math.max(MIN_HIGHLIGHT_WIDTH, MARKER_WIDTH + labelWidth + HIGHLIGHT_TRAILING),
		);
		// The field starts at the mark and runs to the right edge: nothing drifts
		// through the empty column to the left of the butterfly.
		return {
			contentLeft: PADDING_X,
			contentWidth,
			fieldLeft: LOGO_INDENT,
			fieldWidth: Math.max(1, width - LOGO_INDENT),
		};
	}

	private moveSelection(delta: number): void {
		const next = this.selectedIndex + delta;
		if (next < 0 || next > 1) {
			return;
		}
		this.selectedIndex = next;
		this.options.requestRender?.();
	}

	private renderBrandLine(): string {
		return (
			theme.fg("text", "Welcome to ") +
			theme.bold(theme.fg("text", "PRIME")) +
			theme.italic(theme.fg("text", " Agent"))
		);
	}

	private getPrimaryActionLabel(): string {
		const label = this.options.continueActionLabel;
		if (!label) {
			return "Log in with Prime Intellect";
		}
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	private renderActions(width: number, layout: { contentLeft: number; contentWidth: number }): string[] {
		const labels = [this.getPrimaryActionLabel(), "Continue later"];
		const highlightWidth = layout.contentWidth;
		const background = this.getHighlightBackground();
		return labels.map((label, index) => {
			const selected = index === this.selectedIndex;
			const marker = selected ? "> " : "  ";
			const content = truncateToWidth(marker + label, highlightWidth, "");
			const padded = content + " ".repeat(Math.max(0, highlightWidth - visibleWidth(content)));
			const styled = selected ? background(theme.bold(theme.fg("text", padded))) : theme.fg("muted", padded);
			return this.line(width, layout.contentLeft, styled);
		});
	}

	private renderMarkRows(fieldWidth: number): string[] {
		const rows = LOGO_LINES.length;
		const markLeft = 0;
		const canvas: SplashCell[][] = Array.from({ length: rows }, () =>
			Array.from({ length: fieldWidth }, (): SplashCell => ({ char: " ", tone: "dim", priority: 0 })),
		);
		const quietZone: QuietZone = { left: markLeft, right: markLeft + LOGO_WIDTH - 1, top: 0, bottom: rows - 1 };
		if (!this.progressMessage) {
			this.drawField(canvas, fieldWidth, rows, quietZone);
		}
		LOGO_LINES.forEach((line, y) => {
			[...line].forEach((char, x) => {
				if (char !== " ") {
					this.put(canvas, markLeft + x, y, char, "text", 8, fieldWidth);
				}
			});
		});
		return canvas.map((row) => this.renderCells(row));
	}

	/** The lab field of the old full-screen splash, scaled to the mark's band. */
	private drawField(canvas: SplashCell[][], width: number, height: number, quietZone: QuietZone): void {
		const frame = this.frame;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const hash = this.mod(x * 37 + y * 53 + frame * 11 + x * y * 3, 101);
				if (hash < 3) {
					this.put(canvas, x, y, "\u00b7", "dim", 1, width);
				}

				const centerX = Math.floor((width * 36) / 100);
				const centerY = Math.floor((height * 54) / 100);
				const contour = Math.abs(x - centerX) + Math.abs(y - centerY) * 4 + Math.floor(x / 6) - frame;
				if (x < Math.floor((width * 82) / 100) && this.mod(contour, 24) === 12) {
					this.put(canvas, x, y, (x + y) % 5 === 0 ? "\u254c" : "\u00b7", "borderMuted", 2, width);
				}

				const horizonY = Math.floor((height * 58) / 100);
				if (y === horizonY && x % 2 === 0 && this.mod(x + frame, 13) < 2) {
					this.put(canvas, x, y, "\u2500", this.mod(x + frame, 3) === 0 ? "accent" : "dim", 3, width);
				}

				// Scan columns run the whole width; the original splash started them at
				// mid-screen, which left the left half without any.
				if (!this.isInsideQuietZone(x, y, quietZone)) {
					if (x % 4 === 0) {
						const scanIndex = Math.floor(x / 4);
						const segment = this.mod(y + scanIndex * 2 + Math.floor(frame / 2), 6);
						if (y > 0 && y < height - 1 && segment < 2) {
							this.put(canvas, x, y, (scanIndex + y) % 4 === 0 ? "\u2503" : "\u254e", "mdLink", 4, width);
						}
					}
				}
			}
		}

		for (let traceIndex = 0; traceIndex < 3; traceIndex++) {
			const base =
				traceIndex === 0
					? Math.floor((height * 30) / 100)
					: traceIndex === 1
						? Math.floor((height * 49) / 100)
						: Math.floor((height * 72) / 100);
			for (let x = 0; x < width; x++) {
				let wave = this.mod(x * 2 + frame + traceIndex * 7, 16);
				if (wave > 7) {
					wave = 15 - wave;
				}
				const traceY = base + Math.trunc((wave - 3) / 2);
				if (this.mod(x + frame + traceIndex * 13, 41) === 0) {
					this.put(canvas, x, traceY, "\u25c6", "warning", 6, width);
				} else if (this.mod(x + frame, 12) === 0) {
					this.put(canvas, x, traceY, "\u2022", "accent", 6, width);
				} else {
					this.put(canvas, x, traceY, "\u00b7", "accent", 3, width);
				}
			}
		}
	}

	/**
	 * The soft wash used behind user messages, not the picker's solid selection
	 * fill: the selected row should lift off the canvas, not sit in a block.
	 */
	private getHighlightBackground(): (text: string) => string {
		const colors = getResolvedThemeColors();
		const text = parseHexColor(colors.text);
		const onDark = !text || isLightColor(text);
		// Lift the row a few percent off the canvas toward the text colour. Fading a
		// surface colour downward instead lands near black, which reads harsh.
		const canvas = parseHexColor(colors.background) ?? (onDark ? DARK_CANVAS : LIGHT_CANVAS);
		const lift: Rgb = onDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
		const washed = blendColor(lift, canvas, HIGHLIGHT_LIFT);
		const ansi =
			theme.colorMode === "truecolor"
				? `\x1b[48;2;${washed.r};${washed.g};${washed.b}m`
				: `\x1b[48;5;${rgbTo256(washed)}m`;
		return (value: string) => `${ansi}${value}\x1b[49m`;
	}

	private isInsideQuietZone(x: number, y: number, zone: QuietZone): boolean {
		return x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
	}

	private put(
		canvas: SplashCell[][],
		x: number,
		y: number,
		char: string,
		tone: SplashTone,
		priority: number,
		width: number,
	): void {
		if (y < 0 || y >= canvas.length || x < 0 || x >= width) return;
		const row = canvas[y];
		if (!row || !row[x] || row[x].priority > priority) return;
		row[x] = { char, tone, priority };
	}

	private renderCells(cells: SplashCell[]): string {
		let rendered = "";
		let currentTone: SplashTone | undefined;
		let segment = "";
		const flush = () => {
			if (!segment || !currentTone) return;
			rendered += theme.fg(currentTone, segment);
			segment = "";
		};
		for (const cell of cells) {
			if (cell.tone !== currentTone) {
				flush();
				currentTone = cell.tone;
			}
			segment += cell.char;
		}
		flush();
		return rendered;
	}

	private line(width: number, indent: number, content: string): string {
		const text = " ".repeat(indent) + content;
		const truncated = truncateToWidth(text, width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	private mod(value: number, divisor: number): number {
		return ((value % divisor) + divisor) % divisor;
	}
}

function parseHexColor(value: string | undefined): Rgb | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec(value?.trim() ?? "");
	if (!match?.[1]) {
		return undefined;
	}
	const int = Number.parseInt(match[1], 16);
	return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}
