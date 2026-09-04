import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** Compare two strings by code-unit order for deterministic sorting. */
function codeUnitCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function bytewiseCompare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sha256FileBoundedForTest(path: string): string {
	const fd = openSync(path, "r");
	try {
		const digest = createHash("sha256");
		const buffer = Buffer.alloc(65536);
		let count = 0;
		do {
			count = readSync(fd, buffer, 0, buffer.byteLength, null);
			if (count > 0) digest.update(buffer.subarray(0, count));
		} while (count > 0);
		return digest.digest("hex");
	} finally {
		closeSync(fd);
	}
}

/** Minimal typed helper to decode an unknown JSON value as a plain object. */
function asRecord(v: unknown): Record<string, unknown> {
	if (typeof v !== "object" || v === null) throw new Error("expected object");
	return v as Record<string, unknown>;
}

/** Decode unknown as a string. */
function asString(v: unknown): string {
	if (typeof v !== "string") throw new Error("expected string");
	return v;
}

/** Decode unknown as a number. */
function asNumber(v: unknown): number {
	if (typeof v !== "number") throw new Error("expected number");
	return v;
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
	if (!Array.isArray(v)) throw new Error("expected array");
	return v.map(asRecord);
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "..", "..");
const packScript = join(repoRoot, "scripts", "pack-prime-agent-release.mjs");
const releaseRoot = join(packageDir, "release");
const temporaryRoots: string[] = [];
const outputDirs: string[] = [];
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

interface FixturePaths {
	root: string;
	binaries: string;
	sidecars: string;
	output: string;
}

function fixture(): FixturePaths {
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
	for (const name of [
		"prime-agent-runtime/pyproject.toml",
		"theme/prime.json",
		"theme/dark.json",
		"theme/light.json",
		"theme/theme-schema.json",
		"export-html/template.html",
		"export-html/template.css",
		"export-html/template.js",
		"export-html/vendor/.keep",
	]) {
		mkdirSync(dirname(join(sidecars, name)), { recursive: true });
		writeFileSync(join(sidecars, name), "fixture");
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

function fullPack(f: FixturePaths, extra: string[] = []) {
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
		const result = fullPack(f);
		expect(result.status, result.stderr).toBe(0);
		const artifacts = join(f.output, "artifacts");
		const archives = readdirSync(artifacts).filter((name) => name.endsWith(".tar.gz"));
		archives.sort(codeUnitCompare);
		const expected = platforms.map((p) => `prime-agent-1.2.3-${p}`).sort(codeUnitCompare);
		expect(archives).toEqual(expected.map((p) => `${p}.tar.gz`));
		expect(readFileSync(join(artifacts, "stable"), "utf8")).toBe("v1.2.3\n");
		expect(readFileSync(join(artifacts, "SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(8);

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
			packageManager: "bun@1.4.0",
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
		const result = fullPack(f, ["--platform", "linux-x64"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readdirSync(join(f.output, "artifacts")).filter((name) => name.endsWith(".tar.gz"))).toEqual([
			"prime-agent-1.2.3-linux-x64.tar.gz",
		]);
	});

	test("fails closed when a required sidecar is missing", () => {
		const f = fixture();
		rmSync(join(f.sidecars, "theme"), { recursive: true });
		const result = fullPack(f);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing required sidecars");
	});

	test("fails closed when a nested required sidecar is missing", () => {
		const f = fixture();
		rmSync(join(f.sidecars, "prime-agent-runtime", "pyproject.toml"));
		const result = fullPack(f);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("prime-agent-runtime/pyproject.toml");
	});

	test("rejects dependency directories in release sidecars", () => {
		const f = fixture();
		mkdirSync(join(f.sidecars, "examples", "node_modules"));
		const result = fullPack(f);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("forbidden dependency or cache directory");
	});
	test("normalizes v-prefixed versions for binary archive metadata", () => {
		const f = fixture();
		const result = fullPack(f, ["--version", "v1.2.3"]);
		expect(result.status, result.stderr).toBe(0);
		const channelManifest = JSON.parse(readFileSync(join(f.output, "artifacts", "latest.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(asString(channelManifest.version)).toBe("v1.2.3");
		expect(asString(channelManifest.package)).toBe("@earendil-works/pi-coding-agent");
		expect(asString(channelManifest.baseUrl)).toBe("https://downloads.example.test/releases/v1.2.3");
		expect(existsSync(join(f.output, "artifacts", "prime-agent-1.2.3-darwin-arm64.tar.gz"))).toBe(true);
	});

	test("trims release base URLs before writing binary metadata", () => {
		const f = fixture();
		const result = fullPack(f, ["--base-url", "  https://downloads.example.test/  "]);
		expect(result.status, result.stderr).toBe(0);
		const channelManifest = JSON.parse(readFileSync(join(f.output, "artifacts", "latest.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(asString(channelManifest.baseUrl)).toBe("https://downloads.example.test/releases/v1.2.3");
	});

	test("rejects insecure release base URLs", () => {
		const f = fixture();
		const result = fullPack(f, ["--base-url", "http://downloads.example.test"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("must use HTTPS");
	});

	test("rejects empty query and fragment delimiters in release base URLs", () => {
		for (const delimiter of ["?", "#"]) {
			const f = fixture();
			const result = fullPack(f, ["--base-url", `https://downloads.example.test/${delimiter}`]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("must not contain a query or fragment");
		}
	});

	test("rejects shell-active release base URLs", () => {
		const f = fixture();
		const result = fullPack(f, ["--base-url", "https://downloads.example.test/$(touch-danger)"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("unsafe shell characters");
	});

	test("preserves existing artifacts when preflight validation fails", () => {
		const f = fixture();
		const sentinel = join(f.output, "artifacts", "keep.txt");
		mkdirSync(dirname(sentinel), { recursive: true });
		writeFileSync(sentinel, "keep");
		rmSync(join(f.sidecars, "theme"), { recursive: true });
		const result = fullPack(f);
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
		const result = fullPack(f, ["--out-dir", join(link, "old")]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("symlinked output path");
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});
});

describe("entry manifest generation", () => {
	function fixture(): FixturePaths {
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
		for (const name of [
			"prime-agent-runtime/pyproject.toml",
			"theme/prime.json",
			"theme/dark.json",
			"theme/light.json",
			"theme/theme-schema.json",
			"export-html/template.html",
			"export-html/template.css",
			"export-html/template.js",
			"export-html/vendor/.keep",
		]) {
			mkdirSync(dirname(join(sidecars, name)), { recursive: true });
			writeFileSync(join(sidecars, name), "fixture");
		}
		writeFileSync(join(sidecars, "package.json"), JSON.stringify({ name: "prime-agent", version: "1.2.3" }));
		writeFileSync(join(sidecars, "README.md"), "readme");
		writeFileSync(join(sidecars, "CHANGELOG.md"), "changelog");
		const installerContent =
			'#!/bin/sh\nbase="__PRIME_AGENT_DOWNLOAD_BASE_URL__"\nchannel="__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"\n';
		writeFileSync(join(sidecars, "install.sh"), installerContent);
		writeFileSync(join(sidecars, "photon_rs_bg.wasm"), "wasm");
		chmodSync(join(sidecars, "install.sh"), 0o755);
		const output = join(releaseRoot, `test-${process.pid}-${Math.random().toString(36).slice(2)}`);
		outputDirs.push(output);
		return { root, binaries, sidecars, output };
	}

	function singlePack(f: FixturePaths, platform = "darwin-arm64", extra: string[] = []) {
		const result = spawnSync(
			process.execPath,
			[
				packScript,
				"--base-url",
				"https://downloads.example.test",
				"--channel",
				"stable",
				"--version",
				"0.0.0",
				"--binary-base-dir",
				f.binaries,
				"--sidecar-dir",
				f.sidecars,
				"--out-dir",
				f.output,
				"--platform",
				platform,
				...extra,
			],
			{ encoding: "utf8" },
		);
		return result;
	}

	function readManifest(f: FixturePaths, version = "0.0.0", platform = "darwin-arm64"): Record<string, unknown> {
		const manifestPath = join(f.output, "artifacts", `prime-agent-${version}-${platform}.manifest.json`);
		return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	}

	test("produces deterministic manifest bytes for identical input", () => {
		const f1 = fixture();
		const r1 = singlePack(f1);
		expect(r1.status, r1.stderr).toBe(0);
		const m1 = readManifest(f1);
		const json1 = JSON.stringify(m1);

		const f2 = fixture();
		const r2 = singlePack(f2);
		expect(r2.status, r2.stderr).toBe(0);
		const m2 = readManifest(f2);
		const json2 = JSON.stringify(m2);

		expect(json1).toBe(json2);
		expect(asNumber(m1.totalFiles)).toBe(asNumber(m2.totalFiles));
		expect(asNumber(m1.totalDirectories)).toBe(asNumber(m2.totalDirectories));
	});

	test("reports correct file modes and SHA-256 digests", () => {
		const f = fixture();
		const extraScript = join(f.sidecars, "prime-agent-runtime", "script.sh");
		writeFileSync(extraScript, "#!/bin/sh\necho hi");
		chmodSync(extraScript, 0o755);
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const manifest = readManifest(f);

		const entries = asRecordArray(manifest.entries);
		const primeAgentEntry = entries.find((e) => e.path === "prime-agent");
		expect(primeAgentEntry).toBeDefined();
		expect(asString(primeAgentEntry!.type)).toBe("file");
		expect(asString(primeAgentEntry!.mode)).toBe("0755");
		expect(asString(primeAgentEntry!.sha256)).toMatch(/^[a-f0-9]{64}$/);

		const keepEntry = entries.find((e) => e.path === "theme/.keep");
		expect(keepEntry).toBeDefined();
		expect(asString(keepEntry!.type)).toBe("file");
		expect(asString(keepEntry!.mode)).toBe("0644");

		const dirEntry = entries.find((e) => e.path === "theme");
		expect(dirEntry).toBeDefined();
		expect(asString(dirEntry!.type)).toBe("directory");
		expect(asString(dirEntry!.mode)).toBe("0755");

		const scriptEntry = entries.find((e) => e.path === "prime-agent-runtime/script.sh");
		expect(scriptEntry).toBeDefined();
		expect(asString(scriptEntry!.type)).toBe("file");
		expect(asString(scriptEntry!.mode)).toBe("0755");

		for (const entry of entries) {
			if (entry.type === "file") {
				expect(asString(entry.sha256!)).toMatch(/^[a-f0-9]{64}$/);
				expect(asNumber(entry.size)).toBeGreaterThan(0);
			} else {
				expect(entry.sha256).toBeUndefined();
				expect(asNumber(entry.size)).toBe(0);
			}
		}
	});

	test("rejects symlinks in staging tree", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-link-reject-"));
		temporaryRoots.push(root);
		const binaries = join(root, "binaries");
		const sidecars = join(root, "sidecars");
		const linkOutput = join(releaseRoot, `link-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
		outputDirs.push(linkOutput);
		mkdirSync(join(binaries, "darwin-arm64"), { recursive: true });
		cpSync("/bin/echo", join(binaries, "darwin-arm64", "pi"));
		chmodSync(join(binaries, "darwin-arm64", "pi"), 0o755);
		mkdirSync(sidecars, { recursive: true });
		writeFileSync(join(sidecars, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
		writeFileSync(join(sidecars, "README.md"), "r");
		writeFileSync(join(sidecars, "CHANGELOG.md"), "c");
		writeFileSync(join(sidecars, "install.sh"), "#!/bin/sh");
		chmodSync(join(sidecars, "install.sh"), 0o755);
		writeFileSync(join(sidecars, "photon_rs_bg.wasm"), "w");
		mkdirSync(join(sidecars, "prime-agent-runtime"));
		writeFileSync(join(sidecars, "prime-agent-runtime", "pyproject.toml"), "x");
		mkdirSync(join(sidecars, "skills"));
		mkdirSync(join(sidecars, "theme"));
		writeFileSync(join(sidecars, "theme", "prime.json"), "x");
		writeFileSync(join(sidecars, "theme", "dark.json"), "x");
		writeFileSync(join(sidecars, "theme", "light.json"), "x");
		writeFileSync(join(sidecars, "theme", "theme-schema.json"), "x");
		mkdirSync(join(sidecars, "assets"));
		mkdirSync(join(sidecars, "export-html"));
		writeFileSync(join(sidecars, "export-html", "template.html"), "x");
		writeFileSync(join(sidecars, "export-html", "template.css"), "x");
		writeFileSync(join(sidecars, "export-html", "template.js"), "x");
		mkdirSync(join(sidecars, "export-html", "vendor"));
		writeFileSync(join(sidecars, "export-html", "vendor", ".keep"), "x");
		mkdirSync(join(sidecars, "docs"));
		mkdirSync(join(sidecars, "examples"));
		symlinkSync("/etc/passwd", join(sidecars, "prime-agent-runtime", "malicious-link"), "file");

		const result = spawnSync(
			process.execPath,
			[
				packScript,
				"--base-url",
				"https://downloads.example.test",
				"--channel",
				"stable",
				"--version",
				"0.0.0",
				"--binary-base-dir",
				binaries,
				"--sidecar-dir",
				sidecars,
				"--out-dir",
				linkOutput,
				"--platform",
				"darwin-arm64",
			],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("symlink");
	});

	test("rejects directory symlinks in staging tree", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-dirlink-"));
		temporaryRoots.push(root);
		const binaries = join(root, "binaries");
		const sidecars = join(root, "sidecars");
		const linkOutput = join(releaseRoot, `dirlink-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
		outputDirs.push(linkOutput);
		mkdirSync(join(binaries, "darwin-arm64"), { recursive: true });
		cpSync("/bin/echo", join(binaries, "darwin-arm64", "pi"));
		chmodSync(join(binaries, "darwin-arm64", "pi"), 0o755);
		mkdirSync(sidecars, { recursive: true });
		writeFileSync(join(sidecars, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
		writeFileSync(join(sidecars, "README.md"), "r");
		writeFileSync(join(sidecars, "CHANGELOG.md"), "c");
		writeFileSync(join(sidecars, "install.sh"), "#!/bin/sh");
		chmodSync(join(sidecars, "install.sh"), 0o755);
		writeFileSync(join(sidecars, "photon_rs_bg.wasm"), "w");
		mkdirSync(join(sidecars, "prime-agent-runtime"));
		writeFileSync(join(sidecars, "prime-agent-runtime", "pyproject.toml"), "x");
		mkdirSync(join(sidecars, "skills"));
		mkdirSync(join(sidecars, "theme"));
		writeFileSync(join(sidecars, "theme", "prime.json"), "x");
		writeFileSync(join(sidecars, "theme", "dark.json"), "x");
		writeFileSync(join(sidecars, "theme", "light.json"), "x");
		writeFileSync(join(sidecars, "theme", "theme-schema.json"), "x");
		mkdirSync(join(sidecars, "assets"));
		mkdirSync(join(sidecars, "export-html"));
		writeFileSync(join(sidecars, "export-html", "template.html"), "x");
		writeFileSync(join(sidecars, "export-html", "template.css"), "x");
		writeFileSync(join(sidecars, "export-html", "template.js"), "x");
		mkdirSync(join(sidecars, "export-html", "vendor"));
		writeFileSync(join(sidecars, "export-html", "vendor", ".keep"), "x");
		mkdirSync(join(sidecars, "docs"));
		mkdirSync(join(sidecars, "examples"));
		symlinkSync("/tmp", join(sidecars, "prime-agent-runtime", "malicious-dir-link"), "dir");

		const result = spawnSync(
			process.execPath,
			[
				packScript,
				"--base-url",
				"https://downloads.example.test",
				"--channel",
				"stable",
				"--version",
				"0.0.0",
				"--binary-base-dir",
				binaries,
				"--sidecar-dir",
				sidecars,
				"--out-dir",
				linkOutput,
				"--platform",
				"darwin-arm64",
			],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("symlink");
	});

	test("SHA256SUMS matches actual file digests", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);

		const artifactsDir = join(f.output, "artifacts");
		const sums = readFileSync(join(artifactsDir, "SHA256SUMS"), "utf8");
		const lines = sums.trim().split("\n").filter(Boolean);

		expect(lines).toHaveLength(2);

		for (const line of lines) {
			const [expectedSha, filename] = line.split(/\s+/);
			expect(expectedSha).toMatch(/^[a-f0-9]{64}$/);
			expect(filename).toMatch(/^prime-agent-0\.0\.0/);

			const filePath = join(artifactsDir, filename);
			const actualSha = sha256FileBoundedForTest(filePath);
			expect(actualSha, `SHA256 mismatch for ${filename}`).toBe(expectedSha);
		}

		expect(lines.some((l: string) => l.endsWith(".tar.gz"))).toBe(true);
		expect(lines.some((l: string) => l.endsWith(".manifest.json"))).toBe(true);
	});

	test("records archive byteSize, sha256, manifest metadata in latest.json", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);

		const latestRaw = readFileSync(join(f.output, "artifacts", "latest.json"), "utf8");
		const latest = asRecord(JSON.parse(latestRaw));

		expect(asString(latest.version)).toBe("v0.0.0");
		const platformList = asRecordArray(latest.platforms);
		expect(platformList).toHaveLength(1);
		const platform = platformList[0];
		expect(asString(platform.platform)).toBe("darwin-arm64");
		expect(asString(platform.file)).toMatch(/\.tar\.gz$/);
		expect(asString(platform.sha256)).toMatch(/^[a-f0-9]{64}$/);
		expect(typeof asNumber(platform.byteSize)).toBe("number");
		expect(asNumber(platform.byteSize)).toBeGreaterThan(0);
		expect(asNumber(platform.decompressedTarBytes)).toBeGreaterThan(0);
		expect(asNumber(platform.decompressedTarBytes) % 512).toBe(0);
		expect(asString(platform.manifestFile)).toMatch(/\.manifest\.json$/);
		expect(asString(platform.manifestSha256)).toMatch(/^[a-f0-9]{64}$/);
		expect(typeof asNumber(platform.manifestByteSize)).toBe("number");
		expect(asNumber(platform.manifestByteSize)).toBeGreaterThan(0);
		const artifacts = join(f.output, "artifacts");
		const archivePath = join(artifacts, asString(platform.file));
		const manifestPath = join(artifacts, asString(platform.manifestFile));
		expect(asNumber(platform.byteSize)).toBe(statSync(archivePath).size);
		expect(asString(platform.sha256)).toBe(sha256FileBoundedForTest(archivePath));
		expect(asNumber(platform.manifestByteSize)).toBe(statSync(manifestPath).size);
		expect(asString(platform.manifestSha256)).toBe(sha256FileBoundedForTest(manifestPath));
	});

	test("produces correct v1 manifest schema with deterministic sort", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const manifest = readManifest(f);

		expect(asNumber(manifest.manifestVersion)).toBe(1);
		expect(asString(manifest.version)).toBe("0.0.0");
		expect(asString(manifest.platform)).toBe("darwin-arm64");
		expect(asString(manifest.archive)).toMatch(/^prime-agent-0\.0\.0-darwin-arm64\.tar\.gz$/);

		const entries = asRecordArray(manifest.entries);
		const fileEntries = entries.filter((e) => e.type === "file");
		const dirEntries = entries.filter((e) => e.type === "directory");
		expect(asNumber(manifest.totalFiles)).toBe(fileEntries.length);
		expect(asNumber(manifest.totalDirectories)).toBe(dirEntries.length);

		const computedSize = fileEntries.reduce((sum, e) => sum + asNumber(e.size), 0);
		expect(asNumber(manifest.totalSize)).toBe(computedSize);

		expect(asString(entries[0].path)).toBe(".");
		expect(asString(entries[0].type)).toBe("directory");

		const paths = entries.map((e) => asString(e.path));
		const sorted = [...paths].sort(codeUnitCompare);
		expect(paths).toEqual(sorted);

		for (const entry of entries) {
			expect(entry).toHaveProperty("path");
			expect(entry).toHaveProperty("type");
			expect(entry).toHaveProperty("mode");
			expect(entry).toHaveProperty("size");
			expect(["file", "directory"]).toContain(asString(entry.type));
			expect(asString(entry.mode)).toMatch(/^0\d{3}$/);
		}
	});

	test("manifest matches actual archive contents by extraction", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const manifest = readManifest(f);
		const manifestEntries = asRecordArray(manifest.entries);

		const archivePath = join(f.output, "artifacts", "prime-agent-0.0.0-darwin-arm64.tar.gz");
		const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
		expect(listing.status, listing.stderr).toBe(0);
		const listedPaths = listing.stdout
			.trim()
			.split("\n")
			.map((path) => {
				const withoutPrefix = path.startsWith("./") ? path.slice(2) : path;
				const withoutDirectorySlash = withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
				return withoutDirectorySlash === "" ? "." : withoutDirectorySlash;
			});
		const manifestPaths = manifestEntries.map((entry) => asString(entry.path));
		expect(listedPaths).toHaveLength(manifestPaths.length);
		expect(new Set(listedPaths).size).toBe(listedPaths.length);
		expect([...listedPaths].sort(bytewiseCompare)).toEqual(manifestPaths);

		// Extract archive to a temp directory
		const extractDir = mkdtempSync(join(tmpdir(), "prime-agent-extract-"));
		try {
			const extractResult = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { encoding: "utf8" });
			expect(extractResult.status, extractResult.stderr).toBe(0);

			// Walk extracted tree and build a lookup
			const diskEntries = new Map<string, { type: string; mode: string; size: number; sha256: string }>();

			function walkExtracted(dir: string, relativePath: string) {
				const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => codeUnitCompare(a.name, b.name));
				for (const entry of entries) {
					const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
					const fullPath = join(dir, entry.name);
					const st = lstatSync(fullPath);
					if (st.isDirectory()) {
						diskEntries.set(childRelative, { type: "directory", mode: "0755", size: 0, sha256: "" });
						walkExtracted(fullPath, childRelative);
					} else if (st.isFile()) {
						const isExecutable = (st.mode & 0o111) !== 0;
						const perm = isExecutable ? "0755" : "0644";
						diskEntries.set(childRelative, {
							type: "file",
							mode: perm,
							size: st.size,
							sha256: sha256FileBoundedForTest(fullPath),
						});
					}
				}
			}
			walkExtracted(extractDir, "");
			diskEntries.set(".", { type: "directory", mode: "0755", size: 0, sha256: "" });

			// Every manifest entry must exist on disk (including root)
			for (const me of manifestEntries) {
				const mp = asString(me.path);
				const diskEntry = diskEntries.get(mp);
				expect(diskEntry, `manifest path ${mp} not found in extracted archive`).toBeDefined();
				expect(diskEntry!.type, `type mismatch for ${mp}`).toBe(asString(me.type));
				expect(diskEntry!.mode, `mode mismatch for ${mp}`).toBe(asString(me.mode));
				if (asString(me.type) === "file") {
					expect(diskEntry!.size, `size mismatch for ${mp}`).toBe(asNumber(me.size));
					expect(diskEntry!.sha256, `sha256 mismatch for ${mp}`).toBe(asString(me.sha256));
				}
			}

			// No extra entries on disk that are not in the manifest
			expect(diskEntries.size, "extracted entries count must match manifest").toBe(manifestEntries.length);
		} finally {
			rmSync(extractDir, { recursive: true, force: true });
		}
	});

	test("archives use the exact ustar magic and version required by the runtime verifier", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const archivePath = join(f.output, "artifacts", "prime-agent-0.0.0-darwin-arm64.tar.gz");
		const tarBytes = gunzipSync(readFileSync(archivePath));
		expect(tarBytes.subarray(257, 263)).toEqual(Buffer.from("ustar\0", "binary"));
		expect(tarBytes.subarray(263, 265)).toEqual(Buffer.from("00", "ascii"));
	});

	test("decompressedTarBytes matches gzip ISIZE read from last four bytes", () => {
		const f = fixture();
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const manifest = readManifest(f);

		const archivePath = join(f.output, "artifacts", "prime-agent-0.0.0-darwin-arm64.tar.gz");
		const st = statSync(archivePath);
		expect(st.size).toBeGreaterThanOrEqual(18);
		const fd = openSync(archivePath, "r");
		const buf = Buffer.alloc(4);
		readSync(fd, buf, 0, 4, st.size - 4);
		closeSync(fd);
		const isize = buf.readUInt32LE(0);
		expect(isize).toBeGreaterThan(0);
		expect(isize).toBeLessThanOrEqual(256 * 1024 * 1024);
		expect(isize % 512).toBe(0);
		expect(asNumber(manifest.decompressedTarBytes)).toBe(isize);
	});

	test("R2 publication validates complete archive-manifest pairs before uploading", () => {
		const workflow = readFileSync(join(repoRoot, ".github", "workflows", "build-binaries.yml"), "utf8");
		for (const [startMarker, endMarker] of [
			["- name: Publish production channel to R2", "- name: Create production GitHub release"],
			["- name: Publish immutable beta artifacts to R2", "- name: Advance beta release"],
		]) {
			const start = workflow.indexOf(startMarker);
			const end = workflow.indexOf(endMarker, start);
			expect(start).toBeGreaterThanOrEqual(0);
			expect(end).toBeGreaterThan(start);
			const block = workflow.slice(start, end);
			expect(block).toMatch(/\$\{artifact%\.tar\.gz\}\.manifest\.json/);
			expect(block).toMatch(/\$\{manifest%\.manifest\.json\}\.tar\.gz/);
			const countGate = block.indexOf('archive_count" -ne "$manifest_count');
			const firstUpload = block.indexOf("aws s3 cp");
			expect(countGate).toBeGreaterThanOrEqual(0);
			expect(firstUpload).toBeGreaterThan(countGate);
		}
	});

	test("deterministic sort uses UTF-8 byte order", () => {
		const f = fixture();
		writeFileSync(join(f.sidecars, "docs", "\u{e000}"), "bmp");
		writeFileSync(join(f.sidecars, "docs", "\u{10000}"), "astral");
		const result = singlePack(f);
		expect(result.status, result.stderr).toBe(0);
		const manifest = readManifest(f);
		const paths = asRecordArray(manifest.entries).map((entry) => asString(entry.path));
		for (let index = 0; index < paths.length - 1; index++) {
			expect(bytewiseCompare(paths[index], paths[index + 1])).toBeLessThan(0);
		}
		expect(paths.indexOf("docs/\u{e000}")).toBeLessThan(paths.indexOf("docs/\u{10000}"));
	});
});
