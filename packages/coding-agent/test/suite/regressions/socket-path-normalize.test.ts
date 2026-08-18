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
	// Killed processes may still be flushing writes; wait for exit and tolerate
	// leftover temp entries so teardown races cannot fail the suite.
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
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		try {
			harness?.cleanup();
		} catch {
			// Tolerated (see teardown note).
		}
	}
	for (const dir of socketDirs) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 50 });
		} catch {
			// Tolerated (see teardown note).
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
				// Keeps late compile-cache writes from dying workers out of this test's dirs.
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

		const client = await connectEventually(paths.socketPath);

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

		const canonicalSocketPath = `${paths.socketDir}/daemon.sock`;
		const client = await connectEventually(canonicalSocketPath);

		const response = await client.request({ type: "list" });
		expect(response.success).toBe(true);
		expect(requireSessionList(response)).toHaveLength(0);

		await client.request({ type: "shutdown", force: true }, 10_000);
		client.close();
	}, 120_000);
});
