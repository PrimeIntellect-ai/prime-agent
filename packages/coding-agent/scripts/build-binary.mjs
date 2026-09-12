#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBinaryAssets, validateBinaryAssets } from "./copy-binary-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDir = join(root, "packages/coding-agent");
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const args = process.argv.slice(2);
const platform = args.length === 0 ? `${process.platform}-${process.arch}` : args[1];
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--platform")) {
	throw new Error("Usage: npm run build:binary -- [--platform darwin-arm64|darwin-x64|linux-arm64|linux-x64|all]");
}
if (platform !== "all" && !platforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);

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
const outputRoot = join(packageDir, "binaries");
mkdirSync(outputRoot, { recursive: true });
for (const target of platform === "all" ? platforms : [platform]) {
	const staging = mkdtempSync(join(outputRoot, ".build-"));
	try {
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
				`--target=bun-${target}`,
				"./dist/bun/cli.js",
				"--outfile",
				join(staging, "prime-agent"),
			],
			{ cwd: packageDir, stdio: "inherit" },
		);
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
