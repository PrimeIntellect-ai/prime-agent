/**
 * SandboxEventOutboxStore -- restart-durable event outbox for sandbox sessions.
 *
 * Uses a dedicated .b14-event-outbox journal directory (NOT B03 relay).
 * Events are journaled as pending records before transport send, then marked
 * delivered with exact ACK.  Recovery never re-sends delivered events.
 *
 * Design (mirrors DurableProviderCallStore structure):
 *  - Created through createSandboxEventOutboxStore() which returns a
 *    frozen exact capability object with own enumerable data methods.
 *  - Factory integrates recoverSandboxEventOutboxJournal internally.
 *  - Preliminary-acquires publisher.close before unrelated validation;
 *    cleanup returns CLOSE_UNCERTAIN and is never swallowed.
 *  - FIFO serialized operations via tail Promise chain.
 *  - Reentry protection via narrow flag around synchronous Reflect.apply.
 *  - All returned DTOs are deeply frozen; caller inputs never retained.
 *  - Encoded codec records used in index; actual publisher receipts stored.
 *  - No casts, no any, no dynamic imports, no sync fs.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { DurableReceipt } from "./provider-call-record-codec.js";
import type { RemoteHostAckFrame, RemoteHostEventFrame } from "./remote-agent-host-protocol.js";
import { canonicalDigest, decodeAckFrame, decodeEventFrame, isValidDigest } from "./remote-host-frame-codec.js";
import type {
	SandboxEventOutboxDeliveredRecordV1,
	SandboxEventOutboxPendingRecordV1,
	SandboxEventOutboxRecordV1,
} from "./sandbox-event-outbox-record-codec.js";
import {
	decodeSandboxEventOutboxRecordV1,
	encodeSandboxEventOutboxRecordV1,
} from "./sandbox-event-outbox-record-codec.js";
import { type EventOutboxIdentity, recoverSandboxEventOutboxJournal } from "./sandbox-event-outbox-recovery.js";
import type {
	EventOutboxDeliveredReceipt,
	EventOutboxEnqueueReceipt,
	EventOutboxErrorCode,
	EventOutboxEventState,
	EventOutboxReplayPage,
	EventOutboxResult,
	EventOutboxStoreStatus,
	SandboxEventOutboxStoreCapability,
} from "./sandbox-event-outbox-store-types.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_RECOVERY_TOTAL_BYTES = 268_435_456; // 256 MiB
const FILE_MAX_BYTES = 1_310_720; // 1.25 MiB
const RELAY_SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const EVENT_KEYS = new Set(["type", "id", "sequence", "cursor", "emittedAt", "body"]);
const CURSOR_KEYS = new Set(["hostId", "generation", "sessionId", "sequence"]);
const ACK_KEYS = new Set(["type", "ackId", "acknowledges", "status", "rejectReason"]);
const IDENTITY_KEYS = new Set(["hostId", "generation", "sessionId"]);
const _PUBLISHER_KEYS = new Set(["publish", "close"]);

// ===========================================================================
// Typed literal constants
// ===========================================================================

const v1: 1 = 1;
const pendingKind: "pending" = "pending";
const deliveredKind: "delivered" = "delivered";
const deliveredOutcome: "DELIVERED" = "DELIVERED";
const ownerStatus: "owner" = "owner";
const pendingState: "pending" = "pending";
const deliveredState: "delivered" = "delivered";

// ===========================================================================
// Result helpers
// ===========================================================================

function okValue<T>(value: T): EventOutboxResult<T> {
	return Object.freeze({
		ok: true,
		value: typeof value === "object" && value !== null ? Object.freeze(value) : value,
	});
}

function errValue(code: EventOutboxErrorCode): EventOutboxResult<never> {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function publicArgValue(): EventOutboxResult<never> {
	return errValue("INVALID_ARGUMENT");
}

// ===========================================================================
// Fresh DTO copy helpers -- typed per-kind, no generic cast
// ===========================================================================

function freshDurableReceipt(raw: DurableReceipt): DurableReceipt {
	return Object.freeze({
		sequence: raw.sequence,
		size: raw.size,
		sha256: raw.sha256,
	});
}

function freshEventFrame(raw: RemoteHostEventFrame): RemoteHostEventFrame | null {
	// Re-decode through the codec to get a truly fresh independent copy
	// Returns null if codec fails (caller must handle as invariant failure)
	const rawObj: Record<string, unknown> = {
		type: raw.type,
		id: raw.id,
		sequence: raw.sequence,
		cursor: {
			hostId: raw.cursor.hostId,
			generation: raw.cursor.generation,
			sessionId: raw.cursor.sessionId,
			sequence: raw.cursor.sequence,
		},
		emittedAt: raw.emittedAt,
		body: raw.body,
	};
	const result = decodeEventFrame(rawObj);
	if (!result.ok) return null;
	// Deep freeze the decoded result since decodeEventFrame may not freeze nested values
	_deepFreezeRecord(result.value);
	return result.value;
}

function freshAckFrame(raw: RemoteHostAckFrame): RemoteHostAckFrame | null {
	const rawObject: Record<string, unknown> = {
		type: raw.type,
		ackId: raw.ackId,
		acknowledges: raw.acknowledges,
		status: raw.status,
	};
	if (raw.rejectReason !== undefined) rawObject.rejectReason = raw.rejectReason;
	const decoded = decodeAckFrame(rawObject);
	if (!decoded.ok) return null;
	_deepFreezeRecord(decoded.value);
	return decoded.value;
}

function freshEnqueueReceipt(
	receipt: DurableReceipt,
	eventId: string,
	eventDigest: string,
	eventSequence: number,
): EventOutboxEnqueueReceipt {
	return Object.freeze({
		receipt: freshDurableReceipt(receipt),
		eventId,
		eventDigest,
		eventSequence,
	});
}

function freshDeliveredReceipt(
	receipt: DurableReceipt,
	eventId: string,
	ackDigest: string,
	eventSequence: number,
): EventOutboxDeliveredReceipt {
	return Object.freeze({
		receipt: freshDurableReceipt(receipt),
		eventId,
		ackDigest,
		eventSequence,
	});
}

// ===========================================================================
// TypedArray intrinsic captures (same pattern as durable-provider-call-store)
// ===========================================================================

const _taProto = Object.getPrototypeOf(Uint8Array.prototype);
const _byteLengthGetter: (() => number) | undefined = Object.getOwnPropertyDescriptor(_taProto, "byteLength")?.get;
const _byteOffsetGetter: (() => number) | undefined = Object.getOwnPropertyDescriptor(_taProto, "byteOffset")?.get;
const _bufferGetter: (() => ArrayBuffer | SharedArrayBuffer) | undefined = Object.getOwnPropertyDescriptor(
	_taProto,
	"buffer",
)?.get;
const _abProto = Object.getPrototypeOf(ArrayBuffer.prototype);
const _abByteLengthGetter: (() => number) | undefined = Object.getOwnPropertyDescriptor(_abProto, "byteLength")?.get;
const _taFill: typeof Uint8Array.prototype.fill | undefined = _taProto.fill;

function eraseKnownOwned(bytes: Uint8Array): void {
	try {
		if (!_byteLengthGetter || !_taFill) return;
		const len = Reflect.apply(_byteLengthGetter, bytes, []);
		if (typeof len === "number" && len > 0) {
			Reflect.apply(_taFill, bytes, [0]);
		}
	} catch {
		// detached -- suppression is the contract
	}
}

function digestSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// ===========================================================================
// Injected publisher capability types
// ===========================================================================

export interface EventOutboxPublishOk {
	readonly ok: true;
	readonly receipt: DurableReceipt;
}

export interface EventOutboxPublisher {
	readonly publish: (seq: number, bytes: Uint8Array) => Promise<EventOutboxPublishOutcome>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type EventOutboxPublishOutcome =
	| EventOutboxPublishOk
	| Readonly<{
			ok: false;
			error: "IO_UNCONFIRMED" | "SEQ_COLLISION" | "POST_PUBLICATION_UNCERTAIN" | "INVALID_ARGUMENT";
	  }>;

// ===========================================================================
// Internal index types
// ===========================================================================

interface PendingEntry {
	readonly eventId: string;
	readonly eventDigest: string;
	readonly eventSequence: number;
	readonly pendingRecord: SandboxEventOutboxPendingRecordV1;
	readonly pendingReceipt: DurableReceipt;
	deliveredRecord: SandboxEventOutboxDeliveredRecordV1 | null;
	deliveredReceipt: DurableReceipt | null;
	computedState: "pending" | "delivered";
}

interface RecoveredIndex {
	readonly byEventId: ReadonlyMap<string, PendingEntry>;
	readonly pendingEventIds: readonly string[];
	readonly nextJournalSeq: number;
	readonly totalBytes: number;
	readonly nextEventSequence: number;
}

// ===========================================================================
// Own-data descriptor extraction
// ===========================================================================

function exactDescriptors(
	raw: unknown,
	allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, PropertyDescriptor>> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== allowedKeys.size) return null;
		for (const name of names) {
			if (!allowedKeys.has(name)) return null;
		}
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const d = descs[name];
			if (!d || !d.enumerable || !("value" in d)) return null;
		}
		return descs;
	} catch {
		return null;
	}
}

function safeId(raw: unknown): raw is string {
	return typeof raw === "string" && RELAY_SAFE_ID_RE.test(raw);
}

function safeTimestamp(raw: unknown): raw is string {
	if (typeof raw !== "string" || !CANONICAL_UTC_RE.test(raw)) return false;
	try {
		return new Date(raw).toISOString() === raw;
	} catch {
		return false;
	}
}

// ===========================================================================
// Dense array validation
// ===========================================================================

function validateDenseArray(raw: unknown): readonly unknown[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Array.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		const lenDesc = Object.getOwnPropertyDescriptor(raw, "length");
		if (!lenDesc || !("value" in lenDesc)) return null;
		const len = lenDesc.value;
		if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0 || len > 20_000) return null;
		if (lenDesc.configurable !== false || lenDesc.enumerable !== false) return null;
		const ownNames = Object.getOwnPropertyNames(raw);
		if (ownNames.length !== len + 1) return null;
		const values: unknown[] = new Array<unknown>(len);
		for (let i = 0; i < len; i++) {
			const name = String(i);
			if (ownNames[i] !== name) return null;
			const d = descs[name];
			if (!d || d.enumerable !== true || !("value" in d)) return null;
			values[i] = d.value;
		}
		return Object.freeze(values);
	} catch {
		return null;
	}
}

// ===========================================================================
// Publisher bound method acquisition
// ===========================================================================

interface BoundPublisher {
	readonly close: () => unknown;
	readonly publish: (seq: number, bytes: Uint8Array) => unknown;
}

function acquirePublisher(raw: unknown): BoundPublisher | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== 2) return null;
		if (!names.includes("publish") || !names.includes("close")) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		const publishDesc = descs.publish;
		const closeDesc = descs.close;
		if (!publishDesc || !publishDesc.enumerable || !("value" in publishDesc)) return null;
		if (!closeDesc || !closeDesc.enumerable || !("value" in closeDesc)) return null;
		const publishFn = publishDesc.value;
		const closeFn = closeDesc.value;
		if (typeof publishFn !== "function" || typeof closeFn !== "function") return null;
		if (types.isProxy(publishFn) || types.isProxy(closeFn)) return null;
		return Object.freeze({
			publish(seq: number, bytes: Uint8Array): unknown {
				return Reflect.apply(publishFn, raw, [seq, bytes]);
			},
			close(): unknown {
				return Reflect.apply(closeFn, raw, []);
			},
		});
	} catch {
		return null;
	}
}

// ===========================================================================
// Promise observation helpers
// ===========================================================================

async function observePublisherPublish(rawResult: unknown): Promise<EventOutboxPublishOutcome> {
	const observed = await observeExactNativePromise(rawResult);
	if (!observed.ok) return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });

	const successCheck = exactDescriptors(observed.value, new Set(["ok", "receipt"]));
	if (successCheck !== null) {
		const okVal = successCheck.ok?.value;
		if (okVal === true) {
			const receiptRaw = successCheck.receipt?.value;
			const receipt = decodeDurableReceipt(receiptRaw);
			if (receipt !== null) return Object.freeze({ ok: true, receipt });
		}
	}

	const failureCheck = exactDescriptors(observed.value, new Set(["ok", "error"]));
	if (failureCheck !== null) {
		const okVal = failureCheck.ok?.value;
		if (okVal === false) {
			const errStr = failureCheck.error?.value;
			if (
				errStr === "IO_UNCONFIRMED" ||
				errStr === "SEQ_COLLISION" ||
				errStr === "POST_PUBLICATION_UNCERTAIN" ||
				errStr === "INVALID_ARGUMENT"
			) {
				return Object.freeze({ ok: false, error: errStr });
			}
		}
	}

	return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
}

async function observePublisherClose(rawResult: unknown): Promise<Readonly<{ status: "closed" | "error" }>> {
	const observed = await observeExactNativePromise(rawResult);
	if (!observed.ok) return Object.freeze({ status: "error" });
	const d = exactDescriptors(observed.value, new Set(["status"]));
	if (d === null) return Object.freeze({ status: "error" });
	const st = d.status?.value;
	if (st === "closed" || st === "error") return Object.freeze({ status: st });
	return Object.freeze({ status: "error" });
}

function observeExactNativePromise(raw: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
	return new Promise((resolve) => {
		if (typeof raw !== "object" || raw === null) {
			resolve({ ok: false });
			return;
		}
		try {
			if (types.isProxy(raw)) {
				resolve({ ok: false });
				return;
			}
		} catch {
			resolve({ ok: false });
			return;
		}
		if (Object.getPrototypeOf(raw) !== Promise.prototype) {
			resolve({ ok: false });
			return;
		}
		if (Object.getOwnPropertyNames(raw).length > 0) {
			resolve({ ok: false });
			return;
		}
		if (Object.getOwnPropertySymbols(raw).length > 0) {
			resolve({ ok: false });
			return;
		}
		if (!types.isPromise(raw)) {
			resolve({ ok: false });
			return;
		}
		const timer = setTimeout(() => {
			resolve({ ok: false });
		}, 30_000);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(v: unknown) => {
					clearTimeout(timer);
					resolve({ ok: true, value: v });
				},
				() => {
					clearTimeout(timer);
					resolve({ ok: false });
				},
			]);
		} catch {
			clearTimeout(timer);
			resolve({ ok: false });
		}
	});
}

function decodeDurableReceipt(raw: unknown): DurableReceipt | null {
	const d = exactDescriptors(raw, new Set(["sequence", "size", "sha256"]));
	if (d === null) return null;
	const seq = d.sequence?.value;
	const size = d.size?.value;
	const sha = d.sha256?.value;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > MAX_JOURNAL_SEQ) return null;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > FILE_MAX_BYTES) return null;
	if (typeof sha !== "string" || !isValidDigest(sha)) return null;
	return Object.freeze({ sequence: seq, size, sha256: sha });
}

// ===========================================================================
// Input normalization helpers
// ===========================================================================

function snapshotNormalizedObject(
	raw: unknown,
	allowedKeys: ReadonlySet<string>,
	exactCount: number | null,
): Record<string, unknown> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
	} catch {
		return undefined;
	}
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

	const out: Record<string, unknown> = {};
	for (const k of keys) {
		if (!allowedKeys.has(k)) return undefined;
		const desc = descs[k];
		if (desc.get || desc.set) return undefined;
		if (!desc.enumerable) return undefined;
		const v = desc.value;
		if (v === undefined) return undefined;
		out[k] = v;
	}
	return out;
}

function normalizeEventFrame(raw: unknown): RemoteHostEventFrame | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
	} catch {
		return undefined;
	}
	const obj = snapshotNormalizedObject(raw, EVENT_KEYS, 6);
	if (obj === undefined) return undefined;

	const typeVal = obj.type;
	if (typeVal !== "event") return undefined;
	const idVal = obj.id;
	if (typeof idVal !== "string" || !RELAY_SAFE_ID_RE.test(idVal)) return undefined;
	const seqVal = obj.sequence;
	if (typeof seqVal !== "number" || !Number.isSafeInteger(seqVal) || seqVal <= 0) return undefined;
	const emittedAt = obj.emittedAt;
	if (typeof emittedAt !== "string") return undefined;

	// Normalize cursor
	const cursorRaw = obj.cursor;
	const cursorObj = snapshotNormalizedObject(cursorRaw, CURSOR_KEYS, 4);
	if (cursorObj === undefined) return undefined;
	const cursorHostId = cursorObj.hostId;
	const cursorGeneration = cursorObj.generation;
	const cursorSessionId = cursorObj.sessionId;
	const cursorSequence = cursorObj.sequence;
	if (typeof cursorHostId !== "string" || !RELAY_SAFE_ID_RE.test(cursorHostId)) return undefined;
	if (typeof cursorGeneration !== "string" || !RELAY_SAFE_ID_RE.test(cursorGeneration)) return undefined;
	if (typeof cursorSessionId !== "string" || !RELAY_SAFE_ID_RE.test(cursorSessionId)) return undefined;
	if (typeof cursorSequence !== "number" || !Number.isSafeInteger(cursorSequence) || cursorSequence <= 0)
		return undefined;

	const safeCursor = Object.freeze({
		hostId: cursorHostId,
		generation: cursorGeneration,
		sessionId: cursorSessionId,
		sequence: cursorSequence,
	});

	// Pre-validate body: reject Proxy, accessor, non-enumerable, symbol, custom/null prototype
	// before any live property read inside decodeEventFrame.
	// decodeEventBody alone does not reject transparent Proxy bodies.
	const bodyRaw = obj.body;
	if (typeof bodyRaw !== "object" || bodyRaw === null || Array.isArray(bodyRaw)) return undefined;
	let bodyIsProxy = false;
	try {
		bodyIsProxy = types.isProxy(bodyRaw);
	} catch {
		return undefined;
	}
	if (bodyIsProxy) return undefined;
	let bodyProto: object | null;
	try {
		bodyProto = Object.getPrototypeOf(bodyRaw);
	} catch {
		return undefined;
	}
	if (bodyProto !== Object.prototype) return undefined;
	let bodyDescs: PropertyDescriptorMap;
	try {
		bodyDescs = Object.getOwnPropertyDescriptors(bodyRaw);
	} catch {
		return undefined;
	}
	let bodyKeys: string[];
	try {
		bodyKeys = Object.getOwnPropertyNames(bodyRaw);
	} catch {
		return undefined;
	}
	let bodySymbols: symbol[];
	try {
		bodySymbols = Object.getOwnPropertySymbols(bodyRaw);
	} catch {
		return undefined;
	}
	if (bodySymbols.length > 0) return undefined;
	for (const k of bodyKeys) {
		const desc = bodyDescs[k];
		if (desc.get || desc.set) return undefined;
		if (!desc.enumerable) return undefined;
		if (desc.value === undefined) return undefined;
	}
	const safeBody: Record<string, unknown> = {};
	for (const k of bodyKeys) {
		const desc = bodyDescs[k];
		safeBody[k] = desc.value;
	}

	const eventInput = {
		type: "event",
		id: idVal,
		sequence: seqVal,
		cursor: safeCursor,
		emittedAt,
		body: safeBody,
	};
	const decoded = decodeEventFrame(eventInput);
	if (!decoded.ok) return undefined;
	const frame = decoded.value;

	return frame;
}

function normalizeAckFrame(raw: unknown): RemoteHostAckFrame | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
	} catch {
		return undefined;
	}
	// Allow 4 or 5 keys (with optional rejectReason)
	const obj = snapshotNormalizedObject(raw, ACK_KEYS, null);
	if (obj === undefined) return undefined;
	const typeVal = obj.type;
	if (typeVal !== "ack") return undefined;
	const ackId = obj.ackId;
	if (typeof ackId !== "string" || !RELAY_SAFE_ID_RE.test(ackId)) return undefined;
	const acknowledges = obj.acknowledges;
	if (typeof acknowledges !== "string" || !RELAY_SAFE_ID_RE.test(acknowledges)) return undefined;
	const statusVal = obj.status;
	if (statusVal !== "delivered" && statusVal !== "replayed" && statusVal !== "rejected") return undefined;

	const ackInput: Record<string, unknown> = {
		type: "ack",
		ackId,
		acknowledges,
		status: statusVal,
	};
	// Optional rejectReason -- only include if present and non-null
	if (obj.rejectReason !== undefined) {
		const rr = obj.rejectReason;
		if (typeof rr !== "string") return undefined;
		ackInput.rejectReason = rr;
	}

	const decoded = decodeAckFrame(ackInput);
	if (!decoded.ok) return undefined;
	return decoded.value;
}

function _deepFreezeRecord<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			_deepFreezeRecord(value[i]);
		}
		if (!Object.isFrozen(value)) Object.freeze(value);
		return value;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		if (!Object.isFrozen(value)) Object.freeze(value);
		return value;
	}
	const keys = Object.getOwnPropertyNames(value);
	for (const k of keys) {
		const desc = Object.getOwnPropertyDescriptor(value, k);
		if (desc && typeof desc.value === "object" && desc.value !== null) {
			_deepFreezeRecord(desc.value);
		}
	}
	if (!Object.isFrozen(value)) Object.freeze(value);
	return value;
}

// ===========================================================================
// sharesPublisherOwner -- detect same close function
// ===========================================================================
function sharesPublisherOwner(publisher: unknown, recoveryBackend: unknown): boolean {
	if (publisher === recoveryBackend) return true;
	if (
		typeof publisher !== "object" ||
		publisher === null ||
		typeof recoveryBackend !== "object" ||
		recoveryBackend === null
	) {
		return false;
	}
	try {
		if (types.isProxy(publisher) || types.isProxy(recoveryBackend)) return false;
		const publisherClose = Object.getOwnPropertyDescriptor(publisher, "close");
		const recoveryClose = Object.getOwnPropertyDescriptor(recoveryBackend, "close");
		if (
			!publisherClose ||
			!("value" in publisherClose) ||
			!publisherClose.enumerable ||
			typeof publisherClose.value !== "function" ||
			types.isProxy(publisherClose.value) ||
			!recoveryClose ||
			!("value" in recoveryClose) ||
			!recoveryClose.enumerable ||
			typeof recoveryClose.value !== "function" ||
			types.isProxy(recoveryClose.value)
		) {
			return false;
		}
		return publisherClose.value === recoveryClose.value;
	} catch {
		return false;
	}
}

// ===========================================================================
// Index rebuilding from recovery output
// ===========================================================================

const RECOVERY_OUTPUT_KEYS = new Set(["identity", "records", "totalBytes", "nextJournalSeq", "receipts"]);

function rebuildIndex(
	output: unknown,
	identity: { readonly hostId: string; readonly generation: string; readonly sessionId: string },
): RecoveredIndex | null {
	const descs = exactDescriptors(output, RECOVERY_OUTPUT_KEYS);
	if (descs === null) return null;

	const identityRaw = descs.identity?.value;
	const recordsRaw = descs.records?.value;
	const receiptsRaw = descs.receipts?.value;
	const totalBytesRaw = descs.totalBytes?.value;
	const nextJournalSeqRaw = descs.nextJournalSeq?.value;

	// Validate identity
	const identDesc = exactDescriptors(identityRaw, IDENTITY_KEYS);
	if (identDesc === null) return null;
	if (
		identDesc.hostId?.value !== identity.hostId ||
		identDesc.generation?.value !== identity.generation ||
		identDesc.sessionId?.value !== identity.sessionId
	) {
		return null;
	}

	// Validate arrays
	const recordsRawArr = validateDenseArray(recordsRaw);
	if (recordsRawArr === null) return null;
	const receiptsRawArr = validateDenseArray(receiptsRaw);
	if (receiptsRawArr === null) return null;
	if (recordsRawArr.length !== receiptsRawArr.length) return null;

	// Normalize each record through codec
	const normalizedRecords: SandboxEventOutboxRecordV1[] = [];
	const recordProofs: Array<{ size: number; sha256: string }> = [];
	let rebuildKeep = false;
	try {
		for (let i = 0; i < recordsRawArr.length; i++) {
			const enc = Reflect.apply(encodeSandboxEventOutboxRecordV1, undefined, [recordsRawArr[i]]);
			if (!enc.ok) return null;
			let proofSize = 0;
			let proofSha = "";
			let record: SandboxEventOutboxRecordV1;
			try {
				proofSize = enc.bytes.byteLength;
				proofSha = digestSha256(enc.bytes);
				const dec = Reflect.apply(decodeSandboxEventOutboxRecordV1, undefined, [enc.bytes]);
				if (!dec.ok) return null;
				record = dec.record;
			} finally {
				eraseKnownOwned(enc.bytes);
			}
			normalizedRecords.push(record);
			recordProofs.push(Object.freeze({ size: proofSize, sha256: proofSha }));
		}

		// Verify receipts match proofs
		const fileReceipts: DurableReceipt[] = new Array<DurableReceipt>(receiptsRawArr.length);
		for (let i = 0; i < receiptsRawArr.length; i++) {
			const receipt = decodeDurableReceipt(receiptsRawArr[i]);
			if (receipt === null) return null;
			if (receipt.sequence !== i + 1) return null;
			if (receipt.size !== recordProofs[i].size) return null;
			if (receipt.sha256 !== recordProofs[i].sha256) return null;
			fileReceipts[i] = receipt;
		}

		// Validate totalBytes
		if (
			typeof totalBytesRaw !== "number" ||
			!Number.isSafeInteger(totalBytesRaw) ||
			totalBytesRaw < 0 ||
			totalBytesRaw > MAX_RECOVERY_TOTAL_BYTES
		) {
			return null;
		}

		// Validate nextJournalSeq
		if (
			typeof nextJournalSeqRaw !== "number" ||
			!Number.isSafeInteger(nextJournalSeqRaw) ||
			nextJournalSeqRaw < 1 ||
			nextJournalSeqRaw > MAX_JOURNAL_SEQ + 1
		) {
			return null;
		}

		const byEventId = new Map<string, PendingEntry>();
		const pendingEventIds: string[] = [];

		// Single pass: process in strict sequence order
		let nextEventSequence = 0;
		const seenEventIds = new Set<string>();

		for (let i = 0; i < normalizedRecords.length; i++) {
			const record = normalizedRecords[i];
			const expectedSeq = i + 1;
			const receipt = fileReceipts[i];

			if (record.recordSeq !== expectedSeq) return null;
			if (receipt.sequence !== expectedSeq) return null;

			// Identity check
			if (
				record.hostId !== identity.hostId ||
				record.generation !== identity.generation ||
				record.sessionId !== identity.sessionId
			) {
				return null;
			}

			const eventId = record.eventId;
			const rk = record.recordKind;

			if (rk === "pending") {
				// Must have unique eventId
				if (seenEventIds.has(eventId)) return null;
				seenEventIds.add(eventId);

				// Event sequence must be nextEventSequence + 1
				const expectedEventSeq = nextEventSequence + 1;
				if (record.eventSequence !== expectedEventSeq) return null;
				nextEventSequence = expectedEventSeq;

				const entry: PendingEntry = Object.freeze({
					eventId: record.eventId,
					eventDigest: record.eventDigest,
					eventSequence: record.eventSequence,
					pendingRecord: record,
					pendingReceipt: receipt,
					deliveredRecord: null,
					deliveredReceipt: null,
					computedState: "pending",
				});
				byEventId.set(eventId, entry);
				pendingEventIds.push(eventId);
			} else if (rk === "delivered") {
				const pending = byEventId.get(eventId);
				if (pending === undefined) return null;

				// Event sequence must match pending
				if (record.eventSequence !== pending.eventSequence) return null;
				if (record.eventDigest !== pending.eventDigest) return null;

				// Validate ACK
				const ack = record.ack;
				if (ack.acknowledges !== eventId) return null;
				if (ack.status !== "delivered" && ack.status !== "replayed") return null;

				// Replace pending entry with delivered
				const deliveredEntry: PendingEntry = Object.freeze({
					eventId: pending.eventId,
					eventDigest: pending.eventDigest,
					eventSequence: pending.eventSequence,
					pendingRecord: pending.pendingRecord,
					pendingReceipt: pending.pendingReceipt,
					deliveredRecord: record,
					deliveredReceipt: receipt,
					computedState: "delivered",
				});
				byEventId.set(eventId, deliveredEntry);
				// Remove from pending list
				const idx = pendingEventIds.indexOf(eventId);
				if (idx >= 0) pendingEventIds.splice(idx, 1);
			} else {
				return null;
			}
		}

		// Validate nextJournalSeq
		if (normalizedRecords.length > 0) {
			const n = normalizedRecords[normalizedRecords.length - 1].recordSeq;
			if (nextJournalSeqRaw !== n + 1) return null;
		} else {
			if (nextJournalSeqRaw !== 1) return null;
		}

		// Validate totalBytes equals exact sum of receipt sizes
		let computedTotalBytes = 0;
		for (let i = 0; i < fileReceipts.length; i++) {
			const s = fileReceipts[i].size;
			if (!Number.isSafeInteger(computedTotalBytes + s)) return null;
			computedTotalBytes += s;
		}
		if (totalBytesRaw !== computedTotalBytes) return null;

		rebuildKeep = true;
		return Object.freeze({
			byEventId,
			pendingEventIds: Object.freeze(pendingEventIds),
			nextJournalSeq: nextJournalSeqRaw,
			totalBytes: totalBytesRaw,
			nextEventSequence: nextEventSequence + 1,
		});
	} finally {
		if (!rebuildKeep) {
			// No byte buffers to erase in event records
		}
	}
}

function buildRecoveryInput(
	backend: unknown,
	identity: { readonly hostId: string; readonly generation: string; readonly sessionId: string },
): Readonly<{ backend: unknown; identity: EventOutboxIdentity }> {
	return Object.freeze({ backend, identity });
}

// ===========================================================================
// SandboxEventOutboxStore -- internal implementation class
// ===========================================================================

type StoreIdentity = Readonly<{ hostId: string; generation: string; sessionId: string }>;

class SandboxEventOutboxStore {
	private readonly _publisher: BoundPublisher;
	private readonly _identity: StoreIdentity;
	private _index: RecoveredIndex;
	private _tail: Promise<void> = Promise.resolve();
	private _closed = false;
	private _poisoned = false;
	private _insidePublish = false;
	_internalGetInsidePublish(): boolean {
		return this._insidePublish;
	}
	_internalSerialized<T>(fn: () => Promise<EventOutboxResult<T>>): Promise<EventOutboxResult<T>> {
		return this._serialized(fn);
	}
	private _closeOwner: (() => Promise<Readonly<{ status: "closed" | "error" }>>) | null = null;
	private _closeP: Promise<EventOutboxResult<void>> | null = null;
	private _closeTail: Promise<void> | null = null;

	private constructor(
		publisher: BoundPublisher,
		identity: StoreIdentity,
		index: RecoveredIndex,
		closeOnce: () => Promise<Readonly<{ status: "closed" | "error" }>>,
	) {
		this._publisher = publisher;
		this._identity = identity;
		this._index = index;
		this._closeOwner = closeOnce;
	}

	// =========================================================================
	// Factory
	// =========================================================================

	static async create(raw: unknown): Promise<EventOutboxResult<SandboxEventOutboxStoreCapability>> {
		if (typeof raw === "object" && raw !== null) {
			const names = Object.getOwnPropertyNames(raw);
			const descs = Object.getOwnPropertyDescriptors(raw);
			for (const k of names) {
				const _d = descs[k];
			}
		}
		type PrelimState =
			| Readonly<{ status: "none" }>
			| Readonly<{ status: "owner"; close: () => unknown }>
			| Readonly<{ status: "owner_uncertain"; close: () => unknown }>
			| Readonly<{ status: "uncertain" }>;
		let prelim: PrelimState = { status: "none" };
		let publisherRaw: unknown;
		try {
			if (typeof raw === "object" && raw !== null && !types.isProxy(raw)) {
				const pDesc = Object.getOwnPropertyDescriptor(raw, "publisher");
				if (pDesc && "value" in pDesc) {
					publisherRaw = pDesc.value;
					const pubIsValid =
						typeof publisherRaw === "object" && publisherRaw !== null && !types.isProxy(publisherRaw);
					if (pubIsValid) {
						const closeDesc = Object.getOwnPropertyDescriptor(publisherRaw, "close");
						if (
							closeDesc &&
							closeDesc.enumerable === true &&
							"value" in closeDesc &&
							typeof closeDesc.value === "function" &&
							!types.isProxy(closeDesc.value)
						) {
							const rawCloseFn: () => unknown = closeDesc.value;
							prelim = Object.freeze({
								status: pDesc.enumerable === true ? ownerStatus : "owner_uncertain",
								close: (): unknown => {
									return Reflect.apply(rawCloseFn, publisherRaw, []);
								},
							});
						} else if (closeDesc && !("value" in closeDesc)) {
							prelim = { status: "uncertain" };
						} else if (closeDesc && types.isProxy(closeDesc.value)) {
							prelim = { status: "uncertain" };
						} else if (
							closeDesc &&
							"value" in closeDesc &&
							typeof closeDesc.value === "function" &&
							!closeDesc.enumerable
						) {
							prelim = { status: "uncertain" };
						}
					} else if (publisherRaw !== null && publisherRaw !== undefined && typeof publisherRaw === "object") {
						prelim = { status: "uncertain" };
					}
				} else if (pDesc && "get" in pDesc) {
					prelim = { status: "uncertain" };
				}
			} else if (typeof raw === "object" && raw !== null) {
				prelim = { status: "uncertain" };
			}
		} catch {
			prelim = { status: "uncertain" };
		}

		let closePromiseCache: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
		function closeOnce(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closePromiseCache === null) {
				if (prelim.status === "owner" || prelim.status === "owner_uncertain") {
					try {
						closePromiseCache = observePublisherClose(prelim.close());
					} catch {
						closePromiseCache = Promise.resolve(Object.freeze({ status: "error" }));
					}
				} else {
					closePromiseCache = Promise.resolve(Object.freeze({ status: "error" }));
				}
			}
			return closePromiseCache;
		}

		async function failWith(
			code: EventOutboxErrorCode,
		): Promise<EventOutboxResult<SandboxEventOutboxStoreCapability>> {
			const closeResult = await closeOnce();
			if (closeResult.status === "error") return errValue("CLOSE_UNCERTAIN");
			return errValue(code);
		}

		// Validate factory input shape
		const FACTORY_KEYS = new Set(["identity", "publisher", "recoveryBackend"]);
		const factoryInput = exactDescriptors(raw, FACTORY_KEYS);
		if (factoryInput === null) {
			if (prelim.status === "none") return errValue("INVALID_ARGUMENT");
			if (prelim.status === "uncertain" || prelim.status === "owner_uncertain") {
				return await closeOnce().then(() => errValue("CLOSE_UNCERTAIN"));
			}
			return await closeOnce().then((r) =>
				r.status === "closed" ? errValue("INVALID_ARGUMENT") : errValue("CLOSE_UNCERTAIN"),
			);
		}

		if (prelim.status === "uncertain" || prelim.status === "owner_uncertain") {
			return await closeOnce().then(() => errValue("CLOSE_UNCERTAIN"));
		}

		// Acquire full publisher
		const acquired = acquirePublisher(publisherRaw);
		if (acquired === null) {
			if (prelim.status === "none") return errValue("INVALID_ARGUMENT");
			return await failWith("INVALID_ARGUMENT");
		}
		const publisher = acquired;

		if (prelim.status === "owner") {
			prelim = Object.freeze({
				status: ownerStatus,
				close: (): unknown => publisher.close(),
			});
			closePromiseCache = null;
		}

		// Validate identity
		const identityRaw = factoryInput.identity?.value;
		const identityDesc = exactDescriptors(identityRaw, IDENTITY_KEYS);
		if (identityDesc === null) return await failWith("INVALID_ARGUMENT");
		const hostId = identityDesc.hostId?.value;
		const generation = identityDesc.generation?.value;
		const sessionId = identityDesc.sessionId?.value;
		if (!safeId(hostId) || !safeId(generation) || !safeId(sessionId)) return await failWith("INVALID_ARGUMENT");
		const identity = Object.freeze({ hostId, generation, sessionId });

		// Transfer recovery backend
		const recoveryBackend = factoryInput.recoveryBackend?.value;
		if (sharesPublisherOwner(publisherRaw, recoveryBackend)) {
			return await failWith("INVALID_ARGUMENT");
		}
		const recoveryInput = buildRecoveryInput(recoveryBackend, identity);

		// Run recovery
		let index: RecoveredIndex;
		try {
			const recoveryResult = await recoverSandboxEventOutboxJournal(recoveryInput);
			if (!recoveryResult.ok) {
				if (recoveryResult.error.code === "CLOSE_UNCERTAIN") {
					await closeOnce();
					return errValue("CLOSE_UNCERTAIN");
				}
				if (recoveryResult.error.code === "INVALID_ARGUMENT") {
					return await failWith("INVALID_ARGUMENT");
				}
				return await failWith("RECOVERY_FAILED");
			}
			const recoveryOutput = recoveryResult.value;
			const indexResult = rebuildIndex(recoveryOutput, identity);
			if (indexResult === null) return await failWith("RECOVERY_FAILED");
			index = indexResult;
		} catch {
			return await failWith("RECOVERY_FAILED");
		}

		const store = new SandboxEventOutboxStore(publisher, identity, index, closeOnce);
		const cap = buildCapability(store);
		return okValue(cap);
	}

	// =========================================================================
	// Serialization (FIFO tail chain)
	// =========================================================================

	private async _serialized<T>(fn: () => Promise<EventOutboxResult<T>>): Promise<EventOutboxResult<T>> {
		const admittedClosed = this._closed;
		if (admittedClosed) return errValue("CLOSED");

		const prev = this._tail;
		let resolveTail: () => void = () => {};
		this._tail = new Promise<void>((resolve) => {
			resolveTail = resolve;
		});

		try {
			await prev;
			if (this._poisoned) return errValue("POISONED");
			return await fn();
		} finally {
			resolveTail();
		}
	}

	// =========================================================================
	// Publisher invocation with narrow reentry guard
	// =========================================================================

	private async _invokePublish(seq: number, bytes: Uint8Array): Promise<EventOutboxPublishOutcome> {
		let expectedSha = "";
		let expectedSize = 0;
		try {
			expectedSha = digestSha256(bytes);
			expectedSize = bytes.byteLength;
		} catch {
			eraseKnownOwned(bytes);
			this._poisoned = true;
			return Object.freeze({ ok: false, error: "INVALID_ARGUMENT" });
		}

		if (expectedSize < 1) {
			eraseKnownOwned(bytes);
			this._poisoned = true;
			return Object.freeze({ ok: false, error: "INVALID_ARGUMENT" });
		}
		const nextTotalBytes = this._index.totalBytes + expectedSize;
		if (!Number.isSafeInteger(nextTotalBytes) || nextTotalBytes > MAX_RECOVERY_TOTAL_BYTES) {
			eraseKnownOwned(bytes);
			this._poisoned = true;
			return Object.freeze({ ok: false, error: "INVALID_ARGUMENT" });
		}

		this._insidePublish = true;
		let rawPromise: unknown;
		try {
			rawPromise = this._publisher.publish(seq, bytes);
		} catch {
			this._insidePublish = false;
			this._poisoned = true;
			eraseKnownOwned(bytes);
			return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
		} finally {
			this._insidePublish = false;
		}

		let mutationDetected = false;
		let outcome: EventOutboxPublishOutcome;
		try {
			outcome = await observePublisherPublish(rawPromise);
		} catch {
			const fallback: EventOutboxPublishOutcome = Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
			outcome = fallback;
		} finally {
			// Accept unchanged bytes OR fully-zeroed same-length buffer
			// (legitimate ownership erasure by publisher after successful copy).
			// Reject partial/nonzero mutation, size change, detachment.
			try {
				const postSize = bytes.byteLength;
				if (postSize !== expectedSize) {
					mutationDetected = true;
				} else if (postSize > 0) {
					let allZero = true;
					for (let i = 0; i < postSize; i++) {
						if (bytes[i] !== 0) {
							allZero = false;
							break;
						}
					}
					if (!allZero) {
						const postSha = digestSha256(bytes);
						if (postSha !== expectedSha) {
							mutationDetected = true;
						}
					}
				}
			} catch {
				mutationDetected = true;
			} finally {
				eraseKnownOwned(bytes);
			}
		}

		if (mutationDetected) {
			this._poisoned = true;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}

		try {
			if (outcome.ok) {
				const receipt = outcome.receipt;
				if (
					receipt.sequence !== seq ||
					receipt.size !== expectedSize ||
					receipt.size < 1 ||
					receipt.sha256 !== expectedSha
				) {
					this._poisoned = true;
					return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
				}
			}
			return outcome;
		} catch {
			this._poisoned = true;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
	}

	// =========================================================================
	// Public impl methods (called from capability object)
	// =========================================================================

	async _enqueueImpl(
		input: Readonly<{ event: RemoteHostEventFrame; recordedAt: string }>,
	): Promise<EventOutboxResult<EventOutboxEnqueueReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._enqueueOp(input));
	}

	async _markDeliveredImpl(
		input: Readonly<{ eventId: string; ack: RemoteHostAckFrame; recordedAt: string }>,
	): Promise<EventOutboxResult<EventOutboxDeliveredReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._markDeliveredOp(input));
	}

	async _queryImpl(eventId: string): Promise<EventOutboxResult<EventOutboxEventState>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._queryOp(eventId));
	}

	async _replayPendingImpl(
		cursor: number | null,
		maxCount: number,
	): Promise<EventOutboxResult<EventOutboxReplayPage>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._replayPendingOp(cursor, maxCount));
	}

	_closeImpl(): Promise<EventOutboxResult<void>> {
		if (this._closeP !== null) return this._closeP;
		this._closed = true;
		const capturedTail = this._tail;
		let resolveCloseTail: () => void = () => {};
		this._closeTail = new Promise<void>((resolve) => {
			resolveCloseTail = resolve;
		});
		this._tail = this._closeTail;
		this._closeP = (async () => {
			try {
				await capturedTail;
				// Clear index references
				if (this._index.byEventId.size > 0) {
					const emptyMap: ReadonlyMap<string, PendingEntry> = Object.freeze(new Map());
					this._index = Object.freeze({
						byEventId: emptyMap,
						pendingEventIds: Object.freeze([]),
						nextJournalSeq: 0,
						totalBytes: 0,
						nextEventSequence: 1,
					});
				}
				if (this._closeOwner === null) return errValue("CLOSE_UNCERTAIN");
				let closeResult: Readonly<{ status: "closed" | "error" }>;
				try {
					closeResult = await this._closeOwner();
				} catch {
					closeResult = Object.freeze({ status: "error" });
				}
				if (closeResult.status === "error") return errValue("CLOSE_UNCERTAIN");
				return okValue(undefined);
			} finally {
				resolveCloseTail();
			}
		})();
		return this._closeP;
	}

	_status(): EventOutboxStoreStatus {
		return Object.freeze({
			eventCount: this._index.byEventId.size,
			totalBytes: this._index.totalBytes,
			nextJournalSeq: this._index.nextJournalSeq,
			nextEventSequence: this._index.nextEventSequence,
		});
	}

	// =========================================================================
	// Internal operations (called from _serialized)
	// =========================================================================

	private async _enqueueOp(
		input: Readonly<{ event: RemoteHostEventFrame; recordedAt: string }>,
	): Promise<EventOutboxResult<EventOutboxEnqueueReceipt>> {
		// Normalize input
		if (typeof input !== "object" || input === null) return publicArgValue();
		try {
			if (types.isProxy(input)) return publicArgValue();
		} catch {
			return publicArgValue();
		}
		const inputDescs = exactDescriptors(input, new Set(["event", "recordedAt"]));
		if (inputDescs === null) return publicArgValue();

		const eventRaw = inputDescs.event?.value;
		const recordedAt = inputDescs.recordedAt?.value;
		if (!safeTimestamp(recordedAt)) return publicArgValue();

		const event = normalizeEventFrame(eventRaw);
		if (event === undefined) return publicArgValue();

		const eventId = event.id;
		const eventDigestResult = canonicalDigest(event);
		if (!eventDigestResult.ok) return publicArgValue();
		const eventDigest = eventDigestResult.value;

		// Check existing by eventId
		const existing = this._index.byEventId.get(eventId);
		if (existing !== undefined) {
			// Idempotent: same digest returns stored receipt
			if (existing.eventDigest === eventDigest) {
				return okValue(freshEnqueueReceipt(existing.pendingReceipt, eventId, eventDigest, existing.eventSequence));
			}
			// Different digest = collision
			this._poisoned = true;
			return errValue("EVENT_ID_COLLISION");
		}

		// New event: compute event sequence
		const eventSequence = this._index.nextEventSequence;

		// Validate event.sequence and event.cursor.sequence match
		if (event.sequence !== eventSequence) return publicArgValue();
		if (event.cursor.sequence !== eventSequence) return publicArgValue();

		// Build pending record
		const pendingRecordInput: Record<string, unknown> = {};
		pendingRecordInput.version = v1;
		pendingRecordInput.recordKind = pendingKind;
		pendingRecordInput.recordSeq = this._index.nextJournalSeq;
		pendingRecordInput.hostId = this._identity.hostId;
		pendingRecordInput.generation = this._identity.generation;
		pendingRecordInput.sessionId = this._identity.sessionId;
		pendingRecordInput.recordedAt = recordedAt;
		pendingRecordInput.eventId = eventId;
		pendingRecordInput.eventSequence = eventSequence;
		pendingRecordInput.eventType = event.body.type;
		pendingRecordInput.eventDigest = eventDigest;
		pendingRecordInput.event = event;

		// Encode and publish
		const encoded = encodeSandboxEventOutboxRecordV1(pendingRecordInput);
		if (!encoded.ok) return publicArgValue();
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "pending") return publicArgValue();
			if (
				codecRecord.hostId !== this._identity.hostId ||
				codecRecord.generation !== this._identity.generation ||
				codecRecord.sessionId !== this._identity.sessionId
			) {
				this._poisoned = true;
				return errValue("POISONED");
			}
			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const entry: PendingEntry = Object.freeze({
				eventId,
				eventDigest,
				eventSequence,
				pendingRecord: codecRecord,
				pendingReceipt: receipt,
				deliveredRecord: null,
				deliveredReceipt: null,
				computedState: pendingState,
			});

			this._index = Object.freeze({
				byEventId: frozenCloneAdd(this._index.byEventId, eventId, entry),
				pendingEventIds: Object.freeze([...this._index.pendingEventIds, eventId]),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
				nextEventSequence: eventSequence + 1,
			});

			return okValue(freshEnqueueReceipt(receipt, eventId, eventDigest, eventSequence));
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _markDeliveredOp(
		input: Readonly<{ eventId: string; ack: RemoteHostAckFrame; recordedAt: string }>,
	): Promise<EventOutboxResult<EventOutboxDeliveredReceipt>> {
		// Normalize input
		if (typeof input !== "object" || input === null) return publicArgValue();
		try {
			if (types.isProxy(input)) return publicArgValue();
		} catch {
			return publicArgValue();
		}
		const inputDescs = exactDescriptors(input, new Set(["eventId", "ack", "recordedAt"]));
		if (inputDescs === null) return publicArgValue();

		const eventId = inputDescs.eventId?.value;
		const ackRaw = inputDescs.ack?.value;
		const recordedAt = inputDescs.recordedAt?.value;

		if (!safeId(eventId)) return publicArgValue();
		if (!safeTimestamp(recordedAt)) return publicArgValue();

		const ack = normalizeAckFrame(ackRaw);
		if (ack === undefined) return publicArgValue();

		// Validate ACK acknowledges
		if (ack.acknowledges !== eventId) return publicArgValue();
		if (ack.status !== "delivered" && ack.status !== "replayed") return publicArgValue();

		// Compute ACK digest
		const ackDigestResult = canonicalDigest(ack);
		if (!ackDigestResult.ok) return publicArgValue();
		const ackDigest = ackDigestResult.value;

		const entry = this._index.byEventId.get(eventId);
		if (entry === undefined) return errValue("NOT_FOUND");

		// Already delivered: idempotent check
		if (entry.deliveredRecord !== null) {
			const dr = entry.deliveredRecord;
			const drReceipt = entry.deliveredReceipt;
			if (drReceipt === null) return errValue("RECOVERY_FAILED");
			if (dr.ackDigest === ackDigest && dr.ack.ackId === ack.ackId && dr.ack.status === ack.status) {
				return okValue({
					receipt: drReceipt,
					eventId,
					ackDigest,
					eventSequence: entry.eventSequence,
				});
			}
			this._poisoned = true;
			return errValue("DELIVERED_COLLISION");
		}

		// Must be pending state
		if (entry.computedState !== "pending") return errValue("INVALID_ARGUMENT");

		const seq = this._index.nextJournalSeq;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const deliveredRecordInput: Record<string, unknown> = {};
		deliveredRecordInput.version = v1;
		deliveredRecordInput.recordKind = deliveredKind;
		deliveredRecordInput.recordSeq = seq;
		deliveredRecordInput.hostId = this._identity.hostId;
		deliveredRecordInput.generation = this._identity.generation;
		deliveredRecordInput.sessionId = this._identity.sessionId;
		deliveredRecordInput.recordedAt = recordedAt;
		deliveredRecordInput.eventId = eventId;
		deliveredRecordInput.eventSequence = entry.eventSequence;
		deliveredRecordInput.eventType = entry.pendingRecord.eventType;
		deliveredRecordInput.eventDigest = entry.eventDigest;
		deliveredRecordInput.event = entry.pendingRecord.event;
		deliveredRecordInput.outcome = deliveredOutcome;
		deliveredRecordInput.ackDigest = ackDigest;
		deliveredRecordInput.ack = ack;

		const encoded = encodeSandboxEventOutboxRecordV1(deliveredRecordInput);
		if (!encoded.ok) return publicArgValue();
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "delivered") return publicArgValue();
			if (
				codecRecord.hostId !== this._identity.hostId ||
				codecRecord.generation !== this._identity.generation ||
				codecRecord.sessionId !== this._identity.sessionId
			) {
				this._poisoned = true;
				return errValue("POISONED");
			}
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const deliveredEntry: PendingEntry = Object.freeze({
				...entry,
				deliveredRecord: codecRecord,
				deliveredReceipt: receipt,
				computedState: deliveredState,
			});

			// Remove from pending list
			const pendingIdx = this._index.pendingEventIds.indexOf(eventId);
			const newPendingIds =
				pendingIdx >= 0
					? Object.freeze([
							...this._index.pendingEventIds.slice(0, pendingIdx),
							...this._index.pendingEventIds.slice(pendingIdx + 1),
						])
					: this._index.pendingEventIds;

			this._index = Object.freeze({
				byEventId: frozenCloneSet(this._index.byEventId, eventId, deliveredEntry),
				pendingEventIds: newPendingIds,
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
				nextEventSequence: this._index.nextEventSequence,
			});

			return okValue(freshDeliveredReceipt(receipt, eventId, ackDigest, entry.eventSequence));
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _queryOp(eventId: string): Promise<EventOutboxResult<EventOutboxEventState>> {
		if (!safeId(eventId)) return publicArgValue();
		const entry = this._index.byEventId.get(eventId);
		if (entry === undefined) return errValue("NOT_FOUND");

		if (entry.computedState === "pending") {
			const freshEvt = freshEventFrame(entry.pendingRecord.event);
			if (freshEvt === null) return errValue("RECOVERY_FAILED");
			return okValue(
				Object.freeze({
					state: pendingState,
					eventId: entry.eventId,
					eventDigest: entry.eventDigest,
					eventSequence: entry.eventSequence,
					enqueueReceipt: freshEnqueueReceipt(
						entry.pendingReceipt,
						entry.eventId,
						entry.eventDigest,
						entry.eventSequence,
					),
					event: freshEvt,
				}),
			);
		}

		// Delivered
		if (entry.deliveredRecord === null || entry.deliveredReceipt === null) return errValue("RECOVERY_FAILED");
		const freshEvt2 = freshEventFrame(entry.pendingRecord.event);
		if (freshEvt2 === null) return errValue("RECOVERY_FAILED");
		const freshAck2 = freshAckFrame(entry.deliveredRecord.ack);
		if (freshAck2 === null) return errValue("RECOVERY_FAILED");
		return okValue(
			Object.freeze({
				state: deliveredState,
				eventId: entry.eventId,
				eventDigest: entry.eventDigest,
				eventSequence: entry.eventSequence,
				enqueueReceipt: freshEnqueueReceipt(
					entry.pendingReceipt,
					entry.eventId,
					entry.eventDigest,
					entry.eventSequence,
				),
				deliveredReceipt: freshDeliveredReceipt(
					entry.deliveredReceipt,
					entry.eventId,
					entry.deliveredRecord.ackDigest,
					entry.eventSequence,
				),
				event: freshEvt2,
				ack: freshAck2,
			}),
		);
	}

	private async _replayPendingOp(
		cursor: number | null,
		maxCount: number,
	): Promise<EventOutboxResult<EventOutboxReplayPage>> {
		if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) return publicArgValue();
		if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 64) return publicArgValue();

		// Find starting index in pendingEventIds
		let startIdx = 0;
		if (cursor !== null) {
			startIdx = this._index.pendingEventIds.findIndex((eventId) => {
				const entry = this._index.byEventId.get(eventId);
				return entry !== undefined && entry.eventSequence >= cursor;
			});
			if (startIdx < 0) {
				// cursor beyond all pending events
				return okValue(
					Object.freeze({
						records: Object.freeze([]),
						nextEventSequence: null,
						totalBytes: 0,
					}),
				);
			}
		}

		const records: SandboxEventOutboxPendingRecordV1[] = [];
		let pageBytes = 0;
		let lastEventSequence: number | null = null;
		const pageMaxBytes = 16_777_216; // 16 MiB

		for (let i = startIdx; i < this._index.pendingEventIds.length && records.length < maxCount; i++) {
			const eventId = this._index.pendingEventIds[i];
			const entry = this._index.byEventId.get(eventId);
			if (entry === undefined || entry.computedState !== "pending") continue;

			// Check byte limit
			const entryBytes = entry.pendingReceipt.size;
			if (pageBytes + entryBytes > pageMaxBytes && records.length > 0) break;

			// Re-encode through codec for a truly fresh independent record
			const freshReplayEvt = freshEventFrame(entry.pendingRecord.event);
			if (freshReplayEvt === null) {
				this._poisoned = true;
				return errValue("RECOVERY_FAILED");
			}
			const rawFresh = {
				version: 1,
				recordKind: "pending",
				recordSeq: entry.pendingRecord.recordSeq,
				hostId: entry.pendingRecord.hostId,
				generation: entry.pendingRecord.generation,
				sessionId: entry.pendingRecord.sessionId,
				recordedAt: entry.pendingRecord.recordedAt,
				eventId: entry.pendingRecord.eventId,
				eventSequence: entry.pendingRecord.eventSequence,
				eventType: entry.pendingRecord.eventType,
				eventDigest: entry.pendingRecord.eventDigest,
				event: freshReplayEvt,
			};
			const enc = encodeSandboxEventOutboxRecordV1(rawFresh);
			let freshRecord: SandboxEventOutboxRecordV1 | null = null;
			try {
				if (!enc.ok) {
					this._poisoned = true;
					return errValue("RECOVERY_FAILED");
				}
				const dec = decodeSandboxEventOutboxRecordV1(enc.bytes);
				if (!dec.ok) {
					this._poisoned = true;
					return errValue("RECOVERY_FAILED");
				}
				if (dec.record.recordKind !== "pending") {
					this._poisoned = true;
					return errValue("RECOVERY_FAILED");
				}
				freshRecord = dec.record;
			} finally {
				if (enc.ok) eraseKnownOwned(enc.bytes);
			}
			if (freshRecord === null) {
				this._poisoned = true;
				return errValue("RECOVERY_FAILED");
			}
			records.push(freshRecord);
			pageBytes += entryBytes;
			lastEventSequence = entry.eventSequence;
		}

		const nextEventSequence =
			lastEventSequence !== null
				? this._index.pendingEventIds.some((eid) => {
						const e = this._index.byEventId.get(eid);
						return e !== undefined && e.computedState === "pending" && e.eventSequence > lastEventSequence;
					})
					? lastEventSequence + 1
					: null
				: null;

		return okValue(
			Object.freeze({
				records: Object.freeze(records.slice()),
				nextEventSequence,
				totalBytes: pageBytes,
			}),
		);
	}

	// =========================================================================
	// Internal helpers
	// =========================================================================

	private _publishError(result: EventOutboxPublishOutcome & { ok: false }): EventOutboxResult<never> {
		this._poisoned = true;
		if (result.error === "IO_UNCONFIRMED" || result.error === "POST_PUBLICATION_UNCERTAIN") {
			return errValue("UNCERTAIN");
		}
		return errValue("POISONED");
	}
}

// ===========================================================================
// Free helpers
// ===========================================================================

function frozenCloneAdd<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
	const clone = new Map(map);
	clone.set(key, value);
	return clone;
}

function frozenCloneSet<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
	const clone = new Map(map);
	clone.set(key, value);
	return clone;
}

function buildCapability(store: SandboxEventOutboxStore): SandboxEventOutboxStoreCapability {
	return Object.freeze({
		enqueue(input: Readonly<{ event: RemoteHostEventFrame; recordedAt: string }>) {
			return store._enqueueImpl(input);
		},
		markDelivered(input: Readonly<{ eventId: string; ack: RemoteHostAckFrame; recordedAt: string }>) {
			return store._markDeliveredImpl(input);
		},
		query(eventId: string) {
			return store._queryImpl(eventId);
		},
		replayPending(cursor: number | null, maxCount: number) {
			return store._replayPendingImpl(cursor, maxCount);
		},
		close() {
			if (store._internalGetInsidePublish()) {
				const pResult: EventOutboxResult<void> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "POISONED" }),
				});
				return Promise.resolve(pResult);
			}
			try {
				return store._closeImpl();
			} catch {
				const cuResult: EventOutboxResult<void> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "CLOSE_UNCERTAIN" }),
				});
				return Promise.resolve(cuResult);
			}
		},
		status(): Promise<EventOutboxResult<EventOutboxStoreStatus>> {
			if (store._internalGetInsidePublish()) {
				const pResult: EventOutboxResult<EventOutboxStoreStatus> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "POISONED" }),
				});
				return Promise.resolve(pResult);
			}
			return store._internalSerialized(async () => okValue(store._status()));
		},
	});
}

// ===========================================================================
// Public export
// ===========================================================================

export async function createSandboxEventOutboxStore(
	raw: unknown,
): Promise<EventOutboxResult<SandboxEventOutboxStoreCapability>> {
	return await SandboxEventOutboxStore.create(raw);
}
