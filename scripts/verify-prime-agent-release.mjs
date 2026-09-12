#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { publicPackageName, releaseComponents } from "./prime-agent-release-components.mjs";

const releaseChannels = new Set(["stable", "beta"]);
const commitPattern = /^[0-9a-f]{40}$/;

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) throw new Error(`Invalid release version: ${version}`);
	return normalized;
}

function parseArgs(args) {
	const parsed = { artifactDir: undefined, channel: undefined, commit: undefined, dryRun: false, version: undefined };
	for (let i = 0; i < args.length; i += 1) {
		switch (args[i]) {
			case "--artifact-dir": parsed.artifactDir = resolve(args[++i] || ""); break;
			case "--channel": parsed.channel = args[++i]; break;
			case "--commit": parsed.commit = args[++i]; break;
			case "--version": parsed.version = normalizeVersion(args[++i] || ""); break;
			case "--dry-run": parsed.dryRun = true; break;
			default: throw new Error(`Unknown argument: ${args[i]}`);
		}
	}
	if (!parsed.artifactDir || !parsed.channel || !parsed.commit || !parsed.version) throw new Error("--artifact-dir, --channel, --commit, and --version are required");
	if (!releaseChannels.has(parsed.channel)) throw new Error("--channel must be stable or beta");
	if (!commitPattern.test(parsed.commit)) throw new Error("--commit must be a lowercase 40-character Git commit SHA");
	return parsed;
}

function authoritativeSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to resolve authoritative source HEAD: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Invalid JSON in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`); } }
function assert(condition, message) { if (!condition) throw new Error(message); }
function exact(value, expected, label) { assert(JSON.stringify(value) === JSON.stringify(expected), `${label} must exactly match the fixed release component inventory`); }

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourceCommit = authoritativeSourceCommit();
	assert(args.commit === sourceCommit, `--commit must exactly match authoritative source HEAD ${sourceCommit}`);
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	const manifestPath = `${args.artifactDir}/${manifestName}`;
	const sumsPath = `${args.artifactDir}/SHA256SUMS`;
	const channelPath = `${args.artifactDir}/${args.channel}`;
	for (const path of [manifestPath, sumsPath, channelPath]) assert(existsSync(path) && statSync(path).isFile(), `Missing required artifact ${basename(path)}`);

	const manifest = readJson(manifestPath);
	assert(manifest.version === `v${args.version}`, `Manifest version must be v${args.version}`);
	assert(manifest.source?.commit === sourceCommit, `Manifest source commit must be authoritative source HEAD ${sourceCommit}`);
	assert(manifest.package === publicPackageName, `Manifest package must be ${publicPackageName}`);
	assert(manifest.tarball === `releases/v${args.version}/prime-agent-${args.version}.tgz`, "Manifest primary tarball is invalid");
	assert(Array.isArray(manifest.tarballs), "Manifest tarballs must be an array");

	const expectedTarballs = releaseComponents.map(({ component, packageName, artifactName }) => ({
		component, package: packageName, version: args.version, file: `${artifactName}-${args.version}.tgz`,
	}));
	const tarballs = manifest.tarballs;
	exact(tarballs.map(({ component, package: packageName, version, file }) => ({ component, package: packageName, version, file })), expectedTarballs, "Manifest tarballs");
	for (const tarball of tarballs) {
		assert(typeof tarball.sha256 === "string" && /^[0-9a-f]{64}$/.test(tarball.sha256), `Invalid hash for ${tarball.file}`);
		const artifactPath = `${args.artifactDir}/${tarball.file}`;
		assert(existsSync(artifactPath) && statSync(artifactPath).isFile(), `Missing tarball ${tarball.file}`);
		assert(sha256File(artifactPath) === tarball.sha256, `Hash mismatch for ${tarball.file}`);
	}
	const files = tarballs.map(({ file }) => file);
	exact(readdirSync(args.artifactDir).filter((file) => file.endsWith(".tgz")).sort(), [...files].sort(), "Artifact tarballs");
	assert(readFileSync(sumsPath, "utf8") === `${tarballs.map(({ sha256, file }) => `${sha256}  ${file}`).join("\n")}\n`, "SHA256SUMS does not match the manifest");
	assert(readFileSync(channelPath, "utf8") === `v${args.version}\n`, `${args.channel} pointer does not match version`);
	if (args.dryRun) console.log(JSON.stringify({ channel: args.channel, commit: sourceCommit, manifest: manifestName, tarballs: files, version: `v${args.version}` }, null, 2));
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
