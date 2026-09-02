/**
 * Tests for the B03 journal record v1 codec.
 *
 * Covers: all nine frame kinds exact roundtrip, envelope digest known,
 * exact golden key order, direction binding, seq/id/time/size bounds,
 * hostile record/expected inputs, hostile bytes, truncation, invalid UTF8,
 * JSON parse failures, unknown/missing/reorder/whitespace/duplicate escaped
 * key/-0/digest/case/envelope mutations, caller byte erase every path,
 * returned deep freeze/no aliases/mutation, caller envelopeDigest rejection,
 * empty expected rejection, nested envelope canonical key order,
 * invalid-UTF-8 caller erasure, overflow encoded cleanup,
 * reentrant/concurrent encode deterministic output, success result mutation.
 */

import { describe, expect, it } from "vitest";
import type { JournalRecordV1 } from "../src/modes/daemon/b03-journal-record-codec.js";
import { decodeJournalRecordV1, encodeJournalRecordV1 } from "../src/modes/daemon/b03-journal-record-codec.js";
import type { RemoteHostFrame, RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function validEnvelope(): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId: "f-001",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: {
			type: "event",
			id: "e-001",
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "agent_start" },
		},
	};
}

function validEnvelopeWith(frame: RemoteHostFrame): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId: "f-001",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame,
	};
}

const NINE_FRAMES: Array<{ name: string; frame: RemoteHostFrame }> = [
	{
		name: "handshake",
		frame: {
			type: "handshake",
			direction: "home_to_host",
			hostId: "h-1",
			generation: "g-1",
			capabilities: ["session_commands", "sequenced_events"],
			runtime: { buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		} as RemoteHostFrame,
	},
	{
		name: "handshake_ack",
		frame: {
			type: "handshake_ack",
			hostId: "h-1",
			sessionId: "s-1",
			protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
			accepted: true,
			capabilities: ["session_commands"],
			linkId: "l-1",
			remoteBuildIdentity: { buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		} as RemoteHostFrame,
	},
	{ name: "command", frame: { type: "command", commandId: "c-1", body: { type: "abort" } } as RemoteHostFrame },
	{
		name: "event",
		frame: {
			type: "event",
			id: "e-1",
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "agent_start" },
		} as RemoteHostFrame,
	},
	{ name: "ack", frame: { type: "ack", ackId: "a-1", acknowledges: "f-001", status: "delivered" } as RemoteHostFrame },
	{
		name: "agent_message",
		frame: {
			type: "agent_message",
			id: "m-1",
			fromActiveSessionId: "s-1",
			targetActiveSessionId: "s-2",
			message: "hello from test",
		} as RemoteHostFrame,
	},
	{
		name: "provider_proxy",
		frame: {
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-1",
			provider: "test-provider",
			model: "test-model",
			messages: [{ role: "user", content: "hello" }],
		} as RemoteHostFrame,
	},
	{ name: "health", frame: { type: "health", healthSeq: 1, status: "connected" } as RemoteHostFrame },
	{ name: "error", frame: { type: "error", code: "E001", message: "test error" } as RemoteHostFrame },
];

function makeRecordRaw(env: RemoteHostFrameEnvelope, overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		version: 1,
		journalSeq: 1,
		direction: "sent",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		envelope: env,
		...overrides,
	};
}

function validExpected(): Record<string, unknown> {
	return { journalSeq: 1, hostId: "h-1", generation: "g-1", sessionId: "s-1" };
}

function bytesFrom(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

// ===========================================================================
// 1. All nine frame kinds exact roundtrip
// ===========================================================================

describe("all nine frame kinds roundtrip", () => {
	for (const fixture of NINE_FRAMES) {
		it(`encodes and decodes ${fixture.name}`, () => {
			const env = validEnvelopeWith(fixture.frame);
			const raw = makeRecordRaw(env);
			const enc = encodeJournalRecordV1(raw);
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			expect(enc.bytes).toBeInstanceOf(Uint8Array);
			expect(enc.bytes.byteLength).toBeGreaterThan(0);

			const expected = validExpected();
			const dec = decodeJournalRecordV1(enc.bytes, expected);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			expect(dec.record.version).toBe(1);
			expect(dec.record.journalSeq).toBe(1);
			expect(dec.record.direction).toBe("sent");
			expect(dec.record.hostId).toBe("h-1");
			expect(dec.record.generation).toBe("g-1");
			expect(dec.record.sessionId).toBe("s-1");
			expect(dec.record.recordedAt).toBe("2025-01-15T10:30:00.000Z");
			expect(dec.record.envelope.frame.type).toBe(fixture.frame.type);
		});
	}
});

// ===========================================================================
// 2. Envelope digest known and verifiable
// ===========================================================================

describe("envelope digest known", () => {
	it("envelope digest matches canonicalDigest of decoded envelope", () => {
		const env = validEnvelope();
		const d = canonicalDigest(env);
		expect(d.ok).toBe(true);
		if (!d.ok) return;

		const raw = makeRecordRaw(env);
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		expect(enc.record.envelopeDigest).toBe(d.value);

		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.record.envelopeDigest).toBe(d.value);
		const recomp = canonicalDigest(dec.record.envelope);
		expect(recomp.ok).toBe(true);
		if (recomp.ok) expect(recomp.value).toBe(d.value);
	});

	it("rejects record with wrong envelope digest", () => {
		const env = validEnvelope();
		const raw = makeRecordRaw(env);
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const tampered = jsonStr.replace(
			parsed.envelopeDigest,
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		);
		if (tampered === jsonStr) return;
		const b = bytesFrom(tampered);
		const dec = decodeJournalRecordV1(b, validExpected());
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 3. Exact golden key order
// ===========================================================================

describe("exact golden key order", () => {
	it("encode produces fixed key order via insertion-order JSON.stringify", () => {
		const raw = makeRecordRaw(validEnvelope());
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const keys = Object.keys(parsed);
		expect(keys).toEqual([
			"version",
			"journalSeq",
			"direction",
			"hostId",
			"generation",
			"sessionId",
			"recordedAt",
			"envelope",
			"envelopeDigest",
		]);
	});

	it("decode rejects reordered JSON via canonical re-encoding", () => {
		const raw = makeRecordRaw(validEnvelope());
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const reversed: Record<string, unknown> = {};
		const rkeys = [
			"envelopeDigest",
			"envelope",
			"recordedAt",
			"sessionId",
			"generation",
			"hostId",
			"direction",
			"journalSeq",
			"version",
		];
		for (const k of rkeys) reversed[k] = parsed[k];
		const b = bytesFrom(JSON.stringify(reversed));
		const dec = decodeJournalRecordV1(b, validExpected());
		expect(dec.ok).toBe(false);
	});

	it("nested envelope preserves decodeEnvelope insertion order (not re-sorted)", () => {
		const env = validEnvelope();
		const raw = makeRecordRaw(env);
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);

		// Top-level keys are in CANONICAL_KEYS insertion order
		const topKeys = Object.keys(parsed);
		expect(topKeys).toEqual([
			"version",
			"journalSeq",
			"direction",
			"hostId",
			"generation",
			"sessionId",
			"recordedAt",
			"envelope",
			"envelopeDigest",
		]);

		// Nested envelope keys preserve insertion order from decodeEnvelope
		const envKeys = Object.keys(parsed.envelope);
		expect(envKeys).toEqual(["type", "frameId", "protocol", "sentAt", "frame"]);

		// Nested frame keys preserve insertion order from decodeEnvelope
		const frameKeys = Object.keys(parsed.envelope.frame);
		expect(frameKeys).toEqual(["type", "id", "sequence", "cursor", "emittedAt", "body"]);
	});
});

// ===========================================================================
// 4. Direction binding
// ===========================================================================

describe("direction binding", () => {
	it("encode with direction=sent decodes with direction=sent", () => {
		const raw = makeRecordRaw(validEnvelope(), { direction: "sent" });
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.record.direction).toBe("sent");
	});

	it("encode with direction=received decodes with direction=received", () => {
		const raw = makeRecordRaw(validEnvelope(), { direction: "received" });
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.record.direction).toBe("received");
	});

	it("expected direction binds exactly", () => {
		const raw = makeRecordRaw(validEnvelope(), { direction: "sent" });
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const ok = decodeJournalRecordV1(enc.bytes, {
			journalSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
		});
		expect(ok.ok).toBe(true);

		const raw2 = makeRecordRaw(validEnvelope(), { direction: "sent" });
		const enc2 = encodeJournalRecordV1(raw2);
		expect(enc2.ok).toBe(true);
		if (!enc2.ok) return;
		const bad = decodeJournalRecordV1(enc2.bytes, {
			journalSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "received",
		});
		expect(bad.ok).toBe(false);
	});

	it("direction omitted in expected accepts either", () => {
		const raw = makeRecordRaw(validEnvelope(), { direction: "sent" });
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
	});
});

// ===========================================================================
// 5. Seq / ID / time / size bounds
// ===========================================================================

describe("seq / id / time / size bounds", () => {
	it("rejects journalSeq <= 0", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: 0 })).ok).toBe(false);
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: -1 })).ok).toBe(false);
	});

	it("rejects journalSeq > 20000", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: 20001 })).ok).toBe(false);
	});

	it("accepts journalSeq = 20000", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: 20000 }));
		expect(enc.ok).toBe(true);
	});

	it("rejects non-safe-integer journalSeq", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: 1.5 })).ok).toBe(false);
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: NaN })).ok).toBe(false);
	});

	it("rejects invalid hostId", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { hostId: "" })).ok).toBe(false);
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { hostId: "-bad" })).ok).toBe(false);
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { hostId: "a".repeat(129) })).ok).toBe(false);
	});

	it("rejects invalid generation", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { generation: "" })).ok).toBe(false);
	});

	it("rejects invalid sessionId", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { sessionId: "" })).ok).toBe(false);
	});

	it("rejects non-canonical recordedAt", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { recordedAt: "2025-01-15T10:30:00Z" })).ok).toBe(
			false,
		);
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { recordedAt: "not-a-date" })).ok).toBe(false);
	});

	it("rejects non-1 version", () => {
		expect(encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { version: 2 })).ok).toBe(false);
	});

	it("rejects oversized envelope > 1.25 MiB", () => {
		const hugeMsg = "x".repeat(1_200_000);
		const env = validEnvelopeWith({
			type: "agent_message",
			id: "m-huge",
			fromActiveSessionId: "s-1",
			targetActiveSessionId: "s-2",
			message: hugeMsg,
		});
		const enc = encodeJournalRecordV1(makeRecordRaw(env));
		expect(enc.ok).toBe(false);
	});
});

// ===========================================================================
// 6. Hostile record inputs
// ===========================================================================

describe("hostile record inputs", () => {
	it("rejects Proxy input", () => {
		const p = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error();
				},
			},
		);
		expect(encodeJournalRecordV1(p).ok).toBe(false);
	});

	it("rejects input with getter", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, "evil", { get: () => "x", enumerable: true });
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects input with Symbol keys", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects non-enumerable own property", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, "hidden", { value: 1, enumerable: false });
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects extra keys", () => {
		const obj = makeRecordRaw(validEnvelope());
		obj.extra = "x";
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects caller-supplied envelopeDigest (extra key)", () => {
		const obj = makeRecordRaw(validEnvelope());
		obj.envelopeDigest = "00".repeat(32);
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects undefined value", () => {
		const obj = makeRecordRaw(validEnvelope());
		obj.direction = undefined;
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects non-object input", () => {
		expect(encodeJournalRecordV1(null).ok).toBe(false);
		expect(encodeJournalRecordV1("s").ok).toBe(false);
		expect(encodeJournalRecordV1(42).ok).toBe(false);
		expect(encodeJournalRecordV1([]).ok).toBe(false);
	});

	it("rejects input with __proto__ pollution", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true });
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});

	it("rejects TypedArray input", () => {
		expect(encodeJournalRecordV1(new Uint8Array(10)).ok).toBe(false);
		expect(encodeJournalRecordV1(new Int32Array(10)).ok).toBe(false);
	});

	it("rejects DataView input", () => {
		expect(encodeJournalRecordV1(new DataView(new ArrayBuffer(10))).ok).toBe(false);
	});

	it("rejects SharedArrayBuffer-backed input", () => {
		expect(encodeJournalRecordV1(new Uint8Array(new SharedArrayBuffer(10))).ok).toBe(false);
	});

	it("rejects missing key (8 required)", () => {
		const obj = makeRecordRaw(validEnvelope());
		delete obj.version;
		expect(encodeJournalRecordV1(obj).ok).toBe(false);
	});
});

// ===========================================================================
// 7. Hostile expected inputs
// ===========================================================================

describe("hostile expected inputs", () => {
	it("rejects Proxy expected", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const p = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error();
				},
			},
		);
		expect(decodeJournalRecordV1(enc.bytes, p).ok).toBe(false);
	});

	it("rejects expected with extra keys", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeJournalRecordV1(enc.bytes, {
				journalSeq: 1,
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				extra: "x",
			}).ok,
		).toBe(false);
	});

	it("rejects expected with getter", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const obj: Record<string, unknown> = { journalSeq: 1, hostId: "h-1", generation: "g-1", sessionId: "s-1" };
		Object.defineProperty(obj, "evil", { get: () => "x", enumerable: true });
		expect(decodeJournalRecordV1(enc.bytes, obj).ok).toBe(false);
	});

	it("rejects expected with symbol key", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const obj: Record<string, unknown> = { journalSeq: 1, hostId: "h-1", generation: "g-1", sessionId: "s-1" };
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(decodeJournalRecordV1(enc.bytes, obj).ok).toBe(false);
	});

	it("rejects expected with undefined value", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeJournalRecordV1(enc.bytes, {
				journalSeq: 1,
				hostId: "h-1",
				generation: "g-1",
				sessionId: undefined! as string,
			}).ok,
		).toBe(false);
	});

	it("rejects empty expected (missing required fields)", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(decodeJournalRecordV1(enc.bytes, {}).ok).toBe(false);
	});

	it("rejects expected direction with wrong type", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeJournalRecordV1(enc.bytes, {
				journalSeq: 1,
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				direction: 42,
			}).ok,
		).toBe(false);
	});

	it("rejects expected non-plain-object (Date)", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const d = new Date();
		expect(decodeJournalRecordV1(enc.bytes, d as any).ok).toBe(false);
	});

	it("rejects expected null", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(decodeJournalRecordV1(enc.bytes, null as any).ok).toBe(false);
	});
});

// ===========================================================================
// 8. Hostile bytes inputs + erasure
// ===========================================================================

describe("hostile bytes inputs", () => {
	it("rejects non-Uint8Array", () => {
		expect(decodeJournalRecordV1("string" as any, validExpected()).ok).toBe(false);
		expect(decodeJournalRecordV1(null as any, validExpected()).ok).toBe(false);
	});

	it("rejects Uint8Array subclass", () => {
		class SubUint8 extends Uint8Array {}
		const sub = new SubUint8(10);
		sub.fill(32);
		expect(decodeJournalRecordV1(sub, validExpected()).ok).toBe(false);
	});

	it("rejects Proxy-wrapped Uint8Array", () => {
		const real = new Uint8Array(10);
		const p = new Proxy(real, {
			getPrototypeOf() {
				throw new Error();
			},
		});
		expect(decodeJournalRecordV1(p, validExpected()).ok).toBe(false);
	});

	it("rejects SharedArrayBuffer-backed Uint8Array", () => {
		const sab = new SharedArrayBuffer(10);
		const view = new Uint8Array(sab);
		expect(decodeJournalRecordV1(view, validExpected()).ok).toBe(false);
	});

	it("rejects detached ArrayBuffer", () => {
		const ab = new ArrayBuffer(10);
		const view = new Uint8Array(ab);
		const { port1, port2 } = new MessageChannel();
		port1.postMessage(ab, [ab]);
		port2.addEventListener("message", () => {});
		port1.close();
		port2.close();
		expect(decodeJournalRecordV1(view, validExpected()).ok).toBe(false);
	});

	it("rejects subarray (view into larger buffer)", () => {
		const big = new Uint8Array(100);
		const small = big.subarray(10, 20);
		expect(decodeJournalRecordV1(small, validExpected()).ok).toBe(false);
	});

	it("erases input bytes on success", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);

		for (let i = 0; i < enc.bytes.length; i++) {
			expect(enc.bytes[i]).toBe(0);
		}
	});

	it("erases input bytes on failure (invalid JSON)", () => {
		const bad = bytesFrom("{invalid}");
		const dec = decodeJournalRecordV1(bad, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < bad.length; i++) {
			expect(bad[i]).toBe(0);
		}
	});

	it("erases input bytes on failure (invalid UTF-8)", () => {
		const bad = new Uint8Array([0xe2, 0x82]); // incomplete UTF-8 sequence
		const dec = decodeJournalRecordV1(bad, validExpected());
		expect(dec.ok).toBe(false);
		// Even after UTF-8 decode failure, the caller bytes must be erased
		for (let i = 0; i < bad.length; i++) {
			expect(bad[i]).toBe(0);
		}
	});

	it("bytes erased even when expected is hostile", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const p = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error();
				},
			},
		);
		const dec = decodeJournalRecordV1(enc.bytes, p);
		expect(dec.ok).toBe(false);
		for (let i = 0; i < enc.bytes.length; i++) {
			expect(enc.bytes[i]).toBe(0);
		}
	});

	it("erases every owned buffer on schema failure (wrong version)", () => {
		const env = validEnvelope();
		const raw = makeRecordRaw(env, { version: 99 });
		const json = JSON.stringify(raw);
		const b = bytesFrom(json);
		const dec = decodeJournalRecordV1(b, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < b.length; i++) {
			expect(b[i]).toBe(0);
		}
	});
});

// ===========================================================================
// 9. Truncation / invalid UTF8 / JSON
// ===========================================================================

describe("truncation / invalid UTF-8 / JSON", () => {
	it("rejects truncated bytes", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const t = new Uint8Array(enc.bytes.subarray(0, enc.bytes.length - 1));
		expect(decodeJournalRecordV1(t, validExpected()).ok).toBe(false);
	});

	it("rejects incomplete UTF-8", () => {
		const bad = new Uint8Array([0xe2, 0x82]);
		expect(decodeJournalRecordV1(bad, validExpected()).ok).toBe(false);
	});

	it("rejects invalid JSON", () => {
		expect(decodeJournalRecordV1(bytesFrom("{invalid}"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON non-object (number)", () => {
		expect(decodeJournalRecordV1(bytesFrom("42"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON null", () => {
		expect(decodeJournalRecordV1(bytesFrom("null"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON array", () => {
		expect(decodeJournalRecordV1(bytesFrom("[]"), validExpected()).ok).toBe(false);
	});
});

// ===========================================================================
// 10. Schema validation
// ===========================================================================

describe("schema validation", () => {
	it("rejects unknown key in JSON", () => {
		const raw = makeRecordRaw(validEnvelope());
		raw.extraKey = "x";
		const json = JSON.stringify(raw);
		expect(decodeJournalRecordV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects missing required key", () => {
		const env = validEnvelope();
		const json = JSON.stringify({
			version: 1,
			journalSeq: 1,
			direction: "sent",
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			envelope: env,
		});
		expect(decodeJournalRecordV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects wrong version", () => {
		const json = JSON.stringify(makeRecordRaw(validEnvelope(), { version: 2 }));
		expect(decodeJournalRecordV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects -0 as journalSeq", () => {
		const raw = makeRecordRaw(validEnvelope());
		const json = JSON.stringify(raw).replace('"journalSeq":1', '"journalSeq":-0');
		expect(decodeJournalRecordV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects wrong envelope digest format", () => {
		const raw = makeRecordRaw(validEnvelope());
		const d = canonicalDigest(raw.envelope as RemoteHostFrameEnvelope);
		const digestStr = d.ok ? d.value : "";
		const json = JSON.stringify(raw).replace(digestStr, "not-hex");
		const b = bytesFrom(json);
		if (b.byteLength === 0) return;
		expect(decodeJournalRecordV1(b, validExpected()).ok).toBe(false);
	});

	it("rejects uppercase hex digest", () => {
		const raw = makeRecordRaw(validEnvelope());
		const d = canonicalDigest(raw.envelope as RemoteHostFrameEnvelope);
		const digestStr = d.ok ? d.value : "";
		const upper = digestStr.toUpperCase();
		const json = JSON.stringify(raw).replace(digestStr, upper);
		const b = bytesFrom(json);
		if (b.byteLength === 0) return;
		expect(decodeJournalRecordV1(b, validExpected()).ok).toBe(false);
	});

	it("rejects wrong direction", () => {
		const raw = makeRecordRaw(validEnvelope(), { direction: "invalid" });
		const json = JSON.stringify(raw);
		expect(decodeJournalRecordV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects whitespace variation", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const pretty = JSON.stringify(parsed, null, 2);
		expect(decodeJournalRecordV1(bytesFrom(pretty), validExpected()).ok).toBe(false);
	});

	it("rejects duplicate escaped key (JSON last-value wins, but canonical re-encoding mismatch)", () => {
		const raw = makeRecordRaw(validEnvelope());
		const json = JSON.stringify(raw);
		const dup = json.replace('"envelope"', '"envelope","envelope"');
		const b = bytesFrom(dup);
		// The canonical re-encoding won't match the original bytes
		expect(decodeJournalRecordV1(b, validExpected()).ok).toBe(false);
	});

	it("rejects envelope mutation -- tampered frameId", () => {
		const raw = makeRecordRaw(validEnvelope());
		const json = JSON.stringify(raw);
		const t = json.replace('"f-001"', '"f-999"');
		expect(decodeJournalRecordV1(bytesFrom(t), validExpected()).ok).toBe(false);
	});

	it("rejects envelope mutation -- wrong sentAt", () => {
		const raw = makeRecordRaw(validEnvelope());
		const json = JSON.stringify(raw);
		const t = json.replace("2025-01-15T10:30:00.000Z", "2025-06-15T10:30:00.000Z");
		expect(decodeJournalRecordV1(bytesFrom(t), validExpected()).ok).toBe(false);
	});
});

// ===========================================================================
// 11. Deep freeze / no aliases / mutation resistance
// ===========================================================================

describe("deep freeze and no aliases", () => {
	it("encode returns deeply frozen record", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
		expect(Object.isFrozen(enc.record.envelope)).toBe(true);
		expect(Object.isFrozen(enc.record.envelope.frame)).toBe(true);
	});

	it("decode returns deeply frozen record", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
		expect(Object.isFrozen(dec.record.envelope)).toBe(true);
		expect(Object.isFrozen(dec.record.envelope.frame)).toBe(true);
	});

	it("record has no alias to input raw", () => {
		const raw = makeRecordRaw(validEnvelope());
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.record.envelope).not.toBe(raw.envelope);
	});

	it("cannot mutate frozen record", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		try {
			(enc.record as unknown as Record<string, unknown>).journalSeq = 999;
		} catch {}
		expect(enc.record.journalSeq).toBe(1);
	});

	it("encode success result is frozen", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc)).toBe(true);
	});

	it("decode success result is frozen", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(Object.isFrozen(dec)).toBe(true);
	});

	it("encode error result is frozen", () => {
		const enc = encodeJournalRecordV1(null);
		expect(enc.ok).toBe(false);
		expect(Object.isFrozen(enc)).toBe(true);
	});

	it("decode error result is frozen", () => {
		const dec = decodeJournalRecordV1(bytesFrom("xxx"), validExpected());
		expect(dec.ok).toBe(false);
		expect(Object.isFrozen(dec)).toBe(true);
	});
});

// ===========================================================================
// 12. Roundtrip edge cases
// ===========================================================================

describe("roundtrip edge cases", () => {
	it("decode with undefined expected works", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, undefined);
		expect(dec.ok).toBe(true);
	});

	it("rejects mismatched journalSeq in expected", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { journalSeq: 5 }));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeJournalRecordV1(enc.bytes, { journalSeq: 3, hostId: "h-1", generation: "g-1", sessionId: "s-1" }).ok,
		).toBe(false);
	});

	it("rejects mismatched hostId in expected", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope(), { hostId: "h-1" }));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeJournalRecordV1(enc.bytes, { journalSeq: 1, hostId: "h-other", generation: "g-1", sessionId: "s-1" }).ok,
		).toBe(false);
	});

	it("cycles produce no aliases between separate decode calls", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const b1 = new Uint8Array(enc.bytes);
		const b2 = new Uint8Array(enc.bytes);
		const d1 = decodeJournalRecordV1(b1, validExpected());
		const d2 = decodeJournalRecordV1(b2, validExpected());
		expect(d1.ok).toBe(true);
		expect(d2.ok).toBe(true);
		if (!d1.ok || !d2.ok) return;
		expect(d1.record).not.toBe(d2.record);
		expect(d1.record.envelope).not.toBe(d2.record.envelope);
	});

	it("encode ignores caller-supplied envelopeDigest (rejected as extra key)", () => {
		const raw = makeRecordRaw(validEnvelope());
		const enc = encodeJournalRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const d = canonicalDigest(validEnvelope());
		expect(d.ok).toBe(true);
		if (d.ok) {
			expect(enc.record.envelopeDigest).toBe(d.value);
		}

		// With caller passing envelopeDigest, encode must reject
		const raw2 = makeRecordRaw(validEnvelope());
		raw2.envelopeDigest = "00".repeat(32);
		expect(encodeJournalRecordV1(raw2).ok).toBe(false);
	});
});

// ===========================================================================
// 13. Known error codes for hostile patterns
// ===========================================================================

describe("fixed error codes for known hostile patterns", () => {
	function checkError(raw: unknown): string | undefined {
		const r = encodeJournalRecordV1(raw);
		return r.ok ? undefined : r.error.code;
	}

	it("Proxy returns INVALID_FRAME", () => {
		const p = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error();
				},
			},
		);
		expect(checkError(p)).toBe("INVALID_FRAME");
	});

	it("getter returns INVALID_FRAME", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, "x", { get: () => 1, enumerable: true });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("Symbol key returns INVALID_FRAME", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("non-enumerable returns INVALID_FRAME", () => {
		const obj = makeRecordRaw(validEnvelope());
		Object.defineProperty(obj, "h", { value: 1, enumerable: false });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("SharedArrayBuffer returns INVALID_FRAME", () => {
		expect(checkError(new Uint8Array(new SharedArrayBuffer(10)))).toBe("INVALID_FRAME");
	});
});

// ===========================================================================
// 14. Reentrant / concurrent encode deterministic output
// ===========================================================================

describe("reentrant / concurrent encode deterministic output", () => {
	it("consecutive encodes produce identical bytes for same input", () => {
		const raw = makeRecordRaw(validEnvelope());
		const a = encodeJournalRecordV1(raw);
		const b = encodeJournalRecordV1(raw);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;

		expect(a.bytes.byteLength).toBe(b.bytes.byteLength);
		for (let i = 0; i < a.bytes.byteLength; i++) {
			expect(a.bytes[i]).toBe(b.bytes[i]);
		}
	});

	it("interleaved encode calls produce deterministic output (no global state)", () => {
		const raw1 = makeRecordRaw(validEnvelope(), { journalSeq: 1 });
		const raw2 = makeRecordRaw(validEnvelope(), { journalSeq: 2 });

		const results = Array.from({ length: 10 }, (_, i) => {
			const r = i % 2 === 0 ? encodeJournalRecordV1(raw1) : encodeJournalRecordV1(raw2);
			return r;
		});

		for (let i = 0; i < results.length; i++) {
			expect(results[i].ok).toBe(true);
			if (!results[i].ok) continue;
			const expected = i % 2 === 0 ? 1 : 2;
			expect((results[i] as { ok: true; record: JournalRecordV1 }).record.journalSeq).toBe(expected);
		}
	});
});

// ===========================================================================
// 15. Success result mutation resistance
// ===========================================================================

describe("success result mutation resistance", () => {
	it("encode success result { ok, bytes, record } cannot be mutated", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Result is frozen
		expect(() => {
			(enc as any).extra = "x";
		}).toThrow();
	});

	it("encode ok.bytes is caller-owned and mutable but result object is frozen", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// bytes is not frozen (caller-owned), but record is
		expect(Object.isFrozen(enc)).toBe(true);
		expect(Object.isFrozen(enc.record)).toBe(true);
	});

	it("decode success result { ok, record } cannot be mutated", () => {
		const enc = encodeJournalRecordV1(makeRecordRaw(validEnvelope()));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeJournalRecordV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec)).toBe(true);
		expect(() => {
			(dec as any).extra = "x";
		}).toThrow();
	});
});
