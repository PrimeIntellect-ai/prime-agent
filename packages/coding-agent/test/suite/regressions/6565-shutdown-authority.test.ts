import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDaemonShutdownCommand,
	DaemonClient,
	type DaemonHello,
} from "../../../src/modes/daemon/daemon-client.js";
import type {
	DaemonRestartCommand,
	DaemonShutdownAuthority,
	DaemonShutdownCommand,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * Regression coverage for the supervisor-shutdown-authority contract.
 *
 * Public daemon clients invoke the public `shutdown` command to retire the
 * supervisor whose socket they reached. The wire must bind shutdown to the
 * same-connection supervisor identity, or a legacy or stale client can
 * race a new client to retire a different (and still-valid) supervisor. The
 * test file exercises the public DaemonClient ↔ DaemonSupervisor seam using
 * a real, isolated supervisor process per test. No production code is mocked.
 */

type FixtureMessage = { type: "booted" } | { type: "ready" } | { type: "failed"; error: string };

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

const fixturePath = resolve(__dirname, "../../fixtures/eng-4600-supervisor-fixture.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const workerEnvVarsToStrip = [
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
	"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD",
	"PRIME_AGENT_DAEMON_WORKER_ROLE",
	"PRIME_AGENT_DAEMON_SUPERVISOR_SOCKET",
	"PRIME_AGENT_DAEMON_WORKER_AUTH_TOKEN",
	"PRIME_AGENT_DAEMON_WORKER_ACTIVE_SESSION_ID",
	"PRIME_AGENT_DAEMON_WORKER_RECOVERY_JOURNAL",
	"PRIME_AGENT_DAEMON_WORKER_STARTUP_GATE_FD",
	"PRIME_AGENT_DAEMON_CATALOG_ROLE",
] as const;

const handles = new Set<FixtureHandle>();
const harnesses: Harness[] = [];
const supervisorRegistryDirs = new Set<string>();
const cleanupRegistryDirs = new Set<string>();
const cleanupSupervisorSockets = new Set<string>();
const cleanupChildProcesses = new Set<ChildProcess>();

afterEach(async () => {
	for (const registryDir of supervisorRegistryDirs) {
		cleanupRegistryDirs.add(registryDir);
	}
	for (const handle of handles) {
		if (handle.child.exitCode === null && handle.child.signalCode === null) {
			handle.child.kill("SIGTERM");
		}
	}
	for (const child of cleanupChildProcesses) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	for (const socketPath of cleanupSupervisorSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(500);
			await client.requestSupervisorShutdown(true, 1500).catch(() => undefined);
		} catch {
			// Socket may already be gone.
		} finally {
			client.close();
		}
	}
	await waitForHandleExits(
		[...handles].map((handle) => handle.child),
		4000,
	);
	await waitForHandleExits(cleanupChildProcesses, 4000);
	handles.clear();
	cleanupChildProcesses.clear();
	cleanupSupervisorSockets.clear();
	supervisorRegistryDirs.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	cleanupRegistryDirs.clear();
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

function spawnSupervisorFixture(paths: {
	agentDir: string;
	descriptorDir: string;
	registryDir: string;
	socketPath: string;
}): FixtureHandle {
	const isolatedEnv = stripDaemonWorkerEnv(process.env);
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		cwd: paths.agentDir,
		env: {
			...isolatedEnv,
			[supervisorRegistryDirEnv]: paths.registryDir,
			ENG_4600_AGENT_DIR: paths.agentDir,
			ENG_4600_DESCRIPTOR_DIR: paths.descriptorDir,
			ENG_4600_FIXTURE_MODE: "supervisor",
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

function stripDaemonWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned: NodeJS.ProcessEnv = { ...source };
	for (const key of workerEnvVarsToStrip) {
		delete cleaned[key];
	}
	return cleaned;
}

async function waitForHandleExits(children: Iterable<ChildProcess>, timeoutMs: number): Promise<void> {
	const pending = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
	if (pending.length === 0) {
		return;
	}
	await Promise.all(
		pending.map(
			(child) =>
				new Promise<void>((resolveExit) => {
					const timer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGKILL");
						}
						resolveExit();
					}, timeoutMs);
					child.once("exit", () => {
						clearTimeout(timer);
						resolveExit();
					});
				}),
		),
	);
}

async function waitForMessage(
	handle: FixtureHandle,
	predicate: (message: FixtureMessage) => boolean,
	timeoutMs = 30_000,
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

async function waitForType<T extends FixtureMessage["type"]>(
	handle: FixtureHandle,
	type: T,
	timeoutMs?: number,
): Promise<Extract<FixtureMessage, { type: T }>> {
	return (await waitForMessage(handle, (message) => message.type === type, timeoutMs)) as Extract<
		FixtureMessage,
		{ type: T }
	>;
}

function send(handle: FixtureHandle, type: "go"): void {
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
	const registryDir = join(harness.tempDir, "registry");
	supervisorRegistryDirs.add(registryDir);
	cleanupRegistryDirs.add(registryDir);
	return {
		agentDir: harness.tempDir,
		descriptorDir: join(harness.tempDir, "workers"),
		registryDir,
		socketPath:
			process.platform === "win32"
				? `\\.pipeprime-agent-eng-shutdown-auth-${process.pid}-${randomUUID().slice(0, 8)}`
				: join(harness.tempDir, "daemon.sock"),
	};
}

async function connectEventually(socketPath: string, timeoutMs = 30_000): Promise<DaemonClient> {
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
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out connecting to supervisor: ${String(lastError)}`);
}

async function isSocketReachable(socketPath: string, timeoutMs = 500): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		await client.waitForHello(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

async function waitForSocketGone(socketPath: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isSocketReachable(socketPath))) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Daemon supervisor socket remained available: ${socketPath}`);
}

async function startSupervisor(paths: {
	agentDir: string;
	descriptorDir: string;
	registryDir: string;
	socketPath: string;
}): Promise<FixtureHandle> {
	cleanupSupervisorSockets.add(paths.socketPath);
	const handle = spawnSupervisorFixture(paths);
	await waitForType(handle, "booted");
	send(handle, "go");
	await waitForType(handle, "ready");
	return handle;
}

interface LegacySupervisorMock {
	server: Server;
	socketPath: string;
	tempDir: string;
	shutdownObserved: { count: number; lastCommand?: DaemonShutdownCommand };
}

let legacyMockServer: LegacySupervisorMock | undefined;

async function startLegacySupervisorMock(options: { publishSchema16Identity?: boolean } = {}): Promise<string> {
	const tempDir = mkdtempSync(join(tmpdir(), `prime-legacy-mock-${process.pid}-${randomUUID().slice(0, 8)}-`));
	const socketPath =
		process.platform === "win32"
			? `\\.pipeprime-legacy-mock-${process.pid}-${randomUUID().slice(0, 8)}`
			: join(tempDir, "legacy.sock");
	const server = createServer((socket) => {
		const mock = legacyMockServer;
		if (!mock) {
			socket.destroy();
			return;
		}
		// Send a legacy daemon_hello that does NOT include any of the supervisor
		// authority fields. This represents the seam an obsolete client reaches.
		const hello = {
			type: "daemon_hello",
			socketPath,
			protocol: { name: "prime-agent.daemon", version: 7 },
			schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
			schemaRevision: 16,
			appVersion: "0.7.2",
			clientId: randomUUID(),
			serverCapabilities: ["attach_snapshot", "event_sequence"],
			...(options.publishSchema16Identity
				? {
						supervisorGeneration: "schema-16-generation",
						supervisorOwnerToken: "schema-16-owner",
						supervisorPid: process.pid,
						supervisorProcessStartId: "schema-16-start",
						supervisorSocketPath: socketPath,
					}
				: {}),
		};
		socket.write(`${JSON.stringify(hello)}\n`);
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				try {
					const parsed = JSON.parse(line) as { type?: string; id?: string; command?: unknown };
					if (parsed.type === "command" && parsed.command && typeof parsed.command === "object") {
						const command = parsed.command as DaemonShutdownCommand;
						if (command.type === "shutdown") {
							mock.shutdownObserved.count += 1;
							mock.shutdownObserved.lastCommand = command;
							if (parsed.id) {
								const response = {
									id: parsed.id,
									type: "response",
									command: "shutdown",
									success: true,
								};
								socket.write(`${JSON.stringify(response)}\n`);
							}
							socket.write(`${JSON.stringify({ type: "daemon_closing", reason: "shutdown" })}\n`);
							socket.end();
						}
					}
				} catch {
					// Ignore malformed input in the mock.
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	legacyMockServer = { server, socketPath, tempDir, shutdownObserved: { count: 0 } };
	return socketPath;
}

async function stopLegacySupervisorMock(): Promise<void> {
	const mock = legacyMockServer;
	if (!mock) {
		return;
	}
	legacyMockServer = undefined;
	await new Promise<void>((resolveClose) => {
		mock.server.close(() => resolveClose());
		(mock.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
	});
	rmSync(mock.tempDir, { recursive: true, force: true });
}

function requireAuthority(authority: Partial<DaemonShutdownAuthority>): DaemonShutdownAuthority {
	if (
		typeof authority.supervisorGeneration !== "string" ||
		typeof authority.supervisorOwnerToken !== "string" ||
		typeof authority.supervisorPid !== "number" ||
		typeof authority.supervisorProcessStartId !== "string" ||
		typeof authority.supervisorSocketPath !== "string"
	) {
		throw new Error("Supervisor hello did not advertise the modern authority identity");
	}
	return {
		supervisorGeneration: authority.supervisorGeneration,
		supervisorOwnerToken: authority.supervisorOwnerToken,
		supervisorPid: authority.supervisorPid,
		supervisorProcessStartId: authority.supervisorProcessStartId,
		supervisorSocketPath: authority.supervisorSocketPath,
	};
}

function readAuthorityFromHello(hello: DaemonHello): DaemonShutdownAuthority {
	return requireAuthority({
		supervisorGeneration: hello.supervisorGeneration,
		supervisorOwnerToken: hello.supervisorOwnerToken,
		supervisorPid: hello.supervisorPid,
		supervisorProcessStartId: hello.supervisorProcessStartId,
		supervisorSocketPath: hello.supervisorSocketPath,
	});
}

function listOwnerRecords(registryDir: string): Array<Record<string, unknown>> {
	if (!registryDir) {
		return [];
	}
	try {
		return readdirSync(registryDir)
			.filter((name) => name.endsWith(".owner"))
			.map((name) => JSON.parse(require("node:fs").readFileSync(join(registryDir, name, "owner.json"), "utf8")));
	} catch {
		return [];
	}
}

describe("daemon supervisor shutdown authority (public seam)", () => {
	it("rejects a public shutdown without authority and keeps the same supervisor reachable", async () => {
		const paths = await createPaths();
		const handle = await startSupervisor(paths);

		const client = await connectEventually(paths.socketPath);
		try {
			const hello = client.hello;
			if (!hello) {
				throw new Error("Supervisor did not publish a daemon_hello");
			}
			// Authority is intentionally omitted: a legacy client never had it on the wire.
			const response = await client.request({ type: "shutdown" } as DaemonShutdownCommand, 5000);
			expect(response.command).toBe("shutdown");
			expect(response.success).toBe(false);

			// The supervisor, its socket, its workers, and its descriptors must remain.
			const retry = await connectEventually(paths.socketPath);
			try {
				const followUp = retry.hello;
				if (!followUp) {
					throw new Error("Supervisor did not republish a daemon_hello after rejection");
				}
				expect(followUp.supervisorGeneration).toBe(hello.supervisorGeneration);
				expect(followUp.supervisorOwnerToken).toBe(hello.supervisorOwnerToken);
				expect(followUp.supervisorPid).toBe(hello.supervisorPid);
				expect(followUp.supervisorProcessStartId).toBe(hello.supervisorProcessStartId);
				expect(followUp.supervisorSocketPath).toBe(hello.supervisorSocketPath);
			} finally {
				retry.close();
			}
			expect(listOwnerRecords(paths.registryDir)).toHaveLength(1);
		} finally {
			client.close();
			handle.child.kill("SIGTERM");
			await waitForHandleExits([handle.child], 4000);
			handles.delete(handle);
		}
	}, 30_000);

	it("accepts a public shutdown whose authority echoes the exact hello identity", async () => {
		const paths = await createPaths();
		const handle = await startSupervisor(paths);

		const client = await connectEventually(paths.socketPath);
		try {
			const hello = client.hello;
			if (!hello) {
				throw new Error("Supervisor did not publish a daemon_hello");
			}
			const authority = readAuthorityFromHello(hello);
			const response = await client.request({ type: "shutdown", authority } as DaemonShutdownCommand, 5000);
			expect(response.command).toBe("shutdown");
			expect(response.success).toBe(true);
		} finally {
			client.close();
		}
		await waitForSocketGone(paths.socketPath);
		await waitForHandleExits([handle.child], 4000);
		// The fixture owns the supervisor lifecycle; force-stop only after the
		// socket is confirmed gone so the cleanup path does not race the graceful shutdown.
		handles.delete(handle);
	}, 30_000);

	it("rejects authority mismatches for every component", async () => {
		const paths = await createPaths();
		const handle = await startSupervisor(paths);

		const client = await connectEventually(paths.socketPath);
		try {
			const hello = client.hello;
			if (!hello) {
				throw new Error("Supervisor did not publish a daemon_hello");
			}
			const base = readAuthorityFromHello(hello);
			const mutations: Array<{
				name: string;
				mutate: (authority: DaemonShutdownAuthority) => DaemonShutdownAuthority;
			}> = [
				{
					name: "supervisorGeneration",
					mutate: (authority) => ({ ...authority, supervisorGeneration: "wrong-generation" }),
				},
				{
					name: "supervisorOwnerToken",
					mutate: (authority) => ({ ...authority, supervisorOwnerToken: "wrong-owner-token" }),
				},
				{
					name: "supervisorPid",
					mutate: (authority) => ({ ...authority, supervisorPid: (authority.supervisorPid ?? 0) + 1 }),
				},
				{
					name: "supervisorProcessStartId",
					mutate: (authority) => ({ ...authority, supervisorProcessStartId: "wrong-process-start" }),
				},
				{
					name: "supervisorSocketPath",
					mutate: (authority) => ({
						...authority,
						supervisorSocketPath: `${authority.supervisorSocketPath ?? ""}.other`,
					}),
				},
			];
			for (const { name, mutate } of mutations) {
				const mismatched = mutate(base);
				const response = await client.request(
					{ type: "shutdown", authority: mismatched } as DaemonShutdownCommand,
					5000,
				);
				expect(response.command).toBe("shutdown");
				expect(response.success, `mismatch on ${name} should be rejected`).toBe(false);
				const reachable = await isSocketReachable(paths.socketPath);
				expect(reachable, `supervisor should remain reachable after ${name} mismatch`).toBe(true);
			}
			const { supervisorProcessStartId: _missingStart, ...incomplete } = base;
			const incompleteResponse = await client.request(
				{ type: "shutdown", authority: incomplete } as unknown as DaemonShutdownCommand,
				5000,
			);
			expect(incompleteResponse.success, "authority without process-start identity should be rejected").toBe(false);
			expect(await isSocketReachable(paths.socketPath)).toBe(true);
			expect(listOwnerRecords(paths.registryDir)).toHaveLength(1);
		} finally {
			client.close();
			handle.child.kill("SIGTERM");
			await waitForHandleExits([handle.child], 4000);
			handles.delete(handle);
		}
	}, 45_000);

	it("public restart cannot bypass missing or mismatched authority", async () => {
		const paths = await createPaths();
		const handle = await startSupervisor(paths);
		const client = await connectEventually(paths.socketPath);
		try {
			const hello = client.hello;
			if (!hello) throw new Error("Supervisor did not publish a daemon_hello");
			const base = readAuthorityFromHello(hello);

			const missing = await client.request({ type: "restart" } as DaemonRestartCommand, 5000);
			expect(missing.success).toBe(false);
			const mismatched = await client.request(
				{ type: "restart", authority: { ...base, supervisorOwnerToken: "wrong-owner" } } as DaemonRestartCommand,
				5000,
			);
			expect(mismatched.success).toBe(false);
			expect(await isSocketReachable(paths.socketPath)).toBe(true);
			expect(listOwnerRecords(paths.registryDir)).toHaveLength(1);
		} finally {
			client.close();
			handle.child.kill("SIGTERM");
			await waitForHandleExits([handle.child], 4000);
			handles.delete(handle);
		}
	}, 30_000);

	it("force cannot bypass authority rejection", async () => {
		const paths = await createPaths();
		const handle = await startSupervisor(paths);

		const client = await connectEventually(paths.socketPath);
		try {
			const hello = client.hello;
			if (!hello) {
				throw new Error("Supervisor did not publish a daemon_hello");
			}
			const base = readAuthorityFromHello(hello);
			const missingAuthority = { type: "shutdown", force: true } as DaemonShutdownCommand;
			const missingResponse = await client.request(missingAuthority, 5000);
			expect(missingResponse.command).toBe("shutdown");
			expect(missingResponse.success, "force without authority should be rejected").toBe(false);

			const mismatchedAuthority = {
				type: "shutdown",
				force: true,
				authority: { ...base, supervisorGeneration: "wrong-generation" },
			} as DaemonShutdownCommand;
			const mismatchedResponse = await client.request(mismatchedAuthority, 5000);
			expect(mismatchedResponse.command).toBe("shutdown");
			expect(mismatchedResponse.success, "force with mismatched authority should be rejected").toBe(false);

			const reachable = await isSocketReachable(paths.socketPath);
			expect(reachable, "supervisor should remain reachable after force rejections").toBe(true);
			expect(listOwnerRecords(paths.registryDir)).toHaveLength(1);
		} finally {
			client.close();
			handle.child.kill("SIGTERM");
			await waitForHandleExits([handle.child], 4000);
			handles.delete(handle);
		}
	}, 30_000);

	it("preserves new-client cleanup of a legacy supervisor whose handshake lacks authority fields", async () => {
		// A legacy supervisor predates the authority helper. Its daemon_hello does
		// not advertise any of the modern identity fields, so any new client helper
		// that derives authority from hello must recognise the absence and fall
		// back to a legacy-compatible shutdown.
		const socketPath = await startLegacySupervisorMock();
		try {
			const client = new DaemonClient(socketPath);
			await client.connect(500);
			await client.waitForHello(1000);
			const hello = client.hello;
			if (!hello) {
				throw new Error("Legacy supervisor mock did not publish a daemon_hello");
			}
			// The legacy hello must not advertise any of the modern identity fields.
			expect(hello.supervisorGeneration).toBeUndefined();
			expect(hello.supervisorOwnerToken).toBeUndefined();
			expect(hello.supervisorPid).toBeUndefined();
			expect(hello.supervisorProcessStartId).toBeUndefined();
			expect(hello.supervisorSocketPath).toBeUndefined();

			// A new client derives authority from the hello. With no authority fields
			// present, it must emit the legacy command without authority; the legacy
			// supervisor accepts it and the connection closes with a shutdown reason.
			const command = createDaemonShutdownCommand(hello);
			expect(command.authority).toBeUndefined();
			const response = await client.requestSupervisorShutdown(false, 5000);
			expect(response.command).toBe("shutdown");
			expect(response.success).toBe(true);
			expect(legacyMockServer?.shutdownObserved.lastCommand?.authority).toBeUndefined();
			client.close();
		} finally {
			await stopLegacySupervisorMock();
		}
	}, 15_000);

	it("preserves cleanup of a schema-16 supervisor that publishes complete identity", async () => {
		const socketPath = await startLegacySupervisorMock({ publishSchema16Identity: true });
		try {
			const client = new DaemonClient(socketPath);
			await client.connect(500);
			const hello = await client.waitForHello(1000);
			expect(hello.schemaRevision).toBe(16);

			const response = await client.requestSupervisorShutdown(false, 5000);
			expect(response.success).toBe(true);
			expect(legacyMockServer?.shutdownObserved.lastCommand?.authority).toEqual({
				supervisorGeneration: "schema-16-generation",
				supervisorOwnerToken: "schema-16-owner",
				supervisorPid: process.pid,
				supervisorProcessStartId: "schema-16-start",
				supervisorSocketPath: socketPath,
			});
			client.close();
		} finally {
			await stopLegacySupervisorMock();
		}
	}, 15_000);
});
