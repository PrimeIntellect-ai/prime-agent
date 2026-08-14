import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureInteractiveDaemonRunning,
	probeDaemonVersion,
	probeRunningDaemonSessions,
	shouldStartDaemonEarly,
	shutdownDaemonAndWait,
} from "../src/cli/daemon-launch.js";
import { ENV_AGENT_DIR, getDaemonLogPath, VERSION } from "../src/config.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";

interface FakeDaemonOptions {
	/** Sessions returned for a `list` command. */
	sessions?: Array<Record<string, unknown>>;
	busyClientOwnedSessionCount?: number;
	/** When true, the `list` command responds with a failure. */
	failList?: boolean;
	/** When false, the server ignores `shutdown` and stays up. */
	respondToShutdown?: boolean;
	/** When true, the server rejects `shutdown` with a failed response. */
	rejectShutdown?: boolean;
	/** Close independently after writing a rejected shutdown response. */
	closeAfterRejectedShutdown?: boolean;
	protocolVersion?: number;
	appVersion?: string;
	schemaId?: string;
	schemaRevision?: number;
	serverCapabilities?: string[];
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorSocketPath?: string;
	onCommand?: (command: { type: string }, connectionId: number) => void;
	onConnection?: () => void;
}

interface FakeDaemon {
	socketPath: string;
	close: () => Promise<void>;
}

function send(socket: Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-"));
	const socketPath = join(dir, "d.sock");
	let nextConnectionId = 0;
	const server: Server = createServer((socket) => {
		const connectionId = ++nextConnectionId;
		options.onConnection?.();
		socket.on("error", () => undefined);
		send(socket, {
			type: "daemon_hello",
			socketPath,
			protocol: { name: "prime-agent.daemon", version: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION },
			appVersion: options.appVersion,
			schemaId: options.schemaId ?? DAEMON_SCHEMA_ID,
			...(options.schemaRevision !== undefined ? { schemaRevision: options.schemaRevision } : {}),
			...(options.supervisorGeneration
				? {
						supervisorGeneration: options.supervisorGeneration,
						supervisorOwnerToken: options.supervisorOwnerToken ?? "fake-owner-token",
						supervisorPid: options.supervisorPid ?? 1,
						supervisorSocketPath: options.supervisorSocketPath ?? socketPath,
					}
				: {}),
			...(options.supervisorProcessStartId ? { supervisorProcessStartId: options.supervisorProcessStartId } : {}),
			clientId: "fake-client",
			serverCapabilities: options.serverCapabilities ?? [],
		});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) {
					continue;
				}
				const wire = JSON.parse(line) as {
					type: string;
					id: string;
					command?: { type: string; id: string };
				};
				const command = wire.type === "command" && wire.command ? wire.command : wire;
				options.onCommand?.(command, connectionId);
				if (command.type === "list") {
					send(socket, {
						type: "response",
						command: "list",
						id: wire.id,
						...(options.failList
							? { success: false, error: "list failed" }
							: {
									success: true,
									data: {
										sessions: options.sessions ?? [],
										busyClientOwnedSessionCount: options.busyClientOwnedSessionCount ?? 0,
									},
								}),
					});
				} else if (command.type === "shutdown") {
					if (options.respondToShutdown === false) {
						continue;
					}
					if (options.rejectShutdown) {
						send(socket, {
							type: "response",
							command: "shutdown",
							id: wire.id,
							success: false,
							error: "shutdown authority rejected",
							errorInfo: { code: "shutdown_authority_rejected" },
						});
						if (options.closeAfterRejectedShutdown) {
							server.close();
							socket.end();
						}
						continue;
					}
					send(socket, { type: "response", command: "shutdown", id: wire.id, success: true });
					server.close();
					socket.end();
				} else if (command.type === "restart") {
					send(socket, { type: "response", command: "restart", id: wire.id, success: true });
					server.close();
					socket.end();
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				rmSync(dir, { recursive: true, force: true });
			}),
	};
}

async function startCrashingDaemon(): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-crash-"));
	const socketPath = join(dir, "d.sock");
	const child = spawn(
		process.execPath,
		[
			"-e",
			`const { createServer } = require("node:net");
const socketPath = process.argv[1];
const send = (socket, message) => socket.write(JSON.stringify(message) + "\\n");
const server = createServer((socket) => {
	send(socket, {
		type: "daemon_hello",
		socketPath,
		protocol: { name: "prime-agent.daemon", version: ${DAEMON_PROTOCOL_VERSION} },
		schemaId: ${JSON.stringify(DAEMON_SCHEMA_ID)},
	});
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\\n");
		if (newline === -1) return;
		const wire = JSON.parse(buffer.slice(0, newline));
		const command = wire.command ?? wire;
		if (command.type !== "shutdown") return;
		send(socket, { type: "response", command: "shutdown", id: wire.id ?? command.id, success: true });
		socket.end(() => process.kill(process.pid, "SIGKILL"));
	});
});
server.listen(socketPath, () => process.stdout.write("ready\\n"));`,
			socketPath,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code, signal) => reject(new Error(`Daemon exited before listening: ${code ?? signal}`)));
	});
	return {
		socketPath,
		close: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => child.once("close", () => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("probeRunningDaemonSessions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("reports unreachable when no daemon is running", async () => {
		const result = await probeRunningDaemonSessions(join(tmpdir(), "pa-launch-missing.sock"));
		expect(result).toEqual({ reachable: false });
	});

	it("returns only sessions that have an activeSessionId", async () => {
		const daemon = await startFakeDaemon({
			sessions: [
				{ id: "a", activeSessionId: "a", isStreaming: true },
				{ id: "b" }, // saved-only, no activeSessionId
				{ id: "c", activeSessionId: "c", isStreaming: false },
			],
		});
		cleanups.push(daemon.close);
		const result = await probeRunningDaemonSessions(daemon.socketPath);
		expect(result.reachable).toBe(true);
		expect(result.reachable ? result.activeSessions?.map((session) => session.activeSessionId) : undefined).toEqual([
			"a",
			"c",
		]);
	});

	it("returns an empty list when the daemon is reachable but idle", async () => {
		const daemon = await startFakeDaemon({ sessions: [] });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true, activeSessions: [] });
	});

	it("leaves activeSessions undefined when reachable but the list fails", async () => {
		const daemon = await startFakeDaemon({ failList: true });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true });
	});
});

describe("shouldStartDaemonEarly", () => {
	it.each([
		["interactive", []],
		["print", ["--print", "hello"]],
		["json", ["--mode", "json", "hello"]],
		["rpc", ["--mode", "rpc"]],
		["no-session", ["--no-session"]],
	])("starts early for the %s client", (_label, args) => {
		expect(shouldStartDaemonEarly(args, false)).toBe(true);
	});

	it.each([
		["daemon process", ["--mode", "daemon"]],
		["help", ["--help"]],
		["version", ["--version"]],
		["model listing", ["--list-models"]],
		["management command after global flags", ["--daemon-socket", "/tmp/prime.sock", "status"]],
		["startup benchmark", []],
	])("does not start early for %s", (label, args) => {
		expect(shouldStartDaemonEarly(args, label === "startup benchmark")).toBe(false);
	});
});

describe("ensureInteractiveDaemonRunning", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("rejects a busy pre-session-action daemon before attach", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: 3,
			appVersion: VERSION,
			sessions: [{ id: "active-1", activeSessionId: "active-1", isStreaming: true }],
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).rejects.toThrow("incompatible");
		expect(commands).not.toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("does not replace a stale daemon with busy private client sessions", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "stale-schema",
			busyClientOwnedSessionCount: 1,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).rejects.toThrow("stale");
		expect(commands).toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("does not launch a replacement when the guarded supervisor rejects an obsolete client", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "stale-schema",
			sessions: [],
			rejectShutdown: true,
			supervisorGeneration: "gen-guarded",
			supervisorOwnerToken: "token-guarded",
			supervisorPid: 424243,
			supervisorProcessStartId: "start-guarded",
			onCommand: (command) => commands.push({ ...(command as Record<string, unknown>) }),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).rejects.toThrow("stale");
		const shutdownCommand = commands.find((command) => command.type === "shutdown");
		// The obsolete client's shutdown carries the exact identity it observed
		// on the same connection; the guarded supervisor rejects it, so no
		// replacement is launched and the supervisor stays serving.
		expect(shutdownCommand).toBeDefined();
		expect(shutdownCommand?.authority).toEqual({
			supervisorGeneration: "gen-guarded",
			supervisorOwnerToken: "token-guarded",
			supervisorPid: 424243,
			supervisorProcessStartId: "start-guarded",
			supervisorSocketPath: daemon.socketPath,
		});
		expect(await probeDaemonVersion(daemon.socketPath)).toMatchObject({ status: "stale" });
	});

	it("classifies and attempts stale replacement on one unchanged connection", async () => {
		const commandConnections: Array<{ type: string; connectionId: number }> = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "stale-schema",
			sessions: [],
			rejectShutdown: true,
			supervisorGeneration: "same-connection-generation",
			supervisorProcessStartId: "same-connection-start",
			onCommand: (command, connectionId) => commandConnections.push({ type: command.type, connectionId }),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).rejects.toThrow("stale");
		const terminatingCommands = commandConnections.filter(({ type }) => type === "list" || type === "shutdown");
		expect(terminatingCommands.map(({ type }) => type)).toEqual(["list", "shutdown"]);
		expect(new Set(terminatingCommands.map(({ connectionId }) => connectionId)).size).toBe(1);
	});

	it("does not treat a live daemon as absent when cold startup delays the first connection", async () => {
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: DAEMON_SCHEMA_ID,
		});
		cleanups.push(daemon.close);

		const probe = probeDaemonVersion(daemon.socketPath);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

		await expect(probe).resolves.toMatchObject({ status: "current" });
	});

	it("fails fast with the daemon log tail when the spawned daemon exits during startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-crash-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		const logPath = getDaemonLogPath(socketPath);
		mkdirSync(dirname(logPath), { recursive: true });
		const script = `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(logPath)}, "supervisor: fatal startup failure\\n"); process.exit(23);`;
		writeFileSync(entrypoint, script);
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;
		const startedAt = Date.now();

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/Prime Agent daemon exited during startup \(code 23\)\.[\s\S]*fatal startup failure/,
			);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the missing daemon log when the daemon crashes before logging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-silent-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/exited during startup \(code 7\)\. The daemon wrote nothing to its log/,
			);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces a spawn error when the child never emits exit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-spawn-error-"));
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath, join(dir, "missing-cwd"))).rejects.toThrow(
				/Failed to spawn Prime Agent daemon: .*ENOENT/,
			);
		} finally {
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("succeeds when the spawned child loses the race to an already-serving daemon", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-race-"));
		const entrypoint = join(dir, "loser.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;
		const server: Server = createServer((socket) => {
			socket.on("error", () => undefined);
			send(socket, {
				type: "daemon_hello",
				socketPath,
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				appVersion: VERSION,
				schemaId: DAEMON_SCHEMA_ID,
				clientId: "fake-client",
				serverCapabilities: [],
			});
		});

		try {
			const ensurePromise = ensureInteractiveDaemonRunning(socketPath);
			// Let the child exit first, then bring up the winning daemon inside
			// the exit grace window.
			await new Promise((resolve) => setTimeout(resolve, 300));
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			await expect(ensurePromise).resolves.toBeUndefined();
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not attribute a previous run's log to a daemon that crashed before logging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-stale-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		const logPath = getDaemonLogPath(socketPath);
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "supervisor: error from an earlier run in /tmp/\u00fcml\u00e4ut-p\u00e4th\n");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/exited during startup \(code 7\)\. The daemon wrote nothing to its log/,
			);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("shutdownDaemonAndWait", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("returns true immediately when no daemon is running", async () => {
		expect(await shutdownDaemonAndWait(join(tmpdir(), "pa-launch-missing2.sock"))).toBe(true);
	});

	it("stops a running daemon and returns true", async () => {
		const daemon = await startFakeDaemon({ sessions: [{ id: "a", activeSessionId: "a", isStreaming: false }] });
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath)).toBe(true);
	});

	it("accepts an exited daemon that leaves a stale socket behind", async () => {
		if (process.platform === "win32") {
			return;
		}

		const daemon = await startCrashingDaemon();
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 100)).toBe(true);
		expect(existsSync(daemon.socketPath)).toBe(true);
	});

	it("shuts down a legacy daemon whose handshake lacks the supervisor identity", async () => {
		const commands: Array<{ type: string; authority?: unknown }> = [];
		const daemon = await startFakeDaemon({
			sessions: [{ id: "a", activeSessionId: "a", isStreaming: false }],
			onCommand: (command) => commands.push(command as { type: string; authority?: unknown }),
		});
		cleanups.push(daemon.close);

		expect(await shutdownDaemonAndWait(daemon.socketPath)).toBe(true);

		const shutdownCommand = commands.find((command) => command.type === "shutdown");
		expect(shutdownCommand).toBeDefined();
		// The legacy handshake lacks the identity, so the new client emits the
		// legacy command shape without authority and the legacy supervisor
		// accepts it, preserving forward-upgrade replacement.
		expect(shutdownCommand?.authority).toBeUndefined();
	});

	it("returns false when authority is rejected even if the daemon exits afterward", async () => {
		const daemon = await startFakeDaemon({
			rejectShutdown: true,
			closeAfterRejectedShutdown: true,
			supervisorGeneration: "reject-then-exit-generation",
			supervisorProcessStartId: "reject-then-exit-start",
		});
		cleanups.push(daemon.close);

		await expect(shutdownDaemonAndWait(daemon.socketPath, 100)).resolves.toBe(false);
	});

	it("sends authority-bearing shutdown to a schema-16 daemon that accepts unknown wire fields", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
			schemaRevision: 16,
			supervisorGeneration: "schema-16-generation",
			supervisorOwnerToken: "schema-16-owner",
			supervisorPid: 424240,
			supervisorProcessStartId: "schema-16-start",
			onCommand: (command) => commands.push({ ...(command as Record<string, unknown>) }),
		});
		cleanups.push(daemon.close);

		expect(await shutdownDaemonAndWait(daemon.socketPath)).toBe(true);
		expect(commands.find((command) => command.type === "shutdown")).toMatchObject({
			authority: {
				supervisorGeneration: "schema-16-generation",
				supervisorOwnerToken: "schema-16-owner",
				supervisorPid: 424240,
				supervisorProcessStartId: "schema-16-start",
				supervisorSocketPath: daemon.socketPath,
			},
		});
	});

	it("sends authority-bearing restart to a schema-16 daemon that accepts unknown wire fields", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
			schemaRevision: 16,
			supervisorGeneration: "schema-16-restart-generation",
			supervisorOwnerToken: "schema-16-restart-owner",
			supervisorPid: 424241,
			supervisorProcessStartId: "schema-16-restart-start",
			onCommand: (command) => commands.push({ ...(command as Record<string, unknown>) }),
		});
		cleanups.push(daemon.close);
		const client = new DaemonClient(daemon.socketPath);
		await client.connect();
		try {
			const response = await client.requestSupervisorRestart();
			expect(response.success).toBe(true);
			expect(commands.find((command) => command.type === "restart")).toMatchObject({
				authority: {
					supervisorGeneration: "schema-16-restart-generation",
					supervisorOwnerToken: "schema-16-restart-owner",
					supervisorPid: 424241,
					supervisorProcessStartId: "schema-16-restart-start",
					supervisorSocketPath: daemon.socketPath,
				},
			});
		} finally {
			client.close();
		}
	});

	it("emits authority from the same connection's hello toward a modern daemon", async () => {
		const socketPath = join(tmpdir(), `pa-launch-auth-${Math.random().toString(36).slice(2)}.sock`);
		const commands: Array<Record<string, unknown>> = [];
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-auth-"));
		const server: Server = createServer((socket) => {
			socket.on("error", () => undefined);
			send(socket, {
				type: "daemon_hello",
				socketPath,
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				appVersion: VERSION,
				schemaId: DAEMON_SCHEMA_ID,
				supervisorGeneration: "gen-auth",
				supervisorOwnerToken: "token-auth",
				supervisorPid: 424242,
				supervisorProcessStartId: "start-auth",
				supervisorSocketPath: socketPath,
				clientId: "fake-client",
				serverCapabilities: [],
			});
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line.trim()) {
						continue;
					}
					const wire = JSON.parse(line) as { id: string; type?: string; command?: { type: string } };
					const command = wire.command ?? wire;
					commands.push(command as Record<string, unknown>);
					if (command.type === "shutdown") {
						send(socket, { type: "response", command: "shutdown", id: wire.id, success: true });
						server.close();
						socket.end();
					}
				}
			});
		});
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					rmSync(dir, { recursive: true, force: true });
				}),
		);
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		expect(await shutdownDaemonAndWait(socketPath)).toBe(true);

		const shutdownCommand = commands.find((command) => command.type === "shutdown");
		expect(shutdownCommand).toMatchObject({
			authority: {
				supervisorGeneration: "gen-auth",
				supervisorOwnerToken: "token-auth",
				supervisorPid: 424242,
				supervisorProcessStartId: "start-auth",
				supervisorSocketPath: socketPath,
			},
		});
	});
});
