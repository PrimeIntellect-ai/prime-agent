import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const result: string[] = [];

		const emptyLine = " ".repeat(width);

		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		const availableWidth = Math.max(1, width - this.paddingX * 2);

		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		const displayText = truncateToWidth(singleLineText, availableWidth);

		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
