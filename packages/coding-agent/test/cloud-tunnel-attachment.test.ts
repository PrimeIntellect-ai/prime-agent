import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CloudTunnelAttachmentCallbacks,
	CloudTunnelAttachmentTarget,
} from "../src/core/cloud/bridge/tunnel-attachment.js";
import { CloudTunnelAttachment } from "../src/core/cloud/bridge/tunnel-attachment.js";
import {
	type CloudTunnelConnection,
	type CloudTunnelTransport,
	CloudTunnelTransportError,
} from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	type CloudCommandRequest,
	type CloudEvent,
	type CloudMessage,
	cloudRequestDigest,
} from "../src/core/cloud/protocol.js";

/**
 * Fake-transport coverage of the durable attachment supervisor.
 *
 * The bridge end-to-end behavior lives in cloud-guest-bridge.test.ts; this
 * suite pins the local supervisor's own contract: hello authentication and
 * cursor resume, ack strictly after the local flush, idempotent resubmission
 * of unacknowledged commands across reconnects, capped backoff, and clean
 * gateway fallback when the tunnel registration disappears.
 */

const target: CloudTunnelAttachmentTarget = {
	url: "https://tun-1.tunnels.example.com",
	httpUser: "prime-agent",
	httpPassword: "edge-password",
	bridgeToken: "bridge-token-0123456789abcdef",
};

class FakeConnection implements CloudTunnelConnection {
	sent: string[] = [];
	closed = false;
	private messageHandler: ((message: string) => void) | undefined;
	private closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;

	send(message: string): void {
		this.sent.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeHandler?.();
	}

	onMessage(handler: (message: string) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: (error?: CloudTunnelTransportError) => void): void {
		this.closeHandler = handler;
	}

	receive(message: CloudMessage): void {
		this.messageHandler?.(JSON.stringify(message));
	}

	drop(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeHandler?.(new CloudTunnelTransportError("closed", "simulated drop"));
	}
}

class FakeTransport implements CloudTunnelTransport {
	connections: FakeConnection[] = [];
	seenHeaders: Array<Record<string, string>> = [];
	failuresBeforeSuccess = 0;

	async connect(url: string, headers: Record<string, string>): Promise<CloudTunnelConnection> {
		if (this.failuresBeforeSuccess > 0) {
			this.failuresBeforeSuccess--;
			throw new Error("simulated connect failure");
		}
		this.seenHeaders.push(headers);
		expect(url).toBe(target.url);
		const connection = new FakeConnection();
		this.connections.push(connection);
		return connection;
	}
}

function makeCallbacks(overrides: Partial<CloudTunnelAttachmentCallbacks> = {}): CloudTunnelAttachmentCallbacks {
	return {
		resolveTarget: () => target,
		appendGuestEvent: vi.fn(),
		flushTrace: vi.fn(async () => {}),
		persistGuestCursor: vi.fn(),
		loadGuestCursor: () => undefined,
		recordAttachment: vi.fn(),
		isSessionLive: () => true,
		checkTunnelAlive: vi.fn(async () => true),
		onAttachmentError: vi.fn(),
		onTerminal: vi.fn(),
		...overrides,
	};
}

function makeAttachment(
	transport: CloudTunnelTransport,
	callbacks: CloudTunnelAttachmentCallbacks,
	options: { reconnectDelayMs?: number; maxConsecutiveFailures?: number; handshakeTimeoutMs?: number } = {},
): CloudTunnelAttachment {
	return new CloudTunnelAttachment({
		sessionId: "sess_att_1",
		generation: 1,
		transport,
		callbacks,
		reconnectDelayMs: options.reconnectDelayMs ?? 5,
		maxReconnectDelayMs: 20,
		checkTunnelAfterFailures: 2,
		submitWaitMs: 500,
		handshakeTimeoutMs: options.handshakeTimeoutMs ?? 60_000,
		...(options.maxConsecutiveFailures !== undefined
			? { maxConsecutiveFailures: options.maxConsecutiveFailures }
			: {}),
		sleepFn: async () => {},
	});
}

function snapshotWith(events: readonly CloudEvent[]): CloudMessage {
	return {
		type: "snapshot",
		sessionId: "sess_att_1",
		generation: 1,
		cursor: { generation: 1, sequence: events.length },
		status: "busy",
		state: { cwd: "/w", modelId: "image-default", queuedCommandIds: [] },
		events,
	};
}

const statusEvent: CloudEvent = {
	sequence: 1,
	kind: "session_status",
	recordedAt: "2026-01-01T00:00:00.000Z",
	status: "busy",
};
const outputEvent: CloudEvent = {
	sequence: 2,
	kind: "output_delta",
	recordedAt: "2026-01-01T00:00:00.010Z",
	taskId: "task_initial",
	stream: "stdout",
	text: "hello\n",
};

describe("CloudTunnelAttachment", () => {
	// Fake clocks: every reconnect backoff and submit deadline is advanced
	// deterministically instead of waited out.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps a healthy connection past the handshake deadline once the snapshot arrived", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks({ onAttached: vi.fn() });
		const attachment = makeAttachment(transport, callbacks, { handshakeTimeoutMs: 100 });
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		const connection = transport.connections[0] as FakeConnection;
		expect(connection.sent.length).toBe(1);
		// The snapshot answers the hello: the handshake is satisfied and the
		// attachment is live - idle guests never push a session_meta frame.
		connection.receive(snapshotWith([statusEvent]));
		await vi.advanceTimersByTimeAsync(1);
		expect(attachment.attached).toBe(true);
		expect(callbacks.onAttached).toHaveBeenCalledTimes(1);
		// The deadline would have fired here and killed the healthy connection.
		await vi.advanceTimersByTimeAsync(200);
		expect(connection.closed).toBe(false);
		expect(callbacks.onAttachmentError).not.toHaveBeenCalled();
		await attachment.stop();
	});

	it("closes and retries when the bridge accepts the upgrade but never answers hello", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks();
		const attachment = makeAttachment(transport, callbacks, { handshakeTimeoutMs: 100 });
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const silent = transport.connections[0] as FakeConnection;
		expect(silent.sent.length).toBe(1);
		expect(silent.closed).toBe(false);
		// The deadline fires: the silent connection is closed, the failure is
		// surfaced, and the loop reconnects instead of parking forever.
		await vi.advanceTimersByTimeAsync(100);
		expect(silent.closed).toBe(true);
		expect(callbacks.onAttachmentError).toHaveBeenCalledWith(
			expect.stringContaining("never answered hello within 100ms"),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(transport.connections.length).toBe(2);
		await attachment.stop();
	});

	it("authenticates, subscribes, mirrors events, and acks strictly after the local flush", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks();
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const connection = transport.connections[0] as FakeConnection;
		// The hello carries the bridge token and the durable resume cursor.
		expect(connection.sent.length).toBe(1);
		const hello = JSON.parse(connection.sent[0] as string) as { type: string; authToken?: string };
		expect(hello.type).toBe("hello");
		expect(hello.authToken).toBe(target.bridgeToken);
		// Edge basic auth rides the upgrade headers.
		expect(transport.seenHeaders[0]?.Authorization).toBe(
			`Basic ${Buffer.from(`${target.httpUser}:${target.httpPassword}`).toString("base64")}`,
		);

		connection.receive(snapshotWith([statusEvent, outputEvent]));
		await vi.advanceTimersByTimeAsync(1);
		expect(callbacks.appendGuestEvent).toHaveBeenCalledTimes(2);
		expect(callbacks.persistGuestCursor).toHaveBeenCalledWith({
			sandboxGeneration: 1,
			eventGeneration: 1,
			sequence: 2,
		});
		expect(callbacks.flushTrace).toHaveBeenCalledTimes(1);
		// Ack lands only after the flush resolved, then the subscription starts.
		expect(connection.sent.length).toBe(3);
		const ack = JSON.parse(connection.sent[1] as string) as { type: string; cursor?: { sequence: number } };
		const subscribe = JSON.parse(connection.sent[2] as string) as { type: string; cursor?: { sequence: number } };
		expect(ack.type).toBe("ack");
		expect(ack.cursor?.sequence).toBe(2);
		expect(subscribe.type).toBe("subscribe");
		// The subscription starts at the durable resume point, not at the
		// snapshot tail: a bounded snapshot may drop older events, and the
		// replay plus sequence deduplication keeps mirroring complete.
		expect(subscribe.cursor?.sequence).toBe(0);
		expect(attachment.attached).toBe(true);
		await attachment.stop();
	});

	it("deduplicates replayed events and never acks past what it appended", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks({
			loadGuestCursor: () => ({ sandboxGeneration: 1, eventGeneration: 1, sequence: 2 }),
		});
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const connection = transport.connections[0] as FakeConnection;
		connection.receive(snapshotWith([statusEvent, outputEvent]));
		connection.receive({
			type: "events",
			sessionId: "sess_att_1",
			generation: 1,
			events: [statusEvent, outputEvent],
		});
		await vi.advanceTimersByTimeAsync(1);
		// Everything at or below the resume cursor is a no-op.
		expect(callbacks.appendGuestEvent).not.toHaveBeenCalled();
		expect(callbacks.flushTrace).not.toHaveBeenCalled();
		expect(connection.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === "ack")).toHaveLength(0);
		// New events only.
		const next: CloudEvent = {
			sequence: 3,
			kind: "session_status",
			recordedAt: "2026-01-01T00:00:00.020Z",
			status: "idle",
		};
		connection.receive({ type: "events", sessionId: "sess_att_1", generation: 1, events: [next] });
		await vi.advanceTimersByTimeAsync(1);
		expect(callbacks.appendGuestEvent).toHaveBeenCalledTimes(1);
		expect(
			connection.sent.some(
				(raw) => (JSON.parse(raw) as { type: string; cursor?: { sequence: number } }).type === "ack",
			),
		).toBe(true);
		const ack = JSON.parse(
			connection.sent.find((raw) => (JSON.parse(raw) as { type: string }).type === "ack") as string,
		) as { cursor: { sequence: number } };
		expect(ack.cursor.sequence).toBe(3);
		await attachment.stop();
	});

	it("resubmits unacknowledged commands with the same identity after a drop", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks();
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const first = transport.connections[0] as FakeConnection;
		first.receive(snapshotWith([statusEvent]));
		await vi.advanceTimersByTimeAsync(1);
		expect(attachment.attached).toBe(true);

		const steerRequest: CloudCommandRequest = { kind: "steer", text: "go" };
		const receiptPromise = attachment.submit("cmd_s", steerRequest);
		await vi.advanceTimersByTimeAsync(1);
		expect(first.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "submit")).toBe(true);
		// The receipt never arrives; the connection drops instead.
		first.drop();
		// The reconnect backoff is capped at maxReconnectDelayMs with jitter;
		// advancing past it deterministically produces the second connection.
		await vi.advanceTimersByTimeAsync(25);
		expect(transport.connections.length).toBe(2);
		const second = transport.connections[1] as FakeConnection;
		// The new connection resubmits the same identity once its snapshot
		// confirms authentication; the guest journal deduplicates.
		expect(second.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "hello")).toBe(true);
		second.receive(snapshotWith([]));
		await vi.advanceTimersByTimeAsync(1);
		expect(second.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "submit")).toBe(true);
		const resubmitted = JSON.parse(
			second.sent.find((raw) => (JSON.parse(raw) as { type: string }).type === "submit") as string,
		) as { commandId: string; request: unknown; digest: string };
		expect(resubmitted.commandId).toBe("cmd_s");
		expect(resubmitted.digest).toBe(cloudRequestDigest(steerRequest));
		second.receive({
			type: "command",
			sessionId: "sess_att_1",
			generation: 1,
			receipt: {
				commandId: "cmd_s",
				digest: cloudRequestDigest(steerRequest),
				state: "accepted",
				submittedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				uncertain: false,
			},
		});
		const outcome = await receiptPromise;
		expect(outcome).toMatchObject({ state: "acknowledged" });
		expect(attachment.pendingCount).toBe(0);
		await attachment.stop();
	});

	it("reports queued when no receipt arrives in time, and rejects identity reuse with a different body", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks();
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const first = transport.connections[0] as FakeConnection;
		first.receive(snapshotWith([statusEvent]));
		await vi.advanceTimersByTimeAsync(1);
		expect(attachment.attached).toBe(true);
		// A dead bridge: submits are queued, never answered. The queued
		// outcome comes from the submit deadline timer, advanced deterministically.
		first.drop();
		const queuedOutcome = attachment.submit("cmd_q", { kind: "steer", text: "queued" } as CloudCommandRequest);
		await vi.advanceTimersByTimeAsync(501);
		await expect(queuedOutcome).resolves.toMatchObject({ state: "queued" });
		await expect(
			attachment.submit("cmd_q", { kind: "steer", text: "different body" } as CloudCommandRequest),
		).rejects.toThrow(/different request/);
		await attachment.stop();
	});

	it("rejects protocol-invalid commands instead of queueing them for replay", async () => {
		const transport = new FakeTransport();
		const callbacks = makeCallbacks();
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		const first = transport.connections[0] as FakeConnection;
		first.receive(snapshotWith([statusEvent]));
		await vi.advanceTimersByTimeAsync(1);
		expect(attachment.attached).toBe(true);
		// The guest would treat this as a protocol violation and close the
		// connection; queuing it would wedge the supervisor in a replay loop.
		await expect(attachment.submit("cmd_bad", { kind: "steer", text: "x".repeat(65_537) })).rejects.toThrow(
			/invalid tunnel command: request.text/,
		);
		expect(first.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "submit")).toBe(false);
		expect(attachment.pendingCount).toBe(0);
		await attachment.stop();
	});

	it("falls back cleanly when the tunnel registration disappears", async () => {
		const transport = new FakeTransport();
		transport.failuresBeforeSuccess = 10;
		const onTerminal = vi.fn();
		const callbacks = makeCallbacks({ checkTunnelAlive: vi.fn(async () => false), onTerminal });
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		// The reconnect loop only advances on fake-clock ticks; the bounded
		// walk fails the transport twice per liveness probe until the probe
		// reports the registration gone.
		for (let tick = 0; tick < 20 && onTerminal.mock.calls.length === 0; tick++) {
			await vi.advanceTimersByTimeAsync(50);
		}
		expect(onTerminal).toHaveBeenCalled();
		expect(onTerminal).toHaveBeenCalledWith(expect.stringContaining("registration is gone"));
		expect(attachment.pendingCount).toBe(0);
		await attachment.stop();
	});

	it("gives up reconnecting honestly when the guest bridge stays unreachable", async () => {
		const transport = new FakeTransport();
		transport.failuresBeforeSuccess = Number.POSITIVE_INFINITY;
		const onTerminal = vi.fn();
		const callbacks = makeCallbacks({
			checkTunnelAlive: vi.fn(async () => true),
			onTerminal,
		});
		const attachment = makeAttachment(transport, callbacks, { maxConsecutiveFailures: 5 });
		attachment.start();
		for (let tick = 0; tick < 40 && onTerminal.mock.calls.length === 0; tick++) {
			await vi.advanceTimersByTimeAsync(50);
		}
		expect(onTerminal).toHaveBeenCalledWith(expect.stringContaining("could not be re-established after 5 attempts"));
		expect(attachment.attached).toBe(false);
		await attachment.stop();
	});

	it("stops itself when the session stops being steerable", async () => {
		const transport = new FakeTransport();
		let live = true;
		const callbacks = makeCallbacks({
			resolveTarget: () => (live ? target : undefined),
		});
		const attachment = makeAttachment(transport, callbacks);
		attachment.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.connections.length).toBe(1);
		live = false;
		(transport.connections[0] as FakeConnection).drop();
		// With no live session and no target the loop exits without onTerminal spam.
		await attachment.stop();
		await vi.advanceTimersByTimeAsync(30);
		expect(transport.connections.length).toBe(1);
	});
});
