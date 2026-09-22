#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePlatforms } from "../../../scripts/release-platforms.mjs";
import { writeClipboardBinaryBinding } from "./clipboard-binary-binding.mjs";
import { copyBinaryAssets, validateBinaryAssets } from "./copy-binary-assets.mjs";
import { signMacosBinary } from "./macos-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDir = join(root, "packages/coding-agent");
const platforms = releasePlatforms;
const usage = `Usage: npm run build:binary -- [--platform ${[...platforms, "all"].join("|")}] [--test-signer-json <file>]`;

/**
 * The compiled binary pins its release signer at COMPILE time through the
 * `__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__` identifier in src/utils/release-trust.ts. Every build
 * defines it: `null` for a release binary (the hardcoded production signer applies), or - only when
 * `--test-signer-json <file>` is given - the file's JSON as a string literal, producing a TEST-ONLY
 * binary that trusts that signer instead and marks every signer line it prints. There is no runtime
 * way to set this; the only input is this build flag.
 */
export const RELEASE_SIGNER_OVERRIDE_IDENTIFIER = "__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__";
const RUNNER_ENVIRONMENTS = ["github-hosted", "self-hosted"];
const OVERRIDE_FIELDS = [
	"repositoryUri",
	"workflowRepositoryUri",
	"workflowPath",
	"oidcIssuer",
	"runnerEnvironment",
	"refPattern",
];

/** Parse the build arguments. Exported for the script tests. */
export function parseBuildArgs(args) {
	let platform;
	let testSignerJson;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--platform" && value !== undefined && platform === undefined) {
			platform = value;
			index += 1;
		} else if (arg === "--test-signer-json" && value !== undefined && testSignerJson === undefined) {
			testSignerJson = value;
			index += 1;
		} else {
			throw new Error(usage);
		}
	}
	platform ??= `${process.platform}-${process.arch}`;
	if (platform !== "all" && !platforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);
	return { platform, testSignerJson };
}

/**
 * Validate a test signer document before it is compiled in. The binary re-validates it at module
 * load with the same rules (src/utils/release-trust.ts), so this only fails the build early.
 */
export function validateTestSignerJson(text) {
	const document = JSON.parse(text);
	if (typeof document !== "object" || document === null || Array.isArray(document))
		throw new Error("The test signer document must be a JSON object.");
	for (const key of Object.keys(document)) {
		if (!OVERRIDE_FIELDS.includes(key)) throw new Error(`The test signer document has an unknown field ${key}.`);
	}
	for (const field of OVERRIDE_FIELDS) {
		if (typeof document[field] !== "string" || document[field].length === 0)
			throw new Error(`The test signer document must set ${field} to a non-empty string.`);
	}
	for (const field of ["repositoryUri", "workflowRepositoryUri", "oidcIssuer"]) {
		const url = new URL(document[field]);
		if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
			throw new Error(`The test signer document field ${field} must be a bare https URL.`);
	}
	if (!/^[^\s]+\.ya?ml$/.test(document.workflowPath) || document.workflowPath.startsWith("/"))
		throw new Error("The test signer document field workflowPath must be a relative path ending in .yml or .yaml.");
	if (!RUNNER_ENVIRONMENTS.includes(document.runnerEnvironment))
		throw new Error("The test signer document field runnerEnvironment must be github-hosted or self-hosted.");
	if (!document.refPattern.startsWith("^") || !document.refPattern.endsWith("$"))
		throw new Error("The test signer document field refPattern must be anchored with ^ and $.");
	new RegExp(document.refPattern);
	return document;
}

/** The exact `--define` arguments for a build. Exported for the script tests. */
export function releaseSignerDefineArgs(testSignerJson) {
	if (testSignerJson === undefined) return ["--define", `${RELEASE_SIGNER_OVERRIDE_IDENTIFIER}=null`];
	validateTestSignerJson(testSignerJson);
	return ["--define", `${RELEASE_SIGNER_OVERRIDE_IDENTIFIER}=${JSON.stringify(testSignerJson)}`];
}

/** Test-only binaries never land in the release output directory. */
export function binaryOutputRoot(testSignerJson) {
	return join(packageDir, testSignerJson === undefined ? "binaries" : "binaries-test-signer");
}

function main() {
	const { platform, testSignerJson: testSignerPath } = parseBuildArgs(process.argv.slice(2));
	const testSignerJson = testSignerPath === undefined ? undefined : readFileSync(testSignerPath, "utf8");
	const defineArgs = releaseSignerDefineArgs(testSignerJson);
	if (testSignerJson !== undefined)
		console.warn(`Building a TEST-ONLY binary that trusts the signer described in ${testSignerPath}.`);

	const bun = process.env.BUN_BINARY || "bun";
	const bunVersion = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
	if (bunVersion !== "1.4.0") throw new Error(`Binary compilation requires Bun 1.4.0; found ${bunVersion}`);

	// Emit workspace JavaScript and declarations using the committed model catalog.
	for (const name of ["tui", "ai", "agent", "coding-agent"]) {
		execFileSync(join(root, "node_modules/.bin/tsgo"), ["-p", `packages/${name}/tsconfig.build.json`], {
			cwd: root,
			stdio: "inherit",
		});
	}

	const buildId = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const outputRoot = binaryOutputRoot(testSignerJson);
	mkdirSync(outputRoot, { recursive: true });
	for (const target of platform === "all" ? platforms : [platform]) {
		const staging = mkdtempSync(join(outputRoot, ".build-"));
		try {
			writeClipboardBinaryBinding(join(packageDir, "dist/utils/clipboard-binary-binding.js"), target);
			execFileSync(
				bun,
				[
					"build",
					"--compile",
					"--minify",
					"--keep-names",
					"--bytecode",
					"--format=esm",
					"--external",
					"koffi",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-bunfig",
					"--define",
					`__PI_BUILD_ID__=${JSON.stringify(buildId)}`,
					...defineArgs,
					`--target=bun-${target}`,
					"./dist/bun/cli.js",
					"--outfile",
					join(staging, "prime-agent"),
				],
				{ cwd: packageDir, stdio: "inherit" },
			);
			signMacosBinary(join(staging, "prime-agent"), target);
			copyBinaryAssets(staging);
			validateBinaryAssets(staging);
			const destination = join(outputRoot, target);
			rmSync(destination, { recursive: true, force: true });
			renameSync(staging, destination);
			console.log(`Created ${destination}`);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
}

function isEntrypoint() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntrypoint()) main();
