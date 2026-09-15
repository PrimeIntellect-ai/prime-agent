import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PRIME_COMPACT_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { getResolvedThemeColors, type ThemeColor, theme } from "../theme/theme.js";
import { isOnboardingExitKey } from "./onboarding-exit.js";
import { onboardingHighlightBackground } from "./onboarding-highlight.js";

interface PrimeOnboardingSplashOptions {
	/** Terminal rows; the block fills them so the prompt dock stays covered. */
	getRows?: () => number;
	requestRender?: () => void;
	animationIntervalMs?: number;
	/** Quits the app: the editor that normally owns Ctrl+C has no focus yet. */
	onExit?: () => void;
}

const LOGO_LINES = PRIME_COMPACT_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const ANIMATION_INTERVAL_MS = 120;
/** Matches BrandSplashHeader so the mark keeps its place when the block unmounts. */
const PADDING_X = 1;
/** The mark sits a little further right than the text column. */
const LOGO_INDENT = 5;
const LOGIN_ACTION_LABEL = "Log in with Prime Intellect";
const MARKER_WIDTH = 2;
/** What the agent is, wrapped under the welcome line. */
const DESCRIPTION_PARAGRAPHS = [
	"A self-improving RLM harness with persistent context, recursive subagents, and direct swarm communication.",
	"It learns from its history by refining its own memories, skills, prompts, and subagent specifications.",
];
const DESCRIPTION_WIDTH = 56;
const MIN_HIGHLIGHT_WIDTH = 30;
const HIGHLIGHT_TRAILING = 6;

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
	/** Stack, so a nested panel restores the one it covered when it closes. */
	private panels: { panel: Component; heading?: string }[] = [];
	/** Once a flow owns the block, the intro never comes back. */
	private flowStarted = false;

	constructor(
		private readonly onSelect: () => void,
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

	/**
	 * Mount a flow panel (a provider login, a question) inside the block, under
	 * the welcome line. Panels nest: a selector opened on top of a login dialog
	 * restores that dialog when it closes. Passing undefined pops the top panel.
	 */
	setPanel(panel: Component | undefined, heading?: string): void {
		if (panel) {
			this.panels.push({ panel, ...(heading ? { heading } : {}) });
			this.flowStarted = true;
		} else {
			this.panels.pop();
		}
		this.options.requestRender?.();
	}

	handleInput(keyData: string): void {
		if (isOnboardingExitKey(keyData)) {
			this.options.onExit?.();
			return;
		}
		if (this.getActivePanel()) {
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect();
		}
		// Cancel is deliberately unbound: signing in is the only way forward, and
		// the gaps between steps must not drop the user into an unconfigured chat.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const layout = this.getLayout(safeWidth);
		const lines = [this.line(safeWidth, 0, "")];
		lines.push(...this.renderMarkRows(layout.fieldWidth).map((row) => this.line(safeWidth, layout.fieldLeft, row)));
		lines.push(this.line(safeWidth, 0, ""));
		lines.push(this.line(safeWidth, layout.contentLeft, this.renderHeadingLine()));
		if (!this.getActivePanel() && !this.flowStarted) {
			lines.push(this.line(safeWidth, 0, ""));
			const descriptionWidth = Math.max(1, Math.min(DESCRIPTION_WIDTH, safeWidth - layout.contentLeft));
			DESCRIPTION_PARAGRAPHS.forEach((paragraph, index) => {
				if (index > 0) {
					lines.push(this.line(safeWidth, 0, ""));
				}
				for (const row of wrapTextWithAnsi(paragraph, descriptionWidth)) {
					lines.push(this.line(safeWidth, layout.contentLeft, theme.fg("muted", row)));
				}
			});
		}
		// The panel brings its own leading padding; a second blank row reads as a gap.
		if (!this.getActivePanel()) {
			lines.push(this.line(safeWidth, 0, ""));
		}
		const activePanel = this.getActivePanel();
		if (activePanel) {
			// The inline panel indents its own content by one column, so drop one
			// here to keep it flush with the welcome line.
			const panelLeft = Math.max(0, layout.contentLeft - 1);
			const panelWidth = Math.max(1, safeWidth - panelLeft);
			for (const row of activePanel.render(panelWidth)) {
				lines.push(this.line(safeWidth, panelLeft, row));
			}
		} else if (!this.flowStarted) {
			lines.push(...this.renderActions(safeWidth, layout));
		}
		// Onboarding owns the pane from the welcome screen through the last
		// question: pad out the remaining rows so the prompt dock stays covered.
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
		const labels = [LOGIN_ACTION_LABEL, "Continue later"];
		const labelWidth = labels.reduce((max, label) => Math.max(max, visibleWidth(label)), 0);
		const contentWidth = Math.min(
			Math.max(1, width - PADDING_X * 2),
			Math.max(MIN_HIGHLIGHT_WIDTH, MARKER_WIDTH + labelWidth + HIGHLIGHT_TRAILING),
		);
		// The field spans the pane; the mark sits a little in from the left edge.
		return { contentLeft: PADDING_X, contentWidth, fieldLeft: 0, fieldWidth: width };
	}

	/** The panel that owns the block names itself; otherwise the brand line. */
	/** The panel currently on top of the stack, if any. */
	getActivePanel(): Component | undefined {
		return this.panels[this.panels.length - 1]?.panel;
	}

	private renderHeadingLine(): string {
		const heading = this.panels[this.panels.length - 1]?.heading;
		if (heading) {
			return theme.bold(theme.fg("text", heading));
		}
		return this.renderBrandLine();
	}

	private renderBrandLine(): string {
		return (
			theme.fg("text", "Welcome to ") +
			theme.bold(theme.fg("text", "PRIME")) +
			theme.italic(theme.fg("text", " Agent"))
		);
	}

	/** Signing in is the only way forward, so the block offers a single action. */
	private renderActions(width: number, layout: { contentLeft: number; contentWidth: number }): string[] {
		const highlightWidth = layout.contentWidth;
		const content = truncateToWidth(`> ${LOGIN_ACTION_LABEL}`, highlightWidth, "");
		const padded = content + " ".repeat(Math.max(0, highlightWidth - visibleWidth(content)));
		const styled = this.getHighlightBackground()(theme.bold(theme.fg("text", padded)));
		return [this.line(width, layout.contentLeft, styled)];
	}

	private renderMarkRows(fieldWidth: number): string[] {
		const rows = LOGO_LINES.length;
		const markLeft = LOGO_INDENT;
		const canvas: SplashCell[][] = Array.from({ length: rows }, () =>
			Array.from({ length: fieldWidth }, (): SplashCell => ({ char: " ", tone: "dim", priority: 0 })),
		);
		const quietZone: QuietZone = { left: markLeft, right: markLeft + LOGO_WIDTH - 1, top: 0, bottom: rows - 1 };
		this.drawField(canvas, fieldWidth, rows, quietZone);
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

				// Scan columns trail the mark to the right; ambient dots, contours and
				// traces still drift across the full width, including left of it.
				if (x >= quietZone.left && !this.isInsideQuietZone(x, y, quietZone)) {
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

	private getHighlightBackground(): (text: string) => string {
		return onboardingHighlightBackground(getResolvedThemeColors());
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
