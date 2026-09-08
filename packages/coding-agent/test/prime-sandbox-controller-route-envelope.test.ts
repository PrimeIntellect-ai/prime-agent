// Controller Route Envelope V1 — comprehensive proof tests.
//
// Covers: exact known vector; round trip for 1 and 128-byte fields;
// all identity boundary failures; proxy/accessor/symbol/prototype
// rejection; truncation at every header/field boundary; trailing;
// length mismatch; invalid ASCII; invalid magic; inner min/max/
// over-max; input mutation isolation; returned identity/frame frozen
// as applicable; owned inner byte isolation and input zeroing
// expectations consistent with strict-copy ownership.
//
// V31 max = 262128. Header = 16. Identity fields = 1..128 each.
// Inner minimum = 1 (non-zero V16 request).
// Inner maximum depends on identity field lengths.
//
// No casts, asserts, throws, spreads, any, non-null assertions,
// no suppression directives, instanceof at hostile boundary,
// Object.setPrototypeOf, broad errors, structural brands, or
// swallowed catches.

import { describe, expect, it } from "vitest";
import {
	type ControllerRouteDecodeResult,
	type ControllerRouteDecodeSuccess,
	type ControllerRouteEncodeResult,
	type ControllerRouteEncodeSuccess,
	decodeControllerRouteEnvelope,
	encodeControllerRouteEnvelope,
} from "../src/modes/daemon/sandbox/prime-sandbox-controller-route-envelope.js";

// ---------- constants ----------

const HEADER_SIZE: number = 16;
const MAX_TOTAL: number = 262128;

// ---------- helpers ----------

function readUint32BE(buf: Uint8Array, offset: number): number {
	return (
		((buf[offset] << 24) >>> 0) + ((buf[offset + 1] << 16) >>> 0) + ((buf[offset + 2] << 8) >>> 0) + buf[offset + 3]
	);
}

function identity(childId: string, sessionId: string, sessionName: string, modelSelector: string): object {
	return { childId, sessionId, sessionName, modelSelector };
}

function makeField(n: number): string {
	return "A".repeat(n);
}

function makeIdentity(a: number, b: number, c: number, d: number): object {
	return identity(makeField(a), makeField(b), makeField(c), makeField(d));
}

function encodeOk(id: object, inner: Uint8Array): ControllerRouteEncodeSuccess | undefined {
	var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
	if (!r.ok) return undefined;
	return r;
}

function decodeOk(input: Uint8Array): ControllerRouteDecodeSuccess | undefined {
	var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(input);
	if (!r.ok) return undefined;
	return r;
}

// ---------- exact known vector ----------

describe("known vector", () => {
	it("produces deterministic binary for fixed inputs", () => {
		var id: object = identity("c01", "s01", "agent-x", "flash");
		var inner: Uint8Array = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
		var enc: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		var s: ControllerRouteEncodeSuccess = enc;
		var bytes: Uint8Array = s.bytes;

		expect(bytes.length).toBe(HEADER_SIZE + 3 + 3 + 7 + 5 + 5);
		expect(bytes[0]).toBe(0x43);
		expect(bytes[1]).toBe(0x52);
		expect(bytes[2]).toBe(0x54);
		expect(bytes[3]).toBe(0x52);
		expect(bytes[4]).toBe(0x45);
		expect(bytes[5]).toBe(0x4e);
		expect(bytes[6]).toBe(0x56);
		expect(bytes[7]).toBe(0x00);
		expect(bytes[8]).toBe(3);
		expect(bytes[9]).toBe(3);
		expect(bytes[10]).toBe(7);
		expect(bytes[11]).toBe(5);
		expect(readUint32BE(bytes, 12)).toBe(5);

		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.identity.childId).toBe("c01");
		expect(dec.identity.sessionId).toBe("s01");
		expect(dec.identity.sessionName).toBe("agent-x");
		expect(dec.identity.modelSelector).toBe("flash");
		expect(dec.inner.length).toBe(5);
		expect(dec.inner[0]).toBe(0x48);
		expect(dec.inner[1]).toBe(0x65);
		expect(dec.inner[2]).toBe(0x6c);
		expect(dec.inner[3]).toBe(0x6c);
		expect(dec.inner[4]).toBe(0x6f);
	});

	it("decode of known vector yields frozen identity", () => {
		var id: object = identity("x1", "y2", "z3", "w4");
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var dec: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		var ds: ControllerRouteDecodeSuccess = dec;
		expect(Object.isFrozen(ds)).toBe(true);
		expect(Object.isFrozen(ds.identity)).toBe(true);
	});
});

// ---------- round trip for 1 and 128-byte fields ----------

describe("round trip field boundary lengths", () => {
	it("round trips all 1-byte identity fields", () => {
		var id: object = makeIdentity(1, 1, 1, 1);
		var inner: Uint8Array = new Uint8Array([0x01, 0x02]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(s.bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.identity.childId).toBe(makeField(1));
		expect(dec.identity.sessionId).toBe(makeField(1));
		expect(dec.identity.sessionName).toBe(makeField(1));
		expect(dec.identity.modelSelector).toBe(makeField(1));
		expect(dec.inner.length).toBe(2);
		expect(dec.inner[0]).toBe(0x01);
		expect(dec.inner[1]).toBe(0x02);
	});

	it("round trips all 128-byte identity fields", () => {
		var id: object = makeIdentity(128, 128, 128, 128);
		var inner: Uint8Array = new Uint8Array(10);
		for (let i: number = 0; i < 10; i++) inner[i] = i + 100;
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		expect(s.bytes.length).toBe(HEADER_SIZE + 4 * 128 + 10);
		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(s.bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.identity.childId).toBe(makeField(128));
		expect(dec.identity.sessionId).toBe(makeField(128));
		expect(dec.identity.sessionName).toBe(makeField(128));
		expect(dec.identity.modelSelector).toBe(makeField(128));
		expect(dec.inner.length).toBe(10);
	});

	it("round trips with all fields at mixed lengths", () => {
		var id: object = identity("a", "bb", "ccc", "dddd");
		var inner: Uint8Array = new Uint8Array([0x10]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(s.bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.identity.childId).toBe("a");
		expect(dec.identity.sessionId).toBe("bb");
		expect(dec.identity.sessionName).toBe("ccc");
		expect(dec.identity.modelSelector).toBe("dddd");
	});
});

// ---------- identity boundary failures ----------

describe("identity validation failures", () => {
	it("rejects null identity", () => {
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(null, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects non-object identity", () => {
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope("bad", new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with wrong prototype", () => {
		var id: Record<string, string> = Object.create(null);
		id.childId = "c01";
		id.sessionId = "s01";
		id.sessionName = "a";
		id.modelSelector = "m";
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with extra key", () => {
		var id: object = { childId: "c", sessionId: "s", sessionName: "n", modelSelector: "m", extra: "x" };
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with missing key", () => {
		var id: object = { childId: "c", sessionId: "s", sessionName: "n" };
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with getter (accessor)", () => {
		var id: object = {
			get childId(): string {
				return "c";
			},
			sessionId: "s",
			sessionName: "n",
			modelSelector: "m",
		};
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with symbol key", () => {
		var sym: symbol = Symbol("test");
		var id: object = { childId: "c", sessionId: "s", sessionName: "n", modelSelector: "m" };
		Object.defineProperty(id, sym, { value: 1, enumerable: true });
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with Proxy", () => {
		var target: object = { childId: "c", sessionId: "s", sessionName: "n", modelSelector: "m" };
		var proxy: object = new Proxy(target, {});
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(proxy, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with non-string field value", () => {
		var id: object = { childId: 42, sessionId: "s", sessionName: "n", modelSelector: "m" };
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity field with invalid characters (newline)", () => {
		var id: object = identity("c\n01", "s01", "a", "m");
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity field with too-long value", () => {
		var id: object = makeIdentity(129, 1, 1, 1);
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects identity with empty string field", () => {
		var id: object = identity("", "s", "n", "m");
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});
});

// ---------- inner payload boundary ----------

describe("inner payload boundaries", () => {
	it("rejects zero-length inner", () => {
		var id: object = makeIdentity(5, 5, 5, 5);
		var inner: Uint8Array = new Uint8Array(0);
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(r.ok).toBe(false);
	});

	it("encodes and decodes max inner payload (1-byte IDs)", () => {
		var id: object = makeIdentity(1, 1, 1, 1);
		var maxInner: number = MAX_TOTAL - HEADER_SIZE - 4;
		var inner: Uint8Array = new Uint8Array(maxInner);
		inner[0] = 0xaa;
		inner[maxInner - 1] = 0xbb;
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(s.bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.inner.length).toBe(maxInner);
		expect(dec.inner[0]).toBe(0xaa);
		expect(dec.inner[maxInner - 1]).toBe(0xbb);
	});

	it("encodes and decodes max inner payload (128-byte IDs)", () => {
		var id: object = makeIdentity(128, 128, 128, 128);
		var maxInner: number = MAX_TOTAL - HEADER_SIZE - 512;
		var inner: Uint8Array = new Uint8Array(maxInner);
		inner[0] = 0xcc;
		inner[maxInner - 1] = 0xdd;
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var dec: ControllerRouteDecodeSuccess | undefined = decodeOk(s.bytes);
		expect(dec).not.toBe(undefined);
		if (dec === undefined) return;
		expect(dec.inner.length).toBe(maxInner);
		expect(dec.inner[0]).toBe(0xcc);
		expect(dec.inner[maxInner - 1]).toBe(0xdd);
	});

	it("rejects inner over max for 1-byte IDs", () => {
		var id: object = makeIdentity(1, 1, 1, 1);
		var inner: Uint8Array = new Uint8Array(MAX_TOTAL - HEADER_SIZE - 4 + 1);
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(r.ok).toBe(false);
	});

	it("rejects inner with wrong input type", () => {
		var id: object = makeIdentity(5, 5, 5, 5);
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, "not-bytes");
		expect(r.ok).toBe(false);
	});
});

// ---------- truncation boundaries ----------

describe("truncation at every header/field boundary", () => {
	it("rejects empty input", () => {
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(new Uint8Array(0));
		expect(r.ok).toBe(false);
	});

	it("rejects truncated at header boundary", () => {
		var id: object = identity("c01", "s01", "agent-x", "flash");
		var inner: Uint8Array = new Uint8Array([0x01]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		for (let cut: number = 1; cut < HEADER_SIZE; cut++) {
			const truncated: Uint8Array = s.bytes.slice(0, cut);
			const r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(truncated);
			expect(r.ok).toBe(false);
		}
	});

	it("rejects truncated at each identity field boundary", () => {
		var id: object = identity("abc", "def", "ghi", "jkl");
		var inner: Uint8Array = new Uint8Array([0x01]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		for (let cut: number = HEADER_SIZE; cut < s.bytes.length - 1; cut++) {
			const truncated: Uint8Array = s.bytes.slice(0, cut);
			const r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(truncated);
			expect(r.ok).toBe(false);
		}
	});

	it("rejects truncated at inner payload boundary", () => {
		var id: object = identity("x", "y", "z", "w");
		var inner: Uint8Array = new Uint8Array([0x01, 0x02]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var atInner: number = HEADER_SIZE + 1 + 1 + 1 + 1;
		var truncated: Uint8Array = s.bytes.slice(0, atInner + 1);
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(truncated);
		expect(r.ok).toBe(false);
	});
});

// ---------- trailing / length mismatch ----------

describe("trailing bytes and length mismatch", () => {
	it("rejects trailing bytes", () => {
		var id: object = identity("a", "b", "c", "d");
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var trailing: Uint8Array = new Uint8Array(s.bytes.length + 1);
		trailing.set(s.bytes);
		trailing[s.bytes.length] = 0xff;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(trailing);
		expect(r.ok).toBe(false);
	});

	it("rejects inner length field larger than actual data", () => {
		var id: object = identity("a", "b", "c", "d");
		var inner: Uint8Array = new Uint8Array([0x01]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var modified: Uint8Array = new Uint8Array(s.bytes);
		modified[12] = 0;
		modified[13] = 0;
		modified[14] = 0;
		modified[15] = 100;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(modified);
		expect(r.ok).toBe(false);
	});

	it("rejects inner length field smaller than actual data", () => {
		var id: object = identity("a", "b", "c", "d");
		var inner: Uint8Array = new Uint8Array([0x01, 0x02]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var modified: Uint8Array = new Uint8Array(s.bytes);
		modified[12] = 0;
		modified[13] = 0;
		modified[14] = 0;
		modified[15] = 1;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(modified);
		expect(r.ok).toBe(false);
	});

	it("rejects inner length field of zero (non-zero inner required)", () => {
		var id: object = identity("a", "b", "c", "d");
		var inner: Uint8Array = new Uint8Array([0x01]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var modified: Uint8Array = new Uint8Array(s.bytes);
		modified[12] = 0;
		modified[13] = 0;
		modified[14] = 0;
		modified[15] = 0;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(modified);
		expect(r.ok).toBe(false);
	});
});

// ---------- invalid magic ----------

describe("magic validation", () => {
	it("rejects all-zero first 8 bytes", () => {
		var bytes: Uint8Array = new Uint8Array(HEADER_SIZE + 4);
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(bytes);
		expect(r.ok).toBe(false);
	});

	it("rejects wrong magic byte at each position", () => {
		var id: object = makeIdentity(3, 3, 3, 3);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		for (let pos: number = 0; pos < 8; pos++) {
			const modified: Uint8Array = new Uint8Array(s.bytes);
			modified[pos] = modified[pos] ^ 0xff;
			const r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(modified);
			expect(r.ok).toBe(false);
		}
	});
});

// ---------- field length validation (decode) ----------

describe("field length validation on decode", () => {
	it("rejects field length of 0", () => {
		var id: object = makeIdentity(3, 3, 3, 3);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		s.bytes[8] = 0;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(r.ok).toBe(false);
	});

	it("rejects field length of 129", () => {
		var id: object = makeIdentity(3, 3, 3, 3);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		s.bytes[8] = 129;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(r.ok).toBe(false);
	});

	it("rejects one field length being 128 and another being 0", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 128 + 1 + 1 + 1 + 1);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 128;
		frame[9] = 0;
		frame[10] = 1;
		frame[11] = 1;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});

	it("rejects truncated frame with valid header but no body", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 4);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 3;
		frame[9] = 3;
		frame[10] = 3;
		frame[11] = 3;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});
});

// ---------- invalid inner length (decode) ----------

describe("inner length validation on decode", () => {
	it("rejects inner length of 0 on decode", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 4 + 1);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 1;
		frame[9] = 1;
		frame[10] = 1;
		frame[11] = 1;
		frame[12] = 0;
		frame[13] = 0;
		frame[14] = 0;
		frame[15] = 0;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});

	it("rejects inner length that makes expectedTotal exceed MAX_TOTAL", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 4 + 2);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 1;
		frame[9] = 1;
		frame[10] = 1;
		frame[11] = 1;
		frame[12] = 0x04;
		frame[13] = 0x00;
		frame[14] = 0x01;
		frame[15] = 0x00;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});
});

// ---------- non-ASCII identity bytes ----------

describe("non-ASCII identity bytes", () => {
	it("rejects identity field with invalid characters (pattern)", () => {
		var id: object = identity("c\xff01", "s01", "a", "m");
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(false);
	});

	it("rejects decode of frame with high-bit in identity field", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 3 + 1 + 1 + 1 + 2);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 3;
		frame[9] = 1;
		frame[10] = 1;
		frame[11] = 1;
		frame[12] = 0;
		frame[13] = 0;
		frame[14] = 0;
		frame[15] = 2;
		frame[16] = 0x63;
		frame[17] = 0xff;
		frame[18] = 0x31;
		frame[19] = 0x61;
		frame[20] = 0x62;
		frame[21] = 0x63;
		frame[22] = 0x01;
		frame[23] = 0x02;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});

	it("rejects identity with control byte", () => {
		var frame: Uint8Array = new Uint8Array(HEADER_SIZE + 2 + 1 + 1 + 1 + 2);
		frame[0] = 0x43;
		frame[1] = 0x52;
		frame[2] = 0x54;
		frame[3] = 0x52;
		frame[4] = 0x45;
		frame[5] = 0x4e;
		frame[6] = 0x56;
		frame[7] = 0x00;
		frame[8] = 2;
		frame[9] = 1;
		frame[10] = 1;
		frame[11] = 1;
		frame[12] = 0;
		frame[13] = 0;
		frame[14] = 0;
		frame[15] = 2;
		frame[16] = 0x00;
		frame[17] = 0x61;
		frame[18] = 0x62;
		frame[19] = 0x63;
		frame[20] = 0x64;
		frame[21] = 0x01;
		frame[22] = 0x02;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(r.ok).toBe(false);
	});
});

// ---------- input mutation isolation ----------

describe("input mutation isolation", () => {
	it("encoder does not alias input inner bytes", () => {
		var inner: Uint8Array = new Uint8Array([0x01, 0x02, 0x03]);
		var id: object = identity("a", "b", "c", "d");
		var enc: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		var s: ControllerRouteEncodeSuccess = enc;
		inner[0] = 0xff;
		var dec: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		var ds: ControllerRouteDecodeSuccess = dec;
		expect(ds.inner[0]).toBe(0x01);
	});

	it("decoder returns fresh owned inner buffer", () => {
		var id: object = identity("a", "b", "c", "d");
		var inner: Uint8Array = new Uint8Array([0x10, 0x20]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var frame: Uint8Array = s.bytes;
		var dec: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		var ds: ControllerRouteDecodeSuccess = dec;
		ds.inner[0] = 0xff;
		var dec2: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(frame);
		expect(dec2.ok).toBe(true);
		if (!dec2.ok) return;
		var ds2: ControllerRouteDecodeSuccess = dec2;
		expect(ds2.inner[0]).toBe(0x10);
	});

	it("encode handles frozen identity object", () => {
		var id: object = Object.freeze(identity("frozen", "id", "test", "sel"));
		var inner: Uint8Array = new Uint8Array([0x01]);
		var enc: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(enc.ok).toBe(true);
	});

	it("encode returns frozen result", () => {
		var id: object = identity("a", "b", "c", "d");
		var r: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, new Uint8Array([0x01]));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("decode returns frozen result and frozen identity", () => {
		var id: object = identity("a", "b", "c", "d");
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, new Uint8Array([0x01]));
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
		var ds: ControllerRouteDecodeSuccess = r;
		expect(Object.isFrozen(ds.identity)).toBe(true);
	});

	it("decoder does not alias input bytes (strict-copy ownership)", () => {
		var id: object = identity("a", "b", "c", "d");
		var inner: Uint8Array = new Uint8Array([0x01, 0x02]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(id, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		var originalFrame: Uint8Array = new Uint8Array(s.bytes);
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(originalFrame);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(originalFrame[0]).toBe(0x43);
		expect(originalFrame[16]).toBe(0x61);
		var ds: ControllerRouteDecodeSuccess = r;
		expect(ds.inner.length).toBe(2);
		expect(ds.inner[0]).toBe(0x01);
		expect(ds.inner[1]).toBe(0x02);
	});

	it("encoder does not alias identity object", () => {
		var idObj: { childId: string; sessionId: string; sessionName: string; modelSelector: string } = {
			childId: "a",
			sessionId: "b",
			sessionName: "c",
			modelSelector: "d",
		};
		var inner: Uint8Array = new Uint8Array([0x01]);
		var s: ControllerRouteEncodeSuccess | undefined = encodeOk(idObj, inner);
		expect(s).not.toBe(undefined);
		if (s === undefined) return;
		idObj.childId = "mutated";
		var dec: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		var ds: ControllerRouteDecodeSuccess = dec;
		expect(ds.identity.childId).toBe("a");
	});
});

// ---------- non-strict input type rejection ----------

describe("non-strict byte input rejection", () => {
	it("rejects null input on decode", () => {
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(null);
		expect(r.ok).toBe(false);
	});

	it("rejects string input on decode", () => {
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope("bad");
		expect(r.ok).toBe(false);
	});

	it("rejects Array input on decode", () => {
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope([1, 2, 3]);
		expect(r.ok).toBe(false);
	});

	it("rejects Proxy-wrapped Uint8Array on decode", () => {
		var arr: Uint8Array = new Uint8Array(HEADER_SIZE + 4);
		var proxy: object = new Proxy(arr, {});
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(proxy);
		expect(r.ok).toBe(false);
	});
});

// ---------- identity with valid special characters ----------

describe("identity with allowed special characters", () => {
	it("accepts underscores, dots, slashes, colons, hyphens in identity", () => {
		var id: object = identity("child_01", "sess.ion", "agent/name", "model:sel-1");
		var inner: Uint8Array = new Uint8Array([0x01]);
		var enc: ControllerRouteEncodeResult = encodeControllerRouteEnvelope(id, inner);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		var s: ControllerRouteEncodeSuccess = enc;
		var dec: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(s.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		var ds: ControllerRouteDecodeSuccess = dec;
		expect(ds.identity.childId).toBe("child_01");
		expect(ds.identity.sessionId).toBe("sess.ion");
		expect(ds.identity.sessionName).toBe("agent/name");
		expect(ds.identity.modelSelector).toBe("model:sel-1");
	});
});

// ---------- oversized decode input ----------

describe("oversized decode input", () => {
	it("rejects input exceeding MAX_TOTAL", () => {
		var large: Uint8Array = new Uint8Array(MAX_TOTAL + 1);
		large[0] = 0x43;
		large[1] = 0x52;
		large[2] = 0x54;
		large[3] = 0x52;
		large[4] = 0x45;
		large[5] = 0x4e;
		large[6] = 0x56;
		large[7] = 0x00;
		var r: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(large);
		expect(r.ok).toBe(false);
	});
});
