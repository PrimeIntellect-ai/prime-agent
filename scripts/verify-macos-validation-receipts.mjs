#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseBinary } from "./release-artifact-integrity.mjs";

export function verifyMacosValidationReceipts(artifactsDir, receiptsDir, channel) {
	if (!["production", "beta"].includes(channel)) throw new Error("Expected production or beta channel");
	for (const platform of ["darwin-arm64", "darwin-x64"]) {
		const release = readReleaseBinary(artifactsDir, platform);
		const receipt = JSON.parse(readFileSync(join(receiptsDir, `${channel}-${platform}.json`), "utf8"));
		if (receipt.schemaVersion !== 1) throw new Error("Unsupported validation receipt");
		for (const key of ["platform", "version", "file", "sha256", "executableSha256", "manifestFile", "manifestSha256", "inventorySha256"]) {
			if (receipt[key] !== release[key]) throw new Error(`macOS validation receipt mismatch: ${platform} ${key}`);
		}
		console.log(`Matched native validation receipt: ${channel} ${platform} ${release.sha256}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [artifactsDir, receiptsDir, channel, ...extra] = process.argv.slice(2);
	if (!artifactsDir || !receiptsDir || !channel || extra.length)
		throw new Error("Usage: node verify-macos-validation-receipts.mjs <artifacts-dir> <receipts-dir> <production|beta>");
	verifyMacosValidationReceipts(resolve(artifactsDir), resolve(receiptsDir), channel);
}
