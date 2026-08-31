import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, getDaemonSocketCloseReason } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_REVISION,
} from "../src/modes/daemon/daemon-protocol.js";

const netMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	type TrackedListener = Listener & { originalListener?: Listener };

	class MockSocket {
		private readonly listeners = new Map<string, Set<TrackedListener>>();
		readonly writes: string[] = [];
		destroyed = false;

		constructor(readonly path: string) {}

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
			if (!listeners) {
				return this;
			}
			for (const registered of [...listeners]) {
				if (registered === listener || registered.originalListener === listener) {
					listeners.delete(registered);
				}
			}
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners) {
				return false;
			}
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}

		destroy(): this {
			this.destroyed = true;
			return this;
		}

		end(): this {
			return this;
		}

		write(chunk: string | Buffer): boolean {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			return true;
		}

		listenerCount(event: string): number {
			return this.listeners.get(event)?.size ?? 0;
		}
	}

	const sockets: MockSocket[] = [];
	const createConnection = vi.fn((path: string) => {
		const socket = new MockSocket(path);
		sockets.push(socket);
		return socket;
	});

	return { createConnection, sockets };
});

vi.mock("node:net", () => ({
	createConnection: netMock.createConnection,
}));

function emitHello(
	socket: (typeof netMock.sockets)[number],
	version = DAEMON_PROTOCOL_VERSION,
	serverCapabilities: string[] = ["session_input_admission"],
	schemaRevision?: number,
): void {
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version },
			schemaRevision,
			appVersion: "9.9.9",
			clientId: "client-1",
			serverCapabilities,
		})}\n`,
	);
}

describe("DaemonClient", () => {
	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("allows connect retry after the socket emits an error before connecting", async () => {
		const client = new DaemonClient("/tmp/prime-agent-missing.sock");

		const firstAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;
		expect(firstSocket.listenerCount("data")).toBe(1);

		firstSocket.emit("error", new Error("initial connect failed"));

		const firstError = await firstAttempt;
		expect(firstError.message).toContain("Failed to connect to the Prime Agent daemon: initial connect failed.");
		expect(firstError.message).toContain("Socket: /tmp/prime-agent-missing.sock.");
		expect(firstError.message).toContain("Daemon log:");
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Failed to connect to the Prime Agent daemon: retry reached socket."),
		});
	});

	it("allows connect retry after the initial connection times out", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent-slow.sock");

		const firstAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;

		const timeoutRejection = expect(firstAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Timed out after 5ms connecting to the Prime Agent daemon."),
		});
		await vi.advanceTimersByTimeAsync(5);
		await timeoutRejection;

		expect(firstSocket.destroyed).toBe(true);
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({
			message: expect.stringContaining("Failed to connect to the Prime Agent daemon: retry reached socket."),
		});
	});

	it("captures the daemon hello greeting for version checks", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		expect(client.hello).toBeUndefined();
		const waited = client.waitForHello();
		const hello = {
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version: 1 },
			appVersion: "9.9.9",
			clientId: "client-1",
			serverCapabilities: [],
		};
		socket.emit("data", `${JSON.stringify(hello)}\n`);

		await expect(waited).resolves.toMatchObject({ appVersion: "9.9.9" });
		expect(client.hello).toMatchObject({ protocol: { version: 1 }, appVersion: "9.9.9" });
		await expect(client.waitForHello()).resolves.toMatchObject({ appVersion: "9.9.9" });

		client.close();
	});

	it("rejects unsupported optional commands without writing them to an older daemon", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, 3);

		expect(client.supportsServerCapability("heartbeat_catalog")).toBe(false);
		await expect(client.request({ type: "heartbeats_list" })).rejects.toThrow("does not support heartbeat_catalog");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("does not send subagent deletion to an old daemon without the capability", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION, []);

		await expect(
			client.request({ type: "delete_rlm_subagent", activeSessionId: "active-1", childId: "child-1" }),
		).rejects.toThrow("does not support delete_rlm_subagent");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("sends subagent deletion to a capable daemon without requiring a schema bump", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION, ["delete_rlm_subagent"], DAEMON_SCHEMA_REVISION - 1);

		const request = client.request({
			type: "delete_rlm_subagent",
			activeSessionId: "active-1",
			childId: "child-1",
		});
		await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
		client.close();
		await expect(request).rejects.toThrow("closed before the operation completed");
	});

	it("rejects an old daemon before requesting session state", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION - 1);

		await expect(client.request({ type: "get_state", activeSessionId: "active-1" })).rejects.toThrow(
			"does not support get_state",
		);
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("rejects session input admission clearly when an old daemon lacks the capability", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION, []);

		await expect(
			client.request({ type: "prompt", activeSessionId: "active-1", message: "hello", queueIfBusy: true }),
		).rejects.toThrow("does not support session_input_admission");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("field-gates prompt admissionId before writing raw commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION, ["session_input_admission", "prompt_admission_cancellation"], 3);

		await expect(
			client.request({ type: "prompt", activeSessionId: "active-1", message: "hello", admissionId: "a-1" }),
		).rejects.toThrow("does not support prompt_admission_cancellation");
		expect(socket.writes).toEqual([]);
		client.close();
	});

	it("accepts a newer compatible daemon schema for admission-gated prompts", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		const compatibility = DAEMON_COMMAND_COMPATIBILITY.cancel_prompt_admission;
		emitHello(
			socket,
			compatibility.minProtocol,
			["session_input_admission", "prompt_admission_cancellation"],
			compatibility.minSchemaRevision + 1,
		);

		const request = client.request({
			type: "prompt",
			activeSessionId: "active-1",
			message: "hello",
			admissionId: "a-1",
		});
		await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
		client.close();
		await expect(request).rejects.toThrow("closed before the operation completed");
	});

	it("isolates a message consumer failure from the rest of the client", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);
		let delivered = 0;
		client.onMessage(() => {
			throw new Error("broken optional consumer");
		});
		client.onMessage(() => delivered++);

		expect(() => socket.emit("data", `${JSON.stringify({ type: "heartbeats_changed" })}\n`)).not.toThrow();
		expect(delivered).toBe(1);
		client.close();
	});

	it("serializes activeSessionId for session commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "attach", activeSessionId: "active-1" });
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			clientId?: string;
			protocol?: { name?: string; version?: number };
			command?: { type?: string; activeSessionId?: string; daemonSessionId?: unknown };
		};

		expect(envelope).toMatchObject({
			type: "command",
			clientId: expect.any(String),
			protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
			command: { type: "attach", activeSessionId: "active-1" },
		});
		expect(envelope.command).not.toHaveProperty("daemonSessionId");

		socket.emit(
			"data",
			`${JSON.stringify({ id: envelope.id, type: "response", command: "attach", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("serializes list commands with all sessions requested", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "list", all: true });
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: { type?: string; all?: boolean };
		};

		expect(envelope).toMatchObject({ type: "command", command: { type: "list", all: true } });

		socket.emit("data", `${JSON.stringify({ id: envelope.id, type: "response", command: "list", success: true })}\n`);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("includes command, socket, and log context when a request is made while disconnected", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const request = client.request({ type: "list", all: true });

		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining(
				'Cannot send daemon command "list" because the Prime Agent daemon is not connected.',
			),
		});
		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining("Socket: /tmp/prime-agent.sock."),
		});
		await expect(request).rejects.toMatchObject({
			message: expect.stringContaining("Daemon log:"),
		});
	});

	it("keeps durable command envelopes on the session-action protocol", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket, DAEMON_PROTOCOL_VERSION);

		const response = client.request({ type: "create" });
		const request = JSON.parse(socket.writes[0]!.trim()) as {
			id: string;
			protocol: { version: number };
		};
		expect(request.protocol.version).toBe(DAEMON_PROTOCOL_VERSION);

		socket.emit(
			"data",
			`${JSON.stringify({ id: request.id, type: "response", command: "create", success: true })}\n`,
		);
		await response;

		const acknowledgement = JSON.parse(socket.writes[1]!.trim()) as {
			protocol: { version: number };
			command: { type: string; commandId: string };
		};
		expect(acknowledgement).toMatchObject({
			protocol: { version: DAEMON_PROTOCOL_VERSION },
			command: { type: "ack_result", commandId: request.id },
		});
		client.close();
	});

	it("routes request progress by response id without notifying general listeners", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const progress: Array<[number, number]> = [];
		const discovered: string[] = [];
		let discoveredStatus: unknown;
		const listenerMessages: unknown[] = [];
		const unsubscribe = client.onMessage((message) => {
			listenerMessages.push(message);
		});
		const response = client.request(
			{ type: "list_saved_sessions", activeSessionId: "active-1", scope: "current" },
			30000,
			{
				onProgress: (message) => {
					if (message.type === "session_list_progress") {
						progress.push([message.loaded, message.total]);
					} else {
						discovered.push(message.session.id);
						discoveredStatus = message.session.agentStatus;
					}
				},
			},
		);
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: { activeSessionId?: string; scope?: string };
		};

		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "session_list_progress",
				command: "list_saved_sessions",
				activeSessionId: "active-1",
				loaded: 1,
				total: 2,
			})}\n`,
		);
		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "session_list_item",
				command: "list_saved_sessions",
				activeSessionId: "active-1",
				session: {
					path: "/tmp/session-a.jsonl",
					id: "session-a",
					cwd: "/tmp",
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-02T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "hello",
					allMessagesText: "hello",
					agentStatus: {
						summary: "Finished the task",
						taskState: "completed",
						basedOnMessageCount: 1,
					},
				},
			})}\n`,
		);
		socket.emit(
			"data",
			`${JSON.stringify({
				id: envelope.id,
				type: "response",
				command: "list_saved_sessions",
				success: true,
				data: { sessions: [] },
			})}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });
		expect(progress).toEqual([[1, 2]]);
		expect(discovered).toEqual(["session-a"]);
		expect(discoveredStatus).toEqual({
			summary: "Finished the task",
			taskState: "completed",
			basedOnMessageCount: 1,
		});
		expect(listenerMessages).toEqual([]);

		unsubscribe();
		client.close();
	});

	it("serializes per-session config for create commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({
			type: "create",
			name: "configured",
			config: {
				cwd: "/tmp/project",
				model: "openai/gpt-4o-mini",
				tools: ["bash"],
			},
		});
		expect(socket.writes).toHaveLength(1);
		const envelope = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			command?: {
				type?: string;
				name?: string;
				config?: {
					cwd?: string;
					model?: string;
					tools?: string[];
				};
				cwd?: unknown;
				model?: unknown;
			};
		};

		expect(envelope).toMatchObject({
			type: "command",
			command: {
				type: "create",
				name: "configured",
				config: {
					cwd: "/tmp/project",
					model: "openai/gpt-4o-mini",
					tools: ["bash"],
				},
			},
		});
		expect(envelope.command).not.toHaveProperty("cwd");
		expect(envelope.command).not.toHaveProperty("model");

		socket.emit(
			"data",
			`${JSON.stringify({ id: envelope.id, type: "response", command: "create", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: envelope.id, success: true });

		client.close();
	});

	it("acknowledges durable mutating-command results on the current protocol", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		emitHello(socket);

		const response = client.request({ type: "create" });
		const request = JSON.parse(socket.writes[0]!.trim()) as { id: string };
		socket.emit(
			"data",
			`${JSON.stringify({ id: request.id, type: "response", command: "create", success: true })}\n`,
		);
		await response;

		expect(socket.writes).toHaveLength(2);
		expect(JSON.parse(socket.writes[1]!.trim())).toMatchObject({
			type: "command",
			command: { type: "ack_result", commandId: request.id },
		});
		client.close();
	});

	it("notifies listeners when a connected daemon socket closes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		expect(client.isConnected).toBe(false);

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;
		expect(client.isConnected).toBe(true);

		const closed: Error[] = [];
		const unsubscribe = client.onClose((error) => closed.push(error));

		socket.emit("close");

		expect(closed).toHaveLength(1);
		expect(closed[0]?.message).toContain("Connection to the Prime Agent daemon closed.");
		expect(closed[0]?.message).toContain("Socket: /tmp/prime-agent.sock.");
		expect(closed[0]?.message).toContain("Daemon log:");
		expect(client.isConnected).toBe(false);
		unsubscribe();
		client.close();
	});

	it.each(["shutdown", "update"] as const)("preserves the daemon %s reason on socket close", async (reason) => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const closed: Error[] = [];
		client.onClose((error) => closed.push(error));
		socket.emit("data", `${JSON.stringify({ type: "daemon_closing", reason })}\n`);
		socket.emit("close");

		expect(closed).toHaveLength(1);
		expect(getDaemonSocketCloseReason(closed[0]!)).toBe(reason);
		expect(closed[0]?.message).toContain(`Reason: ${reason}.`);
		client.close();
	});

	it("notifies every listener before disconnecting a shared client for update reconnect", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const connect = client.connect();
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const firstClosed: Error[] = [];
		const secondClosed: Error[] = [];
		client.onClose((error) => firstClosed.push(error));
		client.onClose((error) => secondClosed.push(error));

		client.disconnectForReconnect("update");

		expect(client.isConnected).toBe(false);
		expect(firstClosed).toHaveLength(1);
		expect(secondClosed).toHaveLength(1);
		expect(getDaemonSocketCloseReason(firstClosed[0]!)).toBe("update");
		expect(getDaemonSocketCloseReason(secondClosed[0]!)).toBe("update");
	});

	it("notifies listeners once when a socket error is followed by close", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const closed: Error[] = [];
		client.onClose((error) => closed.push(error));

		socket.emit("error", new Error("daemon crashed"));
		socket.emit("close");

		expect(closed.map((error) => error.message)).toEqual(["daemon crashed"]);
		client.close();
	});

	it("allows connect retry after a connected daemon socket closes", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const firstConnect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;

		firstSocket.emit("close");
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondConnect = client.connect();
		expect(netMock.sockets).toHaveLength(2);
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;

		client.close();
	});

	it("shares one reconnect attempt across concurrent callers", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		firstSocket.emit("close");

		const reconnectA = client.reconnect();
		const reconnectB = client.reconnect();
		expect(netMock.sockets).toHaveLength(2);
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");

		await expect(Promise.all([reconnectA, reconnectB])).resolves.toEqual([undefined, undefined]);
		client.close();
	});

	it("resends the same command envelope after a recoverable disconnect", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "prompt", activeSessionId: "active-1", message: "hello" });
		const firstWireData = firstSocket.writes[0]!;
		const firstEnvelope = JSON.parse(firstWireData) as { id: string };
		firstSocket.emit("close");

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		expect(secondSocket.writes).toEqual([]);
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				type: "daemon_hello",
				socketPath: "/tmp/prime-agent.sock",
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				clientId: "server-client-2",
				serverCapabilities: ["session_input_admission"],
			})}\n`,
		);
		expect(secondSocket.writes).toEqual([firstWireData]);

		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "prompt", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});

	it("pauses request timeouts while a recoverable connection is disconnected", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const response = client.request({ type: "list" }, 50);
		let settled = false;
		void response.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const firstEnvelope = JSON.parse(firstSocket.writes[0]!) as { id: string };
		firstSocket.emit("close");
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		emitHello(secondSocket);
		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "list", success: true })}\n`,
		);

		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});

	it("rejects a pending admission-gated prompt when the reconnected daemon is downgraded", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent.sock");
		client.enableRequestRecovery();
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(
			firstSocket,
			DAEMON_PROTOCOL_VERSION,
			["session_input_admission", "prompt_admission_cancellation"],
			DAEMON_SCHEMA_REVISION,
		);

		const response = client.request({
			type: "prompt",
			activeSessionId: "active-1",
			message: "hello",
			admissionId: "a-1",
		});
		expect(firstSocket.writes).toHaveLength(1);
		firstSocket.emit("close");

		const secondConnect = client.connect();
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await secondConnect;
		// The replacement daemon no longer supports admission cancellation, so
		// replaying would silently drop admissionId and take ownership.
		emitHello(secondSocket, DAEMON_PROTOCOL_VERSION, ["session_input_admission"], DAEMON_SCHEMA_REVISION);

		await expect(response).rejects.toThrow("does not support prompt_admission_cancellation");
		expect(secondSocket.writes).toEqual([]);
		client.close();
	});

	it("reconnects raw clients and replays pending commands after supervisor replacement", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");
		const firstConnect = client.connect();
		const firstSocket = netMock.sockets[0]!;
		firstSocket.emit("connect");
		await firstConnect;
		emitHello(firstSocket);

		const statuses: string[] = [];
		const recoverDaemon = vi.fn(async () => {});
		client.enableAutoReconnect({
			recoverDaemon,
			onStatus: (status) => statuses.push(status.status),
		});
		const response = client.request({ type: "list" });
		const firstWireData = firstSocket.writes[0]!;
		const firstEnvelope = JSON.parse(firstWireData) as { id: string };

		firstSocket.emit("close");
		await vi.waitFor(() => expect(netMock.sockets).toHaveLength(2));
		const secondSocket = netMock.sockets[1]!;
		secondSocket.emit("connect");
		await Promise.resolve();
		secondSocket.emit(
			"data",
			`${JSON.stringify({
				type: "daemon_hello",
				socketPath: "/tmp/prime-agent.sock",
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				clientId: "server-client-2",
				serverCapabilities: [],
			})}\n`,
		);

		await vi.waitFor(() => expect(statuses).toEqual(["reconnecting", "connected"]));
		expect(recoverDaemon).toHaveBeenCalledOnce();
		expect(secondSocket.writes).toEqual([firstWireData]);

		secondSocket.emit(
			"data",
			`${JSON.stringify({ id: firstEnvelope.id, type: "response", command: "list", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: firstEnvelope.id, success: true });
		client.close();
	});
});

async function captureRejection(promise: Promise<void>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw new Error("Expected daemon client to reject with an Error");
	}
	throw new Error("Expected daemon client connect attempt to reject");
}
