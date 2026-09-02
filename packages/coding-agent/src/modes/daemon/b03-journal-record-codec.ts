/**
 * Pure B03 journal record v1 codec.
 *
 * Encodes and decodes journal records as fixed-key-order JSON with a
 * SHA-256 digest over the embedded envelope. No filesystem, store,
 * recovery, relay, or index logic -- just codec.
 *
 * Every input bytes buffer is erased (zero-filled) on every path.
 * All returned DTOs are deeply frozen with no aliases to inputs.
 * envelopeDigest is always derived internally -- never accepted as input.
 */

import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import {
	type CodecError,
	type CodecErrorCode,
	canonicalDigest,
	decodeEnvelope,
	digestsEqual,
	isCanonicalUtcTimestamp,
	isValidDigest,
	isValidSafeId,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_ENCODED_BYTES = 1_310_720; // 1.25 MiB

const CANONICAL_KEYS: readonly string[] = [
	"version",
	"journalSeq",
	"direction",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"envelope",
	"envelopeDigest",
];

const RECORD_VERSION = 1;

// ===========================================================================
// DTO types
// ===========================================================================

export type JournalDirection = "sent" | "received";

export interface JournalRecordV1 {
	readonly version: 1;
	readonly journalSeq: number;
	readonly direction: JournalDirection;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly recordedAt: string;
	readonly envelope: RemoteHostFrameEnvelope;
	readonly envelopeDigest: string;
}

export interface ExpectedFields {
	readonly journalSeq: number;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly direction?: JournalDirection;
}

// ===========================================================================
// Result unions (never-throw), frozen
// ===========================================================================

export interface EncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
	readonly record: JournalRecordV1;
}

export interface EncodeError {
	readonly ok: false;
	readonly error: CodecError;
}

export type EncodeJournalResult = EncodeOk | EncodeError;

export interface DecodeOk {
	readonly ok: true;
	readonly record: JournalRecordV1;
}

export interface DecodeError {
	readonly ok: false;
	readonly error: CodecError;
}

export type DecodeJournalResult = DecodeOk | DecodeError;

// ===========================================================================
// Frozen result builders
// ===========================================================================

function fail(code: CodecErrorCode): EncodeError & DecodeError {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function okEncode(bytes: Uint8Array, record: JournalRecordV1): EncodeOk {
	return Object.freeze({ ok: true, bytes, record });
}

function okDecode(record: JournalRecordV1): DecodeOk {
	return Object.freeze({ ok: true, record });
}

// ===========================================================================
// Helpers
// ===========================================================================

function erase(bytes: Uint8Array): void {
	try {
		bytes.fill(0);
	} catch {
		/* best effort */
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) deepFreeze(value[i]);
		return Object.freeze(value) as T;
	}
	if (Object.isFrozen(value)) return value;
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return value;
	const descs = Object.getOwnPropertyDescriptors(value);
	const keys = Object.getOwnPropertyNames(value);
	for (const k of keys) {
		if (descs[k].get || descs[k].set) continue;
		deepFreeze((value as Record<string, unknown>)[k]);
	}
	return Object.freeze(value) as T;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

// ===========================================================================
// Validate raw input is a plain object (no Proxy/getter/symbol/nonenumerable)
// Returns INVALID_FRAME error code or undefined
// ===========================================================================

function rawError(raw: unknown): CodecErrorCode | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "INVALID_FRAME";
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(raw);
	} catch {
		return "INVALID_FRAME";
	}
	if (proto !== null && proto !== Object.prototype) return "INVALID_FRAME";
	if (
		raw instanceof Uint8Array ||
		raw instanceof Int8Array ||
		raw instanceof Uint16Array ||
		raw instanceof Int16Array ||
		raw instanceof Uint32Array ||
		raw instanceof Int32Array ||
		raw instanceof Float32Array ||
		raw instanceof Float64Array ||
		raw instanceof DataView
	) {
		return "INVALID_FRAME";
	}
	let descs: PropertyDescriptorMap;
	try {
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return "INVALID_FRAME";
	}
	const keys = Object.getOwnPropertyNames(raw);
	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return "INVALID_FRAME";
	}
	if (symbols.length > 0) return "INVALID_FRAME";
	for (const k of keys) {
		const desc = descs[k];
		if (desc.get || desc.set) return "INVALID_FRAME";
		if (!desc.enumerable) return "INVALID_FRAME";
		try {
			if ((raw as Record<string, unknown>)[k] === undefined) return "INVALID_FRAME";
		} catch {
			return "INVALID_FRAME";
		}
	}
	return undefined;
}

// ===========================================================================
// Encode input keys (8 -- no envelopeDigest)
// ===========================================================================

const ENCODE_REQUIRED_KEYS: readonly string[] = [
	"version",
	"journalSeq",
	"direction",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"envelope",
];
const ENCODE_KEY_SET = new Set(ENCODE_REQUIRED_KEYS);

// ===========================================================================
// Build record in CANONICAL_KEYS insertion order
// ===========================================================================

function buildRecordObject(
	version: 1,
	journalSeq: number,
	direction: string,
	hostId: string,
	generation: string,
	sessionId: string,
	recordedAt: string,
	envelope: RemoteHostFrameEnvelope,
	envelopeDigest: string,
): Record<string, unknown> {
	const r: Record<string, unknown> = Object.create(null);
	r.version = version;
	r.journalSeq = journalSeq;
	r.direction = direction;
	r.hostId = hostId;
	r.generation = generation;
	r.sessionId = sessionId;
	r.recordedAt = recordedAt;
	r.envelope = envelope;
	r.envelopeDigest = envelopeDigest;
	return r;
}

// ===========================================================================
// encodeJournalRecordV1
// ===========================================================================

export function encodeJournalRecordV1(raw: unknown): EncodeJournalResult {
	try {
		return encodeJournalRecordV1Impl(raw);
	} catch {
		return fail("INVALID_FRAME");
	}
}

function encodeJournalRecordV1Impl(raw: unknown): EncodeJournalResult {
	// 1. Validate raw is trusted plain object
	const err = rawError(raw);
	if (err) return fail(err);

	const obj = raw as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);

	// 2. Exact key count + no extra keys (caller must not supply envelopeDigest)
	if (keys.length !== ENCODE_REQUIRED_KEYS.length) return fail("INVALID_FRAME");
	for (const k of keys) {
		if (!ENCODE_KEY_SET.has(k)) return fail("INVALID_FRAME");
	}

	// 3. Validate version
	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");

	// 4. Validate journalSeq
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	) {
		return fail("INVALID_SEQUENCE");
	}

	// 5. Validate direction
	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") return fail("INVALID_FRAME");

	// 6. Validate IDs
	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId)) return fail("INVALID_IDENTITY");
	if (typeof generation !== "string" || !isValidSafeId(generation)) return fail("INVALID_IDENTITY");
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId)) return fail("INVALID_IDENTITY");

	// 7. Validate recordedAt
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt)) return fail("INVALID_TIMESTAMP");

	// 8. Decode envelope using accepted codec (returns canonical-sorted nested DTO)
	const envelopeRaw = obj.envelope;
	const decodedEnvelope = decodeEnvelope(envelopeRaw);
	if (!decodedEnvelope.ok) return { ok: false, error: decodedEnvelope.error };
	const envelope = decodedEnvelope.value;

	// 9. Compute digest from decoded envelope
	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) return fail("INVALID_DIGEST");
	const envelopeDigest = digestResult.value;

	// 10. Build record in canonical key insertion order, then JSON.stringify
	//     preserves that order.  Nested objects from decodeEnvelope are already
	//     canonical-sorted.  No replacer or custom serializer needed.
	const recordObj = buildRecordObject(
		RECORD_VERSION,
		journalSeq,
		direction,
		hostId,
		generation,
		sessionId,
		recordedAt,
		envelope,
		envelopeDigest,
	);
	const frozen = deepFreeze(recordObj) as unknown as JournalRecordV1;

	// 11. Encode to JSON bytes (fixed insertion order)
	const canonStr = JSON.stringify(recordObj);
	const encoded = new TextEncoder().encode(canonStr);

	// 12. Check max size -- erase encoded before returning failure
	if (encoded.byteLength > MAX_ENCODED_BYTES) {
		erase(encoded);
		return fail("OVERFLOW");
	}

	return okEncode(encoded, frozen);
}

// ===========================================================================
// Decode: keys always include envelopeDigest (9 keys)
// ===========================================================================

const DECODE_KEYS = new Set(CANONICAL_KEYS);

// ===========================================================================
// validateExpected -- rejects empty/partial missing required fields
// ===========================================================================

function validateExpected(expected: unknown): ExpectedFields | undefined {
	if (expected === undefined) return undefined;
	const err = rawError(expected);
	if (err) return undefined;
	const obj = expected as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);
	const allowed = new Set(["journalSeq", "hostId", "generation", "sessionId", "direction"]);
	for (const k of keys) {
		if (!allowed.has(k)) return undefined;
	}
	if (
		obj.journalSeq === undefined ||
		obj.hostId === undefined ||
		obj.generation === undefined ||
		obj.sessionId === undefined
	)
		return undefined;
	if (
		typeof obj.journalSeq !== "number" ||
		!Number.isSafeInteger(obj.journalSeq) ||
		obj.journalSeq <= 0 ||
		obj.journalSeq > MAX_JOURNAL_SEQ
	)
		return undefined;
	for (const idField of ["hostId", "generation", "sessionId"] as const) {
		if (typeof obj[idField] !== "string" || !isValidSafeId(obj[idField] as string)) return undefined;
	}
	if (obj.direction !== undefined && obj.direction !== "sent" && obj.direction !== "received") return undefined;
	return expected as unknown as ExpectedFields;
}

// ===========================================================================
// decodeJournalRecordV1
// ===========================================================================

export function decodeJournalRecordV1(bytes: Uint8Array, expected: unknown): DecodeJournalResult {
	// ownBuffers tracks all allocated byte buffers for erasure in finally.
	// Includes the caller's `bytes` so every path erases it.
	const ownBuffers: Uint8Array[] = [];
	let erased = false;
	const eraseAll = () => {
		if (erased) return;
		erased = true;
		for (const b of ownBuffers) erase(b);
	};

	try {
		return decodeJournalRecordV1Impl(bytes, expected, ownBuffers);
	} finally {
		eraseAll();
	}
}

function decodeJournalRecordV1Impl(
	bytes: Uint8Array,
	expected: unknown,
	ownBuffers: Uint8Array[],
): DecodeJournalResult {
	// 1. Validate bytes
	if (typeof bytes !== "object" || bytes === null) return fail("INVALID_FRAME");
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(bytes);
	} catch {
		return fail("INVALID_FRAME");
	}
	if (proto !== Uint8Array.prototype) return fail("INVALID_FRAME");
	let buf: ArrayBufferLike;
	try {
		buf = bytes.buffer;
	} catch {
		return fail("INVALID_FRAME");
	}
	if (buf instanceof SharedArrayBuffer) return fail("INVALID_FRAME");
	try {
		if (buf.byteLength === 0 && bytes.length > 0) return fail("INVALID_FRAME");
		if (buf.byteLength !== bytes.byteLength) return fail("INVALID_FRAME");
		if (bytes.length > 0) {
			const _x = bytes[0];
			void _x;
		}
	} catch {
		return fail("INVALID_FRAME");
	}

	// The caller's `bytes` goes into ownBuffers so the outer finally
	// erases them even when UTF-8 parse or any intermediate step fails.
	ownBuffers.push(bytes);

	// 2. Snapshot original bytes (owned copy for canonical re-encoding comparison)
	let originalBytes: Uint8Array;
	try {
		originalBytes = new Uint8Array(bytes);
		ownBuffers.push(originalBytes);
	} catch {
		return fail("INVALID_FRAME");
	}

	// 3. Parse UTF-8 JSON
	let jsonStr: string;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		jsonStr = decoder.decode(bytes);
		// bytes are now decoded -- they remain in ownBuffers for finally erasure
	} catch {
		return fail("INVALID_FRAME");
	}

	// 4. Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return fail("INVALID_FRAME");
	}

	// 5. Validate parsed is trusted plain object
	const parseErr = rawError(parsed);
	if (parseErr) return fail(parseErr);
	const obj = parsed as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);

	// 6. Exact key count and no unknown keys
	if (keys.length !== CANONICAL_KEYS.length) return fail("INVALID_FRAME");
	for (const k of keys) {
		if (!DECODE_KEYS.has(k)) return fail("INVALID_FRAME");
	}

	// 7. Validate schema
	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");

	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	) {
		return fail("INVALID_SEQUENCE");
	}

	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") return fail("INVALID_FRAME");

	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId)) return fail("INVALID_IDENTITY");
	if (typeof generation !== "string" || !isValidSafeId(generation)) return fail("INVALID_IDENTITY");
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId)) return fail("INVALID_IDENTITY");

	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt)) return fail("INVALID_TIMESTAMP");

	const storedDigest = obj.envelopeDigest;
	if (typeof storedDigest !== "string" || !isValidDigest(storedDigest)) return fail("INVALID_DIGEST");

	// 8. Validate expected fields (if provided)
	const exp = validateExpected(expected);
	if (expected !== undefined && exp === undefined) return fail("INVALID_FRAME");
	if (exp !== undefined) {
		const expObj = exp as unknown as Record<string, unknown>;
		if (expObj.journalSeq !== journalSeq) return fail("MISMATCH");
		if (expObj.hostId !== hostId) return fail("MISMATCH");
		if (expObj.generation !== generation) return fail("MISMATCH");
		if (expObj.sessionId !== sessionId) return fail("MISMATCH");
		if (expObj.direction !== undefined && expObj.direction !== direction) return fail("MISMATCH");
	}

	// 9. Decode envelope using accepted codec
	const envelopeRaw = obj.envelope;
	const decodedEnvelope = decodeEnvelope(envelopeRaw);
	if (!decodedEnvelope.ok) return { ok: false, error: decodedEnvelope.error };
	const envelope = decodedEnvelope.value;

	// 10. Recompute digest from decoded envelope
	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) return fail("INVALID_DIGEST");
	const recomputedDigest = digestResult.value;

	// 11. Verify digest matches stored digest using accepted digestsEqual
	if (!digestsEqual(recomputedDigest, storedDigest)) return fail("INVALID_DIGEST");

	// 12. Build fresh record in canonical key insertion order
	const recordObj = buildRecordObject(
		RECORD_VERSION,
		journalSeq,
		direction,
		hostId,
		generation,
		sessionId,
		recordedAt,
		envelope,
		storedDigest,
	);

	// 13. Re-encode for canonical verification
	const canonStr = JSON.stringify(recordObj);
	const reEncoded = new TextEncoder().encode(canonStr);
	ownBuffers.push(reEncoded);

	// 14. Constant-time compare re-encoded bytes to original bytes
	if (!constantTimeEqual(reEncoded, originalBytes)) return fail("INVALID_DIGEST");

	// 15. Deep freeze and return
	const frozen = deepFreeze(recordObj) as unknown as JournalRecordV1;
	return okDecode(frozen);
}
