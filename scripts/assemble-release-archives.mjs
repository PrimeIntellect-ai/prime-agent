#!/usr/bin/env bun
/**
 * Assembles Bun-compiled platform release archives with metadata.
 *
 * Usage:
 *   bun scripts/assemble-release-archives.mjs \
 *     --base-url <url> \
 *     --version x.y.z \
 *     --binary-dir <dir> \
 *     --sidecar-dir <dir> \
 *     [--channel stable|beta] \
 *     [--out-dir <dir>]
 *
 * Produces <out-dir>/artifacts/:
 *   prime-agent-<version>-<platform>.tar.gz   (one per platform)
 *   SHA256SUMS                                 (aggregate checksums)
 *   <channel>                                  (plain version pointer)
 *   latest.json|beta.json                      (manifest)
 *
 * Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64
 *
 * Archive layout (each .tar.gz):
 *   prime-agent          (compiled binary, executable)
 *   package.json
 *   README.md
 *   CHANGELOG.md
 *   prime-agent-runtime/ (Python runtime, recursive)
 *   skills/              (skill files)
 *   theme/               (UI theme JSON files)
 *   assets/              (UI assets)
 *   export-html/         (HTML export templates)
 *   docs/                (documentation)
 *   examples/            (example files)
 *   photon_rs_bg.wasm    (image-processing WASM)

 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const defaultOutDir = join(root, "packages", "coding-agent", "release");
const releaseChannels = new Set(["stable", "beta"]);
const publicPackageName = "prime-agent";
const binaryName = "prime-agent";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

const REQUIRED_SIDECARS = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"install.sh",
	"prime-agent-runtime",
	"skills",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
	"photon_rs_bg.wasm",
];

function parseArgs(args) {
	const parsed = {
		baseUrl: undefined,
		channel: "stable",
		binaryDir: undefined,
		sidecarDir: undefined,
		outDir: defaultOutDir,
		version: undefined,
		platforms: [],
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--channel": {
				const value = args[++i];
				if (!value || !releaseChannels.has(value)) throw new Error("--channel must be stable or beta");
				parsed.channel = value;
				break;
			}
			case "--base-url": {
				parsed.baseUrl = args[++i];
				if (!parsed.baseUrl) throw new Error("--base-url requires a value");
				break;
			}
			case "--version": {
				parsed.version = args[++i];
				if (!parsed.version) throw new Error("--version requires a value");
				break;
			}
			case "--binary-dir": {
				parsed.binaryDir = resolve(root, args[++i]);
				break;
			}
			case "--sidecar-dir": {
				parsed.sidecarDir = resolve(root, args[++i]);
				break;
			}
			case "--out-dir": {
				parsed.outDir = resolve(root, args[++i]);
				break;
			}
			case "--platform": {
				const platform = args[++i];
				if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
				parsed.platforms.push(platform);
				break;
			}
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!parsed.baseUrl) throw new Error("--base-url is required");
	if (!parsed.version) throw new Error("--version is required");
	if (!parsed.binaryDir) throw new Error("--binary-dir is required");
	if (!parsed.sidecarDir) throw new Error("--sidecar-dir is required");

	if (!existsSync(parsed.binaryDir)) throw new Error(`Binary dir not found: ${parsed.binaryDir}`);
	if (!existsSync(parsed.sidecarDir)) throw new Error(`Sidecar dir not found: ${parsed.sidecarDir}`);

	parsed.version = normalizeVersion(parsed.version);
	if (parsed.platforms.length === 0) parsed.platforms = [...PLATFORMS];
	parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl);
	return parsed;
}

function printHelp() {
	console.log(`Usage: bun scripts/assemble-release-archives.mjs --base-url <url> --binary-dir <dir> --sidecar-dir <dir> --version x.y.z [--channel stable|beta] [--platform <platform>] [--out-dir <dir>]

Assembles platform-specific release archives from a Bun-compiled binary and sidecar files.

Output:
  <out-dir>/artifacts/prime-agent-<version>-<platform>.tar.gz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)
`);
}

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) throw new Error(`Invalid release version: ${version}`);
	return normalized;
}

function normalizeBaseUrl(value) {
	value = value.trim();
	if (/[\u0000-\u001f\u007f"'`$\\]/.test(value)) {
		throw new Error("Release base URL contains unsafe shell characters");
	}
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid release base URL: ${value}`);
	}
	if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
		throw new Error(`Release base URL must use HTTPS without credentials: ${value}`);
	}
	if (parsed.search || parsed.hash || /[?#]$/.test(parsed.toString())) {
		throw new Error("Release base URL must not contain a query or fragment");
	}
	return parsed.toString().replace(/\/+$/, "");
}

function assertSafeOutputDir(outDir) {
	const base = resolve(defaultOutDir);
	const resolvedOutDir = resolve(outDir);
	const pathFromBase = relative(base, resolvedOutDir);
	if (pathFromBase !== "" && (pathFromBase.startsWith("..") || isAbsolute(pathFromBase))) {
		throw new Error(`Refusing to write output outside ${base}: ${outDir}`);
	}

	let current = base;
	for (const part of pathFromBase.split(/[\/\\]/).filter(Boolean)) {
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
			throw new Error(`Refusing to write through symlinked output path: ${current}`);
		}
		current = join(current, part);
	}
	if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
		throw new Error(`Refusing to write through symlinked output path: ${current}`);
	}
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function createArchive(sourceDir, archivePath) {
	const result = spawnSync("tar", ["-czf", archivePath, "-C", sourceDir, "."], {
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`);
}

function validateSidecars(sidecarDir) {
	const missing = [];
	for (const name of REQUIRED_SIDECARS) {
		if (!existsSync(join(sidecarDir, name))) {
			missing.push(name);
		}
	}
	return missing;
}

const FORBIDDEN_RELEASE_DIRECTORIES = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache"]);

function findForbiddenReleaseDirectory(root, relativePath = "") {
	for (const entry of readdirSync(join(root, relativePath), { withFileTypes: true })) {
		const child = join(relativePath, entry.name);
		if (FORBIDDEN_RELEASE_DIRECTORIES.has(entry.name)) return child;
		if (entry.isDirectory()) {
			const found = findForbiddenReleaseDirectory(root, child);
			if (found) return found;
		}
	}
	return undefined;
}

function renderPackageManifest(path, version) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.name = publicPackageName;
	manifest.version = version;
	manifest.bin = { [binaryName]: `./${binaryName}` };
	manifest.packageManager = "bun@1.4.0";
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function renderInstaller(path, baseUrl, channel) {
	const rendered = readFileSync(path, "utf8")
		.replaceAll("__PRIME_AGENT_DOWNLOAD_BASE_URL__", baseUrl)
		.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", channel);
	if (rendered.includes("__PRIME_AGENT_DOWNLOAD_BASE_URL__") || rendered.includes("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__")) {
		throw new Error("Release installer still contains an unresolved configuration marker");
	}
	writeFileSync(path, rendered);
	chmodSync(path, 0o755);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const outDir = resolve(args.outDir);
	assertSafeOutputDir(outDir);

	const missing = validateSidecars(args.sidecarDir);
	if (missing.length > 0) {
		throw new Error(
			`Missing required sidecars in ${args.sidecarDir}: ${missing.join(", ")}. ` +
			`Run "bun run copy-binary-assets" first.`,
		);
	}
	const forbiddenDirectory = findForbiddenReleaseDirectory(args.sidecarDir);
	if (forbiddenDirectory) {
		throw new Error(`Release sidecars contain a forbidden dependency or cache directory: ${forbiddenDirectory}`);
	}

	const binarySources = new Map();
	for (const platform of args.platforms) {
		const binarySource = join(args.binaryDir, platform, "pi");
		if (!existsSync(binarySource)) {
			throw new Error(`Binary not found for platform ${platform}: ${binarySource}`);
		}
		binarySources.set(platform, binarySource);
	}

	rmSync(outDir, { force: true, recursive: true });
	const versionDir = join(outDir, "artifacts");
	mkdirSync(versionDir, { recursive: true });
	const archives = [];

	for (const platform of args.platforms) {
		const binarySource = binarySources.get(platform);
		const stagingDir = join(outDir, "staging", platform);
		mkdirSync(stagingDir, { recursive: true });

		// Copy binary to archive root as "prime-agent"
		const dstBinary = join(stagingDir, binaryName);
		cpSync(binarySource, dstBinary);
		chmodSync(dstBinary, 0o755);

		// Copy all sidecars to archive root
		for (const name of REQUIRED_SIDECARS) {
			const src = join(args.sidecarDir, name);
			cpSync(src, join(stagingDir, name), { recursive: true, dereference: true });
		}
		renderPackageManifest(join(stagingDir, "package.json"), args.version);
		renderInstaller(join(stagingDir, "install.sh"), args.baseUrl, args.channel);

		const archiveName = `prime-agent-${args.version}-${platform}.tar.gz`;
		const archivePath = join(versionDir, archiveName);
		createArchive(stagingDir, archivePath);

		const sha256 = sha256File(archivePath);
		archives.push({ platform, file: archiveName, sha256 });
		console.log(`Created ${archivePath}`);

		rmSync(join(outDir, "staging"), { force: true, recursive: true });
	}

	if (archives.length === 0) throw new Error("No platform archives created");

	archives.sort((a, b) => a.file.localeCompare(b.file));
	const sumsContent = archives.map((a) => `${a.sha256}  ${a.file}`).join("\n") + "\n";
	writeFileSync(join(versionDir, "SHA256SUMS"), sumsContent);
	writeFileSync(join(versionDir, args.channel), `v${args.version}\n`);

	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeFileSync(
		join(versionDir, manifestName),
		JSON.stringify(
			{
				version: `v${args.version}`,
				package: publicPackageName,
				platforms: archives.map((a) => ({
					platform: a.platform,
					file: a.file,
					sha256: a.sha256,
				})),
				baseUrl: `${args.baseUrl}/releases/v${args.version}`,
			},
			null,
			2,
		) + "\n",
	);

	console.log(`\nSHA256SUMS -> ${join(versionDir, "SHA256SUMS")}`);
	console.log(`${manifestName} -> ${join(versionDir, manifestName)}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
