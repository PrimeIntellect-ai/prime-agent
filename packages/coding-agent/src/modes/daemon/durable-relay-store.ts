import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
	DeliveryIdentity,
	DeliveryMarkerV1,
	DeliveryState,
	JournalDirection,
} from "./b03-delivery-index-codec.js";
import { encodeDeliveryMarkerV1 } from "./b03-delivery-index-codec.js";
import type { JournalRecordV1 } from "./b03-journal-record-codec.js";
import { encodeJournalRecordV1 } from "./b03-journal-record-codec.js";
import {
	type B03Adapter,
	type B03ListPageRequest,
	type B03OpenRequest,
	recoverB03Directory,
} from "./b03-recovery-directory.js";

const MAX_JOURNALS = 20_000;
const MAX_MARKERS = 40_000;
const MAX_TOTAL_BYTES = 268_435_456;
const PAGE_MAX_COUNT = 64;
const PAGE_MAX_BYTES = 16_777_216;
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const INPUT_KEYS = new Set([
	"deliveryPublisher",
	"direction",
	"identity",
	"journalDir",
	"journalPublisher",
	"recoveryBackend",
]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const PUBLISHER_KEYS = new Set(["close", "publish"]);
const RECOVERY_KEYS = new Set(["close", "listPage", "open"]);
const JOURNAL_RESULT_KEYS = new Set(["seq", "sha256", "size", "status"]);
const MARKER_RESULT_KEYS = new Set(["sequence", "sha256", "size", "status"]);
const CLOSE_RESULT_KEYS = new Set(["status"]);
const MARK_INPUT_KEYS = new Set(["frameId", "recordedAt"]);
const REPLAY_INPUT_KEYS = new Set(["cursor", "maxCount"]);
const JOURNAL_INPUT_KEYS = new Set([
	"direction",
	"envelope",
	"generation",
	"hostId",
	"recordedAt",
	"sessionId",
	"version",
]);

export type DurableRelayStoreErrorCode =
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "COLLISION"
	| "INVALID_ARGUMENT"
	| "MISMATCH"
	| "NOT_FOUND"
	| "POISONED"
	| "RECOVERY_FAILED"
	| "UNCERTAIN";

export type DurableRelayStoreFailure = Readonly<{
	readonly ok: false;
	readonly error: Readonly<{ code: DurableRelayStoreErrorCode }>;
}>;

export type DurableRelayStoreResult<T> = Readonly<{ ok: true; value: T }> | DurableRelayStoreFailure;

export interface DurableReceipt {
	readonly sequence: number;
	readonly size: number;
	readonly sha256: string;
}

export interface DurableFrameState {
	readonly state: DeliveryState;
	readonly record: JournalRecordV1;
	readonly journal: DurableReceipt;
	readonly pending: DurableReceipt | null;
	readonly delivered: DurableReceipt | null;
}

export interface DurableJournalEntry {
	readonly record: JournalRecordV1;
	readonly receipt: DurableReceipt;
}

export interface DurableMarkerEntry {
	readonly marker: DeliveryMarkerV1;
	readonly receipt: DurableReceipt;
}

export interface DurableReplayPage<T> {
	readonly entries: readonly T[];
	readonly nextCursor: number | null;
}

export interface DurableRelayStoreStatus {
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	readonly totalBytes: number;
}

export type CreateDurableRelayStoreResult =
	| Readonly<{
			ok: true;
			store: DurableRelayStore;
			status: DurableRelayStoreStatus;
	  }>
	| Readonly<{
			ok: false;
			error: Readonly<{ code: DurableRelayStoreErrorCode }>;
	  }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;

interface PublisherCapability {
	readonly publish: BoundMethod;
	readonly close: OwnedClose;
}

interface RecoveryCapability {
	readonly listPage: BoundMethod;
	readonly open: BoundMethod;
	readonly close: OwnedClose;
}

interface FrameRecord {
	readonly record: JournalRecordV1;
	readonly envelopeDigest: string;
	readonly journal: DurableReceipt;
	readonly pending: DurableReceipt | null;
	readonly delivered: DurableReceipt | null;
}

interface JournalStored {
	readonly record: JournalRecordV1;
	readonly receipt: DurableReceipt;
}

interface MarkerStored {
	readonly marker: DeliveryMarkerV1;
	readonly receipt: DurableReceipt;
}

interface StoreMemory {
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	readonly journalDir: string;
	readonly journals: readonly JournalStored[];
	readonly markers: readonly MarkerStored[];
	readonly frames: ReadonlyMap<string, FrameRecord>;
	readonly nextJournalSequence: number;
	readonly nextMarkerSequence: number;
	readonly totalBytes: number;
}

interface NativePromiseObservation {
	readonly status: "fulfilled" | "rejected" | "timeout" | "invalid";
	readonly value?: unknown;
}

function failure(code: DurableRelayStoreErrorCode): DurableRelayStoreFailure {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function success<T>(value: T): DurableRelayStoreResult<T> {
	return Object.freeze({ ok: true as const, value });
}

function rawDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const names = Object.getOwnPropertyNames(descriptors);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
}

function method(descriptors: Descriptors, owner: object, name: string): BoundMethod | null {
	const candidate = descriptors[name]?.value;
	if (typeof candidate !== "function") return null;
	try {
		if (types.isProxy(candidate)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(candidate as CallableFunction, owner, args);
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observePromise(raw: unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	if (!isNativePromise(raw)) {
		return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	}
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
					if (settled) return;
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
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function invokeAndObserve(call: () => unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "rejected" as const }));
	}
	return observePromise(raw, timeoutMs);
}

function validId(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		if (code <= 0x20 || code >= 0x7f) return false;
	}
	return true;
}

function validDirection(raw: unknown): raw is JournalDirection {
	return raw === "sent" || raw === "received";
}

function validSequence(raw: unknown): raw is number {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1;
}

function erase(bytes: Uint8Array | null): void {
	if (bytes === null) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		// Best effort for bytes that are still locally owned.
	}
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function snapshotIdentity(raw: unknown): DeliveryIdentity | null {
	const descriptors = exact(raw, IDENTITY_KEYS);
	const hostId = descriptors?.hostId?.value;
	const generation = descriptors?.generation?.value;
	const sessionId = descriptors?.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

function snapshotClose(raw: unknown): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		if (typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) return null;
		const bound = (...args: readonly unknown[]): unknown =>
			Reflect.apply(descriptor.value as CallableFunction, raw, args);
		let used = false;
		return async (): Promise<boolean> => {
			if (used) return false;
			used = true;
			const observation = await invokeAndObserve(() => bound(), CLOSE_TIMEOUT_MS);
			if (observation.status !== "fulfilled") return false;
			const result = exact(observation.value, CLOSE_RESULT_KEYS);
			return result?.status?.value === "closed";
		};
	} catch {
		return null;
	}
}

function snapshotPublisher(raw: unknown, close: OwnedClose): PublisherCapability | null {
	const descriptors = exact(raw, PUBLISHER_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const publish = method(descriptors, raw, "publish");
	return publish ? Object.freeze({ publish, close }) : null;
}

function snapshotRecovery(raw: unknown, close: OwnedClose): RecoveryCapability | null {
	const descriptors = exact(raw, RECOVERY_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const listPage = method(descriptors, raw, "listPage");
	const open = method(descriptors, raw, "open");
	return listPage && open ? Object.freeze({ listPage, open, close }) : null;
}

async function closeOwned(closes: readonly OwnedClose[]): Promise<boolean> {
	const tasks = [...new Set(closes)].map((close) => close());
	const results = await Promise.all(tasks);
	return results.every((closed) => closed);
}

function recoveryAdapter(capability: RecoveryCapability): B03Adapter {
	const normalize = (call: () => unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			void invokeAndObserve(call, OPERATION_TIMEOUT_MS).then((observation) => {
				if (observation.status === "fulfilled") resolve(observation.value);
				else reject(new Error("recovery operation failed"));
			});
		});
	return Object.freeze({
		listPage: (request: B03ListPageRequest): unknown => normalize(() => capability.listPage(request)),
		open: (request: B03OpenRequest): unknown => normalize(() => capability.open(request)),
	});
}

function receipt(sequence: number, bytes: Uint8Array): DurableReceipt {
	return Object.freeze({ sequence, size: bytes.byteLength, sha256: digest(bytes) });
}

function journalWithoutDigest(record: JournalRecordV1): Readonly<Record<string, unknown>> {
	return Object.freeze({
		version: record.version,
		journalSeq: record.journalSeq,
		direction: record.direction,
		hostId: record.hostId,
		generation: record.generation,
		sessionId: record.sessionId,
		recordedAt: record.recordedAt,
		envelope: record.envelope,
	});
}

function rebuildMemory(
	identity: DeliveryIdentity,
	direction: JournalDirection,
	journalDir: string,
	journals: readonly JournalRecordV1[],
	markers: readonly DeliveryMarkerV1[],
	recoveredTotalBytes: number,
): StoreMemory | null {
	const storedJournals: JournalStored[] = [];
	const storedMarkers: MarkerStored[] = [];
	const frames = new Map<string, FrameRecord>();
	let totalBytes = 0;
	for (const record of journals) {
		const encoded = encodeJournalRecordV1(journalWithoutDigest(record));
		if (!encoded.ok) return null;
		const recordReceipt = receipt(record.journalSeq, encoded.bytes);
		totalBytes += recordReceipt.size;
		erase(encoded.bytes);
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) return null;
		if (frames.has(record.envelope.frameId)) return null;
		storedJournals.push(Object.freeze({ record, receipt: recordReceipt }));
		frames.set(
			record.envelope.frameId,
			Object.freeze({
				record,
				envelopeDigest: record.envelopeDigest,
				journal: recordReceipt,
				pending: null,
				delivered: null,
			}),
		);
	}
	for (const marker of markers) {
		const encoded = encodeDeliveryMarkerV1(marker);
		if (!encoded.ok) return null;
		const markerReceipt = receipt(marker.indexSeq, encoded.bytes);
		totalBytes += markerReceipt.size;
		erase(encoded.bytes);
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) return null;
		const frame = frames.get(marker.frameId);
		if (!frame || frame.envelopeDigest !== marker.envelopeDigest || frame.journal.sequence !== marker.journalSeq) {
			return null;
		}
		if (marker.state === "pending") {
			if (frame.pending !== null || frame.delivered !== null) return null;
			frames.set(marker.frameId, Object.freeze({ ...frame, pending: markerReceipt }));
		} else {
			if (frame.pending === null || frame.delivered !== null) return null;
			frames.set(marker.frameId, Object.freeze({ ...frame, delivered: markerReceipt }));
		}
		storedMarkers.push(Object.freeze({ marker, receipt: markerReceipt }));
	}
	if (totalBytes !== recoveredTotalBytes) return null;
	const nextJournalSequence = journals.length === 0 ? 1 : journals[journals.length - 1].journalSeq + 1;
	const nextMarkerSequence = markers.length === 0 ? 1 : markers[markers.length - 1].indexSeq + 1;
	if (
		!Number.isSafeInteger(nextJournalSequence) ||
		!Number.isSafeInteger(nextMarkerSequence) ||
		nextJournalSequence > MAX_JOURNALS + 1 ||
		nextMarkerSequence > MAX_MARKERS + 1
	) {
		return null;
	}
	return Object.freeze({
		identity,
		direction,
		journalDir,
		journals: Object.freeze(storedJournals),
		markers: Object.freeze(storedMarkers),
		frames,
		nextJournalSequence,
		nextMarkerSequence,
		totalBytes,
	});
}

export class DurableRelayStore {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<DurableRelayStoreResult<void>> | null = null;
	private closed = false;
	private poisoned = false;

	private constructor(
		private memory: StoreMemory,
		private readonly journalPublisher: PublisherCapability,
		private readonly deliveryPublisher: PublisherCapability,
		private readonly recoveryBackend: RecoveryCapability,
	) {}

	static async create(raw: unknown): Promise<CreateDurableRelayStoreResult> {
		const preliminary = rawDescriptors(raw);
		const journalDescriptor = preliminary?.journalPublisher;
		const deliveryDescriptor = preliminary?.deliveryPublisher;
		const recoveryDescriptor = preliminary?.recoveryBackend;
		const journalRaw = journalDescriptor && "value" in journalDescriptor ? journalDescriptor.value : undefined;
		const deliveryRaw = deliveryDescriptor && "value" in deliveryDescriptor ? deliveryDescriptor.value : undefined;
		const recoveryRaw = recoveryDescriptor && "value" in recoveryDescriptor ? recoveryDescriptor.value : undefined;
		const descriptors = exact(raw, INPUT_KEYS);
		const closeCache = new Map<object, OwnedClose | null>();
		const captureClose = (candidate: unknown): OwnedClose | null => {
			if (typeof candidate !== "object" || candidate === null) return snapshotClose(candidate);
			const cached = closeCache.get(candidate);
			if (cached !== undefined || closeCache.has(candidate)) return cached ?? null;
			const captured = snapshotClose(candidate);
			closeCache.set(candidate, captured);
			return captured;
		};
		const journalClose = captureClose(journalRaw);
		const deliveryClose = captureClose(deliveryRaw);
		const recoveryClose = captureClose(recoveryRaw);
		const ownedCloses = [...new Set([journalClose, deliveryClose, recoveryClose])].filter(
			(close): close is OwnedClose => close !== null,
		);
		const failCreation = async (code: DurableRelayStoreErrorCode): Promise<CreateDurableRelayStoreResult> => {
			const closed = await closeOwned(ownedCloses);
			return failure(closed ? code : "CLOSE_UNCERTAIN");
		};
		if (
			!descriptors ||
			!journalClose ||
			!deliveryClose ||
			!recoveryClose ||
			journalRaw === deliveryRaw ||
			journalRaw === recoveryRaw ||
			deliveryRaw === recoveryRaw
		) {
			return await failCreation("INVALID_ARGUMENT");
		}
		const identity = snapshotIdentity(descriptors.identity.value);
		const direction = descriptors.direction.value;
		const journalDir = descriptors.journalDir.value;
		const journalPublisher = snapshotPublisher(journalRaw, journalClose);
		const deliveryPublisher = snapshotPublisher(deliveryRaw, deliveryClose);
		const recoveryBackend = snapshotRecovery(recoveryRaw, recoveryClose);
		if (
			!identity ||
			!validDirection(direction) ||
			typeof journalDir !== "string" ||
			journalDir.length < 1 ||
			journalDir.length > 4096 ||
			journalDir.includes("\0") ||
			!journalPublisher ||
			!deliveryPublisher ||
			!recoveryBackend
		) {
			return await failCreation("INVALID_ARGUMENT");
		}
		let recovered: Awaited<ReturnType<typeof recoverB03Directory>>;
		try {
			recovered = await recoverB03Directory(
				Object.freeze({ identity, direction, adapter: recoveryAdapter(recoveryBackend) }),
			);
		} catch {
			return await failCreation("RECOVERY_FAILED");
		}
		if (!recovered.ok) return await failCreation("RECOVERY_FAILED");
		const memory = rebuildMemory(
			identity,
			direction,
			journalDir,
			recovered.journals,
			recovered.markers,
			recovered.totalBytes,
		);
		if (!memory) return await failCreation("RECOVERY_FAILED");
		const store = new DurableRelayStore(memory, journalPublisher, deliveryPublisher, recoveryBackend);
		return Object.freeze({
			ok: true as const,
			store,
			status: Object.freeze({ identity, direction, totalBytes: memory.totalBytes }),
		});
	}

	publish(raw: unknown): Promise<DurableRelayStoreResult<DurableReceipt>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const input = this.snapshotJournalInput(raw);
		if (!input) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => this.publishJournal(input));
	}

	markPending(raw: unknown): Promise<DurableRelayStoreResult<DurableReceipt>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const input = this.snapshotMarkInput(raw);
		if (!input) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => this.publishMarker(input, "pending"));
	}

	markDelivered(raw: unknown): Promise<DurableRelayStoreResult<DurableReceipt>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const input = this.snapshotMarkInput(raw);
		if (!input) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => this.publishMarker(input, "delivered"));
	}

	query(frameId: unknown): Promise<DurableRelayStoreResult<DurableFrameState>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		if (!validId(frameId)) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => {
			const frame = this.memory.frames.get(frameId);
			if (!frame) return Promise.resolve(failure("NOT_FOUND"));
			const state: DeliveryState =
				frame.delivered !== null ? "delivered" : frame.pending !== null ? "pending" : "new";
			return Promise.resolve(
				success(
					Object.freeze({
						state,
						record: frame.record,
						journal: frame.journal,
						pending: frame.pending,
						delivered: frame.delivered,
					}),
				),
			);
		});
	}

	replayJournals(raw: unknown): Promise<DurableRelayStoreResult<DurableReplayPage<DurableJournalEntry>>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const input = this.snapshotReplayInput(raw, MAX_JOURNALS);
		if (!input) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => Promise.resolve(success(this.journalPage(input.cursor, input.maxCount))));
	}

	replayMarkers(raw: unknown): Promise<DurableRelayStoreResult<DurableReplayPage<DurableMarkerEntry>>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const input = this.snapshotReplayInput(raw, MAX_MARKERS);
		if (!input) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => Promise.resolve(success(this.markerPage(input.cursor, input.maxCount))));
	}

	close(): Promise<DurableRelayStoreResult<void>> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;
		this.closePromise = this.tail.then(
			() => this.closeCapabilities(),
			() => this.closeCapabilities(),
		);
		this.tail = this.closePromise.then(
			() => undefined,
			() => undefined,
		);
		return this.closePromise;
	}

	private enqueue<T>(operation: () => Promise<DurableRelayStoreResult<T>>): Promise<DurableRelayStoreResult<T>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const attempted = this.tail.then(
			() => {
				if (this.poisoned) return failure("POISONED");
				return operation();
			},
			() => {
				this.poisoned = true;
				return failure("POISONED");
			},
		);
		const result = attempted.then(
			(value) => value,
			() => {
				this.poisoned = true;
				return failure("POISONED");
			},
		);
		this.tail = result.then(() => undefined);
		return result;
	}

	private async closeCapabilities(): Promise<DurableRelayStoreResult<void>> {
		const closed = await closeOwned([
			this.journalPublisher.close,
			this.deliveryPublisher.close,
			this.recoveryBackend.close,
		]);
		return closed ? success(undefined) : failure("CLOSE_UNCERTAIN");
	}

	private snapshotJournalInput(raw: unknown): Readonly<Record<string, unknown>> | null {
		const descriptors = exact(raw, JOURNAL_INPUT_KEYS);
		if (!descriptors) return null;
		if (
			descriptors.version.value !== 1 ||
			descriptors.direction.value !== this.memory.direction ||
			descriptors.hostId.value !== this.memory.identity.hostId ||
			descriptors.generation.value !== this.memory.identity.generation ||
			descriptors.sessionId.value !== this.memory.identity.sessionId
		) {
			return null;
		}
		const encoded = encodeJournalRecordV1(
			Object.freeze({
				version: 1,
				journalSeq: 1,
				direction: descriptors.direction.value,
				hostId: descriptors.hostId.value,
				generation: descriptors.generation.value,
				sessionId: descriptors.sessionId.value,
				recordedAt: descriptors.recordedAt.value,
				envelope: descriptors.envelope.value,
			}),
		);
		if (!encoded.ok) return null;
		erase(encoded.bytes);
		return Object.freeze({
			version: 1,
			direction: encoded.record.direction,
			hostId: encoded.record.hostId,
			generation: encoded.record.generation,
			sessionId: encoded.record.sessionId,
			recordedAt: encoded.record.recordedAt,
			envelope: encoded.record.envelope,
		});
	}

	private snapshotMarkInput(raw: unknown): Readonly<{ frameId: string; recordedAt: string }> | null {
		const descriptors = exact(raw, MARK_INPUT_KEYS);
		const frameId = descriptors?.frameId?.value;
		const recordedAt = descriptors?.recordedAt?.value;
		if (!validId(frameId) || typeof recordedAt !== "string") return null;
		return Object.freeze({ frameId, recordedAt });
	}

	private snapshotReplayInput(
		raw: unknown,
		maxSequence: number,
	): Readonly<{ cursor: number | null; maxCount: number }> | null {
		const descriptors = exact(raw, REPLAY_INPUT_KEYS);
		const cursor = descriptors?.cursor?.value;
		const maxCount = descriptors?.maxCount?.value;
		if (cursor !== null && (!validSequence(cursor) || cursor > maxSequence + 1)) return null;
		if (
			typeof maxCount !== "number" ||
			!Number.isSafeInteger(maxCount) ||
			maxCount < 1 ||
			maxCount > PAGE_MAX_COUNT
		) {
			return null;
		}
		return Object.freeze({ cursor, maxCount });
	}

	private async publishJournal(
		input: Readonly<Record<string, unknown>>,
	): Promise<DurableRelayStoreResult<DurableReceipt>> {
		if (this.memory.nextJournalSequence > MAX_JOURNALS) return failure("COLLISION");
		let bytes: Uint8Array | null = null;
		let transferred = false;
		try {
			const encoded = encodeJournalRecordV1(
				Object.freeze({
					version: 1,
					journalSeq: this.memory.nextJournalSequence,
					direction: input.direction,
					hostId: input.hostId,
					generation: input.generation,
					sessionId: input.sessionId,
					recordedAt: input.recordedAt,
					envelope: input.envelope,
				}),
			);
			if (!encoded.ok) return failure("INVALID_ARGUMENT");
			bytes = encoded.bytes;
			const record = encoded.record;
			const existing = this.memory.frames.get(record.envelope.frameId);
			if (existing) {
				if (existing.envelopeDigest !== record.envelopeDigest) {
					this.poisoned = true;
					return failure("MISMATCH");
				}
				return success(existing.journal);
			}
			const nextTotal = this.memory.totalBytes + bytes.byteLength;
			if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_TOTAL_BYTES) {
				return failure("COLLISION");
			}
			const recordReceipt = receipt(record.journalSeq, bytes);
			let rawPromise: unknown;
			try {
				rawPromise = this.journalPublisher.publish(
					Object.freeze({
						journalDir: this.memory.journalDir,
						seq: record.journalSeq,
						bytes,
					}),
				);
				transferred = true;
			} catch {
				transferred = true;
				this.poisoned = true;
				return failure("UNCERTAIN");
			}
			const observation = await observePromise(rawPromise, OPERATION_TIMEOUT_MS);
			if (observation.status !== "fulfilled") {
				this.poisoned = true;
				return failure("UNCERTAIN");
			}
			const result = exact(observation.value, JOURNAL_RESULT_KEYS);
			if (
				!result ||
				result.status.value !== "success" ||
				result.seq.value !== recordReceipt.sequence ||
				result.size.value !== recordReceipt.size ||
				result.sha256.value !== recordReceipt.sha256
			) {
				this.poisoned = true;
				return failure(result?.status?.value === "success" ? "MISMATCH" : "UNCERTAIN");
			}
			const frames = new Map(this.memory.frames);
			frames.set(
				record.envelope.frameId,
				Object.freeze({
					record,
					envelopeDigest: record.envelopeDigest,
					journal: recordReceipt,
					pending: null,
					delivered: null,
				}),
			);
			this.memory = Object.freeze({
				...this.memory,
				journals: Object.freeze([...this.memory.journals, Object.freeze({ record, receipt: recordReceipt })]),
				frames,
				nextJournalSequence: record.journalSeq + 1,
				totalBytes: nextTotal,
			});
			return success(recordReceipt);
		} catch {
			this.poisoned = true;
			return failure("POISONED");
		} finally {
			if (!transferred) erase(bytes);
		}
	}

	private async publishMarker(
		input: Readonly<{ frameId: string; recordedAt: string }>,
		state: "pending" | "delivered",
	): Promise<DurableRelayStoreResult<DurableReceipt>> {
		const frame = this.memory.frames.get(input.frameId);
		if (!frame) return failure("NOT_FOUND");
		if (state === "pending" && frame.pending !== null) return success(frame.pending);
		if (state === "delivered" && frame.delivered !== null) return success(frame.delivered);
		if (state === "delivered" && frame.pending === null) return failure("COLLISION");
		if (this.memory.nextMarkerSequence > MAX_MARKERS) return failure("COLLISION");
		let bytes: Uint8Array | null = null;
		let transferred = false;
		try {
			const encoded = encodeDeliveryMarkerV1(
				Object.freeze({
					version: 1,
					hostId: this.memory.identity.hostId,
					generation: this.memory.identity.generation,
					sessionId: this.memory.identity.sessionId,
					direction: this.memory.direction,
					frameId: input.frameId,
					envelopeDigest: frame.envelopeDigest,
					journalSeq: frame.journal.sequence,
					indexSeq: this.memory.nextMarkerSequence,
					state,
					recordedAt: input.recordedAt,
				}),
			);
			if (!encoded.ok) return failure("INVALID_ARGUMENT");
			bytes = encoded.bytes;
			const marker = encoded.marker;
			const nextTotal = this.memory.totalBytes + bytes.byteLength;
			if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_TOTAL_BYTES) {
				return failure("COLLISION");
			}
			const markerReceipt = receipt(marker.indexSeq, bytes);
			let rawPromise: unknown;
			try {
				rawPromise = this.deliveryPublisher.publish(
					Object.freeze({
						journalDir: this.memory.journalDir,
						indexSeq: marker.indexSeq,
						bytes,
					}),
				);
				transferred = true;
			} catch {
				transferred = true;
				this.poisoned = true;
				return failure("UNCERTAIN");
			}
			const observation = await observePromise(rawPromise, OPERATION_TIMEOUT_MS);
			if (observation.status !== "fulfilled") {
				this.poisoned = true;
				return failure("UNCERTAIN");
			}
			const result = exact(observation.value, MARKER_RESULT_KEYS);
			if (
				!result ||
				result.status.value !== "success" ||
				result.sequence.value !== markerReceipt.sequence ||
				result.size.value !== markerReceipt.size ||
				result.sha256.value !== markerReceipt.sha256
			) {
				this.poisoned = true;
				return failure(result?.status?.value === "success" ? "MISMATCH" : "UNCERTAIN");
			}
			const frames = new Map(this.memory.frames);
			frames.set(
				input.frameId,
				Object.freeze({
					...frame,
					pending: state === "pending" ? markerReceipt : frame.pending,
					delivered: state === "delivered" ? markerReceipt : frame.delivered,
				}),
			);
			this.memory = Object.freeze({
				...this.memory,
				markers: Object.freeze([...this.memory.markers, Object.freeze({ marker, receipt: markerReceipt })]),
				frames,
				nextMarkerSequence: marker.indexSeq + 1,
				totalBytes: nextTotal,
			});
			return success(markerReceipt);
		} catch {
			this.poisoned = true;
			return failure("POISONED");
		} finally {
			if (!transferred) erase(bytes);
		}
	}

	private journalPage(cursor: number | null, maxCount: number): DurableReplayPage<DurableJournalEntry> {
		const startSequence = cursor ?? 1;
		const entries: DurableJournalEntry[] = [];
		let bytes = 0;
		let nextCursor: number | null = null;
		for (const stored of this.memory.journals) {
			if (stored.record.journalSeq < startSequence) continue;
			if (entries.length >= maxCount || bytes + stored.receipt.size > PAGE_MAX_BYTES) {
				nextCursor = stored.record.journalSeq;
				break;
			}
			entries.push(Object.freeze({ record: stored.record, receipt: stored.receipt }));
			bytes += stored.receipt.size;
		}
		return Object.freeze({ entries: Object.freeze(entries), nextCursor });
	}

	private markerPage(cursor: number | null, maxCount: number): DurableReplayPage<DurableMarkerEntry> {
		const startSequence = cursor ?? 1;
		const entries: DurableMarkerEntry[] = [];
		let bytes = 0;
		let nextCursor: number | null = null;
		for (const stored of this.memory.markers) {
			if (stored.marker.indexSeq < startSequence) continue;
			if (entries.length >= maxCount || bytes + stored.receipt.size > PAGE_MAX_BYTES) {
				nextCursor = stored.marker.indexSeq;
				break;
			}
			entries.push(Object.freeze({ marker: stored.marker, receipt: stored.receipt }));
			bytes += stored.receipt.size;
		}
		return Object.freeze({ entries: Object.freeze(entries), nextCursor });
	}
}

export async function createDurableRelayStore(raw: unknown): Promise<CreateDurableRelayStoreResult> {
	return await DurableRelayStore.create(raw);
}
