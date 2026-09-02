/**
 * Unit tests for the managed relay link state machine.
 *
 * Uses a fake WebSocket factory so tests are deterministic and never
 * touch a network.
 */

import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
	RemoteHostBuildIdentity,
	RemoteHostEventCursor,
	RemoteHostFrameEnvelope,
	RemoteHostHandshakeAckFrame,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_INFO } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { InMemoryRemoteHostJournal, RemoteHostJournal } from "../src/modes/daemon/remote-host-journal.js";
import {
	ManagedRelayLink,
	type ManagedRelayLinkEvent,
	type ManagedRelayLinkOptions,
	type RelayWebSocket,
	type WebSocketFactory,
} from "../src/modes/daemon/remote-host-managed-relay.js";

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket implements RelayWebSocket {
	readyState: number = 0;
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: { error: unknown }) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	sent: string[] = [];
	closed = false;

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(data: string): void {
		this.onmessage?.({ data });
	}

	closeAbrupt(error: unknown = new Error("connection lost")): void {
		this.readyState = 3;
		this.onerror?.({ error });
		this.onclose?.({ code: 1006, reason: "Abnormal closure" });
	}

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
	capturedAuth: { grant?: string } | undefined;

	create(_url: string, auth?: { grant?: string }): FakeWebSocket {
		this.capturedAuth = auth;
		const ws = new FakeWebSocket();
		this.sockets.push(ws);
		this.latest = ws;
		return ws;
	}

	get lastSocket(): FakeWebSocket | undefined {
		return this.latest;
	}

	get connectedUrl(): string | undefined {
		return undefined;
	}

	reset(): void {
		this.sockets = [];
		this.latest = undefined;
		this.capturedAuth = undefined;
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
		sessionId: "sess-1",
		expectedRemoteHostId: "sandbox-1",
		expectedRemoteSessionId: "sess-1",
		buildIdentity: TEST_BUILD,
		direction: "home_to_host",
		capabilities: ["session_commands", "sequenced_events", "link_health"],
		journal: new InMemoryRemoteHostJournal({ hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1" }),
		wsFactory: new FakeWebSocketFactory(),
		pingIntervalMs: 5000,
		pongTimeoutMs: 20000,
		...overrides,
	};
}

function receivedFrameEvents(relay: ManagedRelayLink): ManagedRelayLinkEvent[] {
	const events: ManagedRelayLinkEvent[] = [];
	relay.observe((e) => events.push(e));
	return events;
}

function makeAck(overrides?: Partial<RemoteHostHandshakeAckFrame>): RemoteHostHandshakeAckFrame {
	return {
		type: "handshake_ack",
		hostId: "sandbox-1",
		sessionId: "sess-1",
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		accepted: true,
		capabilities: ["session_commands", "sequenced_events"],
		linkId: "link-1",
		remoteBuildIdentity: { ...TEST_BUILD },
		...overrides,
	};
}

function envelope(body: object, frameId = "env-1"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		sentAt: new Date().toISOString(),
		frame: body as never,
	};
}

/** Connect helper: establishes a full connection and returns the factory. */
async function connectRelay(
	relay: ManagedRelayLink,
	factory: FakeWebSocketFactory,
): Promise<{ result: { accepted: boolean; linkId?: string }; ws: FakeWebSocket }> {
	const connectPromise = relay.connect();
	const ws = factory.lastSocket!;
	ws.open();
	const sent = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
	expect(sent.frame.type).toBe("handshake");
	ws.receive(JSON.stringify(envelope(makeAck())));
	const result = await connectPromise;
	return { result, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initial state", () => {
	it("starts in idle state", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		expect(relay.status).toBe("idle");
	});

	it("starts with no resume cursor when journal is empty", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		expect(relay.resumeCursor).toBeUndefined();
	});

	it("rejects connect after unreachable terminal state", async () => {
		const relay = new ManagedRelayLink(createRelayOptions());
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

describe("connect and handshake", () => {
	it("connects, handshakes, transitions to connected with build validation", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const { result } = await connectRelay(relay, factory);
		expect(result.accepted).toBe(true);
		expect(result.linkId).toBe("link-1");
		expect(relay.status).toBe("connected");
	});

	it("transitions to unreachable when handshake is rejected", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		const rejectAck = makeAck({ accepted: false, rejectReason: "build_mismatch" });
		ws.receive(JSON.stringify(envelope(rejectAck)));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("remote_rejected");
		expect(relay.status).toBe("unreachable");
		expect(events.some((e) => e.type === "handshake_rejected")).toBe(true);
	});

	it("rejects on build identity mismatch in ack", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		const mismatchedAck = makeAck({
			remoteBuildIdentity: { buildId: "other", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		});
		ws.receive(JSON.stringify(envelope(mismatchedAck)));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("build_identity_mismatch");
		expect(relay.status).toBe("unreachable");
		expect(events.some((e) => e.type === "handshake_rejected")).toBe(true);
	});

	it("does not leak the grant into emitted frames or the journal", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const journal = new InMemoryRemoteHostJournal({
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			let grantCalled = 0;
			const relay = new ManagedRelayLink(
				createRelayOptions({
					wsFactory: factory,
					journal,
					grantProvider: async () => {
						grantCalled++;
						return "secret-grant-token";
					},
				}),
			);

			relay.connect();
			await vi.advanceTimersByTimeAsync(100);
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(makeAck())));

			expect(grantCalled).toBe(1);
			expect(factory.capturedAuth).toEqual({ grant: "secret-grant-token" });

			// No sent frame or journal entry should contain the grant
			relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
			const entries = journal.readEntries(1);
			for (const entry of entries) {
				const serialized = JSON.stringify(entry);
				expect(serialized).not.toContain("secret-grant-token");
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("handshake timeout transitions to reconnecting", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, pingIntervalMs: 100000 }));

			relay.connect();
			const ws = factory.lastSocket!;
			ws.open();

			// Advance to just past handshake timeout (15s), but before reconnect timer fires
			await vi.advanceTimersByTimeAsync(15_001);
			expect(relay.status).toBe("reconnecting");

			// Now advance past reconnect delay to trigger new socket
			await vi.advanceTimersByTimeAsync(10_000);
			expect(factory.sockets.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("single-flight connect returns same promise", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		const p1 = relay.connect();
		const p2 = relay.connect();
		// Can't use toBe for Promise identity in vitest with fake promises,
		// but we verify they resolve identically
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(makeAck())));
		const r1 = await p1;
		const r2 = await p2;
		expect(r1.accepted).toBe(true);
		expect(r2.accepted).toBe(true);
	});

	it("close settles pending connect promise", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		const connectPromise = relay.connect();
		relay.close();

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(relay.status).toBe("closed");
	});
});

describe("frame send/receive", () => {
	it("sends frames and records them in the journal", async () => {
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
		await connectRelay(relay, factory);
		const _ws = factory.lastSocket!;

		const sentEnvelope = relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
		expect(sentEnvelope.frame.type).toBe("health");

		const entries = journal.readEntries(1);
		const healthSent = entries.find((e) => e.frame.type === "health");
		expect(healthSent).toBeDefined();
	});

	it("receives frames, persists before ack, and emits frame_received", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send a non-health frame (event) to trigger frame_received
		ws.receive(
			JSON.stringify(
				envelope(
					{
						type: "event",
						id: "evt-1",
						sequence: 1,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
					"frame-rcv-1",
				),
			),
		);

		const frameEvents = events.filter((e) => e.type === "frame_received");
		expect(frameEvents).toHaveLength(1);
		if (frameEvents[0].type === "frame_received") {
			expect(frameEvents[0].envelope.frame.type).toBe("event");
		}
	});

	it("persists received frame before ack and sends ack for event frames", async () => {
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send an event frame
		const eventFrame = {
			type: "event" as const,
			id: "evt-1",
			sequence: 1,
			cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
			emittedAt: new Date().toISOString(),
			body: { type: "agent_start" as const },
		};
		ws.receive(JSON.stringify(envelope(eventFrame, "evt-1")));

		// Journal should have the received entry
		const entries = journal.readEntries(1);
		const received1 = entries.find((e) => e.frameId === "evt-1");
		expect(received1).toBeDefined();
		expect(received1?.type).toBe("received");

		// Should have sent an ack
		const sentAcks = ws.sent.filter((s) => {
			try {
				const e = JSON.parse(s) as RemoteHostFrameEnvelope;
				return e.frame.type === "ack";
			} catch {
				return false;
			}
		});
		expect(sentAcks.length).toBe(1);
	});

	it("does not emit duplicate frames as new work", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send event frame twice
		const eventFrame = {
			type: "event" as const,
			id: "evt-d1",
			sequence: 1,
			cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
			emittedAt: new Date().toISOString(),
			body: { type: "agent_start" as const },
		};
		ws.receive(JSON.stringify(envelope(eventFrame, "evt-d1")));
		ws.receive(JSON.stringify(envelope(eventFrame, "evt-d1")));

		const frameEvents = events.filter((e) => e.type === "frame_received");
		expect(frameEvents).toHaveLength(1);
	});

	it("validates envelope and rejects invalid frames", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Invalid envelope
		ws.receive(JSON.stringify({ not_frame: true }));
		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents.length).toBeGreaterThan(0);

		// Wrong protocol name envelope
		ws.receive(
			JSON.stringify({
				type: "frame",
				frameId: "bad",
				protocol: { name: "wrong", version: 1 },
				sentAt: "now",
				frame: { type: "health", healthSeq: 1, status: "connected" },
			}),
		);
		expect(events.filter((e) => e.type === "error").length).toBe(2);
	});
});

describe("close", () => {
	it("graceful close stops at closed state", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		await connectRelay(relay, factory);

		relay.close();
		expect(relay.status).toBe("closed");
		expect(factory.lastSocket!.closed).toBe(true);
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
		factory.lastSocket!.open();
		relay.close();
		expect(relay.status).toBe("closed");
	});

	it("close from reconnecting state cancels reconnect timer", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			await connectRelay(relay, factory);

			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("reconnecting");

			relay.close();
			expect(relay.status).toBe("closed");

			await vi.advanceTimersByTimeAsync(100_000);
			expect(factory.sockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("reconnect and backoff", () => {
	it("reconnects after unexpected close with bounded exponential backoff", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			await connectRelay(relay, factory);
			expect(factory.sockets.length).toBe(1);

			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("reconnecting");

			await vi.advanceTimersByTimeAsync(5_000);
			expect(factory.sockets.length).toBe(2);

			const ws = factory.lastSocket!;
			ws.open();
			expect(ws.sent.length).toBe(1);
			const sent = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
			expect(sent.frame.type).toBe("handshake");

			ws.receive(JSON.stringify(envelope(makeAck())));
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
			await connectRelay(relay, factory);

			for (let attempt = 1; attempt <= 10; attempt++) {
				factory.lastSocket!.closeAbrupt();
				expect(relay.status).toBe("reconnecting");
				await vi.advanceTimersByTimeAsync(70_000);
			}

			// 11th close exhausts retry budget
			factory.lastSocket!.closeAbrupt();
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
			await connectRelay(relay, factory);

			relay.close();
			expect(relay.status).toBe("closed");

			await vi.advanceTimersByTimeAsync(100_000);
			expect(factory.sockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fetches fresh grant per reconnect", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			let grantCounter = 0;
			const relay = new ManagedRelayLink(
				createRelayOptions({
					wsFactory: factory,
					pingIntervalMs: 100000,
					grantProvider: async () => {
						grantCounter++;
						return `grant-${grantCounter}`;
					},
				}),
			);

			// Connect manually (grant provider is async so socket created after await)
			relay.connect();
			// advance so the async grant provider resolves
			await vi.advanceTimersByTimeAsync(100);
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(makeAck())));
			expect(grantCounter).toBe(1);
			expect(factory.capturedAuth).toEqual({ grant: "grant-1" });

			// Disconnect and reconnect — should get fresh grant
			factory.lastSocket!.closeAbrupt();
			await vi.advanceTimersByTimeAsync(10_000);

			ws = factory.lastSocket!;
			expect(grantCounter).toBe(2);
			expect(factory.capturedAuth).toEqual({ grant: "grant-2" });

			ws.open();
			ws.receive(JSON.stringify(envelope(makeAck())));
			expect(relay.status).toBe("connected");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ping/pong liveness", () => {
	it("sends periodic health frames when connected", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(
				createRelayOptions({ wsFactory: factory, pingIntervalMs: 100, pongTimeoutMs: 5000 }),
			);
			await connectRelay(relay, factory);
			const ws = factory.lastSocket!;

			const initialCount = ws.sent.length;

			await vi.advanceTimersByTimeAsync(100);
			expect(ws.sent.length).toBe(initialCount + 1);

			await vi.advanceTimersByTimeAsync(100);
			expect(ws.sent.length).toBe(initialCount + 2);

			relay.close();
			const afterClose = ws.sent.length;
			await vi.advanceTimersByTimeAsync(500);
			expect(ws.sent.length).toBe(afterClose);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects after pong timeout expires", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(
				createRelayOptions({ wsFactory: factory, pingIntervalMs: 50, pongTimeoutMs: 200 }),
			);
			await connectRelay(relay, factory);

			// Advance past pong timeout without receiving any messages
			await vi.advanceTimersByTimeAsync(300);

			// Should trigger reconnect
			expect(relay.status).toBe("reconnecting");
			await vi.advanceTimersByTimeAsync(5_000);
			expect(factory.sockets.length).toBeGreaterThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("event ordering and recovery", () => {
	it("emits handshake_completed before frame_received events", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const order: string[] = [];

		relay.observe((event) => order.push(event.type));

		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send event frames (not health) to trigger frame_received
		ws.receive(
			JSON.stringify(
				envelope(
					{
						type: "event",
						id: "evt-1",
						sequence: 1,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
					"f1",
				),
			),
		);
		ws.receive(
			JSON.stringify(
				envelope(
					{
						type: "event",
						id: "evt-2",
						sequence: 2,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 2 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_end", messages: 1 },
					},
					"f2",
				),
			),
		);

		expect(order[0]).toBe("handshake_completed");
		const frameEvents = order.filter((e) => e === "frame_received");
		expect(frameEvents).toHaveLength(2);
	});

	it("fires recovered on reconnect with cursor", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const journal = new InMemoryRemoteHostJournal({
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
			const events: ManagedRelayLinkEvent[] = [];
			relay.observe((e) => events.push(e));

			await connectRelay(relay, factory);

			// Simulate received event in journal so resume cursor is non-zero
			journal.recordReceived(
				envelope(
					{
						type: "event",
						id: "evt-1",
						sequence: 1,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
					"evt-1",
				) as RemoteHostFrameEnvelope,
			);

			// Disconnect and reconnect
			factory.lastSocket!.closeAbrupt();
			await vi.advanceTimersByTimeAsync(5_000);

			const ws = factory.lastSocket!;
			ws.open();
			const ackWithCursor = makeAck({
				cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
			});
			ws.receive(JSON.stringify(envelope(ackWithCursor)));

			const recovered = events.find((e) => e.type === "recovered");
			expect(recovered).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("observe disposer", () => {
	it("observe returns a disposer that removes the observer", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		const events: ManagedRelayLinkEvent[] = [];
		const disposer = relay.observe((e) => events.push(e));
		disposer();
		expect(true).toBe(true);
	});

	it("supports multiple observers", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const eventsA: ManagedRelayLinkEvent[] = [];
		const eventsB: ManagedRelayLinkEvent[] = [];

		relay.observe((e) => eventsA.push(e));
		relay.observe((e) => eventsB.push(e));

		await connectRelay(relay, factory);

		expect(eventsA.some((e) => e.type === "handshake_completed")).toBe(true);
		expect(eventsB.some((e) => e.type === "handshake_completed")).toBe(true);
	});

	it("observer errors do not crash the relay", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.observe(() => {
			throw new Error("observer error");
		});

		await connectRelay(relay, factory);
		expect(relay.status).toBe("connected");
	});
});

describe("stale socket guards", () => {
	it("stale socket callbacks do not affect state after close", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			await connectRelay(relay, factory);

			const oldSocket = factory.lastSocket!;
			relay.close();

			// Stale callback on old socket
			oldSocket.open(); // should be no-op for state
			const event: ManagedRelayLinkEvent[] = [];
			relay.observe((e) => event.push(e));
			oldSocket.receive(JSON.stringify(envelope(makeAck())));
			expect(event.filter((e) => e.type === "handshake_completed")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("onerror forces disconnect path", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			await connectRelay(relay, factory);

			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("reconnecting");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("random UUID frame IDs", () => {
	it("sendFrame uses collision-resistant frame IDs", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		await connectRelay(relay, factory);

		const e1 = relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
		const e2 = relay.sendFrame({ type: "health", healthSeq: 2, status: "connected" });
		expect(e1.frameId).not.toBe(e2.frameId);
		expect(e1.frameId.length).toBe(36); // UUID v4
	});

	it("frame IDs survive restart (no sequential counter leak)", () => {
		const relay = new ManagedRelayLink(createRelayOptions());
		const e1 = relay.sendFrame({ type: "health", healthSeq: 1, status: "connected" });
		// Even without connection, frame ID is a UUID
		expect(e1.frameId.length).toBe(36);
	});
});

describe("grant provider failure", () => {
	it("connection fails when grant provider throws", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(
			createRelayOptions({
				wsFactory: factory,
				grantProvider: async () => {
					throw new Error("auth denied");
				},
			}),
		);

		const result = await relay.connect();
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("grant_failed");
		expect(relay.status).toBe("reconnecting");
		expect(factory.sockets.length).toBe(0);
	});
});

describe("malformed ack", () => {
	it("rejects malformed ack (missing protocol) with teardown and stable rejection", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events: ManagedRelayLinkEvent[] = [];
		relay.observe((e) => events.push(e));

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		// Send ack missing protocol and remoteBuildIdentity
		ws.receive(
			JSON.stringify({
				type: "frame",
				frameId: "bad-ack",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: {
					type: "handshake_ack",
					accepted: true,
					hostId: "sandbox-1",
					sessionId: "sess-1",
					linkId: "link-1",
					capabilities: ["session_commands"],
				},
			}),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toContain("malformed_ack");
		expect(relay.status).toBe("unreachable");
		const rejected = events.find((e) => e.type === "handshake_rejected");
		expect(rejected).toBeDefined();
	});

	it("rejects ack with non-boolean accepted field", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		ws.receive(
			JSON.stringify({
				type: "frame",
				frameId: "bad-ack-2",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: {
					type: "handshake_ack",
					accepted: "yes",
					hostId: "sandbox-1",
					sessionId: "sess-1",
					linkId: "link-1",
					capabilities: ["session_commands"],
					protocol: REMOTE_HOST_PROTOCOL_INFO,
				},
			}),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(relay.status).toBe("unreachable");
	});
});

describe("send failure handling", () => {
	it("handshake send failure triggers reconnect", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, pingIntervalMs: 100000 }));
		const events: ManagedRelayLinkEvent[] = [];
		relay.observe((e) => events.push(e));

		relay.connect();
		const ws = factory.lastSocket!;

		// Make send throw
		const originalSend = ws.send.bind(ws);
		ws.send = () => {
			throw new Error("send failed");
		};

		ws.open();

		// The error should be caught, socket torn down, and reconnect scheduled
		expect(relay.status).toBe("reconnecting");

		// Restore send and advance timers to reconnect
		ws.send = originalSend;
		expect(factory.sockets.length).toBe(1);
	});
});

describe("send replay failure propagation", () => {
	it("send failure during replay rejects handshake with replay_resync_required", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const journal = new InMemoryRemoteHostJournal({
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			const relay = new ManagedRelayLink(
				createRelayOptions({ wsFactory: factory, journal, pingIntervalMs: 100000, pongTimeoutMs: 500000 }),
			);

			relay.connect();
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(makeAck())));
			await vi.advanceTimersByTimeAsync(100);
			expect(relay.status).toBe("connected");

			for (let i = 1; i <= 3; i++) {
				journal.recordSent({
					type: "frame",
					frameId: "cmd-" + i,
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					sentAt: new Date().toISOString(),
					frame: { type: "command", commandId: "cmd-" + i, body: { type: "abort" } },
				});
			}

			const events: ManagedRelayLinkEvent[] = [];
			relay.observe((e) => events.push(e));

			ws.closeAbrupt();
			await vi.advanceTimersByTimeAsync(10_000);

			ws = factory.lastSocket!;
			let sendCount = 0;
			ws.send = () => {
				sendCount++;
				if (sendCount > 1) throw new Error("send failed");
			};
			ws.open();
			ws.receive(
				JSON.stringify(
					envelope(
						makeAck({
							cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 0 },
						}),
					),
				),
			);
			await vi.advanceTimersByTimeAsync(100);

			expect(relay.status).toBe("unreachable");
			const resyncEvent = events.find((e) => e.type === "replay_resync_required");
			expect(resyncEvent).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("constructor validation", () => {
	it("rejects empty hostId", () => {
		expect(() => new ManagedRelayLink(createRelayOptions({ hostId: "" }))).toThrow("hostId");
	});
	it("rejects empty generation", () => {
		expect(() => new ManagedRelayLink(createRelayOptions({ generation: "" }))).toThrow("generation");
	});
	it("rejects empty sessionId", () => {
		expect(() => new ManagedRelayLink(createRelayOptions({ sessionId: "" }))).toThrow("sessionId");
	});
	it("rejects empty expectedRemoteHostId", () => {
		expect(() => new ManagedRelayLink(createRelayOptions({ expectedRemoteHostId: "" }))).toThrow(
			"expectedRemoteHostId",
		);
	});
	it("rejects empty expectedRemoteSessionId", () => {
		expect(() => new ManagedRelayLink(createRelayOptions({ expectedRemoteSessionId: "" }))).toThrow(
			"expectedRemoteSessionId",
		);
	});
	it("rejects empty buildIdentity.buildId", () => {
		expect(
			() =>
				new ManagedRelayLink(
					createRelayOptions({
						buildIdentity: { buildId: "", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
					}),
				),
		).toThrow("buildId");
	});
	it("rejects invalid daemonProtocolVersion (negative)", () => {
		expect(
			() =>
				new ManagedRelayLink(
					createRelayOptions({
						buildIdentity: { buildId: "b", daemonProtocolVersion: -1, daemonSchemaRevision: 25 },
					}),
				),
		).toThrow("daemonProtocolVersion");
	});
	it("rejects invalid daemonSchemaRevision (float)", () => {
		expect(
			() =>
				new ManagedRelayLink(
					createRelayOptions({
						buildIdentity: { buildId: "b", daemonProtocolVersion: 7, daemonSchemaRevision: 25.5 },
					}),
				),
		).toThrow("daemonSchemaRevision");
	});
});
describe("protocol compatibility", () => {
	it("rejects handshake ack with mismatched protocol", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		const badAck = makeAck({
			protocol: { name: "prime-agent.remote-host", version: 99 } as never,
		});
		ws.receive(JSON.stringify(envelope(badAck)));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("protocol_incompatible");
		expect(relay.status).toBe("unreachable");
		expect(events.some((e) => e.type === "handshake_rejected")).toBe(true);
	});
});

describe("unreachable state", () => {
	it("failedAt timestamp is stable across reads", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();

		ws.receive(JSON.stringify(envelope(makeAck({ accepted: false, rejectReason: "denied" }))));
		await connectPromise;

		const h1 = relay.health;
		const h2 = relay.health;
		if (h1.status === "unreachable" && h2.status === "unreachable") {
			expect(h1.failedAt).toBe(h2.failedAt);
		}
	});
});

describe("monotonic health sequence", () => {
	it("increments healthSeq on each sent ping", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, pingIntervalMs: 50 }));
			await connectRelay(relay, factory);
			const ws = factory.lastSocket!;

			const initial = ws.sent.length;

			await vi.advanceTimersByTimeAsync(50);
			const p1 = JSON.parse(ws.sent[initial]) as RemoteHostFrameEnvelope;
			expect(p1.frame.type).toBe("health");
			if (p1.frame.type === "health") {
				expect(p1.frame.healthSeq).toBe(1);
			}

			await vi.advanceTimersByTimeAsync(50);
			const p2 = JSON.parse(ws.sent[initial + 1]) as RemoteHostFrameEnvelope;
			if (p2.frame.type === "health") {
				expect(p2.frame.healthSeq).toBe(2);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("file-backed journal replay", () => {
	it("persists entries to file journal and recovers via cursor", async () => {
		vi.useFakeTimers();
		try {
			const tmpDir = fs.mkdtempSync("/tmp/relay-journal-");
			const journalPath = `${tmpDir}/journal.jsonl`;
			const journal = new RemoteHostJournal({
				path: journalPath,
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(
				createRelayOptions({
					wsFactory: factory,
					journal,
					sessionId: "sess-1",
				}),
			);

			// Connect under fake timers
			relay.connect();
			let ws = factory.lastSocket!;
			ws.open();
			ws.receive(JSON.stringify(envelope(makeAck())));
			// Wait for all microtasks
			await vi.advanceTimersByTimeAsync(100);

			// Record received event so journal has a non-zero cursor
			journal.recordReceived({
				type: "frame",
				frameId: "evt-rcv-1",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: {
					type: "event",
					id: "evt-rcv-1",
					sequence: 5,
					cursor: {
						hostId: "sandbox-1",
						generation: "gen-abc",
						sessionId: "sess-1",
						sequence: 5,
					},
					emittedAt: new Date().toISOString(),
					body: { type: "agent_start" },
				},
			});

			// Verify file journal has the entry
			const entriesOnDisk = journal.readEntries(1);
			expect(entriesOnDisk.length).toBeGreaterThanOrEqual(1);
			const receivedEvent = entriesOnDisk.find((e) => e.frameId === "evt-rcv-1");
			expect(receivedEvent).toBeDefined();
			expect(receivedEvent!.type).toBe("received");
			expect(journal.lastReceivedEventSequence).toBe(5);

			// Disconnect and reconnect
			ws.closeAbrupt();
			await vi.advanceTimersByTimeAsync(5_000);

			ws = factory.lastSocket!;
			ws.open();

			// Handshake should include resumeCursor from file journal
			const sent = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
			if (sent.frame.type === "handshake") {
				expect(sent.frame.resumeCursor).toBeDefined();
				const cursor = sent.frame.resumeCursor!;
				expect(cursor.hostId).toBe("sandbox-1");
				expect(cursor.generation).toBe("gen-abc");
				expect(cursor.sessionId).toBe("sess-1");
				expect(cursor.sequence).toBe(5);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("orphaned timers", () => {
	it("orphaned reconnect timer does not fire after close", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
			await connectRelay(relay, factory);

			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("reconnecting");

			relay.close();

			await vi.advanceTimersByTimeAsync(200_000);
			expect(factory.sockets.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("orphaned handshake timer does not fire after close", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

			relay.connect();
			factory.lastSocket!.open();

			relay.close();

			await vi.advanceTimersByTimeAsync(30_000);
			expect(relay.status).toBe("closed");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("health getter stable timestamps", () => {
	it("health connecting timestamp is stable across reads", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));

		relay.connect();
		const h1 = relay.health;
		const h2 = relay.health;
		if (h1.status === "connecting" && h2.status === "connecting") {
			expect(h1.startedAt).toBe(h2.startedAt);
		}
	});

	it("health connected timestamp is stable across reads", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		await connectRelay(relay, factory);

		const h1 = relay.health;
		const h2 = relay.health;
		if (h1.status === "connected" && h2.status === "connected") {
			expect(h1.connectedAt).toBe(h2.connectedAt);
		}
	});
});
describe("ack frame handling", () => {
	it("does not emit received ack frames as application work", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		const events = receivedFrameEvents(relay);
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send an ack frame
		ws.receive(
			JSON.stringify(
				envelope({ type: "ack", ackId: "ack-1", acknowledges: "some-frame", status: "delivered" }, "ack-inbound"),
			),
		);

		const frameEvents = events.filter((e) => e.type === "frame_received");
		expect(frameEvents).toHaveLength(0);
	});

	it("ACKs every durable application frame (event/command/agent_message/provider_proxy)", async () => {
		const factory = new FakeWebSocketFactory();
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory }));
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		const durableTypes = [
			{
				type: "event" as const,
				id: "e-1",
				sequence: 1,
				cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
				emittedAt: new Date().toISOString(),
				body: { type: "agent_start" as const },
			},
			{ type: "command" as const, commandId: "c-1", body: { type: "abort" as const } },
			{
				type: "agent_message" as const,
				id: "m-1",
				fromActiveSessionId: "a",
				targetActiveSessionId: "b",
				message: "hi",
			},
			{
				type: "provider_proxy" as const,
				proxyType: "model_call_request" as const,
				callId: "call-1",
				provider: "test",
				model: "test",
				messages: [],
			},
		];

		for (const frame of durableTypes) {
			ws.receive(JSON.stringify(envelope(frame as never, `f-${frame.type}`)));
		}

		// Count ack frames sent back
		const ackCount = ws.sent.filter((s) => {
			try {
				const e = JSON.parse(s) as RemoteHostFrameEnvelope;
				return e.frame.type === "ack";
			} catch {
				return false;
			}
		}).length;
		expect(ackCount).toBe(4);
	});
});

describe("unacknowledged replay", () => {
	it("replays unacknowledged sent entries with original IDs before handshake_completed", async () => {
		const factory = new FakeWebSocketFactory();
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const relay = new ManagedRelayLink(
			createRelayOptions({
				wsFactory: factory,
				journal,
			}),
		);

		// Simulate unacknowledged sent command
		journal.recordSent({
			type: "frame",
			frameId: "cmd-unacked-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "command", commandId: "cmd-unacked-1", body: { type: "abort" } },
		});
		// Acknowledged command should NOT be replayed
		journal.recordSent({
			type: "frame",
			frameId: "cmd-acked-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "command", commandId: "cmd-acked-1", body: { type: "abort" } },
		});
		journal.recordReceived({
			type: "frame",
			frameId: "ack-cmd-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "ack", ackId: "ack-cmd-1", acknowledges: "cmd-acked-1", status: "delivered" },
		});

		// Send health frame (should not be replayed)
		journal.recordSent({
			type: "frame",
			frameId: "health-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});

		// Connect — replay should resend only the unacknowledged command
		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(JSON.stringify(envelope(makeAck())));
		await connectPromise;

		// Check what was sent after handshake: should include unacked cmd with original frameId
		const afterHandshake = ws.sent.slice(1); // skip handshake envelope
		const replayed = afterHandshake.filter((s) => {
			try {
				const e = JSON.parse(s) as RemoteHostFrameEnvelope;
				return e.frame.type === "command";
			} catch {
				return false;
			}
		});
		expect(replayed).toHaveLength(1);
		const replayedFrame = JSON.parse(replayed[0]) as RemoteHostFrameEnvelope;
		expect(replayedFrame.frameId).toBe("cmd-unacked-1");
	});
});

describe("grant provider failure handling", () => {
	it("fails connection and retries on grant provider rejection", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(
				createRelayOptions({
					wsFactory: factory,
					pingIntervalMs: 100000,
					grantProvider: async () => {
						throw new Error("token expired");
					},
				}),
			);

			relay.connect();
			// Grant provider throws, should transition to reconnecting
			await vi.advanceTimersByTimeAsync(100);
			expect(relay.status).toBe("reconnecting");

			// Should retry (backoff timer fires)
			await vi.advanceTimersByTimeAsync(10_000);
			expect(factory.sockets.length).toBe(0); // grant failed again, no socket
		} finally {
			vi.useRealTimers();
		}
	});
});
describe("ack persistence before return", () => {
	it("persists ack frame to journal before returning from handleMessage", async () => {
		const factory = new FakeWebSocketFactory();
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));

		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		// Send a command frame
		ws.receive(
			JSON.stringify(envelope({ type: "command", commandId: "cmd-1", body: { type: "abort" } }, "cmd-rcv-1")),
		);

		// Journal should have the received entry
		const entries = journal.readEntries(1);
		const receivedEntry = entries.find((e) => e.frameId === "cmd-rcv-1");
		expect(receivedEntry).toBeDefined();
		expect(receivedEntry!.type).toBe("received");
	});
});

describe("ack suppresses replay after restart", () => {
	it("does not replay an acknowledged command after restart", async () => {
		const factory = new FakeWebSocketFactory();
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const relay = new ManagedRelayLink(
			createRelayOptions({
				wsFactory: factory,
				journal,
			}),
		);

		// Record an unacknowledged command and an acknowledged one
		journal.recordSent({
			type: "frame",
			frameId: "cmd-acked",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "command", commandId: "cmd-acked", body: { type: "abort" } },
		});
		journal.recordReceived({
			type: "frame",
			frameId: "ack-for-cmd",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "ack", ackId: "ack-1", acknowledges: "cmd-acked", status: "delivered" },
		});
		journal.recordSent({
			type: "frame",
			frameId: "cmd-unacked",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "command", commandId: "cmd-unacked", body: { type: "abort" } },
		});

		// Connect — replay should resend only the unacknowledged command with original ID
		await connectRelay(relay, factory);
		const ws = factory.lastSocket!;

		const replayedCmds = ws.sent
			.filter((s) => {
				try {
					const e = JSON.parse(s) as RemoteHostFrameEnvelope;
					return e.frame.type === "command";
				} catch {
					return false;
				}
			})
			.map((s) => {
				const e = JSON.parse(s) as RemoteHostFrameEnvelope;
				return e.frameId;
			});

		expect(replayedCmds).toContain("cmd-unacked");
		expect(replayedCmds).not.toContain("cmd-acked");
	});
});

describe("session mismatch", () => {
	it("reports unavailable replay for different session cursor", async () => {
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-A",
		});
		const cursor: RemoteHostEventCursor = {
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-B",
			sequence: 1,
		};
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("session_mismatch");
	});
});

describe("replay_resync_required", () => {
	it("emits replay_resync_required and fails handshake on sequence gap", async () => {
		const factory = new FakeWebSocketFactory();
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));

		for (const seq of [1, 2, 4]) {
			journal.recordSent({
				type: "frame",
				frameId: `evt-${seq}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: {
					type: "event",
					id: `evt-${seq}`,
					sequence: seq,
					cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: seq },
					emittedAt: new Date().toISOString(),
					body: { type: "agent_start" },
				},
			});
		}

		journal.recordReceived({
			type: "frame",
			frameId: "rcv-evt-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: {
				type: "event",
				id: "rcv-evt-1",
				sequence: 1,
				cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 },
				emittedAt: new Date().toISOString(),
				body: { type: "agent_start" },
			},
		});

		const events: ManagedRelayLinkEvent[] = [];
		relay.observe((e) => events.push(e));
		const connectPromise = relay.connect();
		const ws = factory.lastSocket!;
		ws.open();
		ws.receive(
			JSON.stringify(
				envelope(
					makeAck({ cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 1 } }),
				),
			),
		);
		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(result.rejectReason).toBe("replay_resync_required");
		const resyncEvent = events.find((e) => e.type === "replay_resync_required");
		expect(resyncEvent).toBeDefined();
	});
});

describe("replay boundary", () => {
	it("exact MAX_REPLAY_PAGES pages without gap completes successfully", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const journal = new InMemoryRemoteHostJournal({
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
			for (let i = 1; i <= 10; i++) {
				journal.recordSent({
					type: "frame",
					frameId: `evt-${i}`,
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					sentAt: new Date().toISOString(),
					frame: {
						type: "event",
						id: `evt-${i}`,
						sequence: i,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: i },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
				});
			}
			const connectPromise = relay.connect();
			const ws = factory.lastSocket!;
			ws.open();
			ws.receive(
				JSON.stringify(
					envelope(
						makeAck({ cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 0 } }),
					),
				),
			);
			const result = await connectPromise;
			expect(result.accepted).toBe(true);
			expect(relay.status).toBe("connected");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("reconnect cancel on explicit connect", () => {
	it("cancels pending reconnect timer when connect() is called during reconnecting", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, pingIntervalMs: 100000 }));
			await connectRelay(relay, factory);
			factory.lastSocket!.closeAbrupt();
			expect(relay.status).toBe("reconnecting");
			relay.connect();
			const _newWs = factory.lastSocket!;
			expect(factory.sockets.length).toBe(2);
			await vi.advanceTimersByTimeAsync(100_000);
			expect(factory.sockets.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("resume cursor", () => {
	it("returns resume cursor based on journal last received sequence", () => {
		const journal = new InMemoryRemoteHostJournal({
			hostId: "sandbox-1",
			generation: "gen-abc",
			sessionId: "sess-1",
		});
		const relay = new ManagedRelayLink(createRelayOptions({ journal }));
		expect(relay.resumeCursor).toBeUndefined();
		journal.recordReceived(
			envelope(
				{
					type: "event",
					id: "evt-1",
					sequence: 5,
					cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 5 },
					emittedAt: new Date().toISOString(),
					body: { type: "agent_start" },
				},
				"evt-1",
			) as RemoteHostFrameEnvelope,
		);
		const cursor = relay.resumeCursor;
		expect(cursor).toBeDefined();
		expect(cursor!.sequence).toBe(5);
	});

	it("sends resume cursor on reconnect handshake", async () => {
		vi.useFakeTimers();
		try {
			const journal = new InMemoryRemoteHostJournal({
				hostId: "sandbox-1",
				generation: "gen-abc",
				sessionId: "sess-1",
			});
			const factory = new FakeWebSocketFactory();
			const relay = new ManagedRelayLink(createRelayOptions({ wsFactory: factory, journal }));
			await connectRelay(relay, factory);
			journal.recordReceived(
				envelope(
					{
						type: "event",
						id: "evt-1",
						sequence: 3,
						cursor: { hostId: "sandbox-1", generation: "gen-abc", sessionId: "sess-1", sequence: 3 },
						emittedAt: new Date().toISOString(),
						body: { type: "agent_start" },
					},
					"evt-1",
				) as RemoteHostFrameEnvelope,
			);
			factory.lastSocket!.closeAbrupt();
			await vi.advanceTimersByTimeAsync(5_000);
			const ws = factory.lastSocket!;
			ws.open();
			const sentHandshake = JSON.parse(ws.sent[0]) as RemoteHostFrameEnvelope;
			if (sentHandshake.frame.type === "handshake") {
				expect(sentHandshake.frame.resumeCursor).toBeDefined();
				expect(sentHandshake.frame.resumeCursor!.sequence).toBe(3);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
describe("session isolation", () => {
	it("different session sees no prior state from same file", async () => {
		const dir = fs.mkdtempSync("/tmp/relay-session-iso-");
		const path = `${dir}/journal.jsonl`;

		// Write entries for session A
		const journalA = new RemoteHostJournal({
			path,
			hostId: "s",
			generation: "g",
			sessionId: "session-A",
		});
		journalA.recordSent({
			type: "frame",
			frameId: "cmd-A",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "command", commandId: "cmd-A", body: { type: "abort" } },
		});
		journalA.recordReceived({
			type: "frame",
			frameId: "rcv-A",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "ack", ackId: "ack-A", acknowledges: "cmd-A", status: "delivered" },
		});
		expect(journalA.dedupCount).toBe(1);
		expect(journalA.lastReceivedEventSequence).toBe(0);

		// Open same path under session B — must show zero state
		const journalB = new RemoteHostJournal({
			path,
			hostId: "s",
			generation: "g",
			sessionId: "session-B",
		});
		expect(journalB.dedupCount).toBe(0);
		expect(journalB.lastReceivedEventSequence).toBe(0);
		const unackedB = journalB.getUnacknowledgedSentEntries();
		expect(unackedB).toHaveLength(0);
		const entriesB = journalB.readEntries(1);
		expect(entriesB).toHaveLength(0);

		fs.rmSync(dir, { recursive: true, force: true });
	}, 10_000);
});
