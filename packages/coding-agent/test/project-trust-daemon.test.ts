import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonClientCapability,
	type DaemonCommand,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

const netMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	type TrackedListener = Listener & { originalListener?: Listener };

	class MockSocket {
		private readonly listeners = new Map<string, Set<TrackedListener>>();
		readonly writes: string[] = [];
		destroyed = false;

		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? new Set<TrackedListener>();
			listeners.add(listener as TrackedListener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: Listener): this {
			const onceListener: TrackedListener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			onceListener.originalListener = listener;
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event);
			if (!listeners) return this;
			for (const registered of [...listeners]) {
				if (registered === listener || registered.originalListener === listener) {
					listeners.delete(registered);
				}
			}
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners) return false;
			for (const listener of [...listeners]) listener(...args);
			return true;
		}

		write(chunk: string | Buffer): boolean {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			return true;
		}

		end(): this {
			return this;
		}

		destroy(): this {
			this.destroyed = true;
			return this;
		}
	}

	const sockets: MockSocket[] = [];
	const createConnection = vi.fn(() => {
		const socket = new MockSocket();
		sockets.push(socket);
		return socket;
	});

	return { createConnection, createServer: vi.fn(), sockets };
});

vi.mock("node:net", () => ({
	createConnection: netMock.createConnection,
	createServer: netMock.createServer,
}));

interface WireCreateEnvelope {
	type: "command";
	id: string;
	protocol: { name: string; version: number };
	command: {
		id: string;
		type: "create";
		config?: { cwd?: string; projectTrusted?: boolean };
	};
}

interface ConnectedClient {
	client: DaemonClient;
	socket: (typeof netMock.sockets)[number];
}

interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	write: Mock<(client: DaemonSocketClient, message: DaemonOutbound) => void>;
	createOrReuseWorker: Mock<() => Promise<never>>;
}

function emitHello(socket: (typeof netMock.sockets)[number], version: number, schemaRevision: number): void {
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version },
			schemaRevision,
			schemaId: `protocol-${version}-schema-${schemaRevision}-fixture`,
			appVersion: "test",
			clientId: "client-1",
			serverCapabilities: [],
		})}\n`,
	);
}

async function connectClient(version: number, schemaRevision: number): Promise<ConnectedClient> {
	const client = new DaemonClient("/tmp/prime-agent.sock");
	const connecting = client.connect();
	const socket = netMock.sockets[0]!;
	socket.emit("connect");
	await connecting;
	emitHello(socket, version, schemaRevision);
	return { client, socket };
}

function createSupervisorHarness(): SupervisorHarness {
	const write = vi.fn<(client: DaemonSocketClient, message: DaemonOutbound) => void>();
	const createOrReuseWorker = vi.fn<() => Promise<never>>(async () => {
		throw new Error("unsafe create reached dispatcher");
	});

	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		ready: Promise.resolve(),
		ownership: {
			assertCurrent: vi.fn(async () => undefined),
			record: { token: "owner", processStartId: "process", socketPath: "/tmp/prime-agent.sock" },
		},
		workers: new Map(),
		clients: new Set(),
		protocolClientIds: new WeakMap(),
		promptAdmissions: new Map(),
		mutationDrain: new MutationDrainLatch(),
		commandJournal: {
			lookup: () => undefined,
			begin: () => ({ status: "new" as const }),
			recordResult: () => undefined,
			acknowledge: () => undefined,
		},
		write,
		log: vi.fn(),
		createOrReuseWorker,
	}) as unknown as SupervisorHarness;
}

describe("project trust daemon boundary", () => {
	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
		netMock.createServer.mockClear();
	});

	it("carries an explicit false projectTrusted value through runtime merging and the create wire command", async () => {
		const config = mergeAgentSessionRuntimeConfig(
			{ cwd: "/tmp/project", projectTrusted: true },
			{ projectTrusted: false },
		);
		expect(config.projectTrusted).toBe(false);

		const { client, socket } = await connectClient(8, 16);
		const pending = client.request({ type: "create", config });
		const envelope = JSON.parse(socket.writes[0]!) as WireCreateEnvelope;

		expect(envelope.protocol.version).toBe(8);
		expect(envelope.command.config?.projectTrusted).toBe(false);

		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "create",
				success: true,
				data: {},
			})}\n`,
		);
		await expect(pending).resolves.toMatchObject({ success: true, command: "create" });
		client.close();
	});

	it("publishes protocol 8, schema 18, and makes create a protocol-8 command", () => {
		expect(DAEMON_PROTOCOL_VERSION).toBe(8);
		expect(DAEMON_SCHEMA_REVISION).toBe(18);
		expect(DAEMON_SCHEMA_ID).toMatch(/^protocol-8-schema-18-[0-9a-f]{12}$/);
		expect(DAEMON_COMMAND_COMPATIBILITY.create).toEqual({ minProtocol: 8 });
	});

	it("keeps a new client from sending projectTrusted to an old daemon", async () => {
		const { client, socket } = await connectClient(7, 15);

		await expect(
			client.request({ type: "create", config: { cwd: "/tmp/project", projectTrusted: false } }),
		).rejects.toThrow("does not support create");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("makes a new daemon reject an old client's create before session construction", async () => {
		const supervisor = createSupervisorHarness();
		const oldClient = {
			id: "old-client",
			socket: new PassThrough() as unknown as Socket,
			attachedActiveSessionIds: new Set<string>(),
			detachInput: () => undefined,
			supportsExtensionUi: false,
			capabilities: new Set<DaemonClientCapability>(),
		} satisfies DaemonSocketClient;
		const oldCreate = {
			id: "old-create",
			type: "create",
			config: { cwd: "/tmp/project" },
		} satisfies DaemonCommand;
		const oldEnvelope = createDaemonCommandEnvelope(oldCreate, oldCreate.id, oldClient.id, 7);

		await supervisor.handleLine(oldClient, JSON.stringify(oldEnvelope));

		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(supervisor.write).toHaveBeenCalledOnce();
		const response = supervisor.write.mock.calls[0]?.[1];
		if (!response || response.type !== "response" || response.success) {
			throw new Error("Expected a daemon protocol rejection response");
		}
		expect(response.command).toBe("create");
		expect(response.error).toContain("protocol 8");
	});
});
