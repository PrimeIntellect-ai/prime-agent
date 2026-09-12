import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repository = resolve(__dirname, "../../..");
const signatureScript = join(repository, "packages/coding-agent/scripts/macos-signature.mjs");
const assemblyScript = join(repository, "scripts/assemble-release-archives.mjs");
const platform = `${process.platform}-${process.arch}`;
let root: string;
let fixture: string;

function signature(command: string, binary: string, target = platform) {
	return spawnSync(process.execPath, [signatureScript, command, binary, target], { encoding: "utf8" });
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function codesignDetails(binary: string): string {
	const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", binary], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout + result.stderr;
}

function entitlements(binary: string): string {
	return execFileSync("/usr/bin/codesign", ["--display", "--entitlements", "-", binary], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "prime-release-signatures-"));
	if (process.platform === "darwin") {
		fixture = join(root, "native-fixture");
		const source = join(root, "fixture.c");
		writeFileSync(
			source,
			`#include <stdio.h>
#include <string.h>
const char payload[32768] = "signature-page-fixture";
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) puts("1.2.3");
  else if (argc == 2 && strcmp(argv[1], "--help") == 0) puts("Python REPL");
  return payload[0] == 0;
}
`,
		);
		execFileSync("/usr/bin/cc", [source, "-o", fixture]);
		execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", fixture], { stdio: "pipe" });
	}
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("release signature command", () => {
	it.each(["linux-arm64", "linux-x64"])("leaves %s binaries untouched", (target) => {
		const binary = join(root, target);
		writeFileSync(binary, `Linux fixture ${target}`);
		const original = sha256(binary);
		for (const command of ["sign", "verify"]) {
			const result = signature(command, binary, target);
			expect(result.status, result.stderr).toBe(0);
			expect(sha256(binary)).toBe(original);
		}
	});

	it("rejects unsupported targets and invalid commands", () => {
		expect(signature("sign", "unused", "windows-x64").status).not.toBe(0);
		expect(signature("repair", "unused", "linux-x64").status).not.toBe(0);
	});

	it.skipIf(process.platform === "darwin")("cannot approve Darwin signatures on a non-macOS host", () => {
		for (const target of ["darwin-arm64", "darwin-x64"]) {
			for (const command of ["sign", "verify"]) {
				const result = signature(command, "unused", target);
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("macOS");
			}
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"rejects unsigned and damaged signatures, then repairs signed page hashes",
		() => {
			const binary = join(root, "damaged-fixture");
			copyFileSync(fixture, binary);
			expect(signature("verify", binary).status).toBe(0);
			const bytes = readFileSync(binary);
			bytes[4096] ^= 1;
			writeFileSync(binary, bytes);
			const damaged = signature("verify", binary);
			expect(damaged.status).not.toBe(0);
			expect(damaged.stderr).toMatch(/invalid|modified/i);
			const repaired = signature("sign", binary);
			expect(repaired.status, repaired.stderr).toBe(0);
			expect(signature("verify", binary).status).toBe(0);
			execFileSync("/usr/bin/codesign", ["--remove-signature", binary]);
			expect(signature("verify", binary).status).not.toBe(0);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"retains JIT entitlements and the hardened runtime flag during replacement",
		() => {
			const binary = join(root, "jit-fixture");
			copyFileSync(fixture, binary);
			const plist = join(root, "entitlements.plist");
			writeFileSync(
				plist,
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>`,
			);
			execFileSync(
				"/usr/bin/codesign",
				["--force", "--sign", "-", "--options", "runtime", "--entitlements", plist, binary],
				{
					stdio: "pipe",
				},
			);
			const originalEntitlements = entitlements(binary);
			expect(originalEntitlements).toContain("com.apple.security.cs.allow-jit");
			expect(codesignDetails(binary)).toMatch(/flags=.*\bruntime\b/);
			const result = signature("sign", binary);
			expect(result.status, result.stderr).toBe(0);
			expect(entitlements(binary)).toBe(originalEntitlements);
			expect(codesignDetails(binary)).toMatch(/flags=.*\bruntime\b/);
			expect(signature("verify", binary).status).toBe(0);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"does not grant entitlements or hardened runtime to a plain ad-hoc binary",
		() => {
			const binary = join(root, "plain-fixture");
			copyFileSync(fixture, binary);
			const originalEntitlements = entitlements(binary);
			expect(originalEntitlements).not.toContain("com.apple.security");
			expect(codesignDetails(binary)).not.toMatch(/flags=.*\bruntime\b/);
			const result = signature("sign", binary);
			expect(result.status, result.stderr).toBe(0);
			expect(entitlements(binary)).toBe(originalEntitlements);
			expect(codesignDetails(binary)).not.toMatch(/flags=.*\bruntime\b/);
		},
	);
});

function binaryAssets(directory: string, binary: Buffer): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "prime-agent"), binary, { mode: 0o755 });
	for (const name of [
		"install.sh",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"photon_rs_bg.wasm",
		"prime-agent-runtime/pyproject.toml",
		"prime-agent-runtime/src/rlm/repl.py",
		"theme/prime.json",
		"theme/dark.json",
		"theme/light.json",
		"export-html/template.html",
		"export-html/template.css",
		"export-html/template.js",
		"export-html/vendor/marked.min.js",
		"export-html/vendor/highlight.min.js",
	]) {
		mkdirSync(dirname(join(directory, name)), { recursive: true });
		writeFileSync(join(directory, name), name);
	}
	for (const name of ["skills", "assets", "docs", "examples"]) mkdirSync(join(directory, name));
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
}

interface BinaryManifest {
	version: string;
	binaries: { platform: string; file: string; sha256: string; executableSha256: string }[];
}

describe.skipIf(process.platform === "win32")("release archive executable identity", () => {
	it("keeps all four executable bytes identical across stable and beta metadata rewrites", () => {
		const binaries = join(root, "binaries");
		const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
		for (const target of targets) binaryAssets(join(binaries, target), Buffer.from(`unchanged ${target} executable`));
		for (const version of ["1.2.3", "1.2.3-beta.4.1.abcdef0"]) {
			const output = join(root, version);
			execFileSync(process.execPath, [assemblyScript, binaries, output, version]);
			const manifest: BinaryManifest = JSON.parse(readFileSync(join(output, "binaries.json"), "utf8"));
			expect(manifest.version).toBe(`v${version}`);
			expect(manifest.binaries.map((entry) => entry.platform)).toEqual(targets);
			for (const entry of manifest.binaries) {
				const original = join(binaries, entry.platform, "prime-agent");
				const archive = join(output, entry.file);
				const extracted = join(output, entry.platform);
				mkdirSync(extracted);
				execFileSync("tar", ["-xzf", archive, "-C", extracted]);
				expect(sha256(join(extracted, "prime-agent"))).toBe(sha256(original));
				expect(entry.executableSha256).toBe(sha256(original));
				expect(entry.sha256).toBe(sha256(archive));
				expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toContain(`${entry.sha256}  ${entry.file}\n`);
				expect(JSON.parse(readFileSync(join(extracted, "package.json"), "utf8")).version).toBe(version);
				expect(JSON.parse(readFileSync(join(binaries, entry.platform, "package.json"), "utf8")).version).toBe(
					"0.0.0",
				);
			}
		}
	});

	it("does not emit an archive inventory when the executable cannot be packaged", () => {
		const binaries = join(root, "invalid-binaries");
		binaryAssets(join(binaries, "linux-x64"), Buffer.from("not executable"));
		chmodSync(join(binaries, "linux-x64/prime-agent"), 0o644);
		const output = join(root, "invalid-output");
		const result = spawnSync(process.execPath, [assemblyScript, binaries, output, "1.2.3"], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(existsSync(join(output, "SHA256SUMS"))).toBe(false);
		expect(existsSync(join(output, "binaries.json"))).toBe(false);
	});
});

describe.skipIf(process.platform !== "darwin")("final native macOS validation", () => {
	function validate(binary: Buffer, name: string, changeReference = false) {
		const directory = join(root, name);
		const binaries = join(directory, "binaries");
		binaryAssets(join(binaries, platform), binary);
		const artifacts = join(directory, "artifacts");
		execFileSync(process.execPath, [assemblyScript, binaries, artifacts, "1.2.3"]);
		const reference = join(directory, "reference.json");
		const manifest: BinaryManifest = JSON.parse(readFileSync(join(artifacts, "binaries.json"), "utf8"));
		if (changeReference) manifest.binaries[0]!.executableSha256 = "f".repeat(64);
		writeFileSync(reference, JSON.stringify(manifest));
		const receipt = join(directory, "receipt.json");
		const result = spawnSync(
			process.execPath,
			[join(repository, "scripts/validate-macos-release.mjs"), artifacts, platform, reference, receipt],
			{ encoding: "utf8" },
		);
		return { result, receipt, artifacts };
	}

	it("writes a receipt only after exact packaged executable verification and runtime checks", () => {
		const { result, receipt, artifacts } = validate(readFileSync(fixture), "valid-final");
		expect(result.status, result.stderr).toBe(0);
		const evidence = JSON.parse(readFileSync(receipt, "utf8"));
		expect(evidence).toMatchObject({
			schemaVersion: 1,
			platform,
			version: "v1.2.3",
			executableSha256: sha256(fixture),
		});
		expect(evidence.signature).toContain("Signature=adhoc");
		expect(evidence.manifestSha256).toBe(sha256(join(artifacts, "binaries.json")));
		expect(evidence.inventorySha256).toBe(sha256(join(artifacts, "SHA256SUMS")));
	});

	it("rejects invalid signed pages even with matching archive and executable digests", () => {
		const bytes = readFileSync(fixture);
		bytes[4096] ^= 1;
		const { result, receipt } = validate(bytes, "tampered-final");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/invalid|modified/i);
		expect(existsSync(receipt)).toBe(false);
	});

	it("does not attest an executable different from the tested standalone build", () => {
		const { result, receipt } = validate(readFileSync(fixture), "wrong-reference", true);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("identity differs");
		expect(existsSync(receipt)).toBe(false);
	});
});
