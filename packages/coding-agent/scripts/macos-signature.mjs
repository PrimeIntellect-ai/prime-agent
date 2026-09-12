#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requiresMacosSigning(platform) {
	if (platform === "linux-arm64" || platform === "linux-x64") return false;
	if (platform !== "darwin-arm64" && platform !== "darwin-x64") throw new Error(`Unsupported binary platform: ${platform}`);
	if (process.platform !== "darwin") throw new Error("Darwin binaries must be signed and verified on macOS");
	return true;
}

export function verifyMacosBinary(binary, platform) {
	if (!requiresMacosSigning(platform)) return;
	execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", resolve(binary)], { stdio: "inherit" });
}

export function signMacosBinary(binary, platform) {
	if (!requiresMacosSigning(platform)) return;
	// Bun 1.4.0 emits invalid page hashes. Apple must replace its signature, not preserve it.
	// Preserve Intel hardened runtime and Bun's JSC grants; do not add permissions on arm64.
	// These are Bun's compatibility grants, not a claim of minimum required permissions.
	// https://github.com/oven-sh/bun/blob/bun-v1.4.0/entitlements.plist
	// https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/guides/runtime/codesign-macos-executable.mdx
	execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags", resolve(binary)], { stdio: "inherit" });
	verifyMacosBinary(binary, platform);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [command, binary, platform, ...extra] = process.argv.slice(2);
	if (!binary || !platform || extra.length || !["sign", "verify"].includes(command))
		throw new Error("Usage: node macos-signature.mjs sign|verify <binary> <platform>");
	if (command === "sign") signMacosBinary(binary, platform);
	else verifyMacosBinary(binary, platform);
}
