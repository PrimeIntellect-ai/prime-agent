#!/usr/bin/env bun
/**
 * Produce Bun-compiled platform archives and npm-compatible tarballs.
 *
 * This script is the CI entry point for the release artifact lane. It expects
 * pre-built Bun-compiled binaries for 4 platforms (darwin-arm64, darwin-x64,
 * linux-arm64, linux-x64) and sidecar files, then produces platform-specific
 * .tar.gz archives with checksums and channel metadata.
 *
 * Bun creates both native archives and npm-compatible package tarballs.
 *
 * Usage:
 *   bun scripts/pack-prime-agent-release.mjs \
 *     --base-url <url> \
 *     [--channel stable|beta] \
 *     [--version x.y.z] \
 *     [--out-dir <path>] \
 *     [--binary-base-dir <path>] \
 *     [--sidecar-dir <path>]
 *
 * Output:
 *   <out-dir>/artifacts/
 *     prime-agent-<version>-<platform>.tar.gz
 *     prime-agent-<version>.tgz (plus internal workspace tarballs)
 *     SHA256SUMS
 *     <channel>
 *     latest.json|beta.json
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const defaultBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const releaseChannels = new Set(["stable", "beta"]);
const publicPackageName = "prime-agent";
const publicCommandName = "prime-agent";
const releasePackages = [
	{ packageDir: "ai", publicName: "prime-agent-ai" },
	{ packageDir: "tui", publicName: "prime-agent-tui" },
	{ packageDir: "agent", publicName: "prime-agent-core" },
	{ packageDir: "coding-agent", publicName: publicPackageName },
];

function parseArgs(args) {
	const parsed = {
		baseUrl: defaultBaseUrl,
		channel: "stable",
		binaryBaseDir: join(root, "packages", "coding-agent", "binaries"),
		sidecarDir: join(root, "packages", "coding-agent", "dist"),
		outDir: defaultOutputDir,
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
				const value = args[++i];
				if (!value) throw new Error("--base-url requires a value");
				parsed.baseUrl = value;
				break;
			}
			case "--version": {
				const value = args[++i];
				if (!value) throw new Error("--version requires a value");
				parsed.version = value;
				break;
			}
			case "--out-dir": {
				const value = args[++i];
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				break;
			}
			case "--binary-base-dir": {
				const value = args[++i];
				if (!value) throw new Error("--binary-base-dir requires a value");
				parsed.binaryBaseDir = resolve(root, value);
				break;
			}
			case "--sidecar-dir": {
				const value = args[++i];
				if (!value) throw new Error("--sidecar-dir requires a value");
				parsed.sidecarDir = resolve(root, value);
				break;
			}
			case "--platform": {
				const value = args[++i];
				if (!value) throw new Error("--platform requires a value");
				parsed.platforms.push(value);
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

	if (!parsed.baseUrl) throw new Error("--base-url or PRIME_AGENT_DOWNLOAD_BASE_URL is required");
	parsed.baseUrl = parsed.baseUrl.trim().replace(/\/+$/, "");

	// Resolve and normalize the version once for archive names and embedded URLs.
	if (!parsed.version) {
		const cliPkg = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
		parsed.version = cliPkg.version;
	}
	parsed.version = normalizeVersion(parsed.version);

	return parsed;
}

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) throw new Error(`Invalid release version: ${version}`);
	return normalized;
}

function printHelp() {
	console.log(`Usage: bun scripts/pack-prime-agent-release.mjs --base-url url [--channel stable|beta] [--version x.y.z] [--out-dir path] [--binary-base-dir path] [--sidecar-dir path] [--platform platform]

Creates platform release archives:

  <out-dir>/artifacts/prime-agent-<version>-<platform>.tar.gz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)

--binary-base-dir defaults to packages/coding-agent/binaries/
--sidecar-dir defaults to packages/coding-agent/dist/
`);
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function rewriteInternalDependencies(dependencies, internalPackageUrls) {
	if (!dependencies) return undefined;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, range]) => [name, internalPackageUrls.get(name) || range]),
	);
}

function createReleasePackageJson(sourcePackage, packageName, version, internalPackageUrls) {
	const manifest = {
		...sourcePackage,
		name: packageName,
		version,
		dependencies: rewriteInternalDependencies(sourcePackage.dependencies, internalPackageUrls),
		optionalDependencies: rewriteInternalDependencies(sourcePackage.optionalDependencies, internalPackageUrls),
		scripts: sourcePackage.scripts?.postinstall ? { postinstall: "node postinstall.cjs" } : undefined,
	};
	delete manifest.devDependencies;
	delete manifest.overrides;
	delete manifest.private;
	if (packageName === publicPackageName) {
		manifest.bin = { [publicCommandName]: "dist/bundle/cli.js" };
		manifest.piConfig = { ...(manifest.piConfig || {}), name: publicCommandName, configDir: ".prime/agent" };
	}
	return manifest;
}

function copyPackageContents(sourceDir, targetDir, packageJson) {
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(join(targetDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	for (const entry of ["dist", "docs", "examples", "skills", "postinstall.cjs", "README.md", "CHANGELOG.md"]) {
		const source = join(sourceDir, entry);
		if (existsSync(source)) cpSync(source, join(targetDir, entry), { recursive: true });
	}
}

function packNpmCompatibilityTarballs(args) {
	const artifactsDir = join(args.outDir, "artifacts");
	const stagingRoot = join(args.outDir, "npm-packages");
	const packageSources = new Map();
	for (const releasePackage of releasePackages) {
		const sourceDir = join(root, "packages", releasePackage.packageDir);
		if (!existsSync(join(sourceDir, "dist"))) {
			throw new Error(`Missing built package: ${sourceDir}/dist`);
		}
		packageSources.set(releasePackage.packageDir, JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")));
	}

	const artifactFiles = new Map(
		releasePackages.map(({ packageDir, publicName }) => [packageDir, `${publicName}-${args.version}.tgz`]),
	);
	const internalPackageUrls = new Map();
	for (const { packageDir, publicName } of releasePackages) {
		if (packageDir === "coding-agent") continue;
		const sourceName = packageSources.get(packageDir).name;
		internalPackageUrls.set(sourceName, `${args.baseUrl}/releases/v${args.version}/${artifactFiles.get(packageDir)}`);
	}

	const tarballs = [];
	try {
		rmSync(stagingRoot, { recursive: true, force: true });
		for (const { packageDir, publicName } of releasePackages) {
			const stagingDir = join(stagingRoot, packageDir);
			copyPackageContents(
				join(root, "packages", packageDir),
				stagingDir,
				createReleasePackageJson(packageSources.get(packageDir), publicName, args.version, internalPackageUrls),
			);
			const result = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", artifactsDir], {
				cwd: stagingDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0) {
				throw new Error(`bun pm pack failed for ${packageDir}: ${result.stderr.toString()}`);
			}
			const file = artifactFiles.get(packageDir);
			const path = join(artifactsDir, file);
			if (!existsSync(path)) throw new Error(`bun pm pack did not create ${path}`);
			tarballs.push({ package: publicName, file, sha256: sha256File(path) });
		}
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}

	const checksumPath = join(artifactsDir, "SHA256SUMS");
	const checksums = readFileSync(checksumPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean);
	checksums.push(...tarballs.map(({ file, sha256 }) => `${sha256}  ${file}`));
	checksums.sort((left, right) => left.split(/\s+/).at(-1).localeCompare(right.split(/\s+/).at(-1)));
	writeFileSync(checksumPath, `${checksums.join("\n")}\n`);

	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	const manifestPath = join(artifactsDir, manifestName);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.tarball = `releases/v${args.version}/${artifactFiles.get("coding-agent")}`;
	manifest.tarballs = tarballs;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (!existsSync(args.sidecarDir)) {
		throw new Error(
			`Sidecar dir not found: ${args.sidecarDir}. Run "bun run build && bun run copy-binary-assets" first.`,
		);
	}

	// The assembly script is in the same scripts directory.
	const assemblyScript = join(import.meta.dirname, "assemble-release-archives.mjs");
	if (!existsSync(assemblyScript)) {
		throw new Error(`Assembly script not found: ${assemblyScript}`);
	}

	const { spawnSync } = await import("node:child_process");
	const assemblyArgs = [
		assemblyScript,
		"--base-url", args.baseUrl,
		"--channel", args.channel,
		"--version", args.version,
		"--binary-dir", args.binaryBaseDir,
		"--sidecar-dir", args.sidecarDir,
		"--out-dir", args.outDir,
	];
	for (const platform of args.platforms) assemblyArgs.push("--platform", platform);
	const result = spawnSync(process.execPath, assemblyArgs, { stdio: "inherit", encoding: "utf8" });

	if (result.status !== 0) {
		throw new Error(`assemble-release-archives.mjs failed with exit code ${result.status}`);
	}
	packNpmCompatibilityTarballs(args);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
