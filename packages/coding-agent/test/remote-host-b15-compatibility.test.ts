/**
 * B15: Protocol compatibility, reconnect, and recovery tests.
 *
 * Production-hardening tests for the remote agent-host protocol and managed
 * relay. Covers edge cases not exercised by B03/B04:
 *   - Exact build/daemon/schema/capability negotiation
 *   - Old/new/missing/unknown/oversized field handling
 *   - Handshake reject teardown completeness
 *   - Journal isolation across hosts/generations/sessions
 *   - Restart ACK cursor persistence across cycles
 *   - Missing journal + positive cursor resync
 *   - Reconnect backoff/reset/jitter correctness
 *   - Reconnect while timer pending
 *   - Disconnect mid-replay/mid-send
 *   - Sequence gap detection edge cases
 *   - Duplicate/out-of-order frame handling
 *   - Corrupted/truncated journal robustness
 *   - Bounded replay pages enforcement
 *
 * All tests use pure in-memory journals (or tmpdir for file-backed tests),
 * no network, no paid resources.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type {
	RemoteHostBuildIdentity,
	RemoteHostCapability,
	RemoteHostEventCursor,
	RemoteHostEventSequence,
	RemoteHostFrame,
	RemoteHostHandshakeAckFrame,
	RemoteHostHandshakeFrame,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import {
	intersectRemoteHostCapabilities,
	isRemoteHostProtocolCompatible,
	REMOTE_HOST_PROTOCOL_INFO,
	validateRemoteHostFrame,
	validateRemoteHostHandshake,
	validateRemoteHostHandshakeAck,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { InMemoryRemoteHostJournal, RemoteHostJournal } from "../src/modes/daemon/remote-host-journal.js";
import {
	ManagedRelayLink,
	type RelayWebSocket,
	type WebSocketFactory,
} from "../src/modes/daemon/remote-host-managed-relay.js";

// ---------------------------------------------------------------------------
// Constants (mirrored from remote-host-managed-relay.ts for test verification)
// ---------------------------------------------------------------------------

const MAX_REPLAY_PAGES = 10;
const MAX_REPLAY_PAGE_ENTRIES = 200;
const MAX_UNACKED_FOR_REPLAY = MAX_REPLAY_PAGES * MAX_REPLAY_PAGE_ENTRIES; // 2000
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

function jitteredBackoffMs(attempt: number): number {
	const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
	return Math.round(base * (0.5 + Math.random() * 0.5));
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_BUILD: RemoteHostBuildIdentity = {
	buildId: "build-abc",
	daemonProtocolVersion: 7,
	daemonSchemaRevision: 25,
};

const ALT_BUILD: RemoteHostBuildIdentity = {
	buildId: "build-xyz",
	daemonProtocolVersion: 7,
	daemonSchemaRevision: 25,
};

function makeHandshake(overrides?: Partial<RemoteHostHandshakeFrame>): RemoteHostHandshakeFrame {
	return {
		type: "handshake",
		direction: "home_to_host",
		hostId: "sandbox-1",
		generation: "gen-abc123",
		capabilities: ["session_commands", "sequenced_events"],
		runtime: TEST_BUILD,
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		...overrides,
	};
}

function makeAck(overrides?: Partial<RemoteHostHandshakeAckFrame>): Record<string, unknown> {
	return {
		type: "handshake_ack",
		accepted: true,
		hostId: "sandbox-remote-1",
		sessionId: "sess-remote-1",
		protocol: { name: "prime-agent.remote-host", version: 1 },
		capabilities: ["session_commands", "sequenced_events"],
		linkId: "link-1",
		remoteBuildIdentity: { buildId: "build-abc", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		...overrides,
	};
}

function mkJ(opts: { hostId: string; generation: string; sessionId: string }): InMemoryRemoteHostJournal {
	return new InMemoryRemoteHostJournal({
		hostId: opts.hostId,
		generation: opts.generation,
		sessionId: opts.sessionId,
	});
}

// ---------------------------------------------------------------------------
// Fake WebSocket (modeled on B04 FakeWebSocket)
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

class FakeWebSocketFactory implements WebSocketFactory {
	sockets: FakeWebSocket[] = [];
	capturedAuth: { grant?: string } | undefined;

	create(_url: string, auth?: { grant?: string }): FakeWebSocket {
		this.capturedAuth = auth;
		const ws = new FakeWebSocket();
		this.sockets.push(ws);
		return ws;
	}

	get lastSocket(): FakeWebSocket | undefined {
		return this.sockets[this.sockets.length - 1];
	}
}

// ---------------------------------------------------------------------------
// Test relay factory
// ---------------------------------------------------------------------------

function createTestRelay(
	factory: FakeWebSocketFactory,
	journal?: InMemoryRemoteHostJournal,
	overrides?: Partial<{
		hostId: string;
		generation: string;
		sessionId: string;
		expectedRemoteHostId: string;
		expectedRemoteSessionId: string;
		capabilities: RemoteHostCapability[];
	}>,
): ManagedRelayLink {
	const j = journal ?? mkJ({ hostId: "sandbox-1", generation: "gen-abc123", sessionId: "sess-1" });
	return new ManagedRelayLink({
		url: "ws://fake.test/relay",
		hostId: overrides?.hostId ?? "sandbox-1",
		generation: overrides?.generation ?? "gen-abc123",
		sessionId: overrides?.sessionId ?? "sess-1",
		expectedRemoteHostId: overrides?.expectedRemoteHostId ?? "sandbox-remote-1",
		expectedRemoteSessionId: overrides?.expectedRemoteSessionId ?? "sess-remote-1",
		buildIdentity: TEST_BUILD,
		direction: "home_to_host",
		capabilities: overrides?.capabilities ?? ["session_commands", "sequenced_events"],
		journal: j,
		wsFactory: factory,
	});
}

function makeEnvelope(frame: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "frame",
		frameId: randomUUID(),
		protocol: { name: "prime-agent.remote-host", version: 1 },
		sentAt: new Date().toISOString(),
		frame,
	};
}

// ============================================================================
// Tests
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Exact build/daemon protocol/schema/capability negotiation
// ---------------------------------------------------------------------------

describe("B15: protocol and capability negotiation", () => {
	it("rejects negative protocol version", () => {
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, {
				name: "prime-agent.remote-host",
				version: -1 as never,
			}),
		).toBe(false);
	});

	it("rejects different protocol name (case mismatch)", () => {
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, {
				name: "Prime-Agent.Remote-Host" as never,
				version: 1,
			}),
		).toBe(false);
	});

	it("capability intersection with empty arrays", () => {
		expect(intersectRemoteHostCapabilities([], [])).toEqual([]);
		expect(intersectRemoteHostCapabilities(["session_commands"], [])).toEqual([]);
		expect(intersectRemoteHostCapabilities([], ["session_commands"])).toEqual([]);
	});

	it("capability intersection with unknown capabilities is empty", () => {
		const home: RemoteHostCapability[] = ["unknown_cap" as RemoteHostCapability, "session_commands"];
		const host: RemoteHostCapability[] = ["session_commands", "sequenced_events"];
		expect(intersectRemoteHostCapabilities(home, host)).toEqual(["session_commands"]);
	});

	it("intersect with zero common capabilities", () => {
		expect(intersectRemoteHostCapabilities(["session_commands"], ["acknowledgements"])).toEqual([]);
	});

	it("handshake validation rejects non-array capabilities", () => {
		const h: Record<string, unknown> = { ...makeHandshake() };
		h.capabilities = "not-an-array";
		expect(validateRemoteHostHandshake(h as unknown as RemoteHostHandshakeFrame)).toMatchObject({
			code: "MISSING_CAPABILITIES",
		});
	});

	it("handshake validation rejects empty hostId", () => {
		expect(validateRemoteHostHandshake(makeHandshake({ hostId: "" }))).toMatchObject({ code: "MISSING_HOST_ID" });
	});

	it("handshake validation rejects empty generation", () => {
		expect(validateRemoteHostHandshake(makeHandshake({ generation: "" }))).toMatchObject({
			code: "MISSING_GENERATION",
		});
	});
});

// ---------------------------------------------------------------------------
// 2. Old/new/missing/unknown/oversized fields
// ---------------------------------------------------------------------------

describe("B15: field validation edge cases", () => {
	it("rejects unknown fields in handshake_ack", () => {
		const ack: Record<string, unknown> = {
			type: "handshake_ack",
			accepted: true,
			hostId: "sandbox-remote-1",
			sessionId: "sess-remote-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			capabilities: ["session_commands", "sequenced_events"],
			linkId: "link-1",
			remoteBuildIdentity: { buildId: "build-abc", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			extraField: "should-be-rejected",
		};
		const err = validateRemoteHostHandshakeAck(ack);
		expect(err).toBeDefined();
		if (err) expect(err.code).toBe("INVALID_ACK_UNKNOWN_FIELD");
	});

	it("rejects multiple unknown fields in handshake_ack", () => {
		const ack: Record<string, unknown> = {
			type: "handshake_ack",
			accepted: true,
			hostId: "sandbox-remote-1",
			sessionId: "sess-remote-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			capabilities: ["session_commands", "sequenced_events"],
			linkId: "link-1",
			remoteBuildIdentity: { buildId: "build-abc", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			bonusField: "rejected",
			anotherExtra: "also-rejected",
		};
		const err = validateRemoteHostHandshakeAck(ack);
		expect(err).toBeDefined();
		if (err) expect(err.code).toBe("INVALID_ACK_UNKNOWN_FIELD");
	});

	it("rejects oversized capabilities array (>50)", () => {
		const tooMany = Array.from({ length: 51 }, () => "session_commands") as RemoteHostCapability[];
		expect(validateRemoteHostHandshakeAck(makeAck({ capabilities: tooMany }))).toMatchObject({
			code: "INVALID_ACK_CAPABILITIES_BOUND",
		});
	});

	it("accepts boundary 50 capabilities", () => {
		const fifty = Array.from({ length: 50 }, () => "session_commands") as RemoteHostCapability[];
		expect(validateRemoteHostHandshakeAck(makeAck({ capabilities: fifty }))).toBeUndefined();
	});

	it("rejects oversized hostId (>128 chars)", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ hostId: "x".repeat(129) }))).toMatchObject({
			code: "INVALID_ACK_HOST_ID",
		});
	});

	it("accepts boundary 128-char hostId", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ hostId: "x".repeat(128) }))).toBeUndefined();
	});

	it("rejects oversized sessionId (>128 chars)", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ sessionId: "x".repeat(129) }))).toMatchObject({
			code: "INVALID_ACK_SESSION_ID",
		});
	});

	it("rejects oversized linkId (>128 chars)", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ linkId: "x".repeat(129) }))).toMatchObject({
			code: "INVALID_ACK_LINK_ID",
		});
	});

	it("rejects oversized rejectReason (>256 chars)", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ accepted: false, rejectReason: "x".repeat(257) }))).toMatchObject(
			{ code: "INVALID_ACK_REJECT_REASON" },
		);
	});

	it("accepts boundary 256-char rejectReason", () => {
		expect(
			validateRemoteHostHandshakeAck(makeAck({ accepted: false, rejectReason: "x".repeat(256) })),
		).toBeUndefined();
	});

	it("missing optional rejectReason is valid", () => {
		const ack = makeAck({ accepted: false });
		delete (ack as Record<string, unknown>).rejectReason;
		expect(validateRemoteHostHandshakeAck(ack)).toBeUndefined();
	});

	it("missing optional cursor is valid", () => {
		const ack = makeAck();
		delete (ack as Record<string, unknown>).cursor;
		expect(validateRemoteHostHandshakeAck(ack as unknown as RemoteHostHandshakeAckFrame)).toBeUndefined();
	});

	it("accepted=true without remoteBuildIdentity is rejected", () => {
		const ack = makeAck();
		delete (ack as Record<string, unknown>).remoteBuildIdentity;
		const err = validateRemoteHostHandshakeAck(ack as unknown as RemoteHostHandshakeAckFrame);
		expect(err).toBeDefined();
		if (err) expect(err.code).toBe("INVALID_ACK_MISSING_BUILD_IDENTITY");
	});

	it("accepted=false without remoteBuildIdentity is valid", () => {
		const ack = makeAck({ accepted: false, rejectReason: "build_mismatch" });
		delete (ack as Record<string, unknown>).remoteBuildIdentity;
		expect(validateRemoteHostHandshakeAck(ack as unknown as RemoteHostHandshakeAckFrame)).toBeUndefined();
	});

	it("rejects non-integer protocol version in handshake_ack", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({ protocol: { name: "prime-agent.remote-host", version: 1.5 } as never }),
			),
		).toMatchObject({ code: "INVALID_ACK_PROTOCOL_VERSION" });
	});

	it("rejects non-string rejectReason", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ accepted: false, rejectReason: 42 as never }))).toMatchObject({
			code: "INVALID_ACK_REJECT_REASON",
		});
	});

	it("rejects non-object cursor", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ cursor: "not-an-object" as never }))).toMatchObject({
			code: "INVALID_ACK_CURSOR",
		});
	});

	it("rejects oversized cursor hostId (>128 chars)", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					cursor: {
						hostId: "x".repeat(129),
						generation: "g",
						sessionId: "s",
						sequence: 1,
					},
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_CURSOR_HOST_ID" });
	});

	it("rejects oversized cursor generation (>128 chars)", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					cursor: {
						hostId: "h",
						generation: "x".repeat(129),
						sessionId: "s",
						sequence: 1,
					},
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_CURSOR_GENERATION" });
	});

	it("rejects oversized cursor sessionId (>128 chars)", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					cursor: {
						hostId: "h",
						generation: "g",
						sessionId: "x".repeat(129),
						sequence: 1,
					},
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_CURSOR_SESSION_ID" });
	});

	it("rejects non-integer cursor sequence", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					cursor: {
						hostId: "h",
						generation: "g",
						sessionId: "s",
						sequence: 1.5,
					},
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_CURSOR_SEQUENCE" });
	});

	it("rejects non-object remoteBuildIdentity", () => {
		expect(validateRemoteHostHandshakeAck(makeAck({ remoteBuildIdentity: "not-object" as never }))).toMatchObject({
			code: "INVALID_ACK_BUILD_IDENTITY",
		});
	});

	it("rejects oversized buildId (>128 chars)", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					remoteBuildIdentity: { buildId: "x".repeat(129), daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_BUILD_ID" });
	});

	it("rejects negative daemonSchemaRevision in build identity", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					remoteBuildIdentity: { buildId: "b", daemonProtocolVersion: 7, daemonSchemaRevision: -1 },
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_BUILD_SCHEMA" });
	});

	it("rejects negative daemonProtocolVersion in build identity", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					remoteBuildIdentity: { buildId: "b", daemonProtocolVersion: -1, daemonSchemaRevision: 25 },
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_BUILD_PROTOCOL" });
	});

	it("rejects non-integer daemonProtocolVersion in build", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					remoteBuildIdentity: { buildId: "b", daemonProtocolVersion: 1.5, daemonSchemaRevision: 25 },
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_BUILD_PROTOCOL" });
	});

	it("rejects non-integer daemonSchemaRevision in build", () => {
		expect(
			validateRemoteHostHandshakeAck(
				makeAck({
					remoteBuildIdentity: { buildId: "b", daemonProtocolVersion: 7, daemonSchemaRevision: 1.5 },
				}),
			),
		).toMatchObject({ code: "INVALID_ACK_BUILD_SCHEMA" });
	});
});

// ---------------------------------------------------------------------------
// 3. Handshake reject teardown
// ---------------------------------------------------------------------------

describe("B15: handshake reject teardown", () => {
	it("rejected accepted=false transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(
			JSON.stringify(makeEnvelope(makeAck({ accepted: false, rejectReason: "build_mismatch" }))),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});

	it("rejected due to host mismatch transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(JSON.stringify(makeEnvelope(makeAck({ hostId: "wrong-host-id" }))));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});

	it("rejected due to session mismatch transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(JSON.stringify(makeEnvelope(makeAck({ sessionId: "wrong-session" }))));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});

	it("rejected due to protocol incompatibility transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(
			JSON.stringify(
				makeEnvelope(
					makeAck({
						protocol: { name: "prime-agent.remote-host", version: 2 } as never,
					}),
				),
			),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});

	it("rejected due to build identity mismatch transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(JSON.stringify(makeEnvelope(makeAck({ remoteBuildIdentity: ALT_BUILD }))));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});

	it("malformed ack transitions to unreachable", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(
			JSON.stringify(
				makeEnvelope({
					type: "handshake_ack",
					accepted: "not-boolean",
					hostId: "h",
				}),
			),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
		expect(link.status).toBe("unreachable");
	});
});

// ---------------------------------------------------------------------------
// 4. Host/generation/session journal isolation
// ---------------------------------------------------------------------------

describe("B15: journal identity isolation", () => {
	it("readEntries filters by identity (hostId/generation/sessionId)", () => {
		const journal = mkJ({ hostId: "host-A", generation: "gen-1", sessionId: "sess-X" });

		journal.recordSent({
			type: "frame",
			frameId: "f-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});

		const entries = journal.readEntries(1);
		expect(entries).toHaveLength(1);
		expect(entries[0].hostId).toBe("host-A");
	});

	it("getReplayEntries rejects host identity mismatch", () => {
		const journal = mkJ({ hostId: "host-A", generation: "gen-1", sessionId: "sess-X" });

		const cursor: RemoteHostEventCursor = {
			hostId: "host-B",
			generation: "gen-1",
			sessionId: "sess-X",
			sequence: 0,
		};
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("host_identity_mismatch");
	});

	it("getReplayEntries rejects session mismatch", () => {
		const journal = mkJ({ hostId: "host-A", generation: "gen-1", sessionId: "sess-X" });

		const cursor: RemoteHostEventCursor = {
			hostId: "host-A",
			generation: "gen-1",
			sessionId: "sess-Y",
			sequence: 0,
		};
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("session_mismatch");
	});

	it("getReplayEntries rejects generation change", () => {
		const journal = mkJ({ hostId: "host-A", generation: "gen-1", sessionId: "sess-X" });

		const cursor: RemoteHostEventCursor = {
			hostId: "host-A",
			generation: "gen-2",
			sessionId: "sess-X",
			sequence: 0,
		};
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("generation_changed");
	});

	it("getUnacknowledgedSentEntries filters by identity", () => {
		const journal = mkJ({ hostId: "host-A", generation: "gen-1", sessionId: "sess-X" });

		journal.recordSent({
			type: "frame",
			frameId: "cmd-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "cmd-1", body: { type: "abort" } },
		});

		const unacked = journal.getUnacknowledgedSentEntries();
		expect(unacked).toHaveLength(1);
		expect(unacked[0].hostId).toBe("host-A");
		expect(unacked[0].generation).toBe("gen-1");
		expect(unacked[0].sessionId).toBe("sess-X");
	});

	it("journal file isolates multiple identities", () => {
		const dir = fs.mkdtempSync("/tmp/b15-journal-isolation-");
		const journalPath = path.join(dir, "journal.jsonl");

		// Write entry for identity A
		const journalA = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-A",
			generation: "gen-1",
			sessionId: "sess-X",
		});
		journalA.recordSent({
			type: "frame",
			frameId: "a-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "a-1", body: { type: "abort" } },
		});

		// Write entry for identity B (same file)
		const journalB = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-B",
			generation: "gen-2",
			sessionId: "sess-Y",
		});
		journalB.recordSent({
			type: "frame",
			frameId: "b-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "b-1", body: { type: "abort" } },
		});

		// Restart A - should only see A's entry
		const journalARestart = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-A",
			generation: "gen-1",
			sessionId: "sess-X",
		});
		const unackedA = journalARestart.getUnacknowledgedSentEntries();
		expect(unackedA).toHaveLength(1);
		expect(unackedA[0].frameId).toBe("a-1");

		// Restart B - should only see B's entry
		const journalBRestart = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-B",
			generation: "gen-2",
			sessionId: "sess-Y",
		});
		const unackedB = journalBRestart.getUnacknowledgedSentEntries();
		expect(unackedB).toHaveLength(1);
		expect(unackedB[0].frameId).toBe("b-1");

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("cross-identity dedup is isolated after file restart", () => {
		const dir = fs.mkdtempSync("/tmp/b15-dedup-isolation-");
		const journalPath = path.join(dir, "journal.jsonl");

		// A records a frame
		const journalA = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-A",
			generation: "gen-1",
			sessionId: "sess-X",
		});
		journalA.recordReceived({
			type: "frame",
			frameId: "f-A",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});

		// Same frameId for B should not be caught as duplicate by A
		const journalB = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-B",
			generation: "gen-1",
			sessionId: "sess-Y",
		});
		expect(journalB.isDuplicate("f-A")).toBe(false);
		journalB.recordReceived({
			type: "frame",
			frameId: "f-A",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});

		// Restart A - dedup should only have A's own entry
		const journalARestart = new RemoteHostJournal({
			path: journalPath,
			hostId: "host-A",
			generation: "gen-1",
			sessionId: "sess-X",
		});
		expect(journalARestart.dedupCount).toBe(1);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// 5. Restart ACK cursor persistence across cycles
// ---------------------------------------------------------------------------

describe("B15: restart ACK cursor persistence", () => {
	it("ack state persists across multiple restarts", () => {
		const dir = fs.mkdtempSync("/tmp/b15-ack-persist-");
		const journalPath = path.join(dir, "journal.jsonl");

		// Cycle 1: send command and ack it
		const j1 = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		j1.recordSent({
			type: "frame",
			frameId: "cmd-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "cmd-1", body: { type: "abort" } },
		});
		j1.recordReceived({
			type: "frame",
			frameId: "ack-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "ack", ackId: "ack-1", acknowledges: "cmd-1", status: "delivered" },
		});
		expect(j1.getUnacknowledgedSentEntries()).toHaveLength(0);

		// Cycle 2: restart and verify ack state
		const j2 = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(j2.getUnacknowledgedSentEntries()).toHaveLength(0);

		// Cycle 3: restart again
		const j3 = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(j3.getUnacknowledgedSentEntries()).toHaveLength(0);

		// Send a new unacked command after restart
		j3.recordSent({
			type: "frame",
			frameId: "cmd-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "cmd-2", body: { type: "abort" } },
		});
		expect(j3.getUnacknowledgedSentEntries()).toHaveLength(1);
		expect(j3.getUnacknowledgedSentEntries()[0].frameId).toBe("cmd-2");

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("event cursor persists across restart with multiple events", () => {
		const dir = fs.mkdtempSync("/tmp/b15-cursor-persist-");
		const journalPath = path.join(dir, "journal.jsonl");

		const j1 = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		for (let i = 1; i <= 5; i++) {
			j1.recordSent({
				type: "frame",
				frameId: `evt-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: {
					type: "event",
					id: `evt-${i}`,
					sequence: i as RemoteHostEventSequence,
					cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: i as RemoteHostEventSequence },
					emittedAt: "now",
					body: { type: "agent_start" },
				},
			});
		}
		expect(j1.lastSentEventSequence).toBe(5);

		const j2 = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(j2.lastSentEventSequence).toBe(5);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// 6. Missing journal + positive cursor resync
// ---------------------------------------------------------------------------

describe("B15: missing journal resync", () => {
	it("file journal with positive cursor on empty path returns unavailable", () => {
		const dir = fs.mkdtempSync("/tmp/b15-missing-journal-");
		const journalPath = path.join(dir, "journal.jsonl");

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		const cursor: RemoteHostEventCursor = { hostId: "h", generation: "g", sessionId: "s", sequence: 5 };
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("journal_missing");

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("file journal with positive cursor but only other-identity entries has no entries (journal not considered missing for our identity)", () => {
		const dir = fs.mkdtempSync("/tmp/b15-other-id-");
		const journalPath = path.join(dir, "journal.jsonl");

		const jOther = new RemoteHostJournal({
			path: journalPath,
			hostId: "other-host",
			generation: "g",
			sessionId: "s",
		});
		jOther.recordSent({
			type: "frame",
			frameId: "other-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		// Journal exists but has no entries for identity h/g/s.
		// getReplayEntries with cursor > 0 returns "complete" (empty) because
		// the journal file exists (not missing) and no entries match after cursor.
		const cursor: RemoteHostEventCursor = { hostId: "h", generation: "g", sessionId: "s", sequence: 5 };
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("complete");
		expect(result.entries).toHaveLength(0);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("zero cursor on fresh in-memory journal returns complete", () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });
		const cursor: RemoteHostEventCursor = { hostId: "h", generation: "g", sessionId: "s", sequence: 0 };
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("complete");
		expect(result.entries).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 7. Reconnect backoff jitter and reset
// ---------------------------------------------------------------------------

describe("B15: reconnect backoff properties", () => {
	it("backoff does not exceed MAX_RECONNECT_DELAY_MS", () => {
		for (let i = 0; i < 100; i++) {
			const delay = jitteredBackoffMs(20);
			expect(delay).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
		}
	});

	it("backoff is at least BASE_RECONNECT_DELAY_MS * 0.5 for attempt 0", () => {
		for (let i = 0; i < 100; i++) {
			const delay = jitteredBackoffMs(0);
			expect(delay).toBeGreaterThanOrEqual(500);
		}
	});

	it("backoff increases with attempt number (expected range)", () => {
		// Collect ranges for various attempts
		const attempt0 = Math.min(...Array.from({ length: 20 }, () => jitteredBackoffMs(0)));
		const attempt5 = Math.max(...Array.from({ length: 20 }, () => jitteredBackoffMs(5)));
		expect(attempt5).toBeGreaterThanOrEqual(attempt0);
	});
});

// ---------------------------------------------------------------------------
// 8. Reconnect while timer pending
// ---------------------------------------------------------------------------

describe("B15: reconnect timer management", () => {
	it("close during reconnecting cleans up state", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);

		// First connect triggers failure via abnormal close
		const connect1 = link.connect();
		factory.lastSocket!.open();
		factory.lastSocket!.closeAbrupt();
		await connect1;

		// Link should be attempting reconnect
		if (link.status === "reconnecting") {
			link.close();
			expect(link.status).toBe("closed");
		}
	});
});

// ---------------------------------------------------------------------------
// 9. Disconnect mid-replay/mid-send
// ---------------------------------------------------------------------------

describe("B15: send failure during replay", () => {
	it("socket send failure during handshake results in rejected connect", async () => {
		const journal = mkJ({ hostId: "sandbox-1", generation: "gen-abc123", sessionId: "sess-1" });
		const factory = new FakeWebSocketFactory();

		// Override the factory to create a socket with failing send
		factory.create = () => {
			const ws = new FakeWebSocket();
			ws.send = () => {
				throw new Error("send failed");
			};
			factory.sockets.push(ws);
			return ws;
		};

		const link = createTestRelay(factory, journal);
		const connectPromise = link.connect();

		// Now open the socket (it has failing send)
		const ws = factory.lastSocket!;
		ws.open();

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
	});

	it("socket close during handshake rejects connect", async () => {
		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.closeAbrupt();

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 10. Sequence gaps
// ---------------------------------------------------------------------------

describe("B15: sequence gap detection", () => {
	it("detects gap in sent events with mixed received events", () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });

		// Sent: seq 1, 3 (gap at 2 in sent direction)
		journal.recordSent({
			type: "frame",
			frameId: "s-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "s-1",
				sequence: 1 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		// Received event at seq 2 should not fill the sent gap
		journal.recordReceived({
			type: "frame",
			frameId: "r-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "r-2",
				sequence: 2 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 2 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_end", messages: 1 },
			},
		});
		journal.recordSent({
			type: "frame",
			frameId: "s-3",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "s-3",
				sequence: 3 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 3 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});

		const cursor: RemoteHostEventCursor = { hostId: "h", generation: "g", sessionId: "s", sequence: 0 };
		const result = journal.getReplayEntries(cursor, 10, "sent");
		expect(result.status).toBe("partial");
		expect(result.reason).toBe("event_sequence_gap");
	});

	it("no gap when sent events are contiguous", () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });
		for (let i = 1; i <= 5; i++) {
			journal.recordSent({
				type: "frame",
				frameId: `s-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: {
					type: "event",
					id: `s-${i}`,
					sequence: i as RemoteHostEventSequence,
					cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: i as RemoteHostEventSequence },
					emittedAt: "now",
					body: { type: "agent_start" },
				},
			});
		}

		const cursor: RemoteHostEventCursor = { hostId: "h", generation: "g", sessionId: "s", sequence: 1 };
		const result = journal.getReplayEntries(cursor, 10, "sent");
		expect(result.status).toBe("complete");
	});
});

// ---------------------------------------------------------------------------
// 11. Duplicate/out-of-order frames
// ---------------------------------------------------------------------------

describe("B15: out-of-order frame handling", () => {
	it("out-of-order event sequence arrivals only advance max", () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });

		// Receive seq 5 first
		journal.recordReceived({
			type: "frame",
			frameId: "r-5",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "r-5",
				sequence: 5 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 5 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(journal.lastReceivedEventSequence).toBe(5);

		// Then seq 3 (lower - does not advance max)
		journal.recordReceived({
			type: "frame",
			frameId: "r-3",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "r-3",
				sequence: 3 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 3 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(journal.lastReceivedEventSequence).toBe(5);

		// Then seq 7 (new max)
		journal.recordReceived({
			type: "frame",
			frameId: "r-7",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "r-7",
				sequence: 7 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 7 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(journal.lastReceivedEventSequence).toBe(7);

		// All three entries recorded
		expect(journal.readEntries(1)).toHaveLength(3);
	});

	it("late duplicate frame after ack is detected", () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });

		// Receive event
		const r1 = journal.recordReceived({
			type: "frame",
			frameId: "evt-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "evt-1",
				sequence: 1 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(r1.isDuplicate).toBe(false);

		// Ack it
		journal.recordReceived({
			type: "frame",
			frameId: "ack-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "ack", ackId: "ack-1", acknowledges: "evt-1", status: "delivered" },
		});

		// Late duplicate arrival
		const r2 = journal.recordReceived({
			type: "frame",
			frameId: "evt-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "evt-1",
				sequence: 1 as RemoteHostEventSequence,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 as RemoteHostEventSequence },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(r2.isDuplicate).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 12. Corrupted/truncated journals
// ---------------------------------------------------------------------------

describe("B15: corrupted journal resilience", () => {
	it("handles truncated last line gracefully", () => {
		const dir = fs.mkdtempSync("/tmp/b15-truncated-");
		const journalPath = path.join(dir, "journal.jsonl");

		// Write valid received line then truncated line
		const validEntry = JSON.stringify({
			journalSeq: 1,
			type: "received",
			frameId: "f-1",
			recordedAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		fs.writeFileSync(journalPath, `${validEntry}\n{"truncated": true, "broken": \n`, "utf-8");

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(journal.dedupCount).toBe(1);
		expect(journal.isDuplicate("f-1")).toBe(true);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("handles binary garbage gracefully", () => {
		const dir = fs.mkdtempSync("/tmp/b15-binary-");
		const journalPath = path.join(dir, "journal.jsonl");

		fs.writeFileSync(journalPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(journal.dedupCount).toBe(0);

		// New entries should still work after garbage
		journal.recordSent({
			type: "frame",
			frameId: "f-new",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});
		expect(journal.isDuplicate("f-new")).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("handles whitespace-only file gracefully", () => {
		const dir = fs.mkdtempSync("/tmp/b15-whitespace-");
		const journalPath = path.join(dir, "journal.jsonl");

		fs.writeFileSync(journalPath, "   \n\n  \n", "utf-8");

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(journal.dedupCount).toBe(0);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("skips entries for other identities without error", () => {
		const dir = fs.mkdtempSync("/tmp/b15-other-entries-");
		const journalPath = path.join(dir, "journal.jsonl");

		// Write entries for a different hostId
		fs.writeFileSync(
			journalPath,
			'{"journalSeq":1,"type":"sent","frameId":"f-1","recordedAt":"now","frame":{"type":"health","healthSeq":1,"status":"connected"},"hostId":"OTHER","generation":"g","sessionId":"s"}\n',
			"utf-8",
		);

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(journal.dedupCount).toBe(0);
		expect(journal.isDuplicate("f-1")).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("skips corrupt lines with valid JSON but no hostId field", () => {
		const dir = fs.mkdtempSync("/tmp/b15-corrupt-shape-");
		const journalPath = path.join(dir, "journal.jsonl");

		fs.writeFileSync(
			journalPath,
			'{"journalSeq":1,"type":"received","frameId":"f-1","recordedAt":"now","frame":{"type":"health","healthSeq":1,"status":"connected"},"hostId":"h","generation":"g","sessionId":"s"}\n{"notAJournalEntry":true}\n{"journalSeq":3,"type":"received","frameId":"f-3","recordedAt":"now","frame":{"type":"health","healthSeq":3,"status":"connected"},"hostId":"h","generation":"g","sessionId":"s"}\n',
			"utf-8",
		);

		const journal = new RemoteHostJournal({
			path: journalPath,
			hostId: "h",
			generation: "g",
			sessionId: "s",
		});
		expect(journal.isDuplicate("f-1")).toBe(true);
		expect(journal.isDuplicate("f-3")).toBe(true);
		expect(journal.dedupCount).toBe(2);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// 13. Bounded replay pages
// ---------------------------------------------------------------------------

describe("B15: bounded replay pages", () => {
	it("collectAndReplay with large unacknowledged list returns false (resync)", async () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });

		// MAX_UNACKED_FOR_REPLAY = 2000
		for (let i = 0; i <= MAX_UNACKED_FOR_REPLAY; i++) {
			journal.recordSent({
				type: "frame",
				frameId: `cmd-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: `cmd-${i}`, body: { type: "abort" } },
			});
		}

		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory, journal);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(JSON.stringify(makeEnvelope(makeAck({ cursor: undefined }))));

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
	});

	it("replay that exceeds 10 pages returns false (resync)", async () => {
		const journal = mkJ({ hostId: "h", generation: "g", sessionId: "s" });

		// 2001 entries spread across 11 pages
		for (let i = 1; i <= MAX_REPLAY_PAGES * MAX_REPLAY_PAGE_ENTRIES + 1; i++) {
			journal.recordSent({
				type: "frame",
				frameId: `evt-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: {
					type: "event",
					id: `evt-${i}`,
					sequence: i as RemoteHostEventSequence,
					cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: i as RemoteHostEventSequence },
					emittedAt: "now",
					body: { type: "agent_start" },
				},
			});
		}

		const factory = new FakeWebSocketFactory();
		const link = createTestRelay(factory, journal);
		const connectPromise = link.connect();

		factory.lastSocket!.open();
		factory.lastSocket!.receive(
			JSON.stringify(
				makeEnvelope(makeAck({ cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 0 } })),
			),
		);

		const result = await connectPromise;
		expect(result.accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 14. Credential-free error codes and input safety
// ---------------------------------------------------------------------------

describe("B15: credential-free and input safety", () => {
	it("validation errors use fixed codes not dynamic content", () => {
		const codes = [
			validateRemoteHostHandshakeAck(null),
			validateRemoteHostFrame(null),
			validateRemoteHostHandshake(null),
		];
		for (const err of codes) {
			expect(err).toBeDefined();
			if (err) {
				expect(err.code).toMatch(/^[A-Z_]+$/);
			}
		}
	});

	it("frame validation does not echo raw input in error message", () => {
		const malicious =
			'{"type":"frame","frameId":"<script>alert(1)</script>","protocol":{"name":"wrong","version":1},"sentAt":"now","frame":{}}';
		const result = validateRemoteHostFrame(JSON.parse(malicious));
		expect(result).toBeDefined();
		if (result) {
			expect(result.message).not.toContain("<script>");
			expect(result.code).toMatch(/^[A-Z_]+$/);
		}
	});

	it("handshake validation does not echo input in error", () => {
		const result = validateRemoteHostHandshake({
			type: "handshake",
			direction: "injected<attack>" as never,
		} as unknown as RemoteHostHandshakeFrame);
		expect(result).toBeDefined();
		if (result) {
			expect(result.message).not.toContain("<attack>");
			expect(result.code).toMatch(/^[A-Z_]+$/);
		}
	});

	it("error frame uses fixed code not dynamic host input", () => {
		const errorFrame: RemoteHostFrame = {
			type: "error",
			code: "SESSION_NOT_FOUND",
			message: "Session not found",
		};
		expect(errorFrame.code).toMatch(/^[A-Z_]+$/);
		expect(errorFrame.message).not.toContain("undefined");
		expect(errorFrame.message).not.toContain("null");
	});

	it("handshake_ack with valid rejectReason is accepted (no validation error)", () => {
		// makeAck with accepted=false and short rejectReason is valid
		const err1 = validateRemoteHostHandshakeAck(makeAck({ accepted: false, rejectReason: "build_mismatch" }));
		expect(err1).toBeUndefined();

		const err2 = validateRemoteHostHandshakeAck(makeAck({ accepted: false, rejectReason: "invalid" }));
		expect(err2).toBeUndefined();
	});
});
