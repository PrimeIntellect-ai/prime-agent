import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getCronJobsPath } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import {
	acquireDaemonSupervisorOwnership,
	persistDaemonStartupFenceFromOwner,
	waitForDaemonStartupFence,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import { createHarness, type Harness } from "../harness.js";

type FixtureMessage =
	| { type: "booted" }
	| { type: "ready"; owner?: OwnerRecord }
	| { type: "failed"; error: string }
	| { type: "probe_ack" }
	| { type: "owner_released" }
	| { type: "cleanup_complete"; skipped: boolean };

interface OwnerRecord {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	appVersion: string;
	phase: "starting" | "owner" | "stopping";
	createdAt: string;
	updatedAt: string;
}

interface FixtureHandle {
	child: ChildProcess;
	diagnostics: { stdout: string; stderr: string };
	messages: FixtureMessage[];
	waiters: Array<{
		predicate: (message: FixtureMessage) => boolean;
		resolve: (message: FixtureMessage) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>;
}

interface CleanupProcessIdentity {
	pid: number;
	processStartId: string;
	label: string;
}

const fixturePath = resolve(__dirname, "../../fixtures/eng-4600-supervisor-fixture.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/eng-4600-faux-extension.ts");
const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const handles = new Set<FixtureHandle>();
const harnesses: Harness[] = [];
const cleanupProcesses = new Map<string, CleanupProcessIdentity>();
const cleanupRegistryDirs = new Set<string>();
const cleanupSupervisorSockets = new Set<string>();

afterEach(async () => {
	for (const registryDir of cleanupRegistryDirs) {
		registerOwnerRecordsForCleanup(registryDir);
	}
	await cleanupRegisteredProcesses();
	for (const handle of handles) {
		if (handle.child.exitCode === null && handle.child.signalCode === null) {
			handle.child.kill("SIGKILL");
			await waitForExit(handle).catch(() => undefined);
		}
	}
	// A worker or fixture can publish a replacement owner while the first cleanup
	// sweep is stopping processes. Discover and stop that exact identity only after
	// every tracked fixture handle has exited, before removing harness directories.
	for (const registryDir of cleanupRegistryDirs) {
		registerOwnerRecordsForCleanup(registryDir);
	}
	await cleanupRegisteredProcesses();
	for (const registryDir of cleanupRegistryDirs) {
		await removeDeadFixtureOwnerRecords(registryDir);
	}
	handles.clear();
	cleanupProcesses.clear();
	cleanupRegistryDirs.clear();
	cleanupSupervisorSockets.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

function dispatchMessage(handle: FixtureHandle, message: FixtureMessage): void {
	const waiterIndex = handle.waiters.findIndex((waiter) => waiter.predicate(message));
	if (waiterIndex === -1) {
		handle.messages.push(message);
		return;
	}
	const [waiter] = handle.waiters.splice(waiterIndex, 1);
	if (!waiter) {
		return;
	}
	clearTimeout(waiter.timeout);
	waiter.resolve(message);
}

function spawnFixture(
	mode: "legacy_cleanup" | "owner" | "supervisor",
	paths: { agentDir: string; descriptorDir: string; registryDir: string; socketPath: string },
	options: { extraEnv?: NodeJS.ProcessEnv; generation?: string } = {},
): FixtureHandle {
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		cwd: paths.agentDir,
		env: {
			...process.env,
			...options.extraEnv,
			[supervisorRegistryDirEnv]: paths.registryDir,
			[ENV_AGENT_DIR]: paths.agentDir,
			ENG_4600_AGENT_DIR: paths.agentDir,
			ENG_4600_DESCRIPTOR_DIR: paths.descriptorDir,
			ENG_4600_FIXTURE_MODE: mode,
			ENG_4600_GENERATION: options.generation,
			ENG_4600_REGISTRY_DIR: paths.registryDir,
			ENG_4600_SOCKET_PATH: paths.socketPath,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: tsconfigPath,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const handle: FixtureHandle = {
		child,
		diagnostics: { stdout: "", stderr: "" },
		messages: [],
		waiters: [],
	};
	handles.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stderr += chunk.toString("utf8");
	});
	child.on("message", (message: FixtureMessage) => dispatchMessage(handle, message));
	return handle;
}

function spawnRealSupervisor(
	paths: { agentDir: string; registryDir: string; socketPath: string },
	extraEnv: NodeJS.ProcessEnv,
): FixtureHandle {
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", paths.socketPath, "--offline"],
		{
			cwd: paths.agentDir,
			env: {
				...process.env,
				...extraEnv,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const handle: FixtureHandle = {
		child,
		diagnostics: { stdout: "", stderr: "" },
		messages: [],
		waiters: [],
	};
	handles.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stderr += chunk.toString("utf8");
	});
	return handle;
}

function waitForMessage(
	handle: FixtureHandle,
	predicate: (message: FixtureMessage) => boolean,
	timeoutMs = 20_000,
): Promise<FixtureMessage> {
	const queuedIndex = handle.messages.findIndex(predicate);
	if (queuedIndex !== -1) {
		const [message] = handle.messages.splice(queuedIndex, 1);
		if (message) {
			return Promise.resolve(message);
		}
	}
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			handle.waiters = handle.waiters.filter((waiter) => waiter.timeout !== timeout);
			rejectMessage(
				new Error(
					`Timed out waiting for fixture message (exit=${handle.child.exitCode}/${handle.child.signalCode})\n${handle.diagnostics.stderr}`,
				),
			);
		}, timeoutMs);
		handle.waiters.push({ predicate, resolve: resolveMessage, reject: rejectMessage, timeout });
	});
}

function waitForType<T extends FixtureMessage["type"]>(
	handle: FixtureHandle,
	type: T,
	timeoutMs?: number,
): Promise<Extract<FixtureMessage, { type: T }>> {
	return waitForMessage(handle, (message) => message.type === type, timeoutMs) as Promise<
		Extract<FixtureMessage, { type: T }>
	>;
}

function waitForExit(handle: FixtureHandle, timeoutMs = 20_000): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error(`Timed out waiting for fixture exit\n${handle.diagnostics.stderr}`)),
			timeoutMs,
		);
		handle.child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

function send(handle: FixtureHandle, type: "cleanup" | "go" | "probe" | "release" | "shutdown"): void {
	handle.child.send({ type });
}

async function createPaths(): Promise<{
	agentDir: string;
	descriptorDir: string;
	registryDir: string;
	socketPath: string;
}> {
	const harness = await createHarness();
	harnesses.push(harness);
	return {
		agentDir: harness.tempDir,
		descriptorDir: join(harness.tempDir, "workers"),
		registryDir: join(harness.tempDir, "registry"),
		socketPath:
			process.platform === "win32"
				? `\\\\.\\pipe\\prime-agent-eng-4600-${process.pid}-${Date.now()}`
				: join(harness.tempDir, "daemon.sock"),
	};
}

async function assertConnectable(socketPath: string): Promise<void> {
	await new Promise<void>((resolveConnect, rejectConnect) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolveConnect();
		});
		socket.once("error", rejectConnect);
	});
}

async function connectEventually(socketPath: string): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
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
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out connecting to replacement supervisor: ${String(lastError)}`);
}

function waitForConnectionStatus(
	connection: DaemonAgentConnection,
	status: "reconnecting" | "connected",
	timeoutMs = 30_000,
): Promise<void> {
	return new Promise((resolveStatus, rejectStatus) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			rejectStatus(new Error(`Timed out waiting for daemon client status ${status}`));
		}, timeoutMs);
		const unsubscribe = connection.subscribe((event) => {
			if (event.type !== "connection_status" || event.status !== status) {
				return;
			}
			clearTimeout(timeout);
			unsubscribe();
			resolveStatus();
		});
	});
}

function readStableIdentity(target: object, property: "clientId" | "protocolClientId"): string {
	const identity: unknown = Reflect.get(target, property);
	if (typeof identity !== "string") {
		throw new Error(`Missing daemon client identity ${property}`);
	}
	return identity;
}

function requireSessionSummary(value: unknown): SessionSummary {
	if (!value || typeof value !== "object" || typeof (value as Partial<SessionSummary>).id !== "string") {
		throw new Error("Fixture did not return a session summary");
	}
	return value as SessionSummary;
}

function ownerRecordPath(registryDir: string, generation: string): string {
	return join(registryDir, `${generation}.owner`, "owner.json");
}

function ownerScopePath(registryDir: string, generation: string): string {
	return join(registryDir, `${generation}.owner`, "scope.json");
}

function readOwnerRecord(registryDir: string, generation: string): OwnerRecord | undefined {
	try {
		return JSON.parse(readFileSync(ownerRecordPath(registryDir, generation), "utf8")) as OwnerRecord;
	} catch {
		return undefined;
	}
}

function listOwnerRecords(registryDir: string): OwnerRecord[] {
	if (!existsSync(registryDir)) {
		return [];
	}
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => JSON.parse(readFileSync(join(registryDir, name, "owner.json"), "utf8")) as OwnerRecord);
}

async function waitForOwnerCount(registryDir: string, count: number, timeoutMs = 20_000): Promise<OwnerRecord[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const owners = listOwnerRecords(registryDir);
		if (owners.length === count) {
			return owners;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for ${count} supervisor owner records`);
}

function cleanupIdentityKey(identity: Pick<CleanupProcessIdentity, "pid" | "processStartId">): string {
	return `${identity.pid}:${identity.processStartId}`;
}

function registerCleanupProcess(identity: CleanupProcessIdentity): CleanupProcessIdentity {
	cleanupProcesses.set(cleanupIdentityKey(identity), identity);
	return identity;
}

async function captureCleanupProcess(pid: number, label: string, timeoutMs = 5000): Promise<CleanupProcessIdentity> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const processStartId = getProcessStartId(pid);
		if (processStartId) {
			return registerCleanupProcess({ pid, processStartId, label });
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Could not capture the process-start identity for ${label} ${pid}`);
}

function registerOwnerRecordsForCleanup(registryDir: string): void {
	for (const owner of listOwnerRecords(registryDir)) {
		cleanupSupervisorSockets.add(owner.socketPath);
		if (owner.processStartId) {
			registerCleanupProcess({
				pid: owner.pid,
				processStartId: owner.processStartId,
				label: `supervisor ${owner.generation}`,
			});
		}
	}
}

function cleanupProcessState(identity: CleanupProcessIdentity): "exited" | "matching" | "unknown" {
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") {
			return "exited";
		}
	}
	const observedStartId = getProcessStartId(identity.pid);
	if (observedStartId === undefined) {
		return "unknown";
	}
	return observedStartId === identity.processStartId ? "matching" : "exited";
}

async function removeDeadFixtureOwnerRecords(registryDir: string): Promise<void> {
	for (const owner of listOwnerRecords(registryDir)) {
		if (!owner.processStartId) {
			throw new Error(`Cannot clean owner ${owner.generation} without an exact process-start identity`);
		}
		const identity = {
			pid: owner.pid,
			processStartId: owner.processStartId,
			label: `supervisor ${owner.generation}`,
		};
		// A supervisor that just acknowledged shutdown can stay observable for a
		// moment; wait for the exact identity to exit instead of refusing outright.
		if (cleanupProcessState(identity) !== "exited") {
			registerCleanupProcess(identity);
			cleanupSupervisorSockets.add(owner.socketPath);
			await cleanupRegisteredProcesses();
		}

		const current = readOwnerRecord(registryDir, owner.generation);
		if (!current) {
			continue;
		}
		if (
			current.token !== owner.token ||
			current.pid !== owner.pid ||
			current.processStartId !== owner.processStartId
		) {
			throw new Error(`Refusing to clean changed owner ${owner.generation}`);
		}
		const ownerDir = join(registryDir, `${owner.generation}.owner`);
		const quarantineDir = join(registryDir, `.${owner.generation}.owner.test-cleanup-${owner.token}`);
		renameSync(ownerDir, quarantineDir);
		rmSync(quarantineDir, { recursive: true });
	}
}

async function waitForCleanupProcessExit(identity: CleanupProcessIdentity, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (cleanupProcessState(identity) !== "exited" && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	if (cleanupProcessState(identity) !== "exited") {
		throw new Error(`Timed out waiting for ${identity.label} ${identity.pid} (${identity.processStartId}) to exit`);
	}
	cleanupProcesses.delete(cleanupIdentityKey(identity));
}

async function waitForCleanupGracePeriod(timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const identity of [...cleanupProcesses.values()]) {
			if (cleanupProcessState(identity) === "exited") {
				cleanupProcesses.delete(cleanupIdentityKey(identity));
			}
		}
		if (cleanupProcesses.size === 0) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

async function cleanupRegisteredProcesses(existingClient?: DaemonClient): Promise<void> {
	for (const socketPath of cleanupSupervisorSockets) {
		await forceShutdownReachableSupervisor(socketPath, existingClient);
	}
	await waitForCleanupGracePeriod();
	const errors: unknown[] = [];
	for (const identity of [...cleanupProcesses.values()]) {
		try {
			if (cleanupProcessState(identity) === "matching") {
				process.kill(identity.pid, "SIGKILL");
			}
			await waitForCleanupProcessExit(identity);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to clean up ENG-4600 fixture processes");
	}
}

async function forceShutdownReachableSupervisor(socketPath: string, existingClient?: DaemonClient): Promise<void> {
	if (existingClient?.isConnected) {
		try {
			await existingClient.request({ type: "shutdown", force: true }, 5000);
			return;
		} catch {
			// Retry through a fresh connection before exact-identity process cleanup.
		}
	}
	const cleanupClient = new DaemonClient(socketPath);
	try {
		await cleanupClient.connect(1000);
		await cleanupClient.waitForHello(2000);
		await cleanupClient.request({ type: "shutdown", force: true }, 5000);
	} catch {
		// The exact-identity fallback handles an unreachable supervisor.
	} finally {
		cleanupClient.close();
	}
}

async function waitForPath(path: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

function writeOwnerRecord(registryDir: string, owner: OwnerRecord): void {
	writeFileSync(ownerRecordPath(registryDir, owner.generation), `${JSON.stringify(owner, null, 2)}\n`);
}

async function releaseOwnershipHolder(handle: FixtureHandle): Promise<void> {
	send(handle, "release");
	await waitForType(handle, "owner_released");
	send(handle, "shutdown");
	await waitForExit(handle);
}

async function stopSupervisor(handle: FixtureHandle, socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		await client.waitForHello(2000);
		await client.request({ type: "shutdown" }, 5000);
	} finally {
		client.close();
	}
	await waitForExit(handle);
}

describe("ENG-4600 daemon supervisor ownership", () => {
	it("elects one listener while 16 contenders atomically reclaim a stale owner", async () => {
		const paths = await createPaths();
		const stale = spawnFixture("owner", paths, { generation: "stale-owner" });
		await waitForType(stale, "booted");
		send(stale, "go");
		await waitForType(stale, "ready");
		stale.child.kill("SIGKILL");
		await waitForExit(stale);

		const contenders = Array.from({ length: 16 }, () => spawnFixture("supervisor", paths));
		await Promise.all(contenders.map((contender) => waitForType(contender, "booted", 60_000)));
		for (const contender of contenders) {
			send(contender, "go");
		}
		const outcomes = await Promise.all(
			contenders.map((contender) =>
				waitForMessage(contender, (message) => message.type === "ready" || message.type === "failed", 120_000),
			),
		);
		expect(outcomes.filter((message) => message.type === "ready")).toHaveLength(1);
		expect(outcomes.filter((message) => message.type === "failed")).toHaveLength(15);
		const winner = contenders[outcomes.findIndex((message) => message.type === "ready")];
		if (!winner) {
			throw new Error("No supervisor contender won ownership");
		}
		await assertConnectable(paths.socketPath);
		const [owner] = listOwnerRecords(paths.registryDir);
		expect(owner).toBeDefined();
		if (!owner) {
			throw new Error("Winning supervisor did not publish an owner record");
		}
		expect(readOwnerRecord(paths.registryDir, owner.generation)).toEqual(owner);
		await stopSupervisor(winner, paths.socketPath);
		expect(await waitForOwnerCount(paths.registryDir, 0)).toEqual([]);
	}, 180_000);

	it("preserves a real resident faux worker and client across delayed exact v0.3.0 cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}
		const paths = await createPaths();
		const legacyCleanup = spawnFixture("legacy_cleanup", paths);
		await waitForType(legacyCleanup, "booted");
		await waitForType(legacyCleanup, "ready");
		const predecessor = spawnRealSupervisor(paths, {});
		cleanupRegistryDirs.add(paths.registryDir);
		cleanupSupervisorSockets.add(paths.socketPath);
		let client: DaemonClient | undefined;
		let connection: DaemonAgentConnection | undefined;
		try {
			client = await connectEventually(paths.socketPath);
			let created: Awaited<ReturnType<DaemonClient["request"]>>;
			try {
				created = await client.request(
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
				);
			} catch (error) {
				const logsDir = join(paths.agentDir, "logs");
				const logs = existsSync(logsDir)
					? readdirSync(logsDir)
							.map((name) => `${name}:\n${readFileSync(join(logsDir, name), "utf8")}`)
							.join("\n")
					: "no daemon logs";
				throw new Error(`${String(error)}\nfixture stderr:\n${predecessor.diagnostics.stderr}\n${logs}`);
			}
			if (!created.success) {
				throw new Error(`${created.error}\nfixture stderr:\n${predecessor.diagnostics.stderr}`);
			}
			const summary = requireSessionSummary(created.data);
			if (!summary.workerPid) {
				throw new Error("Real resident worker did not expose its pid");
			}
			const workerCleanupIdentity = await captureCleanupProcess(summary.workerPid, "resident worker");
			const activeSessionId = summary.activeSessionId ?? summary.id;
			connection = await DaemonAgentConnection.attach(client, activeSessionId, { recoverDaemon: async () => {} });
			await connection.getInitialSnapshot();
			await connection.prompt("before replacement");
			await connection.waitForIdle();
			expect(await connection.getMessages()).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: [expect.objectContaining({ text: "upgrade response 1" })],
				}),
			);
			const originalClient = client;
			const originalConnection = connection;
			const originalProtocolClientId = readStableIdentity(client, "protocolClientId");
			const originalAttachedClientId = readStableIdentity(connection, "clientId");
			const originalWorkerPid = summary.workerPid;
			const originalState = await connection.getState();
			const reconnecting = waitForConnectionStatus(connection, "reconnecting");
			const reconnected = waitForConnectionStatus(connection, "connected", 60_000);
			const restarted = await client.request({ type: "restart" }, 10_000);
			expect(restarted.success).toBe(true);
			await reconnecting;
			await waitForExit(predecessor);
			await reconnected;
			const [successorOwner] = await waitForOwnerCount(paths.registryDir, 1);
			if (!successorOwner) {
				throw new Error("Replacement supervisor did not publish its owner record");
			}
			if (!successorOwner.processStartId) {
				await captureCleanupProcess(
					successorOwner.pid,
					`replacement supervisor ${successorOwner.generation}`,
				).catch(() => undefined);
				throw new Error("Replacement supervisor did not publish a process-start identity");
			}
			const successorCleanupIdentity = registerCleanupProcess({
				pid: successorOwner.pid,
				processStartId: successorOwner.processStartId,
				label: `replacement supervisor ${successorOwner.generation}`,
			});
			if (cleanupProcessState(successorCleanupIdentity) !== "matching") {
				throw new Error("Replacement supervisor owner identity does not match its live process");
			}
			expect(client).toBe(originalClient);
			expect(connection).toBe(originalConnection);
			expect(readStableIdentity(client, "protocolClientId")).toBe(originalProtocolClientId);
			expect(readStableIdentity(connection, "clientId")).toBe(originalAttachedClientId);
			expect((await connection.getState()).activeSessionId).toBe(originalState.activeSessionId);
			const successorIdentity = statSync(paths.socketPath);
			send(legacyCleanup, "cleanup");
			const cleanup = await waitForType(legacyCleanup, "cleanup_complete");
			expect(cleanup.skipped).toBe(true);
			const identityAfterLegacyCleanup = statSync(paths.socketPath);
			expect(identityAfterLegacyCleanup.dev).toBe(successorIdentity.dev);
			expect(identityAfterLegacyCleanup.ino).toBe(successorIdentity.ino);
			expect(readdirSync(successorOwner.descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
			const listed = await client.request({ type: "list" });
			if (!listed.success) {
				throw new Error(listed.error);
			}
			const listedSessions = (listed.data as { sessions: unknown[] }).sessions;
			expect(listedSessions).toHaveLength(1);
			const restored = requireSessionSummary(listedSessions[0]);
			expect(restored.workerPid).toBe(originalWorkerPid);
			expect(restored.activeSessionId ?? restored.id).toBe(activeSessionId);
			expect((await connection.getState()).activeSessionId).toBe(originalState.activeSessionId);
			await connection.prompt("after replacement");
			await connection.waitForIdle();
			expect(await connection.getMessages()).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					content: [expect.objectContaining({ text: "upgrade response 2" })],
				}),
			);
			await connection.dispose();
			connection = undefined;
			await client.request({ type: "shutdown", force: true }, 10_000);
			client.close();
			await waitForExit(legacyCleanup);
			await waitForCleanupProcessExit(workerCleanupIdentity);
			// Under a fully loaded CI shard, the replacement supervisor can remain
			// observable after shutdown longer than the helper's general cleanup bound.
			// Extend only this exact generation/pid/process-start identity's polled wait.
			await waitForCleanupProcessExit(successorCleanupIdentity, 60_000);
			registerOwnerRecordsForCleanup(paths.registryDir);
			await cleanupRegisteredProcesses(client);
			await removeDeadFixtureOwnerRecords(paths.registryDir);
			expect(listOwnerRecords(paths.registryDir)).toEqual([]);
		} finally {
			await connection?.dispose().catch(() => undefined);
			registerOwnerRecordsForCleanup(paths.registryDir);
			await cleanupRegisteredProcesses(client);
			client?.close();
		}
	}, 90_000);

	it("waits for the exact persisted predecessor identity during update handoff", async () => {
		if (process.platform === "win32") {
			return;
		}
		const paths = await createPaths();
		const predecessor = spawnFixture("owner", paths, { generation: "fixed-predecessor" });
		await waitForType(predecessor, "booted");
		send(predecessor, "go");
		const predecessorReady = await waitForType(predecessor, "ready");
		const owner = predecessorReady.owner;
		if (!owner?.processStartId) {
			throw new Error("Fixed predecessor did not publish a process start identity");
		}
		await persistDaemonStartupFenceFromOwner(
			paths.socketPath,
			{
				supervisorGeneration: owner.generation,
				supervisorOwnerToken: owner.token,
				supervisorPid: owner.pid,
				supervisorProcessStartId: owner.processStartId,
				supervisorSocketPath: owner.socketPath,
			},
			paths.registryDir,
		);
		send(predecessor, "release");
		await waitForType(predecessor, "owner_released");

		const replacement = spawnFixture("supervisor", paths);
		await waitForType(replacement, "booted");
		send(replacement, "go");
		await waitForPath(`${paths.socketPath}.lock`);
		send(replacement, "probe");
		await waitForType(replacement, "probe_ack");
		expect(replacement.messages.some((message) => message.type === "ready")).toBe(false);
		expect(listOwnerRecords(paths.registryDir)).toEqual([]);
		expect(existsSync(paths.socketPath)).toBe(false);
		send(predecessor, "shutdown");
		await waitForExit(predecessor);
		await waitForType(replacement, "ready");
		await assertConnectable(paths.socketPath);
		await stopSupervisor(replacement, paths.socketPath);
	}, 30_000);

	it("rejects malformed or mismatched fixed-owner fences and preserves timed-out fences", async () => {
		const missingPaths = await createPaths();
		await expect(
			persistDaemonStartupFenceFromOwner(
				missingPaths.socketPath,
				{
					supervisorGeneration: "missing-owner",
					supervisorOwnerToken: "missing-owner",
					supervisorPid: process.pid,
					supervisorProcessStartId: "missing-owner",
					supervisorSocketPath: missingPaths.socketPath,
				},
				missingPaths.registryDir,
			),
		).rejects.toThrow(/does not match/);

		const paths = await createPaths();
		const predecessor = spawnFixture("owner", paths, { generation: "validated-predecessor" });
		await waitForType(predecessor, "booted");
		send(predecessor, "go");
		const predecessorReady = await waitForType(predecessor, "ready");
		const owner = predecessorReady.owner;
		if (!owner) {
			throw new Error("Owner fixture did not publish its durable record");
		}
		if (!owner.processStartId) {
			await expect(
				persistDaemonStartupFenceFromOwner(
					paths.socketPath,
					{
						supervisorGeneration: owner.generation,
						supervisorOwnerToken: owner.token,
						supervisorPid: owner.pid,
						supervisorSocketPath: owner.socketPath,
					},
					paths.registryDir,
				),
			).rejects.toThrow(/does not match/);
			await releaseOwnershipHolder(predecessor);
			return;
		}
		const hello = {
			supervisorGeneration: owner.generation,
			supervisorOwnerToken: owner.token,
			supervisorPid: owner.pid,
			supervisorProcessStartId: owner.processStartId,
			supervisorSocketPath: owner.socketPath,
		};
		for (const mismatch of [
			{ ...hello, supervisorPid: owner.pid + 1 },
			{ ...hello, supervisorGeneration: "wrong-generation" },
			{ ...hello, supervisorOwnerToken: "wrong-token" },
			{ ...hello, supervisorProcessStartId: "wrong-start" },
			{ ...hello, supervisorSocketPath: `${owner.socketPath}.other` },
			{},
		]) {
			await expect(
				persistDaemonStartupFenceFromOwner(paths.socketPath, mismatch, paths.registryDir),
			).rejects.toThrow();
		}
		await expect(
			persistDaemonStartupFenceFromOwner(`${paths.socketPath}.other`, hello, paths.registryDir),
		).rejects.toThrow(/does not match/);

		const ownerPath = ownerRecordPath(paths.registryDir, owner.generation);
		writeFileSync(ownerPath, "{ malformed\n");
		await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir)).rejects.toThrow(
			/Invalid daemon supervisor owner record/,
		);
		writeOwnerRecord(paths.registryDir, { ...owner, processStartId: "recycled-process" });
		await expect(
			persistDaemonStartupFenceFromOwner(
				paths.socketPath,
				{ ...hello, supervisorProcessStartId: "recycled-process" },
				paths.registryDir,
			),
		).rejects.toThrow(/process identity changed/);
		writeOwnerRecord(paths.registryDir, owner);
		await persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir);
		await expect(waitForDaemonStartupFence(paths.socketPath, 50, paths.registryDir)).rejects.toThrow(/Timed out/);
		expect(readdirSync(join(paths.registryDir, "startup-fences"))).toHaveLength(1);
		await releaseOwnershipHolder(predecessor);
		await waitForDaemonStartupFence(paths.socketPath, 5000, paths.registryDir);
		expect(readdirSync(join(paths.registryDir, "startup-fences"))).toEqual([]);
	}, 30_000);

	it("admits unrelated ownership when immutable scope proves a corrupt owner is unrelated", async () => {
		const paths = await createPaths();
		const corruptOwner = await acquireDaemonSupervisorOwnership({
			agentDir: join(paths.agentDir, "corrupt-agent"),
			appVersion: "test",
			descriptorDir: join(paths.agentDir, "corrupt-workers"),
			generation: "corrupt-unrelated-owner",
			registryDir: paths.registryDir,
			socketPath: `${paths.socketPath}.corrupt`,
		});
		const originalOwner = { ...corruptOwner.record };
		let unrelatedOwner: Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>> | undefined;
		writeFileSync(ownerRecordPath(paths.registryDir, originalOwner.generation), "{ malformed\n");
		try {
			unrelatedOwner = await acquireDaemonSupervisorOwnership({
				agentDir: join(paths.agentDir, "healthy-agent"),
				appVersion: "test",
				descriptorDir: join(paths.agentDir, "healthy-workers"),
				generation: "healthy-unrelated-owner",
				registryDir: paths.registryDir,
				socketPath: `${paths.socketPath}.healthy`,
			});
			expect(unrelatedOwner.record.generation).toBe("healthy-unrelated-owner");
		} finally {
			await unrelatedOwner?.release();
			writeOwnerRecord(paths.registryDir, originalOwner);
			await corruptOwner.release();
		}
	});

	it("reclaims empty owner directories left by interrupted startup", async () => {
		const paths = await createPaths();
		const abandonedDirectory = join(paths.registryDir, "abandoned-owner.owner");
		mkdirSync(abandonedDirectory, { recursive: true });

		const owner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "healthy-owner",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});

		expect(existsSync(abandonedDirectory)).toBe(false);
		expect(owner.record.generation).toBe("healthy-owner");
		await owner.release();
	});

	it("reclaims owner directories containing only stray files", async () => {
		const paths = await createPaths();
		const abandonedDirectory = join(paths.registryDir, "abandoned-owner.owner");
		mkdirSync(abandonedDirectory, { recursive: true });
		writeFileSync(join(abandonedDirectory, ".DS_Store"), "stray");

		const owner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "healthy-owner",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});

		expect(existsSync(abandonedDirectory)).toBe(false);
		expect(owner.record.generation).toBe("healthy-owner");
		await owner.release();
	});

	it("persists a fence when immutable scope proves a corrupt owner is unrelated", async () => {
		const paths = await createPaths();
		const targetOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "fence-target-owner",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});
		const corruptOwner = await acquireDaemonSupervisorOwnership({
			agentDir: join(paths.agentDir, "fence-corrupt-agent"),
			appVersion: "test",
			descriptorDir: join(paths.agentDir, "fence-corrupt-workers"),
			generation: "fence-corrupt-unrelated-owner",
			registryDir: paths.registryDir,
			socketPath: `${paths.socketPath}.corrupt`,
		});
		const originalCorruptOwner = { ...corruptOwner.record };
		writeFileSync(ownerRecordPath(paths.registryDir, originalCorruptOwner.generation), "{ malformed\n");
		try {
			if (!targetOwner.record.processStartId) {
				return;
			}
			await persistDaemonStartupFenceFromOwner(
				paths.socketPath,
				{
					supervisorGeneration: targetOwner.record.generation,
					supervisorOwnerToken: targetOwner.record.token,
					supervisorPid: targetOwner.record.pid,
					supervisorProcessStartId: targetOwner.record.processStartId,
					supervisorSocketPath: targetOwner.record.socketPath,
				},
				paths.registryDir,
			);
			expect(readdirSync(join(paths.registryDir, "startup-fences"))).toHaveLength(1);
		} finally {
			rmSync(join(paths.registryDir, "startup-fences"), { recursive: true, force: true });
			writeOwnerRecord(paths.registryDir, originalCorruptOwner);
			await corruptOwner.release();
			await targetOwner.release();
		}
	});

	it("fails closed when a corrupt owner has matching immutable scope", async () => {
		const paths = await createPaths();
		const owner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "matching-corrupt-owner",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});
		const originalOwner = { ...owner.record };
		writeFileSync(ownerRecordPath(paths.registryDir, originalOwner.generation), "{ malformed\n");
		try {
			await expect(
				acquireDaemonSupervisorOwnership({
					agentDir: join(paths.agentDir, "matching-contender-agent"),
					appVersion: "test",
					descriptorDir: join(paths.agentDir, "matching-contender-workers"),
					generation: "matching-corrupt-contender",
					registryDir: paths.registryDir,
					socketPath: paths.socketPath,
				}),
			).rejects.toThrow(/Invalid daemon supervisor owner record/);
			await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, {}, paths.registryDir)).rejects.toThrow(
				/Invalid daemon supervisor owner record/,
			);
		} finally {
			writeOwnerRecord(paths.registryDir, originalOwner);
			await owner.release();
		}
	});

	it("fails closed when corrupt owners have missing or corrupt scope metadata", async () => {
		const paths = await createPaths();
		const targetOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "scope-failure-target",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});
		const corruptOwner = await acquireDaemonSupervisorOwnership({
			agentDir: join(paths.agentDir, "scope-failure-agent"),
			appVersion: "test",
			descriptorDir: join(paths.agentDir, "scope-failure-workers"),
			generation: "scope-failure-unrelated",
			registryDir: paths.registryDir,
			socketPath: `${paths.socketPath}.scope-failure`,
		});
		const originalCorruptOwner = { ...corruptOwner.record };
		const scopePath = ownerScopePath(paths.registryDir, originalCorruptOwner.generation);
		const originalScope = readFileSync(scopePath, "utf8");
		const expectBlocked = async (generation: string) => {
			await expect(
				acquireDaemonSupervisorOwnership({
					agentDir: join(paths.agentDir, `${generation}-agent`),
					appVersion: "test",
					descriptorDir: join(paths.agentDir, `${generation}-workers`),
					generation,
					registryDir: paths.registryDir,
					socketPath: `${paths.socketPath}.${generation}`,
				}),
			).rejects.toThrow(/Invalid daemon supervisor owner record/);
			await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, {}, paths.registryDir)).rejects.toThrow(
				/Invalid daemon supervisor owner record/,
			);
		};
		writeFileSync(ownerRecordPath(paths.registryDir, originalCorruptOwner.generation), "{ malformed\n");
		try {
			rmSync(scopePath);
			await expectBlocked("missing-scope-contender");
			writeFileSync(scopePath, "{ malformed\n");
			await expectBlocked("corrupt-scope-contender");
		} finally {
			writeFileSync(scopePath, originalScope);
			writeOwnerRecord(paths.registryDir, originalCorruptOwner);
			await corruptOwner.release();
			await targetOwner.release();
		}
	});

	it("treats physical descriptor aliases as one owner even with different sockets", async () => {
		const paths = await createPaths();
		const physicalRoot = join(paths.agentDir, "physical-root");
		const aliasRoot = join(paths.agentDir, "physical-root-alias");
		mkdirSync(physicalRoot, { recursive: true });
		symlinkSync(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
		const physicalPaths = { ...paths, descriptorDir: join(physicalRoot, "future", "workers") };
		const first = spawnFixture("owner", physicalPaths, { generation: "physical-owner" });
		await waitForType(first, "booted");
		send(first, "go");
		await waitForType(first, "ready");
		const aliasDescriptorDir = join(aliasRoot, "future", "workers");
		const aliasPaths = {
			...paths,
			descriptorDir: process.platform === "win32" ? aliasDescriptorDir.toUpperCase() : aliasDescriptorDir,
			socketPath: `${paths.socketPath}.alias`,
		};
		const alias = spawnFixture("owner", aliasPaths, { generation: "alias-owner" });
		await waitForType(alias, "booted");
		send(alias, "go");
		expect(await waitForType(alias, "failed")).toMatchObject({ error: expect.stringContaining("already owns") });
		await waitForExit(alias);
		await releaseOwnershipHolder(first);
	});

	it("rejects the same descriptor directory paired with a different socket", async () => {
		const paths = await createPaths();
		const first = spawnFixture("owner", paths, { generation: "descriptor-owner" });
		await waitForType(first, "booted");
		send(first, "go");
		await waitForType(first, "ready");
		const secondPaths = { ...paths, socketPath: `${paths.socketPath}.second` };
		const second = spawnFixture("owner", secondPaths, { generation: "descriptor-contender" });
		await waitForType(second, "booted");
		send(second, "go");
		expect(await waitForType(second, "failed")).toMatchObject({ error: expect.stringContaining("already owns") });
		await waitForExit(second);
		await releaseOwnershipHolder(first);
	});

	it("retries ownership release after guarded removal fails", async () => {
		const paths = await createPaths();
		const ownership = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "retryable-release",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});
		const movedRegistry = `${paths.registryDir}.moved`;
		renameSync(paths.registryDir, movedRegistry);
		writeFileSync(paths.registryDir, "blocked");
		await expect(ownership.release()).rejects.toThrow();
		rmSync(paths.registryDir, { force: true });
		renameSync(movedRegistry, paths.registryDir);
		await ownership.release();
		expect(listOwnerRecords(paths.registryDir)).toEqual([]);
	});

	it("does not remove an owner record whose token changed", async () => {
		const paths = await createPaths();
		const ownership = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "token-checked-release",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
		});
		writeOwnerRecord(paths.registryDir, { ...ownership.record, token: "replacement-token" });

		await ownership.release();

		expect(readOwnerRecord(paths.registryDir, ownership.record.generation)?.token).toBe("replacement-token");
		rmSync(join(paths.registryDir, `${ownership.record.generation}.owner`), { recursive: true, force: true });
	});

	it("unwinds real pre-bind and post-bind startup failures before retry", async () => {
		const paths = await createPaths();
		writeFileSync(paths.socketPath, "not a socket");
		const preBindFailure = spawnFixture("supervisor", paths);
		await waitForType(preBindFailure, "booted");
		send(preBindFailure, "go");
		expect(await waitForType(preBindFailure, "failed")).toMatchObject({
			error: expect.stringContaining("is not a socket"),
		});
		await waitForExit(preBindFailure);
		expect(listOwnerRecords(paths.registryDir)).toEqual([]);
		expect(existsSync(`${paths.socketPath}.lock`)).toBe(false);
		rmSync(paths.socketPath, { force: true });

		writeFileSync(getCronJobsPath(paths.agentDir), "{ malformed\n");
		const postBindFailure = spawnFixture("supervisor", paths);
		await waitForType(postBindFailure, "booted");
		send(postBindFailure, "go");
		expect(await waitForType(postBindFailure, "failed")).toMatchObject({
			error: expect.stringContaining("JSON"),
		});
		await waitForExit(postBindFailure);
		expect(listOwnerRecords(paths.registryDir)).toEqual([]);
		expect(existsSync(`${paths.socketPath}.lock`)).toBe(false);
		expect(existsSync(paths.socketPath)).toBe(false);
		const cacheRoot = join(paths.descriptorDir, "snapshot-cache");
		expect(existsSync(cacheRoot) ? readdirSync(cacheRoot) : []).toEqual([]);
		rmSync(getCronJobsPath(paths.agentDir), { force: true });

		const healthy = spawnFixture("supervisor", paths);
		await waitForType(healthy, "booted");
		send(healthy, "go");
		await waitForType(healthy, "ready");
		await assertConnectable(paths.socketPath);
		await stopSupervisor(healthy, paths.socketPath);
	}, 60_000);
});
