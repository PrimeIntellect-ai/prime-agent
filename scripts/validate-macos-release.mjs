#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateBinaryAssets } from "../packages/coding-agent/scripts/copy-binary-assets.mjs";
import { verifyMacosBinary } from "../packages/coding-agent/scripts/macos-signature.mjs";
import { readReleaseBinary, sha256File } from "./release-artifact-integrity.mjs";

export function validateMacosRelease(artifactsDir, platform, referenceManifest, evidencePath) {
	rmSync(evidencePath, { force: true });
	if (process.platform !== "darwin" || platform !== `darwin-${process.arch}`)
		throw new Error(`Final ${platform} validation requires a matching native macOS runner`);
	const release = readReleaseBinary(artifactsDir, platform);
	const references = JSON.parse(readFileSync(referenceManifest, "utf8")).binaries?.filter((entry) => entry.platform === platform);
	if (references?.length !== 1 || references[0].executableSha256 !== release.executableSha256)
		throw new Error("Final executable identity differs from the tested standalone build");
	const temporary = mkdtempSync(join(tmpdir(), "prime-agent-signature-"));
	try {
		const extracted = join(temporary, "extracted app");
		const home = join(temporary, "home");
		mkdirSync(extracted);
		mkdirSync(home);
		execFileSync("tar", ["-xzf", join(artifactsDir, release.file), "-C", extracted], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		validateBinaryAssets(extracted);
		const binary = join(extracted, "prime-agent");
		if (sha256File(binary) !== release.executableSha256) throw new Error("Extracted executable checksum mismatch");
		verifyMacosBinary(binary, platform);
		const display = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", binary], { encoding: "utf8" });
		if (display.status !== 0) throw new Error(`Cannot inspect signature: ${display.stderr}`);
		const signature = display.stderr;
		console.log(signature);
		const options = {
			cwd: home,
			env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: temporary, DO_NOT_TRACK: "1", PRIME_AGENT_CODING_AGENT_DIR: join(home, "agent") },
			encoding: "utf8",
			timeout: 30000,
		};
		if (execFileSync(binary, ["--version"], options).trim() !== release.version.slice(1)) throw new Error("Final archive version mismatch");
		if (!execFileSync(binary, ["--help"], options).includes("Python REPL")) throw new Error("Final archive help failed");
		mkdirSync(dirname(evidencePath), { recursive: true });
		const receipt = { schemaVersion: 1, ...release, referenceManifestSha256: sha256File(referenceManifest), signature, macosVersion: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() };
		writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
		console.log(`Verified final ${platform} ${release.version}: ${release.sha256}`);
		return receipt;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [artifactsDir, platform, referenceManifest, evidencePath, ...extra] = process.argv.slice(2);
	if (!artifactsDir || !platform || !referenceManifest || !evidencePath || extra.length)
		throw new Error("Usage: node validate-macos-release.mjs <artifacts-dir> <platform> <reference-binaries.json> <receipt-path>");
	validateMacosRelease(resolve(artifactsDir), platform, resolve(referenceManifest), resolve(evidencePath));
}
