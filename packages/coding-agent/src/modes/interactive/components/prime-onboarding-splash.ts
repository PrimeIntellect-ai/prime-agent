import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@prime-intellect/prime-agent-tui";
import { PRIME_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { type ThemeColor, theme } from "../theme/theme.js";

interface PrimeOnboardingSplashOptions {
	getRows?: () => number;
	requestRender?: () => void;
	animationIntervalMs?: number;
	continueActionLabel?: string;
}

const LOGO_LINES = PRIME_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const ANIMATION_INTERVAL_MS = 120;
const LAB_FIELD_HEIGHT = 14;
const LAB_FIELD_MIN_WIDTH = 42;
const LAB_FIELD_MAX_WIDTH = 78;

type SplashTone = Extract<ThemeColor, "accent" | "borderMuted" | "dim" | "mdLink" | "muted" | "text" | "warning">;

interface SplashCell {
	char: string;
	tone: SplashTone;
	priority: number;
	bold?: boolean;
	italic?: boolean;
}

interface StyledText {
	text: string;
	tone: SplashTone;
	bold?: boolean;
	italic?: boolean;
	transparentSpaces?: boolean;
}

type PanelTextLine = StyledText[];

interface PanelLine {
	left: number;
	parts: PanelTextLine;
}

interface QuietZone {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export class PrimeOnboardingSplashComponent implements Component {
	private frame = 0;
	private animationInterval?: ReturnType<typeof setInterval>;
	private progressMessage?: string;

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
		// Render output is derived from current theme.
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

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const panelLines = this.renderPanel(safeWidth);
		const targetRows = this.getTargetRows(panelLines.length);
		const topPadding = Math.max(0, Math.floor((targetRows - panelLines.length) / 2));
		const logoZone = this.logoQuietZone(safeWidth, topPadding, targetRows);
		const canvas = this.renderBackdrop(safeWidth, targetRows, logoZone);
		panelLines.forEach((line, index) => {
			this.drawStyledText(canvas, line.left, topPadding + index, line.parts, 8);
		});
		return canvas.map((line) => this.renderCells(line));
	}

	handleInput(keyData: string): void {
		if (this.progressMessage) {
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private formatContinueHint(): PanelTextLine {
		if (this.progressMessage) {
			return [{ text: this.progressMessage, tone: "muted" }];
		}
		const actionLabel = this.options.continueActionLabel ?? "login with Prime Intellect";
		return [
			{ text: "Press ", tone: "muted" },
			{ text: "Enter", tone: "accent", bold: true },
			{ text: ` to ${actionLabel}`, tone: "muted" },
		];
	}

	private formatBrandLine(): PanelTextLine {
		return [
			{ text: "Welcome to ", tone: "text" },
			{ text: "PRIME", tone: "text", bold: true },
			{ text: " Agent", tone: "text", italic: true },
		];
	}

	private renderPanel(width: number): PanelLine[] {
		const lines: PanelLine[] = [];

		for (const line of this.renderLogoBlock(width)) {
			lines.push(this.centerParts(line, width));
		}
		lines.push({ left: 0, parts: [] });
		lines.push({ left: 0, parts: [] });
		lines.push({ left: 0, parts: [] });
		lines.push(this.centerParts(this.formatBrandLine(), width));
		lines.push(this.centerParts(this.formatContinueHint(), width));

		return lines;
	}

	private renderLogoBlock(width: number): PanelTextLine[] {
		const logoWidth = Math.min(LOGO_WIDTH, width);
		return LOGO_LINES.map((line) => {
			const paddedLine = line + " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(line)));
			return [{ text: truncateToWidth(paddedLine, logoWidth, ""), tone: "text", transparentSpaces: true }];
		});
	}

	private renderBackdrop(width: number, rows: number, quietZone: QuietZone | undefined): SplashCell[][] {
		const canvas = Array.from({ length: rows }, () =>
			Array.from({ length: width }, (): SplashCell => ({ char: " ", tone: "dim", priority: 0 })),
		);

		this.drawLabField(canvas, width, rows, quietZone);

		return canvas;
	}

	private drawLabField(canvas: SplashCell[][], width: number, rows: number, quietZone: QuietZone | undefined): void {
		if (width < LAB_FIELD_MIN_WIDTH || rows < LAB_FIELD_HEIGHT + 2) {
			return;
		}

		const labWidth = Math.max(LAB_FIELD_MIN_WIDTH, Math.min(LAB_FIELD_MAX_WIDTH, width - 6));
		const left = Math.max(0, Math.floor((width - labWidth) / 2));
		const fieldTop = quietZone ? quietZone.top - 2 : Math.floor((rows - LAB_FIELD_HEIGHT) / 2);
		const top = Math.max(0, Math.min(rows - LAB_FIELD_HEIGHT, fieldTop));

		for (let labY = 0; labY < LAB_FIELD_HEIGHT; labY++) {
			for (let labX = 0; labX < labWidth; labX++) {
				const x = left + labX;
				const y = top + labY;
				const cell = this.labCell(labX, labY, labWidth);
				if (!cell) {
					continue;
				}
				if (cell.tone === "mdLink" && this.isInsideQuietZone(x, y, quietZone)) {
					continue;
				}
				this.put(canvas, x, y, cell.char, cell.tone, cell.priority);
			}
		}
	}

	private labCell(x: number, y: number, width: number): SplashCell | undefined {
		const height = LAB_FIELD_HEIGHT;
		const frame = this.frame;
		let cell: SplashCell | undefined;
		const setCell = (char: string, tone: SplashTone, priority: number) => {
			if (!cell || priority >= cell.priority) {
				cell = { char, tone, priority };
			}
		};

		const hash = this.mod(x * 37 + y * 53 + frame * 11 + x * y * 3, 101);
		if (hash < 3) {
			setCell("·", "dim", 1);
		}

		const centerX = Math.floor((width * 36) / 100);
		const centerY = Math.floor((height * 54) / 100);
		const contour = Math.abs(x - centerX) + Math.abs(y - centerY) * 4 + Math.floor(x / 6) - frame;
		if (x < Math.floor((width * 82) / 100) && this.mod(contour, 24) === 12) {
			setCell((x + y) % 5 === 0 ? "╌" : "·", "borderMuted", 2);
		}

		const horizonY = Math.floor((height * 58) / 100);
		if (y === horizonY && x % 2 === 0 && this.mod(x + frame, 13) < 2) {
			setCell("─", x > Math.floor((width * 60) / 100) ? "accent" : "dim", 3);
		}

		const scanStart = Math.max(0, Math.floor(width / 2) - 5);
		if (x >= scanStart) {
			const scanOffset = x - scanStart;
			if (scanOffset % 4 === 0) {
				const scanIndex = Math.floor(scanOffset / 4);
				const segment = this.mod(y + scanIndex * 2 + Math.floor(frame / 2), 6);
				if (y > 0 && y < height - 1 && segment < 2) {
					setCell((scanIndex + y) % 4 === 0 ? "┃" : "╎", "mdLink", 4);
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
			let wave = this.mod(x * 2 + frame + traceIndex * 7, 16);
			if (wave > 7) {
				wave = 15 - wave;
			}
			const traceY = base + Math.trunc((wave - 3) / 2);
			if (y !== traceY) {
				continue;
			}

			if (this.mod(x + frame + traceIndex * 13, 41) === 0) {
				setCell("◆", "warning", 5);
			} else if (this.mod(x + frame, 12) === 0) {
				setCell("•", "accent", 5);
			} else {
				setCell("·", "accent", 3);
			}
		}

		return cell;
	}

	private isInsideQuietZone(x: number, y: number, quietZone: QuietZone | undefined): boolean {
		return (
			quietZone !== undefined &&
			x >= quietZone.left &&
			x <= quietZone.right &&
			y >= quietZone.top &&
			y <= quietZone.bottom
		);
	}

	private drawStyledText(
		canvas: SplashCell[][],
		left: number,
		y: number,
		parts: PanelTextLine,
		priority: number,
	): void {
		let x = left;
		for (const part of parts) {
			for (const char of part.text) {
				const width = Math.max(0, visibleWidth(char));
				if (char !== " " || !part.transparentSpaces) {
					this.put(canvas, x, y, char, part.tone, priority, part.bold, part.italic);
				}
				x += Math.max(1, width);
			}
		}
	}

	private put(
		canvas: SplashCell[][],
		x: number,
		y: number,
		char: string,
		tone: SplashTone,
		priority: number,
		bold = false,
		italic = false,
	): void {
		if (y < 0 || y >= canvas.length) return;
		const row = canvas[y];
		if (!row || x < 0 || x >= row.length) return;
		if (row[x] && row[x].priority > priority) return;
		row[x] = { char, tone, priority, bold, italic };
	}

	private renderCells(cells: SplashCell[]): string {
		let rendered = "";
		let currentTone: SplashTone | undefined;
		let currentBold = false;
		let currentItalic = false;
		let segment = "";

		const flush = () => {
			if (!segment || !currentTone) return;
			let styled = theme.fg(currentTone, segment);
			if (currentItalic) {
				styled = theme.italic(styled);
			}
			if (currentBold) {
				styled = theme.bold(styled);
			}
			rendered += styled;
			segment = "";
		};

		for (const cell of cells) {
			const bold = cell.bold === true;
			const italic = cell.italic === true;
			if (cell.tone !== currentTone || bold !== currentBold || italic !== currentItalic) {
				flush();
				currentTone = cell.tone;
				currentBold = bold;
				currentItalic = italic;
			}
			segment += cell.char;
		}
		flush();
		return rendered;
	}

	private mod(value: number, divisor: number): number {
		return ((value % divisor) + divisor) % divisor;
	}

	private visiblePartsWidth(parts: PanelTextLine): number {
		return parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
	}

	private logoQuietZone(width: number, topPadding: number, rows: number): QuietZone | undefined {
		const logoWidth = Math.min(LOGO_WIDTH, width);
		if (logoWidth < 1 || rows < 1) {
			return undefined;
		}
		const left = Math.max(0, Math.floor((width - logoWidth) / 2));
		return {
			left,
			right: Math.min(width - 1, left + logoWidth - 1),
			top: Math.max(0, topPadding),
			bottom: Math.min(rows - 1, topPadding + LOGO_LINES.length - 1),
		};
	}

	private centerParts(parts: PanelTextLine, width: number): PanelLine {
		const left = Math.max(0, Math.floor((width - this.visiblePartsWidth(parts)) / 2));
		return { left, parts };
	}

	private getTargetRows(contentLineCount: number): number {
		const requestedRows = this.options.getRows?.();
		if (requestedRows && Number.isFinite(requestedRows)) {
			return Math.max(contentLineCount, Math.floor(requestedRows));
		}
		return contentLineCount;
	}
}
