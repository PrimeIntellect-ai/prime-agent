/**
 * Pure ProviderCallRecordV1 codec — six-variant versioned tagged union.
 *
 * Public encode/decode operates on DTOs with owned Uint8Array byte fields
 * and nested DurableReceipt objects.  Persisted canonical JSON uses base64
 * strings and flattened receipt fields internally; the decode/codec surface
 * always returns fresh full-backing Uint8Array copies and nested receipts.
 *
 * Encode validates exact own enumerable plain descriptor snapshots — no
 * proxies, accessors, symbols, non-enumerable, undefined, or extra fields.
 * Decode validates the byte input as a genuine full-backing Uint8Array (no
 * Buffer, subclass, Proxy, SAB, detached, subview, or own extras), enforces
 * max size before parsing, and re-encodes JSON to prove canonical encoding.
 *
 * Base64 is strict — rejects non-canonical characters and wrong padding.
 * All returned DTOs are frozen fresh objects, never aliases to inputs.
 * Byte digests are recomputed and verified against stored digests.
 * Contained RemoteHostProviderProxyFrames are decoded and field-matched.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { RemoteHostProviderProxyFrame } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeProviderProxyFrame,
	digestsEqual,
	isCanonicalUtcTimestamp,
	isValidDigest,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_ENCODED_BYTES = 1_310_720; // 1.25 MiB

const FIXED_ERROR_CODES = new Set([
	"PROVIDER_CALL_INTERRUPTED",
	"PROVIDER_ERROR",
	"PROVIDER_CALL_CANCELLED",
	"PERSISTENCE_ERROR",
	"POLICY_DENIED",
	"INVALID_REQUEST",
]);

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ===========================================================================
// Global codec error codes
// ===========================================================================

export const PROVIDER_CALL_CODEC_ERRORS = {
	INVALID_RECORD: "INVALID_RECORD",
	INVALID_FRAME: "INVALID_FRAME",
	INVALID_IDENTITY: "INVALID_IDENTITY",
	INVALID_SEQUENCE: "INVALID_SEQUENCE",
	INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
	INVALID_DIGEST: "INVALID_DIGEST",
	INVALID_BASE64: "INVALID_BASE64",
	INVALID_CHUNK_INDEX: "INVALID_CHUNK_INDEX",
	INVALID_TERMINAL_KIND: "INVALID_TERMINAL_KIND",
	INVALID_USAGE: "INVALID_USAGE",
	FRAME_MISMATCH: "FRAME_MISMATCH",
	OVERFLOW: "OVERFLOW",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const; // needed for literal type inference on const object; see src/typescript/literal-type-widening

export type ProviderCallCodecErrorCode = (typeof PROVIDER_CALL_CODEC_ERRORS)[keyof typeof PROVIDER_CALL_CODEC_ERRORS];

// ===========================================================================
// Shared types (re-exported by provider-call-store-types.ts eventually)
// ===========================================================================

export interface DurableReceipt {
	readonly sequence: number;
	readonly size: number;
	readonly sha256: string;
}

export type ProviderCallRecordKind = "journaled" | "started" | "chunk" | "terminal" | "delivered" | "cancel_requested";

// ===========================================================================
// DTO types — six variants, all with Uint8Array byte fields, nested receipts
// ===========================================================================

export interface ProviderCallRecordCommon {
	readonly version: 1;
	readonly recordKind: ProviderCallRecordKind;
	readonly journalSeq: number;
	readonly callId: string;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly recordedAt: string;
}

export interface ProviderCallJournaledRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "journaled";
	readonly requestFrameId: string;
	readonly requestDigest: string;
	readonly requestBytes: Uint8Array;
	readonly canonicalRequestDigest: string;
}

export interface ProviderCallStartedRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "started";
	readonly requestDigest: string;
	readonly requestJournalSeq: number;
	readonly requestReceipt: DurableReceipt;
}

export interface ProviderCallChunkRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "chunk";
	readonly chunkIndex: number;
	readonly chunkFrameBytes: Uint8Array;
	readonly chunkFrameDigest: string;
}

export interface ProviderCallTerminalRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "terminal";
	readonly terminalKind: "normal" | "interrupted" | "cancelled";
	readonly chunkCount: number;
	readonly terminalFrameBytes: Uint8Array;
	readonly terminalFrameDigest: string;
	readonly usageInputTokens?: number;
	readonly usageOutputTokens?: number;
}

export interface ProviderCallDeliveredRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "delivered";
	readonly ackEnvelopeId: string;
	readonly ackEnvelopeDigest: string;
	readonly outgoingRelayReceipt: DurableReceipt;
}

export interface ProviderCallCancelRequestedRecordV1 extends ProviderCallRecordCommon {
	readonly recordKind: "cancel_requested";
}

export type ProviderCallRecordV1 =
	| ProviderCallJournaledRecordV1
	| ProviderCallStartedRecordV1
	| ProviderCallChunkRecordV1
	| ProviderCallTerminalRecordV1
	| ProviderCallDeliveredRecordV1
	| ProviderCallCancelRequestedRecordV1;

// ===========================================================================
// Result types
// ===========================================================================

interface CodecErrorObj {
	readonly code: ProviderCallCodecErrorCode;
}

export interface ProviderCallEncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
	readonly record: ProviderCallRecordV1;
}
export interface ProviderCallEncodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type ProviderCallEncodeResult = ProviderCallEncodeOk | ProviderCallEncodeError;

export interface ProviderCallDecodeOk {
	readonly ok: true;
	readonly record: ProviderCallRecordV1;
}
export interface ProviderCallDecodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type ProviderCallDecodeResult = ProviderCallDecodeOk | ProviderCallDecodeError;

// ===========================================================================
// Helpers
// ===========================================================================

function codecError(code: ProviderCallCodecErrorCode): CodecErrorObj {
	return Object.freeze({ code });
}

function encOk(bytes: Uint8Array, record: ProviderCallRecordV1): ProviderCallEncodeOk {
	return Object.freeze({ ok: true, bytes, record });
}

function decOk(record: ProviderCallRecordV1): ProviderCallDecodeOk {
	return Object.freeze({ ok: true, record });
}

/** Fresh copy of a Uint8Array that owns its backing buffer. */
function ownCopy(source: Uint8Array): Uint8Array {
	if (source.byteLength === 0) return new Uint8Array(0);
	const copy = new Uint8Array(source.byteLength);
	copy.set(source);
	return copy;
}

/** Base64 encode. */
function b64Encode(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

// Strict base64 character pattern.
const BASE64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 decode.  Returns the decoded bytes only when the input
 * matches strict base64 grammar and roundtrips exactly through encode.
 */
function b64DecodeStrict(b64: string): Uint8Array | undefined {
	if (b64.length === 0) return undefined;
	if (!BASE64_STRICT.test(b64)) return undefined;
	let decoded: Uint8Array;
	try {
		const buf = Buffer.from(b64, "base64");
		decoded = new Uint8Array(buf);
	} catch {
		return undefined;
	}
	// Verify strict roundtrip — reject non-canonical encodings.
	if (Buffer.from(decoded).toString("base64") !== b64) return undefined;
	return decoded;
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isPositiveSafeInt(v: number): boolean {
	return Number.isSafeInteger(v) && v > 0;
}

function isNonNegativeSafeInt(v: number): boolean {
	return Number.isSafeInteger(v) && v >= 0;
}

function isTerminalKind(v: string): v is "normal" | "interrupted" | "cancelled" {
	return v === "normal" || v === "interrupted" || v === "cancelled";
}

// ===========================================================================
// Uint8Array genuine-byte intrinsic validation
// Rejects: Buffer, subclass, SharedArrayBuffer, detached, subview, own extras
// ===========================================================================

// Capture intrinsic getters from %TypedArray%.prototype and ArrayBuffer.prototype
// so we can Reflect.apply them on any target, bypassing own-property overrides.
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const INTRINSIC_BYTE_LENGTH_GETTER: (() => number) | undefined =
	TYPED_ARRAY_PROTO !== null && TYPED_ARRAY_PROTO !== Object.prototype
		? Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength")?.get
		: undefined;
const INTRINSIC_BYTE_OFFSET_GETTER: (() => number) | undefined =
	TYPED_ARRAY_PROTO !== null && TYPED_ARRAY_PROTO !== Object.prototype
		? Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset")?.get
		: undefined;
const INTRINSIC_BUFFER_GETTER: (() => ArrayBufferLike) | undefined =
	TYPED_ARRAY_PROTO !== null && TYPED_ARRAY_PROTO !== Object.prototype
		? Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer")?.get
		: undefined;
const INTRINSIC_AB_BYTE_LENGTH_GETTER: (() => number) | undefined = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get;

/**
 * Validate that `input` is a genuine full-backing Uint8Array with no
 * overrides, subview, shared backing, subclass, proxy, or extra properties.
 *
 * Uses intrinsic getters via Reflect.apply so that own-property overrides of
 * byteLength/byteOffset/buffer are bypassed.  Also verifies:
 *  - types.isProxy is false
 *  - prototype is exact %Uint8Array.prototype%
 *  - byteOffset is 0 (full-backing, not a subview)
 *  - byteLength > 0 (non-empty)
 *  - byteLength === buffer.byteLength (full-backing)
 *  - buffer has exact %ArrayBuffer.prototype% (not SharedArrayBuffer, not Proxy)
 *  - own property names are exactly 0, 1, ..., length-1 (no named extras)
 *  - no symbol own properties
 */
function isGenuineUint8Array(input: unknown): input is Uint8Array {
	try {
		if (typeof input !== "object" || input === null) return false;
		// Reject Proxy before any property access.
		if (types.isProxy(input)) return false;
		// Reject non-Uint8Array prototype.
		if (Object.getPrototypeOf(input) !== Uint8Array.prototype) return false;
		// Read byteLength, byteOffset, buffer through intrinsic getters.
		if (INTRINSIC_BYTE_LENGTH_GETTER === undefined) return false;
		if (INTRINSIC_BYTE_OFFSET_GETTER === undefined) return false;
		if (INTRINSIC_BUFFER_GETTER === undefined) return false;
		const byteLength = Reflect.apply(INTRINSIC_BYTE_LENGTH_GETTER, input, []);
		const byteOffset = Reflect.apply(INTRINSIC_BYTE_OFFSET_GETTER, input, []);
		const buffer = Reflect.apply(INTRINSIC_BUFFER_GETTER, input, []);
		if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength)) return false;
		if (typeof byteOffset !== "number" || !Number.isSafeInteger(byteOffset)) return false;
		if (typeof buffer !== "object" || buffer === null) return false;
		// Must be non-empty full-backing.
		if (byteLength <= 0) return false;
		if (byteOffset !== 0) return false;
		// Buffer must have exact ArrayBuffer.prototype (not SharedArrayBuffer,
		// not a Proxy, not a subclass).
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return false;
		if (types.isProxy(buffer)) return false;
		// Buffer byteLength must match input byteLength (full backing).
		if (INTRINSIC_AB_BYTE_LENGTH_GETTER === undefined) return false;
		const bufferByteLength = Reflect.apply(INTRINSIC_AB_BYTE_LENGTH_GETTER, buffer, []);
		if (typeof bufferByteLength !== "number" || bufferByteLength !== byteLength) return false;
		// Own property names must be exactly canonical typed-array indices.
		const ownNames = Object.getOwnPropertyNames(input);
		if (ownNames.length !== byteLength) return false;
		for (let i = 0; i < byteLength; i++) {
			if (ownNames[i] !== String(i)) return false;
		}
		// No symbol own properties.
		if (Object.getOwnPropertySymbols(input).length > 0) return false;
		return true;
	} catch {
		return false; // detached, revoked proxy, or other unreadable state
	}
}

// ===========================================================================
// copyExactOwnRecordObject — single-pass guarded copy from descriptor.value
//
// Checks prototype, symbols, accessors, non-enumerable, undefined values
// ONCE.  Returns a fresh null-prototype object populated exclusively from
// descriptor.value — never invokes the raw object's [[Get]] trap.
// Returns the copy on success, or a CodecErrorCode string on failure.
// When exactCount >= 0, rejects a different number of own enumerable keys.
// ===========================================================================

const TYPED_ARRAY_CTORS_SIGNATURES = new Set([
	"Uint8Array",
	"Int8Array",
	"Uint16Array",
	"Int16Array",
	"Uint32Array",
	"Int32Array",
	"Float32Array",
	"Float64Array",
]);

function isTypedArrayInstance(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	// Proxy detection before any property access.
	if (types.isProxy(value)) return true;
	try {
		const proto = Object.getPrototypeOf(value);
		if (proto === null) return false;
		const ctorDesc = Object.getOwnPropertyDescriptor(proto, "constructor");
		if (ctorDesc === undefined) return false;
		const ctorValue = ctorDesc.value;
		const ctorName = typeof ctorValue === "function" ? ctorValue.name : undefined;
		return typeof ctorName === "string" && TYPED_ARRAY_CTORS_SIGNATURES.has(ctorName);
	} catch {
		return true; // treat unreadable as hostile
	}
}

function copyExactOwnRecordObject(
	raw: unknown,
	allowed: ReadonlySet<string>,
	exactCount: number | null,
): Record<string, unknown> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;

	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(raw);
	} catch {
		return undefined;
	}
	if (proto !== null && proto !== Object.prototype) return undefined;

	let descs: PropertyDescriptorMap;
	try {
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return undefined;
	}

	let keys: string[];
	try {
		keys = Object.getOwnPropertyNames(raw);
	} catch {
		return undefined;
	}

	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return undefined;
	}
	if (symbols.length > 0) return undefined;

	if (exactCount !== null && keys.length !== exactCount) return undefined;

	const out: Record<string, unknown> = Object.create(null);
	for (const k of keys) {
		if (!allowed.has(k)) return undefined;
		const desc = descs[k];
		if (desc.get || desc.set) return undefined;
		if (!desc.enumerable) return undefined;
		const v = desc.value;
		if (v === undefined) return undefined;
		out[k] = v;
	}
	return out;
}

// ===========================================================================
// decodeDurableReceipt — extracts nested DurableReceipt from a safe copy
// ===========================================================================

function decodeDurableReceipt(raw: unknown): DurableReceipt | undefined {
	const obj = copyExactOwnRecordObject(raw, new Set(["sequence", "size", "sha256"]), 3);
	if (obj === undefined) return undefined;
	const sequence = obj.sequence;
	const size = obj.size;
	const sha256 = obj.sha256;
	if (typeof sequence !== "number" || !isPositiveSafeInt(sequence)) return undefined;
	if (typeof size !== "number" || !isPositiveSafeInt(size)) return undefined;
	if (typeof sha256 !== "string" || !isValidDigest(sha256)) return undefined;
	return Object.freeze({ sequence, size, sha256 });
}

// ===========================================================================
// validateProviderProxyFrameMatch — verify decoded frame matches expected
// ===========================================================================

type FrameCheck =
	| { expectKind: "model_call_request"; callId: string; digest: string }
	| { expectKind: "model_call_chunk"; callId: string; index: number }
	| { expectKind: "model_call_complete"; callId: string }
	| { expectKind: "model_call_error"; callId: string };

/**
 * Validates a decoded RemoteHostProviderProxyFrame against expected
 * fields.  Returns undefined on match, an error code string on mismatch.
 */
function validateFrame(frame: RemoteHostProviderProxyFrame, check: FrameCheck): ProviderCallCodecErrorCode | undefined {
	if (typeof frame !== "object" || frame === null) return "FRAME_MISMATCH";
	// Access frame fields through the known discriminated union.
	switch (check.expectKind) {
		case "model_call_request": {
			if (frame.proxyType !== "model_call_request") return "FRAME_MISMATCH";
			if (frame.callId !== check.callId) return "FRAME_MISMATCH";
			const digestResult = canonicalDigest(frame);
			if (!digestResult.ok) return "FRAME_MISMATCH";
			if (!digestsEqual(digestResult.value, check.digest)) return "FRAME_MISMATCH";
			return undefined;
		}
		case "model_call_chunk": {
			if (frame.proxyType !== "model_call_chunk") return "FRAME_MISMATCH";
			if (frame.callId !== check.callId) return "FRAME_MISMATCH";
			if (frame.index !== check.index) return "FRAME_MISMATCH";
			return undefined;
		}
		case "model_call_complete": {
			if (frame.proxyType !== "model_call_complete") return "FRAME_MISMATCH";
			if (frame.callId !== check.callId) return "FRAME_MISMATCH";
			if (frame.usage !== undefined) {
				if (typeof frame.usage !== "object" || frame.usage === null) return "INVALID_USAGE";
				if (typeof frame.usage.inputTokens !== "number" || !isNonNegativeSafeInt(frame.usage.inputTokens))
					return "INVALID_USAGE";
				if (typeof frame.usage.outputTokens !== "number" || !isNonNegativeSafeInt(frame.usage.outputTokens))
					return "INVALID_USAGE";
			}
			return undefined;
		}
		case "model_call_error": {
			if (frame.proxyType !== "model_call_error") return "FRAME_MISMATCH";
			if (frame.callId !== check.callId) return "FRAME_MISMATCH";
			if (!FIXED_ERROR_CODES.has(frame.error)) return "FRAME_MISMATCH";
			return undefined;
		}
	}
}

// ===========================================================================
// extractRecordKind — single-pass descriptor read of recordKind from raw
// ===========================================================================

function extractRecordKind(raw: unknown): ProviderCallRecordKind | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	try {
		const proto = Object.getPrototypeOf(raw);
		if (proto !== null && proto !== Object.prototype) return undefined;
		const descs = Object.getOwnPropertyDescriptors(raw);
		const desc = descs.recordKind;
		if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) return undefined;
		const v = desc.value;
		if (typeof v !== "string") return undefined;
		switch (v) {
			case "journaled":
			case "started":
			case "chunk":
			case "terminal":
			case "delivered":
			case "cancel_requested":
				return v;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

// ===========================================================================
// decodeAndVerifyFrame — decode base64 bytes, verify digest, parse + match
// ===========================================================================

function decodeAndVerifyFrame(base64: string, expectedDigest: string): Uint8Array | undefined {
	const bytes = b64DecodeStrict(base64);
	if (bytes === undefined) return undefined;
	const computedDigest = sha256Of(bytes);
	if (!digestsEqual(computedDigest, expectedDigest)) return undefined;
	return bytes;
}

function parseAndMatchFrame(bytes: Uint8Array, check: FrameCheck): RemoteHostProviderProxyFrame | undefined {
	let frameStr: string;
	try {
		frameStr = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(frameStr);
	} catch {
		return undefined;
	}
	const decoded = decodeProviderProxyFrame(parsed);
	if (!decoded.ok) return undefined;
	const err = validateFrame(decoded.value, check);
	if (err !== undefined) return undefined;
	return decoded.value;
}

// ===========================================================================
// encodeProviderCallRecordV1
// ===========================================================================

export function encodeProviderCallRecordV1(raw: unknown): ProviderCallEncodeResult {
	try {
		return encodeV1Impl(raw);
	} catch {
		return { ok: false, error: codecError("INVALID_RECORD") };
	}
}

function encodeV1Impl(raw: unknown): ProviderCallEncodeResult {
	const kind = extractRecordKind(raw);
	if (kind === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	switch (kind) {
		case "journaled":
			return encodeJournaled(raw);
		case "started":
			return encodeStarted(raw);
		case "chunk":
			return encodeChunk(raw);
		case "terminal":
			return encodeTerminal(raw);
		case "delivered":
			return encodeDelivered(raw);
		case "cancel_requested":
			return encodeCancel(raw);
	}
}

// ── Journaled encode ──────────────────────────────────────────────────

const JOURNALED_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"requestFrameId",
	"requestDigest",
	"requestBytes",
	"canonicalRequestDigest",
]);
const JOURNALED_KEY_COUNT = 12;

function encodeJournaled(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, JOURNALED_ENCODE_KEYS, JOURNALED_KEY_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };
	// requestFrameId is the transport envelope frameId, NOT related to the
	// contained provider frame.  requestBytes store only the provider frame
	// (type: "provider_proxy", proxyType: "model_call_request"), not the
	// full envelope.  requestDigest is canonicalDigest(decoded provider frame).
	const requestFrameId = obj.requestFrameId;
	if (typeof requestFrameId !== "string" || !SAFE_ID_RE.test(requestFrameId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const requestDigest = obj.requestDigest;
	if (typeof requestDigest !== "string" || !isValidDigest(requestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const requestBytes = obj.requestBytes;
	if (!isGenuineUint8Array(requestBytes)) return { ok: false, error: codecError("INVALID_FRAME") };
	const canonicalRequestDigest = obj.canonicalRequestDigest;
	if (typeof canonicalRequestDigest !== "string" || !isValidDigest(canonicalRequestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	// Verify digest matches the bytes.
	const computedDigest = sha256Of(requestBytes);
	if (!digestsEqual(computedDigest, canonicalRequestDigest)) return { ok: false, error: codecError("INVALID_DIGEST") };

	// Decode and verify contained frame.
	const frameBytes = ownCopy(requestBytes);
	const frame = parseAndMatchFrame(frameBytes, {
		expectKind: "model_call_request",
		callId,
		digest: requestDigest,
	});
	if (frame === undefined) return { ok: false, error: codecError("FRAME_MISMATCH") };

	// Build canonical JSON object with base64-encoded bytes.
	const canonicalRequestBase64 = b64Encode(frameBytes);
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "journaled";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.requestFrameId = requestFrameId;
	jsonObj.requestDigest = requestDigest;
	jsonObj.canonicalRequestBase64 = canonicalRequestBase64;
	jsonObj.canonicalRequestDigest = canonicalRequestDigest;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallJournaledRecordV1 = Object.freeze({
		version: 1,
		recordKind: "journaled",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		requestFrameId,
		requestDigest,
		requestBytes: frameBytes,
		canonicalRequestDigest,
	});
	return encOk(encodedBytes, record);
}

// ── Started encode ────────────────────────────────────────────────────

const STARTED_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"requestDigest",
	"requestJournalSeq",
	"requestReceipt",
]);
const STARTED_KEY_COUNT = 11;

function encodeStarted(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, STARTED_ENCODE_KEYS, STARTED_KEY_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };
	const requestDigest = obj.requestDigest;
	if (typeof requestDigest !== "string" || !isValidDigest(requestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const requestJournalSeq = obj.requestJournalSeq;
	if (
		typeof requestJournalSeq !== "number" ||
		!isPositiveSafeInt(requestJournalSeq) ||
		requestJournalSeq > MAX_JOURNAL_SEQ
	)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const requestReceipt = decodeDurableReceipt(obj.requestReceipt);
	if (requestReceipt === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "started";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.requestDigest = requestDigest;
	jsonObj.requestJournalSeq = requestJournalSeq;
	jsonObj.requestReceipt = requestReceipt;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallStartedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "started",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		requestDigest,
		requestJournalSeq,
		requestReceipt,
	});
	return encOk(encodedBytes, record);
}

// ── Chunk encode ──────────────────────────────────────────────────────

const CHUNK_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"chunkIndex",
	"chunkFrameBytes",
	"chunkFrameDigest",
]);
const CHUNK_KEY_COUNT = 11;

function encodeChunk(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, CHUNK_ENCODE_KEYS, CHUNK_KEY_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };
	const chunkIndex = obj.chunkIndex;
	if (typeof chunkIndex !== "number" || !isNonNegativeSafeInt(chunkIndex))
		return { ok: false, error: codecError("INVALID_CHUNK_INDEX") };
	const chunkFrameBytes = obj.chunkFrameBytes;
	if (!isGenuineUint8Array(chunkFrameBytes)) return { ok: false, error: codecError("INVALID_FRAME") };
	const chunkFrameDigest = obj.chunkFrameDigest;
	if (typeof chunkFrameDigest !== "string" || !isValidDigest(chunkFrameDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	const computedDigest = sha256Of(chunkFrameBytes);
	if (!digestsEqual(computedDigest, chunkFrameDigest)) return { ok: false, error: codecError("INVALID_DIGEST") };

	const frameBytes = ownCopy(chunkFrameBytes);
	const frame = parseAndMatchFrame(frameBytes, {
		expectKind: "model_call_chunk",
		callId,
		index: chunkIndex,
	});
	if (frame === undefined) return { ok: false, error: codecError("FRAME_MISMATCH") };

	const chunkFrameBase64 = b64Encode(frameBytes);
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "chunk";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.chunkIndex = chunkIndex;
	jsonObj.chunkFrameBase64 = chunkFrameBase64;
	jsonObj.chunkFrameDigest = chunkFrameDigest;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallChunkRecordV1 = Object.freeze({
		version: 1,
		recordKind: "chunk",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		chunkIndex,
		chunkFrameBytes: frameBytes,
		chunkFrameDigest,
	});
	return encOk(encodedBytes, record);
}

// ── Terminal encode ───────────────────────────────────────────────────

const TERMINAL_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"terminalKind",
	"chunkCount",
	"terminalFrameBytes",
	"terminalFrameDigest",
	"usageInputTokens",
	"usageOutputTokens",
]);

function encodeTerminal(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, TERMINAL_ENCODE_KEYS, null);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };
	const terminalKind = obj.terminalKind;
	if (typeof terminalKind !== "string" || !isTerminalKind(terminalKind))
		return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
	const chunkCount = obj.chunkCount;
	if (typeof chunkCount !== "number" || !isNonNegativeSafeInt(chunkCount))
		return { ok: false, error: codecError("INVALID_CHUNK_INDEX") };
	const terminalFrameBytes = obj.terminalFrameBytes;
	if (!isGenuineUint8Array(terminalFrameBytes)) return { ok: false, error: codecError("INVALID_FRAME") };
	const terminalFrameDigest = obj.terminalFrameDigest;
	if (typeof terminalFrameDigest !== "string" || !isValidDigest(terminalFrameDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	const usageInputTokensRaw = obj.usageInputTokens;
	const usageOutputTokensRaw = obj.usageOutputTokens;
	const hasUsageInput = usageInputTokensRaw !== undefined;
	const hasUsageOutput = usageOutputTokensRaw !== undefined;
	if (hasUsageInput && (typeof usageInputTokensRaw !== "number" || !isNonNegativeSafeInt(usageInputTokensRaw)))
		return { ok: false, error: codecError("INVALID_USAGE") };
	if (hasUsageOutput && (typeof usageOutputTokensRaw !== "number" || !isNonNegativeSafeInt(usageOutputTokensRaw)))
		return { ok: false, error: codecError("INVALID_USAGE") };

	const computedDigest = sha256Of(terminalFrameBytes);
	if (!digestsEqual(computedDigest, terminalFrameDigest)) return { ok: false, error: codecError("INVALID_DIGEST") };

	const frameBytes = ownCopy(terminalFrameBytes);

	// Terminal frame must be model_call_complete or model_call_error.
	const frameStr = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(frameStr);
	} catch {
		return { ok: false, error: codecError("FRAME_MISMATCH") };
	}
	const decoded = decodeProviderProxyFrame(parsed);
	if (!decoded.ok) return { ok: false, error: codecError("FRAME_MISMATCH") };
	const proxyType = decoded.value.proxyType;
	if (proxyType !== "model_call_complete" && proxyType !== "model_call_error")
		return { ok: false, error: codecError("FRAME_MISMATCH") };
	const err = validateFrame(decoded.value, {
		expectKind: proxyType,
		callId,
	});
	if (err !== undefined) return { ok: false, error: codecError(err) };

	// Enforce terminalKind mapping per contract:
	//   normal ↔ model_call_complete OR model_call_error with non-INTERRUPTED/CANCELLED code
	//   interrupted ↔ model_call_error + PROVIDER_CALL_INTERRUPTED
	//   cancelled ↔ model_call_error + PROVIDER_CALL_CANCELLED
	if (proxyType === "model_call_complete") {
		if (terminalKind !== "normal") return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		// Usage must match frame: both present OR both absent, equal when present.
		const frameUsage = decoded.value.usage;
		if (hasUsageInput !== (frameUsage !== undefined)) return { ok: false, error: codecError("INVALID_USAGE") };
		if (hasUsageOutput !== (frameUsage !== undefined)) return { ok: false, error: codecError("INVALID_USAGE") };
		if (frameUsage !== undefined) {
			if (usageInputTokensRaw !== frameUsage.inputTokens || usageOutputTokensRaw !== frameUsage.outputTokens)
				return { ok: false, error: codecError("INVALID_USAGE") };
		}
	} else {
		// model_call_error — no usage allowed, kind depends on error code.
		if (hasUsageInput || hasUsageOutput) return { ok: false, error: codecError("INVALID_USAGE") };
		const frameError = decoded.value.error;
		if (terminalKind === "interrupted") {
			if (frameError !== "PROVIDER_CALL_INTERRUPTED")
				return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else if (terminalKind === "cancelled") {
			if (frameError !== "PROVIDER_CALL_CANCELLED") return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else if (terminalKind === "normal") {
			// normal allows model_call_error with non-INTERRUPTED/non-CANCELLED codes.
			if (frameError === "PROVIDER_CALL_INTERRUPTED" || frameError === "PROVIDER_CALL_CANCELLED")
				return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else {
			return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		}
	}

	const terminalFrameBase64 = b64Encode(frameBytes);
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "terminal";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.terminalKind = terminalKind;
	jsonObj.chunkCount = chunkCount;
	jsonObj.terminalFrameBase64 = terminalFrameBase64;
	jsonObj.terminalFrameDigest = terminalFrameDigest;
	if (hasUsageInput) jsonObj.usageInputTokens = usageInputTokensRaw;
	if (hasUsageOutput) jsonObj.usageOutputTokens = usageOutputTokensRaw;

	const jsonStr2 = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr2);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallTerminalRecordV1 = Object.freeze({
		version: 1,
		recordKind: "terminal",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		terminalKind,
		chunkCount,
		terminalFrameBytes: frameBytes,
		terminalFrameDigest,
		...(hasUsageInput ? { usageInputTokens: usageInputTokensRaw } : {}),
		...(hasUsageOutput ? { usageOutputTokens: usageOutputTokensRaw } : {}),
	});
	return encOk(encodedBytes, record);
}

// ── Delivered encode ──────────────────────────────────────────────────

const DELIVERED_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"ackEnvelopeId",
	"ackEnvelopeDigest",
	"outgoingRelayReceipt",
]);
const DELIVERED_KEY_COUNT = 11;

function encodeDelivered(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, DELIVERED_ENCODE_KEYS, DELIVERED_KEY_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };
	const ackEnvelopeId = obj.ackEnvelopeId;
	if (typeof ackEnvelopeId !== "string" || !SAFE_ID_RE.test(ackEnvelopeId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const ackEnvelopeDigest = obj.ackEnvelopeDigest;
	if (typeof ackEnvelopeDigest !== "string" || !isValidDigest(ackEnvelopeDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const outgoingRelayReceipt = decodeDurableReceipt(obj.outgoingRelayReceipt);
	if (outgoingRelayReceipt === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "delivered";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.ackEnvelopeId = ackEnvelopeId;
	jsonObj.ackEnvelopeDigest = ackEnvelopeDigest;
	jsonObj.outgoingRelayReceipt = outgoingRelayReceipt;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallDeliveredRecordV1 = Object.freeze({
		version: 1,
		recordKind: "delivered",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		ackEnvelopeId,
		ackEnvelopeDigest,
		outgoingRelayReceipt,
	});
	return encOk(encodedBytes, record);
}

// ── Cancel encode ─────────────────────────────────────────────────────

const CANCEL_ENCODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
]);
const CANCEL_KEY_COUNT = 8;

function encodeCancel(raw: unknown): ProviderCallEncodeResult {
	const obj = copyExactOwnRecordObject(raw, CANCEL_ENCODE_KEYS, CANCEL_KEY_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };
	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "cancel_requested";
	jsonObj.journalSeq = journalSeq;
	jsonObj.callId = callId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	const record: ProviderCallCancelRequestedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "cancel_requested",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
	});
	return encOk(encodedBytes, record);
}

// ===========================================================================
// Decode — six separate variant decoders with typed local variables
// ===========================================================================

export function decodeProviderCallRecordV1(encoded: Uint8Array): ProviderCallDecodeResult {
	try {
		return decodeV1Impl(encoded);
	} catch {
		return { ok: false, error: codecError("INVALID_RECORD") };
	}
}

function decodeV1Impl(encoded: Uint8Array): ProviderCallDecodeResult {
	// Validate the byte input as a genuine full-backing Uint8Array.
	if (!isGenuineUint8Array(encoded)) return { ok: false, error: codecError("INVALID_ARGUMENT") };

	// Enforce max bytes before parsing.
	if (encoded.byteLength > MAX_ENCODED_BYTES) return { ok: false, error: codecError("OVERFLOW") };

	// Decode UTF-8 with fatal error on invalid sequences.
	let jsonStr: string;
	try {
		jsonStr = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
	} catch {
		return { ok: false, error: codecError("INVALID_RECORD") };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return { ok: false, error: codecError("INVALID_RECORD") };
	}

	const kind = extractRecordKind(parsed);
	if (kind === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	// Pass the original encoded bytes so variant decoders can re-encode and
	// compare byte-for-byte, detecting whitespace/duplicate-key/reordered-key
	// inputs that JSON.parse silently accepts.
	switch (kind) {
		case "journaled":
			return decodeJournaled(parsed, encoded);
		case "started":
			return decodeStarted(parsed, encoded);
		case "chunk":
			return decodeChunk(parsed, encoded);
		case "terminal":
			return decodeTerminal(parsed, encoded);
		case "delivered":
			return decodeDelivered(parsed, encoded);
		case "cancel_requested":
			return decodeCancel(parsed, encoded);
	}
}

// ── Journaled decode ──────────────────────────────────────────────────

const JOURNALED_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"requestFrameId",
	"requestDigest",
	"canonicalRequestBase64",
	"canonicalRequestDigest",
]);
const JOURNALED_DECODE_COUNT = 12;

/**
 * Verify that parsed JSON uses canonical (sorted) key order by
 * re-serializing in canonical order and comparing to the original.
 * This detects reordered keys, duplicate keys, and whitespace changes.
 */
function verifyCanonicalKeyOrder(parsed: unknown, allowedKeys: ReadonlySet<string>): boolean {
	if (typeof parsed !== "object" || parsed === null) return false;
	const canon = Object.create(null);
	// Use insertion order from the Set (which matches canonical key order).
	const sorted = Array.from(allowedKeys);
	for (const k of sorted) {
		if (!Object.hasOwn(parsed, k)) continue;
		const desc = Object.getOwnPropertyDescriptor(parsed, k);
		if (desc === undefined || desc.get !== undefined || desc.set !== undefined) return false;
		canon[k] = desc.value;
	}
	const canonStr = JSON.stringify(canon);
	const rawStr = JSON.stringify(parsed);
	return canonStr === rawStr;
}

/**
 * Re-encode the parsed object using strict canonical JSON and compare
 * byte-for-byte to the original input.  This detects whitespace,
 * duplicate keys, reordered keys, and any other non-canonical encoding
 * that JSON.parse silently accepts.
 */
function verifyCanonicalReencode(originalBytes: Uint8Array, canonicalObj: Record<string, unknown>): boolean {
	const canonJson = JSON.stringify(canonicalObj);
	const canonBytes = new TextEncoder().encode(canonJson);
	if (canonBytes.byteLength !== originalBytes.byteLength) return false;
	for (let i = 0; i < canonBytes.byteLength; i++) {
		if (canonBytes[i] !== originalBytes[i]) return false;
	}
	return true;
}

function decodeJournaled(parsed: unknown, originalBytes: Uint8Array): ProviderCallDecodeResult {
	// Verify canonical key ordering by re-serializing with explicit canonical order.
	if (!verifyCanonicalKeyOrder(parsed, JOURNALED_DECODE_KEYS))
		return { ok: false, error: codecError("INVALID_RECORD") };
	const obj = copyExactOwnRecordObject(parsed, JOURNALED_DECODE_KEYS, JOURNALED_DECODE_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	// requestFrameId is the transport envelope frameId, NOT related to the
	// contained provider frame.  requestBytes store only the provider frame
	// (type: "provider_proxy", proxyType: "model_call_request"), not the
	// full envelope.  requestDigest is canonicalDigest(decoded provider frame).
	const requestFrameId = obj.requestFrameId;
	if (typeof requestFrameId !== "string" || !SAFE_ID_RE.test(requestFrameId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const requestDigest = obj.requestDigest;
	if (typeof requestDigest !== "string" || !isValidDigest(requestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const canonicalRequestBase64 = obj.canonicalRequestBase64;
	if (typeof canonicalRequestBase64 !== "string" || canonicalRequestBase64.length === 0)
		return { ok: false, error: codecError("INVALID_BASE64") };
	const canonicalRequestDigest = obj.canonicalRequestDigest;
	if (typeof canonicalRequestDigest !== "string" || !isValidDigest(canonicalRequestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	// Decode base64, verify digest.
	const bytes = decodeAndVerifyFrame(canonicalRequestBase64, canonicalRequestDigest);
	if (bytes === undefined) return { ok: false, error: codecError("INVALID_DIGEST") };

	// Decode and verify contained frame.
	const frame = parseAndMatchFrame(bytes, {
		expectKind: "model_call_request",
		callId,
		digest: requestDigest,
	});
	if (frame === undefined) return { ok: false, error: codecError("FRAME_MISMATCH") };

	// Prove canonical encoding: re-encode and compare byte-for-byte.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "journaled",
			journalSeq,
			callId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			requestFrameId,
			requestDigest,
			canonicalRequestBase64: b64Encode(bytes),
			canonicalRequestDigest,
		})
	)
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallJournaledRecordV1 = Object.freeze({
		version: 1,
		recordKind: "journaled",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		requestFrameId,
		requestDigest,
		requestBytes: bytes,
		canonicalRequestDigest,
	});
	return decOk(record);
}

// ── Started decode ────────────────────────────────────────────────────

const STARTED_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"requestDigest",
	"requestJournalSeq",
	"requestReceipt",
]);
const STARTED_DECODE_COUNT = 11;

function decodeStarted(parsed: unknown, originalBytes: Uint8Array): ProviderCallDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, STARTED_DECODE_KEYS, STARTED_DECODE_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	const requestDigest = obj.requestDigest;
	if (typeof requestDigest !== "string" || !isValidDigest(requestDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const requestJournalSeq = obj.requestJournalSeq;
	if (
		typeof requestJournalSeq !== "number" ||
		!isPositiveSafeInt(requestJournalSeq) ||
		requestJournalSeq > MAX_JOURNAL_SEQ
	)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };

	const requestReceipt = decodeDurableReceipt(obj.requestReceipt);
	if (requestReceipt === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "started",
			journalSeq,
			callId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			requestDigest,
			requestJournalSeq,
			requestReceipt,
		})
	)
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallStartedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "started",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		requestDigest,
		requestJournalSeq,
		requestReceipt,
	});
	return decOk(record);
}

// ── Chunk decode ──────────────────────────────────────────────────────

const CHUNK_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"chunkIndex",
	"chunkFrameBase64",
	"chunkFrameDigest",
]);
const CHUNK_DECODE_COUNT = 11;

function decodeChunk(parsed: unknown, originalBytes: Uint8Array): ProviderCallDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, CHUNK_DECODE_KEYS, CHUNK_DECODE_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	const chunkIndex = obj.chunkIndex;
	if (typeof chunkIndex !== "number" || !isNonNegativeSafeInt(chunkIndex))
		return { ok: false, error: codecError("INVALID_CHUNK_INDEX") };
	const chunkFrameBase64 = obj.chunkFrameBase64;
	if (typeof chunkFrameBase64 !== "string" || chunkFrameBase64.length === 0)
		return { ok: false, error: codecError("INVALID_BASE64") };
	const chunkFrameDigest = obj.chunkFrameDigest;
	if (typeof chunkFrameDigest !== "string" || !isValidDigest(chunkFrameDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	const bytes = decodeAndVerifyFrame(chunkFrameBase64, chunkFrameDigest);
	if (bytes === undefined) return { ok: false, error: codecError("INVALID_DIGEST") };

	const frame = parseAndMatchFrame(bytes, {
		expectKind: "model_call_chunk",
		callId,
		index: chunkIndex,
	});
	if (frame === undefined) return { ok: false, error: codecError("FRAME_MISMATCH") };

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "chunk",
			journalSeq,
			callId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			chunkIndex,
			chunkFrameBase64: chunkFrameBase64,
			chunkFrameDigest,
		})
	)
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallChunkRecordV1 = Object.freeze({
		version: 1,
		recordKind: "chunk",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		chunkIndex,
		chunkFrameBytes: bytes,
		chunkFrameDigest,
	});
	return decOk(record);
}

// ── Terminal decode ───────────────────────────────────────────────────

const TERMINAL_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"terminalKind",
	"chunkCount",
	"terminalFrameBase64",
	"terminalFrameDigest",
	"usageInputTokens",
	"usageOutputTokens",
]);

function decodeTerminal(parsed: unknown, _originalBytes: Uint8Array): ProviderCallDecodeResult {
	if (!verifyCanonicalKeyOrder(parsed, TERMINAL_DECODE_KEYS))
		return { ok: false, error: codecError("INVALID_RECORD") };
	const obj = copyExactOwnRecordObject(parsed, TERMINAL_DECODE_KEYS, null);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	const terminalKind = obj.terminalKind;
	if (typeof terminalKind !== "string" || !isTerminalKind(terminalKind))
		return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
	const chunkCount = obj.chunkCount;
	if (typeof chunkCount !== "number" || !isNonNegativeSafeInt(chunkCount))
		return { ok: false, error: codecError("INVALID_CHUNK_INDEX") };
	const terminalFrameBase64 = obj.terminalFrameBase64;
	if (typeof terminalFrameBase64 !== "string" || terminalFrameBase64.length === 0)
		return { ok: false, error: codecError("INVALID_BASE64") };
	const terminalFrameDigest = obj.terminalFrameDigest;
	if (typeof terminalFrameDigest !== "string" || !isValidDigest(terminalFrameDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };

	const usageInputTokensRaw = obj.usageInputTokens;
	const usageOutputTokensRaw = obj.usageOutputTokens;
	const hasUsageInput = usageInputTokensRaw !== undefined;
	const hasUsageOutput = usageOutputTokensRaw !== undefined;
	if (hasUsageInput && (typeof usageInputTokensRaw !== "number" || !isNonNegativeSafeInt(usageInputTokensRaw)))
		return { ok: false, error: codecError("INVALID_USAGE") };
	if (hasUsageOutput && (typeof usageOutputTokensRaw !== "number" || !isNonNegativeSafeInt(usageOutputTokensRaw)))
		return { ok: false, error: codecError("INVALID_USAGE") };

	const bytes = decodeAndVerifyFrame(terminalFrameBase64, terminalFrameDigest);
	if (bytes === undefined) return { ok: false, error: codecError("INVALID_DIGEST") };

	// Terminal frame must be model_call_complete or model_call_error.
	const frameStr = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	let frameParsed: unknown;
	try {
		frameParsed = JSON.parse(frameStr);
	} catch {
		return { ok: false, error: codecError("FRAME_MISMATCH") };
	}
	const decoded = decodeProviderProxyFrame(frameParsed);
	if (!decoded.ok) return { ok: false, error: codecError("FRAME_MISMATCH") };
	const proxyType = decoded.value.proxyType;
	if (proxyType !== "model_call_complete" && proxyType !== "model_call_error")
		return { ok: false, error: codecError("FRAME_MISMATCH") };
	const verr = validateFrame(decoded.value, {
		expectKind: proxyType,
		callId,
	});
	if (verr !== undefined) return { ok: false, error: codecError(verr) };

	// Enforce terminalKind mapping per contract.
	if (proxyType === "model_call_complete") {
		if (terminalKind !== "normal") return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		const frameUsage = decoded.value.usage;
		if (hasUsageInput !== (frameUsage !== undefined)) return { ok: false, error: codecError("INVALID_USAGE") };
		if (hasUsageOutput !== (frameUsage !== undefined)) return { ok: false, error: codecError("INVALID_USAGE") };
		if (frameUsage !== undefined) {
			if (usageInputTokensRaw !== frameUsage.inputTokens || usageOutputTokensRaw !== frameUsage.outputTokens)
				return { ok: false, error: codecError("INVALID_USAGE") };
		}
	} else {
		// model_call_error — no usage allowed, kind depends on error code.
		if (hasUsageInput || hasUsageOutput) return { ok: false, error: codecError("INVALID_USAGE") };
		const frameError = decoded.value.error;
		if (terminalKind === "interrupted") {
			if (frameError !== "PROVIDER_CALL_INTERRUPTED")
				return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else if (terminalKind === "cancelled") {
			if (frameError !== "PROVIDER_CALL_CANCELLED") return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else if (terminalKind === "normal") {
			if (frameError === "PROVIDER_CALL_INTERRUPTED" || frameError === "PROVIDER_CALL_CANCELLED")
				return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		} else {
			return { ok: false, error: codecError("INVALID_TERMINAL_KIND") };
		}
	}

	// Prove canonical encoding.
	const canonTerminal: Record<string, unknown> = Object.create(null);
	canonTerminal.version = 1;
	canonTerminal.recordKind = "terminal";
	canonTerminal.journalSeq = journalSeq;
	canonTerminal.callId = callId;
	canonTerminal.hostId = hostId;
	canonTerminal.generation = generation;
	canonTerminal.sessionId = sessionId;
	canonTerminal.recordedAt = recordedAt;
	canonTerminal.terminalKind = terminalKind;
	canonTerminal.chunkCount = chunkCount;
	canonTerminal.terminalFrameBase64 = terminalFrameBase64;
	canonTerminal.terminalFrameDigest = terminalFrameDigest;
	if (hasUsageInput) canonTerminal.usageInputTokens = usageInputTokensRaw;
	if (hasUsageOutput) canonTerminal.usageOutputTokens = usageOutputTokensRaw;
	if (!verifyCanonicalReencode(_originalBytes, canonTerminal))
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallTerminalRecordV1 = Object.freeze({
		version: 1,
		recordKind: "terminal",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		terminalKind,
		chunkCount,
		terminalFrameBytes: bytes,
		terminalFrameDigest,
		...(hasUsageInput ? { usageInputTokens: usageInputTokensRaw } : {}),
		...(hasUsageOutput ? { usageOutputTokens: usageOutputTokensRaw } : {}),
	});
	return decOk(record);
}

// ── Delivered decode ──────────────────────────────────────────────────

const DELIVERED_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"ackEnvelopeId",
	"ackEnvelopeDigest",
	"outgoingRelayReceipt",
]);
const DELIVERED_DECODE_COUNT = 11;

function decodeDelivered(parsed: unknown, originalBytes: Uint8Array): ProviderCallDecodeResult {
	if (!verifyCanonicalKeyOrder(parsed, DELIVERED_DECODE_KEYS))
		return { ok: false, error: codecError("INVALID_RECORD") };
	const obj = copyExactOwnRecordObject(parsed, DELIVERED_DECODE_KEYS, DELIVERED_DECODE_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	const ackEnvelopeId = obj.ackEnvelopeId;
	if (typeof ackEnvelopeId !== "string" || !SAFE_ID_RE.test(ackEnvelopeId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const ackEnvelopeDigest = obj.ackEnvelopeDigest;
	if (typeof ackEnvelopeDigest !== "string" || !isValidDigest(ackEnvelopeDigest))
		return { ok: false, error: codecError("INVALID_DIGEST") };
	const outgoingRelayReceipt = decodeDurableReceipt(obj.outgoingRelayReceipt);
	if (outgoingRelayReceipt === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "delivered",
			journalSeq,
			callId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			ackEnvelopeId,
			ackEnvelopeDigest,
			outgoingRelayReceipt,
		})
	)
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallDeliveredRecordV1 = Object.freeze({
		version: 1,
		recordKind: "delivered",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		ackEnvelopeId,
		ackEnvelopeDigest,
		outgoingRelayReceipt,
	});
	return decOk(record);
}

// ── Cancel decode ─────────────────────────────────────────────────────

const CANCEL_DECODE_KEYS = new Set([
	"version",
	"recordKind",
	"journalSeq",
	"callId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
]);
const CANCEL_DECODE_COUNT = 8;

function decodeCancel(parsed: unknown, originalBytes: Uint8Array): ProviderCallDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, CANCEL_DECODE_KEYS, CANCEL_DECODE_COUNT);
	if (obj === undefined) return { ok: false, error: codecError("INVALID_RECORD") };

	const version = obj.version;
	if (version !== 1) return { ok: false, error: codecError("UNSUPPORTED_VERSION") };
	const journalSeq = obj.journalSeq;
	if (typeof journalSeq !== "number" || !isPositiveSafeInt(journalSeq) || journalSeq > MAX_JOURNAL_SEQ)
		return { ok: false, error: codecError("INVALID_SEQUENCE") };
	const callId = obj.callId;
	if (typeof callId !== "string" || !SAFE_ID_RE.test(callId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId))
		return { ok: false, error: codecError("INVALID_IDENTITY") };
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return { ok: false, error: codecError("INVALID_TIMESTAMP") };

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "cancel_requested",
			journalSeq,
			callId,
			hostId,
			generation,
			sessionId,
			recordedAt,
		})
	)
		return { ok: false, error: codecError("INVALID_RECORD") };

	const record: ProviderCallCancelRequestedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "cancel_requested",
		journalSeq,
		callId,
		hostId,
		generation,
		sessionId,
		recordedAt,
	});
	return decOk(record);
}
