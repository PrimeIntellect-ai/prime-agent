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
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const defaultOutDir = join(root, "packages", "coding-agent", "release");
const releaseChannels = new Set(["stable", "beta"]);
const archivePackageName = "prime-agent";
const legacyRegistryPackageName = "@earendil-works/pi-coding-agent";
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
const REQUIRED_SIDECAR_FILES = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"install.sh",
	"photon_rs_bg.wasm",
	"prime-agent-runtime/pyproject.toml",
	"theme/prime.json",
	"theme/dark.json",
	"theme/light.json",
	"theme/theme-schema.json",
	"export-html/template.html",
	"export-html/template.css",
	"export-html/template.js",
];
const REQUIRED_SIDECAR_DIRECTORIES = ["skills", "assets", "docs", "examples", "export-html/vendor"];

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

const MANIFEST_VERSION = 1;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_DECOMPRESSED_TAR_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MEMBERS = 1024;
const MAX_REGULAR_FILES = 512;
const MAX_DIRECTORIES = 512;
const MAX_PER_FILE_BYTES = 192 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 224 * 1024 * 1024;
const MAX_PATH_UTF8_BYTES = 512;
const MAX_COMPONENT_UTF8_BYTES = 255;

function sha256FileBounded(path) {
	const fd = openSync(path, "r");
	try {
		const hash = createHash("sha256");
		const buf = Buffer.alloc(1048576);
		let bytesRead;
		while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
			if (bytesRead < buf.length) {
				hash.update(buf.subarray(0, bytesRead));
			} else {
				hash.update(buf);
			}
		}
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

function sha256Bytes(data) {
	return createHash("sha256").update(data).digest("hex");
}

function buildEntryManifest(stagingDir, version, platform, archiveName) {
	const entries = [];
	const seenPaths = new Set();
	let totalFiles = 0;
	let totalDirectories = 0;
	let totalSize = 0;
	const rootStat = lstatSync(stagingDir);
	if (!rootStat.isDirectory()) throw new Error(`Staging root is not a directory: ${stagingDir}`);

	// Root directory entry
	entries.push({
		path: ".",
		type: "directory",
		mode: "0755",
		size: 0,
	});
	seenPaths.add(".");
	totalDirectories++;
	chmodSync(stagingDir, 0o755);

	function walk(currentDir, relativePath) {
		const dirEntries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => bytewiseCompare(a.name, b.name));
		for (const entry of dirEntries) {
			const childPath = join(currentDir, entry.name);
			const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;

			if (seenPaths.has(childRelative)) throw new Error(`Path collision: ${childRelative}`);
			// Reject links and special files (lstat to detect symlinks)
			const rawStat = lstatSync(childPath);
			if (rawStat.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${childRelative}`);
			if (!rawStat.isFile() && !rawStat.isDirectory()) throw new Error(`Refusing to package special file: ${childRelative}`);

			if (rawStat.isDirectory()) {
				chmodSync(childPath, 0o755);
				entries.push({
					path: childRelative,
					type: "directory",
					mode: "0755",
					size: 0,
				});
				seenPaths.add(childRelative);
				totalDirectories++;
				walk(childPath, childRelative);
			} else {
				const isExecutable = (rawStat.mode & 0o111) !== 0;
				const normalizedMode = isExecutable ? "0755" : "0644";
				const modeNum = isExecutable ? 0o755 : 0o644;
				chmodSync(childPath, modeNum);
				const preStat = lstatSync(childPath);
				const sha256 = sha256FileBounded(childPath);
				const postStat = lstatSync(childPath);
				if (
					!preStat.isFile() ||
					!postStat.isFile() ||
					preStat.nlink !== 1 ||
					postStat.nlink !== 1 ||
					(preStat.mode & 0o7777) !== modeNum ||
					(postStat.mode & 0o7777) !== modeNum ||
					preStat.dev !== postStat.dev ||
					preStat.ino !== postStat.ino ||
					preStat.size !== postStat.size ||
					preStat.mtimeMs !== postStat.mtimeMs
				) {
					throw new Error(`File changed during hashing: ${childRelative}`);
				}
				const fileStat = postStat;

				entries.push({
					path: childRelative,
					type: "file",
					mode: normalizedMode,
					size: fileStat.size,
					sha256,
				});
				seenPaths.add(childRelative);
				totalFiles++;
				totalSize += fileStat.size;
			}
		}
	}

	walk(stagingDir, "");
	entries.sort((a, b) => bytewiseCompare(a.path, b.path));

	return {
		manifestVersion: MANIFEST_VERSION,
		version,
		platform,
		archive: archiveName,
		totalFiles,
		totalDirectories,
		totalSize,
		entries,
	};
}

function bytewiseCompare(a, b) {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function validateManifestPath(path) {
	if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\")) {
		throw new Error("Invalid release manifest path");
	}
	const encoded = Buffer.from(path, "utf8");
	if (encoded.toString("utf8") !== path || encoded.byteLength > MAX_PATH_UTF8_BYTES) {
		throw new Error("Invalid release manifest path");
	}
	if (path === ".") return;
	for (const component of path.split("/")) {
		if (
			component.length === 0 ||
			component === "." ||
			component === ".." ||
			Buffer.byteLength(component, "utf8") > MAX_COMPONENT_UTF8_BYTES ||
			/[\u0000-\u001f\u007f]/.test(component)
		) {
			throw new Error("Invalid release manifest path");
		}
	}
}

function verifyEntryManifest(manifest) {
	const { totalFiles, totalDirectories, totalSize, entries } = manifest;
	if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_MEMBERS) {
		throw new Error("Invalid release manifest member count");
	}
	if (entries[0]?.path !== "." || entries[0]?.type !== "directory") {
		throw new Error("Release manifest root must be first");
	}
	const seen = new Set();
	const directories = new Set();
	let countedFiles = 0;
	let countedDirectories = 0;
	let countedSize = 0;
	let previousPath;
	for (const entry of entries) {
		validateManifestPath(entry.path);
		if (seen.has(entry.path)) throw new Error("Duplicate release manifest path");
		if (previousPath !== undefined && bytewiseCompare(previousPath, entry.path) >= 0) {
			throw new Error("Release manifest paths are not in bytewise order");
		}
		previousPath = entry.path;
		seen.add(entry.path);
		if (entry.path !== ".") {
			const slash = entry.path.lastIndexOf("/");
			const parent = slash < 0 ? "." : entry.path.slice(0, slash);
			if (!directories.has(parent)) throw new Error("Release manifest parent is missing or out of order");
		}
		if (entry.type === "file") {
			countedFiles++;
			if (
				(entry.mode !== "0644" && entry.mode !== "0755") ||
				!Number.isSafeInteger(entry.size) ||
				entry.size < 0 ||
				entry.size > MAX_PER_FILE_BYTES ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.sha256)
			) {
				throw new Error("Invalid release manifest file entry");
			}
			countedSize += entry.size;
		} else if (entry.type === "directory") {
			countedDirectories++;
			if (entry.mode !== "0755" || entry.sha256 !== undefined || entry.size !== 0) {
				throw new Error("Invalid release manifest directory entry");
			}
			directories.add(entry.path);
		} else {
			throw new Error("Invalid release manifest entry type");
		}
	}
	if (
		countedFiles !== totalFiles ||
		countedDirectories !== totalDirectories ||
		countedSize !== totalSize ||
		countedFiles > MAX_REGULAR_FILES ||
		countedDirectories > MAX_DIRECTORIES ||
		countedSize > MAX_TOTAL_FILE_BYTES
	) {
		throw new Error("Release manifest totals are invalid");
	}
	return manifest;
}

function createArchive(sourceDir, archivePath) {
	const result = spawnSync("tar", ["--format=ustar", "-czf", archivePath, "-C", sourceDir, "."], {
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`);
}


function validateSidecars(sidecarDir) {
	const missingFiles = REQUIRED_SIDECAR_FILES.filter((name) => {
		const path = join(sidecarDir, name);
		return !existsSync(path) || !lstatSync(path).isFile();
	});
	const missingDirectories = REQUIRED_SIDECAR_DIRECTORIES.filter((name) => {
		const path = join(sidecarDir, name);
		return !existsSync(path) || !lstatSync(path).isDirectory();
	});
	return [...missingFiles, ...missingDirectories];
}


function validateStagingDir(root, relativePath) {
	const dirEntries = readdirSync(join(root, relativePath), { withFileTypes: true });
	for (const entry of dirEntries) {
		const child = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
		const fullPath = join(root, child);
		const stat = lstatSync(fullPath);
		if (stat.isSymbolicLink()) {
			return { kind: "symlink", path: child };
		}
		if (!stat.isFile() && !stat.isDirectory()) {
			return { kind: "special", path: child };
		}
		if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === "__pycache__" || entry.name === ".pytest_cache") {
			return { kind: "forbidden", path: child };
		}
		if (stat.isDirectory()) {
			const found = validateStagingDir(root, child);
			if (found) return found;
		}
	}
	return undefined;
}

function renderPackageManifest(path, version) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.name = archivePackageName;
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

function readGzipUncompressedSize(path) {
	const archiveStat = statSync(path);
	if (archiveStat.size < 18) throw new Error("Archive is too small for gzip");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(4);
		let completed = 0;
		while (completed < buffer.byteLength) {
			const count = readSync(
				fd,
				buffer,
				completed,
				buffer.byteLength - completed,
				archiveStat.size - buffer.byteLength + completed,
			);
			if (count <= 0) throw new Error("Short read while reading gzip ISIZE");
			completed += count;
		}
		const isize = buffer.readUInt32LE(0);
		if (isize === 0 || isize > MAX_DECOMPRESSED_TAR_BYTES || isize % 512 !== 0) {
			throw new Error("Gzip ISIZE is outside release safety bounds");
		}
		return isize;
	} finally {
		closeSync(fd);
	}
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
	const preflight = validateStagingDir(args.sidecarDir, "");
	if (preflight) {
		if (preflight.kind === "symlink") {
			throw new Error(`Release sidecars contain a symlink: ${preflight.path}`);
		}
		if (preflight.kind === "special") {
			throw new Error(`Release sidecars contain a special file: ${preflight.path}`);
		}
		throw new Error(`Release sidecars contain a forbidden dependency or cache directory: ${preflight.path}`);
	}

	const binarySources = new Map();
	for (const platform of args.platforms) {
		const binarySource = join(args.binaryDir, platform, "pi");
		if (!existsSync(binarySource)) {
			throw new Error(`Binary not found for platform ${platform}: ${binarySource}`);
		}
		// Reject symlinks in binary source path; require regular file
		const binStat = lstatSync(binarySource);
		if (binStat.isSymbolicLink()) {
			throw new Error(`Binary for ${platform} is a symlink: ${binarySource}`);
		}
		if (!binStat.isFile()) {
			throw new Error(`Binary for ${platform} is not a regular file: ${binarySource}`);
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
		const manifestName = `prime-agent-${args.version}-${platform}.manifest.json`;

		const rawManifest = buildEntryManifest(stagingDir, args.version, platform, archiveName);
		const verifiedManifest = verifyEntryManifest(rawManifest);
		const archivePath = join(versionDir, archiveName);
		createArchive(stagingDir, archivePath);

		const archiveByteSize = statSync(archivePath).size;
		if (archiveByteSize <= 0 || archiveByteSize > MAX_ARCHIVE_BYTES) {
			throw new Error("Archive is outside release safety bounds");
		}
		const archiveSha256 = sha256FileBounded(archivePath);
		const decompressedTarBytes = readGzipUncompressedSize(archivePath);
		verifiedManifest.decompressedTarBytes = decompressedTarBytes;
		const finalManifestContent = `${JSON.stringify(verifiedManifest, null, 2)}\n`;
		const manifestByteSize = Buffer.byteLength(finalManifestContent, "utf8");
		if (manifestByteSize <= 0 || manifestByteSize > MAX_MANIFEST_BYTES) {
			throw new Error("Entry manifest is outside release safety bounds");
		}
		const manifestPath = join(versionDir, manifestName);
		writeFileSync(manifestPath, finalManifestContent);
		const finalManifestSha256 = sha256Bytes(finalManifestContent);
		archives.push({
			platform,
			file: archiveName,
			sha256: archiveSha256,
			byteSize: archiveByteSize,
			decompressedTarBytes,
			manifestFile: manifestName,
			manifestSha256: finalManifestSha256,
			manifestByteSize,
		});
		console.log(`Created ${archivePath}`);
		console.log(`Created ${manifestPath} (${verifiedManifest.totalFiles} files, ${verifiedManifest.totalDirectories} dirs, ${verifiedManifest.totalSize} bytes, ${decompressedTarBytes} decompressed)`);

		rmSync(join(outDir, "staging"), { force: true, recursive: true });
	}

	if (archives.length === 0) throw new Error("No platform archives created");

	archives.sort((a, b) => { if (a.file < b.file) return -1; if (a.file > b.file) return 1; return 0; });
	const sumsEntries = [];
	for (const a of archives) {
		sumsEntries.push({ sha256: a.sha256, file: a.file });
		sumsEntries.push({ sha256: a.manifestSha256, file: a.manifestFile });
	}
	sumsEntries.sort((a, b) => { if (a.file < b.file) return -1; if (a.file > b.file) return 1; return 0; });
	const sumsContent = sumsEntries.map((e) => `${e.sha256}  ${e.file}`).join("\n") + "\n";
	writeFileSync(join(versionDir, "SHA256SUMS"), sumsContent);
	writeFileSync(join(versionDir, args.channel), `v${args.version}\n`);

	const channelManifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeFileSync(
		join(versionDir, channelManifestName),
		JSON.stringify(
			{
				version: `v${args.version}`,
				package: legacyRegistryPackageName,
				platforms: archives.map((a) => ({
					platform: a.platform,
					file: a.file,
					sha256: a.sha256,
					byteSize: a.byteSize,
					decompressedTarBytes: a.decompressedTarBytes,
					manifestFile: a.manifestFile,
					manifestSha256: a.manifestSha256,
					manifestByteSize: a.manifestByteSize,
				})),
				baseUrl: `${args.baseUrl}/releases/v${args.version}`,
			},
			null,
			2,
		) + "\n",
	);

	console.log(`\nSHA256SUMS -> ${join(versionDir, "SHA256SUMS")}`);
	console.log(`${channelManifestName} -> ${join(versionDir, channelManifestName)}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
