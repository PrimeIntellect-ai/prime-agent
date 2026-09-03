/**
 * Pure SandboxEventOutboxRecordV1 codec — two-variant versioned tagged union.
 *
 * Public encode/decode operates on DTOs with nested decoded event frames
 * and (for delivered) ack frames.
 * Persisted canonical JSON stores the event and ack inline (they are already
 * JSON-safe).  The encode/decode surface always returns fresh frozen records
 * with decoded frames; no binary base64 fields are needed because the event
 * and ack bodies are pure JSON.
 *
 * Encode validates exact own enumerable plain descriptor snapshots — no
 * proxies, accessors, symbols, non-enumerable, undefined, or extra fields.
 * Decode validates the byte input as a genuine full-backing Uint8Array (no
 * Buffer, subclass, Proxy, SAB, detached, subview, or own extras), enforces
 * max size before parsing, and re-encodes JSON to prove canonical encoding.
 *
 * The semantic digest (eventDigest) is the canonical JSON digest of the
 * full event frame {type:"event",id,sequence,cursor,emittedAt,body},
 * excluding any transport-only fields that exist only on the outer frame
 * envelope.
 */

import { types } from "node:util";
import type { RemoteHostAckFrame, RemoteHostEventFrame } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeAckFrame,
	decodeEventFrame,
	digestsEqual,
	isCanonicalUtcTimestamp,
	isValidDigest,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_RECORD_SEQ = 20_000;
const MAX_ENCODED_BYTES = 1_310_720; // 1.25 MiB

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CURSOR_SNAPSHOT_KEYS = new Set(["hostId", "generation", "sessionId", "sequence"]);

// ===========================================================================
// Codec error codes
// ===========================================================================

export const SANDBOX_EVENT_OUTBOX_CODEC_ERRORS = {
	INVALID_RECORD: "INVALID_RECORD",
	INVALID_IDENTITY: "INVALID_IDENTITY",
	INVALID_SEQUENCE: "INVALID_SEQUENCE",
	INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
	INVALID_DIGEST: "INVALID_DIGEST",
	INVALID_EVENT: "INVALID_EVENT",
	INVALID_ACK: "INVALID_ACK",
	INVALID_OUTCOME: "INVALID_OUTCOME",
	OVERFLOW: "OVERFLOW",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const;

export type SandboxEventOutboxCodecErrorCode =
	(typeof SANDBOX_EVENT_OUTBOX_CODEC_ERRORS)[keyof typeof SANDBOX_EVENT_OUTBOX_CODEC_ERRORS];

// ===========================================================================
// Record kind type
// ===========================================================================

export type SandboxEventOutboxKind = "pending" | "delivered";

// ===========================================================================
// DTO types — two variants, discriminated by recordKind
// ===========================================================================

export interface SandboxEventOutboxRecordCommon {
	readonly version: 1;
	readonly recordKind: SandboxEventOutboxKind;
	readonly recordSeq: number;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly recordedAt: string;
	readonly eventId: string;
	readonly eventSequence: number;
	/** Decoded event body type string — equals event.body.type. */
	readonly eventType: string;
	readonly eventDigest: string;
	/** Decoded event frame with validated body. */
	readonly event: RemoteHostEventFrame;
}

export interface SandboxEventOutboxPendingRecordV1 extends SandboxEventOutboxRecordCommon {
	readonly recordKind: "pending";
}

export interface SandboxEventOutboxDeliveredRecordV1 extends SandboxEventOutboxRecordCommon {
	readonly recordKind: "delivered";
	readonly outcome: "DELIVERED";
	readonly ackDigest: string;
	/** Decoded ack frame with validated status. */
	readonly ack: RemoteHostAckFrame;
}

export type SandboxEventOutboxRecordV1 =
	| SandboxEventOutboxPendingRecordV1
	| SandboxEventOutboxDeliveredRecordV1;

// ===========================================================================
// Result types
// ===========================================================================

interface CodecErrorObj {
	readonly code: SandboxEventOutboxCodecErrorCode;
}

export interface SandboxEventOutboxEncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
	readonly record: SandboxEventOutboxRecordV1;
}
export interface SandboxEventOutboxEncodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type SandboxEventOutboxEncodeResult = SandboxEventOutboxEncodeOk | SandboxEventOutboxEncodeError;

export interface SandboxEventOutboxDecodeOk {
	readonly ok: true;
	readonly record: SandboxEventOutboxRecordV1;
}
export interface SandboxEventOutboxDecodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type SandboxEventOutboxDecodeResult = SandboxEventOutboxDecodeOk | SandboxEventOutboxDecodeError;

// ===========================================================================
// Helpers
// ===========================================================================

function codecError(code: SandboxEventOutboxCodecErrorCode): CodecErrorObj {
	return Object.freeze({ code });
}

function codecFailure(code: SandboxEventOutboxCodecErrorCode): SandboxEventOutboxEncodeError {
	return Object.freeze({ ok: false, error: codecError(code) });
}

function encOk(bytes: Uint8Array, record: SandboxEventOutboxRecordV1): SandboxEventOutboxEncodeOk {
	return Object.freeze({ ok: true, bytes, record });
}

function decOk(record: SandboxEventOutboxRecordV1): SandboxEventOutboxDecodeOk {
	return Object.freeze({ ok: true, record });
}

function isPositiveSafeInt(v: number): boolean {
	return Number.isSafeInteger(v) && v > 0;
}

// ===========================================================================
// Typed validator helpers — narrow unknown → typed values without casts
// ===========================================================================

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ===========================================================================
// deepFreeze — true recursive fresh freezing via descriptor access
// ===========================================================================

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	// Freeze arrays element-by-element.
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			deepFreeze(value[i]);
		}
		Object.freeze(value);
		return value;
	}
	// Freeze plain objects — always recurse into all children via descriptors.
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return value;
	const keys = Object.getOwnPropertyNames(value);
	for (const k of keys) {
		const desc = Object.getOwnPropertyDescriptor(value, k);
		if (desc && typeof desc.value === "object" && desc.value !== null) {
			deepFreeze(desc.value);
		}
	}
	if (!Object.isFrozen(value)) {
		Object.freeze(value);
	}
	return value;
}

// ===========================================================================
// snapshotPlainObject — safe frozen copy from descriptor snapshots
// Rejects Proxy, custom/null proto, accessors, non-enumerable, symbols,
// arrays (at this level), and undefined values.
// ===========================================================================

function snapshotPlainObject(
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
	if (proto !== Object.prototype) return undefined;

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

// Body type key definitions: [required_keys_set, optional_keys_set]
const BODY_TYPE_KEYS: Record<string, [ReadonlySet<string>, ReadonlySet<string>]> = {
	session_created: [new Set(["type", "sessionId", "workspaceId"]), new Set()],
	session_destroyed: [new Set(["type"]), new Set(["reason"])],
	agent_start: [new Set(["type"]), new Set()],
	agent_end: [new Set(["type", "messages"]), new Set()],
	agent_text_delta: [new Set(["type", "index", "text"]), new Set()],
	agent_thinking_delta: [new Set(["type", "index", "text"]), new Set()],
	agent_toolcall_delta: [new Set(["type", "index", "text"]), new Set()],
	bash_start: [new Set(["type", "command"]), new Set()],
	bash_end: [new Set(["type", "exitCode", "cancelled", "truncated"]), new Set()],
	bash_delta: [new Set(["type", "text"]), new Set()],
	compact_start: [new Set(["type"]), new Set()],
	compact_end: [new Set(["type", "keptMessages"]), new Set()],
	compact_failed: [new Set(["type", "error"]), new Set()],
	error: [new Set(["type", "code", "message"]), new Set()],
	checkpoint_start: [new Set(["type"]), new Set()],
	checkpoint_complete: [new Set(["type", "snapshotId"]), new Set()],
	checkpoint_failed: [new Set(["type", "error"]), new Set()],
	session_state: [new Set(["type", "state"]), new Set()],
};

function snapshotPlainObjectByType(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	let bodyProto: object | null;
	try { bodyProto = Object.getPrototypeOf(raw); } catch { return undefined; }
	if (bodyProto !== Object.prototype) return undefined;
	let bodyDescs: PropertyDescriptorMap;
	try { bodyDescs = Object.getOwnPropertyDescriptors(raw); } catch { return undefined; }
	let bodyKeys: string[];
	try { bodyKeys = Object.getOwnPropertyNames(raw); } catch { return undefined; }
	let bodySymbols: symbol[];
	try { bodySymbols = Object.getOwnPropertySymbols(raw); } catch { return undefined; }
	if (bodySymbols.length > 0) return undefined;
	// Read body type from descriptor (safe — no live getter call).
	const bodyTypeDesc = bodyDescs.type;
	if (bodyTypeDesc === undefined || bodyTypeDesc.get || bodyTypeDesc.set || !bodyTypeDesc.enumerable) return undefined;
	const bodyType = bodyTypeDesc.value;
	if (typeof bodyType !== "string" || bodyType.length === 0) return undefined;
	const keyPair = BODY_TYPE_KEYS[bodyType];
	if (keyPair === undefined) return undefined;
	const [requiredSet, optionalSet] = keyPair;
	const allowedSet = new Set([...requiredSet, ...optionalSet]);
	const out: Record<string, unknown> = Object.create(null);
	for (const k of bodyKeys) {
		if (!allowedSet.has(k)) return undefined;
		const desc = bodyDescs[k];
		if (desc.get || desc.set) return undefined;
		if (!desc.enumerable) return undefined;
		if (desc.value === undefined) return undefined;
		out[k] = desc.value;
	}
	// Verify all required keys are present.
	for (const rk of requiredSet) {
		if (!(rk in out)) return undefined;
	}
	return out;
}

// ===========================================================================
// Plain-object guard helpers (same pattern as provider-call-record-codec.ts)
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
	if (Array.isArray(value)) return false;
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
		return true;
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
	if (proto !== Object.prototype) return undefined;

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
// extractRecordKind — single-pass descriptor read of recordKind from raw
// ===========================================================================

function extractRecordKind(raw: unknown): SandboxEventOutboxKind | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	try {
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return undefined;
		const descs = Object.getOwnPropertyDescriptors(raw);
		const desc = descs.recordKind;
		if (desc === undefined || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) return undefined;
		const v = desc.value;
		if (typeof v !== "string") return undefined;
		switch (v) {
			case "pending":
			case "delivered":
				return v;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

// ===========================================================================
// decodeAndValidateEventFrame — decode event and verify consistency
// ===========================================================================

function decodeAndValidateEventFrame(raw: unknown): RemoteHostEventFrame | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	try {
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return undefined;
		const descs = Object.getOwnPropertyDescriptors(raw);
		// Must have exactly type, id, sequence, cursor, emittedAt, body
		const keys = Object.getOwnPropertyNames(raw);
		const symbols = Object.getOwnPropertySymbols(raw);
		if (symbols.length > 0) return undefined;
		if (keys.length !== 6) return undefined;
		const allowed = new Set(["type", "id", "sequence", "cursor", "emittedAt", "body"]);
		for (const k of keys) {
			if (!allowed.has(k)) return undefined;
			const desc = descs[k];
			if (desc.get || desc.set) return undefined;
			if (!desc.enumerable) return undefined;
			if (desc.value === undefined) return undefined;
		}
		// type must be "event"
		const typeDesc = descs.type;
		if (typeDesc.value !== "event") return undefined;
		// Validate scalar fields.
		const idVal = descs.id.value;
		if (typeof idVal !== "string" || idVal.length === 0) return undefined;
		const seqVal = descs.sequence.value;
		if (typeof seqVal !== "number" || !Number.isSafeInteger(seqVal) || seqVal <= 0) return undefined;
		const emittedAtVal = descs.emittedAt.value;
		if (typeof emittedAtVal !== "string" || emittedAtVal.length === 0) return undefined;

		// ── Preflight cursor via descriptor snapshot ──
		const cursorRaw = descs.cursor.value;
		const cursorSnapshot = snapshotPlainObject(cursorRaw, CURSOR_SNAPSHOT_KEYS, 4);
		if (cursorSnapshot === undefined) return undefined;
		const cursorHostId = cursorSnapshot.hostId;
		if (typeof cursorHostId !== "string") return undefined;
		const cursorGeneration = cursorSnapshot.generation;
		if (typeof cursorGeneration !== "string") return undefined;
		const cursorSessionId = cursorSnapshot.sessionId;
		if (typeof cursorSessionId !== "string") return undefined;
		const cursorSequence = cursorSnapshot.sequence;
		if (typeof cursorSequence !== "number" || !Number.isSafeInteger(cursorSequence) || cursorSequence <= 0) return undefined;
		const safeCursor = Object.freeze({
			hostId: cursorHostId,
			generation: cursorGeneration,
			sessionId: cursorSessionId,
			sequence: cursorSequence,
		});

		// ── Preflight body via descriptor snapshot ──
		const bodyRawValue = descs.body.value;
		const bodySnapshot = snapshotPlainObjectByType(bodyRawValue);
		if (bodySnapshot === undefined) return undefined;

		// ── Delegates to the existing decodeEventFrame with safe copies ──
		const eventResult = decodeEventFrame({
			type: "event",
			id: idVal,
			sequence: seqVal,
			cursor: safeCursor,
			emittedAt: emittedAtVal,
			body: bodySnapshot,
		});
		if (!eventResult.ok) return undefined;
		return deepFreeze(eventResult.value);
	} catch {
		return undefined;
	}
}

// ===========================================================================
// decodeAndValidateAckFrame — decode ack and verify consistency
// ===========================================================================

function decodeAndValidateAckFrame(raw: unknown): RemoteHostAckFrame | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	try {
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return undefined;
		const descs = Object.getOwnPropertyDescriptors(raw);
		// Must have at least type, ackId, acknowledges, status; optionally rejectReason
		const keys = Object.getOwnPropertyNames(raw);
		const symbols = Object.getOwnPropertySymbols(raw);
		if (symbols.length > 0) return undefined;
		if (keys.length < 4 || keys.length > 5) return undefined;
		const allowed = new Set(["type", "ackId", "acknowledges", "status", "rejectReason"]);
		for (const k of keys) {
			if (!allowed.has(k)) return undefined;
			const desc = descs[k];
			if (desc.get || desc.set) return undefined;
			if (!desc.enumerable) return undefined;
			if (desc.value === undefined) return undefined;
		}
		const typeDesc = descs.type;
		if (typeDesc.value !== "ack") return undefined;

		// Build safe ack frame from descriptor values (all scalar).
		const safeAck: Record<string, unknown> = {
			type: "ack",
			ackId: descs.ackId.value,
			acknowledges: descs.acknowledges.value,
			status: descs.status.value,
		};
		if (descs.rejectReason !== undefined) {
			safeAck.rejectReason = descs.rejectReason.value;
		}

		const ackResult = decodeAckFrame(safeAck);
		if (!ackResult.ok) return undefined;
		return deepFreeze(ackResult.value);
	} catch {
		return undefined;
	}
}

// ===========================================================================
// verifyCanonicalReencode — re-encode canonical JSON and compare byte-for-byte
// ===========================================================================

function verifyCanonicalReencode(originalBytes: Uint8Array, canonicalObj: Record<string, unknown>): boolean {
	const canonJson = JSON.stringify(canonicalObj);
	const canonBytes = new TextEncoder().encode(canonJson);
	try {
		if (canonBytes.byteLength !== originalBytes.byteLength) return false;
		for (let i = 0; i < canonBytes.byteLength; i++) {
			if (canonBytes[i] !== originalBytes[i]) return false;
		}
		return true;
	} finally {
		// Erase temporary canonical bytes.
		if (INTRINSIC_FILL !== undefined) {
			try {
				Reflect.apply(INTRINSIC_FILL, canonBytes, [0]);
			} catch {
				// Best-effort.
			}
		}
	}
}

// ===========================================================================
// Uint8Array genuine-byte intrinsic validation (same pattern as provider-call-record-codec.ts)
// ===========================================================================

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
const INTRINSIC_FILL: ((value: number) => Uint8Array) | undefined =
	TYPED_ARRAY_PROTO !== null && TYPED_ARRAY_PROTO !== Object.prototype
		? Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "fill")?.value
		: undefined;

function isGenuineUint8Array(input: unknown): input is Uint8Array {
	try {
		if (typeof input !== "object" || input === null) return false;
		if (types.isProxy(input)) return false;
		if (Object.getPrototypeOf(input) !== Uint8Array.prototype) return false;
		if (INTRINSIC_BYTE_LENGTH_GETTER === undefined) return false;
		if (INTRINSIC_BYTE_OFFSET_GETTER === undefined) return false;
		if (INTRINSIC_BUFFER_GETTER === undefined) return false;
		const byteLength = Reflect.apply(INTRINSIC_BYTE_LENGTH_GETTER, input, []);
		const byteOffset = Reflect.apply(INTRINSIC_BYTE_OFFSET_GETTER, input, []);
		const buffer = Reflect.apply(INTRINSIC_BUFFER_GETTER, input, []);
		if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength)) return false;
		if (typeof byteOffset !== "number" || !Number.isSafeInteger(byteOffset)) return false;
		if (typeof buffer !== "object" || buffer === null) return false;
		if (byteLength <= 0) return false;
		if (byteOffset !== 0) return false;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return false;
		if (types.isProxy(buffer)) return false;
		if (INTRINSIC_AB_BYTE_LENGTH_GETTER === undefined) return false;
		const bufferByteLength = Reflect.apply(INTRINSIC_AB_BYTE_LENGTH_GETTER, buffer, []);
		if (typeof bufferByteLength !== "number" || bufferByteLength !== byteLength) return false;
		const ownNames = Object.getOwnPropertyNames(input);
		if (ownNames.length !== byteLength) return false;
		for (let i = 0; i < byteLength; i++) {
			if (ownNames[i] !== String(i)) return false;
		}
		if (Object.getOwnPropertySymbols(input).length > 0) return false;
		return true;
	} catch {
		return false;
	}
}

// ===========================================================================
// Common field validation — returns undefined on success, error code string on failure
// ===========================================================================

function validateCommonFields(obj: Record<string, unknown>): SandboxEventOutboxCodecErrorCode | undefined {
	const version = obj.version;
	if (version !== 1) return "UNSUPPORTED_VERSION";

	const recordSeq = obj.recordSeq;
	if (typeof recordSeq !== "number" || !isPositiveSafeInt(recordSeq) || recordSeq > MAX_RECORD_SEQ)
		return "INVALID_SEQUENCE";

	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId)) return "INVALID_IDENTITY";

	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation)) return "INVALID_IDENTITY";

	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) return "INVALID_IDENTITY";

	const eventId = obj.eventId;
	if (typeof eventId !== "string" || !SAFE_ID_RE.test(eventId)) return "INVALID_IDENTITY";

	const eventSequence = obj.eventSequence;
	if (typeof eventSequence !== "number" || !isPositiveSafeInt(eventSequence)) return "INVALID_SEQUENCE";

	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return "INVALID_TIMESTAMP";

	const eventDigest = obj.eventDigest;
	if (typeof eventDigest !== "string" || !isValidDigest(eventDigest)) return "INVALID_DIGEST";

	return undefined;
}

// ===========================================================================
// Encode
// ===========================================================================

// ── Common encode keys (pending shares common; delivered adds outcome/ackDigest/ack) ──

const COMMON_ENCODE_KEYS = [
	"version",
	"recordKind",
	"recordSeq",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"eventId",
	"eventSequence",
	"eventType",
	"eventDigest",
	"event",
];

// Pending: common only
const PENDING_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS]);
const PENDING_KEY_COUNT = 12;

// Delivered: common + outcome + ackDigest + ack
const DELIVERED_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS, "outcome", "ackDigest", "ack"]);
const DELIVERED_KEY_COUNT = 15;

export function encodeSandboxEventOutboxRecordV1(raw: unknown): SandboxEventOutboxEncodeResult {
	try {
		return encodeV1Impl(raw);
	} catch {
		return codecFailure("INVALID_RECORD");
	}
}

function encodeV1Impl(raw: unknown): SandboxEventOutboxEncodeResult {
	const kind = extractRecordKind(raw);
	if (kind === undefined) return codecFailure("INVALID_RECORD");

	switch (kind) {
		case "pending":
			return encodePending(raw);
		case "delivered":
			return encodeDelivered(raw);
	}
}

// ── Pending encode ────────────────────────────────────────────────────────

function encodePending(raw: unknown): SandboxEventOutboxEncodeResult {
	const obj = copyExactOwnRecordObject(raw, PENDING_ENCODE_KEYS, PENDING_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventId = asString(obj.eventId);
	if (eventId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventSequence = asNumber(obj.eventSequence);
	if (eventSequence === undefined) return codecFailure("INVALID_SEQUENCE");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const eventDigest = asString(obj.eventDigest);
	if (eventDigest === undefined) return codecFailure("INVALID_DIGEST");
	const eventType = asString(obj.eventType);
	if (eventType === undefined) return codecFailure("INVALID_EVENT");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");

	// Validate and decode event frame.
	const event = decodeAndValidateEventFrame(obj.event);
	if (event === undefined) return codecFailure("INVALID_EVENT");
	if (event.id !== eventId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.hostId !== hostId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.generation !== generation) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.sessionId !== sessionId) return codecFailure("INVALID_IDENTITY");
	if (event.sequence !== eventSequence) return codecFailure("INVALID_SEQUENCE");
	if (event.body.type !== eventType) return codecFailure("INVALID_EVENT");

	// Verify eventDigest matches canonical digest of the event frame.
	const digestResult = canonicalDigest(event);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, eventDigest)) return codecFailure("INVALID_DIGEST");

	// Build canonical JSON.
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "pending";
	jsonObj.recordSeq = recordSeq;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.eventId = eventId;
	jsonObj.eventSequence = eventSequence;
	jsonObj.eventType = eventType;
	jsonObj.eventDigest = eventDigest;
	jsonObj.event = event;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) {
			// Erase generated bytes before returning failure.
			if (INTRINSIC_FILL !== undefined) {
				try { Reflect.apply(INTRINSIC_FILL, encodedBytes, [0]); } catch { /* best-effort */ }
			}
			return codecFailure("OVERFLOW");
		}

	const record: SandboxEventOutboxPendingRecordV1 = deepFreeze({
		version: 1,
		recordKind: "pending",
		recordSeq,
		hostId,
		generation,
		sessionId,
		recordedAt,
		eventId,
		eventSequence,
		eventType,
		eventDigest,
		event,
	});
	return encOk(encodedBytes, record);
}

// ── Delivered encode ──────────────────────────────────────────────────────

function encodeDelivered(raw: unknown): SandboxEventOutboxEncodeResult {
	const obj = copyExactOwnRecordObject(raw, DELIVERED_ENCODE_KEYS, DELIVERED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventId = asString(obj.eventId);
	if (eventId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventSequence = asNumber(obj.eventSequence);
	if (eventSequence === undefined) return codecFailure("INVALID_SEQUENCE");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const eventDigest = asString(obj.eventDigest);
	if (eventDigest === undefined) return codecFailure("INVALID_DIGEST");
	const eventType = asString(obj.eventType);
	if (eventType === undefined) return codecFailure("INVALID_EVENT");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");

	// Validate outcome.
	const outcome = obj.outcome;
	if (outcome !== "DELIVERED") return codecFailure("INVALID_OUTCOME");

	// Validate ackDigest.
	const ackDigest = asString(obj.ackDigest);
	if (ackDigest === undefined || !isValidDigest(ackDigest)) return codecFailure("INVALID_DIGEST");

	// Validate and decode event frame.
	const event = decodeAndValidateEventFrame(obj.event);
	if (event === undefined) return codecFailure("INVALID_EVENT");
	if (event.id !== eventId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.hostId !== hostId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.generation !== generation) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.sessionId !== sessionId) return codecFailure("INVALID_IDENTITY");
	if (event.sequence !== eventSequence) return codecFailure("INVALID_SEQUENCE");
	if (event.body.type !== eventType) return codecFailure("INVALID_EVENT");

	// Verify eventDigest matches canonical digest of event frame.
	const eventDigestResult = canonicalDigest(event);
	if (!eventDigestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(eventDigestResult.value, eventDigest)) return codecFailure("INVALID_DIGEST");

	// Validate and decode ack frame.
	const ack = decodeAndValidateAckFrame(obj.ack);
	if (ack === undefined) return codecFailure("INVALID_ACK");

	// Delivered-specific ack validations.
	// ack.acknowledges must equal eventId.
	if (ack.acknowledges !== eventId) return codecFailure("INVALID_ACK");
	// ack.status must be "delivered" or "replayed" (reject "rejected").
	if (ack.status !== "delivered" && ack.status !== "replayed") return codecFailure("INVALID_ACK");

	// Verify ackDigest matches canonical digest of ack frame.
	const ackDigestResult = canonicalDigest(ack);
	if (!ackDigestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(ackDigestResult.value, ackDigest)) return codecFailure("INVALID_DIGEST");

	// Build canonical JSON.
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "delivered";
	jsonObj.recordSeq = recordSeq;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.eventId = eventId;
	jsonObj.eventSequence = eventSequence;
	jsonObj.eventType = eventType;
	jsonObj.eventDigest = eventDigest;
	jsonObj.event = event;
	jsonObj.outcome = "DELIVERED";
	jsonObj.ackDigest = ackDigest;
	jsonObj.ack = ack;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) {
			// Erase generated bytes before returning failure.
			if (INTRINSIC_FILL !== undefined) {
				try { Reflect.apply(INTRINSIC_FILL, encodedBytes, [0]); } catch { /* best-effort */ }
			}
			return codecFailure("OVERFLOW");
		}

	const record: SandboxEventOutboxDeliveredRecordV1 = deepFreeze({
		version: 1,
		recordKind: "delivered",
		recordSeq,
		hostId,
		generation,
		sessionId,
		recordedAt,
		eventId,
		eventSequence,
		eventType,
		eventDigest,
		event,
		outcome: "DELIVERED",
		ackDigest,
		ack,
	});
	return encOk(encodedBytes, record);
}

// ===========================================================================
// Decode — two variant decoders
// ===========================================================================

// ── Decode variant key sets (JSON fields, same as encode) ──

const COMMON_DECODE_KEYS = [
	"version",
	"recordKind",
	"recordSeq",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"eventId",
	"eventSequence",
	"eventType",
	"eventDigest",
	"event",
];
const PENDING_DECODE_KEYS = new Set(COMMON_DECODE_KEYS);
const DELIVERED_DECODE_KEYS = new Set([...COMMON_DECODE_KEYS, "outcome", "ackDigest", "ack"]);

export function decodeSandboxEventOutboxRecordV1(encoded: Uint8Array): SandboxEventOutboxDecodeResult {
	try {
		return decodeV1Impl(encoded);
	} catch {
		return codecFailure("INVALID_RECORD");
	}
}

function decodeV1Impl(encoded: Uint8Array): SandboxEventOutboxDecodeResult {
	// Validate the byte input as a genuine full-backing Uint8Array.
	if (!isGenuineUint8Array(encoded)) return codecFailure("INVALID_ARGUMENT");

	// Capture intrinsic byte length — avoids reading through own overrides.
	const intrinsicByteLength =
		INTRINSIC_BYTE_LENGTH_GETTER !== undefined ? Reflect.apply(INTRINSIC_BYTE_LENGTH_GETTER, encoded, []) : undefined;

	let result: SandboxEventOutboxDecodeResult;
	try {
		if (
			intrinsicByteLength === undefined ||
			typeof intrinsicByteLength !== "number" ||
			!Number.isSafeInteger(intrinsicByteLength)
		) {
			result = codecFailure("INVALID_ARGUMENT");
		} else if (intrinsicByteLength > MAX_ENCODED_BYTES) {
			result = codecFailure("OVERFLOW");
		} else {
			// Decode UTF-8 with fatal error on invalid sequences.
			let jsonStr: string;
			try {
				jsonStr = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
			} catch {
				result = codecFailure("INVALID_RECORD");
				return result; // triggers finally then returns
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonStr);
			} catch {
				result = codecFailure("INVALID_RECORD");
				return result; // triggers finally then returns
			}

			const kind = extractRecordKind(parsed);
			if (kind === undefined) {
				result = codecFailure("INVALID_RECORD");
				return result; // triggers finally then returns
			}

			switch (kind) {
				case "pending":
					result = decodePending(parsed, encoded);
					break;
				case "delivered":
					result = decodeDelivered(parsed, encoded);
					break;
				default:
					result = codecFailure("INVALID_RECORD");
					break;
			}
		}
	} finally {
		// Erase caller-owned bytes — zero the input using intrinsic fill.
		if (INTRINSIC_FILL !== undefined) {
			try {
				Reflect.apply(INTRINSIC_FILL, encoded, [0]);
			} catch {
				// Erasure is best-effort.
			}
		}
	}

	return result;
}

// ── decodePending ─────────────────────────────────────────────────────────

function decodePending(parsed: unknown, originalBytes: Uint8Array): SandboxEventOutboxDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, PENDING_DECODE_KEYS, PENDING_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventId = asString(obj.eventId);
	if (eventId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventSequence = asNumber(obj.eventSequence);
	if (eventSequence === undefined) return codecFailure("INVALID_SEQUENCE");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const eventDigest = asString(obj.eventDigest);
	if (eventDigest === undefined) return codecFailure("INVALID_DIGEST");
	const eventType = asString(obj.eventType);
	if (eventType === undefined) return codecFailure("INVALID_EVENT");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");

	// Validate and decode event frame.
	const event = decodeAndValidateEventFrame(obj.event);
	if (event === undefined) return codecFailure("INVALID_EVENT");
	if (event.id !== eventId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.hostId !== hostId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.generation !== generation) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.sessionId !== sessionId) return codecFailure("INVALID_IDENTITY");
	if (event.sequence !== eventSequence) return codecFailure("INVALID_SEQUENCE");
	if (event.body.type !== eventType) return codecFailure("INVALID_EVENT");

	// Verify eventDigest matches canonical digest of event frame.
	const digestResult = canonicalDigest(event);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, eventDigest)) return codecFailure("INVALID_DIGEST");

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "pending",
			recordSeq,
			hostId,
			generation,
			sessionId,
			recordedAt,
			eventId,
			eventSequence,
			eventType,
			eventDigest,
			event,
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxEventOutboxPendingRecordV1 = deepFreeze({
		version: 1,
		recordKind: "pending",
		recordSeq,
		hostId,
		generation,
		sessionId,
		recordedAt,
		eventId,
		eventSequence,
		eventType,
		eventDigest,
		event,
	});
	return decOk(record);
}

// ── decodeDelivered ───────────────────────────────────────────────────────

function decodeDelivered(parsed: unknown, originalBytes: Uint8Array): SandboxEventOutboxDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, DELIVERED_DECODE_KEYS, DELIVERED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventId = asString(obj.eventId);
	if (eventId === undefined) return codecFailure("INVALID_IDENTITY");
	const eventSequence = asNumber(obj.eventSequence);
	if (eventSequence === undefined) return codecFailure("INVALID_SEQUENCE");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const eventDigest = asString(obj.eventDigest);
	if (eventDigest === undefined) return codecFailure("INVALID_DIGEST");
	const eventType = asString(obj.eventType);
	if (eventType === undefined) return codecFailure("INVALID_EVENT");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");

	// Validate outcome.
	const outcome = obj.outcome;
	if (outcome !== "DELIVERED") return codecFailure("INVALID_OUTCOME");

	// Validate ackDigest.
	const ackDigest = asString(obj.ackDigest);
	if (ackDigest === undefined || !isValidDigest(ackDigest)) return codecFailure("INVALID_DIGEST");

	// Validate and decode event frame.
	const event = decodeAndValidateEventFrame(obj.event);
	if (event === undefined) return codecFailure("INVALID_EVENT");
	if (event.id !== eventId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.hostId !== hostId) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.generation !== generation) return codecFailure("INVALID_IDENTITY");
	if (event.cursor.sessionId !== sessionId) return codecFailure("INVALID_IDENTITY");
	if (event.sequence !== eventSequence) return codecFailure("INVALID_SEQUENCE");
	if (event.body.type !== eventType) return codecFailure("INVALID_EVENT");

	// Verify eventDigest matches canonical digest of event frame.
	const eventDigestResult = canonicalDigest(event);
	if (!eventDigestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(eventDigestResult.value, eventDigest)) return codecFailure("INVALID_DIGEST");

	// Validate and decode ack frame.
	const ack = decodeAndValidateAckFrame(obj.ack);
	if (ack === undefined) return codecFailure("INVALID_ACK");

	// Delivered-specific ack validations.
	if (ack.acknowledges !== eventId) return codecFailure("INVALID_ACK");
	if (ack.status !== "delivered" && ack.status !== "replayed") return codecFailure("INVALID_ACK");

	// Verify ackDigest matches canonical digest of ack frame.
	const ackDigestResult = canonicalDigest(ack);
	if (!ackDigestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(ackDigestResult.value, ackDigest)) return codecFailure("INVALID_DIGEST");

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "delivered",
			recordSeq,
			hostId,
			generation,
			sessionId,
			recordedAt,
			eventId,
			eventSequence,
			eventType,
			eventDigest,
			event,
			outcome: "DELIVERED",
			ackDigest,
			ack,
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxEventOutboxDeliveredRecordV1 = deepFreeze({
		version: 1,
		recordKind: "delivered",
		recordSeq,
		hostId,
		generation,
		sessionId,
		recordedAt,
		eventId,
		eventSequence,
		eventType,
		eventDigest,
		event,
		outcome: "DELIVERED",
		ackDigest,
		ack,
	});
	return decOk(record);
}
