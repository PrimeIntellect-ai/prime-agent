import * as os from "node:os";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../../utils/shell.js";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export interface TextOutputOptions {
	/** Whether image fallbacks should parse image dimensions from base64 data. */
	includeImageDimensions?: boolean;
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
	options: TextOutputOptions = {},
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const includeImageDimensions = options.includeImageDimensions ?? true;
	if (imageBlocks.length > 0 && !showImages) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					includeImageDimensions && img.data && img.mimeType
						? (getImageDimensions(img.data, img.mimeType) ?? undefined)
						: undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}
