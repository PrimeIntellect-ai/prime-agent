/**
 * Pure B03 delivery/application-delivery index marker v1 codec and
 * deterministic recovery state machine.
 *
 * Encodes and decodes delivery-index markers as fixed-key-order canonical
 * JSON.  Provides a pure recovery accumulator created for exact identity
 * and direction that ingests markers in strictly contiguous indexSeq
 * order and returns deterministic delivery actions.
 *
 * No filesystem, store, relay, WebSocket, handlers, or notifications.
 *
 * Every safely-writable caller bytes buffer is erased (zero-filled) on
 * every path.  SharedArrayBuffer-backed views are never written.
 * All returned DTOs are deeply frozen with no aliases to inputs.
 */

import {
	type CodecError,
	type CodecErrorCode,
	isCanonicalUtcTimestamp,
	isValidDigest,
	isValidSafeId,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_INDEX_SEQ = 40_000;
const MAX_ENCODED_BYTES = 1_310_720; // 1.25 MiB

const CANONICAL_KEYS: readonly string[] = [
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
];

const RECORD_VERSION = 1;

// ===========================================================================
// DTO types
// ===========================================================================

export type JournalDirection = "sent" | "received";
export type MarkerState = "pending" | "delivered";
export type DeliveryState = "new" | "pending" | "delivered";
export type DeliveryAction = "persist_pending_then_apply" | "apply_idempotently" | "send_replay_ack";

export interface DeliveryMarkerV1 {
	readonly version: 1;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly direction: JournalDirection;
	readonly frameId: string;
	readonly envelopeDigest: string;
	readonly journalSeq: number;
	readonly indexSeq: number;
	readonly state: MarkerState;
	readonly recordedAt: string;
}

export interface DeliveryMarkerExpected {
	readonly hostId?: string;
	readonly generation?: string;
	readonly sessionId?: string;
	readonly direction?: JournalDirection;
	readonly indexSeq?: number;
}

export interface DeliveryIdentity {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
}

export interface DeliveryQueryResult {
	readonly state: DeliveryState;
	readonly action: DeliveryAction;
}

// ===========================================================================
// Result unions (never-throw), frozen
// ===========================================================================

export interface EncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
	readonly marker: DeliveryMarkerV1;
}
export interface EncodeError {
	readonly ok: false;
	readonly error: CodecError;
}
export type EncodeDeliveryResult = EncodeOk | EncodeError;

export interface DecodeOk {
	readonly ok: true;
	readonly marker: DeliveryMarkerV1;
}
export interface DecodeError {
	readonly ok: false;
	readonly error: CodecError;
}
export type DecodeDeliveryResult = DecodeOk | DecodeError;

export interface IngestOk {
	readonly ok: true;
	readonly action: DeliveryAction;
	readonly state: DeliveryState;
}
export interface IngestError {
	readonly ok: false;
	readonly error: CodecError;
}
export type IngestResult = IngestOk | IngestError;

// ===========================================================================
// Frozen result builders
// ===========================================================================

function fail(code: CodecErrorCode): EncodeError & DecodeError & IngestError {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function okEncode(bytes: Uint8Array, marker: DeliveryMarkerV1): EncodeOk {
	return Object.freeze({ ok: true, bytes, marker });
}

function okDecode(marker: DeliveryMarkerV1): DecodeOk {
	return Object.freeze({ ok: true, marker });
}

function okIngest(action: DeliveryAction, state: DeliveryState): IngestOk {
	return Object.freeze({ ok: true, action, state });
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
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "INVALID_FRAME";
	for (const Ctor of TYPED_ARRAY_CTORS) {
		if (raw instanceof Ctor) return "INVALID_FRAME";
	}
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
	if (exactCount !== null && keys.length !== exactCount) return "INVALID_FRAME";
	const out: Record<string, unknown> = Object.create(null);
	for (const k of keys) {
		if (!allowed.has(k)) return "INVALID_FRAME";
		const desc = descs[k];
		if (desc.get || desc.set) return "INVALID_FRAME";
		if (!desc.enumerable) return "INVALID_FRAME";
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
];
const ENCODE_KEY_SET = new Set(ENCODE_REQUIRED_KEYS);
const DECODE_KEYS = new Set(CANONICAL_KEYS);
const EXPECTED_ALLOWED = new Set(["hostId", "generation", "sessionId", "direction", "indexSeq"]);

// ===========================================================================
// Build marker in CANONICAL_KEYS insertion order
// ===========================================================================

function buildMarkerObject(
	version: 1,
	hostId: string,
	generation: string,
	sessionId: string,
	direction: string,
	frameId: string,
	envelopeDigest: string,
	journalSeq: number,
	indexSeq: number,
	state: string,
	recordedAt: string,
): Record<string, unknown> {
	const r: Record<string, unknown> = Object.create(null);
	r.version = version;
	r.hostId = hostId;
	r.generation = generation;
	r.sessionId = sessionId;
	r.direction = direction;
	r.frameId = frameId;
	r.envelopeDigest = envelopeDigest;
	r.journalSeq = journalSeq;
	r.indexSeq = indexSeq;
	r.state = state;
	r.recordedAt = recordedAt;
	return r;
}

// ===========================================================================
// encodeDeliveryMarkerV1
// ===========================================================================

export function encodeDeliveryMarkerV1(raw: unknown): EncodeDeliveryResult {
	try {
		return encodeDeliveryMarkerV1Impl(raw);
	} catch {
		return fail("INVALID_FRAME");
	}
}

function encodeDeliveryMarkerV1Impl(raw: unknown): EncodeDeliveryResult {
	const copyErr = copyExactOwnDataObject(raw, ENCODE_KEY_SET, ENCODE_REQUIRED_KEYS.length);
	if (typeof copyErr === "string") return fail(copyErr);
	const obj = copyErr;

	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");
	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId)) return fail("INVALID_IDENTITY");
	if (typeof generation !== "string" || !isValidSafeId(generation)) return fail("INVALID_IDENTITY");
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId)) return fail("INVALID_IDENTITY");
	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") return fail("INVALID_FRAME");
	const frameId = obj.frameId;
	if (typeof frameId !== "string" || !isValidSafeId(frameId)) return fail("INVALID_IDENTITY");
	const envelopeDigest = obj.envelopeDigest;
	if (typeof envelopeDigest !== "string" || !isValidDigest(envelopeDigest)) return fail("INVALID_DIGEST");
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq) ||
		journalSeq <= 0 ||
		journalSeq > MAX_JOURNAL_SEQ
	)
		return fail("INVALID_SEQUENCE");
	const indexSeq = obj.indexSeq;
	if (typeof indexSeq !== "number" || !Number.isSafeInteger(indexSeq) || indexSeq <= 0 || indexSeq > MAX_INDEX_SEQ)
		return fail("INVALID_SEQUENCE");
	const state = obj.state;
	if (state !== "pending" && state !== "delivered") return fail("INVALID_FRAME");
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt)) return fail("INVALID_TIMESTAMP");

	const markerObj = buildMarkerObject(
		RECORD_VERSION,
		hostId as string,
		generation as string,
		sessionId as string,
		direction as string,
		frameId as string,
		envelopeDigest as string,
		journalSeq as number,
		indexSeq as number,
		state as string,
		recordedAt as string,
	);
	const frozen = deepFreeze(markerObj) as unknown as DeliveryMarkerV1;
	const canonStr = JSON.stringify(markerObj);
	const encoded = new TextEncoder().encode(canonStr);

	if (encoded.byteLength > MAX_ENCODED_BYTES) {
		erase(encoded);
		return fail("OVERFLOW");
	}
	return okEncode(encoded, frozen);
}

// ===========================================================================
// validateExpected
// ===========================================================================

function validateExpected(expected: unknown): DeliveryMarkerExpected | undefined {
	if (expected === undefined) return undefined;
	const copyErr = copyExactOwnDataObject(expected, EXPECTED_ALLOWED, null);
	if (typeof copyErr === "string") return undefined;
	const obj = copyErr;

	if (obj.hostId !== undefined && (typeof obj.hostId !== "string" || !isValidSafeId(obj.hostId as string)))
		return undefined;
	if (obj.generation !== undefined && (typeof obj.generation !== "string" || !isValidSafeId(obj.generation as string)))
		return undefined;
	if (obj.sessionId !== undefined && (typeof obj.sessionId !== "string" || !isValidSafeId(obj.sessionId as string)))
		return undefined;
	if (obj.direction !== undefined && obj.direction !== "sent" && obj.direction !== "received") return undefined;
	if (
		obj.indexSeq !== undefined &&
		(typeof obj.indexSeq !== "number" ||
			!Number.isSafeInteger(obj.indexSeq as number) ||
			(obj.indexSeq as number) <= 0 ||
			(obj.indexSeq as number) > MAX_INDEX_SEQ)
	)
		return undefined;

	const out: Record<string, unknown> = Object.create(null);
	if (typeof obj.hostId === "string") out.hostId = obj.hostId;
	if (typeof obj.generation === "string") out.generation = obj.generation;
	if (typeof obj.sessionId === "string") out.sessionId = obj.sessionId;
	if (typeof obj.direction === "string") out.direction = obj.direction;
	if (typeof obj.indexSeq === "number") out.indexSeq = obj.indexSeq;
	return out as unknown as DeliveryMarkerExpected;
}

// ===========================================================================
// decodeDeliveryMarkerV1
// ===========================================================================

export function decodeDeliveryMarkerV1(bytes: Uint8Array, expected: unknown): DecodeDeliveryResult {
	const ownBuffers: Uint8Array[] = [];
	let erased = false;
	const eraseAll = () => {
		if (erased) return;
		erased = true;
		for (const b of ownBuffers) erase(b);
	};

	try {
		return decodeDeliveryMarkerV1Impl(bytes, expected, ownBuffers);
	} catch {
		return fail("INVALID_FRAME");
	} finally {
		eraseAll();
	}
}

function decodeDeliveryMarkerV1Impl(
	bytes: Uint8Array,
	expected: unknown,
	ownBuffers: Uint8Array[],
): DecodeDeliveryResult {
	// Step 1: validate bytes
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

	// Step 2: reject oversized before allocating originalBytes
	if (bytes.byteLength > MAX_ENCODED_BYTES) {
		ownBuffers.push(bytes);
		return fail("OVERFLOW");
	}

	ownBuffers.push(bytes);

	// Step 3: snapshot original bytes
	let originalBytes: Uint8Array;
	try {
		originalBytes = new Uint8Array(bytes);
		ownBuffers.push(originalBytes);
	} catch {
		return fail("INVALID_FRAME");
	}

	// Step 4: parse UTF-8 JSON
	let jsonStr: string;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		jsonStr = decoder.decode(bytes);
	} catch {
		return fail("INVALID_FRAME");
	}

	// Step 5: parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return fail("INVALID_FRAME");
	}

	// Step 6: validate parsed object
	const parseErr = copyExactOwnDataObject(parsed, DECODE_KEYS, CANONICAL_KEYS.length);
	if (typeof parseErr === "string") return fail(parseErr);
	const obj = parseErr;

	// Step 7: validate schema from safe copy
	if (obj.version !== RECORD_VERSION) return fail("INVALID_FRAME");
	const hostId = obj.hostId;
	const generation = obj.generation;
	const sessionId = obj.sessionId;
	if (typeof hostId !== "string" || !isValidSafeId(hostId as string)) return fail("INVALID_IDENTITY");
	if (typeof generation !== "string" || !isValidSafeId(generation as string)) return fail("INVALID_IDENTITY");
	if (typeof sessionId !== "string" || !isValidSafeId(sessionId as string)) return fail("INVALID_IDENTITY");
	const direction = obj.direction;
	if (direction !== "sent" && direction !== "received") return fail("INVALID_FRAME");
	const frameId = obj.frameId;
	if (typeof frameId !== "string" || !isValidSafeId(frameId as string)) return fail("INVALID_IDENTITY");
	const envelopeDigest = obj.envelopeDigest;
	if (typeof envelopeDigest !== "string" || !isValidDigest(envelopeDigest as string)) return fail("INVALID_DIGEST");
	const journalSeq = obj.journalSeq;
	if (
		typeof journalSeq !== "number" ||
		!Number.isSafeInteger(journalSeq as number) ||
		(journalSeq as number) <= 0 ||
		(journalSeq as number) > MAX_JOURNAL_SEQ
	)
		return fail("INVALID_SEQUENCE");
	const indexSeq = obj.indexSeq;
	if (
		typeof indexSeq !== "number" ||
		!Number.isSafeInteger(indexSeq as number) ||
		(indexSeq as number) <= 0 ||
		(indexSeq as number) > MAX_INDEX_SEQ
	)
		return fail("INVALID_SEQUENCE");
	const state = obj.state;
	if (state !== "pending" && state !== "delivered") return fail("INVALID_FRAME");
	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !isCanonicalUtcTimestamp(recordedAt as string))
		return fail("INVALID_TIMESTAMP");

	// Step 8: validate expected
	const exp = validateExpected(expected);
	if (expected !== undefined && exp === undefined) return fail("INVALID_FRAME");
	if (exp !== undefined) {
		if (exp.hostId !== undefined && exp.hostId !== (hostId as string)) return fail("MISMATCH");
		if (exp.generation !== undefined && exp.generation !== (generation as string)) return fail("MISMATCH");
		if (exp.sessionId !== undefined && exp.sessionId !== (sessionId as string)) return fail("MISMATCH");
		if (exp.direction !== undefined && exp.direction !== (direction as string)) return fail("MISMATCH");
		if (exp.indexSeq !== undefined && exp.indexSeq !== (indexSeq as number)) return fail("MISMATCH");
	}

	// Step 9: build fresh marker
	const markerObj = buildMarkerObject(
		RECORD_VERSION,
		hostId as string,
		generation as string,
		sessionId as string,
		direction as string,
		frameId as string,
		envelopeDigest as string,
		journalSeq as number,
		indexSeq as number,
		state as string,
		recordedAt as string,
	);

	// Step 10: re-encode for canonical verification
	const canonStr = JSON.stringify(markerObj);
	const reEncoded = new TextEncoder().encode(canonStr);
	ownBuffers.push(reEncoded);
	if (!constantTimeEqual(reEncoded, originalBytes)) return fail("INVALID_DIGEST");

	// Step 11: deep freeze and return
	const frozen = deepFreeze(markerObj) as unknown as DeliveryMarkerV1;
	return okDecode(frozen);
}

// ===========================================================================
// Recovery Accumulator
// ===========================================================================

interface TrackedFrame {
	readonly envelopeDigest: string;
	readonly journalSeq: number;
	readonly indexSeq: number;
	state: "pending" | "delivered";
}

export interface RecoveryAccumulator {
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	ingest(marker: DeliveryMarkerV1): IngestResult;
	query(frameId: string): DeliveryQueryResult;
}

export function createRecoveryAccumulator(
	identity: DeliveryIdentity,
	direction: JournalDirection,
): RecoveryAccumulator {
	const identityFrozen = deepFreeze({
		hostId: identity.hostId,
		generation: identity.generation,
		sessionId: identity.sessionId,
	}) as DeliveryIdentity;

	let lastIndexSeq = 0;
	const frames = new Map<string, TrackedFrame>();

	const accumulator: RecoveryAccumulator = {
		get identity(): DeliveryIdentity {
			return identityFrozen;
		},
		get direction(): JournalDirection {
			return direction;
		},

		ingest(marker: DeliveryMarkerV1): IngestResult {
			try {
				// Validate identity
				if (marker.hostId !== identityFrozen.hostId) return fail("MISMATCH");
				if (marker.generation !== identityFrozen.generation) return fail("MISMATCH");
				if (marker.sessionId !== identityFrozen.sessionId) return fail("MISMATCH");
				if (marker.direction !== direction) return fail("MISMATCH");

				// Validate contiguous indexSeq
				const expectedNext = lastIndexSeq + 1;
				if (marker.indexSeq !== expectedNext) return fail("INVALID_SEQUENCE");
				lastIndexSeq = marker.indexSeq;

				const existing = frames.get(marker.frameId);

				if (!existing) {
					// First marker for this frame -- must be pending
					if (marker.state !== "pending") return fail("INVALID_FRAME");

					frames.set(marker.frameId, {
						envelopeDigest: marker.envelopeDigest,
						journalSeq: marker.journalSeq,
						indexSeq: marker.indexSeq,
						state: "pending",
					});

					return okIngest("persist_pending_then_apply", "pending");
				}

				// Existing tracked frame
				if (existing.state === "delivered") {
					// Second delivered on same frame
					return fail("INVALID_FRAME");
				}

				// existing.state === "pending"
				if (marker.state === "pending") {
					// Duplicate pending
					return fail("INVALID_FRAME");
				}

				// Transition: delivered
				if (marker.state !== "delivered") return fail("INVALID_FRAME");

				// Validate digest + journalSeq match the existing pending
				if (marker.envelopeDigest !== existing.envelopeDigest) return fail("MISMATCH");
				if (marker.journalSeq !== existing.journalSeq) return fail("MISMATCH");

				// Transition to delivered
				frames.set(marker.frameId, {
					envelopeDigest: existing.envelopeDigest,
					journalSeq: existing.journalSeq,
					indexSeq: marker.indexSeq,
					state: "delivered",
				});

				return okIngest("send_replay_ack", "delivered");
			} catch {
				return fail("INVALID_FRAME");
			}
		},

		query(frameId: string): DeliveryQueryResult {
			const tracked = frames.get(frameId);
			if (!tracked) {
				return Object.freeze({
					state: "new" as DeliveryState,
					action: "persist_pending_then_apply" as DeliveryAction,
				});
			}
			if (tracked.state === "pending") {
				return Object.freeze({ state: "pending" as DeliveryState, action: "apply_idempotently" as DeliveryAction });
			}
			return Object.freeze({ state: "delivered" as DeliveryState, action: "send_replay_ack" as DeliveryAction });
		},
	};

	return Object.freeze(accumulator);
}
