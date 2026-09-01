import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "..", "..");
const packScript = join(repoRoot, "scripts", "pack-prime-agent-release.mjs");
const releaseRoot = join(packageDir, "release");
const temporaryRoots: string[] = [];
const outputDirs: string[] = [];
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

function fixture(): { root: string; binaries: string; sidecars: string; output: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-release-"));
	temporaryRoots.push(root);
	const binaries = join(root, "binaries");
	const sidecars = join(root, "sidecars");
	for (const platform of platforms) {
		const dir = join(binaries, platform);
		mkdirSync(dir, { recursive: true });
		cpSync("/bin/echo", join(dir, "pi"));
		chmodSync(join(dir, "pi"), 0o755);
	}
	mkdirSync(sidecars, { recursive: true });
	for (const name of ["prime-agent-runtime", "skills", "theme", "assets", "export-html", "docs", "examples"]) {
		mkdirSync(join(sidecars, name));
		writeFileSync(join(sidecars, name, ".keep"), "fixture");
	}
	writeFileSync(join(sidecars, "package.json"), JSON.stringify({ name: "prime-agent", version: "1.2.3" }));
	writeFileSync(join(sidecars, "README.md"), "readme");
	writeFileSync(join(sidecars, "CHANGELOG.md"), "changelog");
	writeFileSync(
		join(sidecars, "install.sh"),
		'#!/bin/sh\nbase="__PRIME_AGENT_DOWNLOAD_BASE_URL__"\nchannel="__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"\n',
	);
	writeFileSync(join(sidecars, "photon_rs_bg.wasm"), "wasm");
	const output = join(releaseRoot, `test-${process.pid}-${Math.random().toString(36).slice(2)}`);
	outputDirs.push(output);
	return { root, binaries, sidecars, output };
}

function pack(f: ReturnType<typeof fixture>, extra: string[] = []) {
	return spawnSync(
		process.execPath,
		[
			packScript,
			"--base-url",
			"https://downloads.example.test",
			"--channel",
			"stable",
			"--version",
			"1.2.3",
			"--binary-base-dir",
			f.binaries,
			"--sidecar-dir",
			f.sidecars,
			"--out-dir",
			f.output,
			...extra,
		],
		{ encoding: "utf8" },
	);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const output of outputDirs.splice(0)) rmSync(output, { recursive: true, force: true });
});

describe("compiled release archives", () => {
	test("creates all platform archives with flat required sidecars and rendered installer", () => {
		const f = fixture();
		const result = pack(f);
		expect(result.status, result.stderr).toBe(0);
		const artifacts = join(f.output, "artifacts");
		const archives = readdirSync(artifacts).filter((name) => name.endsWith(".tar.gz"));
		expect(archives.sort()).toEqual(platforms.map((platform) => `prime-agent-1.2.3-${platform}.tar.gz`).sort());
		expect(readFileSync(join(artifacts, "stable"), "utf8")).toBe("v1.2.3\n");
		expect(readFileSync(join(artifacts, "SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(8);
		for (const tarball of [
			"prime-agent-1.2.3.tgz",
			"prime-agent-ai-1.2.3.tgz",
			"prime-agent-core-1.2.3.tgz",
			"prime-agent-tui-1.2.3.tgz",
		]) {
			expect(existsSync(join(artifacts, tarball)), tarball).toBe(true);
		}
		const npmExtracted = join(f.root, "npm-extracted");
		mkdirSync(npmExtracted);
		expect(spawnSync("tar", ["-xzf", join(artifacts, "prime-agent-1.2.3.tgz"), "-C", npmExtracted]).status).toBe(0);
		expect(JSON.parse(readFileSync(join(npmExtracted, "package", "package.json"), "utf8"))).toMatchObject({
			name: "prime-agent",
			version: "1.2.3",
			bin: { "prime-agent": "dist/bundle/cli.js" },
			scripts: { postinstall: "node postinstall.cjs" },
		});

		const extracted = join(f.root, "extracted");
		mkdirSync(extracted);
		const archive = join(artifacts, "prime-agent-1.2.3-darwin-arm64.tar.gz");
		expect(spawnSync("tar", ["-xzf", archive, "-C", extracted]).status).toBe(0);
		expect(readFileSync(join(extracted, "install.sh"), "utf8")).toContain('base="https://downloads.example.test"');
		expect(readFileSync(join(extracted, "install.sh"), "utf8")).toContain('channel="stable"');
		const manifest = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
		expect(manifest).toMatchObject({
			name: "prime-agent",
			version: "1.2.3",
			bin: { "prime-agent": "./prime-agent" },
			packageManager: "bun@1.3.14",
		});
		for (const name of [
			"prime-agent",
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
		]) {
			expect(existsSync(join(extracted, name))).toBe(true);
		}
	});

	test("supports a single-platform local archive", () => {
		const f = fixture();
		const result = pack(f, ["--platform", "linux-x64"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readdirSync(join(f.output, "artifacts")).filter((name) => name.endsWith(".tar.gz"))).toEqual([
			"prime-agent-1.2.3-linux-x64.tar.gz",
		]);
	});

	test("fails closed when a required sidecar is missing", () => {
		const f = fixture();
		rmSync(join(f.sidecars, "theme"), { recursive: true });
		const result = pack(f);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing required sidecars");
	});

	test("rejects dependency directories in release sidecars", () => {
		const f = fixture();
		mkdirSync(join(f.sidecars, "examples", "node_modules"));
		const result = pack(f);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("forbidden dependency or cache directory");
	});
	test("normalizes v-prefixed versions for npm artifact URLs", () => {
		const f = fixture();
		const result = pack(f, ["--version", "v1.2.3"]);
		expect(result.status, result.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(f.output, "artifacts", "latest.json"), "utf8"));
		expect(manifest.tarball).toBe("releases/v1.2.3/prime-agent-1.2.3.tgz");
		expect(existsSync(join(f.output, "artifacts", "prime-agent-1.2.3.tgz"))).toBe(true);
	});

	test("trims release base URLs before writing npm dependency specs", () => {
		const f = fixture();
		const result = pack(f, ["--base-url", "  https://downloads.example.test/  "]);
		expect(result.status, result.stderr).toBe(0);
		const packedManifest = spawnSync(
			"tar",
			["-xOzf", join(f.output, "artifacts", "prime-agent-1.2.3.tgz"), "package/package.json"],
			{ encoding: "utf8" },
		);
		expect(packedManifest.status, packedManifest.stderr).toBe(0);
		expect(JSON.parse(packedManifest.stdout).dependencies["@earendil-works/pi-ai"]).toBe(
			"https://downloads.example.test/releases/v1.2.3/prime-agent-ai-1.2.3.tgz",
		);
	});

	test("rejects insecure release base URLs", () => {
		const f = fixture();
		const result = pack(f, ["--base-url", "http://downloads.example.test"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("must use HTTPS");
	});

	test("rejects shell-active release base URLs", () => {
		const f = fixture();
		const result = pack(f, ["--base-url", "https://downloads.example.test/$(touch-danger)"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unsafe shell characters");
	});

	test("preserves existing artifacts when preflight validation fails", () => {
		const f = fixture();
		const sentinel = join(f.output, "artifacts", "keep.txt");
		mkdirSync(dirname(sentinel), { recursive: true });
		writeFileSync(sentinel, "keep");
		rmSync(join(f.sidecars, "theme"), { recursive: true });
		const result = pack(f);
		expect(result.status).not.toBe(0);
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});

	test("rejects output paths that traverse a symlink", () => {
		const f = fixture();
		const outside = join(f.root, "outside");
		const sentinel = join(outside, "old", "keep.txt");
		mkdirSync(dirname(sentinel), { recursive: true });
		writeFileSync(sentinel, "keep");
		const link = join(releaseRoot, `link-${process.pid}-${Math.random().toString(36).slice(2)}`);
		outputDirs.push(link);
		symlinkSync(outside, link, "dir");
		const result = pack(f, ["--out-dir", join(link, "old")]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("symlinked output path");
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});
});
