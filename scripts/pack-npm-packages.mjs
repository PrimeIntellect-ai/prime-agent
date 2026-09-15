#!/usr/bin/env node

/**
 * Build registry-ready npm packages for a Prime Agent release.
 *
 * This is the registry channel. It is deliberately separate from scripts/pack-prime-agent-release.mjs
 * (the R2 channel), because the two have different trust models: R2 artifacts are referenced by
 * absolute tarball URL, registry artifacts must be plain registry ranges so npm can verify
 * signatures, record integrity hashes and attach provenance.
 *
 * Nothing here publishes, signs or talks to the network. The privileged CI job consumes the output.
 *
 * Usage:
 *   node scripts/pack-npm-packages.mjs --binary-dir packages/coding-agent/binaries [options]
 *
 * Options:
 *   --binary-dir <dir>   Directory holding darwin-arm64/, darwin-x64/, linux-arm64/, linux-x64/
 *                        (the output of the standalone binary build). Required unless --archives
 *                        is given.
 *   --archives <dir>     Directory holding the assembled release archives
 *                        prime-agent-<version>-<platform>.tar.gz. Each archive is checked against
 *                        the receipts file when one is given, then extracted into a temporary
 *                        binary directory. This is what CI uses: the privileged job never needs the
 *                        raw build tree, only the artifacts it is about to publish.
 *   --version <x.y.z>    Release version. Defaults to PRIME_AGENT_VERSION, then the coding-agent
 *                        package.json version.
 *   --out-dir <dir>      Staging root. Default: release/npm
 *   --scope <@scope>     npm scope for the mirror, platform and library packages.
 *                        Default: @primeintellect
 *   --front-door <name>  Unscoped canonical package name. Default: prime-agent
 *   --receipts <file>    Optional binaries.json / latest.json / beta.json produced by the R2 packer.
 *                        When given it must carry exactly one well-formed receipt per platform, and
 *                        every executableSha256 (and archive sha256 with --archives) must match, so
 *                        the npm artifact and the R2 artifact assert the same hash. A missing,
 *                        duplicate, unknown or malformed receipt is a hard error, as is a mismatch.
 *   --packages-dir <dir> Workspace packages root. Default: packages/ (override only for tests).
 *   --skip-pack          Stage package directories only; do not run `npm pack`.
 *
 * Output layout (under --out-dir):
 *   <out>/prime-agent/                               front door (bin shim + optionalDependencies)
 *   <out>/@primeintellect/prime-agent/               scoped mirror, identical content
 *   <out>/@primeintellect/prime-agent-<platform>/    one compiled binary each, os/cpu gated
 *   <out>/@primeintellect/prime-agent-{ai,core,tui}/ library packages
 *   <out>/artifacts/<npm-pack-name>.tgz              one tarball per package
 *   <out>/manifest.json                              names, versions, tarballs, sha256, publishOrder
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryAssets, setBinaryVersion, validateBinaryAssets } from "../packages/coding-agent/scripts/copy-binary-assets.mjs";
import {
	assertRegistryDependencies,
	registryDependencySpec,
	rewriteInternalDependencies,
} from "./lib/internal-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shimSource = join(root, "scripts", "lib", "npm-bin-shim.cjs");
const stagingMarker = ".prime-agent-npm-staging";

/**
 * Both values are interpolated into staging paths under --out-dir, so they are restricted to the
 * subset of npm names that can never contain a path separator, `.`, or `..`: a scope is `@` plus
 * one lowercase URL-safe segment, an unscoped name is one such segment. `@x/../../..` and `../..`
 * are npm-invalid anyway; refusing them here keeps the packer from writing outside its output tree.
 */
export const NPM_SCOPE = /^@[a-z0-9](?:[a-z0-9_-]{0,213})$/;
export const NPM_UNSCOPED_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,213})$/;

export const PLATFORMS = {
	"darwin-arm64": { os: "darwin", cpu: "arm64" },
	"darwin-x64": { os: "darwin", cpu: "x64" },
	"linux-arm64": { os: "linux", cpu: "arm64" },
	"linux-x64": { os: "linux", cpu: "x64" },
};

/**
 * Library packages. `packageDir` is the workspace directory, `registryName` the unscoped part of the
 * published name. Dependency keys keep the source workspace names because compiled output imports
 * those specifiers literally; the specifier becomes an npm alias onto the published name.
 */
export const LIBRARIES = [
	{ packageDir: "ai", registryName: "prime-agent-ai" },
	{ packageDir: "agent", registryName: "prime-agent-core" },
	{ packageDir: "tui", registryName: "prime-agent-tui" },
];

const DEFAULTS = {
	scope: "@primeintellect",
	frontDoor: "prime-agent",
	outDir: join(root, "release", "npm"),
};

export function platformPackageName(scope, frontDoor, platform) {
	return `${scope}/${frontDoor}-${platform}`;
}

export function normalizeVersion(version) {
	const normalized = String(version).startsWith("v") ? String(version).slice(1) : String(version);
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) throw new Error(`Invalid release version: ${version}`);
	return normalized;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function publishConfig() {
	return { access: "public", registry: "https://registry.npmjs.org", provenance: true };
}

const REPOSITORY = { type: "git", url: "git+https://github.com/PrimeIntellect-ai/prime-agent.git" };

/** npm requires a repository field that matches the building repository for provenance. */
function repositoryFor(sourcePackage) {
	const repository = sourcePackage?.repository;
	if (!repository) return { ...REPOSITORY };
	return typeof repository === "string" ? { ...REPOSITORY } : { ...repository };
}

const HOMEPAGE = "https://github.com/PrimeIntellect-ai/prime-agent#readme";
const BUGS = { url: "https://github.com/PrimeIntellect-ai/prime-agent/issues" };

/**
 * Topological order over the internal library graph, so a package is always published after the
 * packages it depends on. `@primeintellect/prime-agent-core` depends on `@primeintellect/prime-agent-ai`,
 * so ai precedes core regardless of the order of LIBRARIES.
 */
export function orderLibraries(libraries, sourcePackages) {
	const bySourceName = new Map(libraries.map((library) => [sourcePackages.get(library.packageDir).name, library]));
	const ordered = [];
	const seen = new Set();
	const visit = (library, stack) => {
		const sourceName = sourcePackages.get(library.packageDir).name;
		if (seen.has(sourceName)) return;
		if (stack.has(sourceName)) throw new Error(`Dependency cycle in internal packages: ${sourceName}`);
		stack.add(sourceName);
		const dependencies = sourcePackages.get(library.packageDir).dependencies || {};
		for (const dependency of Object.keys(dependencies)) {
			const next = bySourceName.get(dependency);
			if (next) visit(next, stack);
		}
		stack.delete(sourceName);
		seen.add(sourceName);
		ordered.push(library);
	};
	for (const library of libraries) visit(library, new Set());
	return ordered;
}

/**
 * Pure planning step: produce every package.json that will be staged, in publish order. Kept free of
 * file system writes so it can be unit tested without binaries.
 */
export function buildPackagePlan({ version, scope, frontDoor, sourcePackages, binaries }) {
	const releaseVersion = normalizeVersion(version);
	const libraries = orderLibraries(LIBRARIES, sourcePackages);
	const registryNames = new Map(
		libraries.map((library) => [sourcePackages.get(library.packageDir).name, `${scope}/${library.registryName}`]),
	);
	const replacements = new Map(
		[...registryNames].map(([sourceName, registryName]) => [
			sourceName,
			registryDependencySpec(sourceName, registryName, releaseVersion),
		]),
	);

	const missing = Object.keys(PLATFORMS).filter((platform) => !binaries.some((binary) => binary.platform === platform));
	if (missing.length > 0) throw new Error(`Missing compiled binaries for: ${missing.join(", ")}`);

	const codingAgent = sourcePackages.get("coding-agent");
	const plan = [];

	for (const platform of Object.keys(PLATFORMS)) {
		const receipt = binaries.find((binary) => binary.platform === platform);
		const name = platformPackageName(scope, frontDoor, platform);
		plan.push({
			kind: "platform",
			name,
			platform,
			directory: name,
			receipt,
			packageJson: {
				name,
				version: releaseVersion,
				description: `Prime Agent CLI binary for ${platform}`,
				license: codingAgent.license ?? "MIT",
				// Platform packages have no source directory in the monorepo.
				repository: { ...REPOSITORY },
				homepage: HOMEPAGE,
				bugs: BUGS,
				os: [PLATFORMS[platform].os],
				cpu: [PLATFORMS[platform].cpu],
				// Yarn PnP keeps packages zipped unless told otherwise; the binary must exist on disk.
				preferUnplugged: true,
				files: ["bin", "receipts.json", "README.md", "LICENSE"],
				publishConfig: publishConfig(),
				primeAgent: {
					platform,
					binary: "bin/prime-agent",
					executableSha256: receipt.executableSha256,
					...(receipt.file ? { archive: { file: receipt.file, sha256: receipt.sha256 } } : {}),
				},
			},
		});
	}

	for (const library of libraries) {
		const sourcePackage = sourcePackages.get(library.packageDir);
		const name = registryNames.get(sourcePackage.name);
		const packageJson = {
			...sourcePackage,
			name,
			version: releaseVersion,
			repository: repositoryFor(sourcePackage),
			homepage: HOMEPAGE,
			bugs: BUGS,
			dependencies: rewriteInternalDependencies(sourcePackage.dependencies, replacements),
			optionalDependencies: rewriteInternalDependencies(sourcePackage.optionalDependencies, replacements),
			publishConfig: publishConfig(),
		};
		// No lifecycle scripts reach the registry, and inherited workspace bin names
		// (`pi-ai`) are not part of the public surface.
		delete packageJson.scripts;
		delete packageJson.devDependencies;
		delete packageJson.overrides;
		delete packageJson.private;
		delete packageJson.bin;
		if (packageJson.dependencies === undefined) delete packageJson.dependencies;
		if (packageJson.optionalDependencies === undefined) delete packageJson.optionalDependencies;
		assertRegistryDependencies(packageJson);
		plan.push({
			kind: "library",
			name,
			directory: name,
			packageDir: library.packageDir,
			sourcePackage,
			packageJson,
		});
	}

	const optionalDependencies = {};
	const platformMap = {};
	for (const platform of Object.keys(PLATFORMS)) {
		const name = platformPackageName(scope, frontDoor, platform);
		// Exact pin: the front door must never resolve a platform binary from another release.
		optionalDependencies[name] = releaseVersion;
		platformMap[platform] = {
			package: name,
			binary: "bin/prime-agent",
			executableSha256: binaries.find((binary) => binary.platform === platform).executableSha256,
		};
	}

	const frontDoorPackageJson = {
		name: frontDoor,
		version: releaseVersion,
		description: codingAgent.description ?? "Prime Agent coding CLI",
		license: codingAgent.license ?? "MIT",
		repository: repositoryFor(codingAgent),
		homepage: HOMEPAGE,
		bugs: BUGS,
		keywords: codingAgent.keywords ?? [],
		engines: { node: ">=18.0.0" },
		bin: { [frontDoor]: "bin/prime-agent.cjs" },
		files: ["bin", "README.md", "LICENSE"],
		optionalDependencies,
		publishConfig: publishConfig(),
		primeAgent: { channel: "npm", platforms: platformMap },
	};
	assertRegistryDependencies(frontDoorPackageJson);

	plan.push({ kind: "front-door", name: frontDoor, directory: frontDoor, packageJson: frontDoorPackageJson });
	plan.push({
		kind: "front-door",
		name: `${scope}/${frontDoor}`,
		directory: `${scope}/${frontDoor}`,
		mirrorOf: frontDoor,
		packageJson: { ...frontDoorPackageJson, name: `${scope}/${frontDoor}` },
	});

	return plan;
}

function parseArgs(args) {
	const parsed = {
		binaryDir: undefined,
		archivesDir: undefined,
		version: process.env.PRIME_AGENT_VERSION,
		outDir: DEFAULTS.outDir,
		scope: DEFAULTS.scope,
		frontDoor: DEFAULTS.frontDoor,
		receipts: undefined,
		packagesDir: join(root, "packages"),
		skipPack: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const value = args[i + 1];
		switch (arg) {
			case "--binary-dir":
				if (!value) throw new Error("--binary-dir requires a value");
				parsed.binaryDir = resolve(root, value);
				i += 1;
				break;
			case "--archives":
				if (!value) throw new Error("--archives requires a value");
				parsed.archivesDir = resolve(root, value);
				i += 1;
				break;
			case "--version":
				if (!value) throw new Error("--version requires a value");
				parsed.version = value;
				i += 1;
				break;
			case "--out-dir":
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				i += 1;
				break;
			case "--scope":
				if (!value || !NPM_SCOPE.test(value)) throw new Error("--scope must look like @scope (lowercase, no slashes or dots)");
				parsed.scope = value;
				i += 1;
				break;
			case "--front-door":
				if (!value || !NPM_UNSCOPED_NAME.test(value))
					throw new Error("--front-door must be a plain unscoped npm package name");
				parsed.frontDoor = value;
				i += 1;
				break;
			case "--packages-dir":
				if (!value) throw new Error("--packages-dir requires a value");
				parsed.packagesDir = resolve(root, value);
				i += 1;
				break;
			case "--receipts":
				if (!value) throw new Error("--receipts requires a value");
				parsed.receipts = resolve(root, value);
				i += 1;
				break;
			case "--skip-pack":
				parsed.skipPack = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!parsed.binaryDir && !parsed.archivesDir) throw new Error("--binary-dir or --archives is required");
	if (parsed.binaryDir && parsed.archivesDir) throw new Error("--binary-dir and --archives are mutually exclusive");
	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-npm-packages.mjs (--binary-dir <dir> | --archives <dir>) [--version x.y.z] [--out-dir dir]
       [--scope @primeintellect] [--front-door prime-agent] [--receipts file] [--skip-pack]

Stages registry-ready packages under <out-dir> and writes <out-dir>/manifest.json with the publish order.
Publishing happens in CI: npm publish <tarball> --provenance --access public --ignore-scripts`);
}

/**
 * Only ever delete a directory this script created. Staging dirs carry a marker file, so a mistyped
 * --out-dir cannot wipe an unrelated tree.
 */
function prepareOutputDir(outDir) {
	if (outDir === "/" || outDir === root || dirname(outDir) === outDir) {
		throw new Error(`Refusing to use output directory: ${outDir}`);
	}
	if (existsSync(outDir)) {
		if (!existsSync(join(outDir, stagingMarker)) && readdirSync(outDir).length > 0) {
			throw new Error(`Refusing to delete ${outDir}: it is not a Prime Agent npm staging directory`);
		}
		rmSync(outDir, { recursive: true, force: true });
	}
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, stagingMarker), "generated by scripts/pack-npm-packages.mjs\n");
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Read and validate a receipts file (binaries.json / latest.json / beta.json from the R2 packer).
 *
 * The file is the cross-check that ties the registry artifacts to the R2 artifacts, so it is held to
 * a strict shape: EXACTLY one receipt per required platform (a missing platform would silently skip
 * the digest check, a duplicate would make "the" receipt ambiguous), no receipts for platforms this
 * packer does not publish (the manifest and the packer would then disagree about what the release
 * is), and every receipt carrying its archive name plus well-formed lowercase sha256 digests for
 * both the archive and the executable. Anything else is a hard error - never a skipped check.
 *
 * Returns a Map from platform to `{ platform, file, sha256, executableSha256 }`.
 */
export function readReceipts(receiptsFile, version) {
	const releaseVersion = normalizeVersion(version);
	let manifest;
	try {
		manifest = readJson(receiptsFile);
	} catch (error) {
		throw new Error(`Receipts file ${receiptsFile} is not valid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error(`Receipts file ${receiptsFile} must be a JSON object`);
	}
	if (manifest.version !== undefined && manifest.version !== `v${releaseVersion}`) {
		throw new Error(`Receipts file ${receiptsFile} is for ${manifest.version}, not v${releaseVersion}`);
	}
	if (!Array.isArray(manifest.binaries)) {
		throw new Error(`Receipts file ${receiptsFile} has no "binaries" array`);
	}
	const receipts = new Map();
	for (const entry of manifest.binaries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Receipts file ${receiptsFile} contains a receipt that is not an object`);
		}
		const { platform, file, sha256, executableSha256 } = entry;
		if (typeof platform !== "string" || !Object.hasOwn(PLATFORMS, platform)) {
			throw new Error(
				`Receipts file ${receiptsFile} names unsupported platform ${JSON.stringify(platform)}; expected one of ${Object.keys(PLATFORMS).join(", ")}`,
			);
		}
		if (receipts.has(platform)) {
			throw new Error(`Receipts file ${receiptsFile} has more than one receipt for ${platform}`);
		}
		const expectedFile = `prime-agent-${releaseVersion}-${platform}.tar.gz`;
		if (file !== expectedFile) {
			throw new Error(`Receipt for ${platform} in ${receiptsFile} names ${JSON.stringify(file)}, not ${expectedFile}`);
		}
		for (const [field, value] of [
			["sha256", sha256],
			["executableSha256", executableSha256],
		]) {
			if (typeof value !== "string" || !SHA256_HEX.test(value)) {
				throw new Error(
					`Receipt for ${platform} in ${receiptsFile} has a malformed ${field}: expected 64 lowercase hex characters, got ${JSON.stringify(value)}`,
				);
			}
		}
		receipts.set(platform, { platform, file, sha256, executableSha256 });
	}
	const missing = Object.keys(PLATFORMS).filter((platform) => !receipts.has(platform));
	if (missing.length > 0) {
		throw new Error(`Receipts file ${receiptsFile} has no receipt for: ${missing.join(", ")}`);
	}
	return receipts;
}

/**
 * Materialise a binary directory from the assembled release archives.
 *
 * CI publishes from the artifact set it just verified, not from a build tree. Every archive is
 * hashed and compared against the receipts file before it is unpacked, so a tampered archive cannot
 * reach the registry even if it reached the artifact store. With a receipts file every platform is
 * checked; there is no per-platform opt-out.
 */
function extractBinariesFromArchives(archivesDir, version, receiptsFile) {
	const receipts = receiptsFile ? readReceipts(receiptsFile, version) : undefined;
	// Verify every archive BEFORE creating the staging directory, so a missing archive or a receipt
	// mismatch never leaves a half-populated temp directory behind.
	const archives = new Map();
	for (const platform of Object.keys(PLATFORMS)) {
		const file = `prime-agent-${version}-${platform}.tar.gz`;
		const archive = join(archivesDir, file);
		if (!existsSync(archive)) throw new Error(`Missing release archive: ${archive}`);
		if (receipts) {
			const receipt = receipts.get(platform);
			if (!receipt) throw new Error(`Receipts file ${receiptsFile} has no receipt for: ${platform}`);
			const archiveSha256 = sha256File(archive);
			if (receipt.sha256 !== archiveSha256) {
				throw new Error(
					`Archive mismatch for ${platform}: ${receiptsFile} records ${receipt.sha256}, ${file} hashes ${archiveSha256}`,
				);
			}
		}
		archives.set(platform, archive);
	}
	const staging = mkdtempSync(join(tmpdir(), "prime-agent-npm-binaries-"));
	try {
		for (const [platform, archive] of archives) {
			const target = join(staging, platform);
			mkdirSync(target, { recursive: true });
			run("tar", ["-xzf", archive, "-C", target], root);
		}
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	return staging;
}

/**
 * Read executable receipts for every platform. With a receipts file, every platform's executable
 * digest must match the recorded one; there is no per-platform opt-out.
 */
function collectBinaries(binaryDir, version, receiptsFile) {
	const receipts = receiptsFile ? readReceipts(receiptsFile, version) : undefined;
	const binaries = [];
	for (const platform of Object.keys(PLATFORMS)) {
		const source = join(binaryDir, platform);
		if (!existsSync(source)) throw new Error(`Missing compiled binary directory: ${source}`);
		validateBinaryAssets(source);
		const binary = join(source, "prime-agent");
		if (!statSync(binary).isFile()) throw new Error(`Missing executable: ${binary}`);
		const executableSha256 = sha256File(binary);
		if (receipts) {
			const receipt = receipts.get(platform);
			if (!receipt) throw new Error(`Receipts file ${receiptsFile} has no receipt for: ${platform}`);
			if (receipt.executableSha256 !== executableSha256) {
				throw new Error(
					`Receipt mismatch for ${platform}: ${receiptsFile} records ${receipt.executableSha256}, binary hashes ${executableSha256}`,
				);
			}
			binaries.push({ platform, executableSha256, file: receipt.file, sha256: receipt.sha256 });
		} else {
			binaries.push({ platform, executableSha256 });
		}
	}
	return binaries;
}

function copyIfExists(source, target) {
	if (existsSync(source)) cpSync(source, target, { recursive: true });
}

function stagePlatformPackage(entry, { binaryDir, version, outDir }) {
	const target = join(outDir, entry.directory);
	const payload = join(target, "bin");
	mkdirSync(payload, { recursive: true });
	const source = join(binaryDir, entry.platform);
	// Same payload as the R2 archive: executable plus sibling assets, version stamped.
	for (const name of ["prime-agent", ...binaryAssets]) cpSync(join(source, name), join(payload, name), { recursive: true });
	setBinaryVersion(payload, version);
	chmodSync(join(payload, "prime-agent"), 0o755);
	writeJson(join(target, "receipts.json"), {
		schemaVersion: 1,
		package: entry.name,
		version: `v${version}`,
		platform: entry.platform,
		binary: "bin/prime-agent",
		executableSha256: entry.receipt.executableSha256,
		...(entry.receipt.file ? { archive: { file: entry.receipt.file, sha256: entry.receipt.sha256 } } : {}),
	});
	return target;
}

function stageLibraryPackage(entry, { outDir, packagesDir }) {
	const target = join(outDir, entry.directory);
	const source = join(packagesDir, entry.packageDir);
	if (!existsSync(join(source, "dist"))) {
		throw new Error(`Missing ${join(source, "dist")}. Run npm run build before packing npm packages.`);
	}
	mkdirSync(target, { recursive: true });
	const contents = new Set([...(entry.sourcePackage.files || ["dist"]), "README.md", "CHANGELOG.md"]);
	for (const item of contents) {
		// `files` entries may be globs ("dist/**/*"); stage the directory they select.
		const name = item.replace(/\/\*\*\/\*$/, "").replace(/\/$/, "");
		copyIfExists(join(source, name), join(target, name));
	}
	return target;
}

function stageFrontDoor(entry, { outDir }) {
	const target = join(outDir, entry.directory);
	mkdirSync(join(target, "bin"), { recursive: true });
	cpSync(shimSource, join(target, "bin", "prime-agent.cjs"));
	chmodSync(join(target, "bin", "prime-agent.cjs"), 0o755);
	copyIfExists(join(root, "README.md"), join(target, "README.md"));
	return target;
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
	}
	return result.stdout.trim();
}

/** Guard against npm's default ignore rules silently dropping payload files. */
function verifyTarball(tarballPath, requiredEntries) {
	const listing = run("tar", ["-tzf", tarballPath], root).split("\n");
	for (const required of requiredEntries) {
		if (!listing.includes(`package/${required}`)) {
			throw new Error(`${basename(tarballPath)} is missing ${required}`);
		}
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourcePackages = new Map(
		[...LIBRARIES.map((library) => library.packageDir), "coding-agent"].map((packageDir) => [
			packageDir,
			readJson(join(args.packagesDir, packageDir, "package.json")),
		]),
	);
	const version = normalizeVersion(args.version || sourcePackages.get("coding-agent").version);
	let extracted;
	if (args.archivesDir) {
		extracted = extractBinariesFromArchives(args.archivesDir, version, args.receipts);
		args.binaryDir = extracted;
	}
	try {
		stagePackages(args, version, sourcePackages);
	} finally {
		// The extraction directory only exists for this run; never leave four payloads in $TMPDIR.
		if (extracted) rmSync(extracted, { recursive: true, force: true });
	}
}

function stagePackages(args, version, sourcePackages) {
	const binaries = collectBinaries(args.binaryDir, version, args.receipts);
	const plan = buildPackagePlan({
		version,
		scope: args.scope,
		frontDoor: args.frontDoor,
		sourcePackages,
		binaries,
	});

	prepareOutputDir(args.outDir);
	const artifactsDir = join(args.outDir, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });

	const published = [];
	for (const entry of plan) {
		let target;
		if (entry.kind === "platform") target = stagePlatformPackage(entry, { ...args, version, outDir: args.outDir });
		else if (entry.kind === "library")
			target = stageLibraryPackage(entry, { outDir: args.outDir, packagesDir: args.packagesDir });
		else target = stageFrontDoor(entry, { outDir: args.outDir });
		copyIfExists(join(root, "LICENSE"), join(target, "LICENSE"));
		if (!existsSync(join(target, "README.md"))) copyIfExists(join(root, "README.md"), join(target, "README.md"));
		writeJson(join(target, "package.json"), entry.packageJson);

		const record = {
			name: entry.name,
			kind: entry.kind,
			version,
			directory: entry.directory,
		};
		if (!args.skipPack) {
			const packed = run("npm", ["pack", target, "--pack-destination", artifactsDir, "--silent"], root)
				.split("\n")
				.at(-1);
			const tarballPath = join(artifactsDir, basename(packed));
			if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
			if (entry.kind === "platform") verifyTarball(tarballPath, ["bin/prime-agent", "receipts.json", "package.json"]);
			if (entry.kind === "front-door") verifyTarball(tarballPath, ["bin/prime-agent.cjs", "package.json"]);
			record.tarball = basename(tarballPath);
			record.sha256 = sha256File(tarballPath);
		}
		published.push(record);
	}

	writeJson(join(args.outDir, "manifest.json"), {
		schemaVersion: 1,
		version,
		scope: args.scope,
		frontDoor: args.frontDoor,
		// Publish order: platform binaries first (the front door pins them exactly), then libraries in
		// dependency order, then the front door and its scoped mirror last.
		publishOrder: published.map((record) => record.name),
		packages: published,
	});

	for (const record of published) console.log(`Staged ${record.name} -> ${join(args.outDir, record.directory)}`);
	console.log(`Publish order: ${published.map((record) => record.name).join(" -> ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
