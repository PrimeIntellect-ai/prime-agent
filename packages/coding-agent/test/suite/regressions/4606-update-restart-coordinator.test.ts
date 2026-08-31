import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DaemonUpdateRestartStatusWriter,
	launchDaemonUpdateRestartCoordinator,
	readDaemonUpdateRestartStatus,
} from "../../../src/cli/daemon-update-restart.js";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "../harness.js";

interface SupervisorHandle {
	child: ChildProcess;
	stdout: string;
	stderr: string;
}

interface SupervisorOwnerRecord {
	pid: number;
	processStartId?: string;
	socketPath: string;
}

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/eng-4600-faux-extension.ts");
const launcherFixturePath = resolve(__dirname, "../../fixtures/eng-4606-update-launcher.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const supervisors = new Set<SupervisorHandle>();
const harnesses: Harness[] = [];
const sockets = new Set<string>();

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function spawnSupervisor(paths: {
	agentDir: string;
	completionPath: string;
	pidPath: string;
	registryDir: string;
	socketPath: string;
}): SupervisorHandle {
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", paths.socketPath, "--offline"],
		{
			cwd: paths.agentDir,
			env: {
				...process.env,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				ENG_4606_AGENT_DIR: paths.agentDir,
				ENG_4606_CLI_PATH: cliPath,
				ENG_4606_COMPLETION_PATH: paths.completionPath,
				ENG_4606_PID_PATH: paths.pidPath,
				ENG_4606_SOCKET_PATH: paths.socketPath,
				ENG_4606_TSX_PATH: tsxPath,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const handle: SupervisorHandle = { child, stdout: "", stderr: "" };
	supervisors.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.stderr += chunk.toString("utf8");
	});
	return handle;
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

async function waitForExit(child: ChildProcess, timeoutMs = 60_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error(`Timed out waiting for process ${child.pid} to exit`)),
			timeoutMs,
		);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForProcessExit(pid: number, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await delay(25);
	}
	throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			return;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForTerminalStatus(agentDir: string, timeoutMs = 120_000) {
	const directory = join(agentDir, "update-restarts");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(directory)) {
			// The writer stages "<name>.json.<pid>.<uuid>.tmp" files in this directory
			// before its atomic rename; parsing one mid-write reads torn JSON.
			for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
				const path = join(directory, name);
				const status = readDaemonUpdateRestartStatus(path);
				if (status && (status.phase === "complete" || status.phase === "failed" || status.phase === "skipped")) {
					return { path, status };
				}
			}
		}
		await delay(50);
	}
	throw new Error(`Timed out waiting for update restart status in ${directory}`);
}

function requireSessionSummary(response: DaemonResponse): SessionSummary {
	if (!response.success) {
		throw new Error(response.error);
	}
	if (!response.data || typeof response.data !== "object") {
		throw new Error("Daemon returned an invalid session summary");
	}
	const summary = response.data as Partial<SessionSummary>;
	if (typeof summary.id !== "string" || typeof summary.sessionId !== "string") {
		throw new Error("Daemon returned an invalid session summary");
	}
	return summary as SessionSummary;
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withSourceCliEntrypoint<T>(action: () => Promise<T>): Promise<T> {
	const previousEntrypoint = process.argv[1];
	if (!previousEntrypoint) {
		throw new Error("Test process has no CLI entrypoint");
	}
	const previousExecArgv = [...process.execArgv];
	const previousTsconfigPath = process.env.TSX_TSCONFIG_PATH;
	process.argv[1] = cliPath;
	process.execArgv.splice(0, process.execArgv.length, tsxPath);
	process.env.TSX_TSCONFIG_PATH = tsconfigPath;
	try {
		return await action();
	} finally {
		process.argv[1] = previousEntrypoint;
		process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
		if (previousTsconfigPath === undefined) {
			delete process.env.TSX_TSCONFIG_PATH;
		} else {
			process.env.TSX_TSCONFIG_PATH = previousTsconfigPath;
		}
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function listSupervisorOwnerRecords(registryDir: string): SupervisorOwnerRecord[] {
	if (!existsSync(registryDir)) {
		return [];
	}
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => JSON.parse(readFileSync(join(registryDir, name, "owner.json"), "utf8")) as SupervisorOwnerRecord);
}

async function stopDaemon(socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(500);
		await client.waitForHello(2000);
		await client.request({ type: "shutdown", force: true }, 5000).catch(() => undefined);
	} catch {
		return;
	} finally {
		client.close();
	}
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const probe = new DaemonClient(socketPath);
		try {
			await probe.connect(250);
		} catch {
			probe.close();
			return;
		}
		probe.close();
		await delay(25);
	}
}

afterEach(async () => {
	for (const socketPath of sockets) {
		await stopDaemon(socketPath).catch(() => undefined);
	}
	sockets.clear();
	for (const supervisor of supervisors) {
		if (supervisor.child.exitCode === null && supervisor.child.signalCode === null) {
			supervisor.child.kill("SIGKILL");
			await waitForExit(supervisor.child).catch(() => undefined);
		}
	}
	supervisors.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("ENG-4606 update restart coordinator", () => {
	it("refreshes coordinator liveness without changing restart state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const statusPath = join(harness.tempDir, "restart-status.json");

		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
			const writer = new DaemonUpdateRestartStatusWriter(statusPath, "test-request", "/tmp/daemon.sock");
			const stopHeartbeat = writer.startHeartbeat();
			vi.advanceTimersByTime(5000);
			stopHeartbeat();

			expect(readDaemonUpdateRestartStatus(statusPath)).toMatchObject({
				phase: "starting",
				startedAt: "2026-07-14T00:00:00.000Z",
				updatedAt: "2026-07-14T00:00:00.000Z",
				heartbeatAt: "2026-07-14T00:00:05.000Z",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects coordinator spawn errors without terminating the updater", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(
			launchDaemonUpdateRestartCoordinator({
				socketPath: join(harness.tempDir, "missing-daemon.sock"),
				agentDir: harness.tempDir,
				cwd: join(harness.tempDir, "missing-cwd"),
				timeoutMs: 5000,
			}),
		).rejects.toThrow();
	});

	it("keeps a relative agent directory stable across coordinator cwd changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "relative-agent");
		const coordinatorCwd = join(harness.tempDir, "coordinator-cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(coordinatorCwd, { recursive: true });
		const socketPath = join(harness.tempDir, "missing-daemon.sock");

		const status = await withSourceCliEntrypoint(() =>
			launchDaemonUpdateRestartCoordinator({
				socketPath,
				agentDir: relative(process.cwd(), agentDir),
				cwd: coordinatorCwd,
				timeoutMs: 30_000,
			}),
		);

		expect(status).toMatchObject({ phase: "skipped", socketPath });
	});

	it("resolves a relative custom socket before changing coordinator cwd", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const coordinatorCwd = join(harness.tempDir, "coordinator-cwd");
		mkdirSync(coordinatorCwd, { recursive: true });
		const socketPath = join(harness.tempDir, "missing-daemon.sock");

		const status = await withSourceCliEntrypoint(() =>
			launchDaemonUpdateRestartCoordinator({
				socketPath: relative(process.cwd(), socketPath),
				agentDir: harness.tempDir,
				cwd: coordinatorCwd,
				timeoutMs: 30_000,
			}),
		);

		expect(status).toMatchObject({ phase: "skipped", socketPath });
	});

	it("outlives a daemon-owned updater and restores the exact custom socket", async () => {
		if (process.platform === "win32") {
			return;
		}
		const harness = await createHarness();
		harnesses.push(harness);
		const paths = {
			agentDir: harness.tempDir,
			completionPath: join(harness.tempDir, "updater-completed"),
			pidPath: join(harness.tempDir, "updater.pid"),
			registryDir: join(harness.tempDir, "supervisor-registry"),
			socketPath: join(harness.tempDir, "custom-daemon.sock"),
		};
		sockets.add(paths.socketPath);
		const predecessor = spawnSupervisor(paths);
		const client = await connectEventually(paths.socketPath);
		const predecessorHello = await client.waitForHello(2000);
		const created = requireSessionSummary(
			await client.request(
				{
					type: "create",
					config: {
						agentDir: paths.agentDir,
						apiKey: "faux-key",
						cwd: paths.agentDir,
						extensions: [fauxExtensionPath],
						model: "faux",
						noContextFiles: true,
						noExtensions: false,
						noSkills: true,
						noTools: true,
						provider: "faux",
					},
				},
				60_000,
			),
		);
		const originalActiveSessionId = created.activeSessionId ?? created.id;
		const updateCommand = [process.execPath, tsxPath, launcherFixturePath].map(shellQuote).join(" ");
		const executeResponse = await client.request(
			{ type: "execute_bash", activeSessionId: originalActiveSessionId, command: updateCommand },
			5000,
		);
		expect(executeResponse.success).toBe(true);
		await waitForFile(paths.pidPath);
		const updaterPid = Number(readFileSync(paths.pidPath, "utf8").trim());
		expect(Number.isInteger(updaterPid)).toBe(true);

		const { status } = await waitForTerminalStatus(paths.agentDir);
		if (status.phase === "failed") {
			throw new Error(
				`Coordinator failed: ${status.message}\npredecessor stderr:\n${predecessor.stderr}\npredecessor stdout:\n${predecessor.stdout}`,
			);
		}
		expect(status).toMatchObject({
			phase: "complete",
			socketPath: paths.socketPath,
			counts: { total: 1, restored: 1, resumed: 1, failed: 0 },
		});
		expect(status.predecessor?.pid).toBe(predecessorHello.supervisorPid);
		expect(status.successor?.pid).not.toBe(status.predecessor?.pid);
		expect(existsSync(paths.completionPath)).toBe(false);
		expect(isProcessAlive(updaterPid)).toBe(false);
		client.close();
		await waitForExit(predecessor.child);

		const replacementClient = await connectEventually(paths.socketPath);
		const replacementHello = await replacementClient.waitForHello(2000);
		expect(replacementHello.supervisorSocketPath).toBe(resolve(paths.socketPath));
		const sessions = requireSessionList(await replacementClient.request({ type: "list" }, 30_000));
		expect(sessions).toHaveLength(1);
		const restored = sessions[0];
		if (!restored) {
			throw new Error("Restored session was not listed");
		}
		const restoredActiveSessionId = restored.activeSessionId ?? restored.id;
		const connection = await DaemonAgentConnection.attach(replacementClient, restoredActiveSessionId, {
			closeClientOnDispose: true,
		});
		await connection.getInitialSnapshot();
		await connection.waitForIdle();
		expect(await connection.getMessages()).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "prime-agent.update_complete",
				display: true,
			}),
		);
		await connection.dispose();

		const owners = listSupervisorOwnerRecords(paths.registryDir);
		expect(owners).toHaveLength(1);
		expect(owners[0]).toMatchObject({ pid: status.successor?.pid, socketPath: resolve(paths.socketPath) });
		await stopDaemon(paths.socketPath);
		sockets.delete(paths.socketPath);
		if (replacementHello.supervisorPid === undefined) {
			throw new Error("Replacement daemon did not report its supervisor PID");
		}
		await waitForProcessExit(replacementHello.supervisorPid);
	}, 180_000);
});
