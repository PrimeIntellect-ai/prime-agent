import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main, renderInstaller, sha256 } from "../render-installer.mjs";

const SOURCE = [
	"#!/bin/sh",
	'BASE_URL="__PRIME_AGENT_DOWNLOAD_BASE_URL__"',
	'CHANNEL="__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"',
	"",
].join("\n");

test("renders the stable channel and strips the trailing slash", () => {
	const rendered = renderInstaller(SOURCE, "https://cdn.example.com/", "stable");
	assert.match(rendered, /BASE_URL="https:\/\/cdn\.example\.com"/);
	assert.match(rendered, /CHANNEL="stable"/);
});

test("refuses a relative base url", () => {
	assert.throws(() => renderInstaller(SOURCE, "cdn.example.com", "stable"), /absolute http/);
});

test("refuses an unknown channel", () => {
	assert.throws(() => renderInstaller(SOURCE, "https://cdn.example.com", "nightly"), /Unknown release channel/);
});

test("refuses an installer with no placeholders", () => {
	assert.throws(() => renderInstaller("#!/bin/sh\n", "https://cdn.example.com", "stable"), /no placeholders/);
});

test("writes both installers and appends their digests to SHA256SUMS", () => {
	const dir = mkdtempSync(join(tmpdir(), "render-installer-"));
	const installer = join(dir, "install.sh");
	writeFileSync(installer, SOURCE);
	const outDir = join(dir, "out");
	const sums = join(dir, "SHA256SUMS");
	writeFileSync(sums, "abc  prime-agent-1.0.0.tgz\n");

	const written = main(["--installer", installer, "--base-url", "https://cdn.example.com", "--out-dir", outDir, "--sums", sums]);

	assert.deepEqual(
		written.map((entry) => entry.name),
		["install.sh", "install-beta.sh"],
	);
	const stable = readFileSync(join(outDir, "install.sh"), "utf8");
	const beta = readFileSync(join(outDir, "install-beta.sh"), "utf8");
	assert.match(stable, /CHANNEL="stable"/);
	assert.match(beta, /CHANNEL="beta"/);
	const sumsBody = readFileSync(sums, "utf8");
	assert.ok(sumsBody.includes(`${sha256(stable)}  install.sh\n`));
	assert.ok(sumsBody.includes(`${sha256(beta)}  install-beta.sh\n`));
});
