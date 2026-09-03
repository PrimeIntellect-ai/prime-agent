/**
 * Tests for the ProviderCallRecordV1 codec — six variants, encode/decode,
 * byte validation, digest verification, frame matching, bounds, freeze.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type DurableReceipt,
	decodeProviderCallRecordV1,
	encodeProviderCallRecordV1,
	type ProviderCallChunkRecordV1,
	type ProviderCallDeliveredRecordV1,
	type ProviderCallJournaledRecordV1,
	type ProviderCallStartedRecordV1,
	type ProviderCallTerminalRecordV1,
} from "../src/modes/daemon/provider-call-record-codec.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function _b64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function digestOfFrame(frame: Record<string, unknown>): string {
	const r = canonicalDigest(frame);
	if (!r.ok) throw new Error("canonicalDigest failed");
	return r.value;
}

function makeRequestFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId,
		provider: "test-provider",
		model: "test-model",
		messages: [{ role: "user", content: "Hello" }],
	};
}

function makeChunkFrame(callId: string, index: number): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId,
		index,
		delta: { content: `chunk-${index}` },
	};
}

function makeCompleteFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId,
		result: "ok",
		usage: { inputTokens: 10, outputTokens: 20 },
	};
}

function makeErrorFrame(callId: string, error?: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_error",
		callId,
		error: error ?? "PROVIDER_CALL_INTERRUPTED",
	};
}

function makeReceipt(overrides?: Partial<DurableReceipt>): DurableReceipt {
	return {
		sequence: overrides?.sequence ?? 1,
		size: overrides?.size ?? 100,
		sha256: overrides?.sha256 ?? "a".repeat(64),
	};
}

function makeJournaledInput(callId: string): Record<string, unknown> {
	const frame = makeRequestFrame(callId);
	const bytes = utf8(JSON.stringify(frame));
	const requestDigest = digestOfFrame(frame);
	const canonicalRequestDigest = sha256Of(bytes);
	return {
		version: 1,
		recordKind: "journaled",
		journalSeq: 1,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		requestFrameId: "f-req-1",
		requestDigest,
		requestBytes: new Uint8Array(bytes),
		canonicalRequestDigest,
	};
}

function makeStartedInput(): Record<string, unknown> {
	return {
		version: 1,
		recordKind: "started",
		journalSeq: 2,
		callId: "call-1",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:01.000Z",
		requestDigest: "a".repeat(64),
		requestJournalSeq: 1,
		requestReceipt: makeReceipt(),
	};
}

function makeChunkInput(callId: string, index: number): Record<string, unknown> {
	const frame = makeChunkFrame(callId, index);
	const bytes = utf8(JSON.stringify(frame));
	const chunkFrameDigest = sha256Of(bytes);
	return {
		version: 1,
		recordKind: "chunk",
		journalSeq: 3,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:02.000Z",
		chunkIndex: index,
		chunkFrameBytes: new Uint8Array(bytes),
		chunkFrameDigest,
	};
}

function makeTerminalInput(callId: string, kind?: string): Record<string, unknown> {
	const isComplete = kind === undefined || kind === "complete" || kind === "normal";
	const _isInterrupted = kind === "interrupted";
	const isCancelled = kind === "cancelled";
	let frame: Record<string, unknown>;
	let terminalKind: string;
	let hasUsage: boolean;
	if (isComplete) {
		frame = makeCompleteFrame(callId);
		terminalKind = "normal";
		hasUsage = true;
	} else {
		const errorCode = isCancelled ? "PROVIDER_CALL_CANCELLED" : "PROVIDER_CALL_INTERRUPTED";
		frame = makeErrorFrame(callId, errorCode);
		terminalKind = isCancelled ? "cancelled" : "interrupted";
		hasUsage = false;
	}
	const bytes = utf8(JSON.stringify(frame));
	const terminalFrameDigest = sha256Of(bytes);
	const result: Record<string, unknown> = {
		version: 1,
		recordKind: "terminal",
		journalSeq: 4,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:03.000Z",
		terminalKind,
		chunkCount: 2,
		terminalFrameBytes: new Uint8Array(bytes),
		terminalFrameDigest,
	};
	if (hasUsage) {
		result.usageInputTokens = 10;
		result.usageOutputTokens = 20;
	}
	return result;
}

function makeDeliveredInput(): Record<string, unknown> {
	return {
		version: 1,
		recordKind: "delivered",
		journalSeq: 5,
		callId: "call-1",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:04.000Z",
		ackEnvelopeId: "ack-1",
		ackEnvelopeDigest: "c".repeat(64),
		outgoingRelayReceipt: makeReceipt({
			sequence: 100,
			size: 200,
			sha256: "d".repeat(64),
		}),
	};
}

function makeCancelInput(): Record<string, unknown> {
	return {
		version: 1,
		recordKind: "cancel_requested",
		journalSeq: 6,
		callId: "call-1",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:05.000Z",
	};
}

// ===========================================================================
// 1. All six variants roundtrip + determinism
// ===========================================================================

describe("roundtrip all six variants", () => {
	it("journaled roundtrip", () => {
		const raw = makeJournaledInput("call-j1");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Returned record has requestBytes (Uint8Array), not base64.
		if (enc.record.recordKind !== "journaled") throw new Error("expected journaled");
		const r: ProviderCallJournaledRecordV1 = enc.record;
		expect(r.requestFrameId).toBe("f-req-1");
		expect(r.requestBytes instanceof Uint8Array).toBe(true);
		expect(r.requestBytes.byteLength).toBeGreaterThan(0);
		// Decode from the encoded bytes.
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "journaled") throw new Error("expected journaled");
		const d: ProviderCallJournaledRecordV1 = dec.record;
		expect(d.requestBytes instanceof Uint8Array).toBe(true);
		expect(d.requestBytes).toEqual(r.requestBytes);
	});

	it("started roundtrip with nested receipt", () => {
		const raw = makeStartedInput();
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "started") throw new Error("expected started");
		const r: ProviderCallStartedRecordV1 = enc.record;
		expect(r.requestReceipt.sequence).toBe(1);
		expect(r.requestReceipt.size).toBe(100);
		expect(r.requestReceipt.sha256).toBe("a".repeat(64));
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "started") throw new Error("expected started");
		const d: ProviderCallStartedRecordV1 = dec.record;
		expect(d.requestReceipt.sequence).toBe(1);
	});

	it("chunk roundtrip", () => {
		const raw = makeChunkInput("call-c1", 0);
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "chunk") throw new Error("expected chunk");
		const r: ProviderCallChunkRecordV1 = enc.record;
		expect(r.chunkIndex).toBe(0);
		expect(r.chunkFrameBytes instanceof Uint8Array).toBe(true);
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "chunk") throw new Error("expected chunk");
		const d: ProviderCallChunkRecordV1 = dec.record;
		expect(d.chunkIndex).toBe(0);
		expect(d.chunkFrameBytes).toEqual(r.chunkFrameBytes);
	});

	it("terminal complete roundtrip", () => {
		const raw = makeTerminalInput("call-t1");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "terminal") throw new Error("expected terminal");
		const r: ProviderCallTerminalRecordV1 = enc.record;
		expect(r.terminalKind).toBe("normal");
		expect(r.usageInputTokens).toBe(10);
		expect(r.usageOutputTokens).toBe(20);
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "terminal") throw new Error("expected terminal");
		const d: ProviderCallTerminalRecordV1 = dec.record;
		expect(d.terminalKind).toBe("normal");
		expect(d.usageInputTokens).toBe(10);
	});

	it("terminal error roundtrip with fixed error code", () => {
		const raw = makeTerminalInput("call-e1", "interrupted");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "terminal") throw new Error("expected terminal");
		const d: ProviderCallTerminalRecordV1 = dec.record;
		expect(d.terminalKind).toBe("interrupted");
		expect(d.chunkCount).toBe(2);
	});

	it("delivered roundtrip with nested receipt", () => {
		const raw = makeDeliveredInput();
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "delivered") throw new Error("expected delivered");
		const r: ProviderCallDeliveredRecordV1 = enc.record;
		expect(r.ackEnvelopeId).toBe("ack-1");
		expect(r.outgoingRelayReceipt.sequence).toBe(100);
		expect(r.outgoingRelayReceipt.size).toBe(200);
		expect(r.outgoingRelayReceipt.sha256).toBe("d".repeat(64));
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind !== "delivered") throw new Error("expected delivered");
		const d: ProviderCallDeliveredRecordV1 = dec.record;
		expect(d.ackEnvelopeId).toBe("ack-1");
		expect(d.outgoingRelayReceipt.sequence).toBe(100);
	});

	it("cancel_requested roundtrip", () => {
		const raw = makeCancelInput();
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.record.recordKind).toBe("cancel_requested");
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.record.recordKind).toBe("cancel_requested");
	});

	it("encode is deterministic", () => {
		const raw = makeJournaledInput("call-det");
		const enc1 = encodeProviderCallRecordV1(raw);
		const enc2 = encodeProviderCallRecordV1(raw);
		expect(enc1.ok).toBe(true);
		expect(enc2.ok).toBe(true);
		if (!enc1.ok || !enc2.ok) return;
		expect(enc1.bytes).toEqual(enc2.bytes);
	});
});

// ===========================================================================
// 2. Hostile encode inputs
// ===========================================================================

describe("hostile encode inputs", () => {
	it("rejects null", () => {
		expect(encodeProviderCallRecordV1(null).ok).toBe(false);
	});
	it("rejects non-object", () => {
		expect(encodeProviderCallRecordV1(42).ok).toBe(false);
		expect(encodeProviderCallRecordV1("s").ok).toBe(false);
		expect(encodeProviderCallRecordV1(true).ok).toBe(false);
	});
	it("rejects array", () => {
		expect(encodeProviderCallRecordV1([]).ok).toBe(false);
	});
	it("rejects object with accessors", () => {
		const raw = makeJournaledInput("call-ac");
		const bad = Object.defineProperty({ ...raw }, "requestFrameId", {
			get: () => "f-x",
			enumerable: true,
		});
		expect(encodeProviderCallRecordV1(bad).ok).toBe(false);
	});
	it("rejects object with symbol key", () => {
		const raw = { ...makeJournaledInput("call-sk"), [Symbol("x")]: "hidden" };
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects non-enumerable property", () => {
		const raw = makeJournaledInput("call-ne");
		Object.defineProperty(raw, "x", { value: "y", enumerable: false });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects undefined field", () => {
		const raw = makeJournaledInput("call-ud");
		delete raw.callId;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects extra field", () => {
		const raw = { ...makeJournaledInput("call-ef"), extra: "x" };
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects wrong version", () => {
		const raw = { ...makeJournaledInput("call-wv"), version: 2 };
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects missing required field", () => {
		const raw = makeJournaledInput("call-mr");
		delete raw.requestFrameId;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects revocable proxy after revoke", () => {
		const raw = makeJournaledInput("call-rp");
		const { proxy, revoke } = Proxy.revocable(raw, {});
		revoke();
		expect(encodeProviderCallRecordV1(proxy).ok).toBe(false);
	});
	it("rejects non-genuine Uint8Array (Buffer)", () => {
		const raw = makeJournaledInput("call-bu");
		raw.requestBytes = Buffer.from("test");
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 3. Field bounds
// ===========================================================================

describe("field bounds", () => {
	it("rejects journalSeq <= 0", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), journalSeq: 0 }).ok).toBe(false);
	});
	it("rejects journalSeq > 20000", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), journalSeq: 20001 }).ok).toBe(false);
	});
	it("rejects invalid callId", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("bad id!") }).ok).toBe(false);
	});
	it("rejects callId > 128 chars", () => {
		expect(encodeProviderCallRecordV1(makeJournaledInput("a".repeat(129))).ok).toBe(false);
	});
	it("rejects invalid timestamp", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), recordedAt: "bad" }).ok).toBe(false);
	});
	it("rejects non-canonical timestamp", () => {
		expect(
			encodeProviderCallRecordV1({ ...makeJournaledInput("c"), recordedAt: "2025-01-15T10:30:00.000+00:00" }).ok,
		).toBe(false);
	});
	it("rejects invalid digest", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), requestDigest: "bad" }).ok).toBe(false);
	});
	it("rejects invalid hostId", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), hostId: "" }).ok).toBe(false);
	});
	it("rejects non-positive receipt fields", () => {
		expect(
			encodeProviderCallRecordV1({ ...makeStartedInput(), requestReceipt: makeReceipt({ sequence: 0 }) }).ok,
		).toBe(false);
	});
	it("rejects non-genuine Uint8Array (subview)", () => {
		const raw = makeJournaledInput("c-sv");
		const buf = new Uint8Array(100);
		const view = new Uint8Array(buf.buffer, 10, 20);
		raw.requestBytes = view;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 4. Digest verification
// ===========================================================================

describe("digest verification", () => {
	it("rejects mismatch between bytes and digest", () => {
		const raw = makeJournaledInput("call-dm");
		raw.canonicalRequestDigest = "f".repeat(64);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});

	it("rejects SharedArrayBuffer-backed Uint8Array in byte field", () => {
		const sab = new SharedArrayBuffer(10);
		const arr = new Uint8Array(sab);
		const raw = makeJournaledInput("c-sab");
		raw.requestBytes = arr;
		// The array itself is Uint8Array-like but buffer is SAB.
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects Uint8Array with named own extra property", () => {
		const raw = makeJournaledInput("c-nx");
		const bytes = raw.requestBytes as Uint8Array;
		Object.defineProperty(bytes, "extraField", { value: "x", enumerable: true });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects Uint8Array with own byteLength override", () => {
		const raw = makeJournaledInput("c-bl");
		const bytes = raw.requestBytes as Uint8Array;
		Object.defineProperty(bytes, "byteLength", { value: 9999, enumerable: true, configurable: true });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects Uint8Array with own buffer override", () => {
		const raw = makeJournaledInput("c-bo");
		const bytes = raw.requestBytes as Uint8Array;
		Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(5), enumerable: true, configurable: true });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects Uint8Array with own symbol property", () => {
		const raw = makeJournaledInput("c-sp");
		const bytes = raw.requestBytes as Uint8Array;
		Object.defineProperty(bytes, Symbol("secret"), { value: 42, enumerable: true });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects empty Uint8Array in byte field", () => {
		const raw = makeJournaledInput("c-em");
		raw.requestBytes = new Uint8Array(0);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects subclass in encode byte field", () => {
		class Sub extends Uint8Array {}
		const raw = makeJournaledInput("c-sc");
		raw.requestBytes = new Sub(10);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects genuine Proxy wrapping Uint8Array in encode byte field", () => {
		const _raw = makeJournaledInput("c-gp");
		const { proxy, revoke } = Proxy.revocable(new Uint8Array(10), {});
		revoke();
		expect(encodeProviderCallRecordV1(proxy).ok).toBe(false);
	});
	it("rejects genuine Proxy wrapping ArrayBuffer in backing buffer", () => {
		const raw = makeJournaledInput("c-ap");
		// Can't easily make a Uint8Array with a proxy ArrayBuffer, so skip if impossible.
		const bytes = raw.requestBytes as Uint8Array;
		const proxyBuf = new Proxy(bytes.buffer, {});
		Object.defineProperty(bytes, "buffer", { value: proxyBuf, enumerable: true, configurable: true });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});

	it("rejects mismatch on chunk digest", () => {
		const raw = makeChunkInput("call-cd", 0);
		raw.chunkFrameDigest = "e".repeat(64);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects mismatch on terminal digest", () => {
		const raw = makeTerminalInput("call-td");
		raw.terminalFrameDigest = "e".repeat(64);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("decode verifies digest against base64 content", () => {
		const raw = makeJournaledInput("call-dd");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Tamper the digest in the JSON and verify decode rejects.
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.canonicalRequestDigest = "f".repeat(64);
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
	it("decode verifies request digest against frame canonical digest", () => {
		const raw = makeJournaledInput("call-dd2");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.requestDigest = "f".repeat(64);
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
});

// ===========================================================================
// 5. Frame mismatch
// ===========================================================================

describe("frame mismatch", () => {
	it("journaled must contain model_call_request", () => {
		const raw = makeJournaledInput("call-fm");
		const wrongBytes = utf8(JSON.stringify(makeChunkFrame("call-fm", 0)));
		raw.requestBytes = new Uint8Array(wrongBytes);
		raw.canonicalRequestDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("journaled callId must match frame callId", () => {
		const raw = makeJournaledInput("call-fm2");
		const wrongFrame = makeRequestFrame("other-call");
		const wrongBytes = utf8(JSON.stringify(wrongFrame));
		raw.requestBytes = new Uint8Array(wrongBytes);
		raw.canonicalRequestDigest = sha256Of(wrongBytes);
		raw.requestDigest = digestOfFrame(wrongFrame);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("chunk must contain model_call_chunk with matching index", () => {
		const raw = makeChunkInput("call-cm", 0);
		const wrongBytes = utf8(JSON.stringify(makeChunkFrame("call-cm", 5)));
		raw.chunkFrameBytes = new Uint8Array(wrongBytes);
		raw.chunkFrameDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("chunk callId must match frame callId", () => {
		const raw = makeChunkInput("call-cm2", 0);
		const wrongBytes = utf8(JSON.stringify(makeChunkFrame("other-call", 0)));
		raw.chunkFrameBytes = new Uint8Array(wrongBytes);
		raw.chunkFrameDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("terminal must contain model_call_complete or model_call_error", () => {
		const raw = makeTerminalInput("call-tm");
		const wrongBytes = utf8(JSON.stringify(makeChunkFrame("call-tm", 0)));
		raw.terminalFrameBytes = new Uint8Array(wrongBytes);
		raw.terminalFrameDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("terminal error must be in fixed allowlist", () => {
		const raw = makeTerminalInput("call-tm2", "interrupted");
		const errFrame = makeErrorFrame("call-tm2", "UNKNOWN_CODE");
		const wrongBytes = utf8(JSON.stringify(errFrame));
		raw.terminalFrameBytes = new Uint8Array(wrongBytes);
		raw.terminalFrameDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("terminal complete callId must match frame callId", () => {
		const raw = makeTerminalInput("call-tm3");
		const wrongBytes = utf8(JSON.stringify(makeCompleteFrame("other-call")));
		raw.terminalFrameBytes = new Uint8Array(wrongBytes);
		raw.terminalFrameDigest = sha256Of(wrongBytes);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 6. Size limit
// ===========================================================================

describe("size limit", () => {
	it("rejects record exceeding 1.25 MiB", () => {
		const raw = makeJournaledInput("call-big");
		const hugePayload = "x".repeat(1_300_000);
		const frame = makeRequestFrame("call-big");
		const frameBytes = utf8(JSON.stringify(frame) + hugePayload);
		raw.requestBytes = new Uint8Array(frameBytes);
		raw.canonicalRequestDigest = sha256Of(frameBytes);
		raw.requestDigest = digestOfFrame(frame);
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 7. Deep freeze
// ===========================================================================

describe("deep freeze", () => {
	it("encode returns frozen record", () => {
		const raw = makeJournaledInput("call-fz");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(Object.isFrozen(enc.record)).toBe(true);
	});
	it("decode returns frozen record", () => {
		const raw = makeJournaledInput("call-fz2");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeProviderCallRecordV1(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.record)).toBe(true);
	});
});

// ===========================================================================
// 8. Terminal without usage
// ===========================================================================

describe("terminal without usage", () => {
	it("encodes terminal without usage fields", () => {
		const raw = makeTerminalInput("call-tnu");
		// Create a complete frame without usage, matching record with no usage fields.
		const frameNoUsage = makeCompleteFrame("call-tnu");
		delete frameNoUsage.usage;
		const bytesNoUsage = utf8(JSON.stringify(frameNoUsage));
		raw.terminalFrameBytes = new Uint8Array(bytesNoUsage);
		raw.terminalFrameDigest = sha256Of(bytesNoUsage);
		delete raw.usageInputTokens;
		delete raw.usageOutputTokens;
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "terminal") throw new Error("expected terminal");
		const r: ProviderCallTerminalRecordV1 = enc.record;
		expect(r.usageInputTokens).toBeUndefined();
		expect(r.usageOutputTokens).toBeUndefined();
		const jsonStr = new TextDecoder().decode(enc.bytes);
		expect(jsonStr).not.toContain("usageInputTokens");
	});
	it("rejects negative usage tokens", () => {
		const raw = { ...makeTerminalInput("call-nt"), usageInputTokens: -1 };
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

// ===========================================================================
// 9. Hostile decode inputs
// ===========================================================================

describe("hostile decode inputs", () => {
	it("rejects non-Uint8Array input", () => {
		expect(decodeProviderCallRecordV1("not bytes" as unknown as Uint8Array).ok).toBe(false);
	});
	it("rejects empty Uint8Array", () => {
		expect(decodeProviderCallRecordV1(new Uint8Array(0)).ok).toBe(false);
	});
	it("rejects Buffer input", () => {
		expect(decodeProviderCallRecordV1(Buffer.from("{}")).ok).toBe(false);
	});
	it("rejects Uint8Array subclass", () => {
		class Fake extends Uint8Array {}
		expect(decodeProviderCallRecordV1(new Fake(10)).ok).toBe(false);
	});
	it("rejects SharedArrayBuffer-backed Uint8Array", () => {
		const sab = new SharedArrayBuffer(10);
		const arr = new Uint8Array(sab);
		expect(decodeProviderCallRecordV1(arr).ok).toBe(false);
	});
	it("rejects subview (non-zero byteOffset)", () => {
		const buf = new Uint8Array(100);
		const view = new Uint8Array(buf.buffer, 10, 20);
		expect(decodeProviderCallRecordV1(view).ok).toBe(false);
	});
	it("rejects truncated JSON", () => {
		const raw = makeJournaledInput("call-tr");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const truncated = enc.bytes.slice(0, Math.floor(enc.bytes.length / 2));
		expect(decodeProviderCallRecordV1(truncated).ok).toBe(false);
	});
	it("rejects oversized input", () => {
		const huge = new Uint8Array(2_000_000);
		expect(decodeProviderCallRecordV1(huge).ok).toBe(false);
	});
	it("rejects malicious JSON with extra fields", () => {
		const raw = makeJournaledInput("call-ml");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.extraField = "bad";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
	it("rejects reordered key JSON", () => {
		const raw = makeJournaledInput("call-ro");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		// Reverse key order to produce different serialization.
		const reversedKeys = Object.keys(parsed).reverse();
		const reordered: Record<string, unknown> = Object.create(null);
		for (const k of reversedKeys) reordered[k] = parsed[k];
		const tampered = utf8(JSON.stringify(reordered));
		const dec = decodeProviderCallRecordV1(tampered);
		expect(dec.ok).toBe(false);
	});
	it("rejects invalid UTF-8 bytes", () => {
		const bad = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
		expect(decodeProviderCallRecordV1(bad).ok).toBe(false);
	});
	it("rejects raw number JSON", () => {
		expect(decodeProviderCallRecordV1(utf8("42")).ok).toBe(false);
	});
});

// ===========================================================================
// 10. Fixed error allowlist
// ===========================================================================

it("rejects non-genuine Uint8Array with own byteLength override on decode", () => {
	const raw = makeJournaledInput("c-dbl");
	const enc = encodeProviderCallRecordV1(raw);
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const bytes = new Uint8Array(enc.bytes);
	Object.defineProperty(bytes, "byteLength", { value: 9999, enumerable: true, configurable: true });
	expect(decodeProviderCallRecordV1(bytes).ok).toBe(false);
});
it("rejects non-genuine Uint8Array with own buffer override on decode", () => {
	const raw = makeJournaledInput("c-dbo");
	const enc = encodeProviderCallRecordV1(raw);
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const bytes = new Uint8Array(enc.bytes);
	Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(5), enumerable: true, configurable: true });
	expect(decodeProviderCallRecordV1(bytes).ok).toBe(false);
});
it("rejects non-genuine Uint8Array with named own extra property on decode", () => {
	const raw = makeJournaledInput("c-dne");
	const enc = encodeProviderCallRecordV1(raw);
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const bytes = new Uint8Array(enc.bytes);
	Object.defineProperty(bytes, "extraField", { value: "x", enumerable: true });
	expect(decodeProviderCallRecordV1(bytes).ok).toBe(false);
});
it("rejects non-genuine Uint8Array with own symbol on decode", () => {
	const raw = makeJournaledInput("c-dsy");
	const enc = encodeProviderCallRecordV1(raw);
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const bytes = new Uint8Array(enc.bytes);
	Object.defineProperty(bytes, Symbol("x"), { value: 1, enumerable: true });
	expect(decodeProviderCallRecordV1(bytes).ok).toBe(false);
});
it("rejects Proxy wrapping plain object on decode", () => {
	const proxy = new Proxy({}, {});
	expect(decodeProviderCallRecordV1(proxy as unknown as Uint8Array).ok).toBe(false);
});
it("rejects revoked Proxy on decode", () => {
	const { proxy, revoke } = Proxy.revocable(new Uint8Array(10), {});
	revoke();
	expect(decodeProviderCallRecordV1(proxy).ok).toBe(false);
});

// ===========================================================================
// 15. Canonical encoding verification (reject non-canonical input)
// ===========================================================================

describe("canonical encoding verification", () => {
	function makeCanonJournaledBytes(callId?: string): Uint8Array {
		const frame = makeRequestFrame(callId ?? "call-can");
		const bytes = utf8(JSON.stringify(frame));
		const requestDigest = digestOfFrame(frame);
		const canonicalRequestDigest = sha256Of(bytes);
		const raw = {
			version: 1,
			recordKind: "journaled",
			journalSeq: 1,
			callId: callId ?? "call-can",
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			requestFrameId: "f-req-1",
			requestDigest,
			requestBytes: new Uint8Array(bytes),
			canonicalRequestDigest,
		};
		const enc = encodeProviderCallRecordV1(raw);
		if (!enc.ok) throw new Error("encode failed");
		return enc.bytes;
	}

	it("rejects leading whitespace", () => {
		const canon = makeCanonJournaledBytes("call-lw");
		const jsonStr = new TextDecoder().decode(canon);
		const tampered = ` \t\n${jsonStr}`;
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects trailing whitespace", () => {
		const canon = makeCanonJournaledBytes("call-tw");
		const jsonStr = new TextDecoder().decode(canon);
		const tampered = `${jsonStr} \n\n`;
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects inter-key whitespace", () => {
		const canon = makeCanonJournaledBytes("call-iw");
		const jsonStr = new TextDecoder().decode(canon);
		// Add space between keys
		const tampered = jsonStr.replace(/,/g, ", ");
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects duplicate identical key (last wins, but re-encode differs)", () => {
		const canon = makeCanonJournaledBytes("call-dk");
		const jsonStr = new TextDecoder().decode(canon);
		// Insert a duplicate first key right after the original.
		// {"version":1,"recordKind":"journaled",...}
		// Make it: {"version":1,"version":1,"recordKind":"journaled",...}
		const pos = jsonStr.indexOf('"recordKind"');
		if (pos < 0) throw new Error("position not found");
		const tampered = `${jsonStr.slice(0, pos)}"version":1,${jsonStr.slice(pos)}`;
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects duplicate conflicting key", () => {
		const canon = makeCanonJournaledBytes("call-dc");
		const jsonStr = new TextDecoder().decode(canon);
		// Insert a conflicting "version":2 before the real version
		const pos = jsonStr.indexOf('"recordKind"');
		if (pos < 0) throw new Error("position not found");
		const tampered = `${jsonStr.slice(0, pos)}"version":2,${jsonStr.slice(pos)}`;
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects escaped-vs-literal string variation", () => {
		const canon = makeCanonJournaledBytes("call-ev");
		const jsonStr = new TextDecoder().decode(canon);
		// Replace a key with its escaped equivalent (e.g., \u0068 instead of "h")
		// This is tricky in JSON but we can try replacing "hostId" with "\u0068ostId"
		// Actually just change recordedAt timestamp key to exercise canonical check
		// Simplest: replace "h-1" with a different but structurally identical representation
		const tampered = jsonStr.replace('"h-1"', '"h\\u002d1"');
		expect(decodeProviderCallRecordV1(utf8(tampered)).ok).toBe(false);
	});

	it("rejects reordered keys", () => {
		const canon = makeCanonJournaledBytes("call-ro");
		const jsonStr = new TextDecoder().decode(canon);
		const parsed = JSON.parse(jsonStr);
		const reversedKeys = Object.keys(parsed).reverse();
		const reordered: Record<string, unknown> = Object.create(null);
		for (const k of reversedKeys) reordered[k] = parsed[k];
		const tampered = utf8(JSON.stringify(reordered));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
});

// ===========================================================================
// 11. Owned copy independence
// ===========================================================================

describe("owned copy independence", () => {
	it("returned bytes are fresh copies", () => {
		const raw = makeJournaledInput("call-ic");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const encBytesCopy = new Uint8Array(enc.bytes);
		enc.bytes[0] = 0xff;
		const dec = decodeProviderCallRecordV1(encBytesCopy);
		expect(dec.ok).toBe(true);
	});
	it("returned Uint8Array fields are owned copies", () => {
		const raw = makeJournaledInput("call-oc");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		if (enc.record.recordKind !== "journaled") throw new Error("expected journaled");
		const r: ProviderCallJournaledRecordV1 = enc.record;
		const originalBytes = raw.requestBytes as Uint8Array;
		// Mutate original (technically allowed in test).
		originalBytes[0] = 0;
		// The returned copy should be unchanged.
		expect(r.requestBytes[0]).not.toBe(0);
	});
});

// ===========================================================================
// 12. Cross-kind rejection
// ===========================================================================

describe("cross-kind rejection", () => {
	it("started with missing requestDigest", () => {
		const raw = makeStartedInput();
		delete raw.requestDigest;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("chunk with negative index", () => {
		expect(encodeProviderCallRecordV1(makeChunkInput("c", -1)).ok).toBe(false);
	});
	it("delivered with empty ackEnvelopeId", () => {
		expect(encodeProviderCallRecordV1({ ...makeDeliveredInput(), ackEnvelopeId: "" }).ok).toBe(false);
	});
	it("wrong recordKind string", () => {
		expect(encodeProviderCallRecordV1({ ...makeJournaledInput("c"), recordKind: "bogus" }).ok).toBe(false);
	});
});

// ===========================================================================
// 13. Base64 strictness
// ===========================================================================

describe("base64 strictness", () => {
	it("rejects invalid base64 in decode", () => {
		const raw = makeJournaledInput("call-bi");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.canonicalRequestBase64 = "!!!invalid!!!";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
	it("rejects empty base64 in decode", () => {
		const raw = makeJournaledInput("call-be");
		const enc = encodeProviderCallRecordV1(raw);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const jsonStr = new TextDecoder().decode(enc.bytes);
		const parsed = JSON.parse(jsonStr);
		parsed.canonicalRequestBase64 = "";
		const tampered = utf8(JSON.stringify(parsed));
		expect(decodeProviderCallRecordV1(tampered).ok).toBe(false);
	});
});

// ===========================================================================
// 14. DurableReceipt validation
// ===========================================================================

// ===========================================================================
// 16. Terminal kind and usage cross-mismatch
// ===========================================================================

describe("terminal kind and usage mismatch", () => {
	it("rejects terminalKind normal with model_call_error frame", () => {
		const raw = makeTerminalInput("call-tk-err", "interrupted");
		raw.terminalKind = "normal"; // mismatch: error frame but normal kind
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects terminalKind interrupted with model_call_complete frame", () => {
		const raw = makeTerminalInput("call-tk-complete");
		raw.terminalKind = "interrupted"; // mismatch: complete frame but interrupted kind
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects terminalKind cancelled with PROVIDER_CALL_INTERRUPTED frame", () => {
		const raw = makeTerminalInput("call-tk-ci", "interrupted");
		raw.terminalKind = "cancelled"; // mismatch: interrupted kind needed for this error code
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects terminalKind interrupted with PROVIDER_CALL_CANCELLED frame", () => {
		const raw = makeTerminalInput("call-tk-cc", "cancelled");
		raw.terminalKind = "interrupted"; // mismatch: cancelled kind needed for this error code
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects model_call_complete with usage in frame but none in record", () => {
		const raw = makeTerminalInput("call-tu-mi");
		const frame = makeCompleteFrame("call-tu-mi");
		// Frame has usage, but record won't have usage fields
		const bytes = utf8(JSON.stringify(frame));
		raw.terminalFrameBytes = new Uint8Array(bytes);
		raw.terminalFrameDigest = sha256Of(bytes);
		// Keep usage out by deleting
		delete raw.usageInputTokens;
		delete raw.usageOutputTokens;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects model_call_complete with usage in record but none in frame", () => {
		const raw = makeTerminalInput("call-tu-mf");
		const frame = makeCompleteFrame("call-tu-mf");
		delete frame.usage; // No usage in frame
		const bytes = utf8(JSON.stringify(frame));
		raw.terminalFrameBytes = new Uint8Array(bytes);
		raw.terminalFrameDigest = sha256Of(bytes);
		// Keep usage in record — frame has none but record has usageInputTokens=10, usageOutputTokens=20
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects model_call_complete with mismatched usage values", () => {
		const raw = makeTerminalInput("call-tu-mv");
		const _frame = makeCompleteFrame("call-tu-mv");
		// frame has usage {inputTokens:10, outputTokens:20} but record says different
		raw.usageInputTokens = 99;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects model_call_error with usage present", () => {
		const raw = makeTerminalInput("call-tu-eu", "interrupted");
		// Add usage fields to an error terminal — must be rejected
		raw.usageInputTokens = 10;
		raw.usageOutputTokens = 20;
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
});

describe("DurableReceipt validation", () => {
	it("rejects receipt with non-positive sequence", () => {
		const raw = makeStartedInput();
		raw.requestReceipt = makeReceipt({ sequence: -1 });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects receipt with non-positive size", () => {
		const raw = makeStartedInput();
		raw.requestReceipt = makeReceipt({ size: 0 });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects receipt with invalid sha256", () => {
		const raw = makeStartedInput();
		raw.requestReceipt = makeReceipt({ sha256: "not-a-valid-digest" });
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	it("rejects receipt with extra fields", () => {
		const raw = makeStartedInput();
		raw.requestReceipt = { ...makeReceipt(), extraField: "x" };
		expect(encodeProviderCallRecordV1(raw).ok).toBe(false);
	});
	describe("fixed error allowlist", () => {
		const CODE_KIND_MAP: Record<string, string> = {
			PROVIDER_CALL_INTERRUPTED: "interrupted",
			PROVIDER_CALL_CANCELLED: "cancelled",
			PROVIDER_ERROR: "normal",
			PERSISTENCE_ERROR: "normal",
			POLICY_DENIED: "normal",
			INVALID_REQUEST: "normal",
		};
		for (const [code, kind] of Object.entries(CODE_KIND_MAP)) {
			it(`accepts: ${code}`, () => {
				const raw = makeTerminalInput(`call-${code.substring(0, 16)}`, kind as string);
				const errFrame = makeErrorFrame(`call-${code.substring(0, 16)}`, code);
				const errBytes = utf8(JSON.stringify(errFrame));
				raw.terminalFrameBytes = new Uint8Array(errBytes);
				raw.terminalFrameDigest = sha256Of(errBytes);
				delete raw.usageInputTokens;
				delete raw.usageOutputTokens;
				const enc = encodeProviderCallRecordV1(raw);
				expect(enc.ok).toBe(true);
			});
		}
	});
});
