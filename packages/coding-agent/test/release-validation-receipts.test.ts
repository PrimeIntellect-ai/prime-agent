import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = resolve(__dirname, "../../../scripts/verify-macos-validation-receipts.mjs");
let root: string;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface ReceiptFixture {
	artifacts: string;
	receipts: string;
	manifestPath: string;
	inventory: string;
	archive: string;
	receipt: string;
	channel: string;
}

function fixture(channel = "production"): ReceiptFixture {
	const directory = mkdtempSync(join(root, "release-"));
	const artifacts = join(directory, "artifacts");
	const receipts = join(directory, "receipts");
	mkdirSync(artifacts);
	mkdirSync(receipts);
	const version = channel === "production" ? "1.2.3" : "1.2.3-beta.5.1.abcdef0";
	const manifestFile = channel === "production" ? "latest.json" : "beta.json";
	const binaries = ["darwin-arm64", "darwin-x64"].map((platform) => {
		const file = `prime-agent-${version}-${platform}.tar.gz`;
		writeFileSync(join(artifacts, file), `receipt fixture for ${platform}`);
		return { platform, file, sha256: sha256(join(artifacts, file)), executableSha256: "a".repeat(64) };
	});
	const manifestPath = join(artifacts, manifestFile);
	writeFileSync(manifestPath, JSON.stringify({ version: `v${version}`, binaries }));
	const inventory = join(artifacts, "SHA256SUMS");
	writeFileSync(inventory, binaries.map((entry) => `${entry.sha256}  ${entry.file}\n`).join(""));
	for (const entry of binaries) {
		writeFileSync(
			join(receipts, `${channel}-${entry.platform}.json`),
			JSON.stringify({
				schemaVersion: 1,
				...entry,
				version: `v${version}`,
				manifestFile,
				manifestSha256: sha256(manifestPath),
				inventorySha256: sha256(inventory),
			}),
		);
	}
	return {
		artifacts,
		receipts,
		manifestPath,
		inventory,
		channel,
		archive: join(artifacts, binaries[0]!.file),
		receipt: join(receipts, `${channel}-darwin-arm64.json`),
	};
}

function verify(value: ReceiptFixture, channel = value.channel) {
	return spawnSync(process.execPath, [script, value.artifacts, value.receipts, channel], { encoding: "utf8" });
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "prime-release-receipts-"));
});
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("macOS validation receipt publication gate", () => {
	it.each(["production", "beta"])("accepts matching %s receipts from both architectures", (channel) => {
		const result = verify(fixture(channel));
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("darwin-arm64");
		expect(result.stdout).toContain("darwin-x64");
	});

	it.each(["darwin-arm64", "darwin-x64"])("fails closed when %s validation did not produce a receipt", (platform) => {
		const value = fixture();
		rmSync(join(value.receipts, `production-${platform}.json`));
		expect(verify(value).status).not.toBe(0);
	});

	it.each([
		["changed archive bytes", (value: ReceiptFixture) => writeFileSync(value.archive, "changed after validation")],
		[
			"changed manifest bytes",
			(value: ReceiptFixture) => writeFileSync(value.manifestPath, `${readFileSync(value.manifestPath, "utf8")}\n`),
		],
		[
			"changed inventory bytes",
			(value: ReceiptFixture) =>
				writeFileSync(value.inventory, `${readFileSync(value.inventory, "utf8")}${"b".repeat(64)}  extra.tgz\n`),
		],
		[
			"duplicate inventory entry",
			(value: ReceiptFixture) => writeFileSync(value.inventory, readFileSync(value.inventory, "utf8").repeat(2)),
		],
		[
			"ambiguous manifests",
			(value: ReceiptFixture) =>
				writeFileSync(join(value.artifacts, "binaries.json"), readFileSync(value.manifestPath)),
		],
	])("rejects %s after native validation", (_label, mutate) => {
		const value = fixture();
		mutate(value);
		expect(verify(value).status).not.toBe(0);
	});

	it("rejects a changed executable identity even if the archive and inventory remain consistent", () => {
		const value = fixture();
		const manifest = JSON.parse(readFileSync(value.manifestPath, "utf8"));
		manifest.binaries[0].executableSha256 = "b".repeat(64);
		writeFileSync(value.manifestPath, JSON.stringify(manifest));
		const result = verify(value);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("executableSha256");
	});

	it("rejects an archive replaced together with its manifest and checksum inventory", () => {
		const value = fixture();
		writeFileSync(value.archive, "replacement archive with internally consistent metadata");
		const manifest = JSON.parse(readFileSync(value.manifestPath, "utf8"));
		manifest.binaries[0].sha256 = sha256(value.archive);
		writeFileSync(value.manifestPath, JSON.stringify(manifest));
		writeFileSync(
			value.inventory,
			manifest.binaries
				.map((entry: { sha256: string; file: string }) => `${entry.sha256}  ${entry.file}\n`)
				.join(""),
		);
		const result = verify(value);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("sha256");
	});

	it.each([
		"schemaVersion",
		"platform",
		"version",
		"file",
		"sha256",
		"executableSha256",
		"manifestFile",
		"manifestSha256",
		"inventorySha256",
	])("rejects a mismatched receipt %s", (key) => {
		const value = fixture();
		const receipt = JSON.parse(readFileSync(value.receipt, "utf8"));
		receipt[key] = "changed";
		writeFileSync(value.receipt, JSON.stringify(receipt));
		expect(verify(value).status).not.toBe(0);
	});

	it.skipIf(process.platform === "win32").each(["production", "beta"])(
		"the actual workflow shell stops before publication when %s validation is missing",
		(channel) => {
			const value = fixture(channel);
			const working = mkdtempSync(join(root, "publication-"));
			mkdirSync(join(working, "release-artifacts"));
			symlinkSync(value.artifacts, join(working, "release-artifacts", channel));
			symlinkSync(value.receipts, join(working, "macos-validation"));
			mkdirSync(join(working, "scripts"));
			for (const name of ["verify-macos-validation-receipts.mjs", "release-artifact-integrity.mjs"]) {
				copyFileSync(resolve(__dirname, "../../../scripts", name), join(working, "scripts", name));
			}
			const workflow = parse(
				readFileSync(resolve(__dirname, "../../../.github/workflows/build-binaries.yml"), "utf8"),
			);
			const gate = workflow.jobs.publish.steps.find(
				(step: { name?: string }) => step.name === "Match native validation to publication artifacts",
			);
			expect(gate).toBeDefined();
			const runGate = () =>
				spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${gate.run}\nprintf publication-reached`], {
					cwd: working,
					env: {
						...process.env,
						PUBLISH_PRODUCTION: String(channel === "production"),
						PUBLISH_BETA: String(channel === "beta"),
					},
					encoding: "utf8",
				});
			const passed = runGate();
			expect(passed.status, passed.stderr).toBe(0);
			expect(passed.stdout).toContain("publication-reached");
			rmSync(join(value.receipts, `${channel}-darwin-x64.json`));
			const failed = runGate();
			expect(failed.status).not.toBe(0);
			expect(failed.stdout).not.toContain("publication-reached");
		},
	);

	it("does not substitute another channel's receipts or accept an unknown channel", () => {
		const value = fixture();
		expect(verify(value, "beta").status).not.toBe(0);
		expect(verify(value, "stable").status).not.toBe(0);
	});
});
