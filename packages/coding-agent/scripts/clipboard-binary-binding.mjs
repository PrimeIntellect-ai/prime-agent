import { writeFileSync } from "node:fs";
import { releasePlatforms } from "../../../scripts/release-platforms.mjs";

export const clipboardNativePackageByPlatform = {
	"darwin-arm64": "@mariozechner/clipboard-darwin-arm64",
	"darwin-x64": "@mariozechner/clipboard-darwin-x64",
	"linux-arm64": "@mariozechner/clipboard-linux-arm64-gnu",
	// The published musl packages contain no native addon, so these builds retain the system-command fallback.
	"linux-arm64-musl": null,
	"linux-x64": "@mariozechner/clipboard-linux-x64-gnu",
	"linux-x64-baseline": "@mariozechner/clipboard-linux-x64-gnu",
	"linux-x64-musl": null,
	"linux-x64-musl-baseline": null,
};

export function writeClipboardBinaryBinding(path, platform) {
	if (!releasePlatforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);
	const packageName = clipboardNativePackageByPlatform[platform];
	if (packageName === undefined) throw new Error(`Missing clipboard native package mapping: ${platform}`);
	const binding = packageName ? `require(${JSON.stringify(packageName)})` : "null";
	writeFileSync(path, `export function loadBundledClipboard() {\n\treturn ${binding};\n}\n`);
}
