import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

/** Default number of trailing visual lines shown when a tool output is collapsed. */
export const DEFAULT_COLLAPSED_PREVIEW_LINES = 5;

export interface CollapsedOutputPreviewOptions {
	/** Visual lines to keep visible when collapsed. Defaults to 5. */
	previewLines?: number;
	/** Whether to render the `(Ctrl+O to expand)` hint when lines are hidden. */
	showExpandHint?: boolean;
}

/**
 * Create a component that renders the LAST `previewLines` visual lines of
 * `output`, prefixed with `... N earlier lines (Ctrl+O to expand)` when the
 * output was truncated. Truncation is width-aware (long lines wrap before
 * being counted) and cached per render width.
 *
 * This is the shared collapsed-output behavior used by tool components whose
 * results have no custom renderer (e.g. MCP tools) and can be adopted by any
 * other renderer that wants Ctrl+O expand/collapse support for free.
 */
export function createCollapsedOutputPreview(output: string, options: CollapsedOutputPreviewOptions = {}): Component {
	const previewLines = options.previewLines ?? DEFAULT_COLLAPSED_PREVIEW_LINES;
	const showExpandHint = options.showExpandHint ?? true;
	const styledOutput = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");

	let cachedLines: string[] | undefined;
	let cachedSkipped: number | undefined;
	let cachedWidth: number | undefined;

	return {
		render(width: number): string[] {
			if (cachedLines === undefined || cachedWidth !== width) {
				const preview = truncateToVisualLines(styledOutput, previewLines, width);
				cachedLines = preview.visualLines;
				cachedSkipped = preview.skippedCount;
				cachedWidth = width;
			}
			const lines = [...(cachedLines ?? [])];
			if (cachedSkipped && cachedSkipped > 0) {
				const hint = showExpandHint
					? `${theme.fg("muted", `... ${cachedSkipped} earlier lines`)} ${expandCollapseHint("app.tools.expand", false)}`
					: theme.fg("muted", `... (${cachedSkipped} earlier lines)`);
				lines.unshift(truncateToWidth(hint, width, "..."));
			}
			return lines;
		},
		invalidate: () => {
			cachedLines = undefined;
			cachedSkipped = undefined;
			cachedWidth = undefined;
		},
	};
}
