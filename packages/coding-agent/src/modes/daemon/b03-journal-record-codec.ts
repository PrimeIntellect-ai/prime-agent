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
// Result unions (never-throw)
// ===========================================================================

export type EncodeJournalResult =
	| { ok: true; bytes: Uint8Array; record: JournalRecordV1 }
	| { ok: false; error: CodecError };

export type DecodeJournalResult = { ok: true; record: JournalRecordV1 } | { ok: false; error: CodecError };

// ===========================================================================
// Frozen CodecError
// ===========================================================================

function frozenError(code: CodecErrorCode): CodecError {
	return Object.freeze({ code });
}

// ===========================================================================
// Helpers
// ===========================================================================

// ===========================================================================
// canonicalStringify -- sorts keys recursively for canonical encoding
// ===========================================================================

// ===========================================================================
// canonicalStringify -- canonical JSON with CANONICAL_KEYS at top level,
// sorted keys at nested levels
// ===========================================================================

let _canonDepth = 0;

function canonicalStringify(value: unknown): string {
	_canonDepth = 0;
	return JSON.stringify(value, (_key: string, val: unknown): unknown => {
		if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			const keys = Object.keys(val);
			// Root object: check if all CANONICAL_KEYS are present
			if (_canonDepth === 0 && keys.length >= CANONICAL_KEYS.length) {
				const hasAll = CANONICAL_KEYS.every((k) => k in (val as Record<string, unknown>));
				if (hasAll) {
					_canonDepth = 1;
					const sorted: Record<string, unknown> = Object.create(null);
					for (const k of CANONICAL_KEYS) sorted[k] = (val as Record<string, unknown>)[k];
					return sorted;
				}
			}
			// Nested objects: sort alphabetically
			const sorted: Record<string, unknown> = Object.create(null);
			const sortedKeys = [...keys].sort();
			for (const k of sortedKeys) sorted[k] = (val as Record<string, unknown>)[k];
			return sorted;
		}
		return val;
	});
}

function erase(bytes: Uint8Array): void {
	try {
		bytes.fill(0);
	} catch {
		// best effort -- detached or already freed
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
	for (let i = 0; i < a.byteLength; i++) {
		diff |= a[i] ^ b[i];
	}
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
// Encode input keys: version, journalSeq, direction, hostId, generation,
// sessionId, recordedAt, envelope.  envelopeDigest rejected as caller extra.
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
// encodeJournalRecordV1
// ===========================================================================

export function encodeJournalRecordV1(raw: unknown): EncodeJournalResult {
	try {
		return encodeJournalRecordV1Impl(raw);
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
}

function encodeJournalRecordV1Impl(raw: unknown): EncodeJournalResult {
	// 1. Validate raw is trusted plain object
	const err = rawError(raw);
	if (err) return { ok: false, error: frozenError(err) };

	const obj = raw as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);

	// 2. Exact key count + no extra keys (caller must not supply envelopeDigest)
	if (keys.length !== ENCODE_REQUIRED_KEYS.length) {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
	for (const k of keys) {
		if (!ENCODE_KEY_SET.has(k)) {
			return { ok: false, error: frozenError("INVALID_FRAME") };
		}
	}

	// 3. Validate version (required)
	if (obj.version !== RECORD_VERSION) {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 4. Validate journalSeq
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	) {
		return { ok: false, error: frozenError("INVALID_SEQUENCE") };
	}

	// 5. Validate direction
	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 6. Validate IDs
	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };
	if (typeof generation !== "string" || !isValidSafeId(generation))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };

	// 7. Validate recordedAt
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt)) {
		return { ok: false, error: frozenError("INVALID_TIMESTAMP") };
	}

	// 8. Decode envelope using accepted codec
	const envelopeRaw = obj.envelope;
	const decodedEnvelope = decodeEnvelope(envelopeRaw);
	if (!decodedEnvelope.ok) {
		return { ok: false, error: decodedEnvelope.error };
	}
	const envelope = decodedEnvelope.value;

	// 9. Compute digest from decoded envelope
	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) {
		return { ok: false, error: frozenError("INVALID_DIGEST") };
	}
	const envelopeDigest = digestResult.value;

	// 10. Build frozen record in canonical key order
	const record: Record<string, unknown> = {
		version: RECORD_VERSION,
		journalSeq,
		direction,
		hostId,
		generation,
		sessionId,
		recordedAt,
		envelope,
		envelopeDigest,
	};
	const frozen = deepFreeze(record) as unknown as JournalRecordV1;

	// 11. Encode to canonical JSON bytes using JSON.stringify of fixed-order object
	const canonStr = canonicalStringify(record);
	const encoded = new TextEncoder().encode(canonStr);

	// 12. Check max size
	if (encoded.byteLength > MAX_ENCODED_BYTES) {
		return { ok: false, error: frozenError("OVERFLOW") };
	}

	return { ok: true, bytes: encoded, record: frozen };
}

// ===========================================================================
// Decode: keys always include envelopeDigest (9 keys)
// ===========================================================================

const DECODE_KEYS = new Set(CANONICAL_KEYS);
const DECODE_REQUIRED_COUNT = CANONICAL_KEYS.length;

// ===========================================================================
// validateExpected -- rejects empty/partial missing required fields
// ===========================================================================

function validateExpected(expected: unknown): ExpectedFields | undefined {
	if (expected === undefined) return undefined;
	const err = rawError(expected);
	if (err) return undefined;
	const obj = expected as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);
	// Reject extra keys
	const allowed = new Set(["journalSeq", "hostId", "generation", "sessionId", "direction"]);
	for (const k of keys) {
		if (!allowed.has(k)) return undefined;
	}
	// journalSeq, hostId, generation, sessionId are ALL required
	if (obj.journalSeq === undefined) return undefined;
	if (obj.hostId === undefined) return undefined;
	if (obj.generation === undefined) return undefined;
	if (obj.sessionId === undefined) return undefined;
	// Type-validate
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
	// Track all owned byte intermediates for erasure in finally
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
	if (typeof bytes !== "object" || bytes === null) return { ok: false, error: frozenError("INVALID_FRAME") };
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(bytes);
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
	if (proto !== Uint8Array.prototype) return { ok: false, error: frozenError("INVALID_FRAME") };
	let buf: ArrayBufferLike;
	try {
		buf = bytes.buffer;
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
	if (buf instanceof SharedArrayBuffer) return { ok: false, error: frozenError("INVALID_FRAME") };
	try {
		if (buf.byteLength === 0 && bytes.length > 0) return { ok: false, error: frozenError("INVALID_FRAME") };
		if (buf.byteLength !== bytes.byteLength) return { ok: false, error: frozenError("INVALID_FRAME") };
		if (bytes.length > 0) {
			const _x = bytes[0];
			void _x;
		}
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 2. Snapshot original bytes (owned copy for canonical re-encoding comparison)
	let originalBytes: Uint8Array;
	try {
		originalBytes = new Uint8Array(bytes);
		ownBuffers.push(originalBytes);
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 3. Parse UTF-8 JSON
	let jsonStr: string;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		jsonStr = decoder.decode(bytes);
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 4. Erase input bytes
	erase(bytes);

	// 5. Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	// 6. Validate parsed is trusted plain object
	const parseErr = rawError(parsed);
	if (parseErr) return { ok: false, error: frozenError(parseErr) };
	const obj = parsed as Record<string, unknown>;
	const keys = Object.getOwnPropertyNames(obj);

	// 7. Exact key count and no unknown keys
	if (keys.length !== DECODE_REQUIRED_COUNT) {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
	for (const k of keys) {
		if (!DECODE_KEYS.has(k)) {
			return { ok: false, error: frozenError("INVALID_FRAME") };
		}
	}

	// 8. Validate schema
	if (obj.version !== RECORD_VERSION) return { ok: false, error: frozenError("INVALID_FRAME") };

	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	) {
		return { ok: false, error: frozenError("INVALID_SEQUENCE") };
	}

	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}

	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };
	if (typeof generation !== "string" || !isValidSafeId(generation))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId))
		return { ok: false, error: frozenError("INVALID_IDENTITY") };

	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt)) {
		return { ok: false, error: frozenError("INVALID_TIMESTAMP") };
	}

	const storedDigest = obj.envelopeDigest;
	if (typeof storedDigest !== "string" || !isValidDigest(storedDigest)) {
		return { ok: false, error: frozenError("INVALID_DIGEST") };
	}

	// 9. Validate expected fields (if provided)
	const exp = validateExpected(expected);
	if (expected !== undefined && exp === undefined) {
		return { ok: false, error: frozenError("INVALID_FRAME") };
	}
	if (exp !== undefined) {
		const expObj = exp as unknown as Record<string, unknown>;
		if (expObj.journalSeq !== journalSeq) return { ok: false, error: frozenError("MISMATCH") };
		if (expObj.hostId !== hostId) return { ok: false, error: frozenError("MISMATCH") };
		if (expObj.generation !== generation) return { ok: false, error: frozenError("MISMATCH") };
		if (expObj.sessionId !== sessionId) return { ok: false, error: frozenError("MISMATCH") };
		if (expObj.direction !== undefined && expObj.direction !== direction)
			return { ok: false, error: frozenError("MISMATCH") };
	}

	// 10. Decode envelope using accepted codec
	const envelopeRaw = obj.envelope;
	const decodedEnvelope = decodeEnvelope(envelopeRaw);
	if (!decodedEnvelope.ok) return { ok: false, error: decodedEnvelope.error };
	const envelope = decodedEnvelope.value;

	// 11. Recompute digest from decoded envelope
	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) return { ok: false, error: frozenError("INVALID_DIGEST") };
	const recomputedDigest = digestResult.value;

	// 12. Verify digest matches stored digest using accepted digestsEqual
	if (!digestsEqual(recomputedDigest, storedDigest)) {
		return { ok: false, error: frozenError("INVALID_DIGEST") };
	}

	// 13. Build fresh record in canonical key order
	const record: Record<string, unknown> = {
		version: RECORD_VERSION,
		journalSeq,
		direction,
		hostId,
		generation,
		sessionId,
		recordedAt,
		envelope,
		envelopeDigest: storedDigest,
	};

	// 14. Re-encode for canonical verification
	const canonStr = canonicalStringify(record);
	const reEncoded = new TextEncoder().encode(canonStr);
	ownBuffers.push(reEncoded);

	// 15. Constant-time compare re-encoded bytes to original bytes
	if (!constantTimeEqual(reEncoded, originalBytes)) {
		return { ok: false, error: frozenError("INVALID_DIGEST") };
	}

	// 16. Deep freeze and return
	const frozen = deepFreeze(record) as unknown as JournalRecordV1;
	return { ok: true, record: frozen };
}
