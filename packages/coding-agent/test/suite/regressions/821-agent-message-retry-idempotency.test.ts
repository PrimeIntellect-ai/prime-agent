import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CommandRecoveryJournal,
	createCommandIdempotencyKey,
} from "../../../src/modes/daemon/command-recovery-journal.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonCommandEnvelope,
	type DaemonResponse,
} from "../../../src/modes/daemon/daemon-protocol.js";

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

vi.mock("node:net", () => ({ createConnection: netMock.createConnection }));

function emitHello(socket: (typeof netMock.sockets)[number]): void {
	socket.emit(
		"data",
		`${JSON.stringify({
			type: "daemon_hello",
			socketPath: "/tmp/prime-agent.sock",
			protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
			appVersion: "9.9.9",
			clientId: "supervisor-assigned",
			serverCapabilities: [],
		})}\n`,
	);
}

function writtenEnvelopes(socket: (typeof netMock.sockets)[number]): DaemonCommandEnvelope[] {
	return socket.writes
		.flatMap((chunk) => chunk.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DaemonCommandEnvelope)
		.filter((value) => value.type === "command");
}

/**
 * A worker retrying `send_message` built a new DaemonClient per attempt. Both halves
 * of the supervisor's journal key are per-instance — `protocolClientId` is a fresh
 * uuid and the request counter restarts at 0 — so every retry presented a different
 * key for the same logical message. The journal could not recognize the duplicate and
 * the target received N independent steering prompts under N distinct ids.
 */
describe("issue #821 agent-message retry idempotency", () => {
	const journalDirs: string[] = [];

	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
	});

	afterEach(() => {
		while (journalDirs.length > 0) {
			rmSync(journalDirs.pop()!, { recursive: true, force: true });
		}
	});

	async function sendOnFreshClient(clientId?: string, commandId?: string): Promise<DaemonCommandEnvelope> {
		const client = clientId ? new DaemonClient("/tmp/pa.sock", { clientId }) : new DaemonClient("/tmp/pa.sock");
		const connect = client.connect();
		const socket = netMock.sockets.at(-1)!;
		socket.emit("connect");
		await connect;
		emitHello(socket);
		await client.waitForHello();
		// The transport fails after the command is on the wire, which is exactly the
		// window in which the supervisor may already have accepted and enqueued it.
		void client
			.request({ type: "send_message", targetActiveSessionId: "worker", message: "result ready" }, 50, {
				...(commandId ? { commandId } : {}),
			})
			.catch(() => undefined);
		await vi.waitFor(() => expect(writtenEnvelopes(socket)).toHaveLength(1));
		client.close();
		return writtenEnvelopes(socket)[0]!;
	}

	it("presents one journal key across retries when the identity is pinned", async () => {
		const clientId = "daemon-client:pinned";
		const commandId = "send_message_pinned";

		const first = await sendOnFreshClient(clientId, commandId);
		const second = await sendOnFreshClient(clientId, commandId);

		expect(first.clientId).toBe(clientId);
		expect(first.id).toBe(commandId);
		expect(second.clientId).toBe(clientId);
		expect(second.id).toBe(commandId);
		expect(createCommandIdempotencyKey(second.clientId!, second.id)).toBe(
			createCommandIdempotencyKey(first.clientId!, first.id),
		);
	});

	it("still mints a distinct identity per client when nothing is pinned", async () => {
		const first = await sendOnFreshClient();
		const second = await sendOnFreshClient();

		expect(first.clientId).not.toBe(second.clientId);
		expect(createCommandIdempotencyKey(second.clientId!, second.id)).not.toBe(
			createCommandIdempotencyKey(first.clientId!, first.id),
		);
	});

	it("replays the recorded receipt instead of enqueuing the message twice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-821-journal-"));
		journalDirs.push(dir);
		const journal = new CommandRecoveryJournal(join(dir, "commands.jsonl"));
		const receipt: DaemonResponse = {
			id: "send_message_pinned",
			type: "response",
			command: "send_message",
			success: true,
			data: { id: "agentmsg_1", deliveryStatus: "queued" },
		};

		const pinned = await sendOnFreshClient("daemon-client:pinned", "send_message_pinned");
		const retry = await sendOnFreshClient("daemon-client:pinned", "send_message_pinned");

		expect(journal.begin(pinned.clientId!, pinned.id, "send_message")).toEqual({ status: "new" });
		journal.recordResult(pinned.clientId!, pinned.id, receipt);

		// The retry is recognized as the same command, so the supervisor replays the
		// original receipt rather than accepting a second agent message.
		expect(journal.begin(retry.clientId!, retry.id, "send_message")).toEqual({
			status: "complete",
			response: receipt,
		});

		// Without pinning, the retry would have been admitted as a new command.
		const unpinned = await sendOnFreshClient();
		expect(journal.begin(unpinned.clientId!, unpinned.id, "send_message")).toEqual({ status: "new" });
	});

	it("rejects reusing a command id that is still in flight on one client", async () => {
		const client = new DaemonClient("/tmp/pa.sock", { clientId: "daemon-client:pinned" });
		const connect = client.connect();
		const socket = netMock.sockets.at(-1)!;
		socket.emit("connect");
		await connect;
		emitHello(socket);
		await client.waitForHello();

		const inFlight = client
			.request({ type: "send_message", targetActiveSessionId: "worker", message: "first" }, 5_000, {
				commandId: "send_message_pinned",
			})
			.catch(() => undefined);

		await expect(
			client.request({ type: "send_message", targetActiveSessionId: "worker", message: "second" }, 5_000, {
				commandId: "send_message_pinned",
			}),
		).rejects.toThrow('Daemon command id "send_message_pinned" is already in flight on this client');

		client.close();
		await inFlight;
	});
});
