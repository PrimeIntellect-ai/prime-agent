import { createHash } from "node:crypto";

export const MAX_OWNERSHIP_RECORD_BYTES = 4096;
export const MAX_OWNERSHIP_FIELD_BYTES = 256;

export type OwnershipStage = "pre_admit" | "creating" | "active" | "delete_intent" | "deleting" | "deleted";

export type NonDeletedTransitionStage = "creating" | "active" | "delete_intent" | "deleting";
export type OwnershipSequence = 1 | 2 | 3 | 4 | 5 | 6;

export type OwnershipIntent = Readonly<{
	lifecycleKey: string;
	parentSessionId: string;
	childSessionId: string;
}>;

export type OwnershipRecord = Readonly<{
	version: 1;
	sequence: OwnershipSequence;
	stage: OwnershipStage;
	lifecycleKey: string;
	parentSessionId: string;
	childSessionId: string;
	recordedAt: string;
	previousDigest: string | null;
	contentDigest: string;
}>;

export type OwnershipCodecFailureCode = "INPUT_INVALID" | "CORRUPT" | "CONFLICT" | "INVALID_TRANSITION";
export type OwnershipCodecFailure = Readonly<{ ok: false; code: OwnershipCodecFailureCode }>;

export type CanonicalOwnershipPayload = Readonly<{
	byteLength: number;
	take: () => Uint8Array | undefined;
	discard: () => boolean;
}>;

export type OwnershipRecordCreation = Readonly<{
	record: OwnershipRecord;
	payload: CanonicalOwnershipPayload;
}>;

export type OwnershipCreateResult = Readonly<{ ok: true; value: OwnershipRecordCreation }> | OwnershipCodecFailure;

export type OwnershipDecodeResult = Readonly<{ ok: true; value: OwnershipRecord }> | OwnershipCodecFailure;

export type ValidatedOwnershipChain = Readonly<{
	records: readonly OwnershipRecord[];
	current: OwnershipRecord;
	intent: OwnershipIntent;
}>;

export type OwnershipChainResult = Readonly<{ ok: true; value: ValidatedOwnershipChain }> | OwnershipCodecFailure;

export type OwnershipTransitionResult =
	| Readonly<{ ok: true; idempotent: false; value: OwnershipRecordCreation }>
	| Readonly<{ ok: true; idempotent: true; value: OwnershipRecord }>
	| OwnershipCodecFailure;

const MISSING = Symbol("missing-own-data-property");
type Missing = typeof MISSING;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOWER_HEX_DIGEST = /^[0-9a-f]{64}$/;
const RECORD_KEYS: readonly string[] = Object.freeze([
	"version",
	"sequence",
	"stage",
	"lifecycleKey",
	"parentSessionId",
	"childSessionId",
	"recordedAt",
	"previousDigest",
	"contentDigest",
]);
const validatedChains = new WeakSet<object>();

function failure(code: OwnershipCodecFailureCode): OwnershipCodecFailure {
	return Object.freeze({ ok: false, code });
}

function ownData(object: object, key: string): unknown | Missing {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return MISSING;
	const value: unknown = descriptor.value;
	return value;
}

function isOrdinaryObject(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function exactRecordObject(value: unknown, requireFrozen: boolean): value is object {
	if (!isOrdinaryObject(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== RECORD_KEYS.length) return false;
	for (let index = 0; index < keys.length; index++) {
		if (keys[index] !== RECORD_KEYS[index]) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
		if (
			descriptor === undefined ||
			!Object.hasOwn(descriptor, "value") ||
			descriptor.enumerable !== true ||
			descriptor.configurable !== !requireFrozen ||
			descriptor.writable !== !requireFrozen
		) {
			return false;
		}
	}
	if (Object.getOwnPropertyNames(value).length !== RECORD_KEYS.length) return false;
	return !requireFrozen || Object.isFrozen(value);
}

function boundedIdentity(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit <= 0x7f) {
			bytes += 1;
		} else if (unit <= 0x7ff) {
			bytes += 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		} else {
			bytes += 3;
		}
		if (bytes > MAX_OWNERSHIP_FIELD_BYTES) return false;
	}
	return true;
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !ISO_MILLISECONDS.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && LOWER_HEX_DIGEST.test(value);
}

function validStage(value: unknown): value is OwnershipStage {
	return (
		value === "pre_admit" ||
		value === "creating" ||
		value === "active" ||
		value === "delete_intent" ||
		value === "deleting" ||
		value === "deleted"
	);
}

function validSequence(value: unknown): value is OwnershipSequence {
	return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

function validNonDeletedTarget(value: unknown): value is NonDeletedTransitionStage {
	return value === "creating" || value === "active" || value === "delete_intent" || value === "deleting";
}

function edgeAllowed(from: OwnershipStage, to: OwnershipStage): boolean {
	if (from === "pre_admit") return to === "creating" || to === "deleted";
	if (from === "creating") return to === "active" || to === "delete_intent";
	if (from === "active") return to === "delete_intent";
	if (from === "delete_intent") return to === "deleting" || to === "deleted";
	if (from === "deleting") return to === "deleted";
	return false;
}

function sameIntent(first: OwnershipIntent, second: OwnershipIntent): boolean {
	return (
		first.lifecycleKey === second.lifecycleKey &&
		first.parentSessionId === second.parentSessionId &&
		first.childSessionId === second.childSessionId
	);
}

function copyIntentUnsafe(value: unknown): OwnershipIntent | undefined {
	if (!isOrdinaryObject(value)) return undefined;
	const lifecycleKey = ownData(value, "lifecycleKey");
	const parentSessionId = ownData(value, "parentSessionId");
	const childSessionId = ownData(value, "childSessionId");
	if (!boundedIdentity(lifecycleKey) || !boundedIdentity(parentSessionId) || !boundedIdentity(childSessionId)) {
		return undefined;
	}
	return Object.freeze({ lifecycleKey, parentSessionId, childSessionId });
}

function copyIntent(value: unknown): OwnershipIntent | undefined {
	try {
		return copyIntentUnsafe(value);
	} catch {
		return undefined;
	}
}

function canonicalPrefix(record: Omit<OwnershipRecord, "contentDigest">): string {
	return `{"version":1,"sequence":${record.sequence},"stage":${JSON.stringify(record.stage)},"lifecycleKey":${JSON.stringify(record.lifecycleKey)},"parentSessionId":${JSON.stringify(record.parentSessionId)},"childSessionId":${JSON.stringify(record.childSessionId)},"recordedAt":${JSON.stringify(record.recordedAt)},"previousDigest":${record.previousDigest === null ? "null" : JSON.stringify(record.previousDigest)}`;
}

function eraseAndVerify(bytes: Uint8Array): boolean {
	bytes.fill(0);
	for (let index = 0; index < bytes.length; index++) {
		if (bytes[index] !== 0) return false;
	}
	return true;
}

function digestPrefix(prefix: string): string | undefined {
	const bytes = new TextEncoder().encode(prefix);
	let digest: string;
	try {
		digest = createHash("sha256").update(bytes).digest("hex");
	} catch {
		eraseAndVerify(bytes);
		return undefined;
	}
	if (!eraseAndVerify(bytes)) return undefined;
	return digest;
}

function createPayload(bytes: Uint8Array): CanonicalOwnershipPayload {
	let available: Uint8Array | undefined = bytes;
	const byteLength = bytes.byteLength;
	return Object.freeze({
		byteLength,
		take: () => {
			const result = available;
			available = undefined;
			return result;
		},
		discard: () => {
			if (available === undefined) return true;
			const erased = eraseAndVerify(available);
			available = undefined;
			return erased;
		},
	});
}

function freezeRecord(record: OwnershipRecord): OwnershipRecord {
	return Object.freeze({
		version: 1,
		sequence: record.sequence,
		stage: record.stage,
		lifecycleKey: record.lifecycleKey,
		parentSessionId: record.parentSessionId,
		childSessionId: record.childSessionId,
		recordedAt: record.recordedAt,
		previousDigest: record.previousDigest,
		contentDigest: record.contentDigest,
	});
}

function finalizeRecord(
	sequence: OwnershipSequence,
	stage: OwnershipStage,
	intent: OwnershipIntent,
	previousDigest: string | null,
	recordedAt: string,
): OwnershipCreateResult {
	if (
		!boundedIdentity(intent.lifecycleKey) ||
		!boundedIdentity(intent.parentSessionId) ||
		!boundedIdentity(intent.childSessionId) ||
		!validTimestamp(recordedAt) ||
		(previousDigest !== null && !validDigest(previousDigest))
	) {
		return failure("INPUT_INVALID");
	}
	const withoutDigest: Omit<OwnershipRecord, "contentDigest"> = {
		version: 1,
		sequence,
		stage,
		lifecycleKey: intent.lifecycleKey,
		parentSessionId: intent.parentSessionId,
		childSessionId: intent.childSessionId,
		recordedAt,
		previousDigest,
	};
	const prefix = canonicalPrefix(withoutDigest);
	const contentDigest = digestPrefix(prefix);
	if (contentDigest === undefined) return failure("INPUT_INVALID");
	const bytes = new TextEncoder().encode(`${prefix},"contentDigest":${JSON.stringify(contentDigest)}}`);
	if (bytes.byteLength > MAX_OWNERSHIP_RECORD_BYTES) {
		eraseAndVerify(bytes);
		return failure("INPUT_INVALID");
	}
	const record = freezeRecord({ ...withoutDigest, contentDigest });
	const value: OwnershipRecordCreation = Object.freeze({ record, payload: createPayload(bytes) });
	return Object.freeze({ ok: true, value });
}

function copyValidatedRecordUnsafe(value: unknown, requireFrozen: boolean): OwnershipRecord | undefined {
	if (!exactRecordObject(value, requireFrozen)) return undefined;
	const version = ownData(value, "version");
	const sequence = ownData(value, "sequence");
	const stage = ownData(value, "stage");
	const lifecycleKey = ownData(value, "lifecycleKey");
	const parentSessionId = ownData(value, "parentSessionId");
	const childSessionId = ownData(value, "childSessionId");
	const recordedAt = ownData(value, "recordedAt");
	const previousDigest = ownData(value, "previousDigest");
	const contentDigest = ownData(value, "contentDigest");
	if (
		version !== 1 ||
		!validSequence(sequence) ||
		!validStage(stage) ||
		!boundedIdentity(lifecycleKey) ||
		!boundedIdentity(parentSessionId) ||
		!boundedIdentity(childSessionId) ||
		!validTimestamp(recordedAt) ||
		(previousDigest !== null && !validDigest(previousDigest)) ||
		!validDigest(contentDigest)
	) {
		return undefined;
	}
	const record = freezeRecord({
		version: 1,
		sequence,
		stage,
		lifecycleKey,
		parentSessionId,
		childSessionId,
		recordedAt,
		previousDigest,
		contentDigest,
	});
	const prefix = canonicalPrefix(record);
	const expected = digestPrefix(prefix);
	if (expected === undefined || expected !== contentDigest) return undefined;
	const canonical = new TextEncoder().encode(`${prefix},"contentDigest":${JSON.stringify(contentDigest)}}`);
	const validSize = canonical.byteLength <= MAX_OWNERSHIP_RECORD_BYTES;
	if (!eraseAndVerify(canonical) || !validSize) return undefined;
	return record;
}

function copyValidatedRecord(value: unknown, requireFrozen: boolean): OwnershipRecord | undefined {
	try {
		return copyValidatedRecordUnsafe(value, requireFrozen);
	} catch {
		return undefined;
	}
}

export function createPreAdmitOwnershipRecord(intent: OwnershipIntent, recordedAt: string): OwnershipCreateResult {
	const copiedIntent = copyIntent(intent);
	if (copiedIntent === undefined) return failure("INPUT_INVALID");
	return finalizeRecord(1, "pre_admit", copiedIntent, null, recordedAt);
}

export function decodeOwnershipRecord(input: Uint8Array): OwnershipDecodeResult {
	if (!(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > MAX_OWNERSHIP_RECORD_BYTES) {
		if (input instanceof Uint8Array) eraseAndVerify(input);
		return failure("CORRUPT");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		eraseAndVerify(input);
		return failure("CORRUPT");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		eraseAndVerify(input);
		return failure("CORRUPT");
	}
	const record = copyValidatedRecord(parsed, false);
	if (record === undefined) {
		eraseAndVerify(input);
		return failure("CORRUPT");
	}
	const prefix = canonicalPrefix(record);
	const canonical = new TextEncoder().encode(`${prefix},"contentDigest":${JSON.stringify(record.contentDigest)}}`);
	let equal = canonical.byteLength === input.byteLength;
	for (let index = 0; equal && index < input.byteLength; index++) {
		if (canonical[index] !== input[index]) equal = false;
	}
	const canonicalErased = eraseAndVerify(canonical);
	const inputErased = eraseAndVerify(input);
	if (!equal || !canonicalErased || !inputErased) return failure("CORRUPT");
	return Object.freeze({ ok: true, value: record });
}

function validateOwnershipChainUnsafe(records: readonly OwnershipRecord[]): OwnershipChainResult {
	if (!Array.isArray(records) || records.length < 1 || records.length > 6) return failure("CORRUPT");
	const copies: OwnershipRecord[] = [];
	for (let index = 0; index < records.length; index++) {
		const value = ownData(records, String(index));
		const record = copyValidatedRecord(value, true);
		if (record === undefined || record.sequence !== index + 1) return failure("CORRUPT");
		copies.push(record);
	}
	const first = copies[0];
	if (first.stage !== "pre_admit" || first.previousDigest !== null) return failure("CORRUPT");
	const intent: OwnershipIntent = Object.freeze({
		lifecycleKey: first.lifecycleKey,
		parentSessionId: first.parentSessionId,
		childSessionId: first.childSessionId,
	});
	for (let index = 1; index < copies.length; index++) {
		const prior = copies[index - 1];
		const current = copies[index];
		if (
			!sameIntent(intent, current) ||
			current.previousDigest !== prior.contentDigest ||
			!edgeAllowed(prior.stage, current.stage) ||
			Date.parse(current.recordedAt) < Date.parse(prior.recordedAt)
		) {
			return failure("CORRUPT");
		}
	}
	const frozenRecords = Object.freeze(copies);
	const value: ValidatedOwnershipChain = Object.freeze({
		records: frozenRecords,
		current: frozenRecords[frozenRecords.length - 1],
		intent,
	});
	validatedChains.add(value);
	return Object.freeze({ ok: true, value });
}

export function validateOwnershipChain(records: readonly OwnershipRecord[]): OwnershipChainResult {
	try {
		return validateOwnershipChainUnsafe(records);
	} catch {
		return failure("CORRUPT");
	}
}

export function decideNonDeletedOwnershipTransition(
	chain: ValidatedOwnershipChain,
	target: NonDeletedTransitionStage,
	intent: OwnershipIntent,
	recordedAt: string,
): OwnershipTransitionResult {
	if (!validatedChains.has(chain)) return failure("CORRUPT");
	if (!validNonDeletedTarget(target) || !validTimestamp(recordedAt)) return failure("INPUT_INVALID");
	const copiedIntent = copyIntent(intent);
	if (copiedIntent === undefined) return failure("INPUT_INVALID");
	if (!sameIntent(chain.intent, copiedIntent)) return failure("CONFLICT");
	for (const record of chain.records) {
		if (record.stage === target) {
			return Object.freeze({ ok: true, idempotent: true, value: chain.current });
		}
	}
	if (!edgeAllowed(chain.current.stage, target)) return failure("INVALID_TRANSITION");
	if (Date.parse(recordedAt) < Date.parse(chain.current.recordedAt)) return failure("INPUT_INVALID");
	const nextSequence = chain.records.length + 1;
	if (!validSequence(nextSequence)) return failure("INVALID_TRANSITION");
	const created = finalizeRecord(nextSequence, target, copiedIntent, chain.current.contentDigest, recordedAt);
	if (!created.ok) return created;
	return Object.freeze({ ok: true, idempotent: false, value: created.value });
}
