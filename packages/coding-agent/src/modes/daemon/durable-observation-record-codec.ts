import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { canonicalDigest, decodeEnvelope, isValidDigest, isValidSafeId } from "./remote-host-frame-codec.js";
import { decodeRemoteObservationSnapshotV1, type RemoteObservationSnapshotV1 } from "./remote-observation-snapshot.js";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const PENDING_KEYS = new Set([
	"envelope",
	"envelopeDigest",
	"eventId",
	"eventSequence",
	"frameId",
	"generation",
	"hostId",
	"observationId",
	"preSnapshot",
	"sessionId",
	"state",
	"version",
]);
const APPLIED_KEYS = new Set([...PENDING_KEYS, "postSnapshot"]);
const OBSERVATION_ID_KEYS = new Set([
	"envelopeDigest",
	"eventId",
	"eventSequence",
	"frameId",
	"generation",
	"hostId",
	"sessionId",
	"version",
]);

export type DurableObservationRecordFailureCode =
	| "BYTES_INVALID"
	| "ENVELOPE_INVALID"
	| "IDENTITY_MISMATCH"
	| "INVALID_ARGUMENT"
	| "NON_CANONICAL"
	| "OBSERVATION_ID_MISMATCH"
	| "OVERFLOW"
	| "SNAPSHOT_INVALID";

export interface DurableObservationIdentity {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
}

interface DurableObservationRecordBase extends DurableObservationIdentity {
	readonly version: 1;
	readonly state: "pending" | "applied";
	readonly observationId: string;
	readonly frameId: string;
	readonly eventId: string;
	readonly eventSequence: number;
	readonly envelopeDigest: string;
	readonly envelope: RemoteHostFrameEnvelope;
	readonly preSnapshot: RemoteObservationSnapshotV1;
}

export interface DurableObservationPendingRecord extends DurableObservationRecordBase {
	readonly state: "pending";
}

export interface DurableObservationAppliedRecord extends DurableObservationRecordBase {
	readonly state: "applied";
	readonly postSnapshot: RemoteObservationSnapshotV1;
}

export type DurableObservationRecord = DurableObservationPendingRecord | DurableObservationAppliedRecord;
export type DurableObservationRecordResult =
	| Readonly<{ ok: true; value: DurableObservationRecord }>
	| Readonly<{ ok: false; error: Readonly<{ code: DurableObservationRecordFailureCode }> }>;
export type DurableObservationEncodeResult =
	| Readonly<{ ok: true; bytes: Uint8Array }>
	| Readonly<{ ok: false; error: Readonly<{ code: DurableObservationRecordFailureCode }> }>;
export type DurableObservationIdResult =
	| Readonly<{ ok: true; value: string }>
	| Readonly<{ ok: false; error: Readonly<{ code: "INVALID_ARGUMENT" }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

function failed(code: DurableObservationRecordFailureCode): DurableObservationRecordResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function encodeFailed(code: DurableObservationRecordFailureCode): DurableObservationEncodeResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function descriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const found = descriptors(raw);
	if (!found) return null;
	const names = Object.getOwnPropertyNames(found);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = found[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return found;
}

function identity(raw: unknown): Readonly<DurableObservationIdentity> | null {
	const found = exact(raw, IDENTITY_KEYS);
	const hostId = found?.hostId?.value;
	const generation = found?.generation?.value;
	const sessionId = found?.sessionId?.value;
	if (!isValidSafeId(hostId) || !isValidSafeId(generation) || !isValidSafeId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

function ownedBytes(raw: unknown): raw is Uint8Array {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			Object.getOwnPropertyDescriptor(raw, "buffer") !== undefined ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") !== undefined ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset") !== undefined ||
			!BYTE_LENGTH_GETTER ||
			!BYTE_OFFSET_GETTER ||
			!BUFFER_GETTER ||
			!ARRAY_BUFFER_LENGTH_GETTER
		)
			return false;
		const length = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		const offset = Reflect.apply(BYTE_OFFSET_GETTER, raw, []) as number;
		const buffer = Reflect.apply(BUFFER_GETTER, raw, []) as unknown;
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(ARRAY_BUFFER_LENGTH_GETTER, buffer, []) as number;
		ArrayBuffer.prototype.slice.call(buffer, 0, 0);
		return offset === 0 && length === backingLength;
	} catch {
		return false;
	}
}

function intrinsicLength(bytes: Uint8Array): number {
	return Reflect.apply(BYTE_LENGTH_GETTER!, bytes, []) as number;
}

function erase(bytes: Uint8Array): void {
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		/* ownership was already acquired */
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	const leftLength = intrinsicLength(left);
	if (leftLength !== intrinsicLength(right)) return false;
	for (let index = 0; index < leftLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function normalizedObservationId(raw: unknown): DurableObservationIdResult {
	const found = exact(raw, OBSERVATION_ID_KEYS);
	if (!found || found.version?.value !== 1)
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" as const }) });
	const hostId = found.hostId?.value;
	const generation = found.generation?.value;
	const sessionId = found.sessionId?.value;
	const frameId = found.frameId?.value;
	const eventId = found.eventId?.value;
	const eventSequence = found.eventSequence?.value;
	const envelopeDigest = found.envelopeDigest?.value;
	if (
		!isValidSafeId(hostId) ||
		!isValidSafeId(generation) ||
		!isValidSafeId(sessionId) ||
		!isValidSafeId(frameId) ||
		!isValidSafeId(eventId) ||
		typeof eventSequence !== "number" ||
		!Number.isSafeInteger(eventSequence) ||
		eventSequence < 1 ||
		typeof envelopeDigest !== "string" ||
		!isValidDigest(envelopeDigest)
	) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" as const }) });
	}
	const digest = canonicalDigest(
		Object.freeze({ version: 1, hostId, generation, sessionId, frameId, eventId, eventSequence, envelopeDigest }),
	);
	return digest.ok
		? Object.freeze({ ok: true as const, value: digest.value })
		: Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" as const }) });
}

export function computeDurableObservationId(raw: unknown): DurableObservationIdResult {
	return normalizedObservationId(raw);
}

function snapshotRecord(raw: unknown, expectedIdentity?: unknown): DurableObservationRecordResult {
	const preliminary = descriptors(raw);
	const state = preliminary?.state && "value" in preliminary.state ? preliminary.state.value : undefined;
	const found = state === "pending" ? exact(raw, PENDING_KEYS) : state === "applied" ? exact(raw, APPLIED_KEYS) : null;
	if (!found || found.version?.value !== 1) return failed("INVALID_ARGUMENT");
	const hostId = found.hostId?.value;
	const generation = found.generation?.value;
	const sessionId = found.sessionId?.value;
	if (!isValidSafeId(hostId) || !isValidSafeId(generation) || !isValidSafeId(sessionId))
		return failed("INVALID_ARGUMENT");
	if (expectedIdentity !== undefined) {
		const expected = identity(expectedIdentity);
		if (!expected) return failed("INVALID_ARGUMENT");
		if (expected.hostId !== hostId || expected.generation !== generation || expected.sessionId !== sessionId)
			return failed("IDENTITY_MISMATCH");
	}
	const decodedEnvelope = decodeEnvelope(found.envelope?.value);
	if (!decodedEnvelope.ok) return failed("ENVELOPE_INVALID");
	const envelope = decodedEnvelope.value;
	if (envelope.frame.type !== "event") return failed("ENVELOPE_INVALID");
	const event = envelope.frame;
	const frameId = found.frameId?.value;
	const eventId = found.eventId?.value;
	const eventSequence = found.eventSequence?.value;
	const envelopeDigest = found.envelopeDigest?.value;
	if (
		frameId !== envelope.frameId ||
		eventId !== event.id ||
		eventSequence !== event.sequence ||
		event.cursor.hostId !== hostId ||
		event.cursor.generation !== generation ||
		event.cursor.sessionId !== sessionId ||
		typeof envelopeDigest !== "string" ||
		!isValidDigest(envelopeDigest)
	)
		return failed("ENVELOPE_INVALID");
	const digest = canonicalDigest(envelope);
	if (!digest.ok || digest.value !== envelopeDigest) return failed("ENVELOPE_INVALID");
	const expectedSnapshotIdentity = Object.freeze({ hostId, generation, sessionId });
	const pre = decodeRemoteObservationSnapshotV1(found.preSnapshot?.value, expectedSnapshotIdentity);
	if (!pre.success) return failed("SNAPSHOT_INVALID");
	const id = normalizedObservationId(
		Object.freeze({ version: 1, hostId, generation, sessionId, frameId, eventId, eventSequence, envelopeDigest }),
	);
	if (!id.ok || found.observationId?.value !== id.value) return failed("OBSERVATION_ID_MISMATCH");
	const base = Object.freeze({
		version: 1 as const,
		hostId,
		generation,
		sessionId,
		observationId: id.value,
		frameId,
		eventId,
		eventSequence,
		envelopeDigest,
		envelope,
		preSnapshot: pre.value,
	});
	if (state === "pending")
		return Object.freeze({ ok: true as const, value: Object.freeze({ ...base, state: "pending" as const }) });
	const post = decodeRemoteObservationSnapshotV1(found.postSnapshot?.value, expectedSnapshotIdentity);
	if (!post.success) return failed("SNAPSHOT_INVALID");
	return Object.freeze({
		ok: true as const,
		value: Object.freeze({ ...base, state: "applied" as const, postSnapshot: post.value }),
	});
}

function canonicalObject(record: DurableObservationRecord): Readonly<Record<string, unknown>> {
	const base = {
		version: 1,
		state: record.state,
		hostId: record.hostId,
		generation: record.generation,
		sessionId: record.sessionId,
		observationId: record.observationId,
		frameId: record.frameId,
		eventId: record.eventId,
		eventSequence: record.eventSequence,
		envelopeDigest: record.envelopeDigest,
		envelope: record.envelope,
		preSnapshot: record.preSnapshot,
	};
	return record.state === "pending"
		? Object.freeze(base)
		: Object.freeze({ ...base, postSnapshot: record.postSnapshot });
}

function encodeNormalized(record: DurableObservationRecord): Uint8Array | null {
	try {
		const text = JSON.stringify(canonicalObject(record));
		const bytes = new TextEncoder().encode(text);
		return bytes.byteLength <= MAX_RECORD_BYTES ? bytes : null;
	} catch {
		return null;
	}
}

export function encodeDurableObservationRecord(raw: unknown): DurableObservationEncodeResult {
	const record = snapshotRecord(raw);
	if (!record.ok) return encodeFailed(record.error.code);
	const bytes = encodeNormalized(record.value);
	return bytes ? Object.freeze({ ok: true as const, bytes }) : encodeFailed("OVERFLOW");
}

export function decodeDurableObservationRecord(
	bytes: Uint8Array,
	expectedIdentity?: unknown,
): DurableObservationRecordResult {
	if (!ownedBytes(bytes)) return failed("BYTES_INVALID");
	try {
		const length = intrinsicLength(bytes);
		if (length < 2 || length > MAX_RECORD_BYTES) return failed("OVERFLOW");
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return failed("BYTES_INVALID");
		}
		const record = snapshotRecord(parsed, expectedIdentity);
		if (!record.ok) return record;
		const canonical = encodeNormalized(record.value);
		if (!canonical) return failed("OVERFLOW");
		try {
			if (!sameBytes(bytes, canonical)) return failed("NON_CANONICAL");
		} finally {
			erase(canonical);
		}
		return record;
	} finally {
		erase(bytes);
	}
}
