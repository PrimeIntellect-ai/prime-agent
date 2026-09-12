import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readReleaseBinary(artifactsDir, platform) {
	const manifests = ["latest.json", "beta.json", "binaries.json"].filter((file) => existsSync(join(artifactsDir, file)));
	if (manifests.length !== 1) throw new Error("Expected exactly one release manifest");
	const manifestFile = manifests[0];
	const manifest = JSON.parse(readFileSync(join(artifactsDir, manifestFile), "utf8"));
	const entries = manifest.binaries?.filter((entry) => entry.platform === platform);
	if (entries?.length !== 1) throw new Error(`Expected one ${platform} binary in ${manifestFile}`);
	const entry = entries[0];
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("Invalid manifest version");
	if (entry.file !== `prime-agent-${manifest.version.slice(1)}-${platform}.tar.gz`)
		throw new Error("Unexpected archive filename");
	for (const field of ["sha256", "executableSha256"])
		if (!/^[a-f0-9]{64}$/.test(entry[field])) throw new Error(`Missing or invalid ${field}`);
	const inventory = readFileSync(join(artifactsDir, "SHA256SUMS"), "utf8").trim().split("\n");
	const checksums = new Map();
	for (const line of inventory) {
		const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
		if (!match || basename(match[2]) !== match[2] || checksums.has(match[2])) throw new Error("Invalid checksum inventory");
		checksums.set(match[2], match[1]);
	}
	if (checksums.get(entry.file) !== entry.sha256 || sha256File(join(artifactsDir, entry.file)) !== entry.sha256)
		throw new Error(`Archive checksum mismatch: ${entry.file}`);
	return {
		...entry,
		version: manifest.version,
		manifestFile,
		manifestSha256: sha256File(join(artifactsDir, manifestFile)),
		inventorySha256: sha256File(join(artifactsDir, "SHA256SUMS")),
	};
}
