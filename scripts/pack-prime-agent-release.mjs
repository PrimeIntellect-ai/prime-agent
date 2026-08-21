#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicPackageName, releaseComponents } from "./prime-agent-release-components.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const defaultBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const publicCommandName = process.env.PRIME_AGENT_CMD || "prime-agent";
const releaseChannels = new Set(["stable", "beta"]);
const releasePackages = releaseComponents;

function parseArgs(args) {
	const parsed = {
		baseUrl: defaultBaseUrl,
		channel: "stable",
		commit: undefined,
		outDir: defaultOutputDir,
		version: undefined,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--channel": {
				const value = args[i + 1];
				if (!value || !releaseChannels.has(value)) {
					throw new Error("--channel must be stable or beta");
				}
				parsed.channel = value;
				i += 1;
				break;
			}
			case "--commit": {
				const value = args[i + 1];
				if (!value || !/^[0-9a-f]{40}$/.test(value)) {
					throw new Error("--commit must be a lowercase 40-character Git commit SHA");
				}
				parsed.commit = value;
				i += 1;
				break;
			}
			case "--base-url": {
				const value = args[i + 1];
				if (!value) throw new Error("--base-url requires a value");
				parsed.baseUrl = value;
				i += 1;
				break;
			}
			case "--out-dir": {
				const value = args[i + 1];
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				i += 1;
				break;
			}
			case "--version": {
				const value = args[i + 1];
				if (!value) throw new Error("--version requires a value");
				parsed.version = normalizeVersion(value);
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!parsed.baseUrl) {
		throw new Error("--base-url or PRIME_AGENT_DOWNLOAD_BASE_URL is required");
	}
	if (!parsed.commit) {
		throw new Error("--commit is required");
	}

	parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-prime-agent-release.mjs --base-url url --commit sha [--channel stable|beta] [--version x.y.z] [--out-dir path]

Creates private npm tarballs for R2 distribution:

  <out-dir>/artifacts/prime-agent-<version>.tgz
  <out-dir>/artifacts/prime-agent-ai-<version>.tgz
  <out-dir>/artifacts/prime-agent-core-<version>.tgz
  <out-dir>/artifacts/prime-agent-tui-<version>.tgz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)
`);
}

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	return normalized;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packagePath(packageDir) {
	return join(root, "packages", packageDir);
}

function assertSafeOutputDir(outDir) {
	const relativeToReleaseRoot = relative(defaultOutputDir, outDir);
	if (relativeToReleaseRoot === "" || (!relativeToReleaseRoot.startsWith("..") && !isAbsolute(relativeToReleaseRoot))) {
		return;
	}
	throw new Error(`Refusing to remove output directory outside ${defaultOutputDir}: ${outDir}`);
}

const sourcePackageEntries = Object.freeze([
	"docs",
	"examples",
	"skills",
	"postinstall.cjs",
	"README.md",
	"CHANGELOG.md",
]);

function isWithin(path, parent) {
	const pathRelative = relative(parent, path);
	return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

function assertNoSymlinks(path, label) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in ${label}: ${path}`);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry), label);
}

function assertBuiltPackage(packageDir) {
	const dist = join(packagePath(packageDir), "dist");
	if (!existsSync(dist) || !lstatSync(dist).isDirectory()) {
		throw new Error(`Missing ${dist}. Run npm run build before packing a release.`);
	}
	assertNoSymlinks(dist, "generated dist root");
	return dist;
}

function copySafeTree(source, target, label) {
	const sourceStat = lstatSync(source);
	if (sourceStat.isSymbolicLink()) throw new Error(`Refusing symbolic link in ${label}: ${source}`);
	if (sourceStat.isDirectory()) {
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source)) copySafeTree(join(source, entry), join(target, entry), label);
		return;
	}
	if (!sourceStat.isFile()) throw new Error(`Refusing non-file source in ${label}: ${source}`);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(source, target);
	chmodSync(target, sourceStat.mode);
}

function copyIfExists(source, target, label) {
	if (existsSync(source)) copySafeTree(source, target, label);
}

function npmTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function releaseTarballUrl(baseUrl, version, tarballFile) {
	return `${baseUrl}/releases/v${version}/${tarballFile}`;
}

function rewriteInternalDependencies(dependencies, internalPackageUrls) {
	if (!dependencies) return undefined;
	const rewritten = {};
	for (const [name, range] of Object.entries(dependencies)) {
		rewritten[name] = internalPackageUrls.get(name) || range;
	}
	return rewritten;
}

function releaseScripts(sourceScripts) {
	if (!sourceScripts?.postinstall) return undefined;
	return {
		postinstall: sourceScripts.postinstall,
	};
}

function createReleasePackageJson(sourcePackage, packageName, releaseVersion, internalPackageUrls) {
	const packageJson = {
		...sourcePackage,
		name: packageName,
		version: releaseVersion,
		dependencies: rewriteInternalDependencies(sourcePackage.dependencies, internalPackageUrls),
		optionalDependencies: rewriteInternalDependencies(sourcePackage.optionalDependencies, internalPackageUrls),
		scripts: releaseScripts(sourcePackage.scripts),
	};

	delete packageJson.devDependencies;
	delete packageJson.overrides;
	delete packageJson.private;

	if (packageName === publicPackageName) {
		packageJson.bin = {
			[publicCommandName]: "dist/bundle/cli.js",
		};
		packageJson.piConfig = {
			...(packageJson.piConfig || {}),
			name: publicCommandName,
			configDir: ".prime/agent",
		};
	}

	return packageJson;
}

function copyPackageContents(archivedSourceDir, builtDist, targetDir, packageJson) {
	mkdirSync(targetDir, { recursive: true });
	writeJson(join(targetDir, "package.json"), packageJson);

	// Everything except dist is reconstructed from the exact HEAD archive. Never copy
	// package inputs from the working tree while claiming HEAD provenance.
	for (const entry of sourcePackageEntries) {
		copyIfExists(join(archivedSourceDir, entry), join(targetDir, entry), "archived package source");
	}
	// Build products are the sole working-tree overlay and are constrained to fixed
	// component dist roots, validated above for links and special files.
	copySafeTree(builtDist, join(targetDir, "dist"), "generated dist root");
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
	});

	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
	}

	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function authoritativeSourceCommit() {
	return run("git", ["rev-parse", "HEAD"], root);
}

function assertCleanTrackedSource() {
	const dirty = run("git", ["status", "--porcelain=v1", "--untracked-files=no"], root);
	if (dirty) {
		throw new Error("Refusing to pack a release from a tracked-dirty source checkout");
	}
}

function untrackedPaths() {
	const paths = new Set();
	for (const ignored of [false, true]) {
		const command = ["ls-files", "--others", "--exclude-standard", "-z"];
		if (ignored) command.splice(2, 0, "--ignored");
		for (const path of run("git", command, root).split("\0")) if (path) paths.add(resolve(root, path));
	}
	return paths;
}

function assertOnlyGeneratedUntrackedFiles() {
	const generatedRoots = releasePackages.map(({ packageDir }) => join(packagePath(packageDir), "dist"));
	const outputRoot = defaultOutputDir;
	for (const candidate of [...generatedRoots, outputRoot]) {
		if (existsSync(candidate)) assertNoSymlinks(candidate, "permitted untracked root");
	}
	for (const path of untrackedPaths()) {
		if (![...generatedRoots, outputRoot].some((allowed) => isWithin(path, allowed))) {
			throw new Error(`Refusing untracked file outside fixed generated roots/output dir: ${relative(root, path)}`);
		}
	}
}

function assertAuthoritativeSource(commit, args) {
	const sourceCommit = authoritativeSourceCommit();
	if (commit !== sourceCommit) {
		throw new Error(`--commit must exactly match authoritative source HEAD ${sourceCommit}`);
	}
	assertCleanTrackedSource();
	assertOnlyGeneratedUntrackedFiles();
	return sourceCommit;
}

function createImmutableSourceSnapshot(sourceCommit, sourceRoot) {
	const archivePath = join(sourceRoot, "source.tar");
	mkdirSync(sourceRoot, { recursive: true });
	run("git", ["archive", "--format=tar", "--output", archivePath, sourceCommit], root);
	const archiveRoot = join(sourceRoot, "archive");
	mkdirSync(archiveRoot, { recursive: true });
	run("tar", ["-xf", archivePath, "-C", archiveRoot], root);
	rmSync(archivePath, { force: true });
	assertNoSymlinks(archiveRoot, "immutable git archive");
	return archiveRoot;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	assertSafeOutputDir(args.outDir);
	const sourceCommit = assertAuthoritativeSource(args.commit, args);

	// Do not read package metadata or package inputs from the checkout. The archive
	// below is the immutable source of every non-generated package byte.
	rmSync(args.outDir, { force: true, recursive: true });
	const sourceRoot = join(args.outDir, ".immutable-source");
	const archiveRoot = createImmutableSourceSnapshot(sourceCommit, sourceRoot);
	const sourcePackages = new Map(
		releasePackages.map((releasePackage) => [
			releasePackage.packageDir,
			readJson(join(archiveRoot, "packages", releasePackage.packageDir, "package.json")),
		]),
	);
	const cliPackage = sourcePackages.get("coding-agent");
	const releaseVersion = args.version || normalizeVersion(process.env.PRIME_AGENT_VERSION || cliPackage.version);
	const builtDists = new Map(releasePackages.map((releasePackage) => [releasePackage.packageDir, assertBuiltPackage(releasePackage.packageDir)]));

	// Dependency keys stay on the source package names so existing compiled imports
	// keep resolving, while release package names and artifact filenames are branded.
	const sourcePackageNames = new Map();
	const packageNames = new Map();
	const artifactFiles = new Map();
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = releasePackage.packageName;
		sourcePackageNames.set(releasePackage.packageDir, sourcePackage.name);
		packageNames.set(releasePackage.packageDir, packageName);
		artifactFiles.set(releasePackage.packageDir, npmTarballName(releasePackage.artifactName, releaseVersion));
	}

	const internalPackageUrls = new Map();
	for (const releasePackage of releasePackages) {
		if (releasePackage.packageDir === "coding-agent") continue;
		const sourcePackageName = sourcePackageNames.get(releasePackage.packageDir);
		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		internalPackageUrls.set(sourcePackageName, releaseTarballUrl(args.baseUrl, releaseVersion, artifactFile));
	}

	const stagingRoot = join(args.outDir, "packages");
	const artifactsDir = join(args.outDir, "artifacts");
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(artifactsDir, { recursive: true });

	const tarballs = [];
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = packageNames.get(releasePackage.packageDir);
		const stagingDir = join(stagingRoot, releasePackage.packageDir);
		const packageJson = createReleasePackageJson(
			sourcePackage,
			packageName,
			releaseVersion,
			internalPackageUrls,
		);

		copyPackageContents(
			join(archiveRoot, "packages", releasePackage.packageDir),
			builtDists.get(releasePackage.packageDir),
			stagingDir,
			packageJson,
		);

		const tarballName = run("npm", ["pack", stagingDir, "--pack-destination", artifactsDir, "--silent"], root)
			.split("\n")
			.at(-1);
		if (!tarballName) {
			throw new Error(`npm pack did not report a tarball name for ${packageName}`);
		}

		const tarballPath = join(artifactsDir, basename(tarballName));
		if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
			throw new Error(`npm pack did not create ${tarballPath}`);
		}

		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		const artifactPath = join(artifactsDir, artifactFile);
		if (tarballPath !== artifactPath) {
			rmSync(artifactPath, { force: true });
			renameSync(tarballPath, artifactPath);
		}

		tarballs.push({
			component: releasePackage.component,
			package: packageName,
			version: releaseVersion,
			file: artifactFile,
			sha256: sha256File(artifactPath),
		});
	}
	writeFileSync(
		join(artifactsDir, "SHA256SUMS"),
		tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n",
	);
	writeFileSync(join(artifactsDir, args.channel), `v${releaseVersion}\n`);
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeJson(join(artifactsDir, manifestName), {
		version: `v${releaseVersion}`,
		source: {
			commit: args.commit,
		},
		package: publicPackageName,
		tarball: `releases/v${releaseVersion}/${artifactFiles.get("coding-agent")}`,
		tarballs,
	});

	for (const tarball of tarballs) {
		console.log(`Created ${join(artifactsDir, tarball.file)}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
