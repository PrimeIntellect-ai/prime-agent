import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getCronJobsPath } from "../src/config.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { readActiveOrphanProcesses } from "../src/core/orphan-process-journal.js";
import {
	acquireSessionLease,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient, getDaemonSocketCloseReason } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const blockingProcessPath = resolve(__dirname, "fixtures/blocking-process.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const daemonSockets = new Set<string>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
const PROCESS_STRESS_WORKERS = Number.parseInt(process.env.PRIME_AGENT_STRESS_WORKERS ?? "10", 10);

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown" }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	children.clear();
	for (const pid of workerPids) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {
			// Already gone.
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-daemon-supervisor-test-"));
	tempDirs.push(directory);
	return directory;
}

function spawnSupervisor(
	agentDir: string,
	socketPath: string,
	cwd: string,
	extraArgs: readonly string[] = [],
	extraEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline", ...extraArgs],
		{
			cwd,
			env: {
				...process.env,
				...extraEnv,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

function readDaemonLogs(agentDir: string): string {
	const logsDir = join(agentDir, "logs");
	try {
		return readdirSync(logsDir)
			.map((name) => `${name}:\n${readFileSync(join(logsDir, name), "utf8")}`)
			.join("\n");
	} catch {
		return "no daemon logs";
	}
}

function readWorkerDescriptor(agentDir: string): DaemonWorkerDescriptor {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const descriptorDirectory = join(workersRoot, directory);
		for (const name of readdirSync(descriptorDirectory)) {
			if (name.endsWith(".json")) {
				return JSON.parse(readFileSync(join(descriptorDirectory, name), "utf8")) as DaemonWorkerDescriptor;
			}
		}
	}
	throw new Error("Worker descriptor was not persisted");
}

function countWorkerDescriptors(agentDir: string): number {
	const workersRoot = join(agentDir, "daemon-workers");
	try {
		return readdirSync(workersRoot).reduce((count, directory) => {
			return count + readdirSync(join(workersRoot, directory)).filter((name) => name.endsWith(".json")).length;
		}, 0);
	} catch {
		return 0;
	}
}

async function waitForWorkerStopTombstone(agentDir: string): Promise<DaemonWorkerDescriptor> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const descriptor = readWorkerDescriptor(agentDir);
			if (descriptor.stopRequestedAt) {
				return descriptor;
			}
		} catch {
			// The descriptor directory may still be appearing.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Worker stop tombstone was not persisted");
}

function readSupervisorConfig(agentDir: string): { defaultSessionConfig?: { sessionDir?: string; noTools?: boolean } } {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const path = join(workersRoot, directory, "supervisor-config");
		try {
			return JSON.parse(readFileSync(path, "utf8")) as {
				defaultSessionConfig?: { sessionDir?: string; noTools?: boolean };
			};
		} catch {
			// Continue looking for the descriptor directory for this daemon socket.
		}
	}
	throw new Error("Supervisor config was not persisted");
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			const diagnostics = childDiagnostics.get(child);
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})\n` +
					`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out waiting for supervisor: ${String(lastError)}`);
}

async function waitForSocketGone(socketPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(100);
		} catch {
			client.close();
			return;
		}
		client.close();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error("Daemon supervisor socket remained available after shutdown");
}

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function requireSessionList(responseData: unknown): SessionSummary[] {
	if (!responseData || typeof responseData !== "object" || !("sessions" in responseData)) {
		throw new Error("Missing daemon session list");
	}
	const sessions = (responseData as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Invalid daemon session list");
	}
	return sessions as SessionSummary[];
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

async function waitForCondition(predicate: () => boolean, failureMessage: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(failureMessage);
}

function quoteShellArgument(argument: string): string {
	return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

async function startBlockingBash(client: DaemonClient, activeSessionId: string, readyPath: string): Promise<void> {
	const command = [process.execPath, blockingProcessPath, readyPath].map(quoteShellArgument).join(" ");
	const response = await client.request({ type: "execute_bash", activeSessionId, command });
	if (!response.success) {
		throw new Error(response.error);
	}
	await waitForCondition(() => existsSync(readyPath), `Blocking bash process did not become ready: ${readyPath}`);
}

describe("daemon supervisor resident workers", () => {
	it("accepts the canonical socket path when launched with duplicate slashes", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, `${root}//daemon.sock`, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const response = await client.request({ type: "list" });

		expect(response.success).toBe(true);
		expect(requireSessionList(response.success ? response.data : undefined)).toHaveLength(0);
		await client.request({ type: "shutdown", force: true });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("creates top-level sessions at depth zero when the supervisor inherits a child depth", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-depth-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, [], { RLM_DEPTH: "1" });
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) throw new Error(created.error);
		const summary = requireSummary(created.data);
		if (!summary.workerPid || !summary.sessionFile) throw new Error("Worker did not expose its session identity");
		workerPids.add(summary.workerPid);

		expect(summary).toMatchObject({ runtimeKind: "top-level", rlmDepth: 0 });
		expect(await readSessionInfo(summary.sessionFile)).toMatchObject({ rlmDepth: 0, parentSessionPath: undefined });

		await client.request({ type: "shutdown" });
		client.close();
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("lists, creates, and attaches passive children through their owning worker", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-passive-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const parentManager = SessionManager.create(projectDir, sessionDir);
		parentManager.appendMessage({ role: "user", content: "parent fixture", timestamp: 1 });
		parentManager.flushNow();
		const parentSessionFile = parentManager.getSessionFile();
		const parentArtifactDir = parentManager.getSessionArtifactDir();
		if (!parentSessionFile || !parentArtifactDir) throw new Error("Missing parent fixture paths");

		const makeChild = (childId: string, sessionName: string, timestamp: number) => {
			const childSessionDir = join(parentArtifactDir, childId);
			const manager = SessionManager.create(projectDir, childSessionDir);
			manager.newSession({ parentSession: parentSessionFile });
			manager.appendSessionInfo(sessionName);
			manager.appendMessage({ role: "user", content: `completed ${childId} fixture`, timestamp });
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing child fixture path");
			return { childId, sessionName, childSessionDir, manager, sessionFile };
		};
		const child = makeChild("passive-child", "passive-child-worker", 2);
		const createChild = makeChild("passive-create-child", "passive-create-worker", 3);
		writeFileSync(
			join(parentArtifactDir, "rlm-subagents.jsonl"),
			`${[child, createChild]
				.map((fixture) =>
					JSON.stringify({
						type: "rlm_subagent",
						childId: fixture.childId,
						sessionName: fixture.sessionName,
						sessionDir: fixture.childSessionDir,
						sessionFile: fixture.sessionFile,
						parentSessionId: parentManager.getSessionId(),
						parentSessionFile,
						rlmDepth: 1,
						rlmMaxDepth: 4,
						rlmParentNodeId: fixture.childId,
						status: "completed",
						createdAt: 1,
						updatedAt: "2026-01-01T00:00:00.000Z",
					}),
				)
				.join("\n")}
`,
		);

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: parentSessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(created.success).toBe(true);
		const parentSummary = requireSummary(created.success ? created.data : undefined);
		if (!parentSummary.workerPid) throw new Error("Parent worker did not expose its pid");
		workerPids.add(parentSummary.workerPid);

		const beforeAttach = await client.request({ type: "list" });
		expect(beforeAttach.success).toBe(true);
		const passiveSummary = requireSessionList(beforeAttach.success ? beforeAttach.data : undefined).find(
			(summary) => summary.sessionFile === child.sessionFile,
		);
		expect(passiveSummary).toMatchObject({
			sessionId: child.manager.getSessionId(),
			sessionName: "passive-child-worker",
			runtimeKind: "subagent",
			rlmChildId: child.childId,
			workerPid: parentSummary.workerPid,
		});
		expect(passiveSummary?.activeSessionId).toBeUndefined();

		const createdChild = await client.request({
			type: "create",
			sessionPath: createChild.sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!createdChild.success) throw new Error(createdChild.error);
		expect(requireSummary(createdChild.data)).toMatchObject({
			workerPid: parentSummary.workerPid,
			rlmChildId: createChild.childId,
		});
		expect(countWorkerDescriptors(agentDir)).toBe(1);

		const attached = await client.request({
			type: "attach",
			activeSessionId: child.manager.getSessionId(),
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
		});
		if (!attached.success) throw new Error(attached.error);

		const afterAttach = await client.request({ type: "list" });
		const hydratedSummary = requireSessionList(afterAttach.success ? afterAttach.data : undefined).find(
			(summary) => summary.sessionFile === child.sessionFile,
		);
		expect(hydratedSummary).toMatchObject({
			activeSessionId: expect.any(String),
			workerPid: parentSummary.workerPid,
			rlmChildId: child.childId,
		});
		expect(countWorkerDescriptors(agentDir)).toBe(1);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("keeps client-owned workers hidden and removes them without archiving", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-owned-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "owned worker fixture", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const launchEnvSentinel = `owned-env-${randomUUID()}`;
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			launchEnv: { PRIME_AGENT_OWNED_TEST: launchEnvSentinel },
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(created.success).toBe(true);
		const summary = requireSummary(created.success ? created.data : undefined);
		if (!summary.workerPid || !summary.activeSessionId) {
			throw new Error("Client-owned worker did not expose its process identity");
		}
		workerPids.add(summary.workerPid);

		const publicList = await client.request({ type: "list" });
		expect(publicList.success).toBe(true);
		expect(requireSessionList(publicList.success ? publicList.data : undefined)).toEqual([]);
		const internalList = await client.request({ type: "list", includeClientOwned: true });
		expect(internalList.success).toBe(true);
		expect(requireSessionList(internalList.success ? internalList.data : undefined)).toHaveLength(1);
		const otherClient = await connectEventually(socketPath);
		const deniedList = await otherClient.request({ type: "list", includeClientOwned: true });
		expect(deniedList).toMatchObject({
			success: true,
			data: { sessions: [], busyClientOwnedSessionCount: 0 },
		});
		const privateSelector = summary.sessionId.slice(-8);
		const deniedAttach = await otherClient.request({ type: "attach", activeSessionId: privateSelector });
		expect(deniedAttach).toMatchObject({
			success: false,
			error: `Unknown active session: ${privateSelector}`,
		});
		const deniedCron = await otherClient.request({
			type: "cron_add",
			activeSessionId: summary.activeSessionId,
			schedule: "every 1h",
			prompt: "unauthorized",
		});
		expect(deniedCron).toMatchObject({
			success: false,
			error: `Unknown active session: ${summary.activeSessionId}`,
		});
		otherClient.close();
		const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
			ownedSession: true,
			supportsExtensionUi: false,
		});
		await expect(connection.listHeartbeats()).resolves.toEqual([]);
		await expect(connection.listCronJobs()).resolves.toEqual([]);
		const cronResponse = await client.request({
			type: "cron_add",
			activeSessionId: summary.activeSessionId,
			schedule: "every 1h",
			prompt: "check status",
		});
		if (!cronResponse.success || !cronResponse.data || typeof cronResponse.data !== "object") {
			throw new Error(cronResponse.success ? "Cron response was missing its job" : cronResponse.error);
		}
		const cronJob = (cronResponse.data as { job: { id: string } }).job;
		await expect(connection.listCronJobs()).resolves.toEqual([expect.objectContaining({ id: cronJob.id })]);
		await expect(connection.cancelCronJob(cronJob.id)).resolves.toMatchObject({ id: cronJob.id });

		const descriptor = readWorkerDescriptor(agentDir);
		expect(descriptor.ownerClientId).toEqual(expect.any(String));
		expect(JSON.stringify(descriptor)).not.toContain(launchEnvSentinel);
		expect(descriptor.createCommand).not.toHaveProperty("launchEnv");
		expect(descriptor.createCommand).not.toHaveProperty("lifecycle");

		await connection.dispose();
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Client-owned worker descriptor was not removed",
		);
		expect((await readSessionInfo(sessionFile))?.state?.status).not.toBe("archived");

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("releases an adopted client-owned worker when disposal races supervisor replacement", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(tmpdir(), `prime-supervisor-owned-adopt-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			lifecycle: "client_owned",
			noSession: true,
			launchEnv: { TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
			config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid || !summary.activeSessionId) {
			throw new Error("Client-owned worker did not expose its process identity");
		}
		workerPids.add(summary.workerPid);
		const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
			closeClientOnDispose: true,
			ownedSession: true,
			recoverDaemon: async () => {},
			supportsExtensionUi: false,
		});

		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		await connection.dispose();

		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Adopted client-owned worker descriptor was not removed",
		);
		const replacementClient = await connectEventually(socketPath);
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	}, 60_000);

	it("delivers agent-origin messages between root siblings on separate workers", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-root-message-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const createRoot = async (name: string) => {
			const response = await client.request({
				type: "create",
				name,
				config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
			});
			expect(response.success).toBe(true);
			return requireSummary(response.success ? response.data : undefined);
		};
		const source = await createRoot("source-root");
		const target = await createRoot("target-root");
		expect(source.workerPid).not.toBe(target.workerPid);
		await startBlockingBash(client, target.activeSessionId ?? target.id, join(root, "target-root-blocker.ready"));

		const response = await client.request({
			type: "send_message",
			fromActiveSessionId: source.activeSessionId ?? source.id,
			targetActiveSessionId: target.activeSessionId ?? target.id,
			message: "hello sibling root",
			agentOrigin: true,
		});
		expect(response.success, JSON.stringify(response)).toBe(true);
		expect(response).toMatchObject({
			success: true,
			data: {
				source: "agent_message",
				target: { activeSessionId: target.activeSessionId ?? target.id },
				message: "hello sibling root",
				deliveryStatus: "queued",
			},
		});
		const shutdown = await client.request({ type: "shutdown" }, 10_000);
		expect(shutdown.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
	}, 30_000);

	it("cancels an archived session heartbeat without spawning a worker", { tags: ["process-stress"] }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-archived-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "do not revive me", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		sessionManager.appendSessionState({ status: "archived" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}
		const cronStore = new AgentCronJobStore(getCronJobsPath(agentDir));
		const heartbeat = cronStore.createHeartbeat({
			activeSessionId: "old-active-session",
			sessionId: sessionManager.getSessionId(),
			sessionFile,
			cwd: projectDir,
			scheduleText: "every 10s",
			prompt: "continue old work",
			now: new Date(Date.now() - 20_000),
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const migratedStore = AgentCronJobStore.forSessionArtifacts();
		migratedStore.registerSessionArtifact(sessionManager.getSessionId(), sessionManager.getSessionArtifactDir()!);
		await waitForCondition(
			() => migratedStore.list().find((job) => job.id === heartbeat.id)?.status === "cancelled",
			"Archived heartbeat was not cancelled",
		);

		expect(countWorkerDescriptors(agentDir)).toBe(0);
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("cancels an orphan heartbeat instead of recreating a descriptorless active session", {
		tags: ["process-stress"],
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-orphan-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "old scheduled work", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}
		const cronStore = new AgentCronJobStore(getCronJobsPath(agentDir));
		const heartbeat = cronStore.createHeartbeat({
			activeSessionId: "deleted-worker",
			sessionId: sessionManager.getSessionId(),
			sessionFile,
			cwd: projectDir,
			scheduleText: "every 10s",
			prompt: "continue old work",
			now: new Date(Date.now() - 20_000),
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const migratedStore = AgentCronJobStore.forSessionArtifacts();
		migratedStore.registerSessionArtifact(sessionManager.getSessionId(), sessionManager.getSessionArtifactDir()!);
		await waitForCondition(
			() => migratedStore.list().find((job) => job.id === heartbeat.id)?.status === "cancelled",
			"Orphan heartbeat was not cancelled",
		);

		expect(countWorkerDescriptors(agentDir)).toBe(0);
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("restarts an empty supervisor without requiring a resident worker", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(root, "custom-sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-restart-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, ["--session-dir", sessionDir, "--no-tools"]);
		const client = await connectEventually(socketPath, supervisor);
		const restarted = await client.request({ type: "restart" });
		expect(restarted.success).toBe(true);
		client.close();
		await waitForExit(supervisor);
		children.delete(supervisor);

		const replacementClient = await connectEventually(socketPath);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		const persistedConfig = readSupervisorConfig(agentDir);
		expect(persistedConfig).toMatchObject({ defaultSessionConfig: { sessionDir } });
		expect(persistedConfig.defaultSessionConfig).not.toHaveProperty("noTools");
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	});

	it("survives a worker process spawn error", { tags: ["process-stress"] }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const missingCwd = join(root, "missing-project");
		const socketPath = join(tmpdir(), `prime-supervisor-spawn-error-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const failed = await client.request({
			type: "create",
			config: { cwd: missingCwd, agentDir, noTools: true, noExtensions: true },
		});

		expect(failed).toMatchObject({ success: false });
		expect(supervisor.exitCode).toBeNull();
		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toEqual([]);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("archives resident roots and cancels their heartbeats on explicit daemon shutdown", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-shutdown-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "stop with daemon", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const heartbeatResponse = await client.request({
			type: "heartbeat_set",
			activeSessionId: summary.activeSessionId ?? summary.id,
			schedule: "every 1h",
			prompt: "continue old work",
		});
		if (!heartbeatResponse.success || !heartbeatResponse.data || typeof heartbeatResponse.data !== "object") {
			throw new Error(heartbeatResponse.success ? "Heartbeat response was missing data" : heartbeatResponse.error);
		}
		const heartbeat = (heartbeatResponse.data as { heartbeat: { id: string } }).heartbeat;
		const cronStore = AgentCronJobStore.forSessionArtifacts();
		cronStore.registerSessionArtifact(summary.sessionId, sessionManager.getSessionArtifactDir()!);
		const observer = await connectEventually(socketPath, supervisor);
		const observerClosed = new Promise<Error>((resolveClose) => observer.onClose(resolveClose));

		expect((await client.request({ type: "shutdown" })).success).toBe(true);
		client.close();
		expect(getDaemonSocketCloseReason(await observerClosed)).toBe("shutdown");
		observer.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		expect(countWorkerDescriptors(agentDir)).toBe(0);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });
		expect(cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({ status: "cancelled" });

		const replacement = spawnSupervisor(agentDir, socketPath, projectDir);
		const replacementClient = await connectEventually(socketPath, replacement);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(
			requireSessionList(listed.success ? listed.data : undefined).filter(
				(session) => session.activeSessionId || session.workerPid,
			),
		).toEqual([]);
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	}, 30_000);

	it("finalizes a timed-out worker stop by force-stopping the process and removing its registration", {
		tags: ["process-stress"],
		timeout: 45_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(
			tmpdir(),
			`prime-supervisor-stop-finalize-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
		);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "finalize me", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;

		// A suspended worker cannot exit within the stop deadline, so the stop
		// times out and used to leave a tombstoned registration behind forever.
		process.kill(summary.workerPid, "SIGSTOP");
		const stopResult = await client.request({ type: "complete_owned_session", activeSessionId }, 30_000);
		expect(stopResult).toMatchObject({
			success: false,
			error: expect.stringContaining("did not stop"),
		});
		const tombstone = readWorkerDescriptor(agentDir);
		expect(tombstone.stopRequestedAt).toEqual(expect.any(String));

		// The supervisor finishes the interrupted stop on its own: it escalates
		// to SIGKILL, waits for the process to die, and removes the registration.
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Timed-out worker stop was not finalized",
			20_000,
		);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
	});

	it("resumes a saved session immediately after a worker stop fails and the process dies", {
		tags: ["process-stress"],
		timeout: 45_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-resume-heal-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "resume me", timestamp: 1 });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			lifecycle: "client_owned",
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;

		// A suspended worker forces the stop past its deadline, leaving a
		// tombstoned registration for a process that dies moments later.
		process.kill(summary.workerPid, "SIGSTOP");
		const stopResult = await client.request({ type: "complete_owned_session", activeSessionId }, 30_000);
		expect(stopResult).toMatchObject({
			success: false,
			error: expect.stringContaining("did not stop"),
		});
		process.kill(summary.workerPid, "SIGKILL");
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);

		// Resuming the saved transcript must not be blocked by the stale
		// registration. Whichever cleanup wins the race — the background stop
		// finalizer or the resume-time reclaim (each covered deterministically
		// by unit tests) — the user-visible guarantee is the same: the resume
		// below must succeed with a fresh worker.
		const resumed = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(resumed.success).toBe(true);
		const resumedSummary = requireSummary(resumed.success ? resumed.data : undefined);
		expect(resumedSummary.sessionId).toBe(summary.sessionId);
		expect(resumedSummary.workerPid).not.toBe(summary.workerPid);
		expect(resumedSummary.workerState).toBe("ready");
		if (resumedSummary.workerPid) {
			workerPids.add(resumedSummary.workerPid);
		}

		const attached = await client.request({
			type: "attach",
			activeSessionId: resumedSummary.activeSessionId ?? resumedSummary.id,
		});
		expect(attached.success).toBe(true);

		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
		if (resumedSummary.workerPid) {
			await waitForProcessGone(resumedSummary.workerPid);
			workerPids.delete(resumedSummary.workerPid);
		}
	});

	it("does not resurrect an intentionally stopped root when the supervisor dies during kill", {
		tags: ["process-stress"],
		timeout: 30_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-stop-race-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "stop me", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const firstSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, firstSupervisor);
		const firstSupervisorPid = client.hello?.supervisorPid;
		if (!firstSupervisorPid) {
			throw new Error("Daemon hello did not expose its supervisor pid");
		}
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		const activeSessionId = summary.activeSessionId ?? summary.id;
		const heartbeatResponse = await client.request({
			type: "heartbeat_set",
			activeSessionId,
			schedule: "every 1h",
			prompt: "continue old work",
		});
		if (!heartbeatResponse.success || !heartbeatResponse.data || typeof heartbeatResponse.data !== "object") {
			throw new Error(heartbeatResponse.success ? "Heartbeat response was missing data" : heartbeatResponse.error);
		}
		const heartbeat = (heartbeatResponse.data as { heartbeat: { id: string } }).heartbeat;
		const cronStore = AgentCronJobStore.forSessionArtifacts();
		cronStore.registerSessionArtifact(summary.sessionId, sessionManager.getSessionArtifactDir()!);
		process.kill(summary.workerPid, "SIGSTOP");
		const killResult = client.request({ type: "kill", activeSessionId }).catch((error: unknown) => error);
		const tombstone = await waitForWorkerStopTombstone(agentDir);
		expect(tombstone.stopRequestedAt).toEqual(expect.any(String));
		expect(tombstone.archiveOnStop).toBe(true);

		process.kill(firstSupervisorPid, "SIGKILL");
		await waitForExit(firstSupervisor);
		children.delete(firstSupervisor);
		client.close();
		await expect(killResult).resolves.toBeInstanceOf(Error);

		const replacementSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const replacementClient = await connectEventually(socketPath, replacementSupervisor);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		const sessions = requireSessionList(listed.success ? listed.data : undefined);
		expect(sessions.filter((session) => session.activeSessionId || session.workerPid)).toEqual([]);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
		await waitForCondition(
			() => countWorkerDescriptors(agentDir) === 0,
			"Intentional worker stop descriptor was not removed",
		);
		expect(countWorkerDescriptors(agentDir)).toBe(0);
		expect((await readSessionInfo(sessionFile))?.state).toEqual({ status: "archived" });
		expect(cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({ status: "cancelled" });

		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	});

	it("hosts and adopts isolated worker processes", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-smoke-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionFiles = Array.from({ length: 2 }, (_, index) => {
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: `smoke root ${index}`, timestamp: index + 1 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			return sessionFile;
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await Promise.all(
			sessionFiles.map((sessionPath) =>
				client.request({
					type: "create",
					sessionPath,
					config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
				}),
			),
		);
		const summaries = created.map((response) => {
			if (!response.success) {
				throw new Error(response.error);
			}
			return requireSummary(response.data);
		});
		const pids = summaries.map((summary) => summary.workerPid);
		expect(new Set(pids).size).toBe(2);
		expect(pids).not.toContain(supervisor.pid);
		for (const pid of pids) {
			if (!pid) {
				throw new Error("Resident root did not expose a worker pid");
			}
			workerPids.add(pid);
		}

		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toHaveLength(2);
		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		client.close();

		const replacementClient = await connectEventually(socketPath);
		const adopted = await replacementClient.request({ type: "list" });
		expect(adopted.success).toBe(true);
		expect(
			new Set(requireSessionList(adopted.success ? adopted.data : undefined).map((summary) => summary.workerPid)),
		).toEqual(new Set(pids));
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
		await Promise.all(
			pids.map(async (pid) => {
				if (pid) {
					await waitForProcessGone(pid);
					workerPids.delete(pid);
				}
			}),
		);
	}, 60_000);

	it("hosts resident roots in isolated worker processes without a session cap", {
		tags: ["process-stress"],
		timeout: 180_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-many-roots-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionFiles = Array.from({ length: PROCESS_STRESS_WORKERS }, (_, index) => {
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: `root ${index}`, timestamp: index + 1 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			return sessionFile;
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const externalLease = acquireSessionLease(sessionFiles[0], agentDir, {
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "external-owner",
		});
		const conflict = await client.request({
			type: "create",
			sessionPath: sessionFiles[0],
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(conflict).toMatchObject({
			success: false,
			errorInfo: { code: "session_already_active", activeSessionId: "external-owner" },
		});
		const emptyAfterConflict = await client.request({ type: "list" });
		expect(requireSessionList(emptyAfterConflict.success ? emptyAfterConflict.data : undefined)).toHaveLength(0);
		externalLease?.release();
		const created = await Promise.all(
			sessionFiles.map((sessionPath) =>
				client.request({
					type: "create",
					sessionPath,
					config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
				}),
			),
		);
		const summaries = created.map((response) => {
			if (!response.success) {
				throw new Error(response.error);
			}
			return requireSummary(response.data);
		});
		const pids = summaries.map((summary) => summary.workerPid);
		expect(new Set(pids).size).toBe(PROCESS_STRESS_WORKERS);
		expect(pids).not.toContain(supervisor.pid);
		for (const pid of pids) {
			if (!pid) {
				throw new Error("Resident root did not expose a worker pid");
			}
			workerPids.add(pid);
		}
		const firstActiveSessionId = summaries[0]!.activeSessionId ?? summaries[0]!.id;
		const addedCron = await client.request({
			type: "cron_add",
			activeSessionId: firstActiveSessionId,
			schedule: "every 1h",
			prompt: "check status",
		});
		expect(addedCron.success).toBe(true);
		const cronJob = (addedCron.success ? addedCron.data : undefined) as { job?: { id?: string } } | undefined;
		if (!cronJob?.job?.id) {
			throw new Error("Supervisor did not persist the cron job");
		}
		const listedCron = await client.request({ type: "cron_list", activeSessionId: firstActiveSessionId });
		expect(listedCron).toMatchObject({ success: true, data: { jobs: [{ id: cronJob.job.id }] } });
		const cancelledCron = await client.request({ type: "cron_cancel", jobId: cronJob.job.id });
		expect(cancelledCron.success).toBe(true);
		const activeSessionIds = summaries.map((summary) => summary.activeSessionId ?? summary.id);
		await Promise.all(
			activeSessionIds.map((activeSessionId, index) =>
				startBlockingBash(client, activeSessionId, join(root, `stress-blocker-${index}.ready`)),
			),
		);
		const heartbeats = await Promise.all(
			activeSessionIds.map((activeSessionId, index) =>
				client.request({
					type: "heartbeat_set",
					activeSessionId,
					schedule: "every 10s",
					prompt: `heartbeat ${index}`,
				}),
			),
		);
		expect(heartbeats.every((response) => response.success)).toBe(true);
		await waitForCondition(
			() => {
				const stores = summaries.map((summary, index) => {
					const store = AgentCronJobStore.forSessionArtifacts();
					store.registerSessionArtifact(
						summary.sessionId,
						join(dirname(dirname(sessionFiles[index]!)), "session-artifacts", summary.sessionId),
					);
					return store;
				});
				return stores.every((store) => store.list().some((job) => job.lastSkippedAt !== undefined));
			},
			"Session workers did not advance their heartbeats independently",
			15_000,
		);

		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toHaveLength(PROCESS_STRESS_WORKERS);
		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		client.close();
		const replacementClient = await connectEventually(socketPath);
		const adopted = await replacementClient.request({ type: "list" });
		expect(adopted.success).toBe(true);
		expect(
			new Set(requireSessionList(adopted.success ? adopted.data : undefined).map((summary) => summary.workerPid)),
		).toEqual(new Set(pids));
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
		await Promise.all(
			pids.map(async (pid) => {
				if (pid) {
					await waitForProcessGone(pid);
					workerPids.delete(pid);
				}
			}),
		);
	});

	it("isolates a root, streams a chunked snapshot, and adopts the same worker after restart", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		const largePrompt = `large:${"x".repeat(600 * 1024)}`;
		sessionManager.appendMessage({ role: "user", content: largePrompt, timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const firstSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, firstSupervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: {
				cwd: projectDir,
				agentDir,
				sessionDir,
				noTools: true,
				noExtensions: true,
			},
		});
		if (!created.success) {
			const diagnostics = childDiagnostics.get(firstSupervisor);
			throw new Error(
				`${created.error}\nsupervisor stdout:\n${diagnostics?.stdout ?? ""}\nsupervisor stderr:\n${diagnostics?.stderr ?? ""}\n${readDaemonLogs(agentDir)}`,
			);
		}
		expect(created.success).toBe(true);
		const createdSummary = requireSummary(created.data);
		expect(createdSummary.workerState).toBe("ready");
		expect(createdSummary.workerPid).not.toBe(firstSupervisor.pid);
		if (!createdSummary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(createdSummary.workerPid);

		const connection = await DaemonAgentConnection.attach(
			client,
			createdSummary.activeSessionId ?? createdSummary.id,
			{ recoverDaemon: async () => {} },
		);
		const connectionEvents: string[] = [];
		const replacementMessageCounts: number[] = [];
		connection.subscribe((event) => {
			connectionEvents.push(event.type === "connection_status" ? `${event.type}:${event.status}` : event.type);
			if (event.type === "session_replaced") {
				replacementMessageCounts.push(event.messages.length);
			}
		});
		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.messages[0]).toMatchObject({ role: "user", content: largePrompt });

		const activeSessionId = createdSummary.activeSessionId ?? createdSummary.id;
		const createdNew = await client.request({ type: "new_session", activeSessionId });
		expect(createdNew.success).toBe(true);
		const emptyReplacementDeadline = Date.now() + 5000;
		while (!replacementMessageCounts.includes(0) && Date.now() < emptyReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts).toContain(0);
		const switchedBack = await client.request({ type: "switch_session", activeSessionId, sessionPath: sessionFile });
		expect(switchedBack.success).toBe(true);
		const restoredReplacementDeadline = Date.now() + 5000;
		while (replacementMessageCounts.at(-1) !== 2 && Date.now() < restoredReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts.at(-1)).toBe(2);

		firstSupervisor.kill("SIGTERM");
		await waitForExit(firstSupervisor);
		children.delete(firstSupervisor);

		const reconnectDeadline = Date.now() + 15_000;
		while (!connectionEvents.includes("connection_status:connected") && Date.now() < reconnectDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		expect(connectionEvents).toContain("connection_status:reconnecting");
		expect(connectionEvents).toContain("session_resynced");
		expect(connectionEvents).toContain("connection_status:connected");
		expect(connectionEvents).not.toContain("closed");
		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: createdSummary.activeSessionId,
			sessionId: createdSummary.sessionId,
		});
		const listed = await client.request({ type: "list", all: true, sessionDir });
		expect(listed.success).toBe(true);
		if (!listed.success) {
			throw new Error(listed.error);
		}
		const adopted = requireSessionList(listed.data).find(
			(summary) => (summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
		);
		expect(adopted).toMatchObject({
			workerState: "ready",
			workerPid: createdSummary.workerPid,
		});

		const descriptor = readWorkerDescriptor(agentDir);
		await startBlockingBash(client, activeSessionId, join(root, "orphan-blocker.ready"));
		if (!descriptor.orphanProcessJournalPath) {
			throw new Error("Resident worker did not persist its orphan-process journal path");
		}
		let orphanPids: number[] = [];
		const orphanDeadline = Date.now() + 5000;
		while (orphanPids.length === 0 && Date.now() < orphanDeadline) {
			orphanPids = readActiveOrphanProcesses(descriptor.orphanProcessJournalPath, descriptor.pid).map(
				(orphan) => orphan.pid,
			);
			if (orphanPids.length === 0) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
		expect(orphanPids.length).toBeGreaterThan(0);
		for (const pid of orphanPids) {
			workerPids.add(pid);
		}
		process.kill(createdSummary.workerPid, "SIGKILL");
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
		await Promise.all(orphanPids.map((pid) => waitForProcessGone(pid)));
		for (const pid of orphanPids) {
			workerPids.delete(pid);
		}

		let failed: SessionSummary | undefined;
		const recoveryDeadline = Date.now() + 20_000;
		while (Date.now() < recoveryDeadline) {
			const response = await client.request({ type: "list" });
			if (response.success) {
				failed = requireSessionList(response.data).find(
					(summary) =>
						(summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
				);
				if (failed?.workerState === "failed") break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		expect(failed).toMatchObject({ workerState: "failed", activeSessionId: createdSummary.activeSessionId });
		await connection.dispose();

		const reopened = await client.request({
			type: "create",
			sessionPath: sessionFile,
			continueRecent: false,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
			launchEnv: { PRIME_AGENT_TEST_FRESH_CONTEXT: "1" },
		});
		if (!reopened.success) throw new Error(reopened.error);
		const recovered = requireSummary(reopened.data);
		if (!recovered.workerPid) throw new Error("Recovered worker did not expose its pid");
		workerPids.add(recovered.workerPid);
		const recoveredConnection = await DaemonAgentConnection.attach(
			client,
			recovered.activeSessionId ?? recovered.id,
			{ recoverDaemon: async () => {} },
		);
		const recoveredSnapshot = await recoveredConnection.getInitialSnapshot();
		expect(recoveredSnapshot.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
			]),
		);
		await expect(recoveredConnection.getState()).resolves.toMatchObject({ sessionId: createdSummary.sessionId });

		await recoveredConnection.dispose();
		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(recovered.workerPid);
		workerPids.delete(recovered.workerPid);
	});

	it("runs a session-artifact cron job while the supervisor is being replaced", {
		tags: ["process-stress"],
		timeout: 30_000,
	}, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-worker-cron-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "scheduled work", timestamp: 1 });
		sessionManager.appendSessionState({ status: "active" });
		const sessionFile = sessionManager.getSessionFile();
		const artifactDir = sessionManager.getSessionArtifactDir();
		if (!sessionFile || !artifactDir) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const summary = requireSummary(created.data);
		if (!summary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(summary.workerPid);
		await startBlockingBash(client, summary.activeSessionId ?? summary.id, join(root, "heartbeat-blocker.ready"));
		const scheduled = await client.request({
			type: "heartbeat_set",
			activeSessionId: summary.activeSessionId ?? summary.id,
			schedule: "every 10s",
			prompt: "continue without the supervisor",
		});
		if (!scheduled.success || !scheduled.data || typeof scheduled.data !== "object") {
			throw new Error(scheduled.success ? "Heartbeat response was missing its job" : scheduled.error);
		}
		const job = (scheduled.data as { heartbeat: { id: string } }).heartbeat;

		client.close();
		supervisor.kill("SIGKILL");
		await waitForExit(supervisor);
		children.delete(supervisor);

		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionManager.getSessionId(), artifactDir);
		await waitForCondition(
			() => store.list().find((candidate) => candidate.id === job.id)?.lastSkippedAt !== undefined,
			"Resident worker did not advance its heartbeat without the supervisor",
			15_000,
		);
		expect(store.list().find((candidate) => candidate.id === job.id)).toBeDefined();

		const replacement = await connectEventually(socketPath);
		await replacement.request({ type: "shutdown" });
		replacement.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(summary.workerPid);
		workerPids.delete(summary.workerPid);
	});
});
