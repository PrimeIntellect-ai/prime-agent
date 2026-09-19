import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repository = resolve(__dirname, "../../..");
const packerPath = join(repository, "scripts/pack-npm-packages.mjs");
const packerUrl = pathToFileURL(packerPath).href;
const dependenciesUrl = pathToFileURL(join(repository, "scripts/lib/internal-dependencies.mjs")).href;
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const version = "1.2.3";

let packer: any;
let dependencies: any;
let root: string;
let binaryDir: string;
let packagesDir: string;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Minimal stand-in for a compiled standalone build: executable plus every required sibling asset. */
function writeBinaryFixture(directory: string, platform: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "prime-agent"), `#!/bin/sh\necho "fixture ${platform} $*"\nexit 7\n`, { mode: 0o755 });
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
	for (const name of ["skills", "assets", "docs", "examples"]) mkdirSync(join(directory, name), { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.0.0" })}\n`);
}

/** Workspace stand-in: the real manifests plus a built dist, so no repository build is required. */
function writePackagesFixture(directory: string): void {
	for (const name of ["ai", "agent", "tui", "coding-agent"]) {
		const target = join(directory, name);
		mkdirSync(join(target, "dist"), { recursive: true });
		cpSync(join(repository, "packages", name, "package.json"), join(target, "package.json"));
		writeFileSync(join(target, "dist", "index.js"), "export const fixture = true;\n");
		writeFileSync(join(target, "README.md"), `# ${name}\n`);
	}
}

function pack(args: string[]) {
	return spawnSync(process.execPath, [packerPath, ...args], { encoding: "utf8" });
}

function stage(extra: string[] = []) {
	const outDir = mkdtempSync(join(root, "out-"));
	rmSync(outDir, { recursive: true, force: true });
	const result = pack([
		"--binary-dir",
		binaryDir,
		"--packages-dir",
		packagesDir,
		"--version",
		version,
		"--out-dir",
		outDir,
		"--skip-pack",
		...extra,
	]);
	return { outDir, result };
}

function plan() {
	const sourcePackages = new Map(
		["ai", "agent", "tui", "coding-agent"].map((name) => [name, readJson(join(packagesDir, name, "package.json"))]),
	);
	const binaries = platforms.map((platform) => ({
		platform,
		executableSha256: sha256(join(binaryDir, platform, "prime-agent")),
		file: `prime-agent-${version}-${platform}.tar.gz`,
		sha256: "b".repeat(64),
	}));
	return packer.buildPackagePlan({
		version,
		scope: "@primeintellect",
		frontDoor: "prime-agent",
		sourcePackages,
		binaries,
	});
}

beforeAll(async () => {
	packer = await import(/* @vite-ignore */ packerUrl);
	dependencies = await import(/* @vite-ignore */ dependenciesUrl);
	root = mkdtempSync(join(tmpdir(), "prime-npm-packages-"));
	binaryDir = join(root, "binaries");
	packagesDir = join(root, "packages");
	for (const platform of platforms) writeBinaryFixture(join(binaryDir, platform), platform);
	writePackagesFixture(packagesDir);
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("npm package plan", () => {
	it("publishes the documented names in dependency order", () => {
		expect(plan().map((entry: any) => entry.name)).toEqual([
			"@primeintellect/prime-agent-darwin-arm64",
			"@primeintellect/prime-agent-darwin-x64",
			"@primeintellect/prime-agent-linux-arm64",
			"@primeintellect/prime-agent-linux-x64",
			"@primeintellect/prime-agent-ai",
			"@primeintellect/prime-agent-core",
			"@primeintellect/prime-agent-tui",
			"prime-agent",
			"@primeintellect/prime-agent",
		]);
	});

	it("gives every package the release version and public provenance publish config", () => {
		for (const entry of plan()) {
			expect(entry.packageJson.version).toBe(version);
			expect(entry.packageJson.publishConfig).toEqual({
				access: "public",
				registry: "https://registry.npmjs.org",
				provenance: true,
			});
			expect(entry.packageJson.scripts).toBeUndefined();
			expect(entry.packageJson.repository.url).toContain("PrimeIntellect-ai/prime-agent");
		}
	});

	it("gates each platform package on os and cpu and carries the executable receipt", () => {
		const expected: Record<string, { os: string; cpu: string }> = {
			"darwin-arm64": { os: "darwin", cpu: "arm64" },
			"darwin-x64": { os: "darwin", cpu: "x64" },
			"linux-arm64": { os: "linux", cpu: "arm64" },
			"linux-x64": { os: "linux", cpu: "x64" },
		};
		for (const entry of plan().filter((candidate: any) => candidate.kind === "platform")) {
			const { os, cpu } = expected[entry.platform];
			expect(entry.packageJson.os).toEqual([os]);
			expect(entry.packageJson.cpu).toEqual([cpu]);
			expect(entry.packageJson.preferUnplugged).toBe(true);
			expect(entry.packageJson.primeAgent.executableSha256).toBe(
				sha256(join(binaryDir, entry.platform, "prime-agent")),
			);
			expect(entry.packageJson.primeAgent.archive.file).toBe(`prime-agent-${version}-${entry.platform}.tar.gz`);
			expect(entry.packageJson.dependencies).toBeUndefined();
		}
	});

	it("pins the front door to the exact platform package versions and ships only the shim", () => {
		for (const entry of plan().filter((candidate: any) => candidate.kind === "front-door")) {
			expect(entry.packageJson.optionalDependencies).toEqual({
				"@primeintellect/prime-agent-darwin-arm64": version,
				"@primeintellect/prime-agent-darwin-x64": version,
				"@primeintellect/prime-agent-linux-arm64": version,
				"@primeintellect/prime-agent-linux-x64": version,
			});
			expect(entry.packageJson.bin).toEqual({ "prime-agent": "bin/prime-agent.cjs" });
			expect(entry.packageJson.dependencies).toBeUndefined();
			expect(Object.keys(entry.packageJson.primeAgent.platforms).sort()).toEqual(platforms);
		}
	});

	it("keeps the scoped mirror identical to the canonical front door apart from its name", () => {
		const entries = plan().filter((candidate: any) => candidate.kind === "front-door");
		expect({ ...entries[0].packageJson, name: undefined }).toEqual({ ...entries[1].packageJson, name: undefined });
		expect(entries.map((entry: any) => entry.packageJson.name)).toEqual([
			"prime-agent",
			"@primeintellect/prime-agent",
		]);
	});

	it("rewrites internal library dependencies to semver ranges, never tarball URLs", () => {
		const core = plan().find((entry: any) => entry.name === "@primeintellect/prime-agent-core");
		expect(core.packageJson.dependencies["@earendil-works/pi-ai"]).toBe(
			`npm:@primeintellect/prime-agent-ai@^${version}`,
		);
		expect(core.packageJson.dependencies.typebox).toBe("^1.3.9");
		expect(core.packageJson.bin).toBeUndefined();
		for (const entry of plan()) {
			for (const field of ["dependencies", "optionalDependencies"]) {
				for (const spec of Object.values(entry.packageJson[field] || {}) as string[]) {
					expect(spec).not.toMatch(/^https?:/);
					expect(spec).not.toMatch(/\.tgz$/);
				}
			}
		}
	});
});

describe("argument hygiene", () => {
	it.each([
		["--scope", "@x/../../.."],
		["--scope", "@Scope"],
		["--scope", "@x/y"],
		["--scope", "primeintellect"],
		["--front-door", "../.."],
		["--front-door", "@primeintellect/prime-agent"],
		["--front-door", "prime.agent"],
		["--front-door", "Prime-Agent"],
	])("refuses a %s of %s before writing anything", (flag, value) => {
		const { outDir, result } = stage([flag, value]);
		expect(result.status, result.stderr).not.toBe(0);
		expect(result.stderr).toContain(flag);
		expect(existsSync(outDir)).toBe(false);
		// Nothing may have escaped above the output directory either.
		expect(existsSync(join(dirname(outDir), "bin"))).toBe(false);
		expect(existsSync(join(dirname(outDir), "package.json"))).toBe(false);
	});

	it("removes the archive extraction directory even when staging fails", () => {
		const archives = mkdtempSync(join(root, "archives-"));
		for (const platform of platforms) {
			const dir = join(root, "arch-src", platform);
			writeBinaryFixture(dir, platform);
			spawnSync("tar", ["-czf", join(archives, `prime-agent-${version}-${platform}.tar.gz`), "-C", dir, "."]);
		}
		const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("prime-agent-npm-binaries-")));
		const outDir = join(root, "out-fail");
		// An invalid front door makes staging fail after extraction would have happened; extraction
		// runs first only when the arguments parse, so use a receipts mismatch to fail late instead.
		const receipts = join(root, "bad-receipts.json");
		writeFileSync(
			receipts,
			JSON.stringify({
				version,
				binaries: platforms.map((platform) => ({
					platform,
					file: `prime-agent-${version}-${platform}.tar.gz`,
					sha256: "0".repeat(64),
					executableSha256: "0".repeat(64),
				})),
			}),
		);
		const result = pack([
			"--archives",
			archives,
			"--receipts",
			receipts,
			"--packages-dir",
			packagesDir,
			"--version",
			version,
			"--out-dir",
			outDir,
			"--skip-pack",
		]);
		expect(result.status).not.toBe(0);
		const after = readdirSync(tmpdir()).filter(
			(name) => name.startsWith("prime-agent-npm-binaries-") && !before.has(name),
		);
		expect(after).toEqual([]);
	});
});

describe("registry dependency guard", () => {
	const accepted = [
		"1.2.3",
		"^1.2.3",
		"~1.2.3",
		"=1.2.3",
		">=1 <2",
		">=1.2.3-beta.1 <2",
		"^1.2.3-rc.1 || ^2.0.0",
		"npm:@primeintellect/prime-agent-ai@^1.2.3",
		"npm:chalk@5.5.0",
		"npm:@scope/name@>=1 <2",
	];
	const rejected: Array<[string, unknown]> = [
		["ssh git shorthand", "git@github.com:attacker/pkg.git"],
		["GitHub shorthand", "attacker/pkg#main"],
		["github: prefix", "github:attacker/pkg"],
		["git+https URL", "git+https://github.com/attacker/pkg.git"],
		["https tarball URL", "https://pub.example.dev/releases/v1.2.3/prime-agent-ai-1.2.3.tgz"],
		["http URL", "http://pub.example.dev/prime-agent-ai-1.2.3.tgz"],
		["tarball without a scheme", "pub.example.dev/prime-agent-ai-1.2.3.tgz"],
		["file: spec", "file:../prime-agent-ai"],
		["link: spec", "link:../prime-agent-ai"],
		["workspace: spec", "workspace:*"],
		["workspace caret", "workspace:^"],
		["portal: spec", "portal:../prime-agent-ai"],
		["latest dist-tag", "latest"],
		["arbitrary dist-tag", "next"],
		["bare wildcard", "*"],
		["x-range", "1.x"],
		["bare major", "1"],
		["hyphen range", "1.2.3 - 2.0.0"],
		["build metadata", "1.2.3+build.1"],
		["empty string", ""],
		["surrounding whitespace", " ^1.2.3"],
		["alias without a range", "npm:chalk"],
		["alias with an empty range", "npm:chalk@"],
		["alias onto a dist-tag", "npm:chalk@latest"],
		["alias onto a wildcard", "npm:chalk@*"],
		["alias onto a git URL", "npm:chalk@git+https://github.com/attacker/pkg.git"],
		["alias with an uppercase name", "npm:Chalk@^5.0.0"],
		["alias with a path-traversal name", "npm:../evil@1.0.0"],
		["alias with a scoped path-traversal name", "npm:@scope/..@1.0.0"],
		["alias with a bare scope", "npm:@scope@1.0.0"],
		["non-string spec", 123],
		["object spec", { version: "^1.2.3" }],
	];

	it.each(accepted)("accepts the plain range or alias %s", (spec) => {
		expect(dependencies.isRegistryDependencySpec(spec)).toBe(true);
		expect(() =>
			dependencies.assertRegistryDependencies({ name: "prime-agent", dependencies: { dep: spec } }),
		).not.toThrow();
	});

	it.each(rejected)("rejects %s", (_label, spec) => {
		expect(dependencies.isRegistryDependencySpec(spec)).toBe(false);
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			expect(() => dependencies.assertRegistryDependencies({ name: "prime-agent", [field]: { dep: spec } })).toThrow(
				/must be a plain semver range or npm:<name>@<range> alias/,
			);
		}
	});

	it("rejects dependency maps that are not objects and keys that are not package names", () => {
		expect(() => dependencies.assertRegistryDependencies({ name: "prime-agent", dependencies: ["^1.2.3"] })).toThrow(
			/must be an object/,
		);
		expect(() =>
			dependencies.assertRegistryDependencies({ name: "prime-agent", dependencies: { "../evil": "^1.2.3" } }),
		).toThrow(/invalid package name/);
		expect(() =>
			dependencies.assertRegistryDependencies({ name: "prime-agent", dependencies: { Chalk: "^1.2.3" } }),
		).toThrow(/invalid package name/);
	});

	it("keeps the real workspace manifests inside the allowlist", () => {
		for (const entry of plan())
			expect(() => dependencies.assertRegistryDependencies(entry.packageJson)).not.toThrow();
	});

	it("still produces R2 tarball URLs for the installer channel", () => {
		const url = dependencies.tarballDependencySpec("https://pub.example.dev", "1.2.3", "prime-agent-ai-1.2.3.tgz");
		expect(url).toBe("https://pub.example.dev/releases/v1.2.3/prime-agent-ai-1.2.3.tgz");
		expect(
			dependencies.rewriteInternalDependencies(
				{ "@earendil-works/pi-ai": "^1.2.3", chalk: "^5.5.0" },
				new Map([["@earendil-works/pi-ai", url]]),
			),
		).toEqual({ "@earendil-works/pi-ai": url, chalk: "^5.5.0" });
	});
});

// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
describe.skipIf(process.platform === "win32")("staged output", () => {
	it("writes one directory per package plus a manifest describing the publish order", () => {
		const { outDir, result } = stage();
		expect(result.status, result.stderr).toBe(0);
		const manifest = readJson(join(outDir, "manifest.json"));
		expect(manifest.version).toBe(version);
		expect(manifest.publishOrder).toEqual(plan().map((entry: any) => entry.name));
		for (const entry of manifest.packages)
			expect(existsSync(join(outDir, entry.directory, "package.json"))).toBe(true);
		expect(existsSync(join(outDir, "prime-agent/bin/prime-agent.cjs"))).toBe(true);
		expect(existsSync(join(outDir, "prime-agent/LICENSE"))).toBe(true);
		expect(existsSync(join(outDir, "@primeintellect/prime-agent-ai/dist/index.js"))).toBe(true);
	});

	it("carries the executable receipt into every platform package", () => {
		const { outDir, result } = stage();
		expect(result.status, result.stderr).toBe(0);
		for (const platform of platforms) {
			const packageDir = join(outDir, "@primeintellect", `prime-agent-${platform}`);
			const receipt = readJson(join(packageDir, "receipts.json"));
			const staged = join(packageDir, "bin/prime-agent");
			expect(receipt.executableSha256).toBe(sha256(join(binaryDir, platform, "prime-agent")));
			expect(receipt.executableSha256).toBe(sha256(staged));
			expect(receipt.platform).toBe(platform);
			expect(readJson(join(packageDir, "package.json")).primeAgent.executableSha256).toBe(receipt.executableSha256);
			expect(readJson(join(packageDir, "bin/package.json")).version).toBe(version);
			expect(existsSync(join(packageDir, "bin/prime-agent-runtime/pyproject.toml"))).toBe(true);
		}
	});

	it("refuses to pack when an R2 receipt disagrees with the compiled binary", () => {
		const receipts = join(root, "binaries.json");
		writeFileSync(
			receipts,
			JSON.stringify({
				version: `v${version}`,
				binaries: platforms.map((platform) => ({
					platform,
					file: `prime-agent-${version}-${platform}.tar.gz`,
					sha256: "c".repeat(64),
					executableSha256:
						platform === "linux-x64" ? "d".repeat(64) : sha256(join(binaryDir, platform, "prime-agent")),
				})),
			}),
		);
		const { result } = stage(["--receipts", receipts]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Receipt mismatch for linux-x64");
	});

	it("refuses to delete an output directory it did not create", () => {
		const outDir = mkdtempSync(join(root, "occupied-"));
		writeFileSync(join(outDir, "important.txt"), "keep me");
		const result = pack([
			"--binary-dir",
			binaryDir,
			"--packages-dir",
			packagesDir,
			"--out-dir",
			outDir,
			"--skip-pack",
		]);
		expect(result.status).not.toBe(0);
		expect(existsSync(join(outDir, "important.txt"))).toBe(true);
	});
});

// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
describe.skipIf(process.platform === "win32")("receipt cross-check", () => {
	type Receipt = { platform: string; file: string; sha256: string; executableSha256: string };

	function validReceipts(): Receipt[] {
		return platforms.map((platform) => ({
			platform,
			file: `prime-agent-${version}-${platform}.tar.gz`,
			sha256: "c".repeat(64),
			executableSha256: sha256(join(binaryDir, platform, "prime-agent")),
		}));
	}

	function writeReceipts(binaries: unknown, extra: Record<string, unknown> = {}): string {
		const file = join(mkdtempSync(join(root, "receipts-")), "latest.json");
		writeFileSync(file, JSON.stringify({ version: `v${version}`, binaries, ...extra }));
		return file;
	}

	it("accepts exactly one well-formed receipt per platform and carries it into the packages", () => {
		const receipts = writeReceipts(validReceipts());
		const { outDir, result } = stage(["--receipts", receipts]);
		expect(result.status, result.stderr).toBe(0);
		for (const platform of platforms) {
			const receipt = readJson(join(outDir, "@primeintellect", `prime-agent-${platform}`, "receipts.json"));
			expect(receipt.archive).toEqual({ file: `prime-agent-${version}-${platform}.tar.gz`, sha256: "c".repeat(64) });
		}
	});

	it("refuses a receipts file that lacks a platform instead of skipping its digest check", () => {
		const receipts = writeReceipts(validReceipts().filter((receipt) => receipt.platform !== "linux-arm64"));
		const { result } = stage(["--receipts", receipts]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("has no receipt for: linux-arm64");
		expect(() => packer.readReceipts(receipts, version)).toThrow(/has no receipt for: linux-arm64/);
	});

	it("refuses a receipts file with two receipts for one platform", () => {
		const valid = validReceipts();
		const receipts = writeReceipts([...valid, { ...valid[0] }]);
		const { result } = stage(["--receipts", receipts]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("more than one receipt for darwin-arm64");
	});

	it("refuses a receipt for a platform this packer does not publish", () => {
		const receipts = writeReceipts([
			...validReceipts(),
			{
				platform: "win32-x64",
				file: `prime-agent-${version}-win32-x64.tar.gz`,
				sha256: "c".repeat(64),
				executableSha256: "d".repeat(64),
			},
		]);
		const { result } = stage(["--receipts", receipts]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('unsupported platform "win32-x64"');
	});

	it.each([
		["executableSha256 that is too short", { executableSha256: "abc" }],
		["executableSha256 with uppercase hex", { executableSha256: "A".repeat(64) }],
		["executableSha256 that is missing", { executableSha256: undefined }],
		["sha256 that is not hex", { sha256: "z".repeat(64) }],
		["sha256 that is a number", { sha256: 1 }],
		["sha256 that is missing", { sha256: undefined }],
	])("refuses a receipt with an %s", (_label, patch) => {
		const valid = validReceipts();
		valid[2] = { ...valid[2], ...(patch as Partial<Receipt>) };
		const receipts = writeReceipts(valid);
		const { result } = stage(["--receipts", receipts]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Receipt for linux-arm64");
		expect(result.stderr).toContain("malformed");
	});

	it("refuses a receipt whose archive name does not belong to this release", () => {
		const valid = validReceipts();
		valid[3] = { ...valid[3], file: `prime-agent-9.9.9-linux-x64.tar.gz` };
		const { result } = stage(["--receipts", writeReceipts(valid)]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			`names "prime-agent-9.9.9-linux-x64.tar.gz", not prime-agent-${version}-linux-x64.tar.gz`,
		);
	});

	it("refuses a receipts file for another version or without a binaries array", () => {
		const other = writeReceipts(validReceipts(), { version: "v9.9.9" });
		expect(stage(["--receipts", other]).result.stderr).toContain("is for v9.9.9, not v1.2.3");
		const empty = writeReceipts(undefined);
		expect(stage(["--receipts", empty]).result.stderr).toContain('has no "binaries" array');
		const notObject = writeReceipts([{}]);
		expect(stage(["--receipts", notObject]).result.stderr).toContain("unsupported platform undefined");
	});

	describe("--archives", () => {
		let archivesDir: string;
		let archives: Receipt[];

		beforeAll(() => {
			archivesDir = mkdtempSync(join(root, "archives-"));
			archives = platforms.map((platform) => {
				const file = `prime-agent-${version}-${platform}.tar.gz`;
				const tar = spawnSync("tar", ["-czf", join(archivesDir, file), "-C", join(binaryDir, platform), "."], {
					encoding: "utf8",
				});
				expect(tar.status, tar.stderr).toBe(0);
				return {
					platform,
					file,
					sha256: sha256(join(archivesDir, file)),
					executableSha256: sha256(join(binaryDir, platform, "prime-agent")),
				};
			});
		});

		function stageArchives(receipts: string) {
			const outDir = mkdtempSync(join(root, "out-"));
			rmSync(outDir, { recursive: true, force: true });
			const result = pack([
				"--archives",
				archivesDir,
				"--packages-dir",
				packagesDir,
				"--version",
				version,
				"--out-dir",
				outDir,
				"--skip-pack",
				"--receipts",
				receipts,
			]);
			return { outDir, result };
		}

		it("unpacks archives whose digests match the receipts", () => {
			const { outDir, result } = stageArchives(writeReceipts(archives));
			expect(result.status, result.stderr).toBe(0);
			for (const receipt of archives) {
				const staged = readJson(
					join(outDir, "@primeintellect", `prime-agent-${receipt.platform}`, "receipts.json"),
				);
				expect(staged.archive).toEqual({ file: receipt.file, sha256: receipt.sha256 });
				expect(staged.executableSha256).toBe(receipt.executableSha256);
			}
		});

		it("refuses an archive whose digest disagrees with its receipt", () => {
			const tampered = archives.map((receipt) =>
				receipt.platform === "darwin-x64" ? { ...receipt, sha256: "e".repeat(64) } : receipt,
			);
			const { result } = stageArchives(writeReceipts(tampered));
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Archive mismatch for darwin-x64");
		});

		it("refuses to unpack anything when a platform has no receipt", () => {
			const { result } = stageArchives(
				writeReceipts(archives.filter((receipt) => receipt.platform !== "darwin-x64")),
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("has no receipt for: darwin-x64");
		});
	});
});

// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
describe.skipIf(process.platform === "win32")("bin shim resolution", () => {
	const key = `${process.platform}-${process.arch}`;

	function install(outDir: string, options: { platformPackage?: boolean } = {}) {
		const project = mkdtempSync(join(root, "project-"));
		const modules = join(project, "node_modules");
		cpSync(join(outDir, "prime-agent"), join(modules, "prime-agent"), { recursive: true });
		if (options.platformPackage !== false) {
			cpSync(
				join(outDir, "@primeintellect", `prime-agent-${key}`),
				join(modules, "@primeintellect", `prime-agent-${key}`),
				{ recursive: true },
			);
		}
		return { project, shim: join(modules, "prime-agent/bin/prime-agent.cjs") };
	}

	function launch(shim: string, project: string, args: string[] = [], env: Record<string, string> = {}) {
		return spawnSync(process.execPath, [shim, ...args], {
			cwd: project,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
	}

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	it.skipIf(!platforms.includes(`${process.platform}-${process.arch}`))(
		"executes the platform binary, forwards arguments and propagates the exit code",
		() => {
			const { outDir, result } = stage();
			expect(result.status, result.stderr).toBe(0);
			const { project, shim } = install(outDir);
			const run = launch(shim, project, ["--print", "value"]);
			expect(run.stdout.trim()).toBe(`fixture ${key} --print value`);
			expect(run.status).toBe(7);
			expect(launch(shim, project, [], { PRIME_AGENT_VERIFY_BINARY: "1" }).status).toBe(7);
		},
	);

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	it.skipIf(!platforms.includes(`${process.platform}-${process.arch}`))(
		"fails closed when the receipt does not match the installed binary",
		() => {
			const { outDir, result } = stage();
			expect(result.status, result.stderr).toBe(0);
			const { project, shim } = install(outDir);
			const binary = join(project, "node_modules/@primeintellect", `prime-agent-${key}`, "bin/prime-agent");
			writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const run = launch(shim, project, [], { PRIME_AGENT_VERIFY_BINARY: "1" });
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("hash mismatch");
		},
	);

	it("explains how to recover when no platform package is installed", () => {
		const { outDir, result } = stage();
		expect(result.status, result.stderr).toBe(0);
		const { project, shim } = install(outDir, { platformPackage: false });
		const run = launch(shim, project);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("is not installed");
		expect(run.stderr).toContain("npm install @primeintellect/prime-agent-");
	});

	it("names the supported platforms when the host is not one of them", () => {
		const { outDir, result } = stage();
		expect(result.status, result.stderr).toBe(0);
		const { project, shim } = install(outDir, { platformPackage: false });
		const manifestPath = join(project, "node_modules/prime-agent/package.json");
		const manifest = readJson(manifestPath);
		delete manifest.primeAgent.platforms[key];
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const run = launch(shim, project);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain(`unsupported platform ${key}`);
		expect(run.stderr).toContain("install.prime-agent.dev");
	});
});
