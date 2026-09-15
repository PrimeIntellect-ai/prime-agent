import { writeFileSync } from "node:fs";
import { releasePlatforms } from "../../../scripts/release-platforms.mjs";

export const clipboardNativePackageByPlatform = {
	"darwin-arm64": "@mariozechner/clipboard-darwin-arm64",
	"darwin-x64": "@mariozechner/clipboard-darwin-x64",
	"linux-arm64": "@mariozechner/clipboard-linux-arm64-gnu",
	"linux-arm64-musl": "@mariozechner/clipboard-linux-arm64-musl",
	"linux-x64": "@mariozechner/clipboard-linux-x64-gnu",
	"linux-x64-baseline": "@mariozechner/clipboard-linux-x64-gnu",
	"linux-x64-musl": "@mariozechner/clipboard-linux-x64-musl",
	"linux-x64-musl-baseline": "@mariozechner/clipboard-linux-x64-musl",
};

export function writeClipboardBinaryBinding(path, platform) {
	if (!releasePlatforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);
	const packageName = clipboardNativePackageByPlatform[platform];
	if (!packageName) throw new Error(`Missing clipboard native package for binary platform: ${platform}`);
	writeFileSync(
		path,
		`export function loadBundledClipboard() {\n\treturn require(${JSON.stringify(packageName)});\n}\n`,
	);
}
