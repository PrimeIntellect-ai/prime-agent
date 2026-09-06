// V15 Application Codec — focused test
//
// Ports all meaningful boundary/adversarial behaviors from the proof test
// (~305 checks) into compact vitest groupings. No copy-only tests, no
// mutation fixtures in repo.
//
// No casts, asserts, throws, spreads, any, non-null assertions,
// instanceof at hostile boundary, suppression directives,
// Object.setPrototypeOf, broad errors, structural brands, or
// swallowed catches.

import { describe, expect, it } from "vitest";
import {
	type DecodeCancelAckFrame,
	type DecodeCancelFrame,
	type DecodeDeliveryAckFrame,
	type DecodeReplyFrame,
	type DecodeRequestFrame,
	type DecodeResult,
	decodeAppFrame,
	type EncodeResult,
	encodeAppFrame,
	KIND_CANCEL,
	KIND_CANCEL_ACK,
	KIND_DELIVERY_ACK,
	KIND_REPLY,
	KIND_REQUEST,
} from "../src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.js";

// ---- Constants ----

const MAX_REQUEST_ID: bigint = 0xffff_ffff_ffff_ffffn;
const HEADER_SIZE: number = 16;
const MAX_PAYLOAD: number = 262128;

const KINDS_ALL: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
const STREAMS_ALL: readonly number[] = Object.freeze([0, 1, 2, 3, 4]);
const DATA_KINDS: readonly number[] = Object.freeze([1, 3]);
const CONTROL_KINDS: readonly number[] = Object.freeze([2, 4, 5]);

// ---- Helpers ----

function encodeOk(result: EncodeResult): asserts result is { readonly ok: true; readonly frame: Uint8Array } {
	expect(result.ok).toBe(true);
}

function expectEncodeFails(result: EncodeResult, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function expectDecodeFails(result: DecodeResult, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function u8(values: number[]): Uint8Array {
	const buf = new Uint8Array(values.length);
	for (let i = 0; i < values.length; i += 1) buf[i] = values[i];
	return buf;
}

function sequence(start: number, length: number): Uint8Array {
	const buf = new Uint8Array(length);
	for (let i = 0; i < length; i += 1) buf[i] = (start + i) & 0xff;
	return buf;
}

function mutateByte(frame: Uint8Array, idx: number, value: number): Uint8Array {
	const out = new Uint8Array(frame.length);
	for (let i = 0; i < frame.length; i += 1) out[i] = frame[i];
	out[idx] = value;
	return out;
}

function validFrame(): Uint8Array {
	const enc = encodeAppFrame(KIND_REQUEST, 2, 42n, sequence(0xa0, 8));
	encodeOk(enc);
	return enc.frame;
}

// ===================================================================
// Tests
// ===================================================================

describe("V15 application codec", () => {
	// ---------- 1. Every kind x every stream ----------
	it("encodes and decodes every kind x every stream", () => {
		for (const kind of KINDS_ALL) {
			for (const stream of STREAMS_ALL) {
				const isData = kind === 1 || kind === 3;
				const enc = encodeAppFrame(kind, stream, 42n, isData ? u8([0xab, 0xcd]) : undefined);
				encodeOk(enc);
				const dec = decodeAppFrame(enc.frame);
				expect(dec.ok).toBe(true);
				if (!dec.ok) return;
				expect(dec.kind).toBe(kind);
				expect(dec.stream).toBe(stream);
			}
		}
	});

	// ---------- 2. requestId edge cases ----------
	it("handles requestId edge cases", () => {
		// ID=1 (min valid)
		expect(encodeAppFrame(KIND_REQUEST, 0, 1n, u8([])).ok).toBe(true);
		// ID=0 rejected
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 0n, u8([])), "INVALID_REQUEST_ID");
		// ID=MAX
		expect(encodeAppFrame(KIND_REQUEST, 0, MAX_REQUEST_ID, u8([])).ok).toBe(true);
		// ID=MAX+1 rejected (overflow)
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, MAX_REQUEST_ID + 1n, u8([])), "INVALID_REQUEST_ID");
		// ID=-1n rejected
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, -1n, u8([])), "INVALID_REQUEST_ID");
		// ID=very-negative rejected
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, -9999999999999999999n, u8([])), "INVALID_REQUEST_ID");
		// ID=0 on decode
		const frame = validFrame();
		const zeroIdMut = new Uint8Array(frame.length);
		for (let i = 0; i < frame.length; i += 1) zeroIdMut[i] = i >= 4 && i <= 11 ? 0 : frame[i];
		expectDecodeFails(decodeAppFrame(zeroIdMut), "INVALID_REQUEST_ID");
	});

	// ---------- 3. Payload edge cases ----------
	it("handles payload edge cases", () => {
		// Empty payload (explicit)
		const encEmpty = encodeAppFrame(KIND_REQUEST, 1, 100n, u8([]));
		encodeOk(encEmpty);
		expect(encEmpty.frame.length).toBe(HEADER_SIZE);
		const decEmpty = decodeAppFrame(encEmpty.frame);
		expect(decEmpty.ok).toBe(true);
		if (!decEmpty.ok) return;
		if (decEmpty.kind === 1) expect(decEmpty.payload.length).toBe(0);

		// Omitted payload for data kind rejected
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 1, 101n, undefined), "DATA_PAYLOAD_REQUIRED");

		// Single-byte payload
		const encSingle = encodeAppFrame(KIND_REQUEST, 2, 200n, u8([0x42]));
		encodeOk(encSingle);
		expect(encSingle.frame.length).toBe(32);
		const decSingle = decodeAppFrame(encSingle.frame);
		expect(decSingle.ok).toBe(true);
		if (!decSingle.ok) return;
		if (decSingle.kind === 1) {
			expect(decSingle.payload.length).toBe(1);
			expect(decSingle.payload[0]).toBe(0x42);
		}

		// Payload max+1 rejected
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 1, 400n, new Uint8Array(MAX_PAYLOAD + 1)), "PAYLOAD_TOO_LARGE");
	});

	// ---------- 4. All 0..15 padding lengths ----------
	it("handles all padding lengths 0..15", () => {
		for (let paddingLen = 0; paddingLen <= 15; paddingLen += 1) {
			const payload = sequence(0, paddingLen);
			const enc = encodeAppFrame(KIND_REQUEST, 0, BigInt(500 + paddingLen), payload);
			encodeOk(enc);
			const paddedExpected = ((HEADER_SIZE + paddingLen + 15) >>> 0) & ~15;
			expect(enc.frame.length).toBe(paddedExpected);
			const dec = decodeAppFrame(enc.frame);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			if (dec.kind === 1) expect(dec.payload.length).toBe(paddingLen);
		}
	});

	// ---------- 5. Invalid header mutations ----------
	it("rejects invalid header mutations", () => {
		const base = validFrame();

		// Reserved bytes (2, 3) non-zero
		for (const byteIdx of [2, 3]) {
			for (const val of [1, 0x80, 0xff]) {
				expectDecodeFails(decodeAppFrame(mutateByte(base, byteIdx, val)), "RESERVED_NONZERO");
			}
		}

		// Invalid kind values
		for (const badKind of [0, 6, 7, 255]) {
			expectDecodeFails(decodeAppFrame(mutateByte(base, 0, badKind)), "INVALID_KIND");
		}

		// Invalid stream values (>4)
		for (const badStream of [5, 6, 255]) {
			expectDecodeFails(decodeAppFrame(mutateByte(base, 1, badStream)), "INVALID_STREAM");
		}
	});

	// ---------- 6. Length mismatch ----------
	it("rejects length mismatches", () => {
		const base = validFrame();

		// Truncated frame
		const truncated = new Uint8Array(base.length - 1);
		for (let i = 0; i < truncated.length; i += 1) truncated[i] = base[i];
		expectDecodeFails(decodeAppFrame(truncated), "WRONG_PADDED_LENGTH");

		// Extended frame (trailing byte)
		const extended = new Uint8Array(base.length + 1);
		for (let i = 0; i < base.length; i += 1) extended[i] = base[i];
		extended[base.length] = 0;
		expectDecodeFails(decodeAppFrame(extended), "WRONG_PADDED_LENGTH");

		// unpaddedLength=16 on 32-byte buffer
		const mod16 = mutateByte(mutateByte(mutateByte(mutateByte(base, 12, 0), 13, 0), 14, 0), 15, 16);
		expectDecodeFails(decodeAppFrame(mod16), "WRONG_PADDED_LENGTH");

		// unpaddedLength=17 on 32-byte buffer (non-zero at idx 17)
		const mod17 = mutateByte(mutateByte(mutateByte(mutateByte(base, 12, 0), 13, 0), 14, 0), 15, 17);
		expectDecodeFails(decodeAppFrame(mod17), "PADDING_NONZERO");

		// unpaddedLength=262145: strictBytes rejects at MAX_UNPADDED (262144) => INPUT_TOO_LARGE
		const bigBuf = new Uint8Array(262160);
		for (let i = 0; i < base.length && i < bigBuf.length; i += 1) bigBuf[i] = base[i];
		bigBuf[12] = 0x00;
		bigBuf[13] = 0x04;
		bigBuf[14] = 0x00;
		bigBuf[15] = 0x01;
		expectDecodeFails(decodeAppFrame(bigBuf), "INPUT_TOO_LARGE");

		// UnpaddedLength=15 (< 16)
		const mod15 = mutateByte(mutateByte(mutateByte(mutateByte(base, 12, 0), 13, 0), 14, 0), 15, 15);
		expectDecodeFails(decodeAppFrame(mod15), "BAD_UNPADDED_LENGTH");

		// Buffer length < 16
		for (let len = 0; len < 16; len += 1) {
			const short = new Uint8Array(len);
			for (let i = 0; i < len; i += 1) short[i] = base[i];
			expectDecodeFails(decodeAppFrame(short), "TOO_SHORT");
		}
	});

	// ---------- 7. Non-zero padding ----------
	it("rejects non-zero padding bytes", () => {
		const enc = encodeAppFrame(KIND_REQUEST, 1, 800n, u8([0xaa]));
		encodeOk(enc);
		const frame = enc.frame;
		for (let i = 17; i < frame.length; i += 1) {
			const corrupted = mutateByte(frame, i, 0xff);
			expectDecodeFails(decodeAppFrame(corrupted), "PADDING_NONZERO");
		}
	});

	// ---------- 8. Hostile decode inputs ----------
	it("rejects hostile decode inputs", () => {
		const valid = validFrame();

		// Non-object inputs
		expectDecodeFails(decodeAppFrame(null), "INPUT_INVALID");
		expectDecodeFails(decodeAppFrame(undefined), "INPUT_INVALID");
		expectDecodeFails(decodeAppFrame(42), "INPUT_INVALID");
		expectDecodeFails(decodeAppFrame("hello"), "INPUT_INVALID");

		// Proxy wrapping
		expectDecodeFails(decodeAppFrame(new Proxy(valid, {})), "INPUT_INVALID");

		// Revoked proxy
		const { proxy, revoke } = Proxy.revocable(valid, {});
		revoke();
		expectDecodeFails(decodeAppFrame(proxy), "INPUT_INVALID");

		// Fake object (wrong prototype)
		const fake: Record<string, number> = { length: 32 };
		for (let i = 0; i < 16; i += 1) fake[String(i)] = i;
		expectDecodeFails(decodeAppFrame(fake), "INPUT_INVALID");

		// Subarray (non-zero byteOffset)
		const larger = new Uint8Array(64);
		for (let i = 0; i < valid.length; i += 1) larger[i + 8] = valid[i];
		const subarray = larger.subarray(8, 8 + valid.length);
		expectDecodeFails(decodeAppFrame(subarray), "INPUT_INVALID");
	});

	// ---------- 9. Hostile encode payloads ----------
	it("rejects hostile encode payloads", () => {
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1000n, null), "PAYLOAD_INVALID");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1001n, 42), "PAYLOAD_INVALID");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1002n, "payload"), "PAYLOAD_INVALID");

		// Proxy payload
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1003n, new Proxy(u8([1, 2]), {})), "PAYLOAD_INVALID");

		// Revoked proxy payload
		const rp = Proxy.revocable(u8([1, 2]), {});
		rp.revoke();
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1004n, rp.proxy), "PAYLOAD_INVALID");

		// Subarray payload
		const larg = new Uint8Array(32);
		larg[8] = 0xaa;
		larg[9] = 0xbb;
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1005n, larg.subarray(8, 10)), "PAYLOAD_INVALID");
	});

	// ---------- 10. Input/output nonalias ----------
	it("never aliases input or frame buffers", () => {
		const payload = u8([0x11, 0x22, 0x33]);
		const enc = encodeAppFrame(KIND_REQUEST, 1, 2000n, payload);
		encodeOk(enc);
		expect(enc.frame).not.toBe(payload);

		const dec = decodeAppFrame(enc.frame);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.kind === 1) {
			expect(dec.payload).not.toBe(enc.frame);
			if (dec.payload.length > 0) {
				const origFrameByte = enc.frame[HEADER_SIZE];
				dec.payload[0] = 0xff;
				expect(enc.frame[HEADER_SIZE]).toBe(origFrameByte);
			}
		}
	});

	// ---------- 11. Stable reencode ----------
	it("produces deterministic byte-identical reencode", () => {
		const testPayload = u8([0xde, 0xad, 0xbe, 0xef]);
		const enc1 = encodeAppFrame(KIND_REQUEST, 2, 3000n, testPayload);
		encodeOk(enc1);

		const dec1 = decodeAppFrame(enc1.frame);
		expect(dec1.ok).toBe(true);
		if (!dec1.ok) return;

		// Expect data kind via downstream type-narrowing checks
		expect(dec1.kind === 1 || dec1.kind === 3).toBe(true);

		// Build re-encode payload from decoded result
		let rePayload: Uint8Array;
		if (dec1.kind === 1) {
			rePayload = dec1.payload;
		} else if (dec1.kind === 3) {
			rePayload = dec1.payload;
		} else {
			// Safe guard: non-data kind means test prelude broken
			expect(dec1.kind).toBe(1);
			return;
		}

		const enc2 = encodeAppFrame(dec1.kind, dec1.stream, dec1.requestId, rePayload);
		encodeOk(enc2);
		expect(enc2.frame.length).toBe(enc1.frame.length);
		for (let i = 0; i < enc1.frame.length; i += 1) expect(enc2.frame[i]).toBe(enc1.frame[i]);

		const dec2 = decodeAppFrame(enc2.frame);
		expect(dec2.ok).toBe(true);
		if (!dec2.ok) return;
		if (dec2.kind === 1 && dec1.kind === 1) {
			expect(dec2.payload.length).toBe(dec1.payload.length);
			for (let i = 0; i < dec1.payload.length; i += 1) expect(dec2.payload[i]).toBe(dec1.payload[i]);
		}
	});

	// ---------- 12. Control frame validation ----------
	it("validates control frame constraints", () => {
		for (const kind of CONTROL_KINDS) {
			// Control frames without payload succeed
			const enc = encodeAppFrame(kind, 1, 4000n, undefined);
			encodeOk(enc);
			expect(enc.frame.length).toBe(HEADER_SIZE);
			const dec = decodeAppFrame(enc.frame);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			expect(dec.kind).toBe(kind);

			// Control frames with any payload are rejected
			expectEncodeFails(encodeAppFrame(kind, 1, 4100n, new Uint8Array(0)), "CONTROL_PAYLOAD_PROVIDED");
			expectEncodeFails(encodeAppFrame(kind, 1, 4101n, u8([0x01])), "CONTROL_PAYLOAD_PROVIDED");
			expectEncodeFails(encodeAppFrame(kind, 1, 4102n, null), "CONTROL_PAYLOAD_PROVIDED");
		}
	});

	// ---------- 13. Invalid scalar encode params ----------
	it("rejects invalid scalar encode parameters without throwing", () => {
		const emptyPayload = u8([]);

		expectEncodeFails(encodeAppFrame(NaN, 0, 1n, emptyPayload), "INVALID_KIND");
		expectEncodeFails(encodeAppFrame(Infinity, 0, 1n, emptyPayload), "INVALID_KIND");
		expectEncodeFails(encodeAppFrame(-Infinity, 0, 1n, emptyPayload), "INVALID_KIND");
		expectEncodeFails(encodeAppFrame(-0, 0, 1n, emptyPayload), "INVALID_KIND");
		expectEncodeFails(encodeAppFrame(1.5, 0, 1n, emptyPayload), "INVALID_KIND");
		expectEncodeFails(encodeAppFrame("1", 0, 1n, emptyPayload), "BAD_KIND_TYPE");
		expectEncodeFails(encodeAppFrame({}, 0, 1n, emptyPayload), "BAD_KIND_TYPE");
		expectEncodeFails(encodeAppFrame(Symbol(), 0, 1n, emptyPayload), "BAD_KIND_TYPE");

		expectEncodeFails(encodeAppFrame(KIND_REQUEST, NaN, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, Infinity, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, -Infinity, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, -0, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0.5, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 5, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, -1, 1n, emptyPayload), "INVALID_STREAM");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, "0", 1n, emptyPayload), "BAD_STREAM_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, {}, 1n, emptyPayload), "BAD_STREAM_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, Symbol(), 1n, emptyPayload), "BAD_STREAM_TYPE");

		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, 1, emptyPayload), "BAD_REQUEST_ID_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, "1n", emptyPayload), "BAD_REQUEST_ID_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, {}, emptyPayload), "BAD_REQUEST_ID_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, Symbol(), emptyPayload), "BAD_REQUEST_ID_TYPE");
		expectEncodeFails(encodeAppFrame(KIND_REQUEST, 0, null, emptyPayload), "BAD_REQUEST_ID_TYPE");

		// All three wrong at once
		expectEncodeFails(encodeAppFrame("one", null, true, emptyPayload), "BAD_KIND_TYPE");

		// Hostile decode inputs must also never throw
		expect(() => decodeAppFrame(null)).not.toThrow();
		expect(() => decodeAppFrame(new Proxy(new Uint8Array(32), {}))).not.toThrow();
	});

	// ---------- 14. Discriminant narrowing ----------
	it("discriminates control frame kinds without casting", () => {
		for (const kind of CONTROL_KINDS) {
			const enc = encodeAppFrame(kind, 1, 7000n, undefined);
			encodeOk(enc);
			const dec = decodeAppFrame(enc.frame);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			if (dec.kind === 2) {
				const ack: DecodeDeliveryAckFrame = dec;
				expect(ack.requestId).toBe(7000n);
			} else if (dec.kind === 4) {
				const cancel: DecodeCancelFrame = dec;
				expect(cancel.requestId).toBe(7000n);
			} else if (dec.kind === 5) {
				const cancelAck: DecodeCancelAckFrame = dec;
				expect(cancelAck.requestId).toBe(7000n);
			}
		}
	});

	it("discriminates data frame kinds without casting", () => {
		for (const kind of DATA_KINDS) {
			const enc = encodeAppFrame(kind, 1, 8000n, u8([0x01]));
			encodeOk(enc);
			const dec = decodeAppFrame(enc.frame);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			if (dec.kind === 1) {
				const req: DecodeRequestFrame = dec;
				expect(req.payload.length).toBe(1);
			} else if (dec.kind === 3) {
				const reply: DecodeReplyFrame = dec;
				expect(reply.payload.length).toBe(1);
			}
		}
	});

	// ---------- 15. All-zero frame rejection ----------
	it("rejects all-zero and structurally invalid frames", () => {
		expectDecodeFails(decodeAppFrame(new Uint8Array(16)), "INVALID_KIND");

		const kind0Frame = new Uint8Array(16);
		kind0Frame[0] = 0;
		kind0Frame[11] = 1;
		kind0Frame[15] = 16;
		expectDecodeFails(decodeAppFrame(kind0Frame), "INVALID_KIND");

		const wrongPad = new Uint8Array(32);
		wrongPad[0] = 2;
		wrongPad[11] = 1;
		wrongPad[15] = 16;
		expectDecodeFails(decodeAppFrame(wrongPad), "WRONG_PADDED_LENGTH");

		const shortForLen = new Uint8Array(16);
		shortForLen[0] = 1;
		shortForLen[11] = 1;
		shortForLen[15] = 17;
		expectDecodeFails(decodeAppFrame(shortForLen), "WRONG_PADDED_LENGTH");
	});

	// ---------- 16. Zero-length data frame roundtrip ----------
	it("round-trips zero-length REQUEST and REPLY", () => {
		for (const kind of [KIND_REQUEST, KIND_REPLY]) {
			const enc = encodeAppFrame(kind, 2, 6000n, new Uint8Array(0));
			encodeOk(enc);
			expect(enc.frame.length).toBe(HEADER_SIZE);
			const dec = decodeAppFrame(enc.frame);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;
			if (dec.kind === kind) expect(dec.payload.length).toBe(0);
		}
	});

	// ---------- 17. Exports are exact constants ----------
	it("exports exact wire constants", () => {
		expect(KIND_REQUEST).toBe(1);
		expect(KIND_DELIVERY_ACK).toBe(2);
		expect(KIND_REPLY).toBe(3);
		expect(KIND_CANCEL).toBe(4);
		expect(KIND_CANCEL_ACK).toBe(5);
	});
});
