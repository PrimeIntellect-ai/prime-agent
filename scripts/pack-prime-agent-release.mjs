#!/usr/bin/env bun
/**
 * Produce Bun-compiled platform release archives.
 *
 * This script is the CI entry point for the release artifact lane. It expects
 * pre-built Bun-compiled binaries for 4 platforms (darwin-arm64, darwin-x64,
 * linux-arm64, linux-x64) and sidecar files, then produces platform-specific
 * .tar.gz archives with checksums and channel metadata.
 *
 * No npm or Node.js is used during artifact assembly.
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
 *     SHA256SUMS
 *     <channel>
 *     latest.json|beta.json
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const defaultBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const releaseChannels = new Set(["stable", "beta"]);

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
	parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");

	// Resolve version from coding-agent package.json if not provided.
	if (!parsed.version) {
		const cliPkg = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
		parsed.version = cliPkg.version;
	}

	return parsed;
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
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
