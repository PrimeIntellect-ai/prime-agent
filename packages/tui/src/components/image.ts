import {
	allocateImageId,
	getCapabilities,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.js";
import type { Component } from "../tui.js";

let fullscreenFallback = false;

export function withFullscreenImageFallback<T>(render: () => T): T {
	const previous = fullscreenFallback;
	fullscreenFallback = true;
	try {
		return render();
	} finally {
		fullscreenFallback = previous;
	}
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Renders textual image metadata instead of terminal graphics. */
	fallbackOnly?: boolean;
	/** Prefix prepended to textual fallback metadata. */
	fallbackPrefix?: string;
	/** Kitty image ID to reuse across updates or animations. */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;

	private cachedLines?: string[];
	private cachedWidth?: number;
	private cachedFullscreenFallback?: boolean;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** Returns the Kitty image ID allocated or supplied for this image. */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedFullscreenFallback = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.cachedFullscreenFallback === fullscreenFallback) {
			return this.cachedLines;
		}

		const maxWidth = Math.min(width - 2, this.options.maxWidthCells ?? 60);

		const caps = getCapabilities();
		let lines: string[];

		if (fullscreenFallback || this.options.fallbackOnly === true) {
			const parts = [this.mimeType];
			parts.push(`${this.dimensions.widthPx}×${this.dimensions.heightPx}`);
			if (this.options.filename) parts.unshift(this.options.filename);
			lines = [this.theme.fallbackColor(`${this.options.fallbackPrefix ?? ""}[${parts.join(" · ")}]`)];
		} else if (caps.images) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (result) {
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				// Return `rows` lines so TUI accounts for image height.
				// First (rows-1) lines are empty and cleared before the image is drawn.
				// Last line: move cursor back up, draw the image, then move back down
				// for Kitty (this component disables Kitty's terminal-side cursor movement)
				// so TUI cursor accounting stays inside the scroll area.
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push("");
				}
				const rowOffset = result.rows - 1;
				const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
				const moveDown = caps.images === "kitty" && rowOffset > 0 ? `\x1b[${rowOffset}B` : "";
				lines.push(moveUp + result.sequence + moveDown);
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [this.theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [this.theme.fallbackColor(fallback)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedFullscreenFallback = fullscreenFallback;

		return lines;
	}
}
