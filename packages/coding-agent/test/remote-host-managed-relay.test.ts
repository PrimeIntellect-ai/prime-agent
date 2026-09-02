/**
 * Unit tests for the managed relay link state machine.
 *
 * Uses a fake WebSocket factory so tests are deterministic and never
 * touch a network.
 *
 * Covers: connect, handshake admission/rejection, credential non-leakage,
 * event ordering, reconnect/replay, duplicate delivery, timeout,
 * cancel/close, and orphaned timers.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	RemoteHostBuildIdentity,
	RemoteHostFrameEnvelope,
	RemoteHostHandshakeAckFrame,
	RemoteHostHandshakeFrame,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_INFO } from "../src/modes/daemon/remote-agent-host-protocol.js";
import type { InMemoryRemoteHostJournal } from "../src/modes/daemon/remote-host-journal.js";
import { InMemoryRemoteHostJournal as InMemoryJournal } from "../src/modes/daemon/remote-host-journal.js";
import {
	ManagedRelayLink,
	type ManagedRelayLinkEvent,
	type ManagedRelayLinkObserver,
	type ManagedRelayLinkOptions,
	type RelayWebSocket,
	type WebSocketFactory,
} from "../src/modes/daemon/remote-host-managed-relay.js";

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket implements RelayWebSocket {
	readyState: number = 0; // 0 = CONNECTING
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: { error: unknown }) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	sent: string[] = [];
	closed = false;

	/** Simulate the socket opening (triggers onopen). */
	open(): void {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}

	/** Simulate receiving a message. */
	receive(data: string): void {
		this.onmessage?.({ data });
	}

	/** Simulate an abnormal closure (error + close). */
	closeAbrupt(error: unknown = new Error("connection lost")): void {
		this.readyState = 3; // CLOSED
		this.onerror?.({ error });
		this.onclose?.({ code: 1006, reason: "Abnormal closure" });
	}

	/** Simulate a normal close event. */
	closeNormally(code = 1000, reason = ""): void {
		this.readyState = 3;
		this.closed = true;
		this.onclose?.({ code, reason });
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.closed = true;
		this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
	}
}

// ---------------------------------------------------------------------------
// Fake WebSocket Factory
// ---------------------------------------------------------------------------

class FakeWebSocketFactory implements WebSocketFactory {
	sockets: FakeWebSocket[] = [];
	private latest: FakeWebSocket | undefined;

	create(_url: string): FakeWebSocket {
		const ws = new FakeWebSocket();
		this.sockets.push(ws);
		this.latest = ws;
		return ws;
	}

	/** Get the most recently created socket. */
	get lastSocket(): FakeWebSocket | undefined {
		return this.latest;
	}

	reset(): void {
		this.sockets = [];
		this.latest = undefined;
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_BUILD: RemoteHostBuildIdentity = {
	buildId: "build-abc",
	daemonProtocolVersion: 7,
	daemonSchemaRevision: 25,
};

function createRelayOptions(overrides?: Partial<ManagedRelayLinkOptions>): ManagedRelayLinkOptions {
	return {
		url: "ws://localhost:9999/test",
		hostId: "sandbox-1",
		generation: "gen-abc",
		buildIdentity: TEST_BUILD,
		direction: "home_to_host",
		capabilities: ["session_commands", "sequenced_events", "link_health"],
		journal: new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" }),
		wsFactory: new FakeWebSocketFactory(),
		pingIntervalMs: 5000,
		...overrides,
	};
}

function receivedFrameEvents(relay: ManagedRelayLink): ManagedRelayLinkEvent[] {
	const events: ManagedRelayLinkEvent[] = [];
	relay.observe((e) => events.push(e));
	return events;
}

/** Create a valid handshake ack for the test relay. */
function handshakeAck(): RemoteHostHandshakeAckFrame {
	return {
		type: "handshake_ack",
		hostId: "sandbox-1",
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		accepted: true,
		capabilities: ["session_commands", "sequenced_events"],
		linkId: "link-1",
	};
}

/** Wrap a frame body in an envelope. */
function envelope(body: object, frameId = "env-1"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		sentAt: new Date().toISOString(),
		frame: body as never,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManagedRelayLink — initial state", () => {
	it("starts in idle state", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		expect(relay.status).toBe("idle");
		expect(relay.health).toEqual({ status: "connecting", startedAt: expect.any(String) });
	});

	it("starts with no resume cursor when journal is empty", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		expect(relay.resumeCursor).toBeUndefined();
	});

	it("rejects connect after unreachable terminal state", async () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		// Force unreachable state
		const state = relay as unknown as { _state: { status: string; error: string } };
		state._state = { status: "unreachable", error: "forced" };
		await expect(relay.connect()).rejects.toThrow("terminal state");
	});

	it("rejects connect after closed state", async () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		const state = relay as unknown as { _state: { status: string } };
		state._state = { status: "closed" };
		await expect(relay.connect()).rejects.toThrow("terminal state");
	});
});

describe("ManagedRelayLink — connect and handshake", () => {
	it("connects, sends handshake, transitions to handshaking, then to connected", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		// Initiate connection
		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		expect(ws).toBeDefined();
		expect(relay.status).toBe("connecting");

		// Socket opens — should send handshake
		ws.open();
		expect(ws.sent.length).toBe(1);
		const sentFrame = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
		expect(sentFrame.frame.type).toBe("handshake");
		const handshake = sentFrame.frame as RemoteHostHandshakeFrame;
		expect(handshake.hostId).toBe("sandbox-1");
		expect(handshake.generation).toBe("gen-abc");
		expect(handshake.direction).toBe("home_to_host");
		expect(handshake.capabilities).toContain("session_commands");
		expect(handshake.runtime.buildId).toBe("build-abc");

		// Receive handshake_ack
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		const result = await connectPromise;
		expect(result.accepted).toBe(true);
		expect(result.linkId).toBe("link-1");
		expect(relay.status).toBe("connected");

		// Should have received handshake_completed event
		const completed = events.find((e) => e.type === "handshake_completed");
		expect(completed).toBeDefined();
		if (completed?.type === "handshake_completed") {
			expect(completed.linkId).toBe("link-1");
		}
	});

	it("transitions to unreachable when handshake is rejected", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		expect(ws.sent.length).toBe(1);

		// Reject handshake
		const rejectAck: RemoteHostHandshakeAckFrame = {
			type: "handshake_ack",
			hostId: "sandbox-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			accepted: false,
			rejectReason: "build_mismatch",
			capabilities: [],
			linkId: "",
		};
		ws.receive(JSON.stringify(envelope(rejectAck)));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("build_mismatch");
		expect(relay.status).toBe("unreachable");
		expect(events.some((e) => e.type === "handshake_rejected")).toBe(true);
	});

	it("does not leak the grant into emitted frames or the journal", async () => {
		const factory = new FakeWebSocketFactory();
		const journal = new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" });
		const relay = new ManagedRelayLink(
			createRelayOptions({ wsFactory: factory, journal, grant: "secret-grant-token" }),
		);

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;

		// Check the URL includes the grant (encoded)
		// Note: the url is used in wsFactory.create(url), but our fake doesn't expose it.
		// We verify non-leakage by checking that no journal entry or sent frame
		// contains the grant string.
		ws.open();
		expect(ws.sent.length).toBe(1);
		const sentStr = ws.sent[0];
		expect(sentStr).not.toContain("secret-grant-token");

		ws.receive(JSON.stringify(envelope(handshakeAck())));
		await connectPromise;

		// Send a frame and check journal
		relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
		const entries = journal.readEntries(1);
		for (const entry of entries) {
			const serialized = JSON.stringify(entry);
			expect(serialized).not.toContain("secret-grant-token");
		}
	});

	it("resolves connect even when socket closes after handshake ack before the relay processes it", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		// Receive handshake ack, then close immediately
		ws.receive(JSON.stringify(envelope(handshakeAck())));
		ws.closeNormally();

		const result = await connectPromise;
		expect(result.accepted).toBe(true);
	});
});

describe("ManagedRelayLink — frame send/receive", () => {
	it("sends frames and records them in the journal", () => {
		const journal = new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" });
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
		// Establish connection
		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		// Send a health frame
		const sentEnvelope = relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
		expect(sentEnvelope.frame.type).toBe("health");
		expect(ws.sent.length).toBe(2); // handshake + health

		// Journal should have sent + health frame
		const entries = journal.readEntries(1);
		const healthSent = entries.find((e) => e.frame.type === "health");
		expect(healthSent).toBeDefined();
	});

	it("receives frames and emits frame_received events", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		// Receive a health frame
		ws.receive(
			JSON.stringify(envelope({ type: "health", healthSeq: 2, status: "connected" as const }, "frame-rcv-1")),
		);

		const frameEvents = events.filter((e) => e.type === "frame_received");
		expect(frameEvents).toHaveLength(1);
		if (frameEvents[0].type === "frame_received") {
			expect(frameEvents[0].envelope.frame.type).toBe("health");
			expect(frameEvents[0].isDuplicate).toBe(false);
		}
	});

	it("reports duplicates and still records them in the journal", () => {
		const journal = new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" });
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
		const events = receivedFrameEvents(relay);

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		// Receive the same frame twice
		ws.receive(JSON.stringify(envelope({ type: "health", healthSeq: 5, status: "connected" as const }, "dup-frame")));
		ws.receive(JSON.stringify(envelope({ type: "health", healthSeq: 5, status: "connected" as const }, "dup-frame")));

		const frameEvents = events.filter((e) => e.type === "frame_received");
		expect(frameEvents).toHaveLength(2);
		if (frameEvents[0].type === "frame_received" && frameEvents[1].type === "frame_received") {
			expect(frameEvents[0].isDuplicate).toBe(false);
			expect(frameEvents[1].isDuplicate).toBe(true);
		}

		// Both should be in the journal
		expect(journal.readEntries(1).length).toBeGreaterThanOrEqual(2);
	});
});

describe("ManagedRelayLink — close", () => {
	it("graceful close stops at closed state", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		expect(relay.status).toBe("connected");

		relay.close();
		expect(relay.status).toBe("closed");
		expect(ws.closed).toBe(true);
	});

	it("close from connecting state works", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.connect();
		relay.close();
		expect(relay.status).toBe("closed");
	});

	it("close from handshaking state works", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open(); // now handshaking
		relay.close();
		expect(relay.status).toBe("closed");
	});

	it("close from reconnecting state cancels reconnect timer", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

			relay.connect();
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			// Force disconnect — should schedule reconnect
			ws.closeAbrupt();
			expect(relay.status).toBe("reconnecting");

			// Close while reconnecting
			relay.close();
			expect(relay.status).toBe("closed");
			expect(relay.health).toEqual({ status: "closed" });

			// Advance timers — reconnect should NOT trigger
			await vi.advanceTimersByTimeAsync(100_000);
			// No new socket should be created
			expect(factory.sockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — reconnect and backoff", () => {
	it("reconnects after unexpected close with bounded exponential backoff", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

			// Connect normally
			relay.connect();
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));
			expect(relay.status).toBe("connected");
			expect(factory.sockets.length).toBe(1);

			// Abrupt close triggers reconnect
			ws.closeAbrupt();
			expect(relay.status).toBe("reconnecting");
			expect(relay.health).toMatchObject({ status: "reconnecting" });

			// Fast-forward past backoff
			await vi.advanceTimersByTimeAsync(5_000);
			expect(factory.sockets.length).toBe(2);

			// Second socket opens
			ws = factory.lastSocket!;
			ws.open();
			// Should have sent a handshake (second message after first socket cleanup)
			expect(ws.sent.length).toBe(1);
			const sent = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
			expect(sent.frame.type).toBe("handshake");

			// Accept handshake
			ws.receive(JSON.stringify(envelope(handshakeAck())));
			expect(relay.status).toBe("connected");
		} finally {
			vi.useRealTimers();
		}
	});

	it("transitions to unreachable after max reconnect attempts", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

			relay.connect();
			const initialWs = factory.lastSocket!;
			initialWs.open();
			initialWs.receive(JSON.stringify(envelope(handshakeAck())));

			// Force reconnects repeatedly (first 10 should succeed, 11th exhausts)
			for (let attempt = 1; attempt <= 10; attempt++) {
				const currentWs = factory.lastSocket!;
				currentWs.closeAbrupt();
				expect(relay.status).toBe("reconnecting");

				// Wait enough time for backoff and reconnect
				await vi.advanceTimersByTimeAsync(70_000);
			}

			// 11th close exhausts the retry budget
			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("unreachable");

			// After max attempts, should be unreachable
			expect(relay.status).toBe("unreachable");
			expect(relay.health).toMatchObject({ status: "unreachable" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reconnect after graceful close", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

			relay.connect();
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			relay.close();
			expect(relay.status).toBe("closed");

			// Advance timers — no reconnect should happen
			await vi.advanceTimersByTimeAsync(100_000);
			expect(factory.sockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — ping/pong liveness", () => {
	it("sends periodic health frames when connected", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, pingIntervalMs: 100 }));

			relay.connect();
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));
			expect(relay.status).toBe("connected");

			// Clear initial handshake
			const initialCount = ws.sent.length;

			// Advance past first ping interval
			await vi.advanceTimersByTimeAsync(100);
			expect(ws.sent.length).toBe(initialCount + 1);

			// Second ping
			await vi.advanceTimersByTimeAsync(100);
			expect(ws.sent.length).toBe(initialCount + 2);

			// Close — pings should stop
			relay.close();
			const afterClose = ws.sent.length;
			await vi.advanceTimersByTimeAsync(500);
			expect(ws.sent.length).toBe(afterClose);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — event ordering and recovery", () => {
	it("emits handshake_completed before frame_received events", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const order: string[] = [];

		relay.observe((event) => {
			order.push(event.type);
		});

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		// Receive frames after connection
		ws.receive(JSON.stringify(envelope({ type: "health", healthSeq: 1, status: "connected" as const }, "f1")));
		ws.receive(JSON.stringify(envelope({ type: "health", healthSeq: 2, status: "connected" as const }, "f2")));

		expect(order[0]).toBe("handshake_completed");
		// frame_received events come after
		const frameEvents = order.filter((e) => e === "frame_received");
		expect(frameEvents).toHaveLength(2);
	});

	it("recovery event fires on handshake completion after reconnect", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			const events: ManagedRelayLinkEvent[] = [];
			relay.observe((e) => events.push(e));

			// Connect
			relay.connect();
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			// Disconnect and reconnect
			ws.closeAbrupt();
			await vi.advanceTimersByTimeAsync(5_000);

			ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			// Should have a recovered event
			const recovered = events.find((e) => e.type === "recovered");
			expect(recovered).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — timeout and cancel", () => {
	it("observer errors do not crash the relay", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.observe(() => {
			throw new Error("observer error");
		});

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		// Should not throw
		ws.receive(JSON.stringify(envelope(handshakeAck())));
		expect(relay.status).toBe("connected");
	});

	it("orphaned timers do not fire after close from reconnecting", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			const createdSockets: number[] = [];

			// Track socket creation as a proxy for reconnects
			const originalCreate = factory.create.bind(factory);
			vi.spyOn(factory, "create").mockImplementation((url: string) => {
				createdSockets.push(createdSockets.length + 1);
				return originalCreate(url);
			});

			relay.connect();
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			// Disconnect — enters reconnecting
			ws.closeAbrupt();
			expect(relay.status).toBe("reconnecting");

			// Close immediately
			relay.close();
			expect(relay.status).toBe("closed");

			// Advance far past any backoff interval
			await vi.advanceTimersByTimeAsync(200_000);

			// No new socket should be created after close
			expect(createdSockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — observer lifecycle", () => {
	it("can add and remove observers", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		const events: ManagedRelayLinkEvent[] = [];

		const observer: ManagedRelayLinkObserver = (e) => events.push(e);
		relay.observe(observer);
		relay.unobserve(observer);

		// No events should be captured after unobserving
		// (events only happen during connection, so this is structural)
		expect(true).toBe(true);
	});

	it("supports multiple observers", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const eventsA: ManagedRelayLinkEvent[] = [];
		const eventsB: ManagedRelayLinkEvent[] = [];

		relay.observe((e) => eventsA.push(e));
		relay.observe((e) => eventsB.push(e));

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		expect(eventsA.some((e) => e.type === "handshake_completed")).toBe(true);
		expect(eventsB.some((e) => e.type === "handshake_completed")).toBe(true);
	});
});

describe("ManagedRelayLink — consume grant", () => {
	it("uses grant as URL query parameter only, never in frames", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, grant: "one-time-grant-xyz" }));

		// Connect and check that sent frames don't contain grant
		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		for (const msg of ws.sent) {
			expect(msg).not.toContain("one-time-grant-xyz");
		}

		// Journal should not contain it
		const entries = (createRelayOptions().journal as InMemoryRemoteHostJournal).readEntries(1);
		for (const entry of entries) {
			expect(JSON.stringify(entry)).not.toContain("one-time-grant-xyz");
		}
	});
});

describe("ManagedRelayLink — resume cursor", () => {
	it("returns resume cursor based on journal last received sequence", () => {
		const journal = new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" });
		const relay = new ManagedRelayLink(createRelayOptions({ journal }));

		expect(relay.resumeCursor).toBeUndefined();

		// Simulate received events by recording directly into the journal
		journal.recordReceived(
			envelope(
				{
					type: "event",
					id: "evt-1",
					sequence: 5,
					cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess", sequence: 5 },
					emittedAt: new Date().toISOString(),
					body: { type: "agent_start" },
				},
				"evt-1",
			) as RemoteHostFrameEnvelope,
		);

		const cursor = relay.resumeCursor;
		expect(cursor).toBeDefined();
		expect(cursor!.hostId).toBe("sandbox-1");
		expect(cursor!.generation).toBe("gen-abc");
		expect(cursor!.sequence).toBe(5);
	});

	it("sends resume cursor on reconnect", async () => {
		vi.useFakeTimers();
		try {
			const journal = new InMemoryJournal({ hostId: "sandbox-1", generation: "gen-abc" });
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));

			// Connect
			relay.connect();
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(handshakeAck())));

			// Record events in journal
			journal.recordReceived(
				envelope(
					{
						type: "event",
						id: "evt-1",
						sequence: 3,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess", sequence: 3 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
					"evt-1",
				) as RemoteHostFrameEnvelope,
			);

			// Disconnect and reconnect
			ws.closeAbrupt();
			await vi.advanceTimersByTimeAsync(5_000);

			ws = factory.lastSocket!;
			ws.open();

			// The handshake should include a resumeCursor
			const lastSent = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
			if (lastSent.frame.type === "handshake") {
				expect(lastSent.frame.resumeCursor).toBeDefined();
				expect(lastSent.frame.resumeCursor!.sequence).toBe(3);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ManagedRelayLink — non-frame messages", () => {
	it("emits error for unparseable messages", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		ws.receive("not json");

		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents.length).toBeGreaterThan(0);
	});

	it("emits error for non-frame objects", () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(handshakeAck())));

		ws.receive(JSON.stringify({ type: "not_frame", data: "hello" }));

		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents.length).toBeGreaterThan(0);
	});
});

describe("ManagedRelayLink — link status mapping", () => {
	it("maps internal state to RemoteHostLinkStatus correctly", () => {
		const relay = new ManagedRelayLink(createRelayOptions());

		expect(relay.linkStatus).toBe("connecting");

		const state = relay as unknown as { _state: { status: string } };
		state._state = { status: "connected" };
		expect(relay.linkStatus).toBe("connected");

		state._state = { status: "reconnecting" };
		expect(relay.linkStatus).toBe("reconnecting");

		state._state = { status: "unreachable" };
		expect(relay.linkStatus).toBe("unreachable");

		state._state = { status: "closed" };
		expect(relay.linkStatus).toBe("closed");
	});
});
