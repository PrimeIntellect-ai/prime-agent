#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBinary = join(rootDir, "packages", "coding-agent", "dist", "pi");
const defaultDist = dirname(defaultBinary);

export const REQUIRED_BINARY_SIDECARS = [
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
] as const;

type RunResult = {
	args: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
};

function run(executable: string, args: string[], cwd: string, path: string): RunResult {
	const result = spawnSync(executable, args, {
		cwd,
		env: { ...process.env, PATH: path },
		encoding: "utf8",
	});
	return {
		args,
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
}

export function inspectNativeExecutable(path: string): "elf" | "mach-o" | "unknown" {
	const header = readFileSync(path).subarray(0, 4).toString("hex");
	if (header === "7f454c46") return "elf";
	if ([
		"feedface", "cefaedfe", "feedfacf", "cffaedfe",
		"cafebabe", "bebafeca", "cafebabf", "bfbafeca",
	].includes(header)) return "mach-o";
	return "unknown";
}

export function runEmptyDiagnostic(binaryPath = defaultBinary) {
	if (!existsSync(binaryPath)) throw new Error(`Compiled binary not found: ${binaryPath}`);
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-binary-empty-"));
	try {
		const binary = join(tempDir, basename(binaryPath));
		copyFileSync(binaryPath, binary);
		chmodSync(binary, 0o755);
		const emptyPath = join(tempDir, "empty-path");
		mkdirSync(emptyPath);
		const runResult = run(binary, ["--version"], tempDir, emptyPath);
		return {
			mode: "binary-only-diagnostic" as const,
			nativeFormat: inspectNativeExecutable(binary),
			run: runResult,
			detectedMissingPackageJson: runResult.exitCode !== 0 && runResult.stderr.includes("package.json"),
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export function runPackagedSmoke(binaryPath = defaultBinary, sourceDist = defaultDist) {
	if (!existsSync(binaryPath)) throw new Error(`Compiled binary not found: ${binaryPath}`);
	const missing = REQUIRED_BINARY_SIDECARS.filter((name) => !existsSync(join(sourceDist, name)));
	if (missing.length > 0) throw new Error(`Missing compiled-binary sidecars: ${missing.join(", ")}`);

	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-binary-package-"));
	try {
		const binary = join(tempDir, basename(binaryPath));
		copyFileSync(binaryPath, binary);
		chmodSync(binary, 0o755);
		for (const name of REQUIRED_BINARY_SIDECARS) {
			cpSync(join(sourceDist, name), join(tempDir, name), { recursive: true, dereference: true });
		}

		const emptyPath = join(tempDir, "empty-path");
		mkdirSync(emptyPath);
		let nodeAvailable = false;
		let npmAvailable = false;
		try { nodeAvailable = run("node", ["--version"], tempDir, emptyPath).exitCode === 0; } catch {}
		try { npmAvailable = run("npm", ["--version"], tempDir, emptyPath).exitCode === 0; } catch {}
		const runs = [["--version"], ["--help"]].map((args) => run(binary, args, tempDir, emptyPath));
		const passed =
			inspectNativeExecutable(binary) !== "unknown" &&
			!nodeAvailable &&
			!npmAvailable &&
			runs.every((result) => result.exitCode === 0 && result.stdout.trim().length > 0);
		return {
			mode: "packaged-layout-smoke" as const,
			nativeFormat: inspectNativeExecutable(binary),
			binarySizeBytes: statSync(binary).size,
			path: emptyPath,
			nodeAvailable,
			npmAvailable,
			sidecars: [...REQUIRED_BINARY_SIDECARS],
			runs,
			passed,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
	const binary = resolve(argumentValue("--binary") ?? defaultBinary);
	const sourceDist = resolve(argumentValue("--dist") ?? dirname(binary));
	try {
		const empty = runEmptyDiagnostic(binary);
		const packaged = runPackagedSmoke(binary, sourceDist);
		console.log(JSON.stringify({
			empty: {
				mode: empty.mode,
				nativeFormat: empty.nativeFormat,
				exitCode: empty.run.exitCode,
				detectedMissingPackageJson: empty.detectedMissingPackageJson,
			},
			packaged: {
				mode: packaged.mode,
				nativeFormat: packaged.nativeFormat,
				binarySizeBytes: packaged.binarySizeBytes,
				nodeAvailable: packaged.nodeAvailable,
				npmAvailable: packaged.npmAvailable,
				sidecars: packaged.sidecars,
				runs: packaged.runs.map((result) => ({
					args: result.args,
					exitCode: result.exitCode,
					stdoutLength: result.stdout.length,
					stderrLength: result.stderr.length,
				})),
				passed: packaged.passed,
			},
		}, null, 2));
		if (empty.nativeFormat === "unknown" || !empty.detectedMissingPackageJson || !packaged.passed) process.exit(1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
