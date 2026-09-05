import { types } from "node:util";
import type { DeliveryIdentity, JournalDirection } from "./b03-delivery-index-codec.js";
import type { JournalRecordV1 } from "./b03-journal-record-codec.js";
import { type DurableReceipt, DurableRelayStore, type DurableRelayStoreResult } from "./durable-relay-store.js";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { canonicalDigest, decodeAgentMessageFrame, decodeEnvelope, digestsEqual } from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const ADMIT_INPUT_KEYS = new Set(["envelope"]);
const DISPATCHER_KEYS = new Set(["close", "ensure"]);
const ENSURE_RESULT_KEYS = new Set(["status"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const INPUT_KEYS = new Set([
	"deliveryPublisher",
	"dispatcher",
	"direction",
	"identity",
	"journalDir",
	"journalPublisher",
	"recoveryBackend",
]);

// ===========================================================================
// Error / result types
// ===========================================================================

export type TargetInboxErrorCode =
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "COLLISION"
	| "INVALID_ARGUMENT"
	| "MISMATCH"
	| "NOT_FOUND"
	| "POISONED"
	| "RECOVERY_FAILED"
	| "UNCERTAIN";

export type TargetInboxFailure = Readonly<{
	readonly ok: false;
	readonly error: Readonly<{ code: TargetInboxErrorCode }>;
}>;

export type TargetInboxResult<T> = Readonly<{ ok: true; value: T }> | TargetInboxFailure;

export interface AdmitReceipt {
	readonly status: "queued";
	readonly receipt: DurableReceipt;
	readonly frameId: string;
	readonly semanticId: string;
	readonly semanticDigest: string;
}

export interface EnsureResult {
	readonly status: "persisted" | "deferred";
}

export interface DispatcherCapability {
	readonly ensure: (raw: unknown) => Promise<EnsureResult>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface DurableTargetInboxStatus {
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	readonly admitted: number;
}

export type CreateDurableTargetInboxResult =
	| Readonly<{ ok: true; inbox: DurableTargetInbox; status: DurableTargetInboxStatus }>
	| TargetInboxFailure;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;

interface SemanticEntry {
	readonly frameId: string;
	readonly digest: string;
	readonly receipt: DurableReceipt;
}

interface NativePromiseObservation {
	readonly status: "fulfilled" | "rejected" | "timeout" | "invalid";
	readonly value?: unknown;
}

// ===========================================================================
// Result builders
// ===========================================================================

function failure(code: TargetInboxErrorCode): TargetInboxFailure {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function success<T>(value: T): TargetInboxResult<T> {
	return Object.freeze({ ok: true as const, value });
}

// ===========================================================================
// Validation helpers
// ===========================================================================

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
			if (settled) return;
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

// ===========================================================================
// Capability snapshot helpers
// ===========================================================================

function snapshotIdentity(raw: unknown): DeliveryIdentity | null {
	const descriptors = exact(raw, IDENTITY_KEYS);
	const hostId = descriptors?.hostId?.value;
	const generation = descriptors?.generation?.value;
	const sessionId = descriptors?.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

function snapshotDispatcherClose(raw: unknown): OwnedClose | null {
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
			const result = exact(observation.value, ENSURE_RESULT_KEYS);
			return result?.status?.value === "closed";
		};
	} catch {
		return null;
	}
}

function snapshotDispatcher(
	raw: unknown,
	ownClose: OwnedClose,
): Readonly<{
	ensure: BoundMethod;
	close: OwnedClose;
}> | null {
	const descriptors = exact(raw, DISPATCHER_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const ensure = method(descriptors, raw, "ensure");
	const close = ownClose;
	return ensure ? Object.freeze({ ensure, close }) : null;
}

// ===========================================================================
// Close helper — closeOwned returns true if ALL succeeded
// ===========================================================================

async function closeOwned(closes: readonly (() => Promise<boolean>)[]): Promise<boolean> {
	const results = await Promise.all(closes.map((c) => c().catch(() => false)));
	return results.every((ok) => ok);
}

// ===========================================================================
// DurableTargetInbox
// ===========================================================================

export class DurableTargetInbox {
	private operationTail: Promise<void> = Promise.resolve();
	private drainTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<TargetInboxResult<void>> | null = null;
	private closed = false;
	private poisoned = false;
	private started = false;
	private drainRequested = false;
	private drainRunning = false;
	private readonly semanticIndex = new Map<string, SemanticEntry>();
	private admittedCount: number;

	private constructor(
		private readonly store: DurableRelayStore,
		private readonly dispatcherEnsure: BoundMethod,
		private readonly dispatcherClose: OwnedClose,
		private readonly identity: DeliveryIdentity,
		admittedCount: number,
		semanticIndex: Map<string, SemanticEntry>,
	) {
		this.admittedCount = admittedCount;
		for (const [k, v] of semanticIndex) this.semanticIndex.set(k, v);
	}

	static async create(raw: unknown): Promise<CreateDurableTargetInboxResult> {
		// ---- Phase 1: preliminary extraction of ALL raw capability values ----
		// Extract before any validation so we can ALWAYS acquire/close caps.
		const preliminary = rawDescriptors(raw);
		const journalRaw =
			preliminary?.journalPublisher && "value" in preliminary.journalPublisher
				? preliminary.journalPublisher.value
				: undefined;
		const deliveryRaw =
			preliminary?.deliveryPublisher && "value" in preliminary.deliveryPublisher
				? preliminary.deliveryPublisher.value
				: undefined;
		const recoveryRaw =
			preliminary?.recoveryBackend && "value" in preliminary.recoveryBackend
				? preliminary.recoveryBackend.value
				: undefined;
		const dispatcherRaw =
			preliminary?.dispatcher && "value" in preliminary.dispatcher ? preliminary.dispatcher.value : undefined;
		// ---- Phase 2: invoke Store.create with candidate preliminary values ----
		// Always invoke first so publisher/recovery ownership is acquired before validation.
		const storePromise = DurableRelayStore.create(
			Object.freeze({
				deliveryPublisher: deliveryRaw,
				direction:
					preliminary?.direction && "value" in preliminary.direction ? preliminary.direction.value : undefined,
				identity: preliminary?.identity && "value" in preliminary.identity ? preliminary.identity.value : undefined,
				journalDir:
					preliminary?.journalDir && "value" in preliminary.journalDir ? preliminary.journalDir.value : undefined,
				journalPublisher: journalRaw,
				recoveryBackend: recoveryRaw,
			}),
		);

		// Snapshot the remaining input and dispatcher ownership before the first await.
		const descriptors = exact(raw, INPUT_KEYS);
		const direction = descriptors?.direction.value;
		const identity = snapshotIdentity(descriptors?.identity.value);
		const journalDir = descriptors?.journalDir.value;
		const dispatcherAliased =
			dispatcherRaw !== undefined &&
			(dispatcherRaw === journalRaw || dispatcherRaw === deliveryRaw || dispatcherRaw === recoveryRaw);
		const dispatcherClose = dispatcherAliased ? null : snapshotDispatcherClose(dispatcherRaw);
		const dispatcher = dispatcherClose ? snapshotDispatcher(dispatcherRaw, dispatcherClose) : null;
		const storeResult = await storePromise;

		// ---- Phase 3: register every independently acquired close ----
		const ownedCloses: (() => Promise<boolean>)[] = [];
		if (storeResult.ok) {
			const s = storeResult.store;
			ownedCloses.push(async () => {
				try {
					const r = await Reflect.apply(DurableRelayStore.prototype.close, s, []);
					return r.ok;
				} catch {
					return false;
				}
			});
		}
		if (dispatcherClose) ownedCloses.push(dispatcherClose);

		const finalize = async (code: TargetInboxErrorCode): Promise<CreateDurableTargetInboxResult> => {
			const closed = await closeOwned(ownedCloses);
			return closed ? failure(code) : failure("CLOSE_UNCERTAIN");
		};

		if (!storeResult.ok) {
			const code: TargetInboxErrorCode =
				storeResult.error.code === "CLOSE_UNCERTAIN"
					? "CLOSE_UNCERTAIN"
					: storeResult.error.code === "INVALID_ARGUMENT" || !dispatcherClose
						? "INVALID_ARGUMENT"
						: "RECOVERY_FAILED";
			return await finalize(code);
		}
		if (!dispatcherClose) return await finalize("INVALID_ARGUMENT");

		const store = storeResult.store;

		// ---- Phase 4: validate the synchronously captured input ----
		if (!descriptors || direction !== "received") return await finalize("INVALID_ARGUMENT");
		if (
			!identity ||
			typeof journalDir !== "string" ||
			journalDir.length < 1 ||
			journalDir.length > 4096 ||
			journalDir.includes("\0")
		) {
			return await finalize("INVALID_ARGUMENT");
		}

		if (!dispatcher) return await finalize("INVALID_ARGUMENT");

		// ---- Phase 5: replay journals for semantic index + recovery ----
		const allJournals: Array<{ record: JournalRecordV1; receipt: DurableReceipt }> = [];
		let cursor: number | null = null;
		for (;;) {
			const page = (await Reflect.apply(DurableRelayStore.prototype.replayJournals, store, [
				Object.freeze({ cursor, maxCount: 64 }),
			])) as DurableRelayStoreResult<unknown>;
			if (!page.ok) return await finalize(page.error.code);
			const pv = page.value as {
				entries: readonly { record: JournalRecordV1; receipt: DurableReceipt }[];
				nextCursor: number | null;
			};
			for (const entry of pv.entries) {
				allJournals.push({ record: entry.record, receipt: entry.receipt });
			}
			if (pv.nextCursor === null) break;
			cursor = pv.nextCursor;
		}

		const semanticIndex = new Map<string, SemanticEntry>();
		for (const { record, receipt } of allJournals) {
			if (record.envelope.frame.type !== "agent_message") return await finalize("RECOVERY_FAILED");
			const decoded = decodeAgentMessageFrame(record.envelope.frame);
			if (!decoded.ok) return await finalize("RECOVERY_FAILED");
			if (decoded.value.targetActiveSessionId !== identity.sessionId) return await finalize("RECOVERY_FAILED");
			const digestResult = canonicalDigest(decoded.value);
			if (!digestResult.ok) return await finalize("RECOVERY_FAILED");
			const semDigest = digestResult.value;
			const existing = semanticIndex.get(decoded.value.id);
			if (existing) {
				if (!digestsEqual(existing.digest, semDigest)) return await finalize("RECOVERY_FAILED");
				continue;
			}
			semanticIndex.set(
				decoded.value.id,
				Object.freeze({ frameId: record.envelope.frameId, digest: semDigest, receipt }),
			);
		}

		// ---- Phase 6: recover — mark every recovered new as pending ----
		for (const { record } of allJournals) {
			if (record.envelope.frame.type !== "agent_message") continue;
			const state = (await Reflect.apply(DurableRelayStore.prototype.query, store, [
				record.envelope.frameId,
			])) as DurableRelayStoreResult<unknown>;
			if (!state.ok) return await finalize(state.error.code);
			const sv = state.value as { state: "new" | "pending" | "delivered" };
			if (sv.state === "new") {
				const pending = (await Reflect.apply(DurableRelayStore.prototype.markPending, store, [
					Object.freeze({ frameId: record.envelope.frameId, recordedAt: record.recordedAt }),
				])) as DurableRelayStoreResult<unknown>;
				if (!pending.ok) return await finalize(pending.error.code);
			}
		}

		const inbox = new DurableTargetInbox(
			store,
			dispatcher.ensure,
			dispatcher.close,
			identity,
			allJournals.length,
			semanticIndex,
		);

		return Object.freeze({
			ok: true as const,
			inbox,
			status: Object.freeze({
				identity,
				direction: "received" as const,
				admitted: allJournals.length,
			}),
		});
	}
	// -----------------------------------------------------------------------
	// Admit — decodes envelope synchronously, then serialized
	// -----------------------------------------------------------------------

	admit(raw: unknown): Promise<TargetInboxResult<AdmitReceipt>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const d = exact(raw, ADMIT_INPUT_KEYS);
		if (!d) return Promise.resolve(failure("INVALID_ARGUMENT"));

		const decoded = decodeEnvelope(d.envelope.value);
		if (!decoded.ok) return Promise.resolve(failure("INVALID_ARGUMENT"));
		const envelope = decoded.value;
		if (envelope.frame.type !== "agent_message") return Promise.resolve(failure("INVALID_ARGUMENT"));

		const agentDecoded = decodeAgentMessageFrame(envelope.frame);
		if (!agentDecoded.ok) return Promise.resolve(failure("INVALID_ARGUMENT"));

		// bind target: require targetActiveSessionId === identity.sessionId
		if (agentDecoded.value.targetActiveSessionId !== this.identity.sessionId) {
			return Promise.resolve(failure("INVALID_ARGUMENT"));
		}

		const digestResult = canonicalDigest(agentDecoded.value);
		if (!digestResult.ok) return Promise.resolve(failure("INVALID_ARGUMENT"));

		const semId = agentDecoded.value.id;
		const semDigestLocal = digestResult.value;

		return this.enqueueOperation(() => this.admitOrdered(envelope, semId, semDigestLocal));
	}

	// -----------------------------------------------------------------------
	// Start — one-use, idempotent
	// -----------------------------------------------------------------------

	start(): void {
		if (this.closed || this.poisoned || this.started) return;
		this.started = true;
		this.requestDrain();
	}

	dispatchPending(): Promise<TargetInboxResult<void>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		if (this.poisoned) return Promise.resolve(failure("POISONED"));
		this.started = true;
		this.requestDrain();
		const pending = this.drainTail;
		return pending.then(
			() => {
				if (this.closed) return failure("CLOSED");
				return this.poisoned ? failure("POISONED") : success(undefined);
			},
			() => {
				this.poisoned = true;
				return failure("POISONED");
			},
		);
	}

	// -----------------------------------------------------------------------
	// Close
	//   1. closed=true (stop admission)
	//   2. Start dispatcher.close (settles pending ensures)
	//   3. Wait for operation+drain tails
	//   4. Close store
	// -----------------------------------------------------------------------

	close(): Promise<TargetInboxResult<void>> {
		if (this.closePromise !== null) return this.closePromise;

		let resolveClose: (result: TargetInboxResult<void>) => void = () => undefined;
		const shared = new Promise<TargetInboxResult<void>>((resolve) => {
			resolveClose = resolve;
		});
		this.closePromise = shared;
		this.closed = true;

		const operationTail = this.operationTail;
		const drainTail = this.drainTail;
		let dispatcherClose: Promise<boolean>;
		try {
			dispatcherClose = this.dispatcherClose();
		} catch {
			dispatcherClose = Promise.resolve(false);
		}
		void this.finishClose(operationTail, drainTail, dispatcherClose, resolveClose);

		this.operationTail = shared.then(() => undefined);
		this.drainTail = shared.then(() => undefined);
		return shared;
	}

	private async finishClose(
		operationTail: Promise<void>,
		drainTail: Promise<void>,
		dispatcherClose: Promise<boolean>,
		resolve: (result: TargetInboxResult<void>) => void,
	): Promise<void> {
		let tailsOk = true;
		try {
			await Promise.all([operationTail, drainTail]);
		} catch {
			tailsOk = false;
		}
		let dispatcherOk = false;
		try {
			dispatcherOk = await dispatcherClose;
		} catch {
			dispatcherOk = false;
		}
		let storeOk = false;
		try {
			const result = await Reflect.apply(DurableRelayStore.prototype.close, this.store, []);
			storeOk = result.ok;
		} catch {
			storeOk = false;
		}
		resolve(tailsOk && dispatcherOk && storeOk ? success(undefined) : failure("CLOSE_UNCERTAIN"));
	}

	get status(): DurableTargetInboxStatus {
		return Object.freeze({
			identity: this.identity,
			direction: "received",
			admitted: this.admittedCount,
		});
	}

	// =======================================================================
	// Operation serialization
	// =======================================================================

	private enqueueOperation<T>(operation: () => Promise<TargetInboxResult<T>>): Promise<TargetInboxResult<T>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const attempted = this.operationTail.then(
			() => (this.poisoned ? failure("POISONED") : operation()),
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
		this.operationTail = result.then(() => undefined);
		return result;
	}

	// =======================================================================
	// Drain scheduler — coalesced, cursor-advancing, started-guarded
	// =======================================================================

	private requestDrain(): void {
		if (this.closed || this.poisoned || !this.started) return;
		if (this.drainRequested) return;
		this.drainRequested = true;
		if (this.drainRunning) return;
		this.drainRunning = true;
		const run = this.drainTail.then(() => this.runDrain());
		this.drainTail = run.then(
			() => undefined,
			() => {
				this.poisoned = true;
				this.drainRunning = false;
			},
		);
	}

	private async runDrain(): Promise<void> {
		for (;;) {
			this.drainRequested = false;
			let cursor: number | null = null;

			for (;;) {
				if (this.closed || this.poisoned) {
					this.drainRunning = false;
					return;
				}
				const page = (await Reflect.apply(DurableRelayStore.prototype.replayJournals, this.store, [
					Object.freeze({ cursor, maxCount: 64 }),
				])) as DurableRelayStoreResult<unknown>;
				if (!page.ok) {
					this.poisoned = true;
					this.drainRunning = false;
					return;
				}
				const pv = page.value as {
					entries: readonly { record: JournalRecordV1; receipt: DurableReceipt }[];
					nextCursor: number | null;
				};

				for (const entry of pv.entries) {
					if (this.closed || this.poisoned) {
						this.drainRunning = false;
						return;
					}
					await this.dispatchOne(entry.record, entry.receipt);
				}

				if (pv.nextCursor === null) break;
				cursor = pv.nextCursor;
			}

			if (!this.drainRequested) break;
		}
		this.drainRunning = false;
	}

	// =======================================================================
	// Dispatch one record
	// =======================================================================

	private async dispatchOne(record: JournalRecordV1, _receipt: DurableReceipt): Promise<void> {
		if (record.envelope.frame.type !== "agent_message") {
			this.poisoned = true;
			return;
		}

		const decoded = decodeAgentMessageFrame(record.envelope.frame);
		if (!decoded.ok || decoded.value.targetActiveSessionId !== this.identity.sessionId) {
			this.poisoned = true;
			return;
		}
		const digestResult = canonicalDigest(decoded.value);
		if (!digestResult.ok) {
			this.poisoned = true;
			return;
		}
		const semDigest = digestResult.value;

		const state = (await Reflect.apply(DurableRelayStore.prototype.query, this.store, [
			record.envelope.frameId,
		])) as DurableRelayStoreResult<unknown>;
		if (!state.ok) {
			this.poisoned = true;
			return;
		}
		const sv = state.value as { state: "new" | "pending" | "delivered" };

		if (sv.state === "delivered") {
			await this.callEnsure(record, semDigest);
			return;
		}

		if (sv.state === "new") {
			const pending = (await Reflect.apply(DurableRelayStore.prototype.markPending, this.store, [
				Object.freeze({ frameId: record.envelope.frameId, recordedAt: record.recordedAt }),
			])) as DurableRelayStoreResult<unknown>;
			if (!pending.ok) {
				this.poisoned = true;
				return;
			}
		}

		await this.callEnsure(record, semDigest);
	}

	private async callEnsure(record: JournalRecordV1, semDigest: string): Promise<void> {
		const observed = await invokeAndObserve(
			() => this.dispatcherEnsure(Object.freeze({ envelope: record.envelope, semanticDigest: semDigest })),
			OPERATION_TIMEOUT_MS,
		);

		if (observed.status === "invalid" || observed.status === "rejected" || observed.status === "timeout") {
			this.poisoned = true;
			return;
		}

		const result = exact(observed.value, ENSURE_RESULT_KEYS);
		if (!result || (result.status.value !== "persisted" && result.status.value !== "deferred")) {
			this.poisoned = true;
			return;
		}

		if (result.status.value === "deferred") return;

		const current = (await Reflect.apply(DurableRelayStore.prototype.query, this.store, [
			record.envelope.frameId,
		])) as DurableRelayStoreResult<unknown>;
		if (!current.ok) {
			this.poisoned = true;
			return;
		}
		const cv = current.value as { state: "new" | "pending" | "delivered" };
		if (cv.state === "delivered") return;

		const delivered = (await Reflect.apply(DurableRelayStore.prototype.markDelivered, this.store, [
			Object.freeze({ frameId: record.envelope.frameId, recordedAt: record.recordedAt }),
		])) as DurableRelayStoreResult<unknown>;
		if (!delivered.ok) this.poisoned = true;
	}

	// =======================================================================
	// Admit internal (runs inside operation tail)
	// =======================================================================

	private async admitOrdered(
		envelope: RemoteHostFrameEnvelope,
		semanticId: string,
		semDigest: string,
	): Promise<TargetInboxResult<AdmitReceipt>> {
		const existing = this.semanticIndex.get(semanticId);
		if (existing) {
			if (!digestsEqual(existing.digest, semDigest)) {
				this.poisoned = true;
				return failure("MISMATCH");
			}
			if (this.started) this.requestDrain();
			return success(
				Object.freeze({
					status: "queued" as const,
					receipt: existing.receipt,
					frameId: envelope.frameId,
					semanticId,
					semanticDigest: semDigest,
				}),
			);
		}

		const published = (await Reflect.apply(DurableRelayStore.prototype.publish, this.store, [
			Object.freeze({
				version: 1,
				direction: "received",
				hostId: this.identity.hostId,
				generation: this.identity.generation,
				sessionId: this.identity.sessionId,
				recordedAt: envelope.sentAt,
				envelope,
			}),
		])) as DurableRelayStoreResult<unknown>;
		if (!published.ok) {
			const code = published.error.code;
			if (code === "UNCERTAIN" || code === "POISONED" || code === "MISMATCH") {
				this.poisoned = true;
			}
			return failure(code);
		}
		const journalReceipt = published.value as DurableReceipt;

		const pending = (await Reflect.apply(DurableRelayStore.prototype.markPending, this.store, [
			Object.freeze({ frameId: envelope.frameId, recordedAt: envelope.sentAt }),
		])) as DurableRelayStoreResult<unknown>;
		if (!pending.ok) {
			this.poisoned = true;
			return failure(pending.error.code);
		}

		this.semanticIndex.set(
			semanticId,
			Object.freeze({ frameId: envelope.frameId, digest: semDigest, receipt: journalReceipt }),
		);
		this.admittedCount += 1;

		if (this.started) this.requestDrain();

		return success(
			Object.freeze({
				status: "queued" as const,
				receipt: journalReceipt,
				frameId: envelope.frameId,
				semanticId,
				semanticDigest: semDigest,
			}),
		);
	}
}

export async function createDurableTargetInbox(raw: unknown): Promise<CreateDurableTargetInboxResult> {
	return await DurableTargetInbox.create(raw);
}
