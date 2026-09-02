import { type Component, truncateToWidth, visibleWidth } from "@prime-intellect/prime-agent-tui";
import { theme } from "../theme/theme.js";

export const TOOL_PANEL_PADDING_X = 2;

export function toolPanelContentWidth(width: number): number {
	return Math.max(1, width - TOOL_PANEL_PADDING_X * 2);
}

/**
 * Format a single tool panel line: content indented by the panel padding and
 * padded to the full width, on the subtle panel background that groups the
 * block.
 */
export function toolPanelLine(line: string, width: number): string {
	const contentWidth = toolPanelContentWidth(width);
	const truncated = truncateToWidth(line, contentWidth, "");
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
	const sidePad = " ".repeat(TOOL_PANEL_PADDING_X);
	return theme.bg("toolPanelBg", `${sidePad}${truncated}${padding}${sidePad}`);
}

/**
 * Panel shell for tool executions: a status header line followed by the
 * tool's own call/result components, every line on the panel background so
 * the whole block reads as one unit. Children render at the reduced content
 * width; lines that still overflow are truncated, matching ipython cell
 * behavior.
 */
export class ToolPanel implements Component {
	private children: Component[] = [];
	private header = "";
	private cache?: {
		width: number;
		header: string;
		bgSample: string;
		childLines: string[];
		lines: string[];
	};

	setHeader(header: string): void {
		this.header = header;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.cache = undefined;
	}

	clear(): void {
		this.children = [];
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const childLines: string[] = [];
		for (const child of this.children) {
			childLines.push(...child.render(toolPanelContentWidth(width)));
		}

		// The background sample detects theme changes that don't go through
		// invalidate().
		const bgSample = theme.bg("toolPanelBg", " ");
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.header === this.header &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		) {
			return cache.lines;
		}

		const lines: string[] = [toolPanelLine(this.header, width)];
		if (childLines.length > 0) {
			lines.push(toolPanelLine("", width));
			for (const line of childLines) {
				lines.push(toolPanelLine(line, width));
			}
		}
		this.cache = { width, header: this.header, bgSample, childLines, lines };
		return lines;
	}
}
