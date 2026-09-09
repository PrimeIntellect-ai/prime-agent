import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	DaemonCapabilityUnavailableError,
	DaemonClient,
	DaemonPeerIdentityError,
} from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonEndpointNonce,
	createDaemonEndpointProof,
	DAEMON_ENDPOINT_SECRET_FILE_NAME,
	DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV,
	daemonEndpointIdentityRequired,
	loadDaemonEndpointSecret,
	verifyDaemonEndpointProof,
} from "../src/modes/daemon/daemon-endpoint-identity.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import {
	daemonEndpointOwnerKey,
	defaultDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

// ENG-5340: the Windows named pipe had no ownership, occupancy, or peer identity
// checks, so a process that pre-created the pipe received the client's create
// command with its full launch environment. These tests run on Linux: platform
// behaviour is stubbed, and Unix sockets stand in for the pipe.

const tempDirs: string[] = [];
const servers: Server[] = [];
const clients: DaemonClient[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					if (!server.listening) return resolve();
					server.close(() => resolve());
				}),
		),
	);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

async function withPlatformAsync<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: platform });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

describe("daemon endpoint secret", () => {
	it("creates an owner-only secret once and reuses it", () => {
		const agentDir = join(tempDir("pa-endpoint-secret-"), "agent");
		const first = loadDaemonEndpointSecret(agentDir);
		const second = loadDaemonEndpointSecret(agentDir);

		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toBe(first);
		const path = join(agentDir, DAEMON_ENDPOINT_SECRET_FILE_NAME);
		expect(readFileSync(path, "utf8").trim()).toBe(first);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("repairs a secret file left readable by other users", () => {
		if (process.platform === "win32") return;
		const agentDir = tempDir("pa-endpoint-secret-mode-");
		const path = join(agentDir, DAEMON_ENDPOINT_SECRET_FILE_NAME);
		writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o644 });

		expect(loadDaemonEndpointSecret(agentDir)).toBe("ab".repeat(32));
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("rejects a malformed secret file instead of adopting it", () => {
		const agentDir = tempDir("pa-endpoint-secret-bad-");
		writeFileSync(join(agentDir, DAEMON_ENDPOINT_SECRET_FILE_NAME), "not-a-secret\n");

		expect(() => loadDaemonEndpointSecret(agentDir)).toThrow(/invalid format/);
	});

	it("binds proofs to the role and both nonces", () => {
		const secret = "11".repeat(32);
		const challenge = createDaemonEndpointNonce();
		const nonce = createDaemonEndpointNonce();
		const clientProof = createDaemonEndpointProof(secret, "client", challenge, nonce);
		const daemonProof = createDaemonEndpointProof(secret, "daemon", challenge, nonce);

		expect(verifyDaemonEndpointProof(secret, "client", challenge, nonce, clientProof)).toBe(true);
		expect(verifyDaemonEndpointProof(secret, "daemon", challenge, nonce, daemonProof)).toBe(true);
		// A reflected proof or one under another secret/nonce never verifies.
		expect(verifyDaemonEndpointProof(secret, "daemon", challenge, nonce, clientProof)).toBe(false);
		expect(verifyDaemonEndpointProof(secret, "client", challenge, nonce, daemonProof)).toBe(false);
		expect(verifyDaemonEndpointProof("22".repeat(32), "client", challenge, nonce, clientProof)).toBe(false);
		expect(verifyDaemonEndpointProof(secret, "client", createDaemonEndpointNonce(), nonce, clientProof)).toBe(false);
		expect(verifyDaemonEndpointProof(secret, "client", challenge, createDaemonEndpointNonce(), clientProof)).toBe(
			false,
		);
		expect(verifyDaemonEndpointProof(secret, "client", challenge, nonce, undefined)).toBe(false);
		expect(verifyDaemonEndpointProof(secret, "client", challenge, nonce, "zz")).toBe(false);
		expect(verifyDaemonEndpointProof(secret, "client", "", nonce, clientProof)).toBe(false);
	});

	it("is required on Windows and opt-in elsewhere", () => {
		expect(daemonEndpointIdentityRequired({}, "win32")).toBe(true);
		expect(daemonEndpointIdentityRequired({}, "linux")).toBe(false);
		expect(daemonEndpointIdentityRequired({}, "darwin")).toBe(false);
		expect(daemonEndpointIdentityRequired({ [DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV]: "1" }, "linux")).toBe(true);
		expect(daemonEndpointIdentityRequired({ [DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV]: "true" }, "darwin")).toBe(true);
		expect(daemonEndpointIdentityRequired({ [DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV]: "0" }, "linux")).toBe(false);
	});
});

describe("Windows daemon endpoint naming", () => {
	it("derives a per-user, per-agent-dir pipe name", () => {
		const env = { USERDOMAIN: "HOST" };
		const keyA = daemonEndpointOwnerKey("C:\\Users\\alice\\.prime\\agent", env, "alice");

		expect(keyA).toMatch(/^[0-9a-f]{16}$/);
		expect(daemonEndpointOwnerKey("C:\\Users\\alice\\.prime\\agent", env, "alice")).toBe(keyA);
		// Another account, another domain, or another agent dir gets its own endpoint.
		expect(daemonEndpointOwnerKey("C:\\Users\\alice\\.prime\\agent", env, "bob")).not.toBe(keyA);
		expect(daemonEndpointOwnerKey("C:\\Users\\alice\\.prime\\agent", { USERDOMAIN: "OTHER" }, "alice")).not.toBe(
			keyA,
		);
		expect(daemonEndpointOwnerKey("C:\\Users\\alice\\other", env, "alice")).not.toBe(keyA);
		// Case differences in the agent dir (case-insensitive filesystem) do not fork the endpoint.
		expect(daemonEndpointOwnerKey("c:\\users\\ALICE\\.prime\\AGENT", env, "alice")).toBe(keyA);
		// The default username comes from the OS account, not from a spoofable environment variable.
		expect(daemonEndpointOwnerKey("/tmp/agent", { USERNAME: "someone-else" })).toBe(
			daemonEndpointOwnerKey("/tmp/agent", {}),
		);
	});

	it("names the Windows pipe after the endpoint owner key", () => {
		const pipe = withPlatform("win32", () => defaultDaemonSocketPath());
		expect(pipe).toBe(`\\\\.\\pipe\\prime-agent-daemon-${daemonEndpointOwnerKey()}`);
		expect(pipe).not.toBe("\\\\.\\pipe\\prime-agent-daemon");
	});

	it("refuses to start over an endpoint that already answers", async () => {
		if (process.platform === "win32") return;
		const dir = tempDir("pa-endpoint-occupied-");
		const endpoint = join(dir, "pipe-stand-in.sock");
		const server = createServer((socket) => socket.destroy());
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, resolve);
		});

		await expect(withPlatformAsync("win32", () => prepareDaemonSocketPath(endpoint))).rejects.toThrow(
			/socket already in use/i,
		);
		// A free endpoint is accepted without touching the filesystem.
		await expect(
			withPlatformAsync("win32", () => prepareDaemonSocketPath(join(dir, "free-pipe-stand-in.sock"))),
		).resolves.toBeUndefined();
	});
});

interface FakeDaemonOptions {
	serverCapabilities?: string[];
	endpointChallenge?: string;
	endpointHandshakeRequired?: true;
	secret?: string;
	sendHello?: boolean;
	onCommand?: (command: { type: string; id: string; body: Record<string, unknown> }, socket: Socket) => void;
}

interface FakeDaemon {
	socketPath: string;
	received: Array<{ type: string; body: Record<string, unknown> }>;
	connections: Socket[];
}

function reply(socket: Socket, response: DaemonResponse): void {
	socket.write(`${JSON.stringify(response)}\n`);
}

/** Stands in for whoever owns the endpoint: honest daemon, old daemon, or a squatter without the secret. */
async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const dir = tempDir("pa-endpoint-fake-");
	const socketPath = join(dir, "daemon.sock");
	const fake: FakeDaemon = { socketPath, received: [], connections: [] };
	const server = createServer((socket) => {
		fake.connections.push(socket);
		socket.on("error", () => undefined);
		if (options.sendHello ?? true) {
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
					schemaId: DAEMON_SCHEMA_ID,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					clientId: "fake-client",
					serverCapabilities: options.serverCapabilities ?? [],
					...(options.endpointChallenge ? { endpointChallenge: options.endpointChallenge } : {}),
					...(options.endpointHandshakeRequired ? { endpointHandshakeRequired: true } : {}),
				})}\n`,
			);
		}
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				const wire = JSON.parse(line) as { id: string; type: string; command?: DaemonCommand };
				const body = (wire.command ?? wire) as unknown as Record<string, unknown>;
				const type = String(body.type);
				fake.received.push({ type, body });
				if (options.onCommand) {
					options.onCommand({ type, id: wire.id, body }, socket);
					continue;
				}
				if (type === "endpoint_handshake") {
					const secret = options.secret;
					const challenge = options.endpointChallenge ?? "";
					const nonce = String(body.nonce);
					if (secret && verifyDaemonEndpointProof(secret, "client", challenge, nonce, body.proof)) {
						reply(socket, {
							id: wire.id,
							type: "response",
							command: type,
							success: true,
							data: { proof: createDaemonEndpointProof(secret, "daemon", challenge, nonce) },
						});
					} else {
						// A squatter cannot compute the proof; the best it can do is guess.
						reply(socket, {
							id: wire.id,
							type: "response",
							command: type,
							success: true,
							data: { proof: "00".repeat(32) },
						});
					}
					continue;
				}
				reply(socket, { id: wire.id, type: "response", command: type, success: true, data: { sessions: [] } });
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return fake;
}

async function connectClient(
	socketPath: string,
	options: { requirePeerIdentity?: boolean; secret?: string } = {},
): Promise<DaemonClient> {
	const client = new DaemonClient(socketPath, {
		requirePeerIdentity: options.requirePeerIdentity,
		loadEndpointSecret: () => options.secret ?? "cc".repeat(32),
	});
	clients.push(client);
	await client.connect(1000);
	await client.waitForHello(2000);
	return client;
}

const SENSITIVE_CREATE = {
	type: "create" as const,
	config: { apiKey: "SYNTH-PROVIDER-KEY-5340" },
	launchEnv: { OPENAI_API_KEY: "SYNTH-OPENAI-KEY-5340", PATH: "/usr/bin" },
};

describe("DaemonClient peer identity (Windows policy)", () => {
	it("refuses to send create to an endpoint owner that cannot prove the secret", async () => {
		const secret = "aa".repeat(32);
		// Squatter: advertises everything a current daemon would, but has no secret.
		const squatter = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
		});
		const client = await connectClient(squatter.socketPath, { requirePeerIdentity: true, secret });

		await expect(client.request(SENSITIVE_CREATE)).rejects.toBeInstanceOf(DaemonPeerIdentityError);
		expect(squatter.received.map((entry) => entry.type)).toEqual(["endpoint_handshake"]);
		expect(JSON.stringify(squatter.received)).not.toContain("SYNTH-");
		// The connection is dropped so nothing else can leak on it.
		await vi.waitFor(() => expect(client.isConnected).toBe(false));
	});

	it("does not hand the secret itself to the endpoint owner", async () => {
		const secret = "ab".repeat(32);
		const squatter = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
		});
		const client = await connectClient(squatter.socketPath, { requirePeerIdentity: true, secret });

		await client.request(SENSITIVE_CREATE).catch(() => undefined);
		expect(JSON.stringify(squatter.received)).not.toContain(secret);
	});

	it("refuses an old daemon without endpoint identity except for stale-daemon retirement", async () => {
		// New client, old daemon: hello has no capability and no challenge.
		const oldDaemon = await startFakeDaemon({ serverCapabilities: ["session_input_admission"] });
		const client = await connectClient(oldDaemon.socketPath, { requirePeerIdentity: true });

		const error = await client.request(SENSITIVE_CREATE).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DaemonCapabilityUnavailableError);
		expect((error as DaemonCapabilityUnavailableError).capability).toBe("endpoint_identity");
		expect(oldDaemon.received).toEqual([]);

		await expect(client.request({ type: "list" })).resolves.toMatchObject({ success: true });
		await expect(client.request({ type: "shutdown" })).resolves.toMatchObject({ success: true });
		expect(oldDaemon.received.map((entry) => entry.type)).toEqual(["list", "shutdown"]);
		expect(JSON.stringify(oldDaemon.received)).not.toContain("SYNTH-");
	});

	it("sends create only after the daemon proves the shared secret", async () => {
		const secret = "ad".repeat(32);
		const daemon = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
			secret,
		});
		const client = await connectClient(daemon.socketPath, { requirePeerIdentity: true, secret });

		const [first, second] = await Promise.all([client.request(SENSITIVE_CREATE), client.request({ type: "list" })]);
		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		// One handshake per connection, ahead of every command.
		expect(daemon.received.map((entry) => entry.type)).toEqual(["endpoint_handshake", "create", "list"]);
		expect(daemon.received[0]!.body.proof).toMatch(/^[0-9a-f]{64}$/);
		expect(daemon.received[1]!.body.launchEnv).toEqual(SENSITIVE_CREATE.launchEnv);
	});

	it("rejects a daemon whose proof was made with another user's secret", async () => {
		const daemon = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
			secret: "ae".repeat(32),
		});
		const client = await connectClient(daemon.socketPath, { requirePeerIdentity: true, secret: "af".repeat(32) });

		await expect(client.request({ type: "list" })).rejects.toBeInstanceOf(DaemonPeerIdentityError);
		expect(daemon.received.map((entry) => entry.type)).toEqual(["endpoint_handshake"]);
	});

	it("keeps Unix behaviour unchanged when identity is not required", async () => {
		const daemon = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
			secret: "ba".repeat(32),
		});
		const client = await connectClient(daemon.socketPath, { requirePeerIdentity: false });

		await expect(client.request({ type: "list" })).resolves.toMatchObject({ success: true });
		expect(daemon.received.map((entry) => entry.type)).toEqual(["list"]);
	});

	it("verifies the peer when the daemon declares the handshake required", async () => {
		const secret = "bb".repeat(32);
		const daemon = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: createDaemonEndpointNonce(),
			endpointHandshakeRequired: true,
			secret,
		});
		const client = await connectClient(daemon.socketPath, { requirePeerIdentity: false, secret });

		await expect(client.request({ type: "list" })).resolves.toMatchObject({ success: true });
		expect(daemon.received.map((entry) => entry.type)).toEqual(["endpoint_handshake", "list"]);
	});

	it("verifies a reconnected daemon before replaying parked commands", async () => {
		const secret = "bc".repeat(32);
		const challenge = createDaemonEndpointNonce();
		const daemon = await startFakeDaemon({
			serverCapabilities: ["endpoint_identity"],
			endpointChallenge: challenge,
			onCommand: ({ type, id, body }, socket) => {
				if (type === "endpoint_handshake") {
					reply(socket, {
						id,
						type: "response",
						command: type,
						success: true,
						data: { proof: createDaemonEndpointProof(secret, "daemon", challenge, String(body.nonce)) },
					});
					return;
				}
				if (type === "create" && daemon.connections.length === 1) {
					// The first incarnation dies mid-command; the client parks the create for replay.
					socket.destroy();
					return;
				}
				reply(socket, { id, type: "response", command: type, success: true, data: {} });
			},
		});
		const client = new DaemonClient(daemon.socketPath, {
			requirePeerIdentity: true,
			loadEndpointSecret: () => secret,
		});
		clients.push(client);
		client.enableAutoReconnect({ recoverDaemon: async () => {} });
		await client.connect(1000);
		await client.waitForHello(2000);

		const response = await client.request(SENSITIVE_CREATE, 10_000);
		expect(response.success).toBe(true);
		expect(daemon.connections).toHaveLength(2);
		// The replayed create waits for the new connection's handshake.
		expect(daemon.received.map((entry) => entry.type)).toEqual([
			"endpoint_handshake",
			"create",
			"endpoint_handshake",
			"create",
		]);
	});
});

// Constructor-bypass harness mirroring daemon-supervisor-admission.test.ts.
interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	write: ReturnType<typeof vi.fn>;
}

function createSupervisorHarness(options: { requireEndpointHandshake: boolean; secret?: string }): SupervisorHarness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		ready: Promise.resolve(),
		ownership: {
			assertCurrent: vi.fn(async () => undefined),
			record: { token: "test-owner", processStartId: "test-process", socketPath: "/tmp/test.sock" },
		},
		workers: new Map(),
		clients: new Set(),
		connectionIds: new WeakMap(),
		sessionInputPauseEpochs: new WeakMap(),
		detachingInputPauseSessions: new WeakMap(),
		protocolClientIds: new WeakMap(),
		promptAdmissions: new Map(),
		sessionInputPauses: new Map(),
		mutationDrain: new MutationDrainLatch(),
		commandJournal: {
			lookup: vi.fn(() => undefined),
			begin: vi.fn(() => ({ status: "new" })),
			recordResult: vi.fn(),
			acknowledge: vi.fn(),
		},
		requireEndpointHandshake: options.requireEndpointHandshake,
		endpointSecret: options.secret,
		findWorkerForClient: vi.fn(),
		forwardToWorker: vi.fn(),
		write: vi.fn(),
		log: vi.fn(),
	}) as SupervisorHarness;
}

function harnessClient(
	id: string,
	options: { authenticated: boolean; endpointChallenge?: string },
): DaemonSocketClient {
	return {
		id,
		socket: { end: vi.fn(), destroyed: false } as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		capabilities: new Set(),
		authenticated: options.authenticated,
		endpointChallenge: options.endpointChallenge,
		detachInput: () => {},
		supportsExtensionUi: false,
	};
}

function commandLine(command: DaemonCommand & { id: string }): string {
	return JSON.stringify(createDaemonCommandEnvelope(command, command.id, "client-1"));
}

function lastResponse(supervisor: SupervisorHarness): DaemonResponse {
	return supervisor.write.mock.calls.at(-1)![1] as DaemonResponse;
}

describe("daemon supervisor endpoint handshake", () => {
	const secret = "dd".repeat(32);

	it("rejects and disconnects an unverified client before any command runs", async () => {
		// Old client, new daemon: the client never sends endpoint_handshake.
		const supervisor = createSupervisorHarness({ requireEndpointHandshake: true, secret });
		const client = harnessClient("legacy", { authenticated: false, endpointChallenge: createDaemonEndpointNonce() });

		await supervisor.handleLine(client, commandLine({ id: "c1", type: "list" }));

		expect(lastResponse(supervisor)).toMatchObject({
			id: "c1",
			command: "list",
			success: false,
			error: expect.stringMatching(/Endpoint handshake required/),
		});
		expect(client.socket.end).toHaveBeenCalledOnce();
	});

	it("authenticates a client that answers the challenge and returns the daemon proof", async () => {
		const supervisor = createSupervisorHarness({ requireEndpointHandshake: true, secret });
		const challenge = createDaemonEndpointNonce();
		const client = harnessClient("current", { authenticated: false, endpointChallenge: challenge });
		const nonce = createDaemonEndpointNonce();

		await supervisor.handleLine(
			client,
			commandLine({
				id: "h1",
				type: "endpoint_handshake",
				nonce,
				proof: createDaemonEndpointProof(secret, "client", challenge, nonce),
			}),
		);

		const response = lastResponse(supervisor);
		expect(response).toMatchObject({ id: "h1", command: "endpoint_handshake", success: true });
		const proof = (response as { data?: { proof?: unknown } }).data?.proof;
		expect(verifyDaemonEndpointProof(secret, "daemon", challenge, nonce, proof)).toBe(true);
		expect(client.authenticated).toBe(true);
		expect(client.socket.end).not.toHaveBeenCalled();

		// Subsequent commands pass the gate (and fail later only because the harness has no workers wired).
		await supervisor.handleLine(client, commandLine({ id: "c2", type: "list" }));
		expect(lastResponse(supervisor)).toMatchObject({ id: "c2", command: "list" });
		expect((lastResponse(supervisor) as { error?: string }).error ?? "").not.toMatch(/Endpoint handshake required/);
	});

	it("rejects a proof computed without the secret or against another challenge", async () => {
		const supervisor = createSupervisorHarness({ requireEndpointHandshake: true, secret });
		const challenge = createDaemonEndpointNonce();
		const nonce = createDaemonEndpointNonce();
		const wrongSecret = harnessClient("wrong-secret", { authenticated: false, endpointChallenge: challenge });
		await supervisor.handleLine(
			wrongSecret,
			commandLine({
				id: "h2",
				type: "endpoint_handshake",
				nonce,
				proof: createDaemonEndpointProof("ee".repeat(32), "client", challenge, nonce),
			}),
		);
		expect(lastResponse(supervisor)).toMatchObject({ id: "h2", success: false, error: "Endpoint handshake failed" });
		expect(wrongSecret.socket.end).toHaveBeenCalledOnce();
		expect(wrongSecret.authenticated).toBe(false);

		const replayed = harnessClient("replayed", { authenticated: false, endpointChallenge: challenge });
		await supervisor.handleLine(
			replayed,
			commandLine({
				id: "h3",
				type: "endpoint_handshake",
				nonce,
				proof: createDaemonEndpointProof(secret, "client", createDaemonEndpointNonce(), nonce),
			}),
		);
		expect(lastResponse(supervisor)).toMatchObject({ id: "h3", success: false, error: "Endpoint handshake failed" });
		expect(replayed.socket.end).toHaveBeenCalledOnce();

		const reflected = harnessClient("reflected", { authenticated: false, endpointChallenge: challenge });
		await supervisor.handleLine(
			reflected,
			commandLine({
				id: "h4",
				type: "endpoint_handshake",
				nonce,
				proof: createDaemonEndpointProof(secret, "daemon", challenge, nonce),
			}),
		);
		expect(lastResponse(supervisor)).toMatchObject({ id: "h4", success: false });
	});

	it("keeps accepting unauthenticated Unix clients when the handshake is not required", async () => {
		const supervisor = createSupervisorHarness({ requireEndpointHandshake: false, secret });
		const client = harnessClient("unix", { authenticated: true, endpointChallenge: createDaemonEndpointNonce() });

		await supervisor.handleLine(client, commandLine({ id: "c3", type: "list" }));

		expect((lastResponse(supervisor) as { error?: string }).error ?? "").not.toMatch(/Endpoint handshake required/);
		expect(client.socket.end).not.toHaveBeenCalled();
	});
});
