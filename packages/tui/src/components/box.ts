import type { TableCellSelectionRegion } from "../selection-metadata.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth } from "../utils.js";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
	selectionRegions: TableCellSelectionRegion[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			this.cache = undefined;
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		const childLines: string[] = [];
		const selectionRegions: TableCellSelectionRegion[] = [];
		for (const child of this.children) {
			const lineOffset = childLines.length;
			const lines = child.render(contentWidth);
			for (const region of child.getSelectionRegions?.() ?? []) {
				selectionRegions.push({
					...region,
					line: region.line + lineOffset + this.paddingY,
					col: region.col + this.paddingX,
					tableTop: region.tableTop + lineOffset + this.paddingY,
					tableBottom: region.tableBottom + lineOffset + this.paddingY,
					tableLeft: region.tableLeft + this.paddingX,
					tableRight: region.tableRight + this.paddingX,
				});
			}
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			this.cache = undefined;
			return [];
		}

		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		if (this.matchCache(width, childLines, bgSample)) {
			this.cache!.selectionRegions = selectionRegions;
			return this.cache!.lines;
		}

		const result: string[] = [];

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		this.cache = { childLines, width, bgSample, lines: result, selectionRegions };

		return result;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.cache?.selectionRegions ?? [];
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
