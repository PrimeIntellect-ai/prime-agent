import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

/**
 * Cold real-CLI stdin guard coverage.
 *
 * Non-interactive parents (daemon workers, agent harnesses, CI runners) spawn
 * this CLI with a stdin pipe they never write to and never close. The boot-time
 * piped-stdin read must give up on that pipe instead of hanging the process
 * forever — a bug that previously left daemons "starting" for minutes while the
 * client sat in readPipedStdin().
 *
 * Every spawn here keeps the child's stdin write end open and silent for the
 * whole run, and every wait has an explicit deadline: a hang surfaces as a
 * SIGKILL exit and a test failure, never a stuck test process.
 */

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");

interface ColdRun {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

const tempRoots: string[] = [];
const cleanupBoundMs = 30_000;

function makeEnv(agentDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		[ENV_AGENT_DIR]: agentDir,
		HOME: agentDir,
		TSX_TSCONFIG_PATH: tsconfigPath,
		// Keep the guard's give-up window short and deterministic.
		PI_STDIN_TIMEOUT_MS: "300",
		...extra,
	};
}

function newTempRoot(): { tempRoot: string; agentDir: string } {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-stdin-guard-"));
	tempRoots.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { tempRoot, agentDir };
}

function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/** Run the real CLI non-interactively with a held-open, silent stdin pipe. */
function runColdCli(
	args: string[],
	options: { timeoutMs: number; ipc?: boolean; extraEnv?: Record<string, string> },
): Promise<ColdRun> {
	const { tempRoot, agentDir } = newTempRoot();
	return new Promise((resolveRun, rejectRun) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: tempRoot,
			env: makeEnv(agentDir, options.extraEnv),
			stdio: options.ipc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		// Deliberately never write to and never close child.stdin: this is the
		// held-open pipe shape a non-interactive parent produces.
		// test-policy: allow wall-clock-timer -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
		const killTimer = setTimeout(() => killTree(child), options.timeoutMs);
		child.once("error", (error) => {
			clearTimeout(killTimer);
			rejectRun(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(killTimer);
			resolveRun({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
		});
	});
}

/** Stop a daemon this test spawned on an isolated socket. Bounded. */
async function shutdownDaemon(socketPath: string, agentDir: string, tempRoot: string): Promise<void> {
	await new Promise<void>((resolveShutdown) => {
		const child = spawn(
			process.execPath,
			[tsxPath, cliPath, "daemon", "shutdown", "--force", "--socket", socketPath],
			{
				cwd: tempRoot,
				env: makeEnv(agentDir),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		// test-policy: allow wall-clock-timer -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
		const killTimer = setTimeout(() => child.kill("SIGKILL"), cleanupBoundMs);
		child.once("close", () => {
			clearTimeout(killTimer);
			resolveShutdown();
		});
		child.once("error", () => {
			clearTimeout(killTimer);
			resolveShutdown();
		});
	});
}

const daemonSockets: { socketPath: string; agentDir: string; tempRoot: string }[] = [];

afterEach(async () => {
	for (const target of daemonSockets.splice(0)) {
		await shutdownDaemon(target.socketPath, target.agentDir, target.tempRoot);
	}
	for (const dir of tempRoots.splice(0)) {
		// The CLI's daemon/kernel children may still be flushing caches under this
		// dir when the child exits; retry the ENOTEMPTY/EBUSY window instead of failing cleanup.
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

describe("cold CLI stdin guard", () => {
	it("exits --version cleanly without reading a held-open stdin", async () => {
		const result = await runColdCli(["--version"], { timeoutMs: 20_000 });
		expect(result.signal).toBeNull();
		expect(result.code).toBe(0);
		// Non-interactive mode takes over stdout, so console output lands on stderr.
		expect(`${result.stdout}${result.stderr}`).toMatch(/\d+\.\d+\.\d+/);
		expect(result.elapsedMs).toBeLessThan(20_000);
		// test-policy: allow explicit-test-timeout -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
	}, 30_000);

	it("does not hang a non-interactive owned-worker print boot on a held-open stdin pipe", async () => {
		// The owned-worker shape boots the in-process runtime (no daemon) and
		// still runs the boot-time piped-stdin read; the ipc channel satisfies
		// the owner watch this role installs.
		const result = await runColdCli(["--print", "--offline", "--no-session", "Say hi"], {
			timeoutMs: 30_000,
			ipc: true,
			extraEnv: { PRIME_AGENT_INTERNAL_OWNED_WORKER: "1" },
		});
		// The old behavior hung here forever: the child never exits and the
		// bound SIGKILLs it (signal SIGKILL, code null).
		expect(result.signal).toBeNull();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("stdin did not close within 300ms");
		expect(result.elapsedMs).toBeLessThan(30_000);
		// test-policy: allow explicit-test-timeout -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
	}, 45_000);

	it("does not hang a daemon-client print boot on a held-open stdin pipe", async () => {
		// The daemon-client shape is the reported bug: the early daemon spawn
		// succeeds, the daemon worker boots, but the client sits in the
		// boot-time stdin read and never reaches daemon readiness.
		const { tempRoot, agentDir } = newTempRoot();
		const socketPath = join(tempRoot, "daemon.sock");
		daemonSockets.push({ socketPath, agentDir, tempRoot });
		const result = await runColdCli(
			["--print", "--offline", "--no-session", "--daemon-socket", socketPath, "Say hi"],
			{ timeoutMs: 90_000 },
		);
		expect(result.signal).toBeNull();
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("stdin did not close within 300ms");
		expect(result.elapsedMs).toBeLessThan(90_000);
		// test-policy: allow explicit-test-timeout -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
	}, 150_000);
});
