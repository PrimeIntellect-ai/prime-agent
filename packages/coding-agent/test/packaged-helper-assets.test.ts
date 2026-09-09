import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	chownSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _REPO = resolve(PACKAGE, "../..");
const BUN = process.execPath;
const HELPERS = Object.freeze([
	Object.freeze({
		name: "hosted-session-store-posix-helper.py",
		size: 200324,
		digest: "c5edb8a96abbe6d92f21698012be1d74b2686b7b589293430b726f6f16d69319",
		sourceAnchor: "hosted-session-store.ts",
	}),
	Object.freeze({
		name: "ws-posix-helper.py",
		size: 144628,
		digest: "0241c6ddd8de0072bb5b6f7896899767cdde5b4902654f883bb92435fac78fb2",
		sourceAnchor: "prime-workspace-helper-core.ts",
	}),
]);
const temporaryDirectories: string[] = [];
const sessionRoots: string[] = [];

function mkdir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function fixture(): { root: string; packageDir: string; sourceDir: string; distDir: string } {
	const root = mkdtempSync(join(tmpdir(), "packaged-helper-assets-"));
	temporaryDirectories.push(root);
	const packageDir = join(root, "packages", "coding-agent");
	const sourceDir = join(packageDir, "src", "modes", "daemon", "sandbox");
	const distDir = join(packageDir, "dist");
	for (const path of [
		join(packageDir, "scripts"),
		sourceDir,
		join(packageDir, "src", "modes", "interactive", "theme"),
		join(packageDir, "src", "modes", "interactive", "assets"),
		join(packageDir, "src", "core", "export-html", "vendor"),
		join(packageDir, "skills"),
		join(packageDir, "docs"),
		join(packageDir, "examples"),
		join(root, "prime-agent-runtime"),
		join(root, "node_modules", "@silvia-odwyer", "photon-node"),
		distDir,
	])
		mkdir(path);
	writeFileSync(
		join(packageDir, "scripts", "copy-assets.ts"),
		readFileSync(join(PACKAGE, "scripts", "copy-assets.ts")),
	);
	writeFileSync(join(packageDir, "scripts", "bundle.mjs"), readFileSync(join(PACKAGE, "scripts", "bundle.mjs")));
	for (const helper of HELPERS) {
		writeFileSync(
			join(sourceDir, helper.name),
			readFileSync(join(PACKAGE, "src", "modes", "daemon", "sandbox", helper.name)),
			{
				mode: 0o644,
			},
		);
		writeFileSync(join(sourceDir, helper.sourceAnchor), "trusted source anchor\n", { mode: 0o644 });
	}
	writeFileSync(join(distDir, "cli.js"), "console.log('fixture');\n", { mode: 0o644 });
	for (const name of ["template.html", "template.css", "template.js"])
		writeFileSync(join(packageDir, "src", "core", "export-html", name), "fixture");
	writeFileSync(join(packageDir, "src", "core", "export-html", "vendor", "fixture.js"), "fixture");
	writeFileSync(join(packageDir, "src", "modes", "interactive", "theme", "fixture.json"), "{}");
	writeFileSync(join(packageDir, "src", "modes", "interactive", "assets", "fixture.png"), "fixture");
	writeFileSync(join(root, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"), "fixture");
	writeFileSync(join(root, "install.sh"), "#!/bin/sh\n");
	for (const name of ["README.md", "CHANGELOG.md"]) writeFileSync(join(packageDir, name), "fixture\n");
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "packaged-helper-assets-fixture", version: "1.0.0", files: ["dist"] }),
	);
	return { root, packageDir, sourceDir, distDir };
}

function run(packageDir: string, args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync(BUN, args, { cwd: packageDir, env: {}, encoding: "utf8", timeout: 30_000 });
}

function expectHelper(path: string, helper: (typeof HELPERS)[number], anchorPath: string): void {
	const stat = lstatSync(path);
	const bytes = readFileSync(path);
	expect(stat.isFile()).toBe(true);
	expect(stat.nlink).toBe(1);
	expect(stat.mode & 0o7777).toBe(0o644);
	expect(stat.uid === process.geteuid?.() || stat.uid === 0).toBe(true);
	const anchor = lstatSync(anchorPath);
	expect(stat.uid).toBe(anchor.uid);
	expect(stat.gid).toBe(anchor.gid);
	expect(bytes.byteLength).toBe(helper.size);
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(helper.digest);
}

function runPackage(packageDir: string): ReturnType<typeof spawnSync> {
	return run(packageDir, ["scripts/copy-assets.ts", "package"]);
}

function alternateGid(anchorPath: string): number | null {
	const anchorGid = lstatSync(anchorPath).gid;
	return process.getgroups?.().find((gid) => gid !== anchorGid) ?? null;
}

function expectNoHelperCopies(directory: string): void {
	for (const helper of HELPERS) expect(() => lstatSync(join(directory, helper.name))).toThrow();
}

function expectNoArchive(packageDir: string): void {
	expect(readdirSync(packageDir).some((name) => name.endsWith(".tgz"))).toBe(false);
}

const externalOwnerIt = process.env.PRIME_HELPER_OWNER_EXTERNAL_TEST === "1" ? it : it.skip;

function buildWorkspaceCore(target: string): void {
	const source = join(PACKAGE, "src", "modes", "daemon", "sandbox", "prime-workspace-helper-core.ts");
	const result = spawnSync(BUN, ["build", source, "--target=bun", "--format=esm", "--outfile", target], {
		encoding: "utf8",
		timeout: 30_000,
	});
	expect(result.status, result.stderr).toBe(0);
}

function expectResolverAcceptance(corePath: string, directory: string): void {
	const root = join(homedir(), ".prime", "agent", "sandbox-sessions", randomBytes(32).toString("hex"));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	sessionRoots.push(root);
	const runner = join(directory, `resolver-${randomBytes(8).toString("hex")}.ts`);
	writeFileSync(
		runner,
		`import { verifyWorkspaceRootLifecycleInternal as verify } from ${JSON.stringify(corePath)};\nprocess.stdout.write(JSON.stringify(await verify(${JSON.stringify(root)})));\n`,
	);
	const result = spawnSync(BUN, [runner], { cwd: "/", env: {}, encoding: "utf8", timeout: 20_000 });
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe('{"ok":true}');
}

afterEach(() => {
	for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
	for (const path of sessionRoots) rmSync(path, { recursive: true, force: true });
	temporaryDirectories.length = 0;
	sessionRoots.length = 0;
});

describe("fixed two-helper asset manifest", () => {
	it("is identical in the asset scripts and runtime owners", () => {
		const paths = [
			join(PACKAGE, "scripts", "copy-assets.ts"),
			join(PACKAGE, "scripts", "bundle.mjs"),
			join(PACKAGE, "src", "modes", "daemon", "sandbox", "hosted-session-store.ts"),
			join(PACKAGE, "src", "modes", "daemon", "sandbox", "prime-workspace-helper-core.ts"),
		];
		const sources = paths.map((path) => readFileSync(path, "utf8"));
		for (const helper of HELPERS) {
			const relevant = helper.name.startsWith("hosted-")
				? sources.slice(0, 3)
				: [sources[0], sources[1], sources[3]];
			for (const source of relevant) {
				expect(source).toContain(helper.name);
				expect(source).toContain(String(helper.size));
				expect(source).toContain(helper.digest);
			}
			expectHelper(
				join(PACKAGE, "src", "modes", "daemon", "sandbox", helper.name),
				helper,
				join(PACKAGE, "src", "modes", "daemon", "sandbox", helper.sourceAnchor),
			);
		}
	});

	it("keeps Store and Workspace helper routing disjoint", () => {
		const copySource = readFileSync(join(PACKAGE, "scripts", "copy-assets.ts"), "utf8");
		const names = [...copySource.matchAll(/name: "([^"]+-helper\.py)"/g)].map((match) => match[1]);
		expect(names).toEqual(HELPERS.map((helper) => helper.name));
		const store = readFileSync(join(PACKAGE, "src", "modes", "daemon", "sandbox", "hosted-session-store.ts"), "utf8");
		const workspace = readFileSync(
			join(PACKAGE, "src", "modes", "daemon", "sandbox", "prime-workspace-helper-core.ts"),
			"utf8",
		);
		expect(store).toContain('const HELPER_NAME = "hosted-session-store-posix-helper.py"');
		expect(store).not.toContain('const HELPER_NAME = "ws-posix-helper.py"');
		expect(workspace).toContain('const HELPER_NAME = "ws-posix-helper.py"');
		expect(workspace).not.toContain('const HELPER_NAME = "hosted-session-store-posix-helper.py"');
		expect(workspace).toContain("const RECOVER = 0x0e;");
		expect(store).toContain("const CREATE_SESSION = 0x02;");
	});

	it("copies and revalidates both package and binary layouts", () => {
		const item = fixture();
		const packaged = runPackage(item.packageDir);
		expect(packaged.status, packaged.stderr).toBe(0);
		for (const helper of HELPERS)
			expectHelper(
				join(item.distDir, "modes", "daemon", "sandbox", helper.name),
				helper,
				join(item.distDir, "cli.js"),
			);
		writeFileSync(join(item.distDir, "pi"), "binary", { mode: 0o755 });
		const binary = run(item.packageDir, ["scripts/copy-assets.ts", "binary"]);
		expect(binary.status, binary.stderr).toBe(0);
		for (const helper of HELPERS) expectHelper(join(item.distDir, helper.name), helper, join(item.distDir, "pi"));
	});

	it("rejects the binary asset phase before dist/pi exists", () => {
		const item = fixture();
		for (const helper of HELPERS) {
			writeFileSync(join(item.distDir, helper.name), readFileSync(join(item.sourceDir, helper.name)), {
				mode: 0o644,
			});
		}
		const result = run(item.packageDir, ["scripts/copy-assets.ts", "binary"]);
		expect(result.status).not.toBe(0);
		for (const helper of HELPERS) expect(() => lstatSync(join(item.distDir, helper.name))).toThrow();
	});

	it("rejects source and output anchor gid mismatches for package, bundle, and binary", () => {
		const sourceItem = fixture();
		const sourceHelper = join(sourceItem.sourceDir, HELPERS[1].name);
		const sourceGid = alternateGid(join(sourceItem.sourceDir, HELPERS[1].sourceAnchor));
		if (sourceGid === null) return;
		chownSync(sourceHelper, lstatSync(sourceHelper).uid, sourceGid);
		expect(runPackage(sourceItem.packageDir).status).not.toBe(0);
		expectNoHelperCopies(join(sourceItem.distDir, "modes", "daemon", "sandbox"));

		const bundleSourceItem = fixture();
		expect(runPackage(bundleSourceItem.packageDir).status).toBe(0);
		const bundleSourceHelper = join(bundleSourceItem.sourceDir, HELPERS[1].name);
		chownSync(bundleSourceHelper, lstatSync(bundleSourceHelper).uid, sourceGid);
		expect(run(bundleSourceItem.packageDir, ["scripts/bundle.mjs"]).status).not.toBe(0);
		expect(() => lstatSync(join(bundleSourceItem.distDir, "bundle"))).toThrow();

		const packageItem = fixture();
		const packageAnchor = join(packageItem.distDir, "cli.js");
		chownSync(packageAnchor, lstatSync(packageAnchor).uid, sourceGid);
		expect(runPackage(packageItem.packageDir).status).not.toBe(0);
		expectNoHelperCopies(join(packageItem.distDir, "modes", "daemon", "sandbox"));

		const binaryItem = fixture();
		const binaryAnchor = join(binaryItem.distDir, "pi");
		writeFileSync(binaryAnchor, "binary", { mode: 0o755 });
		chownSync(binaryAnchor, lstatSync(binaryAnchor).uid, sourceGid);
		expect(run(binaryItem.packageDir, ["scripts/copy-assets.ts", "binary"]).status).not.toBe(0);
		expectNoHelperCopies(binaryItem.distDir);

		const bundleItem = fixture();
		expect(runPackage(bundleItem.packageDir).status).toBe(0);
		const bundleScript = join(bundleItem.packageDir, "scripts", "bundle.mjs");
		let bundleSource = readFileSync(bundleScript, "utf8");
		bundleSource = `import { chownSync as hostileChownSync } from "node:fs";\n${bundleSource}`;
		bundleSource = bundleSource.replace(
			'const bundleAnchor = join(outdir, "cli.js");',
			`const bundleAnchor = join(outdir, "cli.js");\n\thostileChownSync(bundleAnchor, -1, ${sourceGid});`,
		);
		writeFileSync(bundleScript, bundleSource);
		expect(run(bundleItem.packageDir, ["scripts/bundle.mjs"]).status).not.toBe(0);
		expect(() => lstatSync(join(bundleItem.distDir, "bundle"))).toThrow();
		for (const item of [sourceItem, bundleSourceItem, packageItem, binaryItem, bundleItem])
			expectNoArchive(item.packageDir);
	});

	externalOwnerIt("rejects source and output anchor uid mismatches as root", () => {
		if (process.geteuid?.() !== 0) throw new Error("external owner test requires root");
		const sourceItem = fixture();
		const sourceHelper = join(sourceItem.sourceDir, HELPERS[1].name);
		chownSync(sourceHelper, 1234, lstatSync(sourceHelper).gid);
		expect(runPackage(sourceItem.packageDir).status).not.toBe(0);
		expectNoHelperCopies(join(sourceItem.distDir, "modes", "daemon", "sandbox"));

		const bundleSourceItem = fixture();
		expect(runPackage(bundleSourceItem.packageDir).status).toBe(0);
		const bundleSourceHelper = join(bundleSourceItem.sourceDir, HELPERS[1].name);
		chownSync(bundleSourceHelper, 1234, lstatSync(bundleSourceHelper).gid);
		expect(run(bundleSourceItem.packageDir, ["scripts/bundle.mjs"]).status).not.toBe(0);
		expect(() => lstatSync(join(bundleSourceItem.distDir, "bundle"))).toThrow();

		const packageItem = fixture();
		const packageAnchor = join(packageItem.distDir, "cli.js");
		chownSync(packageAnchor, 1234, lstatSync(packageAnchor).gid);
		expect(runPackage(packageItem.packageDir).status).not.toBe(0);
		expectNoHelperCopies(join(packageItem.distDir, "modes", "daemon", "sandbox"));

		const binaryItem = fixture();
		const binaryAnchor = join(binaryItem.distDir, "pi");
		writeFileSync(binaryAnchor, "binary", { mode: 0o755 });
		chownSync(binaryAnchor, 1234, lstatSync(binaryAnchor).gid);
		expect(run(binaryItem.packageDir, ["scripts/copy-assets.ts", "binary"]).status).not.toBe(0);
		expectNoHelperCopies(binaryItem.distDir);

		const bundleItem = fixture();
		expect(runPackage(bundleItem.packageDir).status).toBe(0);
		const bundleScript = join(bundleItem.packageDir, "scripts", "bundle.mjs");
		let bundleSource = readFileSync(bundleScript, "utf8");
		bundleSource = `import { chownSync as hostileChownSync } from "node:fs";\n${bundleSource}`;
		bundleSource = bundleSource.replace(
			'const bundleAnchor = join(outdir, "cli.js");',
			'const bundleAnchor = join(outdir, "cli.js");\n\thostileChownSync(bundleAnchor, 1234, -1);',
		);
		writeFileSync(bundleScript, bundleSource);
		expect(run(bundleItem.packageDir, ["scripts/bundle.mjs"]).status).not.toBe(0);
		expect(() => lstatSync(join(bundleItem.distDir, "bundle"))).toThrow();
		for (const item of [sourceItem, bundleSourceItem, packageItem, binaryItem, bundleItem])
			expectNoArchive(item.packageDir);
	});

	it("fails closed for missing, altered, mis-sized, outside, linked, wrong-mode, and extra sources", () => {
		const mutations: ((item: ReturnType<typeof fixture>) => void)[] = [
			(item) => rmSync(join(item.sourceDir, HELPERS[0].name)),
			(item) => {
				const path = join(item.sourceDir, HELPERS[0].name);
				const bytes = readFileSync(path);
				bytes[0] ^= 1;
				writeFileSync(path, bytes);
			},
			(item) => writeFileSync(join(item.sourceDir, HELPERS[1].name), "extra", { flag: "a" }),
			(item) => {
				const path = join(item.sourceDir, HELPERS[0].name);
				const outside = join(item.root, HELPERS[0].name);
				writeFileSync(outside, readFileSync(path), { mode: 0o644 });
				rmSync(path);
				symlinkSync(outside, path);
			},
			(item) => linkSync(join(item.sourceDir, HELPERS[0].name), join(item.sourceDir, "second-link.py")),
			(item) => chmodSync(join(item.sourceDir, HELPERS[1].name), 0o600),
			(item) => writeFileSync(join(item.sourceDir, "unexpected-helper.py"), "unexpected", { mode: 0o644 }),
		];
		for (const mutate of mutations) {
			const item = fixture();
			mutate(item);
			const result = runPackage(item.packageDir);
			expect(result.status).not.toBe(0);
		}
	});

	it("deletes stale bundle output and restores the verified pair", () => {
		const item = fixture();
		expect(runPackage(item.packageDir).status).toBe(0);
		mkdir(join(item.distDir, "bundle"));
		writeFileSync(join(item.distDir, "bundle", "stale"), "must disappear");
		const result = run(item.packageDir, ["scripts/bundle.mjs"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readdirSync(join(item.distDir, "bundle"))).not.toContain("stale");
		for (const helper of HELPERS)
			expectHelper(join(item.distDir, "bundle", helper.name), helper, join(item.distDir, "bundle", "cli.js"));
	});

	it("cleans the rebuilt bundle when helper validation fails", () => {
		const item = fixture();
		expect(runPackage(item.packageDir).status).toBe(0);
		mkdir(join(item.distDir, "bundle"));
		writeFileSync(join(item.distDir, "bundle", "stale"), "must disappear");
		chmodSync(join(item.distDir, "modes", "daemon", "sandbox", HELPERS[0].name), 0o600);
		const result = run(item.packageDir, ["scripts/bundle.mjs"]);
		expect(result.status).not.toBe(0);
		expect(() => lstatSync(join(item.distDir, "bundle"))).toThrow();
	});

	it("packs four exact helper members and preserves them through extraction and install", () => {
		const item = fixture();
		expect(runPackage(item.packageDir).status).toBe(0);
		expect(run(item.packageDir, ["scripts/bundle.mjs"]).status).toBe(0);
		const unbundledCore = join(item.distDir, "modes", "daemon", "sandbox", "prime-workspace-helper-core.js");
		buildWorkspaceCore(unbundledCore);
		const packed = spawnSync("npm", ["pack", "--json"], {
			cwd: item.packageDir,
			env: { PATH: process.env.PATH ?? "" },
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(packed.status, packed.stderr).toBe(0);
		const packResult = JSON.parse(packed.stdout)[0] as { filename: string; files: { path: string; mode: number }[] };
		const expected = HELPERS.flatMap((helper) => [
			`dist/modes/daemon/sandbox/${helper.name}`,
			`dist/bundle/${helper.name}`,
		]).sort();
		const members = packResult.files
			.filter((file) => file.path.endsWith("-helper.py"))
			.sort((a, b) => a.path.localeCompare(b.path));
		expect(members.map((file) => file.path)).toEqual(expected);
		for (const member of members) expect(member.mode & 0o7777).toBe(0o644);

		const archive = join(item.packageDir, packResult.filename);
		const listing = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
		expect(listing.status, listing.stderr).toBe(0);
		const helperLines = listing.stdout.split("\n").filter((line) => line.endsWith("-helper.py"));
		expect(helperLines).toHaveLength(4);
		for (const line of helperLines) expect(line.startsWith("-rw-r--r--")).toBe(true);
		const extracted = join(item.root, "extracted");
		mkdir(extracted);
		const extraction = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
		expect(extraction.status, extraction.stderr).toBe(0);
		for (const helper of HELPERS) {
			expectHelper(
				join(extracted, "package", "dist", "modes", "daemon", "sandbox", helper.name),
				helper,
				join(extracted, "package", "dist", "cli.js"),
			);
			expectHelper(
				join(extracted, "package", "dist", "bundle", helper.name),
				helper,
				join(extracted, "package", "dist", "bundle", "cli.js"),
			);
		}
		expectResolverAcceptance(
			join(extracted, "package", "dist", "modes", "daemon", "sandbox", "prime-workspace-helper-core.js"),
			extracted,
		);

		const install = join(item.root, "install");
		mkdir(install);
		writeFileSync(join(install, "package.json"), '{"private":true}');
		const installed = spawnSync("npm", ["install", "--ignore-scripts", archive], {
			cwd: install,
			env: { PATH: process.env.PATH ?? "" },
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(installed.status, installed.stderr).toBe(0);
		const installedPackage = join(install, "node_modules", "packaged-helper-assets-fixture");
		for (const helper of HELPERS) {
			expectHelper(
				join(installedPackage, "dist", "modes", "daemon", "sandbox", helper.name),
				helper,
				join(installedPackage, "dist", "cli.js"),
			);
			expectHelper(
				join(installedPackage, "dist", "bundle", helper.name),
				helper,
				join(installedPackage, "dist", "bundle", "cli.js"),
			);
		}
		expectResolverAcceptance(
			join(installedPackage, "dist", "modes", "daemon", "sandbox", "prime-workspace-helper-core.js"),
			install,
		);
	});
});
