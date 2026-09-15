import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(join(root, "scripts", "release.mjs"), "utf8");

// A release is a reviewed pull request. The preparation script must never be able to publish one
// on its own, so it may not push the default branch and may not create the release tag: the tag is
// created by the release workflow only after the artifacts are published.
test("the release script never pushes main", () => {
	assert.equal(/git push origin main/.test(script), false);
	assert.equal(/git push\s+(-u\s+)?origin\s+main/.test(script), false);
});

test("the release script never creates the release tag", () => {
	assert.equal(/git tag/.test(script), false);
	assert.equal(/git push origin v\$/.test(script), false);
});

test("the release script pushes a release branch instead", () => {
	assert.match(script, /release\/v\$\{version\}/);
	assert.match(script, /git push -u origin \$\{releaseBranch\}/);
});

test("the release script opens the pull request but cannot approve or merge it", () => {
	assert.match(script, /gh pr create --base main --head \$\{branch\}/);
	assert.equal(/gh pr merge/.test(script), false);
	assert.equal(/gh pr review/.test(script), false);
	assert.equal(/--admin/.test(script), false);
});

test("the release script creates the release branch before mutating anything", () => {
	const branch = script.indexOf("createReleaseBranch(plannedVersion)");
	const bump = script.indexOf("bumpOrSetVersion(RELEASE_TARGET)");
	// The first call to updateChangelogsForRelease is the dry run, which exits before anything is
	// mutated; the real call is the last one.
	const changelog = script.lastIndexOf("updateChangelogsForRelease(version)");
	assert.ok(script.indexOf("process.exit(0)") < branch, "the dry run must exit before the branch is created");
	assert.ok(branch > 0 && bump > 0 && changelog > 0);
	assert.ok(branch < bump, "branch must be created before the version bump");
	assert.ok(branch < changelog, "branch must be created before changelogs are rewritten");
});

test("the release script refuses an existing release branch", () => {
	assert.match(script, /git branch --list \$\{branch\}/);
	assert.match(script, /git ls-remote --heads origin \$\{branch\}/);
});

test("the release script only prepares from an up-to-date main", () => {
	assert.match(script, /git rev-parse --abbrev-ref HEAD/);
	assert.match(script, /current !== "main"/);
	assert.match(script, /git rev-parse origin\/main/);
});

test("a failed gh pr create does not abort after the branch was pushed", () => {
	const call = script.indexOf("gh pr create --base main");
	const opts = script.slice(call, call + 200);
	assert.match(opts, /ignoreError: true/);
});

test("the release script writes the pull request body in a private temp directory", () => {
	assert.match(script, /mkdtempSync\(join\(tmpdir\(\), "prime-agent-release-"\)\)/);
	assert.match(script, /flag: "wx"/);
	assert.equal(/join\(tmpdir\(\), `prime-agent-release-\$\{version\}\.md`\)/.test(script), false);
});
