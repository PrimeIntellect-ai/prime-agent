// Recompute the pinned SHA-256 table for a helper tool release.
//
// Usage (from packages/coding-agent): npx tsx scripts/pin-helper-tools.ts <fd|rg|uv> <version>
//
// Downloads every supported asset of that release from GitHub, prints its SHA-256, and
// cross-checks the upstream `<asset>.sha256` file when the project publishes one. Paste
// the printed table into src/utils/helper-tool-releases.ts together with the new version.
import { createHash } from "node:crypto";
import { HELPER_TOOL_RELEASES, type HelperToolId } from "../src/utils/helper-tool-releases.js";

const SUPPORTED_TARGETS: Array<[platform: string, architecture: string]> = [
	["darwin", "arm64"],
	["darwin", "x64"],
	["linux", "arm64"],
	["linux", "x64"],
	["win32", "arm64"],
	["win32", "x64"],
];

async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
	const [tool, version] = process.argv.slice(2);
	if (!tool || !version || !(tool in HELPER_TOOL_RELEASES)) {
		console.error("usage: npx tsx scripts/pin-helper-tools.ts <fd|rg|uv> <version>");
		process.exit(2);
	}
	const current = HELPER_TOOL_RELEASES[tool as HelperToolId];
	const tag = current.tag.startsWith("v") ? `v${version}` : version;
	const lines: string[] = [];
	let failed = false;
	for (const [platform, architecture] of SUPPORTED_TARGETS) {
		const assetName = current.assetName(platform, architecture)?.replaceAll(current.version, version);
		if (!assetName) continue;
		const url = `https://github.com/${current.repo}/releases/download/${tag}/${assetName}`;
		const digest = createHash("sha256").update(await fetchBytes(url)).digest("hex");
		let note = "no upstream checksum published";
		try {
			const published = new TextDecoder().decode(await fetchBytes(`${url}.sha256`));
			const match = published.match(/[0-9a-f]{64}/i)?.[0].toLowerCase();
			note = match === digest ? "matches upstream .sha256" : `MISMATCH with upstream .sha256 (${match ?? "unparseable"})`;
			if (match !== digest) failed = true;
		} catch {
			// Only ripgrep and uv publish per-asset checksum files.
		}
		lines.push(`\t\t\t"${assetName}": "${digest}", // ${note}`);
	}
	console.log(`// ${current.repo} ${tag}\n${lines.join("\n")}`);
	if (failed) {
		console.error("Upstream checksum mismatch detected; do not pin this release.");
		process.exit(1);
	}
}

await main();
