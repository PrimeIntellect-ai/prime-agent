#!/usr/bin/env node
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs <target> --dry-run   (preview changelog updates only)
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version via npm run version:xxx or set an explicit version
 * 3. Update CHANGELOG.md files: aggregate .changes/*.md fragments into a
 *    [version] - date section, git rm the consumed fragments
 * 4. Commit on a release/vX.Y.Z branch, push it, and open the release pull request
 *
 * This script PREPARES a release; it does not perform one. It never pushes main and never
 * creates the tag. A release is a reviewed pull request: open one from the pushed branch, get it
 * approved, merge it, and CI builds, signs, publishes and tags the result. See
 * packages/coding-agent/docs/releasing.md.
 *
 * Publishing is NOT part of this script. CI publishes the release artifacts (R2 archives and npm
 * packages), so no publish credential is ever present on a laptop.
 */

import { execSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { buildReleaseSection } from "./lib/changelog-fragments.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PR = process.argv.includes("--no-pr");
const RELEASE_TARGET = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--dry-run] [--no-pr]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

/**
 * Creates the release branch before any file is touched, so an aborted or repeated run never
 * leaves the original branch holding a half-consumed release. Fails if the branch already exists
 * locally or on the remote: a second release of the same version is a new decision, not a retry.
 */
function createReleaseBranch(version) {
	const branch = `release/v${version}`;
	// A release ships exactly what main has. Starting from any other branch would fold that branch's
	// unmerged commits into the release pull request.
	const current = (run("git rev-parse --abbrev-ref HEAD", { silent: true }) || "").trim();
	if (current !== "main") {
		console.error(`Error: releases are prepared from main, not from ${current || "a detached HEAD"}.`);
		process.exit(1);
	}
	run("git fetch origin main", { silent: true });
	const local = run("git rev-parse HEAD", { silent: true }).trim();
	const upstream = run("git rev-parse origin/main", { silent: true }).trim();
	if (local !== upstream) {
		console.error(`Error: local main (${local.slice(0, 9)}) is not origin/main (${upstream.slice(0, 9)}). Pull or reset first.`);
		process.exit(1);
	}
	const existing = run(`git branch --list ${branch}`, { silent: true });
	if (existing && existing.trim()) {
		console.error(`Error: branch ${branch} already exists locally. Delete it or pick another version.`);
		process.exit(1);
	}
	const remote = run(`git ls-remote --heads origin ${branch}`, { silent: true });
	if (remote && remote.trim()) {
		console.error(`Error: branch ${branch} already exists on origin. A release for v${version} was already prepared.`);
		process.exit(1);
	}
	run(`git checkout -b ${branch}`);
	return branch;
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	if (compareVersions(target, currentVersion) <= 0) {
		console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		`npm version ${target} -ws --no-git-tag-version && node scripts/sync-versions.js && npx shx rm -rf node_modules packages/*/node_modules package-lock.json && npm install`,
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function listFragments(pkgDir) {
	const changesDir = join(pkgDir, ".changes");
	if (!existsSync(changesDir)) {
		return [];
	}

	const files = readdirSync(changesDir)
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => join(changesDir, name));
	return files
		.map((path) => ({ path, key: fragmentSortKey(path) }))
		.sort((a, b) => a.key - b.key || (a.path < b.path ? -1 : 1))
		.map(({ path }) => ({ name: path, content: readFileSync(path, "utf-8") }));
}

function fragmentSortKey(path) {
	const output = run(`git log --diff-filter=A --format=%ct -1 -- ${shellQuote(path)}`, {
		silent: true,
		ignoreError: true,
	});
	const epoch = Number.parseInt((output || "").trim(), 10);
	return Number.isFinite(epoch) ? epoch : Infinity;
}

/** Reads the notes this release just wrote into the coding-agent changelog, for the pull request body. */
function releaseNotes(version) {
	const changelog = join("packages", "coding-agent", "CHANGELOG.md");
	if (!existsSync(changelog)) return "";
	const lines = readFileSync(changelog, "utf-8").split("\n");
	const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
	if (start === -1) return "";
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("## ["));
	return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Opens the release pull request. Failing here is not fatal: the branch is already pushed, so the
 * pull request can be opened by hand.
 */
function openReleasePullRequest(version, branch) {
	console.log("Opening the release pull request...");
	const notes = releaseNotes(version);
	const body = [
		`release v${version}.`,
		"",
		notes || "see the changelogs in this branch for the included changes.",
		"",
		"merging this publishes the release: ci builds, signs and verifies the artifacts, then tags `v" +
			version +
			"`.",
	].join("\n");
	// A private, freshly created directory: a predictable path in the shared temp directory could be
	// pre-planted as a symlink and make this write clobber an arbitrary file.
	const bodyDir = mkdtempSync(join(tmpdir(), "prime-agent-release-"));
	const bodyFile = join(bodyDir, "pull-request.md");
	writeFileSync(bodyFile, `${body}\n`, { flag: "wx" });
	// ignoreError: a missing or unauthenticated gh must not abort a run whose branch is already
	// pushed; the caller prints the manual recovery instead.
	const url = run(
		`gh pr create --base main --head ${branch} --title "release v${version}" --body-file ${bodyFile}`,
		{ silent: true, ignoreError: true },
	);
	const last = url?.trim().split("\n").at(-1);
	if (!last || !/^https:\/\//.test(last)) {
		console.warn(`  Could not open the pull request automatically; open it for ${branch} by hand.`);
		return undefined;
	}
	return last;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();
	const consumedFragments = [];

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");
		const allFragments = listFragments(dirname(changelog));
		// Empty fragments are skipped, not consumed, so nothing is ever lost silently.
		const empty = allFragments.filter((fragment) => !fragment.content.trim());
		for (const fragment of empty) {
			console.warn(`  Warning: skipping empty fragment ${fragment.name}; delete it or add content.`);
		}
		const fragments = allFragments.filter((fragment) => fragment.content.trim());
		const result = buildReleaseSection(content, fragments, version, date);

		if (!result.changed) {
			console.log(`  Skipping ${changelog}: no fragments`);
			continue;
		}

		if (DRY_RUN) {
			console.log(`\n--- ${changelog} (${fragments.length} fragments) ---`);
			const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const sectionRe = new RegExp(`## \\[${escapedVersion}\\][\\s\\S]*?(?=\\n## \\[|$)`);
			console.log((result.content.match(sectionRe) || ["(no release section)"])[0]);
		} else {
			writeFileSync(changelog, result.content);
			console.log(`  Updated ${changelog} (${fragments.length} fragments)`);
		}
		consumedFragments.push(...fragments.map((fragment) => fragment.name));
	}

	if (consumedFragments.length > 0) {
		if (DRY_RUN) {
			console.log(`\nWould git rm: ${consumedFragments.join(", ")}`);
		} else {
			run(`git rm -q -- ${consumedFragments.map(shellQuote).join(" ")}`);
		}
	}
}

function previewVersion(target) {
	if (!BUMP_TYPES.has(target)) {
		return target;
	}
	const [major, minor, patch] = getVersion().split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

console.log("\n=== Release Script ===\n");

if (DRY_RUN) {
	const version = previewVersion(RELEASE_TARGET);
	console.log(`Dry run for v${version}: previewing changelog updates, no files are written.`);
	updateChangelogsForRelease(version);
	console.log("\n=== Dry run complete (no changes made) ===");
	process.exit(0);
}

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// Predict the version and create the branch BEFORE anything is mutated.
const plannedVersion = previewVersion(RELEASE_TARGET);
const releaseBranch = createReleaseBranch(plannedVersion);

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);
if (version !== plannedVersion) {
	console.error(`Error: expected the bump to produce ${plannedVersion} but got ${version}.`);
	process.exit(1);
}

console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

console.log(`Committing on ${releaseBranch}...`);
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
console.log();

// npm publishing is a CI-only job (OIDC trusted publishing, --provenance). Never publish from a
// laptop: a release shell runs a full install, build and check with a registry credential in
// ~/.npmrc, which is exactly the shape a malicious postinstall exploits.
console.log("Pushing the release branch...");
run(`git push -u origin ${releaseBranch}`);
console.log();

// Opening the pull request is the last thing this script does. It cannot approve or merge it:
// the release workflow publishes unattended only for a merge commit whose pull request carries a
// human approval, so a release always passes through someone else's review.
const pullRequestUrl = NO_PR ? undefined : openReleasePullRequest(version, releaseBranch);

// The tag is created by the release workflow after the artifacts are published, so a tag never
// exists for a release that failed or was never reviewed.
console.log(`=== Prepared v${version} on ${releaseBranch} ===`);
if (pullRequestUrl) {
	console.log(`Release pull request: ${pullRequestUrl}`);
	console.log("Next: have it reviewed and merged. CI then builds, signs, publishes and tags the release.");
} else {
	console.log(`Next: open a pull request for ${releaseBranch}, have it reviewed, and merge it.`);
	console.log("CI then builds, signs, publishes and tags the release.");
}
