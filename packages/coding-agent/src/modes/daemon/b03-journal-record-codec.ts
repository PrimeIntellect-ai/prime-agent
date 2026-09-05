/**
 * Pure B03 journal record v1 codec.
 *
 * Encodes and decodes journal records as fixed-key-order JSON with a
 * SHA-256 digest over the embedded envelope. No filesystem, store,
 * recovery, relay, or index logic -- just codec.
 *
 * Every safely-writable caller bytes buffer is erased (zero-filled) on
 * every path.  SharedArrayBuffer-backed views are never written.
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
		/* best effort -- detached, frozen, or shared buffer */
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
// copyExactOwnDataObject -- single-pass guarded copy from descriptor.value
//
// Checks prototype, symbols, accessors, non-enumerable, undefined values
// ONCE.  Returns a fresh null-prototype object populated exclusively from
// descriptor.value -- never invokes the raw object's [[Get]] trap.
// Returns the copy on success, or a CodecErrorCode string on failure.
// When exactCount >= 0, rejects a different number of own enumerable keys.
// ===========================================================================

const TYPED_ARRAY_CTORS = [
	Uint8Array,
	Int8Array,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
	Float32Array,
	Float64Array,
	DataView,
];

function copyExactOwnDataObject(
	raw: unknown,
	allowed: ReadonlySet<string>,
	exactCount: number | null,
): Record<string, unknown> | CodecErrorCode {
	// Reject non-object / null / array
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "INVALID_FRAME";

	// Reject TypedArray / DataView
	for (const Ctor of TYPED_ARRAY_CTORS) {
		if (raw instanceof Ctor) return "INVALID_FRAME";
	}

	// Guard prototype, descriptors, symbols -- all wrapped so Proxy throws
	// become INVALID_FRAME.
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(raw);
	} catch {
		return "INVALID_FRAME";
	}
	if (proto !== null && proto !== Object.prototype) return "INVALID_FRAME";

	let descs: PropertyDescriptorMap;
	try {
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return "INVALID_FRAME";
	}

	let keys: string[];
	try {
		keys = Object.getOwnPropertyNames(raw);
	} catch {
		return "INVALID_FRAME";
	}

	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return "INVALID_FRAME";
	}
	if (symbols.length > 0) return "INVALID_FRAME";

	// Exact count check (for encoder input with exactly 8 keys)
	if (exactCount !== null && keys.length !== exactCount) return "INVALID_FRAME";

	// Populate from descriptor.value only -- never [[Get]].
	// This guarantees that a Proxy whose getOwnPropertyDescriptor returns
	// benign data values but whose [[Get]] trap throws or returns different
	// values is caught here: the getter is never invoked.
	const out: Record<string, unknown> = Object.create(null);
	for (const k of keys) {
		if (!allowed.has(k)) return "INVALID_FRAME";
		const desc = descs[k];
		if (desc.get || desc.set) return "INVALID_FRAME";
		if (!desc.enumerable) return "INVALID_FRAME";
		// Read from descriptor.value (which IS the data value for a plain data
		// property).  For a Proxy that returns {value: X, ...}, desc.value is X
		// without invoking [[Get]].
		const v = desc.value;
		if (v === undefined) return "INVALID_FRAME";
		out[k] = v;
	}

	return out;
}

// ===========================================================================
// Allowed-key sets
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
const EXPECTED_ALLOWED = new Set(["journalSeq", "hostId", "generation", "sessionId", "direction"]);

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
	// Single-pass descriptor copy -- never re-reads raw.
	const copyErr = copyExactOwnDataObject(raw, ENCODE_KEY_SET, ENCODE_REQUIRED_KEYS.length);
	if (typeof copyErr === "string") return fail(copyErr);
	const obj = copyErr; // fresh safe copy

	// Validate fields from the safe copy.
	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	)
		return fail("INVALID_SEQUENCE");
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

	const envelopeRaw = obj.envelope;
	const decodedEnvelope = decodeEnvelope(envelopeRaw);
	if (!decodedEnvelope.ok) return fail(decodedEnvelope.error.code);
	const envelope = decodedEnvelope.value;

	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) return fail("INVALID_DIGEST");
	const envelopeDigest = digestResult.value;

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
	const canonStr = JSON.stringify(recordObj);
	const encoded = new TextEncoder().encode(canonStr);

	if (encoded.byteLength > MAX_ENCODED_BYTES) {
		erase(encoded);
		return fail("OVERFLOW");
	}
	return okEncode(encoded, frozen);
}

// ===========================================================================
// Decode key set (all 9 keys required)
// ===========================================================================

const DECODE_KEYS = new Set(CANONICAL_KEYS);

// ===========================================================================
// validateExpected -- uses copyExactOwnDataObject for TOCTOU safety
// ===========================================================================

function validateExpected(expected: unknown): ExpectedFields | undefined {
	if (expected === undefined) return undefined;

	// Single-pass descriptor copy -- never invokes [[Get]] on expected.
	// exactCount is null because direction is optional (4-5 keys present).
	const copyErr = copyExactOwnDataObject(expected, EXPECTED_ALLOWED, null);
	if (typeof copyErr === "string") return undefined;
	const obj = copyErr; // fresh safe copy

	// journalSeq, hostId, generation, sessionId all required.
	if (
		obj.journalSeq === undefined ||
		obj.hostId === undefined ||
		obj.generation === undefined ||
		obj.sessionId === undefined
	)
		return undefined;
	if (
		typeof obj.journalSeq !== "number" ||
		!Number.isSafeInteger(obj.journalSeq as number) ||
		(obj.journalSeq as number) <= 0 ||
		(obj.journalSeq as number) > MAX_JOURNAL_SEQ
	)
		return undefined;
	for (const idField of ["hostId", "generation", "sessionId"] as const) {
		if (typeof obj[idField] !== "string" || !isValidSafeId(obj[idField] as string)) return undefined;
	}
	if (obj.direction !== undefined && obj.direction !== "sent" && obj.direction !== "received") return undefined;

	// Build fresh ExpectedFields from safe values.
	const out: ExpectedFields = {
		journalSeq: obj.journalSeq as number,
		hostId: obj.hostId as string,
		generation: obj.generation as string,
		sessionId: obj.sessionId as string,
	};
	if (typeof obj.direction === "string") (out as unknown as Record<string, unknown>).direction = obj.direction;
	return out;
}

// ===========================================================================
// decodeJournalRecordV1 -- outer shell: owns erasure, catches all exceptions
// ===========================================================================

export function decodeJournalRecordV1(bytes: Uint8Array, expected: unknown): DecodeJournalResult {
	const ownBuffers: Uint8Array[] = [];
	let erased = false;
	const eraseAll = () => {
		if (erased) return;
		erased = true;
		for (const b of ownBuffers) erase(b);
	};

	try {
		return decodeJournalRecordV1Impl(bytes, expected, ownBuffers);
	} catch {
		return fail("INVALID_FRAME");
	} finally {
		eraseAll();
	}
}

function decodeJournalRecordV1Impl(
	bytes: Uint8Array,
	expected: unknown,
	ownBuffers: Uint8Array[],
): DecodeJournalResult {
	// ---- Step 1: validate bytes ----
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

	// ---- Step 2: reject oversized before allocating originalBytes ----
	if (bytes.byteLength > MAX_ENCODED_BYTES) {
		ownBuffers.push(bytes);
		return fail("OVERFLOW");
	}

	// Caller bytes go into ownBuffers so the outer finally erases them.
	ownBuffers.push(bytes);

	// ---- Step 3: snapshot original bytes ----
	let originalBytes: Uint8Array;
	try {
		originalBytes = new Uint8Array(bytes);
		ownBuffers.push(originalBytes);
	} catch {
		return fail("INVALID_FRAME");
	}

	// ---- Step 4: parse UTF-8 JSON ----
	let jsonStr: string;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		jsonStr = decoder.decode(bytes);
	} catch {
		return fail("INVALID_FRAME");
	}

	// ---- Step 5: parse JSON ----
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return fail("INVALID_FRAME");
	}

	// ---- Step 6: validate parsed object ----
	// JSON.parse output is always plain and safe (no Proxy), but we still
	// guard with a bounded descriptor copy that allows all CANONICAL_KEYS.
	const parseErr = copyExactOwnDataObject(parsed, DECODE_KEYS, CANONICAL_KEYS.length);
	if (typeof parseErr === "string") return fail(parseErr);
	const obj = parseErr; // fresh safe copy

	// ---- Step 7: validate schema from safe copy ----
	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	)
		return fail("INVALID_SEQUENCE");
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

	// ---- Step 8: validate expected ----
	const exp = validateExpected(expected);
	if (expected !== undefined && exp === undefined) return fail("INVALID_FRAME");
	if (exp !== undefined) {
		if (exp.journalSeq !== journalSeq) return fail("MISMATCH");
		if (exp.hostId !== hostId) return fail("MISMATCH");
		if (exp.generation !== generation) return fail("MISMATCH");
		if (exp.sessionId !== sessionId) return fail("MISMATCH");
		if (exp.direction !== undefined && exp.direction !== direction) return fail("MISMATCH");
	}

	// ---- Step 9: decode envelope ----
	const decodedEnvelope = decodeEnvelope(obj.envelope);
	if (!decodedEnvelope.ok) return fail(decodedEnvelope.error.code);
	const envelope = decodedEnvelope.value;

	// ---- Step 10: recompute digest ----
	const digestResult = canonicalDigest(envelope);
	if (!digestResult.ok) return fail("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, storedDigest)) return fail("INVALID_DIGEST");

	// ---- Step 11: build fresh record ----
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

	// ---- Step 12: re-encode for canonical verification ----
	const canonStr = JSON.stringify(recordObj);
	const reEncoded = new TextEncoder().encode(canonStr);
	ownBuffers.push(reEncoded);
	if (!constantTimeEqual(reEncoded, originalBytes)) return fail("INVALID_DIGEST");

	// ---- Step 13: deep freeze and return ----
	const frozen = deepFreeze(recordObj) as unknown as JournalRecordV1;
	return okDecode(frozen);
}
