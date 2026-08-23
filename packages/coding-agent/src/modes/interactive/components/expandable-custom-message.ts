import { Box } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * Shared skeleton for boxed custom-message cards (compaction, skill,
 * refinement) with a collapsed/expanded state driven by the shared
 * tool-output expansion toggle.
 */
export abstract class ExpandableCustomMessageBox extends Box {
	protected expanded = false;

	constructor() {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	protected abstract updateDisplay(): void;
}

/** Bold custom-message label like `[refinement]`. */
export function customMessageLabel(name: string): string {
	return theme.fg("customMessageLabel", `\x1b[1m[${name}]\x1b[22m`);
}
