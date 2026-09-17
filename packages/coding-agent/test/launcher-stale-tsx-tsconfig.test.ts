import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";

const repoRoot = resolve(__dirname, "../../..");
const launcherPath = join(repoRoot, "prime-agent.sh");
const launcherTimeoutMs = 30_000;

interface LauncherRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-launcher-tsconfig-test-"));
	tempDirs.push(directory);
	return directory;
}

function runLauncher(env: NodeJS.ProcessEnv, cwd: string): Promise<LauncherRun> {
	const child = spawn("bash", [launcherPath, "--version"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	children.add(child);
	const run: LauncherRun = { code: null, stdout: "", stderr: "" };
	child.stdout?.on("data", (chunk: Buffer) => {
		run.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		run.stderr += chunk.toString("utf8");
	});
	return new Promise<LauncherRun>((resolveRun, rejectRun) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectRun(new Error(`launcher did not exit within ${launcherTimeoutMs}ms`));
		}, launcherTimeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			run.code = code;
			resolveRun(run);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectRun(error);
		});
	});
}

// The CLI takes over stdout for non-interactive runs, so --version prints to stderr.
function expectLauncherStarted(result: LauncherRun): void {
	expect(result.code).toBe(0);
	expect(result.stderr).toContain(VERSION);
}

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

describe("source launcher tsconfig pinning", () => {
	it.runIf(process.platform !== "win32")(
		"starts with TSX_TSCONFIG_PATH pointing at a removed external checkout",
		async () => {
			const outside = tempDir();
			const staleTsconfigPath = join(outside, "removed-checkout", "tsconfig.json");
			const result = await runLauncher({ ...process.env, TSX_TSCONFIG_PATH: staleTsconfigPath }, outside);
			expectLauncherStarted(result);
			expect(result.stderr).not.toContain("Cannot resolve tsconfig");
		},
	);

	it.runIf(process.platform !== "win32")(
		"starts with TSX_TSCONFIG_PATH pointing at another checkout's tsconfig",
		async () => {
			const outside = tempDir();
			const otherCheckout = join(outside, "other-checkout");
			mkdirSync(otherCheckout, { recursive: true });
			writeFileSync(join(otherCheckout, "tsconfig.json"), `{\n\t"compilerOptions": {}\n}\n`);
			const result = await runLauncher(
				{ ...process.env, TSX_TSCONFIG_PATH: join(otherCheckout, "tsconfig.json") },
				outside,
			);
			expectLauncherStarted(result);
			expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
		},
	);

	it.runIf(process.platform !== "win32")("starts from outside the checkout without TSX_TSCONFIG_PATH", async () => {
		const outside = tempDir();
		const env = { ...process.env };
		delete env.TSX_TSCONFIG_PATH;
		const result = await runLauncher(env, outside);
		expectLauncherStarted(result);
		expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
	});
});
