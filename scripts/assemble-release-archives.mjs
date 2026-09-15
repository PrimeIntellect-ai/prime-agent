#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	binaryAssets,
	setBinaryVersion,
	validateBinaryAssets,
} from "../packages/coding-agent/scripts/copy-binary-assets.mjs";

const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

export function assembleBinaryArchives({ binaryDir, artifactsDir, version, requireAll = true }) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid binary version: ${version}`);
	const available = readdirSync(binaryDir);
	const targets = platforms.filter((platform) => available.includes(platform));
	if (targets.length === 0 || (requireAll && targets.length !== platforms.length)) {
		throw new Error("Missing compiled binaries; build all four platforms before packing a release");
	}
	mkdirSync(artifactsDir, { recursive: true });
	const archives = [];
	for (const platform of targets) {
		const source = join(binaryDir, platform);
		validateBinaryAssets(source);
		const binary = join(source, "prime-agent");
		if (!statSync(binary).isFile() || !(statSync(binary).mode & 0o111))
			throw new Error(`Missing executable: ${binary}`);
		const staging = mkdtempSync(join(tmpdir(), "prime-agent-archive-"));
		try {
			for (const name of ["prime-agent", ...binaryAssets])
				cpSync(join(source, name), join(staging, name), { recursive: true });
			setBinaryVersion(staging, version);
			chmodSync(join(staging, "prime-agent"), 0o755);
			const file = `prime-agent-${version}-${platform}.tar.gz`;
			const output = join(artifactsDir, file);
			execFileSync("tar", ["-czf", output, "-C", staging, "prime-agent", ...binaryAssets], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			});
			archives.push({
				platform,
				file,
				sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
				executableSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
			});
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	return archives;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [binaryDir, artifactsDir, version] = process.argv.slice(2);
	if (!binaryDir || !artifactsDir || !version)
		throw new Error("Usage: node scripts/assemble-release-archives.mjs <binary-dir> <out-dir> <version>");
	const archives = assembleBinaryArchives({
		binaryDir: resolve(binaryDir),
		artifactsDir: resolve(artifactsDir),
		version,
		requireAll: false,
	});
	writeFileSync(join(artifactsDir, "SHA256SUMS"), archives.map(({ sha256, file }) => `${sha256}  ${file}\n`).join(""));
	writeFileSync(
		join(artifactsDir, "binaries.json"),
		`${JSON.stringify({ version: `v${version}`, binaries: archives }, null, 2)}\n`,
	);
}
