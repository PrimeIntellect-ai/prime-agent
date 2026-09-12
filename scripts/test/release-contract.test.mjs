import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const packer = new URL("../pack-prime-agent-release.mjs", import.meta.url);
const verifier = new URL("../verify-prime-agent-release.mjs", import.meta.url);
const releaseVersion = new URL("../read-release-version.mjs", import.meta.url);
const githubApiPathSegment = new URL("../encode-github-api-path-segment.mjs", import.meta.url);
const workflow = new URL("../../.github/workflows/build-binaries.yml", import.meta.url);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = "0.7.1";
const components = [
	["agent", "prime-agent-core"],
	["ai", "prime-agent-ai"],
	["tui", "prime-agent-tui"],
	["coding-agent", "prime-agent"],
];

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function createArtifacts(mutator) {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-contract-"));
	const tarballs = components.map(([component, packageName]) => {
		const file = `${packageName}-${version}.tgz`;
		const contents = `fixture ${file}\n`;
		writeFileSync(join(directory, file), contents);
		return { component, package: packageName, version, file, sha256: sha256(contents) };
	});
	const manifest = { version: `v${version}`, source: { commit: sourceCommit }, package: "prime-agent", tarball: `releases/v${version}/prime-agent-${version}.tgz`, tarballs };
	mutator?.({ directory, manifest, tarballs });
	writeFileSync(join(directory, "SHA256SUMS"), manifest.tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n");
	writeFileSync(join(directory, "stable"), `v${version}\n`);
	writeFileSync(join(directory, "latest.json"), JSON.stringify(manifest) + "\n");
	return directory;
}
function verify(directory, commit = sourceCommit) {
	return spawnSync(process.execPath, [verifier.pathname, "--artifact-dir", directory, "--channel", "stable", "--version", version, "--commit", commit, "--dry-run"], { cwd: root.pathname, encoding: "utf8" });
}
function cleanup(directory) { rmSync(directory, { force: true, recursive: true }); }

test("packer rejects a spoofed --commit instead of recording caller-controlled provenance", () => {
	const result = spawnSync(process.execPath, [packer.pathname, "--base-url", "https://release.invalid", "--commit", "0123456789abcdef0123456789abcdef01234567"], { cwd: root.pathname, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /authoritative source HEAD/);
});

test("packer resolves HEAD and rejects tracked-dirty source before packaging", () => {
	const source = readFileSync(packer, "utf8");
	assert.match(source, /git", \["rev-parse", "HEAD"\]/);
	assert.match(source, /git", \["status", "--porcelain=v1", "--untracked-files=no"\]/);
	assert.match(source, /tracked-dirty source checkout/);
});

test("packer refuses a tracked-dirty source checkout", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-dirty-"));
	try {
		const scripts = join(directory, "scripts");
		mkdirSync(scripts);
		copyFileSync(packer, join(scripts, "pack-prime-agent-release.mjs"));
		copyFileSync(new URL("../prime-agent-release-components.mjs", import.meta.url), join(scripts, "prime-agent-release-components.mjs"));
		writeFileSync(join(directory, "tracked.txt"), "clean\n");
		execFileSync("git", ["init", "--quiet"], { cwd: directory });
		execFileSync("git", ["add", "."], { cwd: directory });
		execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: directory });
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
		writeFileSync(join(directory, "tracked.txt"), "dirty\n");
		const result = spawnSync(process.execPath, [join(scripts, "pack-prime-agent-release.mjs"), "--base-url", "https://release.invalid", "--commit", commit], { cwd: directory, encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /tracked-dirty source checkout/);
	} finally { cleanup(directory); }
});

function createPackerFixture() {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-packer-"));
	const scripts = join(directory, "scripts");
	mkdirSync(scripts, { recursive: true });
	copyFileSync(packer, join(scripts, "pack-prime-agent-release.mjs"));
	copyFileSync(new URL("../prime-agent-release-components.mjs", import.meta.url), join(scripts, "prime-agent-release-components.mjs"));
	for (const [component] of components) {
		const packageDir = join(directory, "packages", component);
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: `@fixture/${component}`, version: "0.7.1" }));
		writeFileSync(join(packageDir, "README.md"), `tracked ${component}\n`);
		writeFileSync(join(packageDir, "dist", "index.js"), `generated ${component}\n`);
	}
	// Release source files are committed, while dist is deliberately ignored and
	// recreated after checkout to model the CI build boundary.
	writeFileSync(join(directory, ".gitignore"), "packages/*/dist/\npackages/coding-agent/release/\n");
	execFileSync("git", ["init", "--quiet"], { cwd: directory });
	execFileSync("git", ["add", "."], { cwd: directory });
	execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: directory });
	return directory;
}

function fixtureCommit(directory) {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
}

function packFixture(directory, outDir = "packages/coding-agent/release/fixture") {
	return spawnSync(process.execPath, [join(directory, "scripts", "pack-prime-agent-release.mjs"), "--base-url", "https://release.invalid", "--commit", fixtureCommit(directory), "--version", version, "--out-dir", outDir], { cwd: directory, encoding: "utf8" });
}

test("packer rejects untracked skill, documentation, and source inputs before they can be packed", () => {
	for (const [path, contents] of [
		["packages/coding-agent/skills/untracked.md", "malicious skill\n"],
		["packages/coding-agent/docs/untracked.md", "malicious doc\n"],
		["packages/coding-agent/src/untracked.ts", "malicious source\n"],
		["packages/coding-agent/docs/ignored.md", "ignored malicious doc\n"],
	]) {
		const directory = createPackerFixture();
		try {
			mkdirSync(join(directory, path, ".."), { recursive: true });
			writeFileSync(join(directory, path), contents);
			if (path.includes("ignored")) writeFileSync(join(directory, ".git", "info", "exclude"), "packages/coding-agent/docs/ignored.md\n");
			const result = packFixture(directory);
			assert.notEqual(result.status, 0, path);
			assert.match(result.stderr, /untracked file outside fixed generated roots/);
			assert.equal(result.stdout.includes(contents.trim()), false, path);
		} finally { cleanup(directory); }
	}
});

test("packer permits only generated dist overlays and packs immutable tracked package content", () => {
	const directory = createPackerFixture();
	try {
		const result = packFixture(directory);
		assert.equal(result.status, 0, result.stderr);
		const tarball = join(directory, "packages/coding-agent/release/fixture/artifacts/prime-agent-0.7.1.tgz");
		const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
		assert.match(listed, /package\/dist\/index\.js/);
		assert.match(listed, /package\/README\.md/);
		assert.doesNotMatch(listed, /untracked/);
	} finally { cleanup(directory); }
});

test("release workflow clean boundary removes pre-existing untracked dist before install and build", () => {
	const source = readFileSync(workflow, "utf8");
	const checkout = source.indexOf("ref: ${{ env.SOURCE_SHA }}");
	const clean = source.indexOf("git clean -ffdx", checkout);
	const install = source.indexOf("run: npm ci", checkout);
	const build = source.indexOf("run: npm run build", checkout);
	const removeInputs = source.indexOf("Remove non-release build inputs", build);
	assert.ok(clean > checkout, "release build must clean immediately after immutable checkout");
	assert.ok(clean < install && clean < build, "clean must precede dependency installation and build");
	assert.match(source.slice(clean, install), /git status --porcelain=v1 --untracked-files=all/);
	assert.ok(removeInputs > build, "workflow must remove pre-clean untracked inputs before packing");
	assert.match(source.slice(removeInputs), /git clean -ffdx[\s\S]*-e \/packages\/coding-agent\/dist\//);
});

test("release verifier accepts the exact fixed four-component inventory", () => {
	const directory = createArtifacts();
	try {
		const result = verify(directory);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).tarballs, components.map(([, packageName]) => `${packageName}-${version}.tgz`));
	} finally { cleanup(directory); }
});

test("release verifier binds caller and manifest commits to authoritative HEAD", () => {
	const directory = createArtifacts(({ manifest }) => { manifest.source.commit = "fedcba9876543210fedcba9876543210fedcba98"; });
	try {
		const result = verify(directory);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Manifest source commit must be authoritative source HEAD/);
		const spoofed = verify(directory, "0123456789abcdef0123456789abcdef01234567");
		assert.notEqual(spoofed.status, 0);
		assert.match(spoofed.stderr, /--commit must exactly match authoritative source HEAD/);
	} finally { cleanup(directory); }
});

test("release verifier rejects missing or substituted secondary components", () => {
	for (const mutate of [
		({ manifest }) => { manifest.tarballs.splice(1, 1); },
		({ manifest }) => { manifest.tarballs[1].package = "prime-agent-substitute"; manifest.tarballs[1].file = `prime-agent-substitute-${version}.tgz`; },
	]) {
		const directory = createArtifacts(mutate);
		try {
			const result = verify(directory);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /fixed release component inventory/);
		} finally { cleanup(directory); }
	}
});

test("release verifier retains hash tamper protection", () => {
	const directory = createArtifacts();
	try {
		writeFileSync(join(directory, `prime-agent-${version}.tgz`), "tampered\n");
		const result = verify(directory);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Hash mismatch/);
	} finally { cleanup(directory); }
});

test("workflow resolves once then only checks out and verifies immutable source_sha", () => {
	const source = readFileSync(workflow, "utf8");
	assert.match(source, /source_sha: \$\{\{ steps\.context\.outputs\.source_sha \}\}/);
	assert.match(source, /source_sha=\$\(git rev-parse "\$\{GITHUB_SHA_VALUE\}\^\{commit\}"\)/);
	assert.match(source, /tagged_commit=\$\(git rev-parse "refs\/tags\/\$INPUT_RELEASE_TAG\^\{commit\}"\)/);
	assert.match(source, /source_sha="\$GITHUB_SHA_VALUE"/);
	assert.match(source, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
	assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
	assert.match(source, /--commit "\$SOURCE_SHA"/);
	assert.match(source, /--target "\$SOURCE_SHA"/);
	assert.doesNotMatch(source, /BUILD_REF/);
	assert.doesNotMatch(source, /ref: \$\{\{ env\.BUILD_REF \}\}/);
});


test("workflow peels annotated tags and only creates protected production tags once", () => {
	const source = readFileSync(workflow, "utf8");
	assert.match(source, /fetch-depth: 0/);
	assert.match(source, /fetch-tags: true/);
	assert.match(source, /source_sha=\$\(git rev-parse "refs\/tags\/\$REF_NAME\^\{commit\}"\)/);
	assert.match(source, /tagged_commit=\$\(git rev-parse "refs\/tags\/\$INPUT_RELEASE_TAG\^\{commit\}"\)/);
	assert.match(source, /tagged_commit=\$\(git rev-parse "refs\/tags\/v\$\{production_version\}\^\{commit\}"\)/);
	assert.match(source, /Manual release will create immutable production tag \$INPUT_RELEASE_TAG for \$source_sha\./);
	assert.match(source, /Manual release tag \$INPUT_RELEASE_TAG resolves to \$tagged_commit, not the selected immutable default-branch commit \$source_sha\./);
	assert.match(source, /gh api --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/git\/refs"/);
	assert.match(source, /-f "ref=refs\/tags\/\$RELEASE_TAG"/);
	assert.match(source, /-f "sha=\$SOURCE_SHA"/);
	const productionTagStep = source.slice(source.indexOf("- name: Create or verify immutable production tag"), source.indexOf("- name: Prepare installer"));
	assert.doesNotMatch(productionTagStep, /force=/);
	assert.doesNotMatch(source, /create or update/i);
});

test("workflow rechecks the remote protected tag before stable pointers and after release upload", () => {
	const source = readFileSync(workflow, "utf8");
	const rechecks = source.match(/git fetch --no-tags origin "refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"/g) ?? [];
	assert.ok(rechecks.length >= 4, "expected remote tag checks after creation, before stable pointers, and around release upload");
	const peels = source.match(/git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"/g) ?? [];
	assert.ok(peels.length >= 4, "expected each remote tag check to peel annotated tags");
	assert.match(source, /# Production tags are protected immutable release identities\./);
	assert.match(source, /# Re-fetch at the stable-pointer boundary/);
	assert.match(source, /changed during release publication/);
	assert.doesNotMatch(source, /^\s*queue:/m);
});

test("release version reader emits exactly one canonical semver line", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-version-"));
	try {
		const packageJson = join(directory, "package.json");
		writeFileSync(packageJson, JSON.stringify({ version: "1.2.3" }));
		const result = spawnSync(process.execPath, [releaseVersion.pathname, packageJson], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "1.2.3\n");
	} finally { cleanup(directory); }
});

test("release version reader rejects multiline values and output injection", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-version-injection-"));
	try {
		for (const versionValue of ["1.2.3\nproduction_version=9.9.9", "1.2.3\rpublish_beta=true", "1.2.3\n", "1.2.3\u0000x"]) {
			const packageJson = join(directory, `${Buffer.from(versionValue).toString("hex")}.json`);
			writeFileSync(packageJson, JSON.stringify({ version: versionValue }));
			const result = spawnSync(process.execPath, [releaseVersion.pathname, packageJson], { encoding: "utf8" });
			assert.notEqual(result.status, 0, versionValue);
			assert.equal(result.stdout, "", versionValue);
			assert.match(result.stderr, /Invalid package\.json version/, versionValue);
		}
	} finally { cleanup(directory); }
});

test("release version reader rejects malformed or non-canonical semver", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-version-malformed-"));
	try {
		for (const versionValue of ["01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2", "1.2.3-beta.1", "1.2.3+build", "1.2.3;echo pwned"]) {
			const packageJson = join(directory, `${Buffer.from(versionValue).toString("hex")}.json`);
			writeFileSync(packageJson, JSON.stringify({ version: versionValue }));
			const result = spawnSync(process.execPath, [releaseVersion.pathname, packageJson], { encoding: "utf8" });
			assert.notEqual(result.status, 0, versionValue);
			assert.match(result.stderr, /canonical plain semver/, versionValue);
		}
	} finally { cleanup(directory); }
});

test("release version reader rejects invalid JSON and non-string version fields", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-version-json-"));
	try {
		for (const contents of ["{", JSON.stringify({}), JSON.stringify({ version: 123 })]) {
			const packageJson = join(directory, `${Buffer.from(contents).toString("hex")}.json`);
			writeFileSync(packageJson, contents);
			const result = spawnSync(process.execPath, [releaseVersion.pathname, packageJson], { encoding: "utf8" });
			assert.notEqual(result.status, 0, contents);
			assert.equal(result.stdout, "", contents);
			assert.match(result.stderr, /Invalid package\.json version/, contents);
		}
	} finally { cleanup(directory); }
});

test("GitHub commits refs are percent-encoded as one REST path segment", () => {
	for (const [ref, encoded] of [["feature/release", "feature%2Frelease"], ["release#candidate", "release%23candidate"], ["release?candidate", "release%3Fcandidate"], ["release /#?", "release%20%2F%23%3F"]]) {
		const result = spawnSync(process.execPath, [githubApiPathSegment.pathname, ref], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${encoded}\n`);
	}
});

test("workflow validates package version before output and binds production tags to it", () => {
	const source = readFileSync(workflow, "utf8");
	const outputIndex = source.indexOf('echo "beta_version=$beta_version" >> "$GITHUB_OUTPUT"');
	const packageVersionIndex = source.indexOf("package_version=$(node scripts/read-release-version.mjs package.json)");
	assert.ok(packageVersionIndex >= 0 && packageVersionIndex < outputIndex, "package version must be validated before any context output");
	assert.match(source, /production_version="\$\{INPUT_RELEASE_TAG#v\}"\n            if \[ "\$production_version" != "\$package_version" \]/);
	assert.match(source, /production_version="\$\{REF_NAME#v\}"\n            if \[ "\$production_version" != "\$package_version" \]/);
	assert.match(source, /production_version="\$package_version"\n            source_sha=/);
	assert.match(source, /previous_version=\$\(node scripts\/read-release-version\.mjs \/tmp\/previous-package\.json\)/);
});

test("workflow uses the encoded default branch in the GitHub commits API", () => {
	const source = readFileSync(workflow, "utf8");
	assert.match(source, /encoded_default_branch=\$\(node scripts\/encode-github-api-path-segment\.mjs "\$DEFAULT_BRANCH"\)/);
	assert.match(source, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{encoded_default_branch\}" --jq \.sha/);
	assert.doesNotMatch(source, /commits\/\$\{DEFAULT_BRANCH\}/);
});
