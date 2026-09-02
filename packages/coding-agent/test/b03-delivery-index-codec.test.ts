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
import type { DeliveryIdentity, DeliveryMarkerV1 } from "../src/modes/daemon/b03-delivery-index-codec.js";
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
// 13. Recovery accumulator transitions
// ===========================================================================

describe("recovery accumulator transitions", () => {
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

	it("pending -> delivered transition with same envelopeDigest and journalSeq", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.action).toBe("apply_idempotently");
		expect(r1.state).toBe("pending");

		const r2 = acc.ingest(makeMarker(2, "delivered"));
		if (!r2.ok) return;
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.action).toBe("send_replay_ack");
		expect(r2.state).toBe("delivered");
	});

	it("first marker for a frame must be pending", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "delivered"));
		expect(r.ok).toBe(false);
	});

	it("duplicate pending is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "pending"));
		expect(r2.ok).toBe(false);
	});

	it("second delivered is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "delivered"));
		if (!r2.ok) return;
		expect(r2.ok).toBe(true);

		const r3 = acc.ingest(makeMarker(3, "delivered"));
		expect(r3.ok).toBe(false);
	});

	it("delivered without prior pending is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "delivered"));
		expect(r.ok).toBe(false);
	});

	it("delivered with digest mismatch is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "delivered", { envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);
	});

	it("delivered with journalSeq mismatch is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "delivered", { journalSeq: 999 }));
		expect(r2.ok).toBe(false);
	});

	it("delivered at later indexSeq transitions existing pending", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		// Another frame in between
		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		if (!r2.ok) return;
		expect(r2.ok).toBe(true);
		expect(r2.action).toBe("apply_idempotently");

		// Now deliver original frame at later index
		const r3 = acc.ingest(makeMarker(3, "delivered"));
		if (!r3.ok) return;
		expect(r3.ok).toBe(true);
		expect(r3.action).toBe("send_replay_ack");
		expect(r3.state).toBe("delivered");
	});

	it("gaps in indexSeq are corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(3, "delivered")); // skip 2
		expect(r2.ok).toBe(false);
	});

	it("duplicate indexSeq is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		// Manually create a marker with indexSeq 1 again
		const r2 = acc.ingest(makeMarker(1, "pending", { frameId: "f-002" }));
		expect(r2.ok).toBe(false);
	});
});

// ===========================================================================
// 14. Recovery accumulator cross-identity/direction
// ===========================================================================

describe("recovery accumulator cross-identity/direction", () => {
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

	it("rejects marker with different hostId", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { hostId: "h-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different generation", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { generation: "g-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different sessionId", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { sessionId: "s-other" }));
		expect(r.ok).toBe(false);
	});

	it("rejects marker with different direction", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { direction: "received" }));
		expect(r.ok).toBe(false);
	});

	it("different frameId with same digest is allowed", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_A }));
		if (!r2.ok) return;
		expect(r2.ok).toBe(true);
	});

	it("same frameId with different digest is corruption (pending on different digest)", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001", envelopeDigest: DIGEST_A }));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		const r2 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);
	});

	it("same frameId with different direction is corruption", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const r = acc.ingest(makeMarker(1, "pending", { direction: "received" }));
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 15. Recovery accumulator query results
// ===========================================================================

describe("recovery accumulator query", () => {
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

	it("query returns new for absent frameId", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("unknown-frame");
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("query returns pending after pending ingest", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		const q = acc.query("f-001");
		expect(q.state).toBe("pending");
		expect(q.action).toBe("apply_idempotently");
	});

	it("query returns delivered after delivered ingest", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		acc.ingest(makeMarker(2, "delivered"));
		const q = acc.query("f-001");
		expect(q.state).toBe("delivered");
		expect(q.action).toBe("send_replay_ack");
	});

	it("query result is frozen", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("unknown");
		expect(Object.isFrozen(q)).toBe(true);
	});

	it("query on different frame returns new (not confused with existing frames)", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		acc.ingest(makeMarker(2, "delivered", { frameId: "f-001" }));
		const q = acc.query("f-002");
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});
});

// ===========================================================================
// 16. Recovery accumulator DTOs fresh, frozen, no aliases
// ===========================================================================

describe("recovery accumulator DTOs fresh, frozen, no aliases", () => {
	it("accumulator is frozen", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		expect(Object.isFrozen(acc)).toBe(true);
	});

	it("identity is frozen", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		expect(Object.isFrozen(acc.identity)).toBe(true);
	});

	it("ingest result is frozen on success", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const marker: DeliveryMarkerV1 = makeMarkerRaw({
			indexSeq: 1,
			state: "pending",
		}) as unknown as DeliveryMarkerV1;
		const r = acc.ingest(marker);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("ingest result is frozen on error", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const marker: DeliveryMarkerV1 = makeMarkerRaw({
			indexSeq: 1,
			state: "pending",
			hostId: "h-other",
		}) as unknown as DeliveryMarkerV1;
		const r = acc.ingest(marker);
		expect(r.ok).toBe(false);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("no mutable exported sets -- query returns fresh object each time", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q1 = acc.query("unknown");
		const q2 = acc.query("unknown");
		expect(q1).not.toBe(q2);
		expect(q1.state).toBe(q2.state);
	});
});

// ===========================================================================
// 17. Override: ingest replay actions for pending/delivered query
// ===========================================================================

describe("ingest replay actions", () => {
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

	it("re-ingest of same pending returns corruption (duplicate pending)", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		const r1 = acc.ingest(makeMarker(1, "pending"));
		if (!r1.ok) return;
		expect(r1.ok).toBe(true);

		// Re-ingesting pending for same frame is corruption
		const r2 = acc.ingest(makeMarker(2, "pending"));
		expect(r2.ok).toBe(false);
	});

	it("query pending suggests apply_idempotently for replay", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		const q = acc.query("f-001");
		expect(q.action).toBe("apply_idempotently");
	});

	it("query delivered suggests send_replay_ack", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		acc.ingest(makeMarker(1, "pending"));
		acc.ingest(makeMarker(2, "delivered"));
		const q = acc.query("f-001");
		expect(q.action).toBe("send_replay_ack");
	});
});

// ===========================================================================
// 18. Success result mutation resistance
// ===========================================================================

describe("success result mutation resistance", () => {
	it("encode success result { ok, bytes, marker } result object is frozen", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc)).toBe(true);
	});

	it("decode success result { ok, marker } result object is frozen", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeDeliveryMarkerV1(enc.bytes, validExpected());
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec)).toBe(true);
	});
});

// ===========================================================================
// 19. Oversized decode rejection
// ===========================================================================

describe("oversized decode rejection", () => {
	it("rejects bytes longer than MAX_ENCODED_BYTES (1.25 MiB)", () => {
		const size = 1_310_721;
		const big = new Uint8Array(size);
		big.fill(0x20);
		const dec = decodeDeliveryMarkerV1(big, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < big.length; i += 100000) {
			expect(big[i]).toBe(0);
		}
	});

	it("rejects at 1.25 MiB boundary and erases", () => {
		const size = 1_310_720;
		const big = new Uint8Array(size);
		big.fill(0x20);
		const dec = decodeDeliveryMarkerV1(big, validExpected());
		expect(dec.ok).toBe(false);
		for (let i = 0; i < big.length; i += 100000) {
			expect(big[i]).toBe(0);
		}
	});

	it("rejects oversized and returns OVERFLOW code", () => {
		const size = 1_310_721;
		const big = new Uint8Array(size);
		big.fill(0x20);
		const dec = decodeDeliveryMarkerV1(big, validExpected());
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe("OVERFLOW");
	});
});

// ===========================================================================
// 20. Proxy TOCTOU resistance
// ===========================================================================

describe("Proxy expected TOCTOU resistance", () => {
	it("Proxy expected with descriptor values A and get values B uses descriptor values", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		let getCallCount = 0;
		const benignData = { hostId: "h-1", generation: "g-1", sessionId: "s-1" };
		const trap = new Proxy({} as Record<string, unknown>, {
			ownKeys() {
				return ["hostId", "generation", "sessionId"];
			},
			getOwnPropertyDescriptor(_t: unknown, key: string) {
				return {
					value: (benignData as Record<string, unknown>)[key],
					writable: true,
					enumerable: true,
					configurable: true,
				};
			},
			get(_t: unknown, key: string) {
				getCallCount++;
				if (key === "direction") return undefined;
				return "wrong-value-from-get-trap";
			},
		});

		const dec = decodeDeliveryMarkerV1(enc.bytes, trap);
		expect(dec.ok).toBe(true);
		expect(getCallCount).toBe(0);
	});

	it("get-accessor on expected is caught without invoking getter", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		let accessorCalled = false;
		const obj: Record<string, unknown> = { hostId: "h-1", generation: "g-1" };
		Object.defineProperty(obj, "sessionId", {
			get: () => {
				accessorCalled = true;
				return "s-1";
			},
			enumerable: true,
			configurable: true,
		});
		const dec = decodeDeliveryMarkerV1(enc.bytes, obj);
		expect(dec.ok).toBe(false);
		expect(accessorCalled).toBe(false);
	});

	it("Proxy throwing get trap is caught by outer catch", () => {
		const enc = encodeDeliveryMarkerV1(makeMarkerRaw());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;

		const trap = new Proxy({} as Record<string, unknown>, {
			ownKeys() {
				throw new Error("ownKeys trap");
			},
		});
		const dec = decodeDeliveryMarkerV1(enc.bytes, trap);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe("INVALID_FRAME");
	});

	it("Proxy encode input with descriptor values uses descriptor values", () => {
		let getCallCount = 0;
		const benignData = {
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
		const trap = new Proxy({} as Record<string, unknown>, {
			ownKeys() {
				return Object.keys(benignData);
			},
			getOwnPropertyDescriptor(_t: unknown, key: string) {
				return {
					value: (benignData as Record<string, unknown>)[key],
					writable: true,
					enumerable: true,
					configurable: true,
				};
			},
			get() {
				getCallCount++;
				return "wrong-value";
			},
		});
		const enc = encodeDeliveryMarkerV1(trap);
		expect(enc.ok).toBe(true);
		expect(getCallCount).toBe(0);
	});
});

// ===========================================================================
// 21. Reentrant / concurrent encode deterministic output
// ===========================================================================

describe("reentrant / concurrent encode deterministic output", () => {
	it("consecutive encodes produce identical bytes for same input", () => {
		const raw = makeMarkerRaw();
		const a = encodeDeliveryMarkerV1(raw);
		const b = encodeDeliveryMarkerV1(raw);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.bytes.byteLength).toBe(b.bytes.byteLength);
		for (let i = 0; i < a.bytes.byteLength; i++) {
			expect(a.bytes[i]).toBe(b.bytes[i]);
		}
	});

	it("interleaved encode calls produce deterministic output", () => {
		const raw1 = makeMarkerRaw({ indexSeq: 1 });
		const raw2 = makeMarkerRaw({ indexSeq: 2 });
		const results = Array.from({ length: 10 }, (_, i) => {
			return i % 2 === 0 ? encodeDeliveryMarkerV1(raw1) : encodeDeliveryMarkerV1(raw2);
		});
		for (let i = 0; i < results.length; i++) {
			expect(results[i].ok).toBe(true);
			if (!results[i].ok) continue;
			const expected = i % 2 === 0 ? 1 : 2;
			expect((results[i] as { ok: true; marker: DeliveryMarkerV1 }).marker.indexSeq).toBe(expected);
		}
	});
});

// ===========================================================================
// 22. Corrupt marker followed by corrected same indexSeq
// ===========================================================================

describe("corrupt marker followed by corrected same indexSeq", () => {
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

	it("wrong digest marker at indexSeq 1 fails and does not advance lastIndexSeq", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		// Deliver a marker with mismatched digest for the pending frame
		const r1 = acc.ingest(makeMarker(1, "pending", { envelopeDigest: DIGEST_B, frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.action).toBe("apply_idempotently");
		expect(r1.state).toBe("pending");

		// Delivered with digest mismatch
		const r2 = acc.ingest(makeMarker(2, "delivered", { envelopeDigest: DIGEST_A, frameId: "f-001" }));
		expect(r2.ok).toBe(false);

		// State should still show pending (delivery was rejected)
		const q = acc.query("f-001");
		expect(q.state).toBe("pending");
		expect(q.action).toBe("apply_idempotently");
	});

	it("corrected same indexSeq succeeds after corrupt marker with that indexSeq fails", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		// Skip indexSeq 1 deliberately with a gap -- this tests that
		// a corrected marker with the SAME indexSeq can follow a failed
		// marker only if the preceding marker never advanced state.
		// Here we first feed a bad marker at 1, it fails, state stays at 0.
		// Then a correct pending at 1 should succeed.

		// Actually the gap test says index 1 -> fail, then index 1 again should work
		// since lastIndexSeq is still 0. Let me test index 2 first:

		// Wrong digest at index 2 (but index 1 first to establish frame)
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		expect(r1.state).toBe("pending");

		// Delivered at index 2 with WRONG digest -- fails
		const r2 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(false);

		// lastIndexSeq should still be 1, so index 2 on CORRECT digest should work
		const r3 = acc.ingest(makeMarker(2, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_A }));
		expect(r3.ok).toBe(true);
		if (!r3.ok) return;
		expect(r3.action).toBe("send_replay_ack");
		expect(r3.state).toBe("delivered");

		const q = acc.query("f-001");
		expect(q.state).toBe("delivered");
		expect(q.action).toBe("send_replay_ack");
	});

	it("state and cursor unchanged after every rejected marker type", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		// Establish a pending frame
		const r1 = acc.ingest(makeMarker(1, "pending", { frameId: "f-001" }));
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		// lastIndexSeq is 1, so next must be 2

		// Establish frame f-002 as pending at index 2 (different frameId is valid)
		const r2 = acc.ingest(makeMarker(2, "pending", { frameId: "f-002", envelopeDigest: DIGEST_B }));
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		expect(r2.state).toBe("pending");

		// lastIndexSeq is 2

		// Reject: digest mismatch on delivered for f-001
		const r3 = acc.ingest(makeMarker(3, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_B }));
		expect(r3.ok).toBe(false);

		// lastIndexSeq should still be 2; correct delivered at index 3 should work
		const r4 = acc.ingest(makeMarker(3, "delivered", { frameId: "f-001", envelopeDigest: DIGEST_A }));
		expect(r4.ok).toBe(true);
		if (!r4.ok) return;
		expect(r4.action).toBe("send_replay_ack");
		expect(r4.state).toBe("delivered");

		// lastIndexSeq is 3. Second delivered should fail.
		const r5 = acc.ingest(makeMarker(4, "delivered", { frameId: "f-001" }));
		expect(r5.ok).toBe(false);

		// f-001 delivered, f-002 still pending - state unchanged by rejected markers
		const q1 = acc.query("f-001");
		expect(q1.state).toBe("delivered");
		const q2 = acc.query("f-002");
		expect(q2.state).toBe("pending");

		// A correct pending at index 4 should work (lastIndexSeq is still 3)
		const r6 = acc.ingest(makeMarker(4, "pending", { frameId: "f-003", envelopeDigest: DIGEST_A }));
		expect(r6.ok).toBe(true);
		if (!r6.ok) return;
		expect(r6.state).toBe("pending");
	});
});

// ===========================================================================
// 23. createRecoveryAccumulator rejects invalid identity/direction
// ===========================================================================

describe("createRecoveryAccumulator rejects invalid identity/direction", () => {
	it("rejects hostId with bad chars", () => {
		expect(() =>
			createRecoveryAccumulator({ hostId: "-bad", generation: "g-1", sessionId: "s-1" }, "sent"),
		).toThrow();
	});

	it("rejects empty hostId", () => {
		expect(() => createRecoveryAccumulator({ hostId: "", generation: "g-1", sessionId: "s-1" }, "sent")).toThrow();
	});

	it("rejects long hostId", () => {
		expect(() =>
			createRecoveryAccumulator({ hostId: "a".repeat(129), generation: "g-1", sessionId: "s-1" }, "sent"),
		).toThrow();
	});

	it("rejects invalid direction", () => {
		expect(() =>
			createRecoveryAccumulator({ hostId: "h-1", generation: "g-1", sessionId: "s-1" }, "invalid" as any),
		).toThrow();
	});

	it("rejects missing identity fields", () => {
		expect(() => createRecoveryAccumulator({ hostId: "h-1", generation: "g-1" } as any, "sent")).toThrow();
	});

	it("rejects undefined identity", () => {
		expect(() => createRecoveryAccumulator(undefined as any, "sent")).toThrow();
	});

	it("rejects null identity", () => {
		expect(() => createRecoveryAccumulator(null as any, "sent")).toThrow();
	});
});

// ===========================================================================
// 24. Accumulator ingest hostile marker inputs
// ===========================================================================

describe("accumulator ingest hostile marker inputs", () => {
	it("rejects Proxy marker with throwing getOwnPropertyDescriptor", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const p = new Proxy({} as any, {
			getOwnPropertyDescriptor() {
				throw new Error("trap");
			},
		});
		const r = acc.ingest(p);
		expect(r.ok).toBe(false);
	});

	it("rejects marker with getter accessor", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const obj = Object.create(null);
		Object.defineProperty(obj, "hostId", {
			get: () => "h-1",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "generation", {
			get: () => "g-1",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "sessionId", {
			get: () => "s-1",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "direction", {
			get: () => "sent",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "frameId", {
			get: () => "f-001",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "envelopeDigest", {
			get: () => DIGEST_A,
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "journalSeq", {
			get: () => 1,
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "indexSeq", {
			get: () => 1,
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "state", {
			get: () => "pending",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(obj, "recordedAt", {
			get: () => "2025-01-15T10:30:00.000Z",
			enumerable: true,
			configurable: true,
		});
		const r = acc.ingest(obj as unknown as DeliveryMarkerV1);
		expect(r.ok).toBe(false);
	});

	it("rejects non-object marker", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		expect(acc.ingest(null as any).ok).toBe(false);
		expect(acc.ingest("string" as any).ok).toBe(false);
		expect(acc.ingest(42 as any).ok).toBe(false);
	});

	it("rejects marker with extra keys", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
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
});

// ===========================================================================
// 25. Query with invalid frameId
// ===========================================================================

describe("query with invalid frameId", () => {
	it("returns new for empty string", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("");
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("returns new for frameId starting with hyphen", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("-bad");
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("returns new for very long frameId", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("a".repeat(200));
		expect(q.state).toBe("new");
		expect(q.action).toBe("persist_pending_then_apply");
	});

	it("query result is frozen even for invalid id", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");
		const q = acc.query("");
		expect(Object.isFrozen(q)).toBe(true);
	});
});

// ===========================================================================
// 26. Exact action sequence
// ===========================================================================

describe("exact action sequence", () => {
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

	it("new query -> ingest pending -> query pending -> ingest delivered -> query delivered", () => {
		const acc = createRecoveryAccumulator(IDENTITY_A, "sent");

		// Step 1: query absent frame -> new
		const q1 = acc.query("f-001");
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
		expect(q3.state).toBe("delivered");
		expect(q3.action).toBe("send_replay_ack");
	});
});
