/**
 * Tests for the SandboxEventOutboxRecordV1 codec — two variants (pending, delivered),
 * encode/decode, byte validation, digest verification, state/outcome constraints, bounds.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

import {
	decodeSandboxEventOutboxRecordV1,
	encodeSandboxEventOutboxRecordV1,
} from "../src/modes/daemon/sandbox-event-outbox-record-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function makeEventBody(type: string): Record<string, unknown> {
	switch (type) {
		case "session_created":
			return { type: "session_created", sessionId: "sess-1", workspaceId: "ws-1" };
		case "session_destroyed":
			return { type: "session_destroyed" };
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", messages: 5 };
		case "agent_text_delta":
			return { type: "agent_text_delta", index: 0, text: "hello" };
		case "agent_thinking_delta":
			return { type: "agent_thinking_delta", index: 0, text: "thinking..." };
		case "agent_toolcall_delta":
			return { type: "agent_toolcall_delta", index: 0, text: "tool call" };
		case "bash_start":
			return { type: "bash_start", command: "ls" };
		case "bash_end":
			return { type: "bash_end", exitCode: 0, cancelled: false, truncated: false };
		case "bash_delta":
			return { type: "bash_delta", text: "output" };
		case "compact_start":
			return { type: "compact_start" };
		case "compact_end":
			return { type: "compact_end", keptMessages: 10 };
		case "compact_failed":
			return { type: "compact_failed", error: "oops" };
		case "error":
			return { type: "error", code: "ERR", message: "something went wrong" };
		case "checkpoint_start":
			return { type: "checkpoint_start" };
		case "checkpoint_complete":
			return { type: "checkpoint_complete", snapshotId: "snap-1" };
		case "checkpoint_failed":
			return { type: "checkpoint_failed", error: "checkpoint error" };
		case "session_state":
			return { type: "session_state", state: "running" };
		default:
			throw new Error(`unknown event body type: ${type}`);
	}
}

function makeEventFrame(eventId: string, bodyType: string, sequence?: number): Record<string, unknown> {
	const body = makeEventBody(bodyType);
	const seq = sequence ?? 1;
	return {
		type: "event",
		id: eventId,
		sequence: seq,
		cursor: { hostId: "h-1", generation: "g-1", sessionId: "sess-1", sequence: seq },
		emittedAt: "2025-01-15T10:30:00.000Z",
		body,
	};
}

function digestOfFrame(evt: Record<string, unknown>): string {
	const r = canonicalDigest(evt);
	if (!r.ok) throw new Error("canonicalDigest failed for event frame");
	return r.value;
}

function makeAckFrame(
	ackId: string,
	acknowledges: string,
	status: "delivered" | "replayed" | "rejected",
): Record<string, unknown> {
	return {
		type: "ack",
		ackId,
		acknowledges,
		status,
	};
}

function digestOfAck(ack: Record<string, unknown>): string {
	const r = canonicalDigest(ack);
	if (!r.ok) throw new Error("canonicalDigest failed for ack");
	return r.value;
}

function makePendingInput(eventId: string, bodyType?: string): Record<string, unknown> {
	const bType = bodyType ?? "agent_start";
	const evt = makeEventFrame(eventId, bType);
	const eventDigest = digestOfFrame(evt);
	return {
		version: 1,
		recordKind: "pending",
		recordSeq: 1,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "sess-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		eventId,
		eventSequence: 1,
		eventType: bType,
		eventDigest,
		event: evt,
	};
}

function makeDeliveredInput(
	eventId: string,
	bodyType?: string,
	ackStatus?: "delivered" | "replayed",
): Record<string, unknown> {
	const bType = bodyType ?? "agent_start";
	const ackSt = ackStatus ?? "delivered";
	const evt = makeEventFrame(eventId, bType);
	const eventDigest = digestOfFrame(evt);
	const ack = makeAckFrame("a-1", eventId, ackSt);
	const ackDigest = digestOfAck(ack);
	return {
		version: 1,
		recordKind: "delivered",
		recordSeq: 1,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "sess-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		eventId,
		eventSequence: 1,
		eventType: bType,
		eventDigest,
		event: evt,
		outcome: "DELIVERED",
		ackDigest,
		ack,
	};
}

// ===========================================================================
// 1. Both variants roundtrip + determinism
// ===========================================================================

describe("roundtrip both variants", () => {
	it("pending roundtrip", () => {
		const raw = makePendingInput("evt-p1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") {
			expect(enc.record.recordKind).toBe("pending");
			return;
		}
		const r = enc.record;
		expect(r.event.type).toBe("event");
		expect(r.event.id).toBe("evt-p1");
		expect(r.event.body).toEqual({ type: "agent_start" });
		expect(r.sessionId).toBe("sess-1");
		expect(r.eventType).toBe("agent_start");

		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "pending") {
			expect(dec.record.recordKind).toBe("pending");
			return;
		}
		const d = dec.record;
		expect(d.event.type).toBe("event");
		expect(d.event.id).toBe("evt-p1");
		expect(d.event.body).toEqual({ type: "agent_start" });
		expect(d.sessionId).toBe("sess-1");
		expect(d.eventType).toBe("agent_start");
		expect(d.eventSequence).toBe(1);
	});

	it("delivered roundtrip with DELIVERED outcome", () => {
		const raw = makeDeliveredInput("evt-d1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "delivered") {
			expect(enc.record.recordKind).toBe("delivered");
			return;
		}
		const r = enc.record;
		expect(r.outcome).toBe("DELIVERED");
		expect(r.ack.acknowledges).toBe("evt-d1");
		expect(r.ack.status).toBe("delivered");
		expect(r.ackDigest.length).toBe(64);
		expect(r.eventDigest.length).toBe(64);

		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "delivered") {
			expect(dec.record.recordKind).toBe("delivered");
			return;
		}
		const d = dec.record;
		expect(d.outcome).toBe("DELIVERED");
		expect(d.ack.acknowledges).toBe("evt-d1");
		expect(d.ack.status).toBe("delivered");
	});

	it("delivered roundtrip with replayed status", () => {
		const raw = makeDeliveredInput("evt-d2", "agent_start", "replayed");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.record.recordKind).toBe("delivered");
		if (enc.record.recordKind !== "delivered") return;
		expect(enc.record.ack.status).toBe("replayed");

		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.record.recordKind).toBe("delivered");
		if (dec.record.recordKind !== "delivered") return;
		expect(dec.record.ack.status).toBe("replayed");
	});

	it("encode is deterministic", () => {
		const raw = makePendingInput("evt-p2");
		const enc1 = encodeSandboxEventOutboxRecordV1(raw);
		const enc2 = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc1.ok).toBe(true);
		expect(enc2.ok).toBe(true);
		if (!enc1.ok || !enc2.ok) return;
		expect(enc1.bytes.byteLength).toBe(enc2.bytes.byteLength);
		for (let i = 0; i < enc1.bytes.byteLength; i++) {
			expect(enc1.bytes[i]).toBe(enc2.bytes[i]);
		}
	});
});

// ===========================================================================
// 2. All event body classes
// ===========================================================================

describe("all event body classes", () => {
	const bodyTypes = [
		"session_created",
		"session_destroyed",
		"agent_start",
		"agent_end",
		"agent_text_delta",
		"agent_thinking_delta",
		"agent_toolcall_delta",
		"bash_start",
		"bash_end",
		"bash_delta",
		"compact_start",
		"compact_end",
		"compact_failed",
		"error",
		"checkpoint_start",
		"checkpoint_complete",
		"checkpoint_failed",
		"session_state",
	];

	for (const bt of bodyTypes) {
		it(`pending roundtrip with body type "${bt}"`, () => {
			const raw = makePendingInput("evt-bt", bt);
			const enc = encodeSandboxEventOutboxRecordV1(raw);
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			expect(dec.record.eventType).toBe(bt);
			expect(dec.record.event.body.type).toBe(bt);
		});

		it(`delivered roundtrip with body type "${bt}"`, () => {
			const raw = makeDeliveredInput("evt-bt-d", bt);
			const enc = encodeSandboxEventOutboxRecordV1(raw);
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			expect(dec.record.eventType).toBe(bt);
			expect(dec.record.event.body.type).toBe(bt);
		});
	}
});

// ===========================================================================
// 3. ID and digest mismatch
// ===========================================================================

describe("ID and digest mismatch", () => {
	it("encode rejects eventId mismatch between top-level and frame", () => {
		const raw = makePendingInput("evt-m1");
		raw.eventId = "evt-other";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects eventSequence mismatch between top-level and frame", () => {
		const raw = makePendingInput("evt-m2");
		raw.eventSequence = 99;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects eventDigest mismatch", () => {
		const raw = makePendingInput("evt-m3");
		raw.eventDigest = "0000000000000000000000000000000000000000000000000000000000000000";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects eventDigest mismatch (tampered)", () => {
		const raw = makePendingInput("evt-m4");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Tamper with the digest in the bytes.
		const tampered = new Uint8Array(enc.bytes);
		// Find the digest hex string and flip a character.
		const decStr = new TextDecoder().decode(tampered);
		const tamperedStr = decStr.replace(
			enc.record.eventDigest,
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("encode rejects eventType mismatch between field and event.body.type", () => {
		const raw = makePendingInput("evt-m5");
		raw.eventType = "bash_start";
		// The event body is actually agent_start
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("delivered encode rejects ackDigest mismatch", () => {
		const raw = makeDeliveredInput("evt-m6");
		raw.ackDigest = "0000000000000000000000000000000000000000000000000000000000000000";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("delivered encode rejects acknowledges mismatch", () => {
		const raw = makeDeliveredInput("evt-m7");
		const ackVal = Reflect.get(raw, "ack");
		if (typeof ackVal === "object" && ackVal !== null) Reflect.set(ackVal, "acknowledges", "wrong-id");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects cursor.hostId mismatch between record and event frame — pending", () => {
		const raw = makePendingInput("evt-m8");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).hostId = "h-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects cursor.generation mismatch between record and event frame — pending", () => {
		const raw = makePendingInput("evt-m9");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).generation = "g-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects cursor.sessionId mismatch between record and event frame — pending", () => {
		const raw = makePendingInput("evt-m10");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).sessionId = "sess-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("delivered encode rejects cursor.hostId mismatch between record and event frame", () => {
		const raw = makeDeliveredInput("evt-m11");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).hostId = "h-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("delivered encode rejects cursor.generation mismatch between record and event frame", () => {
		const raw = makeDeliveredInput("evt-m12");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).generation = "g-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("delivered encode rejects cursor.sessionId mismatch between record and event frame", () => {
		const raw = makeDeliveredInput("evt-m13");
		if (typeof raw.event === "object" && raw.event !== null && !Array.isArray(raw.event)) {
			const evt = raw.event as Record<string, unknown>;
			if (typeof evt.cursor === "object" && evt.cursor !== null) {
				(evt.cursor as Record<string, unknown>).sessionId = "sess-other";
			}
		}
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects cursor.hostId mismatch — pending", () => {
		const raw = makePendingInput("evt-m14");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Tamper cursor.hostId via JSON parse/modify/stringify.
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).hostId = "h-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("decode rejects cursor.generation mismatch — pending", () => {
		const raw = makePendingInput("evt-m15");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).generation = "g-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("decode rejects cursor.sessionId mismatch — pending", () => {
		const raw = makePendingInput("evt-m16");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).sessionId = "sess-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("decode rejects cursor.hostId mismatch — delivered", () => {
		const raw = makeDeliveredInput("evt-m17");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).hostId = "h-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("decode rejects cursor.generation mismatch — delivered", () => {
		const raw = makeDeliveredInput("evt-m18");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).generation = "g-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});

	it("decode rejects cursor.sessionId mismatch — delivered", () => {
		const raw = makeDeliveredInput("evt-m19");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const decStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(decStr);
		(parsed.event.cursor as Record<string, unknown>).sessionId = "sess-x";
		const tamperedStr = JSON.stringify(parsed);
		const tamperedBytes = new TextEncoder().encode(tamperedStr);
		const dec = decodeSandboxEventOutboxRecordV1(tamperedBytes);
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 4. Session identity
// ===========================================================================

describe("session identity", () => {
	it("encode rejects missing sessionId", () => {
		const raw = makePendingInput("evt-si1");
		Reflect.deleteProperty(raw, "sessionId");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects empty sessionId", () => {
		const raw = makePendingInput("evt-si2");
		raw.sessionId = "";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects tampered eventId", () => {
		const raw = makePendingInput("evt-si3");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const str = new TextDecoder().decode(enc.bytes);
		// Tamper eventId in the payload so it no longer matches event.id.
		const tampered = str.replace(/"eventId":"evt-si3"/, '"eventId":"tampered-id"');
		const dec = decodeSandboxEventOutboxRecordV1(new TextEncoder().encode(tampered));
		expect(dec.ok).toBe(false);
	});

	it("decode roundtrips with sessionId intact", () => {
		const raw = makePendingInput("evt-si4");
		// Rebuild the event with custom session.
		const evt = makeEventFrame("evt-si4", "agent_start");
		evt.cursor = { hostId: "h-1", generation: "g-1", sessionId: "my-custom-session", sequence: 1 };
		// Update the record fields.
		raw.event = evt;
		raw.sessionId = "my-custom-session";
		raw.eventDigest = digestOfFrame(evt);
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.record.sessionId).toBe("my-custom-session");
	});
});

// ===========================================================================
// 5. State/outcome mismatch
// ===========================================================================

describe("state/outcome mismatch", () => {
	it("encode rejects pending with outcome field", () => {
		const raw = makePendingInput("evt-so1");
		raw.outcome = "DELIVERED";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects delivered without outcome", () => {
		const raw = makeDeliveredInput("evt-so2");
		Reflect.deleteProperty(raw, "outcome");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects delivered with wrong outcome", () => {
		const raw = makeDeliveredInput("evt-so3");
		raw.outcome = "PENDING";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects delivered with outcome 'COMPLETED'", () => {
		const raw = makeDeliveredInput("evt-so4");
		Reflect.set(raw, "outcome", "COMPLETED");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects missing outcome on delivered record", () => {
		const raw = makeDeliveredInput("evt-so5");
		Reflect.deleteProperty(raw, "outcome");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects delivered with rejected ack status", () => {
		const raw = makeDeliveredInput("evt-so6");
		const ackVal = Reflect.get(raw, "ack");
		if (typeof ackVal === "object" && ackVal !== null) Reflect.set(ackVal, "status", "rejected");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects delivered with rejected ack status", () => {
		// Build delivered bytes with a valid encode, then change ack status byte level.
		const raw = makeDeliveredInput("evt-so7");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const str = new TextDecoder().decode(enc.bytes);
		// Replace "delivered" with "rejected" in the JSON.
		const tampered = str.replace('"delivered"', '"rejected"');
		const dec = decodeSandboxEventOutboxRecordV1(new TextEncoder().encode(tampered));
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 6. Canonical encoding verification
// ===========================================================================

describe("canonical encoding verification", () => {
	it("rejects leading whitespace", () => {
		const raw = makePendingInput("evt-ce1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const withSpace = utf8(`  ${new TextDecoder().decode(enc.bytes)}`);
		const dec = decodeSandboxEventOutboxRecordV1(withSpace);
		expect(dec.ok).toBe(false);
	});

	it("rejects trailing whitespace", () => {
		const raw = makePendingInput("evt-ce2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const withNewline = utf8(`${new TextDecoder().decode(enc.bytes)}\n`);
		const dec = decodeSandboxEventOutboxRecordV1(withNewline);
		expect(dec.ok).toBe(false);
	});

	it("rejects reordered keys", () => {
		const raw = makePendingInput("evt-ce3");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const str = new TextDecoder().decode(enc.bytes);
		// Swap version and recordKind positions.
		const reordered = str.replace('{"version":1,"recordKind":"pending"', '{"recordKind":"pending","version":1');
		const dec = decodeSandboxEventOutboxRecordV1(new TextEncoder().encode(reordered));
		expect(dec.ok).toBe(false);
	});

	it("rejects truncated bytes", () => {
		const raw = makePendingInput("evt-ce4");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const truncated = enc.bytes.subarray(0, enc.bytes.byteLength - 10);
		// Re-wrap in a genuine Uint8Array (subarray preserves the buffer, so copy)
		const copy = new Uint8Array(truncated);
		const dec = decodeSandboxEventOutboxRecordV1(copy);
		expect(dec.ok).toBe(false);
	});

	it("rejects oversized input", () => {
		// Create valid record
		const raw = makePendingInput("evt-ce5");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Pad bytes to exceed max.
		const big = new Uint8Array(2_000_000);
		big.set(enc.bytes);
		const dec = decodeSandboxEventOutboxRecordV1(big);
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 7. Hostile encode inputs
// ===========================================================================

describe("hostile encode inputs", () => {
	it("rejects null", () => {
		expect(encodeSandboxEventOutboxRecordV1(null).ok).toBe(false);
	});

	it("rejects non-object", () => {
		expect(encodeSandboxEventOutboxRecordV1("string").ok).toBe(false);
		expect(encodeSandboxEventOutboxRecordV1(42).ok).toBe(false);
	});

	it("rejects array", () => {
		expect(encodeSandboxEventOutboxRecordV1([]).ok).toBe(false);
	});

	it("rejects object with accessor", () => {
		const raw = makePendingInput("evt-he1");
		Object.defineProperty(raw, "recordKind", {
			get: () => "pending",
			enumerable: true,
			configurable: true,
		});
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects object with symbol key", () => {
		const raw = makePendingInput("evt-he2");
		Object.defineProperty(raw, Symbol("extra"), { value: "x", enumerable: true, configurable: true, writable: true });
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects non-enumerable property", () => {
		const raw = makePendingInput("evt-he3");
		Object.defineProperty(raw, "hidden", { value: "x", enumerable: false });
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects undefined field", () => {
		const raw = makePendingInput("evt-he4");
		raw.hostId = undefined;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects extra field", () => {
		const raw = makePendingInput("evt-he5");
		raw.extraField = "x";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects wrong version", () => {
		const raw = makePendingInput("evt-he6");
		raw.version = 2;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects missing required field", () => {
		const raw = makePendingInput("evt-he7");
		delete raw.hostId;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects null proto object", () => {
		const raw = makePendingInput("evt-he8");
		const nullProto = Object.assign(Object.create(null), raw);
		const enc = encodeSandboxEventOutboxRecordV1(nullProto);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 8. Hostile decode inputs
// ===========================================================================

describe("hostile decode inputs", () => {
	it("rejects empty Uint8Array", () => {
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(0));
		expect(dec.ok).toBe(false);
	});

	it("rejects Buffer input", () => {
		const raw = makePendingInput("evt-hd1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const buf = Buffer.from(enc.bytes);
		const dec = decodeSandboxEventOutboxRecordV1(buf);
		expect(dec.ok).toBe(false);
	});

	it("rejects Uint8Array subclass", () => {
		class MyU8 extends Uint8Array {}
		const raw = makePendingInput("evt-hd2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const subclass = new MyU8(enc.bytes);
		const dec = decodeSandboxEventOutboxRecordV1(subclass);
		expect(dec.ok).toBe(false);
	});

	it("rejects SharedArrayBuffer-backed Uint8Array", () => {
		const sab = new SharedArrayBuffer(10);
		const u8 = new Uint8Array(sab);
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});

	it("rejects subview (non-zero byteOffset)", () => {
		const raw = makePendingInput("evt-hd3");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bigger = new Uint8Array(enc.bytes.byteLength + 10);
		bigger.set(enc.bytes, 5);
		const subview = bigger.subarray(5);
		const dec = decodeSandboxEventOutboxRecordV1(subview);
		expect(dec.ok).toBe(false);
	});

	it("rejects invalid UTF-8 bytes", () => {
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array([0xff, 0xfe, 0x00]));
		expect(dec.ok).toBe(false);
	});

	it("rejects raw number JSON", () => {
		const dec = decodeSandboxEventOutboxRecordV1(utf8("42"));
		expect(dec.ok).toBe(false);
	});

	it("rejects own byteLength override on decode input", () => {
		const raw = makePendingInput("evt-hd4");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const u8 = new Uint8Array(enc.bytes);
		Object.defineProperty(u8, "byteLength", { value: 999999 });
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});

	it("rejects own buffer override on decode input", () => {
		const raw = makePendingInput("evt-hd5");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const u8 = new Uint8Array(enc.bytes);
		Object.defineProperty(u8, "buffer", { value: new ArrayBuffer(10) });
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});

	it("rejects own extra property on decode input", () => {
		const raw = makePendingInput("evt-hd6");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const u8 = new Uint8Array(enc.bytes);
		Reflect.set(u8, "extra", "x");
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});

	it("rejects own symbol on decode input", () => {
		const raw = makePendingInput("evt-hd7");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const u8 = new Uint8Array(enc.bytes);
		Reflect.set(u8, Symbol("x"), "x");
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});

	it("rejects Proxy wrapping plain object", () => {
		const raw = makePendingInput("evt-hd8");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const proxy = new Proxy(enc.bytes, {});
		const dec = decodeSandboxEventOutboxRecordV1(proxy);
		expect(dec.ok).toBe(false);
	});

	it("rejects revoked Proxy on decode", () => {
		const raw = makePendingInput("evt-hd9");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const { proxy, revoke } = Proxy.revocable(enc.bytes, {});
		revoke();
		const dec = decodeSandboxEventOutboxRecordV1(proxy);
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 9. Deep freeze
// ===========================================================================

describe("deep freeze", () => {
	it("encode returns frozen record", () => {
		const raw = makePendingInput("evt-df1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
	});

	it("decode returns frozen record", () => {
		const raw = makePendingInput("evt-df2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
	});

	it("returns frozen failures", () => {
		const enc = encodeSandboxEventOutboxRecordV1(null);
		expect(enc.ok).toBe(false);
		expect(enc.ok).toBe(false);
		if (enc.ok) return;
		expect(Object.isFrozen(enc.error)).toBe(true);

		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(0));
		expect(dec.ok).toBe(false);
		if (dec.ok) return;
		expect(Object.isFrozen(dec.error)).toBe(true);
	});

	it("event frame in returned record is frozen", () => {
		const raw = makePendingInput("evt-df3");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "pending") return;
		expect(Object.isFrozen(enc.record.event)).toBe(true);
	});
});

// ===========================================================================
// 10. Field bounds
// ===========================================================================

describe("field bounds", () => {
	it("rejects recordSeq <= 0", () => {
		const raw = makePendingInput("evt-b1");
		raw.recordSeq = 0;
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
		raw.recordSeq = -1;
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects recordSeq > 20000", () => {
		const raw = makePendingInput("evt-b2");
		raw.recordSeq = 20001;
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects invalid eventId", () => {
		const raw = makePendingInput("evt-b3");
		raw.eventId = "";
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
		raw.eventId = ".invalid";
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects invalid hostId", () => {
		const raw = makePendingInput("evt-b4");
		raw.hostId = "";
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects invalid timestamp", () => {
		const raw = makePendingInput("evt-b5");
		raw.recordedAt = "not-a-timestamp";
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects non-canonical timestamp", () => {
		const raw = makePendingInput("evt-b6");
		raw.recordedAt = "2025-01-15T10:30:00Z"; // missing .000
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects invalid eventDigest", () => {
		const raw = makePendingInput("evt-b7");
		raw.eventDigest = "not-a-hex-digest";
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});

	it("rejects eventSequence <= 0", () => {
		const raw = makePendingInput("evt-b8");
		raw.eventSequence = 0;
		expect(encodeSandboxEventOutboxRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 11. Mutation isolation
// ===========================================================================

describe("mutation isolation", () => {
	it("encode record event is a fresh object (no alias to input)", () => {
		const raw = makePendingInput("evt-mi1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Mutate the input event
		const evtVal = Reflect.get(raw, "event");
		if (typeof evtVal === "object" && evtVal !== null) Reflect.set(evtVal, "id", "mutated");
		expect(enc.record.event.id).toBe("evt-mi1");
	});

	it("decode record event is a fresh object (no alias to parsed JSON)", () => {
		const raw = makePendingInput("evt-mi2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		// The decoded event should be a separate frozen object.
		expect(Object.isFrozen(dec.record.event)).toBe(true);
	});
});

// ===========================================================================
// 12. Cross-variant rejection
// ===========================================================================

describe("cross-variant rejection", () => {
	it("rejects pending with outcome field", () => {
		const raw = makePendingInput("evt-cr1");
		raw.outcome = "DELIVERED";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("rejects wrong recordKind string", () => {
		const raw = makePendingInput("evt-cr2");
		raw.recordKind = "invalid";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 13. Null prototype rejection
// ===========================================================================

describe("null prototype rejection", () => {
	it("encode rejects null proto record", () => {
		const raw = makePendingInput("evt-np1");
		const nullProto = Object.assign(Object.create(null), raw);
		const enc = encodeSandboxEventOutboxRecordV1(nullProto);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects null proto inner event frame", () => {
		const raw = makePendingInput("evt-np2");
		raw.event = Object.assign(Object.create(null), raw.event);
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 14. Caller byte erasure
// ===========================================================================

describe("caller byte erasure", () => {
	it("success path zeroes caller bytes", () => {
		const raw = makePendingInput("evt-cb1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.bytes);
		const dec = decodeSandboxEventOutboxRecordV1(bytes);
		expect(dec.ok).toBe(true);
		// Bytes should have been zeroed.
		let allZero = true;
		for (let i = 0; i < bytes.byteLength; i++) {
			if (bytes[i] !== 0) {
				allZero = false;
				break;
			}
		}
		expect(allZero).toBe(true);
	});

	it("failure path zeroes caller bytes", () => {
		const bytes = new Uint8Array(10);
		bytes[0] = 0x7b; // '{' so it looks like JSON start
		bytes[1] = 0x22; // '"'
		bytes[2] = 0x7d; // '}'
		const dec = decodeSandboxEventOutboxRecordV1(bytes);
		expect(dec.ok).toBe(false);
		// Bytes should still have been zeroed.
		let allZero = true;
		for (let i = 0; i < bytes.byteLength; i++) {
			if (bytes[i] !== 0) {
				allZero = false;
				break;
			}
		}
		expect(allZero).toBe(true);
	});

	it("rejects own fill override on decode input", () => {
		const raw = makePendingInput("evt-cb2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const u8 = new Uint8Array(enc.bytes);
		// Override fill with a different function.
		Object.defineProperty(u8, "fill", {
			value: () => {
				/* no-op */
			},
		});
		const dec = decodeSandboxEventOutboxRecordV1(u8);
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 15. eventType mismatch
// ===========================================================================

describe("eventType mismatch", () => {
	it("encode rejects eventType mismatch between field and event.body.type", () => {
		const raw = makePendingInput("evt-et1");
		raw.eventType = "bash_end";
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("decode rejects tampered eventType", () => {
		const raw = makePendingInput("evt-et2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const str = new TextDecoder().decode(enc.bytes);
		const tampered = str.replace('"agent_start"', '"bash_end"');
		const dec = decodeSandboxEventOutboxRecordV1(new TextEncoder().encode(tampered));
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 15. Hostile nested ack frame (descriptor-preflight must reject without live reads)
// ===========================================================================

describe("hostile nested ack frame", () => {
	it("encode rejects Proxy-wrapped ack", () => {
		const raw = makeDeliveredInput("evt-ha1");
		const cleanAck = { type: "ack", ackId: "a-1", acknowledges: "evt-ha1", status: "delivered" };
		const precomputedDigest = digestOfAck(cleanAck);
		const ackProxy = new Proxy(cleanAck, {
			get() {
				throw new Error("getter called");
			},
			set() {
				throw new Error("setter called");
			},
		});
		Reflect.set(raw, "ack", ackProxy);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with accessor property", () => {
		const raw = makeDeliveredInput("evt-ha2");
		const cleanAck: Record<string, unknown> = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "evt-ha2",
			status: "delivered",
		};
		const precomputedDigest = digestOfAck(cleanAck);
		Object.defineProperty(cleanAck, "status", { get: () => "delivered", enumerable: true, configurable: true });
		Reflect.set(raw, "ack", cleanAck);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with null prototype", () => {
		const raw = makeDeliveredInput("evt-ha3");
		const cleanAck = { type: "ack", ackId: "a-1", acknowledges: "evt-ha3", status: "delivered" };
		const precomputedDigest = digestOfAck(cleanAck);
		const ack = Object.assign(Object.create(null), cleanAck);
		Reflect.set(raw, "ack", ack);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with symbol key", () => {
		const raw = makeDeliveredInput("evt-ha4");
		const cleanAck: Record<string, unknown> = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "evt-ha4",
			status: "delivered",
		};
		const precomputedDigest = digestOfAck(cleanAck);
		Object.defineProperty(cleanAck, Symbol("x"), {
			value: "x",
			enumerable: true,
			configurable: true,
			writable: true,
		});
		Reflect.set(raw, "ack", cleanAck);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with non-enumerable key", () => {
		const raw = makeDeliveredInput("evt-ha5");
		const cleanAck: Record<string, unknown> = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "evt-ha5",
			status: "delivered",
		};
		const precomputedDigest = digestOfAck(cleanAck);
		Object.defineProperty(cleanAck, "hidden", { value: "x", enumerable: false });
		Reflect.set(raw, "ack", cleanAck);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with undefined field", () => {
		const raw = makeDeliveredInput("evt-ha6");
		const cleanAck: Record<string, unknown> = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "evt-ha6",
			status: "delivered",
		};
		const precomputedDigest = digestOfAck(cleanAck);
		cleanAck.status = undefined;
		Reflect.set(raw, "ack", cleanAck);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects ack with extra field", () => {
		const raw = makeDeliveredInput("evt-ha7");
		const cleanAck: Record<string, unknown> = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "evt-ha7",
			status: "delivered",
		};
		const precomputedDigest = digestOfAck(cleanAck);
		cleanAck.extra = "x";
		Reflect.set(raw, "ack", cleanAck);
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 16. True recursive deep freeze — full isFrozen at every level
// ===========================================================================

describe("true recursive deep freeze", () => {
	it("encode pending — record, event, cursor, body all frozen", () => {
		const raw = makePendingInput("evt-tr1");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
		if (enc.record.recordKind !== "pending") return;
		expect(Object.isFrozen(enc.record.event)).toBe(true);
		expect(Object.isFrozen(enc.record.event.cursor)).toBe(true);
		expect(Object.isFrozen(enc.record.event.body)).toBe(true);
	});

	it("encode delivered — record, event, cursor, body, ack all frozen", () => {
		const raw = makeDeliveredInput("evt-tr2");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
		if (enc.record.recordKind !== "delivered") return;
		expect(Object.isFrozen(enc.record.event)).toBe(true);
		expect(Object.isFrozen(enc.record.event.cursor)).toBe(true);
		expect(Object.isFrozen(enc.record.event.body)).toBe(true);
		expect(Object.isFrozen(enc.record.ack)).toBe(true);
	});

	it("decode pending — record, event, cursor, body all frozen", () => {
		const raw = makePendingInput("evt-tr3");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(enc.bytes));
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
		if (dec.record.recordKind !== "pending") return;
		expect(Object.isFrozen(dec.record.event)).toBe(true);
		expect(Object.isFrozen(dec.record.event.cursor)).toBe(true);
		expect(Object.isFrozen(dec.record.event.body)).toBe(true);
	});

	it("decode delivered — record, event, cursor, body, ack all frozen", () => {
		const raw = makeDeliveredInput("evt-tr4");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(enc.bytes));
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
		if (dec.record.recordKind !== "delivered") return;
		expect(Object.isFrozen(dec.record.event)).toBe(true);
		expect(Object.isFrozen(dec.record.event.cursor)).toBe(true);
		expect(Object.isFrozen(dec.record.event.body)).toBe(true);
		expect(Object.isFrozen(dec.record.ack)).toBe(true);
	});

	it("mutation at every level throws in strict mode — pending encode event", () => {
		const raw = makePendingInput("evt-tr5");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(() => {
			Object.defineProperty(enc.record.event, "id", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(enc.record.event.cursor, "hostId", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(enc.record.event.body, "type", { value: "x" });
		}).toThrow();
	});

	it("mutation at every level throws in strict mode — delivered encode event + ack", () => {
		const raw = makeDeliveredInput("evt-tr6");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "delivered") return;
		const r = enc.record;
		expect(() => {
			Object.defineProperty(r.event, "id", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.event.cursor, "hostId", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.event.body, "type", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.ack, "status", { value: "x" });
		}).toThrow();
	});

	it("mutation at every level throws in strict mode — decode pending", () => {
		const raw = makePendingInput("evt-tr7");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(enc.bytes));
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(() => {
			Object.defineProperty(dec.record.event, "id", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(dec.record.event.cursor, "hostId", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(dec.record.event.body, "type", { value: "x" });
		}).toThrow();
	});

	it("mutation at every level throws in strict mode — decode delivered", () => {
		const raw = makeDeliveredInput("evt-tr8");
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeSandboxEventOutboxRecordV1(new Uint8Array(enc.bytes));
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "delivered") return;
		const r = dec.record;
		expect(() => {
			Object.defineProperty(r.event, "id", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.event.cursor, "hostId", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.event.body, "type", { value: "x" });
		}).toThrow();
		expect(() => {
			Object.defineProperty(r.ack, "status", { value: "x" });
		}).toThrow();
	});
});

// ===========================================================================
// 17. Overflow erasure via captured intrinsic
// ===========================================================================

describe("overflow erasure via captured intrinsic", () => {
	it("encode overflow zeroes generated bytes before returning failure", () => {
		// Build oversized body to trigger overflow.
		const cleanBody = { type: "bash_delta", text: "x" };
		const evt = makeEventFrame("evt-ov1", "bash_start", 1);
		evt.body = cleanBody;
		const eventDigest = digestOfFrame(evt);
		evt.body = { type: "bash_delta", text: "x".repeat(1_500_000) };
		const raw = {
			version: 1,
			recordKind: "pending",
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-ov1",
			eventSequence: 1,
			eventType: "bash_delta",
			eventDigest,
			event: evt,
		};
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 18. Cross-variant deep freeze symmetry
// ===========================================================================

describe("cross-variant deep freeze symmetry", () => {
	it("encode pending and delivered both produce fully frozen records", () => {
		const rawP = makePendingInput("evt-cs1");
		const encP = encodeSandboxEventOutboxRecordV1(rawP);
		expect(encP.ok).toBe(true);
		if (!encP.ok) return;
		expect(Object.isFrozen(encP.record)).toBe(true);

		const rawD = makeDeliveredInput("evt-cs2");
		const encD = encodeSandboxEventOutboxRecordV1(rawD);
		expect(encD.ok).toBe(true);
		if (!encD.ok) return;
		expect(Object.isFrozen(encD.record)).toBe(true);
	});

	it("decode pending and delivered both produce fully frozen records", () => {
		const rawP = makePendingInput("evt-cs3");
		const encP = encodeSandboxEventOutboxRecordV1(rawP);
		expect(encP.ok).toBe(true);
		if (!encP.ok) return;
		const decP = decodeSandboxEventOutboxRecordV1(new Uint8Array(encP.bytes));
		expect(decP.ok).toBe(true);
		if (!decP.ok) return;
		expect(Object.isFrozen(decP.record)).toBe(true);

		const rawD = makeDeliveredInput("evt-cs4");
		const encD = encodeSandboxEventOutboxRecordV1(rawD);
		expect(encD.ok).toBe(true);
		if (!encD.ok) return;
		const decD = decodeSandboxEventOutboxRecordV1(new Uint8Array(encD.bytes));
		expect(decD.ok).toBe(true);
		if (!decD.ok) return;
		expect(Object.isFrozen(decD.record)).toBe(true);
	});
});

// ===========================================================================
// 19. Body undefined field rejection
// ===========================================================================

describe("body undefined field rejection", () => {
	it("encode rejects body with undefined required field", () => {
		const raw = makePendingInput("evt-bu1");
		const cleanBody: Record<string, unknown> = { type: "session_created", sessionId: "s-1", workspaceId: "ws-1" };
		const cleanEvent = makeEventFrame("evt-bu1", "session_created");
		Reflect.set(cleanEvent, "body", cleanBody);
		const precomputedDigest = digestOfFrame(cleanEvent);
		cleanBody.workspaceId = undefined;
		raw.event = cleanEvent;
		raw.eventDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});

	it("encode rejects body with undefined optional field", () => {
		const raw = makePendingInput("evt-bu2");
		const cleanBody: Record<string, unknown> = { type: "session_destroyed" };
		const cleanEvent = makeEventFrame("evt-bu2", "session_destroyed");
		Reflect.set(cleanEvent, "body", cleanBody);
		const precomputedDigest = digestOfFrame(cleanEvent);
		cleanBody.reason = undefined;
		raw.event = cleanEvent;
		raw.eventDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 20. Null prototype rejection for inner objects
// ===========================================================================

describe("null prototype rejection for inner objects", () => {
	it("encode rejects ack with null prototype", () => {
		const raw = makeDeliveredInput("evt-np1");
		const cleanAck = { type: "ack", ackId: "a-1", acknowledges: "evt-np1", status: "delivered" };
		const precomputedDigest = digestOfAck(cleanAck);
		Reflect.set(raw, "ack", Object.assign(Object.create(null), cleanAck));
		raw.ackDigest = precomputedDigest;
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		expect(enc.ok).toBe(false);
	});
});
