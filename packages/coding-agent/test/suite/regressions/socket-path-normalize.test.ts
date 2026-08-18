import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "../harness.js";

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

const supervisors = new Set<ChildProcess>();
const harnesses: Harness[] = [];
const socketDirs = new Set<string>();

afterEach(async () => {
	// Wait for killed supervisors to fully exit before removing their
	// directories; a dying process may still be flushing writes, which makes
	// recursive removal race into ENOTEMPTY.
	await Promise.all(
		[...supervisors].map((child) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				return undefined;
			}
			const exited = new Promise<void>((resolveExit) => {
				child.once("exit", () => resolveExit());
				setTimeout(resolveExit, 10_000).unref();
			});
			child.kill("SIGKILL");
			return exited;
		}),
	);
	supervisors.clear();
	// Workers exit asynchronously after their supervisor and may still be
	// flushing writes; leftover temp entries must not fail the suite.
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		try {
			harness?.cleanup();
		} catch {
			// Tolerated: the OS reclaims the temp directory.
		}
	}
	for (const dir of socketDirs) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 50 });
		} catch {
			// Tolerated: the OS reclaims the temp directory.
		}
	}
	socketDirs.clear();
}, 60_000);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestPaths {
	agentDir: string;
	registryDir: string;
	socketDir: string;
	socketPath: string;
}

async function createPaths(suffix: string): Promise<TestPaths> {
	const harness = await createHarness();
	harnesses.push(harness);
	const socketDir = `/tmp/socknorm-${process.pid}-${Date.now()}-${suffix}`;
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	socketDirs.add(socketDir);
	return {
		agentDir: harness.tempDir,
		registryDir: join(harness.tempDir, "registry"),
		socketDir,
		socketPath: `${socketDir}//daemon.sock`,
	};
}

function spawnSupervisor(paths: TestPaths): ChildProcess {
	const child = spawn(
		process.execPath,
		[
			tsxPath,
			cliPath,
			"--mode",
			"daemon",
			"--daemon-socket",
			paths.socketPath,
			"--offline",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
		],
		{
			cwd: paths.agentDir,
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(([key]) => !key.startsWith("PRIME_AGENT_INTERNAL_")),
				),
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				// Spawned workers can outlive the SIGKILLed supervisor and keep
				// flushing compile-cache writes into TMPDIR, which makes cleanup
				// race into ENOTEMPTY; keep their caches out of this test's dirs.
				NODE_DISABLE_COMPILE_CACHE: "1",
				PI_OFFLINE: "1",
				TMPDIR: paths.socketDir,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	supervisors.add(child);
	return child;
}

async function connectEventually(socketPath: string, timeoutMs = 60_000): Promise<DaemonClient> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.waitForHello(2000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(25);
		}
	}
	throw new Error(`Timed out connecting to ${socketPath}: ${String(lastError)}`);
}

function requireSessionList(response: DaemonResponse): SessionSummary[] {
	if (!response.success) {
		throw new Error(response.error);
	}
	if (!response.data || typeof response.data !== "object" || !("sessions" in response.data)) {
		throw new Error("Daemon returned an invalid session list");
	}
	const sessions = (response.data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon returned an invalid session list");
	}
	return sessions as SessionSummary[];
}

describe("daemon socket path normalization", () => {
	it("connects to a daemon started with a double-slash socket path and lists sessions", async () => {
		if (process.platform === "win32") return;

		const paths = await createPaths("double-slash");
		spawnSupervisor(paths);

		// Connect using the same double-slash spelling the supervisor was started with.
		const client = await connectEventually(paths.socketPath);

		// A fresh daemon with no agents should return an empty session list.
		const response = await client.request({ type: "list" });
		expect(response.success).toBe(true);
		expect(requireSessionList(response)).toHaveLength(0);

		await client.request({ type: "shutdown", force: true }, 10_000);
		client.close();
	}, 120_000);

	it("connects to a daemon via the canonical spelling when started with a double-slash path", async () => {
		if (process.platform === "win32") return;

		const paths = await createPaths("canonical-connect");
		spawnSupervisor(paths);

		// The supervisor normalizes the double-slash path; connecting with the
		// canonical single-slash spelling should also succeed.
		const canonicalSocketPath = `${paths.socketDir}/daemon.sock`;
		const client = await connectEventually(canonicalSocketPath);

		const response = await client.request({ type: "list" });
		expect(response.success).toBe(true);
		expect(requireSessionList(response)).toHaveLength(0);

		await client.request({ type: "shutdown", force: true }, 10_000);
		client.close();
	}, 120_000);
});
