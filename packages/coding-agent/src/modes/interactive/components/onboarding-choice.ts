import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getResolvedThemeColors, theme } from "../theme/theme.js";
import { isOnboardingExitKey } from "./onboarding-exit.js";
import { onboardingHighlightBackground } from "./onboarding-highlight.js";

export interface OnboardingChoiceOption {
	label: string;
	/** Identifier shown after the label, dimmer than the name it belongs to. */
	detail?: string;
}

interface OnboardingChoiceOptions {
	prompt?: string;
	/** Muted sentence under the prompt, before the options. */
	description?: string;
	/** Grey footnote under the list, e.g. how to change the answer later. */
	note?: string;
	rowWidth?: number;
	selectedIndex?: number;
	requestRender?: () => void;
	/** Quits the app while onboarding owns the screen. */
	onExit?: () => void;
}

const MARKER_WIDTH = 2;
const MIN_ROW_WIDTH = 30;
const ROW_TRAILING = 6;
const DESCRIPTION_WIDTH = 50;

/**
 * A question in the onboarding block: a prompt, a list of options in the same
 * selection language as the first-run actions, and an optional grey footnote.
 */
export class OnboardingChoiceComponent implements Component {
	private selectedIndex: number;

	constructor(
		private readonly options: readonly OnboardingChoiceOption[],
		private readonly onSelect: (index: number) => void,
		private readonly onCancel: () => void,
		private readonly config: OnboardingChoiceOptions = {},
	) {
		this.selectedIndex = Math.max(0, Math.min(config.selectedIndex ?? 0, options.length - 1));
	}

	invalidate(): void {
		// Render output is derived from current theme and selection state.
	}

	handleInput(keyData: string): void {
		if (isOnboardingExitKey(keyData)) {
			this.config.onExit?.();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect(this.selectedIndex);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// Panels carry their own leading blank row and one column of indent, so the
		// host can render every flow panel at the same offset.
		const lines: string[] = [this.line(safeWidth, "")];
		if (this.config.prompt) {
			lines.push(this.line(safeWidth, theme.fg("text", this.config.prompt)));
			lines.push(this.line(safeWidth, ""));
		}
		if (this.config.description) {
			for (const row of wrapTextWithAnsi(
				this.config.description,
				Math.max(1, Math.min(DESCRIPTION_WIDTH, safeWidth - 2)),
			)) {
				lines.push(this.line(safeWidth, theme.fg("muted", row)));
			}
			lines.push(this.line(safeWidth, ""));
		}
		const labelWidth = this.options.reduce(
			(max, option) =>
				Math.max(max, visibleWidth(option.detail ? `${option.label}  ${option.detail}` : option.label)),
			0,
		);
		const rowWidth = Math.min(
			safeWidth,
			this.config.rowWidth ?? Math.max(MIN_ROW_WIDTH, MARKER_WIDTH + labelWidth + ROW_TRAILING),
		);
		const background = onboardingHighlightBackground(getResolvedThemeColors());
		this.options.forEach((option, index) => {
			const selected = index === this.selectedIndex;
			const name = `${selected ? "> " : "  "}${option.label}`;
			const detail = this.formatDetail(option);
			const plain = truncateToWidth(`${name}${detail}`, rowWidth, "");
			const pad = " ".repeat(Math.max(0, rowWidth - visibleWidth(plain)));
			// The identifier reads as a subtitle of the name, so it stays dimmer.
			const styled = selected
				? background(theme.bold(theme.fg("text", name)) + theme.fg("dim", `${detail}${pad}`))
				: theme.fg("muted", name) + theme.fg("dim", `${detail}${pad}`);
			lines.push(this.line(safeWidth, styled));
		});
		if (this.config.note) {
			lines.push(this.line(safeWidth, ""));
			lines.push(this.line(safeWidth, theme.fg("dim", this.config.note)));
		}
		return lines;
	}

	private formatDetail(option: OnboardingChoiceOption): string {
		return option.detail ? `  @${option.detail}` : "";
	}

	private move(delta: number): void {
		const next = this.selectedIndex + delta;
		if (next < 0 || next >= this.options.length) {
			return;
		}
		this.selectedIndex = next;
		this.config.requestRender?.();
	}

	private line(width: number, content: string): string {
		const truncated = truncateToWidth(content ? ` ${content}` : "", width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}
}
