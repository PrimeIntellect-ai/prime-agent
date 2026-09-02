import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	computeDurableObservationId,
	type DurableObservationAppliedRecord,
	type DurableObservationIdentity,
	type DurableObservationPendingRecord,
	type DurableObservationRecord,
	decodeDurableObservationRecord,
	encodeDurableObservationRecord,
} from "./durable-observation-record-codec.js";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { canonicalDigest, decodeEnvelope, isValidDigest, isValidSafeId } from "./remote-host-frame-codec.js";
import { RemoteObservationMirror } from "./remote-observation-mirror.js";
import { decodeRemoteObservationSnapshotV1, type RemoteObservationSnapshotV1 } from "./remote-observation-snapshot.js";

const MAX_PAGE_COUNT = 64;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 1024;
const MAX_TOTAL_RECORDS = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const INPUT_KEYS = new Set(["backend", "identity"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const BACKEND_KEYS = new Set(["close", "publishApplied", "publishPending", "recoverPage"]);
const APPLY_KEYS = new Set(["envelope"]);
const PAGE_KEYS = new Set(["entries", "nextCursor", "owner", "status"]);
const PAGE_ENTRY_KEYS = new Set(["bytes", "sequence", "sha256", "size"]);
const PUBLISH_RESULT_KEYS = new Set(["observationId", "sequence", "sha256", "size", "state", "status"]);
const CLOSE_RESULT_KEYS = new Set(["status"]);

export type DurableObservationApplicationErrorCode =
	| "CLOSE_UNCONFIRMED"
	| "INPUT_INVALID"
	| "PERSISTENCE_UNCERTAIN"
	| "RECOVERY_CORRUPT"
	| "RECOVERY_UNCERTAIN";

export type DurableObservationApplyResult = Readonly<{ status: "applied" | "error" }>;
export type DurableObservationCloseResult = Readonly<{ status: "closed" | "error" }>;
export type DurableObservationApplicationCapability = Readonly<{
	apply: (raw: unknown) => Promise<DurableObservationApplyResult>;
	close: () => Promise<DurableObservationCloseResult>;
}>;
export type DurableObservationViewCapability = Readonly<{
	snapshot: () => RemoteObservationSnapshotV1;
	status: () => Readonly<{
		closed: boolean;
		generation: string;
		hostId: string;
		poisoned: boolean;
		recoveredRecords: number;
		sessionId: string;
	}>;
}>;
export type CreateDurableObservationApplicationResult =
	| Readonly<{
			ok: true;
			application: DurableObservationApplicationCapability;
			view: DurableObservationViewCapability;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: DurableObservationApplicationErrorCode }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;
type OwnedClose = () => Promise<boolean>;
type Backend = Readonly<{
	identity: object;
	recoverPage: BoundMethod;
	publishPending: BoundMethod;
	publishApplied: BoundMethod;
	close: OwnedClose;
	usable: boolean;
}>;
type PageEntry = Readonly<{ sequence: number; record: DurableObservationRecord }>;
type Chain = Readonly<{
	lastSequence: number;
	lastSnapshot: RemoteObservationSnapshotV1 | null;
	pending: DurableObservationPendingRecord | null;
	recordCount: number;
	totalBytes: number;
	seen: ReadonlyMap<string, "pending" | "applied">;
	frameIds: ReadonlyMap<string, string>;
	eventIds: ReadonlyMap<string, string>;
	eventSequences: ReadonlyMap<number, string>;
}>;

function failure(code: DurableObservationApplicationErrorCode): CreateDurableObservationApplicationResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function applyStatus(status: "applied" | "error"): DurableObservationApplyResult {
	return Object.freeze({ status });
}

function closeStatus(status: "closed" | "error"): DurableObservationCloseResult {
	return Object.freeze({ status });
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

function bind(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
	if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as CallableFunction;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
	} catch {
		return null;
	}
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			types.isPromise(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observe(raw: unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) {
						late?.(value);
						return;
					}
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "rejected" as const }));
				},
			]);
		} catch {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function invoke(call: () => unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
	return observe(raw, timeoutMs, late);
}

function statusIs(raw: unknown, status: string): boolean {
	return exact(raw, CLOSE_RESULT_KEYS)?.status?.value === status;
}

function ownedClose(method: BoundMethod): OwnedClose {
	let shared: Promise<boolean> | null = null;
	return (): Promise<boolean> => {
		if (shared) return shared;
		shared = invoke(() => method(), CLOSE_TIMEOUT_MS).then(
			(result) => result.status === "fulfilled" && statusIs(result.value, "closed"),
			() => false,
		);
		return shared;
	};
}

function snapshotIdentity(raw: unknown): Readonly<DurableObservationIdentity> | null {
	const found = exact(raw, IDENTITY_KEYS);
	const hostId = found?.hostId?.value;
	const generation = found?.generation?.value;
	const sessionId = found?.sessionId?.value;
	return isValidSafeId(hostId) && isValidSafeId(generation) && isValidSafeId(sessionId)
		? Object.freeze({ hostId, generation, sessionId })
		: null;
}

function acquireBackend(raw: unknown): Backend | null {
	if (typeof raw !== "object" || raw === null) return null;
	const preliminary = descriptors(raw);
	const closeDescriptor = preliminary?.close;
	const closeMethod = closeDescriptor ? bind(raw, closeDescriptor) : null;
	if (!closeMethod) return null;
	const close = ownedClose(closeMethod);
	const found = exact(raw, BACKEND_KEYS);
	const recoverPage = found ? bind(raw, found.recoverPage!) : null;
	const publishPending = found ? bind(raw, found.publishPending!) : null;
	const publishApplied = found ? bind(raw, found.publishApplied!) : null;
	if (!recoverPage || !publishPending || !publishApplied) {
		return Object.freeze({
			identity: raw,
			recoverPage: () => undefined,
			publishPending: () => undefined,
			publishApplied: () => undefined,
			close,
			usable: false,
		});
	}
	return Object.freeze({ identity: raw, recoverPage, publishPending, publishApplied, close, usable: true });
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

function byteLength(bytes: Uint8Array): number {
	return Reflect.apply(BYTE_LENGTH_GETTER!, bytes, []) as number;
}

function erase(bytes: Uint8Array): void {
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		/* ownership was acquired */
	}
}

function exactArray(raw: unknown): readonly unknown[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Array.prototype ||
			!Object.isFrozen(raw) ||
			Object.getOwnPropertySymbols(raw).length !== 0 ||
			raw.length > MAX_PAGE_COUNT
		)
			return null;
		const found = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(found);
		if (names.length !== raw.length + 1 || names[names.length - 1] !== "length") return null;
		const values: unknown[] = [];
		for (let index = 0; index < raw.length; index += 1) {
			const descriptor = found[String(index)];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
			values.push(descriptor.value);
		}
		return Object.freeze(values);
	} catch {
		return null;
	}
}

function acquirePageOwner(
	raw: unknown,
	identities: Set<object>,
): Readonly<{ identity: object; close: OwnedClose; usable: boolean }> | null {
	if (typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	identities.add(raw);
	const preliminary = descriptors(raw);
	const closeDescriptor = preliminary?.close;
	const method = closeDescriptor ? bind(raw, closeDescriptor) : null;
	if (!method) return null;
	const close = ownedClose(method);
	return Object.freeze({ identity: raw, close, usable: exact(raw, new Set(["close"])) !== null });
}

function acquireDiscoverablePageBytes(raw: unknown, identities: Set<object>): Set<Uint8Array> {
	const output = new Set<Uint8Array>();
	const entriesRaw = (() => {
		const found = descriptors(raw);
		const descriptor = found?.entries;
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	})();
	if (!Array.isArray(entriesRaw)) return output;
	try {
		if (types.isProxy(entriesRaw) || Object.getPrototypeOf(entriesRaw) !== Array.prototype) return output;
		const found = Object.getOwnPropertyDescriptors(entriesRaw);
		for (let index = 0; index < entriesRaw.length; index += 1) {
			const entryDescriptor = found[String(index)];
			const entry = entryDescriptor && "value" in entryDescriptor ? entryDescriptor.value : undefined;
			const bytesDescriptor = descriptors(entry)?.bytes;
			const bytes = bytesDescriptor && "value" in bytesDescriptor ? bytesDescriptor.value : undefined;
			if (ownedBytes(bytes) && !identities.has(bytes)) {
				identities.add(bytes);
				output.add(bytes);
			}
		}
	} catch {
		/* page owner remains responsible for undiscoverable state */
	}
	return output;
}

async function closeLatePage(raw: unknown, identities: Set<object>): Promise<void> {
	const pageBytes = acquireDiscoverablePageBytes(raw, identities);
	for (const bytes of pageBytes) erase(bytes);
	const ownerRaw = (() => {
		const found = descriptors(raw);
		const descriptor = found?.owner;
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	})();
	const owner = acquirePageOwner(ownerRaw, identities);
	if (owner) await owner.close();
}

function recordBaseDigest(record: DurableObservationRecord): string | null {
	const digest = canonicalDigest(
		Object.freeze({
			version: record.version,
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
		}),
	);
	return digest.ok ? digest.value : null;
}

function snapshotsEqual(left: RemoteObservationSnapshotV1, right: RemoteObservationSnapshotV1): boolean {
	const leftDigest = canonicalDigest(left);
	const rightDigest = canonicalDigest(right);
	return leftDigest.ok && rightDigest.ok && leftDigest.value === rightDigest.value;
}

function deterministicTransition(
	preSnapshot: RemoteObservationSnapshotV1,
	record: DurableObservationRecord,
	identity: Readonly<DurableObservationIdentity>,
): RemoteObservationSnapshotV1 | null {
	if (record.envelope.frame.type !== "event") return null;
	const restored = RemoteObservationMirror.fromSnapshot(preSnapshot, identity);
	if (!restored.success) return null;
	const applied = restored.mirror.ingestEvent(record.envelope.frame);
	if (!applied.accepted) return null;
	const captured = restored.mirror.captureSnapshot();
	const normalized = Object.freeze({ ...captured, capturedAt: record.envelope.frame.emittedAt });
	const decoded = decodeRemoteObservationSnapshotV1(normalized, identity);
	return decoded.success ? decoded.value : null;
}

function initialSnapshotValid(
	snapshot: RemoteObservationSnapshotV1,
	identity: Readonly<DurableObservationIdentity>,
): boolean {
	const restored = RemoteObservationMirror.fromSnapshot(snapshot, identity);
	if (!restored.success || restored.mirror.currentCursor !== 0) return false;
	const blank = new RemoteObservationMirror(identity).captureSnapshot();
	const normalized = decodeRemoteObservationSnapshotV1(
		Object.freeze({ ...blank, capturedAt: snapshot.capturedAt }),
		identity,
	);
	return normalized.success && snapshotsEqual(normalized.value, snapshot);
}

function extendChain(
	chain: Chain,
	entries: readonly PageEntry[],
	identity: Readonly<DurableObservationIdentity>,
): Chain | null {
	let lastSequence = chain.lastSequence;
	let lastSnapshot = chain.lastSnapshot;
	let pending = chain.pending;
	let recordCount = chain.recordCount;
	const seen = new Map(chain.seen);
	const frameIds = new Map(chain.frameIds);
	const eventIds = new Map(chain.eventIds);
	const eventSequences = new Map(chain.eventSequences);
	for (const entry of entries) {
		if (entry.sequence !== lastSequence + 1) return null;
		lastSequence = entry.sequence;
		recordCount += 1;
		if (recordCount > MAX_TOTAL_RECORDS) return null;
		const record = entry.record;
		if (record.state === "pending") {
			if (
				pending ||
				seen.has(record.observationId) ||
				frameIds.has(record.frameId) ||
				eventIds.has(record.eventId) ||
				eventSequences.has(record.eventSequence)
			)
				return null;
			if (
				lastSnapshot
					? !snapshotsEqual(lastSnapshot, record.preSnapshot)
					: !initialSnapshotValid(record.preSnapshot, identity)
			)
				return null;
			if (!deterministicTransition(record.preSnapshot, record, identity)) return null;
			pending = record;
			seen.set(record.observationId, "pending");
			frameIds.set(record.frameId, record.observationId);
			eventIds.set(record.eventId, record.observationId);
			eventSequences.set(record.eventSequence, record.observationId);
			continue;
		}
		if (
			!pending ||
			pending.observationId !== record.observationId ||
			seen.get(record.observationId) !== "pending" ||
			recordBaseDigest(pending) !== recordBaseDigest(record)
		)
			return null;
		const expected = deterministicTransition(pending.preSnapshot, pending, identity);
		if (!expected || !snapshotsEqual(expected, record.postSnapshot)) return null;
		lastSnapshot = record.postSnapshot;
		pending = null;
		seen.set(record.observationId, "applied");
	}
	return Object.freeze({
		lastSequence,
		lastSnapshot,
		pending,
		recordCount,
		totalBytes: chain.totalBytes,
		seen,
		frameIds,
		eventIds,
		eventSequences,
	});
}

type ReadPageResult =
	| Readonly<{ ok: true; chain: Chain; nextCursor: number | null }>
	| Readonly<{ ok: false; code: "RECOVERY_CORRUPT" | "RECOVERY_UNCERTAIN" }>;

async function readPage(
	backend: Backend,
	identity: Readonly<DurableObservationIdentity>,
	chain: Chain,
	cursor: number | null,
	ownerIdentities: Set<object>,
): Promise<ReadPageResult> {
	const observed = await invoke(
		() => backend.recoverPage(Object.freeze({ cursor, maxCount: MAX_PAGE_COUNT, maxBytes: MAX_PAGE_BYTES })),
		OPERATION_TIMEOUT_MS,
		(value) => {
			void closeLatePage(value, ownerIdentities);
		},
	);
	if (observed.status !== "fulfilled") return Object.freeze({ ok: false, code: "RECOVERY_UNCERTAIN" as const });
	const raw = observed.value;
	const pageDescriptors = descriptors(raw);
	const ownerRaw =
		pageDescriptors?.owner && "value" in pageDescriptors.owner ? pageDescriptors.owner.value : undefined;
	const owner = acquirePageOwner(ownerRaw, ownerIdentities);
	if (!owner) return Object.freeze({ ok: false, code: "RECOVERY_UNCERTAIN" as const });
	const acquiredBytes = acquireDiscoverablePageBytes(raw, ownerIdentities);
	const parse = (): ReadPageResult => {
		const corrupt = Object.freeze({ ok: false as const, code: "RECOVERY_CORRUPT" as const });
		const page = exact(raw, PAGE_KEYS);
		const values = page ? exactArray(page.entries?.value) : null;
		if (!page || !owner.usable || page.status?.value !== "page" || !values) return corrupt;
		const entries: PageEntry[] = [];
		const usedBytes = new Set<Uint8Array>();
		let pageBytes = 0;
		for (const value of values) {
			const entry = exact(value, PAGE_ENTRY_KEYS);
			const sequence = entry?.sequence?.value;
			const bytes = entry?.bytes?.value;
			const size = entry?.size?.value;
			const sha256 = entry?.sha256?.value;
			if (
				typeof sequence !== "number" ||
				!Number.isSafeInteger(sequence) ||
				sequence < 1 ||
				!ownedBytes(bytes) ||
				!acquiredBytes.has(bytes) ||
				usedBytes.has(bytes) ||
				typeof size !== "number" ||
				!Number.isSafeInteger(size) ||
				size < 2 ||
				size !== byteLength(bytes) ||
				typeof sha256 !== "string" ||
				!isValidDigest(sha256)
			)
				return corrupt;
			usedBytes.add(bytes);
			pageBytes += size;
			if (
				!Number.isSafeInteger(pageBytes) ||
				pageBytes > MAX_PAGE_BYTES ||
				chain.totalBytes + pageBytes > MAX_TOTAL_BYTES
			)
				return corrupt;
			if (createHash("sha256").update(bytes).digest("hex") !== sha256) return corrupt;
			acquiredBytes.delete(bytes);
			const decoded = decodeDurableObservationRecord(bytes, identity);
			if (!decoded.ok) return corrupt;
			entries.push(Object.freeze({ sequence, record: decoded.value }));
		}
		const nextRaw = page.nextCursor?.value;
		const nextCursor = nextRaw === null ? null : nextRaw;
		if (
			nextCursor !== null &&
			(typeof nextCursor !== "number" ||
				!Number.isSafeInteger(nextCursor) ||
				nextCursor < 1 ||
				values.length === 0 ||
				nextCursor !== entries[entries.length - 1]?.sequence ||
				(cursor !== null && nextCursor <= cursor))
		)
			return corrupt;
		const extended = extendChain(chain, Object.freeze(entries), identity);
		if (!extended) return corrupt;
		return Object.freeze({
			ok: true as const,
			chain: Object.freeze({ ...extended, totalBytes: chain.totalBytes + pageBytes }),
			nextCursor,
		});
	};
	let result: ReadPageResult;
	let ownerClosed = false;
	try {
		result = parse();
	} finally {
		for (const bytes of acquiredBytes) erase(bytes);
		ownerClosed = await owner.close();
	}
	return ownerClosed ? result : Object.freeze({ ok: false, code: "RECOVERY_UNCERTAIN" as const });
}

type PublicationResult = Readonly<{ ok: true; sequence: number; size: number }> | Readonly<{ ok: false }>;

function encodedRecordSize(record: DurableObservationRecord): number | null {
	const encoded = encodeDurableObservationRecord(record);
	if (!encoded.ok) return null;
	const size = byteLength(encoded.bytes);
	erase(encoded.bytes);
	return size;
}

async function publishRecord(
	method: BoundMethod,
	record: DurableObservationPendingRecord | DurableObservationAppliedRecord,
): Promise<PublicationResult> {
	const encoded = encodeDurableObservationRecord(record);
	if (!encoded.ok) return Object.freeze({ ok: false as const });
	let owned: Uint8Array | null = encoded.bytes;
	const size = byteLength(owned);
	const sha256 = createHash("sha256").update(owned).digest("hex");
	let raw: unknown;
	try {
		raw = method(
			Object.freeze({
				bytes: owned,
				observationId: record.observationId,
				sha256,
				size,
				state: record.state,
			}),
		);
		owned = null;
	} catch {
		owned = null;
		return Object.freeze({ ok: false as const });
	} finally {
		if (owned) erase(owned);
	}
	const observed = await observe(raw, OPERATION_TIMEOUT_MS);
	if (observed.status !== "fulfilled") return Object.freeze({ ok: false as const });
	const result = exact(observed.value, PUBLISH_RESULT_KEYS);
	const sequence = result?.sequence?.value;
	return result?.status?.value === "persisted" &&
		result.state?.value === record.state &&
		result.observationId?.value === record.observationId &&
		result.sha256?.value === sha256 &&
		result.size?.value === size &&
		typeof sequence === "number" &&
		Number.isSafeInteger(sequence) &&
		sequence >= 1
		? Object.freeze({ ok: true as const, sequence, size })
		: Object.freeze({ ok: false as const });
}

function appliedRecord(
	pending: DurableObservationPendingRecord,
	postSnapshot: RemoteObservationSnapshotV1,
): DurableObservationAppliedRecord {
	return Object.freeze({
		version: pending.version,
		state: "applied",
		hostId: pending.hostId,
		generation: pending.generation,
		sessionId: pending.sessionId,
		observationId: pending.observationId,
		frameId: pending.frameId,
		eventId: pending.eventId,
		eventSequence: pending.eventSequence,
		envelopeDigest: pending.envelopeDigest,
		envelope: pending.envelope,
		preSnapshot: pending.preSnapshot,
		postSnapshot,
	});
}

async function recover(
	backend: Backend,
	identity: Readonly<DurableObservationIdentity>,
	ownerIdentities: Set<object>,
): Promise<
	Readonly<{ ok: true; chain: Chain }> | Readonly<{ ok: false; code: "RECOVERY_CORRUPT" | "RECOVERY_UNCERTAIN" }>
> {
	let chain: Chain = Object.freeze({
		lastSequence: 0,
		lastSnapshot: null,
		pending: null,
		recordCount: 0,
		totalBytes: 0,
		seen: new Map(),
		frameIds: new Map(),
		eventIds: new Map(),
		eventSequences: new Map(),
	});
	let cursor: number | null = null;
	const cursors = new Set<number>();
	let complete = false;
	for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
		const page = await readPage(backend, identity, chain, cursor, ownerIdentities);
		if (!page.ok) return page;
		chain = page.chain;
		if (page.nextCursor === null) {
			complete = true;
			break;
		}
		if (cursors.has(page.nextCursor)) return Object.freeze({ ok: false, code: "RECOVERY_CORRUPT" as const });
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	if (!complete) return Object.freeze({ ok: false, code: "RECOVERY_CORRUPT" as const });
	if (chain.pending) {
		if (chain.recordCount >= MAX_TOTAL_RECORDS)
			return Object.freeze({ ok: false, code: "RECOVERY_CORRUPT" as const });
		const postSnapshot = deterministicTransition(chain.pending.preSnapshot, chain.pending, identity);
		if (!postSnapshot) return Object.freeze({ ok: false, code: "RECOVERY_CORRUPT" as const });
		const record = appliedRecord(chain.pending, postSnapshot);
		const recordSize = encodedRecordSize(record);
		if (recordSize === null || chain.totalBytes + recordSize > MAX_TOTAL_BYTES)
			return Object.freeze({ ok: false, code: "RECOVERY_CORRUPT" as const });
		const published = await publishRecord(backend.publishApplied, record);
		if (!published.ok || published.sequence !== chain.lastSequence + 1) {
			return Object.freeze({ ok: false, code: "RECOVERY_UNCERTAIN" as const });
		}
		const seen = new Map(chain.seen);
		seen.set(record.observationId, "applied");
		chain = Object.freeze({
			...chain,
			lastSequence: published.sequence,
			lastSnapshot: postSnapshot,
			pending: null,
			recordCount: chain.recordCount + 1,
			totalBytes: chain.totalBytes + published.size,
			seen,
		});
	}
	return Object.freeze({ ok: true as const, chain });
}

function initialSnapshot(identity: Readonly<DurableObservationIdentity>): RemoteObservationSnapshotV1 | null {
	const snapshot = new RemoteObservationMirror(identity).captureSnapshot();
	const decoded = decodeRemoteObservationSnapshotV1(snapshot, identity);
	return decoded.success ? decoded.value : null;
}

class DurableObservationApplication {
	private readonly context = new AsyncLocalStorage<object>();
	private readonly contextToken = Object.freeze({});
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<DurableObservationCloseResult> | null = null;
	private closed = false;
	private poisoned = false;

	constructor(
		private readonly backend: Backend,
		private readonly identity: Readonly<DurableObservationIdentity>,
		private currentSnapshot: RemoteObservationSnapshotV1,
		private durableSequence: number,
		private recoveredRecords: number,
		private durableBytes: number,
		private readonly frameIds: Set<string>,
		private readonly eventIds: Set<string>,
		private readonly eventSequences: Set<number>,
	) {}

	application(): DurableObservationApplicationCapability {
		return Object.freeze({ apply: (raw: unknown) => this.apply(raw), close: () => this.close() });
	}

	view(): DurableObservationViewCapability {
		return Object.freeze({
			snapshot: () => this.currentSnapshot,
			status: () =>
				Object.freeze({
					closed: this.closed,
					generation: this.identity.generation,
					hostId: this.identity.hostId,
					poisoned: this.poisoned,
					recoveredRecords: this.recoveredRecords,
					sessionId: this.identity.sessionId,
				}),
		});
	}

	private apply(raw: unknown): Promise<DurableObservationApplyResult> {
		if (this.context.getStore() === this.contextToken) {
			this.poisoned = true;
			return Promise.resolve(applyStatus("error"));
		}
		if (this.closed || this.poisoned) return Promise.resolve(applyStatus("error"));
		const input = exact(raw, APPLY_KEYS);
		const decoded = decodeEnvelope(input?.envelope?.value);
		if (!input || !decoded.ok || decoded.value.frame.type !== "event") return Promise.resolve(applyStatus("error"));
		const envelope = decoded.value;
		const operation = this.tail.then(
			() => this.context.run(this.contextToken, () => this.applyOrdered(envelope)),
			() => {
				this.poisoned = true;
				return applyStatus("error");
			},
		);
		const safe = operation.then(
			(value) => value,
			() => {
				this.poisoned = true;
				return applyStatus("error");
			},
		);
		this.tail = safe.then(() => undefined);
		return safe;
	}

	private async applyOrdered(envelope: RemoteHostFrameEnvelope): Promise<DurableObservationApplyResult> {
		if (this.closed || this.poisoned || envelope.frame.type !== "event") return applyStatus("error");
		const digest = canonicalDigest(envelope);
		if (!digest.ok) return this.poison();
		const id = computeDurableObservationId(
			Object.freeze({
				version: 1,
				hostId: this.identity.hostId,
				generation: this.identity.generation,
				sessionId: this.identity.sessionId,
				frameId: envelope.frameId,
				eventId: envelope.frame.id,
				eventSequence: envelope.frame.sequence,
				envelopeDigest: digest.value,
			}),
		);
		if (
			!id.ok ||
			this.frameIds.has(envelope.frameId) ||
			this.eventIds.has(envelope.frame.id) ||
			this.eventSequences.has(envelope.frame.sequence)
		)
			return this.poison();
		const pending: DurableObservationPendingRecord = Object.freeze({
			version: 1,
			state: "pending",
			hostId: this.identity.hostId,
			generation: this.identity.generation,
			sessionId: this.identity.sessionId,
			observationId: id.value,
			frameId: envelope.frameId,
			eventId: envelope.frame.id,
			eventSequence: envelope.frame.sequence,
			envelopeDigest: digest.value,
			envelope,
			preSnapshot: this.currentSnapshot,
		});
		const postSnapshot = deterministicTransition(this.currentSnapshot, pending, this.identity);
		if (!postSnapshot) return this.poison();
		const applied = appliedRecord(pending, postSnapshot);
		const pendingSize = encodedRecordSize(pending);
		const appliedSize = encodedRecordSize(applied);
		if (
			pendingSize === null ||
			appliedSize === null ||
			this.recoveredRecords + 2 > MAX_TOTAL_RECORDS ||
			this.durableBytes + pendingSize + appliedSize > MAX_TOTAL_BYTES
		)
			return this.poison();
		const pendingPublication = await publishRecord(this.backend.publishPending, pending);
		if (!pendingPublication.ok || pendingPublication.sequence !== this.durableSequence + 1 || this.poisoned)
			return this.poison();
		const appliedPublication = await publishRecord(this.backend.publishApplied, applied);
		if (!appliedPublication.ok || appliedPublication.sequence !== pendingPublication.sequence + 1)
			return this.poison();
		this.currentSnapshot = postSnapshot;
		this.durableSequence = appliedPublication.sequence;
		this.recoveredRecords += 2;
		this.durableBytes += pendingPublication.size + appliedPublication.size;
		this.frameIds.add(envelope.frameId);
		this.eventIds.add(envelope.frame.id);
		this.eventSequences.add(envelope.frame.sequence);
		return applyStatus("applied");
	}

	private poison(): DurableObservationApplyResult {
		this.poisoned = true;
		return applyStatus("error");
	}

	private close(): Promise<DurableObservationCloseResult> {
		if (this.context.getStore() === this.contextToken) {
			this.poisoned = true;
			return Promise.resolve(closeStatus("error"));
		}
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.tail.then(
			() => this.closeBackend(),
			() => this.closeBackend(),
		);
		this.tail = this.closePromise.then(() => undefined);
		return this.closePromise;
	}

	private async closeBackend(): Promise<DurableObservationCloseResult> {
		return (await this.backend.close()) ? closeStatus("closed") : closeStatus("error");
	}
}

export async function createDurableObservationApplication(
	raw: unknown,
): Promise<CreateDurableObservationApplicationResult> {
	const input = exact(raw, INPUT_KEYS);
	if (!input) return failure("INPUT_INVALID");
	const backend = acquireBackend(input.backend?.value);
	if (!backend) return failure("INPUT_INVALID");
	const fail = async (
		code: DurableObservationApplicationErrorCode,
	): Promise<CreateDurableObservationApplicationResult> =>
		(await backend.close()) ? failure(code) : failure("CLOSE_UNCONFIRMED");
	if (!backend.usable) return await fail("INPUT_INVALID");
	try {
		const identity = snapshotIdentity(input.identity?.value);
		if (!identity) return await fail("INPUT_INVALID");
		const ownerIdentities = new Set<object>([backend.identity]);
		const recovered = await recover(backend, identity, ownerIdentities);
		if (!recovered.ok) return await fail(recovered.code);
		const snapshot = recovered.chain.lastSnapshot ?? initialSnapshot(identity);
		if (!snapshot) return await fail("RECOVERY_CORRUPT");
		const restored = RemoteObservationMirror.fromSnapshot(snapshot, identity);
		if (!restored.success) return await fail("RECOVERY_CORRUPT");
		const implementation = new DurableObservationApplication(
			backend,
			identity,
			snapshot,
			recovered.chain.lastSequence,
			recovered.chain.recordCount,
			recovered.chain.totalBytes,
			new Set(recovered.chain.frameIds.keys()),
			new Set(recovered.chain.eventIds.keys()),
			new Set(recovered.chain.eventSequences.keys()),
		);
		return Object.freeze({
			ok: true as const,
			application: implementation.application(),
			view: implementation.view(),
		});
	} catch {
		return await fail("RECOVERY_UNCERTAIN");
	}
}
