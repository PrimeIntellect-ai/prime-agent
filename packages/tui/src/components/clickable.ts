import type { ClickPosition, ClickRegion } from "../click-regions.js";
import type { Component } from "../tui.js";

/**
 * Wraps a component and turns its rendered rows into a single click region.
 */
export class Clickable implements Component {
	private regions: ClickRegion[] = [];

	constructor(
		private readonly child: Component,
		private readonly onClick: (position: ClickPosition) => void,
	) {}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const lines = this.child.render(width);
		this.regions = lines.length > 0 ? [{ line: 0, col: 0, width, height: lines.length, onClick: this.onClick }] : [];
		return lines;
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}
}
