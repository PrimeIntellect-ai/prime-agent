/**
 * Pure SandboxCommandRecordV1 codec — four-variant versioned tagged union.
 *
 * Public encode/decode operates on DTOs with nested decoded command envelopes.
 * Persisted canonical JSON stores the command envelope inline (it is already
 * JSON-safe).  The encode/decode surface always returns fresh frozen records
 * with decoded command envelopes; no binary base64 fields are needed because
 * the command body is pure JSON.
 *
 * Encode validates exact own enumerable plain descriptor snapshots — no
 * proxies, accessors, symbols, non-enumerable, undefined, or extra fields.
 * Decode validates the byte input as a genuine full-backing Uint8Array (no
 * Buffer, subclass, Proxy, SAB, detached, subview, or own extras), enforces
 * max size before parsing, and re-encodes JSON to prove canonical encoding.
 *
 * The semantic digest (bodyDigest) is the canonical JSON digest of the
 * full command envelope {type:"command",commandId,body}, excluding any
 * transport-only fields that exist only on the outer frame envelope.
 */

import { types } from "node:util";
import type { RemoteHostCommandFrame } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeCommandBody,
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

// ===========================================================================
// Codec error codes
// ===========================================================================

export const SANDBOX_COMMAND_CODEC_ERRORS = {
	INVALID_RECORD: "INVALID_RECORD",
	INVALID_IDENTITY: "INVALID_IDENTITY",
	INVALID_SEQUENCE: "INVALID_SEQUENCE",
	INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
	INVALID_DIGEST: "INVALID_DIGEST",
	INVALID_COMMAND: "INVALID_COMMAND",
	INVALID_OUTCOME: "INVALID_OUTCOME",
	OVERFLOW: "OVERFLOW",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const;

export type SandboxCommandCodecErrorCode =
	(typeof SANDBOX_COMMAND_CODEC_ERRORS)[keyof typeof SANDBOX_COMMAND_CODEC_ERRORS];

// ===========================================================================
// State and outcome types
// ===========================================================================

/** Record state — pending/started have no outcome; completed/interrupted have one. */
export type SandboxCommandState = "pending" | "started" | "completed" | "interrupted";

/** Terminal outcome — exact strings per state variant. */
export type SandboxCommandOutcome = "COMPLETED" | "INTERRUPTED" | "CRASH";

// ===========================================================================
// DTO types — four variants
// ===========================================================================

export interface SandboxCommandRecordCommon {
	readonly version: 1;
	readonly recordKind: SandboxCommandState;
	readonly recordSeq: number;
	readonly commandId: string;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly recordedAt: string;
	readonly bodyDigest: string;
	/** Decoded command body type string — equals command.body.type. */
	readonly commandType: RemoteHostCommandFrame["body"]["type"];
	/** Decoded command envelope with validated body. */
	readonly command: RemoteHostCommandFrame;
}

export interface SandboxCommandPendingRecordV1 extends SandboxCommandRecordCommon {
	readonly recordKind: "pending";
}

export interface SandboxCommandStartedRecordV1 extends SandboxCommandRecordCommon {
	readonly recordKind: "started";
}

export interface SandboxCommandCompletedRecordV1 extends SandboxCommandRecordCommon {
	readonly recordKind: "completed";
	readonly outcome: "COMPLETED";
}

export interface SandboxCommandInterruptedRecordV1 extends SandboxCommandRecordCommon {
	readonly recordKind: "interrupted";
	readonly outcome: "INTERRUPTED" | "CRASH";
}

export type SandboxCommandRecordV1 =
	| SandboxCommandPendingRecordV1
	| SandboxCommandStartedRecordV1
	| SandboxCommandCompletedRecordV1
	| SandboxCommandInterruptedRecordV1;

// ===========================================================================
// Result types
// ===========================================================================

interface CodecErrorObj {
	readonly code: SandboxCommandCodecErrorCode;
}

export interface SandboxCommandEncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
	readonly record: SandboxCommandRecordV1;
}
export interface SandboxCommandEncodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type SandboxCommandEncodeResult = SandboxCommandEncodeOk | SandboxCommandEncodeError;

export interface SandboxCommandDecodeOk {
	readonly ok: true;
	readonly record: SandboxCommandRecordV1;
}
export interface SandboxCommandDecodeError {
	readonly ok: false;
	readonly error: CodecErrorObj;
}
export type SandboxCommandDecodeResult = SandboxCommandDecodeOk | SandboxCommandDecodeError;

// ===========================================================================
// Helpers
// ===========================================================================

function codecError(code: SandboxCommandCodecErrorCode): CodecErrorObj {
	return Object.freeze({ code });
}

function codecFailure(code: SandboxCommandCodecErrorCode): SandboxCommandEncodeError {
	return Object.freeze({ ok: false, error: codecError(code) });
}

function encOk(bytes: Uint8Array, record: SandboxCommandRecordV1): SandboxCommandEncodeOk {
	return Object.freeze({ ok: true, bytes, record });
}

function decOk(record: SandboxCommandRecordV1): SandboxCommandDecodeOk {
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

function asOutcome(v: unknown): SandboxCommandOutcome | undefined {
	if (v === "COMPLETED" || v === "INTERRUPTED" || v === "CRASH") return v;
	return undefined;
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

function extractRecordKind(raw: unknown): SandboxCommandState | undefined {
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
			case "started":
			case "completed":
			case "interrupted":
				return v;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

// ===========================================================================
// decodeAndValidateCommandEnvelope — decode body and verify command envelope
// ===========================================================================

function decodeAndValidateCommandEnvelope(raw: unknown): RemoteHostCommandFrame | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	if (isTypedArrayInstance(raw)) return undefined;
	try {
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return undefined;
		const descs = Object.getOwnPropertyDescriptors(raw);
		// Must have exactly type, commandId, body
		const keys = Object.getOwnPropertyNames(raw);
		const symbols = Object.getOwnPropertySymbols(raw);
		if (symbols.length > 0) return undefined;
		if (keys.length !== 3) return undefined;
		const allowed = new Set(["type", "commandId", "body"]);
		for (const k of keys) {
			if (!allowed.has(k)) return undefined;
			const desc = descs[k];
			if (desc.get || desc.set) return undefined;
			if (!desc.enumerable) return undefined;
			if (desc.value === undefined) return undefined;
		}
		// type must be "command"
		const typeDesc = descs.type;
		if (typeDesc.value !== "command") return undefined;
		// commandId validation
		const commandIdDesc = descs.commandId;
		if (typeof commandIdDesc.value !== "string" || !SAFE_ID_RE.test(commandIdDesc.value)) return undefined;
		// body must be valid command body
		const bodyDesc = descs.body;
		const bodyResult = decodeCommandBody(bodyDesc.value);
		if (!bodyResult.ok) return undefined;
		return Object.freeze({
			type: "command" as const,
			commandId: commandIdDesc.value,
			body: bodyResult.value,
		});
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

function validateCommonFields(obj: Record<string, unknown>): SandboxCommandCodecErrorCode | undefined {
	const version = obj.version;
	if (version !== 1) return "UNSUPPORTED_VERSION";

	const recordSeq = obj.recordSeq;
	if (typeof recordSeq !== "number" || !isPositiveSafeInt(recordSeq) || recordSeq > MAX_RECORD_SEQ)
		return "INVALID_SEQUENCE";

	const commandId = obj.commandId;
	if (typeof commandId !== "string" || !SAFE_ID_RE.test(commandId)) return "INVALID_IDENTITY";

	const hostId = obj.hostId;
	if (typeof hostId !== "string" || !SAFE_ID_RE.test(hostId)) return "INVALID_IDENTITY";

	const generation = obj.generation;
	if (typeof generation !== "string" || !SAFE_ID_RE.test(generation)) return "INVALID_IDENTITY";

	const sessionId = obj.sessionId;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) return "INVALID_IDENTITY";

	const recordedAt = obj.recordedAt;
	if (typeof recordedAt !== "string" || !CANONICAL_UTC_RE.test(recordedAt) || !isCanonicalUtcTimestamp(recordedAt))
		return "INVALID_TIMESTAMP";

	const bodyDigest = obj.bodyDigest;
	if (typeof bodyDigest !== "string" || !isValidDigest(bodyDigest)) return "INVALID_DIGEST";

	return undefined;
}

// ===========================================================================
// Encode
// ===========================================================================

// ── Common encode keys (all four variants share these, plus variant-specific keys) ──

const COMMON_ENCODE_KEYS = [
	"version",
	"recordKind",
	"recordSeq",
	"commandId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"bodyDigest",
	"commandType",
	"command",
];

// Pending/started: common + no outcome
const PENDING_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS]);
const PENDING_KEY_COUNT = 11;
const STARTED_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS]);
const STARTED_KEY_COUNT = 11;

// Completed: common + outcome
const COMPLETED_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS, "outcome"]);
const COMPLETED_KEY_COUNT = 12;

// Interrupted: common + outcome
const INTERRUPTED_ENCODE_KEYS = new Set([...COMMON_ENCODE_KEYS, "outcome"]);
const INTERRUPTED_KEY_COUNT = 12;

export function encodeSandboxCommandRecordV1(raw: unknown): SandboxCommandEncodeResult {
	try {
		return encodeV1Impl(raw);
	} catch {
		return codecFailure("INVALID_RECORD");
	}
}

function encodeV1Impl(raw: unknown): SandboxCommandEncodeResult {
	const kind = extractRecordKind(raw);
	if (kind === undefined) return codecFailure("INVALID_RECORD");

	switch (kind) {
		case "pending":
			return encodePending(raw);
		case "started":
			return encodeStarted(raw);
		case "completed":
			return encodeCompleted(raw);
		case "interrupted":
			return encodeInterrupted(raw);
	}
}

// ── Pending encode ────────────────────────────────────────────────────────

function encodePending(raw: unknown): SandboxCommandEncodeResult {
	const obj = copyExactOwnRecordObject(raw, PENDING_ENCODE_KEYS, PENDING_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate and decode command envelope.
	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	// Verify bodyDigest matches canonical digest of the command envelope.
	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	// Build canonical JSON.
	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "pending";
	jsonObj.recordSeq = recordSeq;
	jsonObj.commandId = commandId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.bodyDigest = bodyDigest;
	jsonObj.commandType = commandType;
	jsonObj.command = command;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return codecFailure("OVERFLOW");

	const record: SandboxCommandPendingRecordV1 = Object.freeze({
		version: 1,
		recordKind: "pending",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
	});
	return encOk(encodedBytes, record);
}

// ── Started encode ────────────────────────────────────────────────────────

function encodeStarted(raw: unknown): SandboxCommandEncodeResult {
	const obj = copyExactOwnRecordObject(raw, STARTED_ENCODE_KEYS, STARTED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate and decode command envelope.
	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "started";
	jsonObj.recordSeq = recordSeq;
	jsonObj.commandId = commandId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.bodyDigest = bodyDigest;
	jsonObj.commandType = commandType;
	jsonObj.command = command;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return codecFailure("OVERFLOW");

	const record: SandboxCommandStartedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "started",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
	});
	return encOk(encodedBytes, record);
}

// ── Completed encode ──────────────────────────────────────────────────────

function encodeCompleted(raw: unknown): SandboxCommandEncodeResult {
	const obj = copyExactOwnRecordObject(raw, COMPLETED_ENCODE_KEYS, COMPLETED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate outcome.
	const outcome = asOutcome(obj.outcome);
	if (outcome !== "COMPLETED") return codecFailure("INVALID_OUTCOME");

	// Validate and decode command envelope.
	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "completed";
	jsonObj.recordSeq = recordSeq;
	jsonObj.commandId = commandId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.bodyDigest = bodyDigest;
	jsonObj.commandType = commandType;
	jsonObj.command = command;
	jsonObj.outcome = "COMPLETED";

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return codecFailure("OVERFLOW");

	const record: SandboxCommandCompletedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "completed",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
		outcome: "COMPLETED",
	});
	return encOk(encodedBytes, record);
}

// ── Interrupted encode ────────────────────────────────────────────────────

function encodeInterrupted(raw: unknown): SandboxCommandEncodeResult {
	const obj = copyExactOwnRecordObject(raw, INTERRUPTED_ENCODE_KEYS, INTERRUPTED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate outcome — must be INTERRUPTED or CRASH.
	const outcome = asOutcome(obj.outcome);
	if (outcome === undefined || outcome === "COMPLETED") return codecFailure("INVALID_OUTCOME");

	// Validate and decode command envelope.
	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	const jsonObj: Record<string, unknown> = Object.create(null);
	jsonObj.version = 1;
	jsonObj.recordKind = "interrupted";
	jsonObj.recordSeq = recordSeq;
	jsonObj.commandId = commandId;
	jsonObj.hostId = hostId;
	jsonObj.generation = generation;
	jsonObj.sessionId = sessionId;
	jsonObj.recordedAt = recordedAt;
	jsonObj.bodyDigest = bodyDigest;
	jsonObj.commandType = commandType;
	jsonObj.command = command;
	jsonObj.outcome = outcome;

	const jsonStr = JSON.stringify(jsonObj);
	const encodedBytes = new TextEncoder().encode(jsonStr);
	if (encodedBytes.byteLength > MAX_ENCODED_BYTES) return codecFailure("OVERFLOW");

	const record: SandboxCommandInterruptedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "interrupted",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
		outcome,
	});
	return encOk(encodedBytes, record);
}

// ===========================================================================
// Decode — four variant decoders
// ===========================================================================

// ── Decode variant key sets (JSON fields, same as encode) ──

const COMMON_DECODE_KEYS = [
	"version",
	"recordKind",
	"recordSeq",
	"commandId",
	"hostId",
	"generation",
	"sessionId",
	"recordedAt",
	"bodyDigest",
	"commandType",
	"command",
];
const PENDING_DECODE_KEYS = new Set(COMMON_DECODE_KEYS);
const STARTED_DECODE_KEYS = new Set(COMMON_DECODE_KEYS);
const COMPLETED_DECODE_KEYS = new Set([...COMMON_DECODE_KEYS, "outcome"]);
const INTERRUPTED_DECODE_KEYS = new Set([...COMMON_DECODE_KEYS, "outcome"]);

export function decodeSandboxCommandRecordV1(encoded: Uint8Array): SandboxCommandDecodeResult {
	try {
		return decodeV1Impl(encoded);
	} catch {
		return codecFailure("INVALID_RECORD");
	}
}

function decodeV1Impl(encoded: Uint8Array): SandboxCommandDecodeResult {
	// Validate the byte input as a genuine full-backing Uint8Array.
	if (!isGenuineUint8Array(encoded)) return codecFailure("INVALID_ARGUMENT");

	// Capture intrinsic byte length — avoids reading through own overrides.
	const intrinsicByteLength =
		INTRINSIC_BYTE_LENGTH_GETTER !== undefined ? Reflect.apply(INTRINSIC_BYTE_LENGTH_GETTER, encoded, []) : undefined;

	let result: SandboxCommandDecodeResult;
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
				case "started":
					result = decodeStarted(parsed, encoded);
					break;
				case "completed":
					result = decodeCompleted(parsed, encoded);
					break;
				case "interrupted":
					result = decodeInterrupted(parsed, encoded);
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

function decodePending(parsed: unknown, originalBytes: Uint8Array): SandboxCommandDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, PENDING_DECODE_KEYS, PENDING_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate and decode command envelope.
	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	// Prove canonical encoding.
	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "pending",
			recordSeq,
			commandId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			bodyDigest,
			commandType,
			command,
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxCommandPendingRecordV1 = Object.freeze({
		version: 1,
		recordKind: "pending",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
	});
	return decOk(record);
}

// ── decodeStarted ─────────────────────────────────────────────────────────

function decodeStarted(parsed: unknown, originalBytes: Uint8Array): SandboxCommandDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, STARTED_DECODE_KEYS, STARTED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "started",
			recordSeq,
			commandId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			bodyDigest,
			commandType,
			command,
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxCommandStartedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "started",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
	});
	return decOk(record);
}

// ── decodeCompleted ───────────────────────────────────────────────────────

function decodeCompleted(parsed: unknown, originalBytes: Uint8Array): SandboxCommandDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, COMPLETED_DECODE_KEYS, COMPLETED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate outcome.
	const outcome = asOutcome(obj.outcome);
	if (outcome !== "COMPLETED") return codecFailure("INVALID_OUTCOME");

	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "completed",
			recordSeq,
			commandId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			bodyDigest,
			commandType,
			command,
			outcome: "COMPLETED",
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxCommandCompletedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "completed",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
		outcome: "COMPLETED",
	});
	return decOk(record);
}

// ── decodeInterrupted ─────────────────────────────────────────────────────

function decodeInterrupted(parsed: unknown, originalBytes: Uint8Array): SandboxCommandDecodeResult {
	const obj = copyExactOwnRecordObject(parsed, INTERRUPTED_DECODE_KEYS, INTERRUPTED_KEY_COUNT);
	if (obj === undefined) return codecFailure("INVALID_RECORD");

	const err = validateCommonFields(obj);
	if (err !== undefined) return codecFailure(err);

	const commandId = asString(obj.commandId);
	if (commandId === undefined) return codecFailure("INVALID_IDENTITY");
	const bodyDigest = asString(obj.bodyDigest);
	if (bodyDigest === undefined) return codecFailure("INVALID_DIGEST");
	const recordSeq = asNumber(obj.recordSeq);
	if (recordSeq === undefined) return codecFailure("INVALID_SEQUENCE");
	const hostId = asString(obj.hostId);
	if (hostId === undefined) return codecFailure("INVALID_IDENTITY");
	const generation = asString(obj.generation);
	if (generation === undefined) return codecFailure("INVALID_IDENTITY");
	const sessionId = asString(obj.sessionId);
	if (sessionId === undefined) return codecFailure("INVALID_IDENTITY");
	const recordedAt = asString(obj.recordedAt);
	if (recordedAt === undefined) return codecFailure("INVALID_TIMESTAMP");
	const commandType = asString(obj.commandType);
	if (commandType === undefined) return codecFailure("INVALID_COMMAND");

	// Validate outcome — must be INTERRUPTED or CRASH.
	const outcome = asOutcome(obj.outcome);
	if (outcome === undefined || outcome === "COMPLETED") return codecFailure("INVALID_OUTCOME");

	const command = decodeAndValidateCommandEnvelope(obj.command);
	if (command === undefined) return codecFailure("INVALID_COMMAND");
	if (command.commandId !== commandId) return codecFailure("INVALID_IDENTITY");
	if (command.body.type !== commandType) return codecFailure("INVALID_COMMAND");

	const digestResult = canonicalDigest(command);
	if (!digestResult.ok) return codecFailure("INVALID_DIGEST");
	if (!digestsEqual(digestResult.value, bodyDigest)) return codecFailure("INVALID_DIGEST");

	if (
		!verifyCanonicalReencode(originalBytes, {
			version: 1,
			recordKind: "interrupted",
			recordSeq,
			commandId,
			hostId,
			generation,
			sessionId,
			recordedAt,
			bodyDigest,
			commandType,
			command,
			outcome,
		})
	)
		return codecFailure("INVALID_RECORD");

	const record: SandboxCommandInterruptedRecordV1 = Object.freeze({
		version: 1,
		recordKind: "interrupted",
		recordSeq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt,
		bodyDigest,
		commandType,
		command,
		outcome,
	});
	return decOk(record);
}
