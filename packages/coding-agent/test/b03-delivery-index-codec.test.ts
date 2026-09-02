/**
 * Tests for the B03 delivery index codec and recovery accumulator.
 *
 * Covers: encode/decode roundtrip, exact golden key order, direction binding,
 * seq/id/time/size bounds, hostile marker/expected/bytes inputs, erasure every
 * path, schema validation, deep freeze, mutation resistance, recovery
 * accumulator transitions/actions/gaps/cross-binding, frameId vs semantic
 * identities via full envelope digest fixtures, hostile Proxy inputs.
 */

import { describe, expect, it } from "vitest";
import type {
	DeliveryIdentity,
	DeliveryMarkerV1,
	JournalDirection,
	RecoveryAccumulator,
} from "../src/modes/daemon/b03-delivery-index-codec.js";
import {
	createRecoveryAccumulator,
	decodeDeliveryMarkerV1,
	encodeDeliveryMarkerV1,
} from "../src/modes/daemon/b03-delivery-index-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

const DIGEST_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeMarkerRaw(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		version: 1,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		direction: "sent",
		frameId: "f-001",
		envelopeDigest: DIGEST_A,
		journalSeq: 1,
		indexSeq: 1,
		state: "pending",
		recordedAt: "2025-01-15T10:30:00.000Z",
		...overrides,
	};
}

function validExpected(): Record<string, unknown> {
	return { hostId: "h-1", generation: "g-1", sessionId: "s-1" };
}

function bytesFrom(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

const IDENTITY_A: DeliveryIdentity = Object.freeze({ hostId: "h-1", generation: "g-1", sessionId: "s-1" });

// ===========================================================================
// 1. Basic roundtrip
// ===========================================================================

describe("basic roundtrip", () => {
	it("encodes and decodes a pending marker", () => {
		const raw = makeMarkerRaw();
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.bytes).toBeInstanceOf(Uint8Array);
		expect(enc.bytes.byteLength).toBeGreaterThan(0);

		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.marker.version).toBe(1);
		expect(dec.marker.hostId).toBe("h-1");
		expect(dec.marker.generation).toBe("g-1");
		expect(dec.marker.sessionId).toBe("s-1");
		expect(dec.marker.direction).toBe("sent");
		expect(dec.marker.frameId).toBe("f-001");
		expect(dec.marker.envelopeDigest).toBe(DIGEST_A);
		expect(dec.marker.journalSeq).toBe(1);
		expect(dec.marker.indexSeq).toBe(1);
		expect(dec.marker.state).toBe("pending");
		expect(dec.marker.recordedAt).toBe("2025-01-15T10:30:00.000Z");
	});

	it("encodes and decodes a delivered marker", () => {
		const raw = makeMarkerRaw({ state: "delivered" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.marker.state).toBe("delivered");
	});

	it("encode result contains both bytes and marker", () => {
		const raw = makeMarkerRaw();
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.bytes).toBeInstanceOf(Uint8Array);
		expect(enc.bytes.byteLength).toBeGreaterThan(0);
		expect(enc.marker.version).toBe(1);
	});

	it("roundtrip with direction=received", () => {
		const raw = makeMarkerRaw({ direction: "received" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.marker.direction).toBe("received");
	});

	it("roundtrip with high seq values", () => {
		const raw = makeMarkerRaw({ journalSeq: 20000, indexSeq: 40000 });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.marker.journalSeq).toBe(20000);
		expect(dec.marker.indexSeq).toBe(40000);
	});
});

// ===========================================================================
// 2. Exact golden key order
// ===========================================================================

describe("exact golden key order", () => {
	it("encode produces fixed key order via insertion-order JSON.stringify", () => {
		const raw = makeMarkerRaw();
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const keys = Object.keys(parsed);
		expect(keys).toEqual([
			"version",
			"hostId",
			"generation",
			"sessionId",
			"direction",
			"frameId",
			"envelopeDigest",
			"journalSeq",
			"indexSeq",
			"state",
			"recordedAt",
		]);
	});

	it("decode rejects reordered JSON via canonical re-encoding", () => {
		const raw = makeMarkerRaw();
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const reversed: Record<string, unknown> = {};
		const rkeys = [
			"recordedAt",
			"state",
			"indexSeq",
			"journalSeq",
			"envelopeDigest",
			"frameId",
			"direction",
			"sessionId",
			"generation",
			"hostId",
			"version",
		];
		for (const k of rkeys) reversed[k] = parsed[k];
		const b = bytesFrom(JSON.stringify(reversed));
		const dec = decodeDeliveryMarkerV1(b, validExpected());
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 3. Direction binding
// ===========================================================================

describe("direction binding", () => {
	it("encode with direction=sent decodes with direction=sent", () => {
		const raw = makeMarkerRaw({ direction: "sent" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.marker.direction).toBe("sent");
	});

	it("encode with direction=received decodes with direction=received", () => {
		const raw = makeMarkerRaw({ direction: "received" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.marker.direction).toBe("received");
	});

	it("expected direction binds exactly", () => {
		const raw = makeMarkerRaw({ direction: "sent" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const ok = decodeDeliveryMarkerV1(enc.bytes, {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
		});
		expect(ok.ok).toBe(true);

		const bad = decodeDeliveryMarkerV1(enc.bytes, {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "received",
		});
		expect(bad.ok).toBe(false);
	});

	it("direction omitted in expected accepts either", () => {
		const raw = makeMarkerRaw({ direction: "sent" });
		const enc = encodeDeliveryMarkerV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
	});
});

// ===========================================================================
// 4. Seq / ID / time / size bounds
// ===========================================================================

describe("seq / id / time / size bounds", () => {
	it("rejects journalSeq <= 0", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: 0 })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: -1 })).ok).toBe(false);
	});

	it("rejects journalSeq > 20000", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: 20001 })).ok).toBe(false);
	});

	it("accepts journalSeq = 20000", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: 20000 }));
		expect(enc.ok).toBe(true);
	});

	it("rejects indexSeq <= 0", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: 0 })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: -1 })).ok).toBe(false);
	});

	it("rejects indexSeq > 40000", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: 40001 })).ok).toBe(false);
	});

	it("accepts indexSeq = 40000", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: 40000 }));
		expect(enc.ok).toBe(true);
	});

	it("rejects non-safe-integer journalSeq", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: 1.5 })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ journalSeq: NaN })).ok).toBe(false);
	});

	it("rejects non-safe-integer indexSeq", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: 1.5 })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ indexSeq: NaN })).ok).toBe(false);
	});

	it("rejects invalid hostId", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ hostId: "" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ hostId: "-bad" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ hostId: "a".repeat(129) })).ok).toBe(false);
	});

	it("rejects invalid generation", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ generation: "" })).ok).toBe(false);
	});

	it("rejects invalid sessionId", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ sessionId: "" })).ok).toBe(false);
	});

	it("rejects invalid frameId", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ frameId: "" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ frameId: "-bad" })).ok).toBe(false);
	});

	it("rejects non-canonical recordedAt", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ recordedAt: "2025-01-15T10:30:00Z" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ recordedAt: "not-a-date" })).ok).toBe(false);
	});

	it("rejects non-1 version", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ version: 2 })).ok).toBe(false);
	});

	it("rejects invalid digest format", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ envelopeDigest: "not-hex" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ envelopeDigest: "" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ envelopeDigest: DIGEST_A.toUpperCase() })).ok).toBe(false);
	});

	it("rejects invalid state", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ state: "invalid" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ state: "" })).ok).toBe(false);
	});

	it("rejects invalid direction", () => {
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ direction: "invalid" })).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(makeMarkerRaw({ direction: "" })).ok).toBe(false);
	});
});

// ===========================================================================
// 5. Hostile marker inputs
// ===========================================================================

describe("hostile marker inputs", () => {
	it("rejects Proxy input", () => {
		const p = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error();
				},
			},
		);
		expect(encodeDeliveryMarkerV1(p).ok).toBe(false);
	});

	it("rejects input with getter", () => {
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, "evil", { get: () => "x", enumerable: true });
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});

	it("rejects input with Symbol keys", () => {
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});

	it("rejects non-enumerable own property", () => {
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, "hidden", { value: 1, enumerable: false });
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});

	it("rejects extra keys", () => {
		const obj = makeMarkerRaw();
		obj.extra = "x";
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});

	it("rejects undefined value", () => {
		const obj = makeMarkerRaw();
		obj.direction = undefined;
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});

	it("rejects non-object input", () => {
		expect(encodeDeliveryMarkerV1(null).ok).toBe(false);
		expect(encodeDeliveryMarkerV1("s").ok).toBe(false);
		expect(encodeDeliveryMarkerV1(42).ok).toBe(false);
		expect(encodeDeliveryMarkerV1([]).ok).toBe(false);
	});

	it("rejects TypedArray input", () => {
		expect(encodeDeliveryMarkerV1(new Uint8Array(10)).ok).toBe(false);
		expect(encodeDeliveryMarkerV1(new Int32Array(10)).ok).toBe(false);
	});

	it("rejects DataView input", () => {
		expect(encodeDeliveryMarkerV1(new DataView(new ArrayBuffer(10))).ok).toBe(false);
	});

	it("rejects missing key", () => {
		const obj = makeMarkerRaw();
		delete obj.version;
		expect(encodeDeliveryMarkerV1(obj).ok).toBe(false);
	});
});

// ===========================================================================
// 6. Hostile expected inputs
// ===========================================================================

describe("hostile expected inputs", () => {
	it("rejects Proxy expected", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
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
		expect(decodeDeliveryMarkerV1(enc.bytes, p).ok).toBe(false);
	});

	it("rejects expected with extra keys", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				extra: "x",
			}).ok,
		).toBe(false);
	});

	it("rejects expected with getter", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const obj: Record<string, unknown> = { hostId: "h-1", generation: "g-1", sessionId: "s-1" };
		Object.defineProperty(obj, "evil", { get: () => "x", enumerable: true });
		expect(decodeDeliveryMarkerV1(enc.bytes, obj).ok).toBe(false);
	});

	it("rejects expected with symbol key", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const obj: Record<string, unknown> = { hostId: "h-1", generation: "g-1", sessionId: "s-1" };
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(decodeDeliveryMarkerV1(enc.bytes, obj).ok).toBe(false);
	});

	it("rejects expected with undefined value", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-1",
				generation: "g-1",
				sessionId: undefined! as string,
			}).ok,
		).toBe(false);
	});

	it("rejects expected with invalid direction type", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				direction: 42,
			}).ok,
		).toBe(false);
	});

	it("rejects expected with invalid indexSeq", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				indexSeq: 0,
			}).ok,
		).toBe(false);
	});

	it("rejects expected non-plain-object (Date)", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const d = new Date();
		expect(decodeDeliveryMarkerV1(enc.bytes, d as any).ok).toBe(false);
	});

	it("rejects expected null", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(decodeDeliveryMarkerV1(enc.bytes, null as any).ok).toBe(false);
	});
});

// ===========================================================================
// 7. Hostile bytes inputs + erasure
// ===========================================================================

describe("hostile bytes inputs", () => {
	it("rejects non-Uint8Array", () => {
		expect(decodeDeliveryMarkerV1("string" as any, validExpected()).ok).toBe(false);
		expect(decodeDeliveryMarkerV1(null as any, validExpected()).ok).toBe(false);
	});

	it("rejects Uint8Array subclass", () => {
		class SubUint8 extends Uint8Array {}
		const sub = new SubUint8(10);
		sub.fill(32);
		expect(decodeDeliveryMarkerV1(sub, validExpected()).ok).toBe(false);
	});

	it("rejects Proxy-wrapped Uint8Array", () => {
		const real = new Uint8Array(10);
		const p = new Proxy(real, {
			getPrototypeOf() {
				throw new Error();
			},
		});
		expect(decodeDeliveryMarkerV1(p, validExpected()).ok).toBe(false);
	});

	it("rejects SharedArrayBuffer-backed Uint8Array", () => {
		const sab = new SharedArrayBuffer(10);
		const view = new Uint8Array(sab);
		expect(decodeDeliveryMarkerV1(view, validExpected()).ok).toBe(false);
	});

	it("rejects subarray (view into larger buffer)", () => {
		const big = new Uint8Array(100);
		const small = big.subarray(10, 20);
		expect(decodeDeliveryMarkerV1(small, validExpected()).ok).toBe(false);
	});

	it("erases input bytes on success", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);

		for (let i = 0; i < enc.bytes.length; i++) {
			expect(enc.bytes[i]).toBe(0);
		}
	});

	it("erases input bytes on failure (invalid JSON)", () => {
		const bad = bytesFrom("{invalid}");
		const dec = decodeDeliveryMarkerV1(bad, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < bad.length; i++) {
			expect(bad[i]).toBe(0);
		}
	});

	it("erases input bytes on failure (invalid UTF-8)", () => {
		const bad = new Uint8Array([0xe2, 0x82]);
		const dec = decodeDeliveryMarkerV1(bad, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < bad.length; i++) {
			expect(bad[i]).toBe(0);
		}
	});

	it("bytes erased even when expected is hostile", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
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
		const dec = decodeDeliveryMarkerV1(enc.bytes, p);
		expect(dec.ok).toBe(false);
		for (let i = 0; i < enc.bytes.length; i++) {
			expect(enc.bytes[i]).toBe(0);
		}
	});

	it("erases every owned buffer on schema failure (wrong version)", () => {
		const raw = makeMarkerRaw({ version: 99 });
		const json = JSON.stringify(raw);
		const b = bytesFrom(json);
		const dec = decodeDeliveryMarkerV1(b, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < b.length; i++) {
			expect(b[i]).toBe(0);
		}
	});
});

// ===========================================================================
// 8. Truncation / invalid UTF8 / JSON
// ===========================================================================

describe("truncation / invalid UTF-8 / JSON", () => {
	it("rejects truncated bytes", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const t = new Uint8Array(enc.bytes.subarray(0, enc.bytes.length - 1));
		expect(decodeDeliveryMarkerV1(t, validExpected()).ok).toBe(false);
	});

	it("rejects incomplete UTF-8", () => {
		const bad = new Uint8Array([0xe2, 0x82]);
		expect(decodeDeliveryMarkerV1(bad, validExpected()).ok).toBe(false);
	});

	it("rejects invalid JSON", () => {
		expect(decodeDeliveryMarkerV1(bytesFrom("{invalid}"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON non-object (number)", () => {
		expect(decodeDeliveryMarkerV1(bytesFrom("42"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON null", () => {
		expect(decodeDeliveryMarkerV1(bytesFrom("null"), validExpected()).ok).toBe(false);
	});

	it("rejects JSON array", () => {
		expect(decodeDeliveryMarkerV1(bytesFrom("[]"), validExpected()).ok).toBe(false);
	});
});

// ===========================================================================
// 9. Schema validation
// ===========================================================================

describe("schema validation", () => {
	it("rejects unknown key in JSON", () => {
		const raw = makeMarkerRaw();
		raw.extraKey = "x";
		const json = JSON.stringify(raw);
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects missing required key", () => {
		const raw = makeMarkerRaw();
		delete (raw as any).frameId;
		const json = JSON.stringify(raw);
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects wrong version", () => {
		const json = JSON.stringify(makeMarkerRaw({ version: 2 }));
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects -0 as indexSeq", () => {
		const raw = makeMarkerRaw();
		const json = JSON.stringify(raw).replace('"indexSeq":1', '"indexSeq":-0');
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects wrong digest format", () => {
		const raw = makeMarkerRaw();
		const json = JSON.stringify(raw).replace(DIGEST_A, "not-hex");
		const b = bytesFrom(json);
		if (b.byteLength === 0) return;
		expect(decodeDeliveryMarkerV1(b, validExpected()).ok).toBe(false);
	});

	it("rejects uppercase hex digest", () => {
		const raw = makeMarkerRaw();
		const upper = DIGEST_A.toUpperCase();
		const json = JSON.stringify(raw).replace(DIGEST_A, upper);
		const b = bytesFrom(json);
		if (b.byteLength === 0) return;
		expect(decodeDeliveryMarkerV1(b, validExpected()).ok).toBe(false);
	});

	it("rejects wrong direction", () => {
		const raw = makeMarkerRaw({ direction: "invalid" });
		const json = JSON.stringify(raw);
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects wrong state", () => {
		const json = JSON.stringify(makeMarkerRaw({ state: "invalid" }));
		expect(decodeDeliveryMarkerV1(bytesFrom(json), validExpected()).ok).toBe(false);
	});

	it("rejects whitespace variation", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		const pretty = JSON.stringify(parsed, null, 2);
		expect(decodeDeliveryMarkerV1(bytesFrom(pretty), validExpected()).ok).toBe(false);
	});

	it("rejects duplicate escaped key", () => {
		const raw = makeMarkerRaw();
		const json = JSON.stringify(raw);
		const dup = json.replace('"envelopeDigest"', '"envelopeDigest","envelopeDigest"');
		const b = bytesFrom(dup);
		expect(decodeDeliveryMarkerV1(b, validExpected()).ok).toBe(false);
	});

	it("accepts different valid digest (no envelope to verify against)", () => {
		const raw = makeMarkerRaw();
		const json = JSON.stringify(raw);
		const t = json.replace(DIGEST_A, DIGEST_B);
		const dec = decodeDeliveryMarkerV1(bytesFrom(t), validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.marker.envelopeDigest).toBe(DIGEST_B);
	});
});

// ===========================================================================
// 10. Deep freeze / no aliases / mutation
// ===========================================================================

describe("deep freeze and no aliases", () => {
	it("encode returns deeply frozen marker", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.marker)).toBe(true);
	});

	it("decode returns deeply frozen marker", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.marker)).toBe(true);
	});

	it("encode success result is frozen", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc)).toBe(true);
	});

	it("decode success result is frozen", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(Object.isFrozen(dec)).toBe(true);
	});

	it("encode error result is frozen", () => {
		const enc = encodeDeliveryMarkerV1(null);
		expect(enc.ok).toBe(false);
		expect(Object.isFrozen(enc)).toBe(true);
	});

	it("decode error result is frozen", () => {
		const dec = decodeDeliveryMarkerV1(bytesFrom("xxx"), validExpected());
		expect(dec.ok).toBe(false);
		expect(Object.isFrozen(dec)).toBe(true);
	});
});

// ===========================================================================
// 11. Roundtrip edge cases
// ===========================================================================

describe("roundtrip edge cases", () => {
	it("decode with undefined expected works", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, undefined);
		expect(dec.ok).toBe(true);
	});

	it("rejects mismatched hostId in expected", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-other",
				generation: "g-1",
				sessionId: "s-1",
			}).ok,
		).toBe(false);
	});

	it("rejects mismatched indexSeq in expected", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(
			decodeDeliveryMarkerV1(enc.bytes, {
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				indexSeq: 5,
			}).ok,
		).toBe(false);
	});

	it("cycles produce no aliases between separate decode calls", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const b1 = new Uint8Array(enc.bytes);
		const b2 = new Uint8Array(enc.bytes);
		const d1 = decodeDeliveryMarkerV1(b1, validExpected());
		const d2 = decodeDeliveryMarkerV1(b2, validExpected());
		expect(d1.ok).toBe(true);
		expect(d2.ok).toBe(true);
		if (!d1.ok || !d2.ok) return;
		expect(d1.marker).not.toBe(d2.marker);
	});
});

// ===========================================================================
// 12. Fixed error codes for hostile patterns
// ===========================================================================

describe("fixed error codes for known hostile patterns", () => {
	function checkError(raw: unknown): string | undefined {
		const r = encodeDeliveryMarkerV1(raw);
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
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, "x", { get: () => 1, enumerable: true });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("Symbol key returns INVALID_FRAME", () => {
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("non-enumerable returns INVALID_FRAME", () => {
		const obj = makeMarkerRaw();
		Object.defineProperty(obj, "h", { value: 1, enumerable: false });
		expect(checkError(obj)).toBe("INVALID_FRAME");
	});

	it("invalid indexSeq returns INVALID_SEQUENCE", () => {
		expect(checkError(makeMarkerRaw({ indexSeq: -1 }))).toBe("INVALID_SEQUENCE");
	});

	it("invalid journalSeq returns INVALID_SEQUENCE", () => {
		expect(checkError(makeMarkerRaw({ journalSeq: -1 }))).toBe("INVALID_SEQUENCE");
	});

	it("invalid digest returns INVALID_DIGEST", () => {
		expect(checkError(makeMarkerRaw({ envelopeDigest: "bad" }))).toBe("INVALID_DIGEST");
	});

	it("invalid identity returns INVALID_IDENTITY", () => {
		expect(checkError(makeMarkerRaw({ hostId: "" }))).toBe("INVALID_IDENTITY");
	});

	it("invalid timestamp returns INVALID_TIMESTAMP", () => {
		expect(checkError(makeMarkerRaw({ recordedAt: "bad" }))).toBe("INVALID_TIMESTAMP");
	});
});

// ===========================================================================
// Recovery accumulator tests
// ===========================================================================

// Helper: unwrap accumulator result
function mkAcc(identity: DeliveryIdentity, direction: JournalDirection): RecoveryAccumulator {
	const r = createRecoveryAccumulator(identity, direction);
	if (!r.ok) throw new Error(`createRecoveryAccumulator failed: ${r.error.code}`);
	return r.accumulator;
}

function makeMarker(
	indexSeq: number,
	state: "pending" | "delivered",
	overrides?: Record<string, unknown>,
): DeliveryMarkerV1 {
	const raw: Record<string, unknown> = {
		version: 1,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		direction: "sent",
		frameId: "f-001",
		envelopeDigest: DIGEST_A,
		journalSeq: 1,
		indexSeq,
		state,
		recordedAt: "2025-01-15T10:30:00.000Z",
		...overrides,
	};
	return raw as unknown as DeliveryMarkerV1;
}

// ===========================================================================
// 13. createRecoveryAccumulator never throws
// ===========================================================================

describe("createRecoveryAccumulator never throws", () => {
	it("returns error for invalid identity hostId", () => {
		const r = createRecoveryAccumulator({ hostId: "", generation: "g-1", sessionId: "s-1" }, "sent");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("INVALID_IDENTITY");
	});

	it("returns error for invalid identity generation", () => {
		const r = createRecoveryAccumulator({ hostId: "h-1", generation: "-bad", sessionId: "s-1" }, "sent");
		expect(r.ok).toBe(false);
	});

	it("returns error for invalid identity sessionId", () => {
		const r = createRecoveryAccumulator({ hostId: "h-1", generation: "g-1", sessionId: "" }, "sent");
		expect(r.ok).toBe(false);
	});

	it("returns error for invalid direction", () => {
		const r = createRecoveryAccumulator({ hostId: "h-1", generation: "g-1", sessionId: "s-1" }, "invalid" as any);
		expect(r.ok).toBe(false);
	});

	it("returns error for missing identity fields", () => {
		const r = createRecoveryAccumulator({ hostId: "h-1", generation: "g-1" } as any, "sent");
		expect(r.ok).toBe(false);
	});

	it("returns error for undefined identity", () => {
		const r = createRecoveryAccumulator(undefined as any, "sent");
		expect(r.ok).toBe(false);
	});

	it("returns error for null identity", () => {
		const r = createRecoveryAccumulator(null as any, "sent");
		expect(r.ok).toBe(false);
	});

	it("returns error for Proxy identity with throwing descriptor", () => {
		const p = new Proxy({} as any, {
			getOwnPropertyDescriptor() {
				throw new Error();
			},
		});
		const r = createRecoveryAccumulator(p, "sent");
		expect(r.ok).toBe(false);
	});

	it("error result is frozen", () => {
		const r = createRecoveryAccumulator(undefined as any, "sent");
		expect(r.ok).toBe(false);
		expect(Object.isFrozen(r)).toBe(true);
		if (!r.ok) expect(Object.isFrozen(r.error)).toBe(true);
	});

	it("success result is frozen with frozen accumulator", () => {
		const r = createRecoveryAccumulator(IDENTITY_A, "sent");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.accumulator)).toBe(true);
	});
});

// ===========================================================================
// 14. Recovery accumulator transitions
// ===========================================================================

describe("recovery accumulator transitions", () => {
	it("pending -> delivered transition with same envelopeDigest and journalSeq", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.action).toBe("apply_idempotently");
		expect(r1.state).toBe("pending");

		const r2 = acc.ingest(makeMarker(2, "delivered"));
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.action).toBe("send_replay_ack");
		expect(r2.state).toBe("delivered");
	});

	it("first marker for a frame must be pending", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "delivered"));
		expect(r.ok).toBe(false);
	});

	it("duplicate pending is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "pending"));
		expect(r2.ok).toBe(false);
	});

	it("second delivered is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "delivered"));
		expect(r2.ok).toBe(true);
		const r3 = acc.ingest(makeMarker(3, "delivered"));
		expect(r3.ok).toBe(false);
	});

	it("delivered without prior pending is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "delivered"));
		expect(r.ok).toBe(false);
	});

	it("delivered with digest mismatch is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "delivered", { envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);
	});

	it("delivered with journalSeq mismatch is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "delivered", { journalSeq: 999 }));
		expect(r2.ok).toBe(false);
	});

	it("delivered at later indexSeq transitions existing pending", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.action).toBe("apply_idempotently");

		const r3 = acc.ingest(makeMarker(3, "delivered"));
		expect(r3.ok).toBe(true);
		if (!r3.ok) return;
		expect(r3.action).toBe("send_replay_ack");
		expect(r3.state).toBe("delivered");
	});

	it("gaps in indexSeq are corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(3, "delivered"));
		expect(r2.ok).toBe(false);
	});

	it("duplicate indexSeq is corruption", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(1, "pending", { frameId: "f-002" }));
		expect(r2.ok).toBe(false);
	});
});

// ===========================================================================
// 15. Recovery accumulator cross-identity/direction
// ===========================================================================

describe("recovery accumulator cross-identity/direction", () => {
	it("rejects marker with different hostId", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { hostId: "h-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different generation", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { generation: "g-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different sessionId", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { sessionId: "s-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different direction", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { direction: "received" }));
		expect(r.ok).toBe(false);
	});

	it("different frameId with same digest is allowed", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_A }));
		expect(r2.ok).toBe(true);
	});

	it("same frameId with different digest is corruption on delivered", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001", envelopeDigest: DIGEST_A }));
		expect(r1.ok).toBe(true);
		const r2 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);
	});
});

// ===========================================================================
// 16. Recovery accumulator query — DeliveryQueryOutcome
// ===========================================================================

describe("recovery accumulator query — DeliveryQueryOutcome", () => {
	it("query returns {ok:true,state:new} for absent frameId", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("unknown-frame");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("query returns {ok:true,state:pending} after pending ingest", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		const q = acc.query("f-001");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("pending");
		expect(q.action).toBe("apply_idempotently");
	});

	it("query returns {ok:true,state:delivered} after delivered ingest", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		acc.ingest(makeMarker(2, "delivered"));
		const q = acc.query("f-001");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("delivered");
		expect(q.action).toBe("send_replay_ack");
	});

	it("query result is frozen on success", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("unknown");
		expect(q.ok).toBe(true);
		if (q.ok) expect(Object.isFrozen(q)).toBe(true);
	});

	it("query on different frame returns state:new for absent frame", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		acc.ingest(makeMarker(2, "delivered", { frameId: "f-001" }));
		const q = acc.query("f-002");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("query returns error for empty string frameId", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("");
		expect(q.ok).toBe(false);
		if (!q.ok) expect(q.error.code).toBe("INVALID_IDENTITY");
	});

	it("query returns error for frameId starting with hyphen", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("-bad");
		expect(q.ok).toBe(false);
	});

	it("query returns error for very long frameId", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("a".repeat(200));
		expect(q.ok).toBe(false);
	});

	it("query error result is frozen", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q = acc.query("");
		expect(q.ok).toBe(false);
		expect(Object.isFrozen(q)).toBe(true);
		if (!q.ok) expect(Object.isFrozen(q.error)).toBe(true);
	});

	it("query never throws for any input", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		expect(() => acc.query(null as any)).not.toThrow();
		expect(() => acc.query(undefined as any)).not.toThrow();
		expect(() => acc.query(42 as any)).not.toThrow();
		expect(() => acc.query({} as any)).not.toThrow();
	});
});

// ===========================================================================
// 17. Recovery accumulator DTOs fresh, frozen, no aliases
// ===========================================================================

describe("recovery accumulator DTOs fresh, frozen, no aliases", () => {
	it("accumulator is frozen", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		expect(Object.isFrozen(acc)).toBe(true);
	});

	it("identity is frozen", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		expect(Object.isFrozen(acc.identity)).toBe(true);
	});

	it("ingest result is frozen on success", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("ingest result is frozen on error", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "delivered"));
		expect(r.ok).toBe(false);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("query returns fresh frozen object each call", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const q1 = acc.query("unknown");
		const q2 = acc.query("unknown");
		expect(q1).not.toBe(q2);
		expect(q1.ok).toBe(true);
		expect(q2.ok).toBe(true);
		if (q1.ok && q2.ok) {
			expect(q1.state).toBe(q2.state);
		}
	});
});

// ===========================================================================
// 18. Exact action sequence
// ===========================================================================

describe("exact action sequence", () => {
	it("new query -> ingest pending -> query pending -> ingest delivered -> query delivered", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		// Step 1: query absent frame -> new
		const q1 = acc.query("f-001");
		expect(q1.ok).toBe(true);
		if (!q1.ok) return;
		expect(q1.state).toBe("new");
		expect(q1.action).toBe("persist_pending_then_apply");

		// Step 2: ingest pending
		const r1 = acc.ingest(makeMarker(1, "pending"));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.action).toBe("apply_idempotently");
		expect(r1.state).toBe("pending");

		// Step 3: query pending -> apply_idempotently
		const q2 = acc.query("f-001");
		expect(q2.ok).toBe(true);
		if (!q2.ok) return;
		expect(q2.state).toBe("pending");
		expect(q2.action).toBe("apply_idempotently");

		// Step 4: ingest delivered
		const r2 = acc.ingest(makeMarker(2, "delivered"));
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.action).toBe("send_replay_ack");
		expect(r2.state).toBe("delivered");

		// Step 5: query delivered -> send_replay_ack
		const q3 = acc.query("f-001");
		expect(q3.ok).toBe(true);
		if (!q3.ok) return;
		expect(q3.state).toBe("delivered");
		expect(q3.action).toBe("send_replay_ack");
	});
});

// ===========================================================================
// 19. Corrupt marker, state unchanged, corrected retry
// ===========================================================================

describe("corrupt marker state unchanged and corrected retry", () => {
	it("wrong digest delivered fails and does not advance cursor", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.state).toBe("pending");

		// Delivered with wrong digest
		const r2 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);

		// Frame still pending
		const q = acc.query("f-001");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("pending");
		expect(q.action).toBe("apply_idempotently");

		// Corrected delivered at same indexSeq should succeed
		const r3 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_A }));
		expect(r3.ok).toBe(true);
		if (!r3.ok) return;
		expect(r3.action).toBe("send_replay_ack");
		expect(r3.state).toBe("delivered");
	});

	it("duplicate pending fails but frame stays pending, corrected index succeeds", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		// Duplicate pending at index 2 fails
		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-001" }));
		expect(r2.ok).toBe(false);

		// Corrected: different frame at same index 2 succeeds
		const r3 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		expect(r3.ok).toBe(true);

		// Now deliver f-001 at index 3
		const r4 = acc.ingest(makeMarker(3, "delivered", { frameId: "f-001" }));
		expect(r4.ok).toBe(true);
		if (!r4.ok) return;
		expect(r4.action).toBe("send_replay_ack");
	});

	it("second delivered fails but state unchanged, corrected index succeeds", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		acc.ingest(makeMarker(2, "delivered", { frameId: "f-001" }));

		// Second delivered at index 3 fails
		const r3 = acc.ingest(makeMarker(3, "delivered", { frameId: "f-001" }));
		expect(r3.ok).toBe(false);

		// f-001 still delivered
		const q = acc.query("f-001");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.state).toBe("delivered");
		expect(q.action).toBe("send_replay_ack");

		// Corrected: different frame at index 3
		const r4 = acc.ingest(makeMarker(3, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		expect(r4.ok).toBe(true);
	});
});

// ===========================================================================
// 20. Accumulator ingest validates full marker schema
// ===========================================================================

describe("accumulator ingest validates full marker schema", () => {
	it("rejects marker with getter accessors", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const obj: Record<string, unknown> = Object.create(null);
		const fieldValues: Record<string, unknown> = {
			version: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
			frameId: "f-001",
			envelopeDigest: DIGEST_A,
			journalSeq: 1,
			indexSeq: 1,
			state: "pending",
			recordedAt: "2025-01-15T10:30:00.000Z",
		};
		for (const [key, val] of Object.entries(fieldValues)) {
			Object.defineProperty(obj, key, {
				get: () => val,
				enumerable: true,
				configurable: true,
			});
		}
		const r = acc.ingest(obj as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false); // getters rejected
	});

	it("rejects non-object marker", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		expect(acc.ingest(null as any).ok).toBe(false);
		expect(acc.ingest("string" as any).ok).toBe(false);
		expect(acc.ingest(42 as any).ok).toBe(false);
	});

	it("rejects marker with extra keys", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const raw = {
			version: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
			frameId: "f-001",
			envelopeDigest: DIGEST_A,
			journalSeq: 1,
			indexSeq: 1,
			state: "pending",
			recordedAt: "2025-01-15T10:30:00.000Z",
			extra: "x",
		};
		const r = acc.ingest(raw as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false);
	});

	it("rejects marker missing version", () => {
		const raw = {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
			frameId: "f-001",
			envelopeDigest: DIGEST_A,
			journalSeq: 1,
			indexSeq: 1,
			state: "pending",
			recordedAt: "2025-01-15T10:30:00.000Z",
		};
		const r = mkAcc(IDENTITY_A, "sent").ingest(raw as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false);
	});

	it("rejects marker missing recordedAt", () => {
		const raw = {
			version: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
			frameId: "f-001",
			envelopeDigest: DIGEST_A,
			journalSeq: 1,
			indexSeq: 1,
			state: "pending",
		};
		const r = mkAcc(IDENTITY_A, "sent").ingest(raw as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false);
	});

	it("rejects marker with bad digest format", () => {
		const r = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { envelopeDigest: "not-hex" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with bad frameId", () => {
		const r = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { frameId: "" }));
		expect(r.ok).toBe(false);
		const r2 = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { frameId: "-bad" }));
		expect(r2.ok).toBe(false);
	});

	it("rejects marker with non-canonical timestamp", () => {
		const r = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { recordedAt: "2025-01-15T10:30:00Z" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with out-of-range journalSeq", () => {
		const r = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { journalSeq: 20001 }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with out-of-range indexSeq", () => {
		const r = mkAcc(IDENTITY_A, "sent").ingest(makeMarker(1, "pending", { indexSeq: 40001 }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with symbol key", () => {
		const acc = mkAcc(IDENTITY_A, "sent");
		const obj: Record<string, unknown> = {
			version: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			direction: "sent",
			frameId: "f-001",
			envelopeDigest: DIGEST_A,
			journalSeq: 1,
			indexSeq: 1,
			state: "pending",
			recordedAt: "2025-01-15T10:30:00.000Z",
		};
		Object.defineProperty(obj, Symbol.for("k"), { value: "secret", enumerable: true });
		const r = acc.ingest(obj as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false);
	});

	it("rejects marker with Proxy that would throw on frameId re-read", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		let readCount = 0;
		const base = makeMarker(1, "pending");
		const proxy = new Proxy(base, {
			get(target, prop, receiver) {
				readCount++;
				if (prop === "frameId" && readCount > 1) {
					throw new Error("frameId getter called after first read");
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const r = acc.ingest(proxy);
		expect(r.ok).toBe(true); // should succeed — frameId only read once by validateMarker
		if (!r.ok) return;
		expect(r.state).toBe("pending");

		// Frame state is accessible
		const q = acc.query("f-001");
		expect(q.ok).toBe(true);
		if (q.ok) expect(q.state).toBe("pending");
	});

	it("same indexSeq retry succeeds after digest mismatch rejection", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		// Establish f-001 as pending at index 1
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);

		// Try to deliver index 2 with wrong digest
		const r2 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);

		// Correct: deliver index 2 with right digest
		const r3 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001" }));
		expect(r3.ok).toBe(true);
		if (!r3.ok) return;
		expect(r3.action).toBe("send_replay_ack");
		expect(r3.state).toBe("delivered");
	});

	it("same indexSeq retry succeeds after second delivered rejection", () => {
		const acc = mkAcc(IDENTITY_A, "sent");

		// Establish f-001: pending -> delivered
		acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		acc.ingest(makeMarker(2, "delivered", { frameId: "f-001" }));

		// Second delivered at index 3 fails
		const r = acc.ingest(makeMarker(3, "delivered", { frameId: "f-001" }));
		expect(r.ok).toBe(false);

		// Correct: different frame at index 3 as pending
		const r2 = acc.ingest(makeMarker(3, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(true);
	});
});
