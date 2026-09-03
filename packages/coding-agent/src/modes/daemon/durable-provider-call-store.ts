/**
 * DurableProviderCallStore -- restart-durable relay foundation for LLM
 * provider calls across a remote agent-host boundary.
 *
 * Uses a dedicated .b10-provider-call journal directory (NOT B03 relay).
 * Full request is journaled before provider contact.  Recovery never
 * re-executes started/chunking calls; durably appends
 * PROVIDER_CALL_INTERRUPTED terminal before exposure.
 *
 * Design:
 *  - Created through createDurableProviderCallStore() which returns a
 *    frozen exact capability object with own enumerable data methods.
 *  - Factory integrates recoverProviderCallJournal internally.
 *  - Preliminary-acquires publisher.close before unrelated validation;
 *    cleanup returns CLOSE_UNCERTAIN and is never swallowed.
 *  - FIFO serialized operations via tail Promise chain.
 *  - Reentry protection via narrow flag around synchronous Reflect.apply.
 *  - All returned DTOs are deeply frozen; caller inputs never retained.
 *  - Encoded codec records used in index; actual publisher receipts stored.
 *  - Query states use conditional narrowing instead of non-null assertions.
 *  - replayCallRecords returns fresh frozen copies.
 *  - RebuildIndex requires actual validated receipts.
 *  - Frame decoding uses decodeProviderProxyFrame from the accepted codec.
 *  - No casts, no any, no dynamic imports, no sync fs.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	type DurableReceipt,
	decodeProviderCallRecordV1,
	encodeProviderCallRecordV1,
	type ProviderCallCancelRequestedRecordV1,
	type ProviderCallChunkRecordV1,
	type ProviderCallDeliveredRecordV1,
	type ProviderCallJournaledRecordV1,
	type ProviderCallRecordV1,
	type ProviderCallStartedRecordV1,
	type ProviderCallTerminalRecordV1,
} from "./provider-call-record-codec.js";
import { type ProviderCallIdentity, recoverProviderCallJournal } from "./provider-call-recovery.js";
import type {
	ProviderCallErrorCode,
	ProviderCallJournaledReceipt,
	ProviderCallOutputRecord,
	ProviderCallReplayPage,
	ProviderCallState,
	ProviderCallStoreStatus,
	ProviderCallTerminalReceipt,
	ProviderCallUndeliveredPage,
	ProviderCallUndeliveredRecord,
} from "./provider-call-store-types.js";
import { decodeProviderProxyFrame, isValidDigest } from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_RECOVERY_TOTAL_BYTES = 268_435_456; // 256 MiB — matches recovery TOTAL_MAX_BYTES
const FILE_MAX_BYTES = 1_310_720; // 1.25 MiB — matches recovery FILE_MAX_BYTES
const RELAY_SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ===========================================================================
// Typed literal constants
// ===========================================================================

const v1: 1 = 1;
const terminalRecordKind: "terminal" = "terminal";
const startedRecordKind: "started" = "started";
const deliveredRecordKind: "delivered" = "delivered";
const cancelRequestedRecordKind: "cancel_requested" = "cancel_requested";
const interruptedKind: "interrupted" = "interrupted";
const ownerStatus: "owner" = "owner";
const journaledState: "journaled" = "journaled";
const startedState: "started" = "started";
const streamingState: "streaming" = "streaming";
const terminalState: "terminal" = "terminal";
const deliveredState: "delivered" = "delivered";

// ===========================================================================
// Result helpers
// ===========================================================================

type StoreResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: Readonly<{ code: ProviderCallErrorCode }> }>;

function okValue<T>(value: T): StoreResult<T> {
	return Object.freeze({
		ok: true,
		value: typeof value === "object" && value !== null ? Object.freeze(value) : value,
	});
}

function errValue(code: ProviderCallErrorCode): StoreResult<never> {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function publicArgValue(): StoreResult<never> {
	return errValue("INVALID_ARGUMENT");
}

/** Non-throwing intrinsic erase — handles detached buffers and proxy objects. */
// Captured once at module init — never re-discovered on each call.
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

/** Erase a byte buffer known to be owned by the store (codec output, terminal buffer). */
function eraseKnownOwned(bytes: Uint8Array): void {
	try {
		if (!_byteLengthGetter || !_taFill) return;
		const len = Reflect.apply(_byteLengthGetter, bytes, []);
		if (typeof len === "number" && len > 0) {
			Reflect.apply(_taFill, bytes, [0]);
		}
	} catch {
		// detached — suppression is the contract
	}
}

/**
 * Erase an external byte buffer only after proving it is an exact intrinsic
 * Uint8Array: non-Proxy %Uint8Array.prototype%, own full-backing ArrayBuffer
 * (byteOffset 0, byteLength === buffer.byteLength), no extras (symbols),
 * and own indexed names match exactly 0..len-1.
 * Rejects Buffer, subclasses, subviews, SharedArrayBuffer, and objects with extras.
 * Uses captured intrinsic getters — no [[Get]] calls on the raw object.
 */
function eraseIfExactTransferred(raw: unknown): void {
	try {
		if (typeof raw !== "object" || raw === null) return;
		if (types.isProxy(raw)) return;
		if (Object.getPrototypeOf(raw) !== Uint8Array.prototype) return;
		if (!_byteLengthGetter || !_byteOffsetGetter || !_bufferGetter || !_abByteLengthGetter || !_taFill) return;
		const byteLen = Reflect.apply(_byteLengthGetter, raw, []);
		if (typeof byteLen !== "number" || !Number.isSafeInteger(byteLen) || byteLen < 0) return;
		// Own names must be exactly "0"..."byteLen-1" (Uint8Array owns numeric indices)
		const ownNames = Object.getOwnPropertyNames(raw);
		if (ownNames.length !== byteLen) return;
		for (let i = 0; i < byteLen; i++) {
			if (ownNames[i] !== String(i)) return;
		}
		if (Object.getOwnPropertySymbols(raw).length !== 0) return;
		const buf = Reflect.apply(_bufferGetter, raw, []);
		if (typeof buf !== "object" || buf === null) return;
		if (Object.getPrototypeOf(buf) !== ArrayBuffer.prototype) return;
		const abByteLen = Reflect.apply(_abByteLengthGetter, buf, []);
		if (typeof abByteLen !== "number" || abByteLen !== byteLen) return;
		const byteOff = Reflect.apply(_byteOffsetGetter, raw, []);
		if (typeof byteOff !== "number" || byteOff !== 0) return;
		if (byteLen > 0) Reflect.apply(_taFill, raw, [0]);
	} catch {
		// detached — suppression is the contract
	}
}

/**
 * Erase store-owned byte arrays inside a recovery output.
 * Only touches requestBytes, chunkFrameBytes, and terminalFrameBytes.
 * Recovery output identity/descriptors are untouched.
 */
/**
 * Best-effort erasure of byte buffers inside a recovery output object.
 * Independent of overall output shape: does not require exact key count.
 * Snapshot the `records` own data field (reject Proxy/accessor), then
 * try to extract record items even if the container array is not fully dense.
 * For each item: reject Proxy, use descriptor-protected field access,
 * delegate to eraseIfExactTransferred which proves intrinsic Uint8Array.
 */
function eraseRecoveryBytes(raw: unknown): void {
	try {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
		if (types.isProxy(raw)) return;
		const allDescs = Object.getOwnPropertyDescriptors(raw);
		const recordsDesc = allDescs.records;
		if (!recordsDesc || !recordsDesc.enumerable || !("value" in recordsDesc)) return;
		const recordsRaw = recordsDesc.value;
		if (typeof recordsRaw !== "object" || recordsRaw === null) return;
		if (types.isProxy(recordsRaw)) return;
		const arrDescs = Object.getOwnPropertyDescriptors(recordsRaw);
		const lenDesc = arrDescs.length;
		if (!lenDesc || !("value" in lenDesc)) return;
		const arrLen = lenDesc.value;
		if (typeof arrLen !== "number" || !Number.isSafeInteger(arrLen) || arrLen < 0 || arrLen > 20000) return;
		const maxIdx = Math.min(arrLen, 20000);
		for (let i = 0; i < maxIdx; i++) {
			const name = String(i);
			const desc = arrDescs[name];
			if (!desc || !desc.enumerable || !("value" in desc)) continue;
			const item = desc.value;
			if (typeof item !== "object" || item === null) continue;
			if (types.isProxy(item)) continue;
			const itemDescs = Object.getOwnPropertyDescriptors(item);
			const kindDesc = itemDescs.recordKind;
			if (!kindDesc || !kindDesc.enumerable || !("value" in kindDesc)) continue;
			const kind = kindDesc.value;
			if (kind === "journaled") {
				const rbDesc = itemDescs.requestBytes;
				if (rbDesc && rbDesc.enumerable && "value" in rbDesc && rbDesc.value && typeof rbDesc.value === "object") {
					eraseIfExactTransferred(rbDesc.value);
				}
			} else if (kind === "chunk") {
				const fbDesc = itemDescs.chunkFrameBytes;
				if (fbDesc && fbDesc.enumerable && "value" in fbDesc && fbDesc.value && typeof fbDesc.value === "object") {
					eraseIfExactTransferred(fbDesc.value);
				}
			} else if (kind === "terminal") {
				const fbDesc = itemDescs.terminalFrameBytes;
				if (fbDesc && fbDesc.enumerable && "value" in fbDesc && fbDesc.value && typeof fbDesc.value === "object") {
					eraseIfExactTransferred(fbDesc.value);
				}
			}
		}
	} catch {
		// suppression — best-effort erasure on failure path
	}
}

/**
 * Erase owned byte arrays inside a descriptor-proven record item.
 * Uses exact own-property descriptor checks to avoid Proxy/accessor traps.
 */
function eraseRecordItemOwnedBytes(item: unknown): void {
	if (typeof item !== "object" || item === null) return;
	if (types.isProxy(item)) return;
	const descs = Object.getOwnPropertyDescriptors(item);
	const kindDesc = descs.recordKind;
	if (!kindDesc || !kindDesc.enumerable || !("value" in kindDesc)) return;
	const kind = kindDesc.value;
	if (kind === "journaled") {
		const rbDesc = descs.requestBytes;
		if (rbDesc && rbDesc.enumerable && "value" in rbDesc && rbDesc.value && typeof rbDesc.value === "object") {
			eraseIfExactTransferred(rbDesc.value);
		}
	} else if (kind === "chunk") {
		const fbDesc = descs.chunkFrameBytes;
		if (fbDesc && fbDesc.enumerable && "value" in fbDesc && fbDesc.value && typeof fbDesc.value === "object") {
			eraseIfExactTransferred(fbDesc.value);
		}
	} else if (kind === "terminal") {
		const fbDesc = descs.terminalFrameBytes;
		if (fbDesc && fbDesc.enumerable && "value" in fbDesc && fbDesc.value && typeof fbDesc.value === "object") {
			eraseIfExactTransferred(fbDesc.value);
		}
	}
}

/**
 * Erase owned byte buffers of up to `count` normalized records in array.
 * Uses discriminated recordKind to access the correct buffer field.
 */
function eraseNormalizedRecordBuffers(records: ProviderCallRecordV1[], count: number): void {
	for (let j = 0; j < count; j++) {
		const r = records[j];
		if (r.recordKind === "journaled") {
			if (r.requestBytes && typeof r.requestBytes === "object") eraseKnownOwned(r.requestBytes);
		} else if (r.recordKind === "chunk") {
			if (r.chunkFrameBytes && typeof r.chunkFrameBytes === "object") eraseKnownOwned(r.chunkFrameBytes);
		} else if (r.recordKind === "terminal") {
			if (r.terminalFrameBytes && typeof r.terminalFrameBytes === "object") eraseKnownOwned(r.terminalFrameBytes);
		}
	}
}

function digestSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function encodeUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

// ===========================================================================
// Injected publisher capability types
// ===========================================================================

export interface ProviderCallPublishOk {
	readonly ok: true;
	readonly receipt: DurableReceipt;
}

export interface ProviderCallPublisher {
	readonly publish: (seq: number, bytes: Uint8Array) => Promise<ProviderCallPublishOutcome>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type ProviderCallPublishOutcome =
	| ProviderCallPublishOk
	| Readonly<{
			ok: false;
			error: "IO_UNCONFIRMED" | "SEQ_COLLISION" | "POST_PUBLICATION_UNCERTAIN" | "INVALID_ARGUMENT";
	  }>;

// ===========================================================================
// Public capability type
// ===========================================================================

export interface ProviderCallStoreCapability {
	readonly journalProviderCall: (
		record: ProviderCallJournaledRecordV1,
	) => Promise<StoreResult<ProviderCallJournaledReceipt>>;
	readonly journalStarted: (
		callId: string,
		requestDigest: string,
		requestReceipt: DurableReceipt,
		recordedAt: string,
	) => Promise<StoreResult<DurableReceipt>>;
	readonly journalChunk: (record: ProviderCallChunkRecordV1) => Promise<StoreResult<DurableReceipt>>;
	readonly journalTerminal: (
		record: ProviderCallTerminalRecordV1,
	) => Promise<StoreResult<ProviderCallTerminalReceipt>>;
	readonly journalInterrupted: (
		callId: string,
		chunkCount: number,
		recordedAt: string,
	) => Promise<StoreResult<ProviderCallTerminalReceipt>>;
	readonly markDelivered: (
		callId: string,
		ackEnvelopeId: string,
		ackEnvelopeDigest: string,
		outgoingRelayReceipt: DurableReceipt,
		recordedAt: string,
	) => Promise<StoreResult<DurableReceipt>>;
	readonly journalCancel: (callId: string, recordedAt: string) => Promise<StoreResult<DurableReceipt>>;
	readonly query: (callId: string) => Promise<StoreResult<ProviderCallState>>;
	readonly replayOutput: (
		callId: string,
		cursor: number,
		maxCount: number,
	) => Promise<StoreResult<ProviderCallReplayPage>>;
	readonly replayCallRecords: (callId: string) => Promise<StoreResult<readonly ProviderCallRecordV1[]>>;
	readonly replayUndelivered: (
		cursor: number | null,
		maxCount: number,
	) => Promise<StoreResult<ProviderCallUndeliveredPage>>;
	readonly close: () => Promise<StoreResult<void>>;
	readonly status: () => Promise<StoreResult<ProviderCallStoreStatus>>;
}

// ===========================================================================
// Factory input keys
// ===========================================================================

const FACTORY_KEYS = new Set(["publisher", "recoveryBackend", "identity", "recordedAt"]);
const IDENTITY_KEYS = new Set(["hostId", "generation", "sessionId"]);
const RECOVERY_OUTPUT_KEYS = new Set([
	"identity",
	"records",
	"fileReceipts",
	"totalBytes",
	"nextJournalSeq",
	"interruptedCallIds",
]);

// ===========================================================================
// Internal index types
// ===========================================================================

type InternalState = "journaled" | "started" | "streaming" | "terminal" | "delivered";

interface CallIndexData {
	readonly callId: string;
	requestDigest: string | null;
	readonly journaledRecord: ProviderCallJournaledRecordV1;
	readonly journaledReceipt: DurableReceipt;
	startedRecord: ProviderCallStartedRecordV1 | null;
	startedReceipt: DurableReceipt | null;
	chunkRecords: readonly ProviderCallChunkRecordV1[];
	chunkReceipts: readonly DurableReceipt[];
	terminalRecord: ProviderCallTerminalRecordV1 | null;
	terminalReceipt: DurableReceipt | null;
	deliveredRecord: ProviderCallDeliveredRecordV1 | null;
	deliveredReceipt: DurableReceipt | null;
	cancelRequested: boolean;
	cancelRequestedRecord: ProviderCallCancelRequestedRecordV1 | null;
	cancelRequestedReceipt: DurableReceipt | null;
	computedState: InternalState;
}

interface RecoveredIndex {
	readonly byCallId: ReadonlyMap<string, CallIndexData>;
	readonly byRequestFrameId: ReadonlyMap<string, string>;
	readonly allCallIds: readonly string[];
	readonly nextJournalSeq: number;
	readonly totalBytes: number;
}

// ===========================================================================
// InternalState helper functions
// ===========================================================================

function _sJournaled(): InternalState {
	return "journaled";
}
function _sStarted(): InternalState {
	return "started";
}
function _sStreaming(): InternalState {
	return "streaming";
}
function _sTerminal(): InternalState {
	return "terminal";
}
function _sDelivered(): InternalState {
	return "delivered";
}

// ===========================================================================
// Own-data descriptor extraction (no casts)
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
// Dense array validation — exact Array-prototype, own 0..length-1, no extras
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
		// Validate length descriptor: non-configurable, non-enumerable, data descriptor
		if (lenDesc.configurable !== false || lenDesc.enumerable !== false) return null;
		// Expect own names: 0, 1, ..., len-1, "length" => len + 1
		const ownNames = Object.getOwnPropertyNames(raw);
		if (ownNames.length !== len + 1) return null;
		// Validate each index: must be enumerable data descriptor.
		// Snapshot values into a fresh frozen array to decouple from any proxy/accessor on the original.
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
// Publisher bound method acquisition (strict)
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
				// Thin dispatch — store handles observation; no double-observe
				return Reflect.apply(publishFn, raw, [seq, bytes]);
			},
			close(): unknown {
				// Thin dispatch — store handles observation; no double-observe
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

async function observePublisherPublish(rawResult: unknown): Promise<ProviderCallPublishOutcome> {
	const observed = await observeExactNativePromise(rawResult);
	if (!observed.ok) return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });

	// Validate success variant: exact {ok, receipt}
	const successCheck = exactDescriptors(observed.value, new Set(["ok", "receipt"]));
	if (successCheck !== null) {
		const okVal = successCheck.ok?.value;
		if (okVal === true) {
			const receiptRaw = successCheck.receipt?.value;
			const receipt = decodeDurableReceipt(receiptRaw);
			if (receipt !== null) return Object.freeze({ ok: true, receipt });
		}
	}

	// Validate failure variant: exact {ok, error}
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
// Factory close-on-failure helper
// ===========================================================================

// closePublisherStatus removed — factory uses getBoundClose + observePublisherClose directly

// ===========================================================================
// DurableProviderCallStore -- internal implementation class
// ===========================================================================

class DurableProviderCallStore {
	private readonly _publisher: BoundPublisher;
	private readonly _identity: { readonly hostId: string; readonly generation: string; readonly sessionId: string };
	private _index: RecoveredIndex;
	private _tail: Promise<void> = Promise.resolve();
	private _closed = false;
	private _poisoned = false;
	private _insidePublish = false;
	/** @internal Exposed for buildCapability factory */
	_internalGetInsidePublish(): boolean {
		return this._insidePublish;
	}
	/** @internal Exposed for buildCapability factory */
	_internalSerialized<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
		return this._serialized(fn);
	}
	private _closeOwner: (() => Promise<Readonly<{ status: "closed" | "error" }>>) | null = null;
	private _closeP: Promise<StoreResult<void>> | null = null;
	private _closeTail: Promise<void> | null = null;

	private constructor(
		publisher: BoundPublisher,
		identity: { readonly hostId: string; readonly generation: string; readonly sessionId: string },
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

	static async create(raw: unknown): Promise<StoreResult<ProviderCallStoreCapability>> {
		// Phase 0: tri-state preliminary close-owner discovery.
		// {none} — raw is not object or lacks `publisher` own data property;
		//           no close owner to acquire.  Only plain invalid-arg returns
		//           INVALID_ARGUMENT directly.
		// {owner} — a valid `publisher.close` own data function was discovered;
		//           close exactly once on every failure path; close failure dominates.
		// {uncertain} — Proxy, accessor, non-data, or hidden close owner detected;
		//           CLOSE_UNCERTAIN even when the rest of the input is invalid.
		// No live getters are invoked during discovery.
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
					// Data publisher descriptor (enumerable or hidden).
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
							// accessor close — close owner hidden, uncertain
							prelim = { status: "uncertain" };
						} else if (closeDesc && types.isProxy(closeDesc.value)) {
							// Proxy close function — uncertain
							prelim = { status: "uncertain" };
						} else if (
							closeDesc &&
							"value" in closeDesc &&
							typeof closeDesc.value === "function" &&
							!closeDesc.enumerable
						) {
							// non-enumerable data close — hidden close owner, uncertain
							prelim = { status: "uncertain" };
						} // else: missing close or non-function close → provably no owner, leave prelim.none
					} else if (publisherRaw !== null && publisherRaw !== undefined && typeof publisherRaw === "object") {
						// publisher exists but is Proxy — uncertain
						prelim = { status: "uncertain" };
					} // else undefined or primitive publisher — leave prelim.none
				} else if (pDesc && "get" in pDesc) {
					// Accessor publisher — cannot read value without invoking getter.
					// Hidden publisher structure; always uncertain even if close is later provable.
					prelim = { status: "uncertain" };
				} // else no publisher own data — leave prelim.none
			} else if (typeof raw === "object" && raw !== null) {
				// raw is a non-null object that failed the outer checks
				prelim = { status: "uncertain" };
			} // else raw is primitive or null → provably no owner, leave prelim.none
		} catch {
			prelim = { status: "uncertain" };
		}

		// closeOnce — shared exact close that can be called at most once.
		// If prelim.status is "owner", closeOnce calls the discovered close.
		// If prelim.status is "none" or "uncertain", closeOnce returns {status:"error"}
		// but does not throw.
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
			code: ProviderCallErrorCode,
			storeToErase?: DurableProviderCallStore,
		): Promise<StoreResult<ProviderCallStoreCapability>> {
			if (storeToErase !== undefined) {
				storeToErase._eraseRecordBuffers();
			}
			const closeResult = await closeOnce();
			if (closeResult.status === "error") return errValue("CLOSE_UNCERTAIN");
			return errValue(code);
		}

		// Validate factory input shape
		const factoryInput = exactDescriptors(raw, FACTORY_KEYS);
		if (factoryInput === null) {
			if (prelim.status === "none") return errValue("INVALID_ARGUMENT");
			if (prelim.status === "uncertain" || prelim.status === "owner_uncertain") {
				return await closeOnce().then(() => errValue("CLOSE_UNCERTAIN"));
			}
			// owner with invalid factory — close fails becomes uncertain, close success stays invalid
			return await closeOnce().then((r) =>
				r.status === "closed" ? errValue("INVALID_ARGUMENT") : errValue("CLOSE_UNCERTAIN"),
			);
		}

		// Phase 1: uncertain or owner_uncertain preliminary state after valid
		// factoryInput means hidden/uncertain close owner — always CLOSE_UNCERTAIN.
		if (prelim.status === "uncertain" || prelim.status === "owner_uncertain") {
			return await closeOnce().then(() => errValue("CLOSE_UNCERTAIN"));
		}

		// Phase 2: acquire full publisher (publish + close validation)
		const acquired = acquirePublisher(publisherRaw);
		if (acquired === null) {
			if (prelim.status === "none") return errValue("INVALID_ARGUMENT");
			return await failWith("INVALID_ARGUMENT");
		}
		const publisher = acquired;

		// Replace preliminary close with bound publisher close — same owner.
		if (prelim.status === "owner") {
			// replace the captured fn so it uses the bound variant
			prelim = Object.freeze({
				status: ownerStatus,
				close: (): unknown => publisher.close(),
			});
			// also reset the cache since the close function changed
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

		const recordedAt = factoryInput.recordedAt?.value;
		if (!safeTimestamp(recordedAt)) return await failWith("INVALID_ARGUMENT");

		// Transfer the raw recovery backend to the hardened scanner. The scanner
		// exclusively validates and closes it. Reject a shared physical owner
		// before transfer so one close function is never invoked twice.
		const recoveryBackend = factoryInput.recoveryBackend?.value;
		if (sharesPublisherOwner(publisherRaw, recoveryBackend)) {
			return await failWith("INVALID_ARGUMENT");
		}
		const recoveryInput = buildRecoveryInput(recoveryBackend, identity);

		// Run recovery (consumes and closes backend internally)
		let index: RecoveredIndex;
		try {
			const recoveryResult = await recoverProviderCallJournal(recoveryInput);
			if (!recoveryResult.ok) {
				if (recoveryResult.error.code === "CLOSE_UNCERTAIN") {
					// Recovery cleanup uncertainty dominates publisher cleanup.
					await closeOnce();
					return errValue("CLOSE_UNCERTAIN");
				}
				if (recoveryResult.error.code === "INVALID_ARGUMENT") {
					return await failWith("INVALID_ARGUMENT");
				}
				return await failWith("RECOVERY_FAILED");
			}
			const recoveryOutput = recoveryResult.value;

			// Build index using actual file receipts from recovery.
			// rebuildIndex accepts unknown and descriptor-snapshots everything.
			try {
				const indexResult = rebuildIndex(recoveryOutput, identity);
				if (indexResult === null) return await failWith("RECOVERY_FAILED");
				index = indexResult;
			} finally {
				eraseRecoveryBytes(recoveryOutput);
			}
		} catch {
			return await failWith("RECOVERY_FAILED");
		}

		const store = new DurableProviderCallStore(publisher, identity, index, closeOnce);

		// Terminalize interrupted calls using the validated index, never
		// direct-reading unvalidated recoveryOutput.interruptedCallIds.
		// Compute from index which has already validated the interrupted set.
		const interruptedFromIndex: string[] = [];
		for (const [callId, entry] of store._index.byCallId) {
			if (entry.computedState === "started" || entry.computedState === "streaming") {
				interruptedFromIndex.push(callId);
			}
		}
		for (const callId of interruptedFromIndex) {
			const entry = store._index.byCallId.get(callId);
			if (entry === undefined) return await failWith("RECOVERY_FAILED");
			const chunkCount = entry.chunkRecords.length;
			try {
				const terminalResult = await store._terminalizeInterrupted(callId, chunkCount, recordedAt);
				if (!terminalResult.ok) {
					const code =
						terminalResult.error.code === "INVALID_ARGUMENT" ||
						terminalResult.error.code === "NOT_FOUND" ||
						terminalResult.error.code === "RECOVERY_FAILED"
							? "RECOVERY_FAILED"
							: "UNCERTAIN";
					return await failWith(code, store);
				}
			} catch {
				return await failWith("RECOVERY_FAILED", store);
			}
		}

		// Build and return capability object
		const cap = buildCapability(store);
		return okValue(cap);
	} // =========================================================================
	// Record buffer erasure — zero all store-owned decoded byte arrays
	// =========================================================================

	private _eraseRecordBuffers(): void {
		for (const [, entry] of this._index.byCallId) {
			try {
				const jr: ProviderCallJournaledRecordV1 = entry.journaledRecord;
				const rb = jr.requestBytes;
				if (rb !== undefined) eraseKnownOwned(rb);
			} catch {
				/* suppression */
			}
			for (const chunk of entry.chunkRecords) {
				try {
					const cb = chunk.chunkFrameBytes;
					if (cb !== undefined) eraseKnownOwned(cb);
				} catch {
					/* suppression */
				}
			}
			if (entry.terminalRecord !== null) {
				try {
					const tb = entry.terminalRecord.terminalFrameBytes;
					if (tb !== undefined) eraseKnownOwned(tb);
				} catch {
					/* suppression */
				}
			}
		}
	}

	// =========================================================================
	// Serialization (FIFO tail chain)
	// =========================================================================

	private async _serialized<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
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

	private async _invokePublish(seq: number, bytes: Uint8Array): Promise<ProviderCallPublishOutcome> {
		// Phase 1: pre-hash (contain failure, erase on error)
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

		// Phase 2: publish with nested finally for erasure
		this._insidePublish = true;
		let rawPromise: unknown;
		try {
			rawPromise = this._publisher.publish(seq, bytes);
		} catch {
			this._insidePublish = false;
			this._poisoned = true;
			eraseKnownOwned(bytes);
			const unconfirmedOutcome: ProviderCallPublishOutcome = Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
			return unconfirmedOutcome;
		} finally {
			this._insidePublish = false;
		}

		// Phase 3: observe publish result, then always erase and detect mutation
		// observePublisherPublish is contained so this method never rejects.
		let mutationDetected = false;
		let outcome: ProviderCallPublishOutcome;
		try {
			outcome = await observePublisherPublish(rawPromise);
		} catch {
			// observePublisherPublish threw unexpectedly — contain it.
			const fallback: ProviderCallPublishOutcome = Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
			outcome = fallback;
		} finally {
			// Nested finally: always erase bytes despite mutation detection errors
			// Accept unchanged bytes OR fully-zeroed same-length buffer
			// (legitimate ownership erasure by publisher after successful copy).
			// Reject partial/nonzero mutation, size change, detachment, prototype change.
			try {
				// Verify bytes is still a genuine Uint8Array before trusting byteLength/index reads.
				// A malicious publisher could zero bytes then replace the prototype, making
				// further property reads unreliable.
				try {
					if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype) {
						mutationDetected = true;
					}
				} catch {
					mutationDetected = true;
				}
				if (!mutationDetected) {
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

		// Phase 4: verify receipt matches expected values, never reject public callers
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
	// Internal: terminalize interrupted (used by factory)
	// =========================================================================

	private async _terminalizeInterrupted(
		callId: string,
		chunkCount: number,
		recordedAt: string,
	): Promise<StoreResult<void>> {
		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");
		if (entry.terminalRecord !== null) return okValue(undefined);

		const errorFrame = Object.freeze({
			type: "provider_proxy",
			proxyType: "model_call_error",
			callId,
			error: "PROVIDER_CALL_INTERRUPTED",
		});
		const terminalBytes = encodeUtf8(JSON.stringify(errorFrame));
		try {
			const terminalFrameDigest = digestSha256(terminalBytes);

			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const terminalRecordInput: ProviderCallTerminalRecordV1 = Object.freeze({
				version: v1,
				recordKind: terminalRecordKind,
				journalSeq: seq,
				callId,
				hostId: this._identity.hostId,
				generation: this._identity.generation,
				sessionId: this._identity.sessionId,
				recordedAt,
				terminalKind: interruptedKind,
				chunkCount,
				terminalFrameBytes: terminalBytes,
				terminalFrameDigest,
			});

			// Encode+publish, then erase the store-owned input buffer.
			const encoded = encodeProviderCallRecordV1(terminalRecordInput);
			if (!encoded.ok) return errValue("INVALID_ARGUMENT");
			try {
				const publishResult = await this._invokePublish(seq, encoded.bytes);
				if (!publishResult.ok) {
					this._poisoned = true;
					return errValue("UNCERTAIN");
				}
				const receipt = publishResult.receipt;

				const codecRecord = encoded.record;
				if (codecRecord.recordKind !== "terminal") return errValue("RECOVERY_FAILED");

				this._index = Object.freeze({
					...this._index,
					byCallId: frozenCloneSet(this._index.byCallId, callId, {
						...entry,
						terminalRecord: codecRecord,
						terminalReceipt: receipt,
						computedState: _sTerminal(),
					}),
					nextJournalSeq: seq + 1,
					totalBytes: this._index.totalBytes + receipt.size,
				});

				return okValue(undefined);
			} finally {
				eraseKnownOwned(encoded.bytes);
			}
		} finally {
			eraseKnownOwned(terminalBytes);
		}
	}

	// =========================================================================
	// Public methods (called from capability object)
	// =========================================================================

	async _journalProviderCallImpl(
		record: ProviderCallJournaledRecordV1,
	): Promise<StoreResult<ProviderCallJournaledReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalProviderCallOp(record));
	}

	async _journalStartedImpl(
		callId: string,
		requestDigest: string,
		requestReceipt: DurableReceipt,
		recordedAt: string,
	): Promise<StoreResult<DurableReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalStartedOp(callId, requestDigest, requestReceipt, recordedAt));
	}

	async _journalChunkImpl(record: ProviderCallChunkRecordV1): Promise<StoreResult<DurableReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalChunkOp(record));
	}

	async _journalTerminalImpl(record: ProviderCallTerminalRecordV1): Promise<StoreResult<ProviderCallTerminalReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalTerminalOp(record));
	}

	async _journalInterruptedImpl(
		callId: string,
		chunkCount: number,
		recordedAt: string,
	): Promise<StoreResult<ProviderCallTerminalReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalInterruptedOp(callId, chunkCount, recordedAt));
	}

	async _markDeliveredImpl(
		callId: string,
		ackEnvelopeId: string,
		ackEnvelopeDigest: string,
		outgoingRelayReceipt: DurableReceipt,
		recordedAt: string,
	): Promise<StoreResult<DurableReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() =>
			this._markDeliveredOp(callId, ackEnvelopeId, ackEnvelopeDigest, outgoingRelayReceipt, recordedAt),
		);
	}

	async _journalCancelImpl(callId: string, recordedAt: string): Promise<StoreResult<DurableReceipt>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(() => this._journalCancelOp(callId, recordedAt));
	}

	async _queryImpl(callId: string): Promise<StoreResult<ProviderCallState>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._queryOp(callId));
	}

	async _replayOutputImpl(
		callId: string,
		cursor: number,
		maxCount: number,
	): Promise<StoreResult<ProviderCallReplayPage>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._replayOutputOp(callId, cursor, maxCount));
	}

	async _replayCallRecordsImpl(callId: string): Promise<StoreResult<readonly ProviderCallRecordV1[]>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._replayCallRecordsOp(callId));
	}

	async _replayUndeliveredImpl(
		cursor: number | null,
		maxCount: number,
	): Promise<StoreResult<ProviderCallUndeliveredPage>> {
		if (this._insidePublish) {
			return errValue("POISONED");
		}
		return await this._serialized(async () => this._replayUndeliveredOp(cursor, maxCount));
	}

	_closeImpl(): Promise<StoreResult<void>> {
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
				// Erase store-owned record buffers before closing
				this._eraseRecordBuffers();
				// Clear index references after erasure
				if (this._index.byCallId.size > 0) {
					const emptyMap: ReadonlyMap<string, CallIndexData> = Object.freeze(new Map());
					const emptyMap2: ReadonlyMap<string, string> = Object.freeze(new Map());
					this._index = Object.freeze({
						byCallId: emptyMap,
						byRequestFrameId: emptyMap2,
						allCallIds: Object.freeze([]),
						nextJournalSeq: 0,
						totalBytes: 0,
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

	_status(): ProviderCallStoreStatus {
		return Object.freeze({
			callCount: this._index.byCallId.size,
			totalBytes: this._index.totalBytes,
			nextSequence: this._index.nextJournalSeq,
		});
	}

	// =========================================================================
	// Internal operations (called from _serialized)
	// =========================================================================

	private async _journalProviderCallOp(
		record: ProviderCallJournaledRecordV1,
	): Promise<StoreResult<ProviderCallJournaledReceipt>> {
		// Validate through codec FIRST before any raw field reads
		const encoded = encodeProviderCallRecordV1(record);
		if (!encoded.ok) return publicArgValue();
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "journaled") return publicArgValue();
			// Validate exact store identity before any state read
			if (
				codecRecord.hostId !== this._identity.hostId ||
				codecRecord.generation !== this._identity.generation ||
				codecRecord.sessionId !== this._identity.sessionId
			) {
				return this._poisonResult("POISONED");
			}
			const existing = this._index.byCallId.get(codecRecord.callId);
			if (existing !== undefined) {
				if (existing.requestDigest !== null && existing.requestDigest === codecRecord.requestDigest) {
					return okValue({
						receipt: existing.journaledReceipt,
						callId: codecRecord.callId,
						requestDigest: codecRecord.requestDigest,
						canonicalRequestDigest: existing.journaledRecord.canonicalRequestDigest,
					});
				}
				return this._poisonResult("CALL_ID_COLLISION");
			}
			if (this._index.byRequestFrameId.has(codecRecord.requestFrameId)) {
				return this._poisonResult("CALL_ID_COLLISION");
			}
			// New journaled record must use the exact next journalSeq
			if (codecRecord.journalSeq !== this._index.nextJournalSeq) {
				return this._poisonResult("POISONED");
			}

			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			if (codecRecord.recordKind !== "journaled") return publicArgValue();

			const newEntry: CallIndexData = Object.freeze({
				callId: codecRecord.callId,
				requestDigest: codecRecord.requestDigest,
				journaledRecord: codecRecord,
				journaledReceipt: receipt,
				startedRecord: null,
				startedReceipt: null,
				chunkRecords: Object.freeze([]),
				chunkReceipts: Object.freeze([]),
				terminalRecord: null,
				terminalReceipt: null,
				deliveredRecord: null,
				deliveredReceipt: null,
				cancelRequested: false,
				cancelRequestedRecord: null,
				cancelRequestedReceipt: null,
				computedState: _sJournaled(),
			});

			this._index = Object.freeze({
				byCallId: frozenCloneAdd(this._index.byCallId, codecRecord.callId, newEntry),
				byRequestFrameId: frozenCloneAdd(
					this._index.byRequestFrameId,
					codecRecord.requestFrameId,
					codecRecord.callId,
				),
				allCallIds: Object.freeze([...this._index.allCallIds, codecRecord.callId]),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue({
				receipt,
				callId: codecRecord.callId,
				requestDigest: codecRecord.requestDigest,
				canonicalRequestDigest: codecRecord.canonicalRequestDigest,
			});
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _journalStartedOp(
		callId: string,
		requestDigest: string,
		requestReceipt: DurableReceipt,
		recordedAt: string,
	): Promise<StoreResult<DurableReceipt>> {
		if (!safeId(callId)) return publicArgValue();
		if (!isValidDigest(requestDigest)) return publicArgValue();
		if (!safeTimestamp(recordedAt)) return publicArgValue();

		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		// Exact-decode and compare requestReceipt against journaled receipt
		const decodedReceipt = decodeDurableReceipt(requestReceipt);
		if (
			decodedReceipt === null ||
			decodedReceipt.sequence !== entry.journaledReceipt.sequence ||
			decodedReceipt.size !== entry.journaledReceipt.size ||
			decodedReceipt.sha256 !== entry.journaledReceipt.sha256
		)
			return publicArgValue();

		if (entry.startedRecord !== null) {
			const sr = entry.startedRecord;
			if (sr.requestDigest === requestDigest) {
				const srReceipt = entry.startedReceipt;
				if (srReceipt !== null) return okValue(srReceipt);
				return errValue("RECOVERY_FAILED");
			}
			return this._poisonResult("CALL_ID_COLLISION");
		}

		if (entry.computedState !== "journaled") return errValue("INVALID_ARGUMENT");
		if (entry.requestDigest !== requestDigest) return this._poisonResult("CALL_ID_COLLISION");

		const jr = entry.journaledReceipt;

		const seq = this._index.nextJournalSeq;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const startedRecordInput: ProviderCallStartedRecordV1 = Object.freeze({
			version: v1,
			recordKind: startedRecordKind,
			journalSeq: seq,
			callId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt,
			requestDigest,
			requestJournalSeq: entry.journaledRecord.journalSeq,
			requestReceipt: jr,
		});

		const encoded = encodeProviderCallRecordV1(startedRecordInput);
		if (!encoded.ok) return publicArgValue();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "started") return publicArgValue();

			this._index = Object.freeze({
				...this._index,
				byCallId: frozenCloneSet(this._index.byCallId, callId, {
					...entry,
					startedRecord: codecRecord,
					startedReceipt: receipt,
					computedState: _sStarted(),
				}),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue(receipt);
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _journalChunkOp(record: ProviderCallChunkRecordV1): Promise<StoreResult<DurableReceipt>> {
		// Validate through codec FIRST before any raw field reads
		const encoded = encodeProviderCallRecordV1(record);
		if (!encoded.ok) return publicArgValue();
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "chunk") return publicArgValue();
			// Validate exact store identity before any state read
			if (
				codecRecord.hostId !== this._identity.hostId ||
				codecRecord.generation !== this._identity.generation ||
				codecRecord.sessionId !== this._identity.sessionId
			) {
				return this._poisonResult("POISONED");
			}
			const entry = this._index.byCallId.get(codecRecord.callId);
			if (entry === undefined) return errValue("NOT_FOUND");

			// For idempotent existing chunk, return stored receipt without seq validation.
			// The digest check below ensures semantic match.
			if (codecRecord.chunkIndex < entry.chunkRecords.length) {
				const existing = entry.chunkRecords[codecRecord.chunkIndex];
				if (existing !== undefined && existing.chunkFrameDigest === codecRecord.chunkFrameDigest) {
					const r = entry.chunkReceipts[codecRecord.chunkIndex];
					if (r !== undefined) return okValue(r);
					return errValue("RECOVERY_FAILED");
				}
				return this._poisonResult("CHUNK_COLLISION");
			}
			// New chunks must use exact next journalSeq
			if (codecRecord.journalSeq !== this._index.nextJournalSeq) {
				return this._poisonResult("POISONED");
			}

			// Require started/streaming only for a new chunk index.
			if (entry.computedState !== "started" && entry.computedState !== "streaming")
				return errValue("INVALID_ARGUMENT");

			const expectedIndex = entry.chunkRecords.length;
			if (codecRecord.chunkIndex > expectedIndex) return this._poisonResult("CHUNK_GAP");

			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			if (codecRecord.recordKind !== "chunk") return publicArgValue();

			this._index = Object.freeze({
				...this._index,
				byCallId: frozenCloneSet(this._index.byCallId, codecRecord.callId, {
					...entry,
					chunkRecords: Object.freeze([...entry.chunkRecords, codecRecord]),
					chunkReceipts: Object.freeze([...entry.chunkReceipts, receipt]),
					computedState: _sStreaming(),
				}),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue(receipt);
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _journalTerminalOp(
		record: ProviderCallTerminalRecordV1,
	): Promise<StoreResult<ProviderCallTerminalReceipt>> {
		// Validate through codec FIRST before any raw field reads
		const encoded = encodeProviderCallRecordV1(record);
		if (!encoded.ok) {
			return publicArgValue();
		}
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "terminal") {
				return publicArgValue();
			}
			// Validate exact store identity before any state read
			if (
				codecRecord.hostId !== this._identity.hostId ||
				codecRecord.generation !== this._identity.generation ||
				codecRecord.sessionId !== this._identity.sessionId
			) {
				return this._poisonResult("POISONED");
			}
			// For idempotent existing terminal, validate identity above only.
			// journalSeq is checked only for new terminal records below.
			const entry = this._index.byCallId.get(codecRecord.callId);
			if (entry === undefined) {
				return errValue("NOT_FOUND");
			}

			// Check idempotent/collision BEFORE state check — terminal record may
			// already exist (state = "terminal") for idempotent re-calls.
			if (entry.terminalRecord !== null) {
				const tr = entry.terminalRecord;
				const trReceipt = entry.terminalReceipt;
				if (trReceipt === null) return errValue("RECOVERY_FAILED");
				if (
					tr.terminalFrameDigest === codecRecord.terminalFrameDigest &&
					tr.terminalKind === codecRecord.terminalKind &&
					tr.chunkCount === codecRecord.chunkCount
				) {
					return okValue({
						receipt: trReceipt,
						callId: codecRecord.callId,
						terminalKind: tr.terminalKind,
						chunkCount: tr.chunkCount,
						terminalBytesDigest: tr.terminalFrameDigest,
					});
				}
				return this._poisonResult("TERMINAL_COLLISION");
			}

			// No existing terminal record — validate identity above, now check journalSeq
			if (codecRecord.journalSeq !== this._index.nextJournalSeq) return this._poisonResult("POISONED");
			// Validate state and chunk count
			if (entry.computedState !== "started" && entry.computedState !== "streaming")
				return errValue("INVALID_ARGUMENT");
			if (codecRecord.chunkCount !== entry.chunkRecords.length) return errValue("INVALID_ARGUMENT");
			// cancelled terminal requires prior cancel_requested record
			if (codecRecord.terminalKind === "cancelled" && !entry.cancelRequested) return errValue("INVALID_ARGUMENT");

			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			if (codecRecord.recordKind !== "terminal") return publicArgValue();

			this._index = Object.freeze({
				...this._index,
				byCallId: frozenCloneSet(this._index.byCallId, codecRecord.callId, {
					...entry,
					terminalRecord: codecRecord,
					terminalReceipt: receipt,
					computedState: _sTerminal(),
				}),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue({
				receipt,
				callId: codecRecord.callId,
				terminalKind: codecRecord.terminalKind,
				chunkCount: codecRecord.chunkCount,
				terminalBytesDigest: codecRecord.terminalFrameDigest,
			});
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _journalInterruptedOp(
		callId: string,
		chunkCount: number,
		recordedAt: string,
	): Promise<StoreResult<ProviderCallTerminalReceipt>> {
		if (!safeId(callId)) return publicArgValue();
		if (!safeTimestamp(recordedAt)) return publicArgValue();
		if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) return publicArgValue();

		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		// Require exact chunkCount match against actual chunk records
		// (validate before terminal idempotency to catch invalid callers earlier)
		if (chunkCount !== entry.chunkRecords.length) return publicArgValue();

		// journalInterrupted only for started/streaming state
		if (entry.computedState === "delivered") return errValue("INVALID_ARGUMENT");
		if (entry.computedState !== "started" && entry.computedState !== "streaming") {
			// If already terminal (but not delivered), return idempotent terminal receipt
			if (entry.terminalRecord !== null) {
				const trReceipt = entry.terminalReceipt;
				if (trReceipt === null) return errValue("RECOVERY_FAILED");
				return okValue({
					receipt: trReceipt,
					callId,
					terminalKind: entry.terminalRecord.terminalKind,
					chunkCount: entry.terminalRecord.chunkCount,
					terminalBytesDigest: entry.terminalRecord.terminalFrameDigest,
				});
			}
			return errValue("INVALID_ARGUMENT");
		}

		const errorFrame = Object.freeze({
			type: "provider_proxy",
			proxyType: "model_call_error",
			callId,
			error: "PROVIDER_CALL_INTERRUPTED",
		});
		const terminalBytes = encodeUtf8(JSON.stringify(errorFrame));
		try {
			const terminalFrameDigest = digestSha256(terminalBytes);

			const seq = this._index.nextJournalSeq;
			if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

			const terminalRecordInput: ProviderCallTerminalRecordV1 = Object.freeze({
				version: v1,
				recordKind: terminalRecordKind,
				journalSeq: seq,
				callId,
				hostId: this._identity.hostId,
				generation: this._identity.generation,
				sessionId: this._identity.sessionId,
				recordedAt,
				terminalKind: interruptedKind,
				chunkCount,
				terminalFrameBytes: terminalBytes,
				terminalFrameDigest,
			});

			// Encode+publish, then erase the store-owned input buffer.
			const encoded = encodeProviderCallRecordV1(terminalRecordInput);
			if (!encoded.ok) return publicArgValue();
			try {
				const publishResult = await this._invokePublish(seq, encoded.bytes);
				if (!publishResult.ok) return this._publishError(publishResult);
				const receipt = publishResult.receipt;

				const codecRecord = encoded.record;
				if (codecRecord.recordKind !== "terminal") return publicArgValue();

				this._index = Object.freeze({
					...this._index,
					byCallId: frozenCloneSet(this._index.byCallId, callId, {
						...entry,
						terminalRecord: codecRecord,
						terminalReceipt: receipt,
						computedState: _sTerminal(),
					}),
					nextJournalSeq: seq + 1,
					totalBytes: this._index.totalBytes + receipt.size,
				});

				return okValue({
					receipt,
					callId,
					terminalKind: interruptedKind,
					chunkCount,
					terminalBytesDigest: codecRecord.terminalFrameDigest,
				});
			} finally {
				eraseKnownOwned(encoded.bytes);
			}
		} finally {
			eraseKnownOwned(terminalBytes);
		}
	}

	private async _markDeliveredOp(
		callId: string,
		ackEnvelopeId: string,
		ackEnvelopeDigest: string,
		outgoingRelayReceipt: DurableReceipt,
		recordedAt: string,
	): Promise<StoreResult<DurableReceipt>> {
		if (!safeId(callId)) return publicArgValue();
		if (!safeId(ackEnvelopeId)) return publicArgValue();
		if (!isValidDigest(ackEnvelopeDigest)) return publicArgValue();
		if (!safeTimestamp(recordedAt)) return publicArgValue();

		// Exact-decode receipt: never compare/pass raw/Proxy properties.
		const decodedReceipt = decodeDurableReceipt(outgoingRelayReceipt);
		if (decodedReceipt === null) return publicArgValue();

		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		if (entry.deliveredRecord !== null) {
			const dr = entry.deliveredRecord;
			const drReceipt = entry.deliveredReceipt;
			if (drReceipt === null) return errValue("RECOVERY_FAILED");
			if (
				dr.ackEnvelopeId === ackEnvelopeId &&
				dr.ackEnvelopeDigest === ackEnvelopeDigest &&
				dr.outgoingRelayReceipt.sequence === decodedReceipt.sequence &&
				dr.outgoingRelayReceipt.size === decodedReceipt.size &&
				dr.outgoingRelayReceipt.sha256 === decodedReceipt.sha256
			) {
				return okValue(drReceipt);
			}
			return this._poisonResult("DELIVERED_COLLISION");
		}

		if (entry.computedState !== "terminal") return errValue("INVALID_ARGUMENT");

		const seq = this._index.nextJournalSeq;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const deliveredRecordInput: ProviderCallDeliveredRecordV1 = Object.freeze({
			version: v1,
			recordKind: deliveredRecordKind,
			journalSeq: seq,
			callId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt,
			ackEnvelopeId,
			ackEnvelopeDigest,
			outgoingRelayReceipt: decodedReceipt,
		});

		const encoded = encodeProviderCallRecordV1(deliveredRecordInput);
		if (!encoded.ok) return publicArgValue();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "delivered") return publicArgValue();

			this._index = Object.freeze({
				...this._index,
				byCallId: frozenCloneSet(this._index.byCallId, callId, {
					...entry,
					deliveredRecord: codecRecord,
					deliveredReceipt: receipt,
					computedState: _sDelivered(),
				}),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue(receipt);
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _journalCancelOp(callId: string, recordedAt: string): Promise<StoreResult<DurableReceipt>> {
		if (!safeId(callId)) return publicArgValue();
		if (!safeTimestamp(recordedAt)) return publicArgValue();

		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		// Late cancel after terminal/delivered is idempotent success — return existing terminal receipt
		if (entry.computedState === "terminal" || entry.computedState === "delivered") {
			if (entry.terminalReceipt === null) return errValue("RECOVERY_FAILED");
			return okValue(entry.terminalReceipt);
		}

		if (entry.computedState !== "started" && entry.computedState !== "streaming") return errValue("INVALID_ARGUMENT");

		// Idempotent: return actual stored receipt on second call
		if (entry.cancelRequested) {
			if (entry.cancelRequestedReceipt !== null) return okValue(entry.cancelRequestedReceipt);
			return errValue("RECOVERY_FAILED");
		}

		const seq = this._index.nextJournalSeq;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const cancelRecordInput: ProviderCallCancelRequestedRecordV1 = Object.freeze({
			version: v1,
			recordKind: cancelRequestedRecordKind,
			journalSeq: seq,
			callId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt,
		});

		const encoded = encodeProviderCallRecordV1(cancelRecordInput);
		if (!encoded.ok) return publicArgValue();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "cancel_requested") return publicArgValue();

			this._index = Object.freeze({
				...this._index,
				byCallId: frozenCloneSet(this._index.byCallId, callId, {
					...entry,
					cancelRequested: true,
					cancelRequestedRecord: codecRecord,
					cancelRequestedReceipt: publishResult.receipt,
				}),
				nextJournalSeq: seq + 1,
				totalBytes: this._index.totalBytes + publishResult.receipt.size,
			});

			return okValue(publishResult.receipt);
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	private async _queryOp(callId: string): Promise<StoreResult<ProviderCallState>> {
		if (!safeId(callId)) return publicArgValue();
		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		const journaledReceipt: ProviderCallJournaledReceipt = Object.freeze({
			receipt: entry.journaledReceipt,
			callId: entry.callId,
			requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
			canonicalRequestDigest: entry.journaledRecord.canonicalRequestDigest,
		});

		const startedReceipt = entry.startedReceipt;
		const terminalReceipt = entry.terminalReceipt;
		const terminalRecord = entry.terminalRecord;
		const deliveredReceipt = entry.deliveredReceipt;

		switch (entry.computedState) {
			case "journaled":
				return okValue(
					Object.freeze({
						state: journaledState,
						callId: entry.callId,
						requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
						journaledReceipt,
					}),
				);
			case "started": {
				if (startedReceipt === null) return errValue("RECOVERY_FAILED");
				return okValue(
					Object.freeze({
						state: startedState,
						callId: entry.callId,
						requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
						journaledReceipt,
						startedReceipt,
					}),
				);
			}
			case "streaming": {
				if (startedReceipt === null) return errValue("RECOVERY_FAILED");
				return okValue(
					Object.freeze({
						state: streamingState,
						callId: entry.callId,
						requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
						journaledReceipt,
						startedReceipt,
						chunkCount: entry.chunkRecords.length,
					}),
				);
			}
			case "terminal": {
				if (startedReceipt === null || terminalReceipt === null || terminalRecord === null)
					return errValue("RECOVERY_FAILED");
				return okValue(
					Object.freeze({
						state: terminalState,
						callId: entry.callId,
						requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
						journaledReceipt,
						startedReceipt,
						terminalReceipt: Object.freeze({
							receipt: terminalReceipt,
							callId: entry.callId,
							terminalKind: terminalRecord.terminalKind,
							chunkCount: terminalRecord.chunkCount,
							terminalBytesDigest: terminalRecord.terminalFrameDigest,
						}),
						chunkCount: entry.chunkRecords.length,
					}),
				);
			}
			case "delivered": {
				if (
					startedReceipt === null ||
					terminalReceipt === null ||
					terminalRecord === null ||
					deliveredReceipt === null
				)
					return errValue("RECOVERY_FAILED");
				return okValue(
					Object.freeze({
						state: deliveredState,
						callId: entry.callId,
						requestDigest: entry.requestDigest ?? entry.journaledRecord.requestDigest,
						journaledReceipt,
						startedReceipt,
						terminalReceipt: Object.freeze({
							receipt: terminalReceipt,
							callId: entry.callId,
							terminalKind: terminalRecord.terminalKind,
							chunkCount: terminalRecord.chunkCount,
							terminalBytesDigest: terminalRecord.terminalFrameDigest,
						}),
						deliveredReceipt,
						chunkCount: entry.chunkRecords.length,
					}),
				);
			}
		}
	}

	private async _replayOutputOp(
		callId: string,
		cursor: number,
		maxCount: number,
	): Promise<StoreResult<ProviderCallReplayPage>> {
		if (!safeId(callId)) return publicArgValue();
		if (!Number.isSafeInteger(cursor) || cursor < 0) return publicArgValue();
		if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 64) return publicArgValue();

		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");
		if (cursor > entry.chunkRecords.length) return publicArgValue();

		const outputRecords: ProviderCallOutputRecord[] = [];
		const chunks = entry.chunkRecords;
		let nextChunkIndex: number | null = cursor;
		let count = 0;

		for (let i = cursor; i < chunks.length && count < maxCount; i += 1) {
			let frameStr: string;
			try {
				frameStr = new TextDecoder("utf-8", { fatal: true }).decode(chunks[i].chunkFrameBytes);
			} catch {
				return errValue("RECOVERY_FAILED");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(frameStr);
			} catch {
				return errValue("RECOVERY_FAILED");
			}
			const decoded = decodeProviderProxyFrame(parsed);
			if (!decoded.ok) return errValue("RECOVERY_FAILED");
			deepFreezeFrame(decoded.value);
			outputRecords.push(Object.freeze({ kind: "chunk", chunkIndex: chunks[i].chunkIndex, frame: decoded.value }));
			count += 1;
			nextChunkIndex = i + 1;
		}

		if (entry.terminalRecord !== null && count < maxCount) {
			let frameStr: string;
			try {
				frameStr = new TextDecoder("utf-8", { fatal: true }).decode(entry.terminalRecord.terminalFrameBytes);
			} catch {
				return errValue("RECOVERY_FAILED");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(frameStr);
			} catch {
				return errValue("RECOVERY_FAILED");
			}
			const decoded = decodeProviderProxyFrame(parsed);
			if (!decoded.ok) return errValue("RECOVERY_FAILED");
			deepFreezeFrame(decoded.value);
			outputRecords.push(Object.freeze({ kind: "terminal", frame: decoded.value }));
			// Null only after the actual terminal frame is included.
			nextChunkIndex = null;
		} else if (entry.terminalRecord !== null && nextChunkIndex !== null && nextChunkIndex >= chunks.length) {
			// Terminal is pending but wasn't included this page (count == maxCount).
			// Keep cursor at chunks.length so the next page starts at the terminal.
			// Don't set to null — the terminal is pending on the next call.
		} else if (nextChunkIndex !== null && nextChunkIndex >= chunks.length) {
			// Terminal is absent and all chunks consumed.
			// Preserve nextChunkIndex = chunks.length (not null) so a future terminal
			// page is discoverable. Null only after actual terminal is included above.
		}

		return okValue(Object.freeze({ records: Object.freeze(outputRecords), nextChunkIndex }));
	}

	private async _replayCallRecordsOp(callId: string): Promise<StoreResult<readonly ProviderCallRecordV1[]>> {
		if (!safeId(callId)) return publicArgValue();
		const entry = this._index.byCallId.get(callId);
		if (entry === undefined) return errValue("NOT_FOUND");

		// Collect fresh codec-decoded copies; on failure erase all accumulated owned buffers.
		const allRecords: Array<{ record: ProviderCallRecordV1; journalSeq: number }> = [];
		let keep = false;
		try {
			const pushReencoded = (r: ProviderCallRecordV1): boolean => {
				const enc = encodeProviderCallRecordV1(r);
				if (!enc.ok) return false;
				try {
					const dec = decodeProviderCallRecordV1(enc.bytes);
					if (!dec.ok) return false;
					allRecords.push({ record: dec.record, journalSeq: r.journalSeq });
					return true;
				} finally {
					eraseKnownOwned(enc.bytes);
				}
			};
			if (!pushReencoded(entry.journaledRecord)) return errValue("RECOVERY_FAILED");
			if (entry.startedRecord !== null) {
				if (!pushReencoded(entry.startedRecord)) return errValue("RECOVERY_FAILED");
			}
			for (const chunk of entry.chunkRecords) {
				if (!pushReencoded(chunk)) return errValue("RECOVERY_FAILED");
			}
			if (entry.terminalRecord !== null) {
				if (!pushReencoded(entry.terminalRecord)) return errValue("RECOVERY_FAILED");
			}
			if (entry.deliveredRecord !== null) {
				if (!pushReencoded(entry.deliveredRecord)) return errValue("RECOVERY_FAILED");
			}
			if (entry.cancelRequestedRecord !== null) {
				if (!pushReencoded(entry.cancelRequestedRecord)) return errValue("RECOVERY_FAILED");
			}
			allRecords.sort((a, b) => a.journalSeq - b.journalSeq);
			const records = allRecords.map((e) => e.record);
			keep = true;
			return okValue(Object.freeze(records));
		} finally {
			if (!keep) {
				for (const { record: r } of allRecords) {
					if (r.recordKind === "journaled") {
						if (r.requestBytes) eraseKnownOwned(r.requestBytes);
					} else if (r.recordKind === "chunk") {
						if (r.chunkFrameBytes) eraseKnownOwned(r.chunkFrameBytes);
					} else if (r.recordKind === "terminal") {
						if (r.terminalFrameBytes) eraseKnownOwned(r.terminalFrameBytes);
					}
				}
			}
		}
	}

	async _replayUndeliveredOp(
		cursor: number | null,
		maxCount: number,
	): Promise<StoreResult<ProviderCallUndeliveredPage>> {
		// Validate cursor: null (start from beginning) or non-negative safe integer
		if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) return publicArgValue();
		// Validate maxCount: 1..64
		if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 64) return publicArgValue();

		const allCallIds = this._index.allCallIds;
		const startIdx = cursor !== null ? cursor : 0;
		if (startIdx > allCallIds.length) return publicArgValue();

		const undeliveredRecords: Array<{
			callId: string;
			state: "journaled" | "started" | "streaming" | "terminal";
			requestDigest: string;
			firstJournalSequence: number;
			chunkCount: number;
		}> = [];

		let idx = startIdx;

		// Scan in deterministic allCallIds (original first-journal-sequence) order
		while (idx < allCallIds.length && undeliveredRecords.length < maxCount) {
			const callId = allCallIds[idx];
			const entry = this._index.byCallId.get(callId);
			if (entry === undefined) {
				return errValue("RECOVERY_FAILED");
			}
			const computedState = entry.computedState;

			// Skip delivered calls
			if (computedState !== "delivered") {
				let undeliveredState: "journaled" | "started" | "streaming" | "terminal";
				if (computedState === "journaled") {
					undeliveredState = "journaled";
				} else if (computedState === "started") {
					undeliveredState = "started";
				} else if (computedState === "streaming") {
					undeliveredState = "streaming";
				} else if (computedState === "terminal") {
					undeliveredState = "terminal";
				} else {
					// delivered — skipped above, unreachable
					idx += 1;
					continue;
				}

				const requestDigest = entry.requestDigest ?? entry.journaledRecord.requestDigest;
				if (typeof requestDigest !== "string") return errValue("RECOVERY_FAILED");

				undeliveredRecords.push({
					callId: entry.callId,
					state: undeliveredState,
					requestDigest,
					firstJournalSequence: entry.journaledRecord.journalSeq,
					chunkCount: entry.chunkRecords.length,
				});
			}

			idx += 1;
		}

		// nextCursor: null when exhausted, otherwise the next index to scan
		const nextCursor: number | null = idx < allCallIds.length ? idx : null;

		const frozenRecords: readonly ProviderCallUndeliveredRecord[] = Object.freeze(
			undeliveredRecords.map((r) =>
				Object.freeze({
					callId: r.callId,
					state: r.state,
					requestDigest: r.requestDigest,
					firstJournalSequence: r.firstJournalSequence,
					chunkCount: r.chunkCount,
				}),
			),
		);

		return okValue(Object.freeze({ records: frozenRecords, nextCursor }));
	}

	// =========================================================================
	// Internal helpers
	// =========================================================================

	private _publishError(result: ProviderCallPublishOutcome & { ok: false }): StoreResult<never> {
		this._poisoned = true;
		if (result.error === "IO_UNCONFIRMED" || result.error === "POST_PUBLICATION_UNCERTAIN") {
			return errValue("UNCERTAIN");
		}
		return errValue("POISONED");
	}

	private _poisonResult(code: ProviderCallErrorCode): StoreResult<never> {
		this._poisoned = true;
		return errValue(code);
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

function deepFreezeFrame(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	// Always recurse into nested objects, even if outer is already frozen.
	// A frozen object's nested values may not be frozen.
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreezeFrame(item);
		}
		if (!Object.isFrozen(value)) Object.freeze(value);
		return;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		if (!Object.isFrozen(value)) Object.freeze(value);
		return;
	}
	const ownNames = Object.getOwnPropertyNames(value);
	for (const name of ownNames) {
		const desc = Object.getOwnPropertyDescriptor(value, name);
		if (desc && "value" in desc) {
			deepFreezeFrame(desc.value);
		}
	}
	if (!Object.isFrozen(value)) Object.freeze(value);
}

function buildRecoveryInput(
	backend: unknown,
	identity: { readonly hostId: string; readonly generation: string; readonly sessionId: string },
): Readonly<{ backend: unknown; identity: ProviderCallIdentity }> {
	return Object.freeze({ backend, identity });
}

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
// Index rebuilding (returns null on missing receipts)
// ===========================================================================

function rebuildIndex(output: unknown, identity: ProviderCallIdentity): RecoveredIndex | null {
	// Phase 0: descriptor-snapshot the entire recovery output before any property read.
	// This prevents Proxy/accessor traps from fabricating fields during iteration.
	const descs = exactDescriptors(output, RECOVERY_OUTPUT_KEYS);
	if (descs === null) return null;

	// Snapshot each validated property once
	const identityRaw = descs.identity?.value;
	const recordsRaw = descs.records?.value;
	const fileReceiptsRaw = descs.fileReceipts?.value;
	const totalBytesRaw = descs.totalBytes?.value;
	const nextJournalSeqRaw = descs.nextJournalSeq?.value;
	const interruptedRaw = descs.interruptedCallIds?.value;

	// --- validate identity descriptor-safe against expected identity ---
	const identDesc = exactDescriptors(identityRaw, IDENTITY_KEYS);
	if (identDesc === null) return null;
	if (
		identDesc.hostId?.value !== identity.hostId ||
		identDesc.generation?.value !== identity.generation ||
		identDesc.sessionId?.value !== identity.sessionId
	) {
		return null;
	}

	// --- validate arrays: dense, non-Proxy, own-property only ---
	const recordsRawArr = validateDenseArray(recordsRaw);
	if (recordsRawArr === null) return null;
	const fileReceiptsRawArr = validateDenseArray(fileReceiptsRaw);
	if (fileReceiptsRawArr === null) return null;
	if (recordsRawArr.length !== fileReceiptsRawArr.length) return null;
	// Normalize each record through the hardened codec: encode then decode.
	// For each record, compute the canonical {size, sha256} proof from the
	// encoded bytes BEFORE erasing, then require the matching file receipt.
	const normalizedRecords: ProviderCallRecordV1[] = [];
	const recordProofs: Array<{ size: number; sha256: string }> = [];
	let rebuildKeep = false;
	try {
		for (let i = 0; i < recordsRawArr.length; i++) {
			const enc = Reflect.apply(encodeProviderCallRecordV1, undefined, [recordsRawArr[i]]);
			if (!enc.ok) {
				return null;
			}
			let proofSize = 0;
			let proofSha = "";
			let record: ProviderCallRecordV1;
			try {
				proofSize = enc.bytes.byteLength;
				proofSha = digestSha256(enc.bytes);
				const dec = Reflect.apply(decodeProviderCallRecordV1, undefined, [enc.bytes]);
				if (!dec.ok) {
					return null;
				}
				record = dec.record;
			} finally {
				eraseKnownOwned(enc.bytes);
			}
			normalizedRecords.push(record);
			recordProofs.push(Object.freeze({ size: proofSize, sha256: proofSha }));
			// Erase the original accepted owned buffer from the raw snapshot
			eraseRecordItemOwnedBytes(recordsRawArr[i]);
		}
		// Normalize each receipt through the receipt decoder and verify
		// {sequence, size, sha256} matches the canonical record proof.
		const fileReceipts: DurableReceipt[] = new Array<DurableReceipt>(fileReceiptsRawArr.length);
		for (let i = 0; i < fileReceiptsRawArr.length; i++) {
			const receipt = decodeDurableReceipt(fileReceiptsRawArr[i]);
			if (receipt === null) {
				return null;
			}
			if (receipt.sequence !== i + 1) return null;
			if (receipt.size !== recordProofs[i].size) return null;
			if (receipt.sha256 !== recordProofs[i].sha256) return null;
			fileReceipts[i] = receipt;
		}

		// --- validate totalBytes as safe integer with upper bound ---
		if (
			typeof totalBytesRaw !== "number" ||
			!Number.isSafeInteger(totalBytesRaw) ||
			totalBytesRaw < 0 ||
			totalBytesRaw > MAX_RECOVERY_TOTAL_BYTES
		) {
			return null;
		}

		// --- validate nextJournalSeq: safe integer, >=1, <= MAX_JOURNAL_SEQ+1 ---
		if (
			typeof nextJournalSeqRaw !== "number" ||
			!Number.isSafeInteger(nextJournalSeqRaw) ||
			nextJournalSeqRaw < 1 ||
			nextJournalSeqRaw > MAX_JOURNAL_SEQ + 1
		) {
			return null;
		}

		// --- validate interruptedCallIds: dense array of safe unique strings ---
		const interruptedRawArr = validateDenseArray(interruptedRaw);
		if (interruptedRawArr === null) {
			return null;
		}
		const interruptedSet = new Set<string>();
		for (let i = 0; i < interruptedRawArr.length; i++) {
			const id = interruptedRawArr[i];
			if (typeof id !== "string" || !RELAY_SAFE_ID_RE.test(id)) {
				return null;
			}
			if (interruptedSet.has(id)) {
				return null; // duplicates rejected
			}
			interruptedSet.add(id);
		}

		const byCallId = new Map<string, CallIndexData>();
		const byRequestFrameId = new Map<string, string>();
		const allCallIds: string[] = [];

		// Single pass: process records in strict journalSeq order.
		// Each array entry must have journalSeq === index+1 (absolute sequence order).
		// This enforces chronological ordering: a transition record can never precede
		// its journaled/earlier record because the journaled record will not yet exist
		// in byCallId when an out-of-order transition is encountered.

		for (let i = 0; i < normalizedRecords.length; i++) {
			const record = normalizedRecords[i];
			const expectedSeq = i + 1;
			const receipt = fileReceipts[i];

			// --- absolute sequence ordering ---
			if (record.journalSeq !== expectedSeq) return null;
			if (
				typeof receipt.sequence !== "number" ||
				!Number.isSafeInteger(receipt.sequence) ||
				receipt.sequence !== expectedSeq
			)
				return null;

			// --- receipt integrity (safe integer fields) ---
			if (typeof receipt.size !== "number" || !Number.isSafeInteger(receipt.size) || receipt.size < 1) return null;
			if (typeof receipt.sha256 !== "string" || receipt.sha256.length !== 64) return null;
			for (let j = 0; j < 64; j++) {
				const c = receipt.sha256.charCodeAt(j);
				if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return null;
			}

			// --- output.identity validation ---
			if (
				record.hostId !== identity.hostId ||
				record.generation !== identity.generation ||
				record.sessionId !== identity.sessionId
			) {
				return null;
			}

			// --- exactly one recordKind per record ---
			const rk = record.recordKind;

			// --- journaled: create entry (transition records require existing entry) ---
			if (rk === "journaled") {
				if (byCallId.has(record.callId)) return null; // duplicate callId
				if (byRequestFrameId.has(record.requestFrameId)) return null; // duplicate frameId

				byCallId.set(
					record.callId,
					Object.freeze({
						callId: record.callId,
						requestDigest: record.requestDigest,
						journaledRecord: record,
						journaledReceipt: receipt,
						startedRecord: null,
						startedReceipt: null,
						chunkRecords: Object.freeze([]),
						chunkReceipts: Object.freeze([]),
						terminalRecord: null,
						terminalReceipt: null,
						deliveredRecord: null,
						deliveredReceipt: null,
						cancelRequested: false,
						cancelRequestedRecord: null,
						cancelRequestedReceipt: null,
						computedState: _sJournaled(),
					}),
				);
				byRequestFrameId.set(record.requestFrameId, record.callId);
				allCallIds.push(record.callId);
				continue;
			}

			// --- transitions: entry must already exist (chronology guard) ---
			const entry = byCallId.get(record.callId);
			if (entry === undefined) return null;

			switch (rk) {
				case "started": {
					if (entry.computedState !== "journaled") return null;
					const sr = record;
					if (entry.journaledReceipt === undefined) return null;
					if (
						sr.requestReceipt.sequence !== entry.journaledReceipt.sequence ||
						sr.requestReceipt.size !== entry.journaledReceipt.size ||
						sr.requestReceipt.sha256 !== entry.journaledReceipt.sha256
					) {
						return null;
					}
					if (sr.requestDigest !== entry.requestDigest) return null;
					if (sr.requestJournalSeq !== entry.journaledRecord.journalSeq) return null;
					byCallId.set(
						sr.callId,
						Object.freeze({
							...entry,
							startedRecord: sr,
							startedReceipt: receipt,
							computedState: _sStarted(),
							requestDigest: sr.requestDigest,
						}),
					);
					break;
				}
				case "chunk": {
					if (entry.computedState !== "started" && entry.computedState !== "streaming") return null;
					const cr = record;
					if (cr.chunkIndex !== entry.chunkRecords.length) return null;
					const sorted = Object.freeze([...entry.chunkRecords, cr].sort((a, b) => a.chunkIndex - b.chunkIndex));
					const sortedR = Object.freeze([...entry.chunkReceipts, receipt]);
					byCallId.set(
						cr.callId,
						Object.freeze({
							...entry,
							chunkRecords: sorted,
							chunkReceipts: sortedR,
							computedState: _sStreaming(),
						}),
					);
					break;
				}
				case "terminal": {
					if (entry.computedState !== "started" && entry.computedState !== "streaming") return null;
					const tr = record;
					if (tr.chunkCount !== entry.chunkRecords.length) return null;
					if (tr.terminalKind === "cancelled" && !entry.cancelRequested) return null;
					byCallId.set(
						tr.callId,
						Object.freeze({
							...entry,
							terminalRecord: tr,
							terminalReceipt: receipt,
							computedState: _sTerminal(),
						}),
					);
					break;
				}
				case "delivered": {
					if (entry.computedState !== "terminal") return null;
					const dr = record;
					byCallId.set(
						dr.callId,
						Object.freeze({
							...entry,
							deliveredRecord: dr,
							deliveredReceipt: receipt,
							computedState: _sDelivered(),
						}),
					);
					break;
				}
				case "cancel_requested": {
					if (entry.computedState !== "started" && entry.computedState !== "streaming") return null;
					if (entry.cancelRequested) return null;
					byCallId.set(
						record.callId,
						Object.freeze({
							...entry,
							cancelRequested: true,
							cancelRequestedRecord: record,
							cancelRequestedReceipt: receipt,
						}),
					);
					break;
				}
				default:
					return null; // unknown recordKind
			}
		}

		// Validate no committed transition lacks a receipt
		for (const [, entry] of byCallId) {
			if (entry.journaledReceipt === undefined) return null;
			if (entry.computedState === "started" || entry.computedState === "streaming") {
				if (entry.startedReceipt === undefined) return null;
			}
			if (entry.computedState === "terminal" || entry.computedState === "delivered") {
				if (entry.terminalReceipt === undefined) return null;
			}
			if (entry.computedState === "delivered") {
				if (entry.deliveredReceipt === undefined) return null;
			}
			if (entry.chunkRecords.length !== entry.chunkReceipts.length) return null;
		}

		// Validate nextJournalSeq equals N+1 (or 1 for empty recovery)
		if (normalizedRecords.length > 0) {
			const n = normalizedRecords[normalizedRecords.length - 1].journalSeq;
			if (nextJournalSeqRaw !== n + 1) return null;
		} else {
			if (nextJournalSeqRaw !== 1) return null;
		}

		// Validate totalBytes equals exact sum of receipt sizes (overflow-safe)
		let computedTotalBytes = 0;
		for (let i = 0; i < fileReceipts.length; i++) {
			const s = fileReceipts[i].size;
			if (!Number.isSafeInteger(computedTotalBytes + s)) return null;
			computedTotalBytes += s;
		}
		if (totalBytesRaw !== computedTotalBytes) return null;

		// Validate interruptedCallIds is exactly the unique set of started/streaming calls
		const computedInterrupted: string[] = [];
		for (const [callId, entry] of byCallId) {
			if (entry.computedState === "started" || entry.computedState === "streaming") {
				computedInterrupted.push(callId);
			}
		}
		computedInterrupted.sort();
		const expectedInterrupted = Array.from(interruptedSet).sort();
		if (computedInterrupted.length !== expectedInterrupted.length) return null;
		for (let i = 0; i < computedInterrupted.length; i++) {
			if (computedInterrupted[i] !== expectedInterrupted[i]) return null;
		}

		rebuildKeep = true;
		return Object.freeze({
			byCallId,
			byRequestFrameId,
			allCallIds: Object.freeze(allCallIds),
			nextJournalSeq: nextJournalSeqRaw,
			totalBytes: totalBytesRaw,
		});
	} finally {
		if (!rebuildKeep) eraseNormalizedRecordBuffers(normalizedRecords, normalizedRecords.length);
	}
}

function buildCapability(store: DurableProviderCallStore): ProviderCallStoreCapability {
	return Object.freeze({
		journalProviderCall(r: ProviderCallJournaledRecordV1) {
			return store._journalProviderCallImpl(r);
		},
		journalStarted(callId: string, requestDigest: string, requestReceipt: DurableReceipt, recordedAt: string) {
			return store._journalStartedImpl(callId, requestDigest, requestReceipt, recordedAt);
		},
		journalChunk(r: ProviderCallChunkRecordV1) {
			return store._journalChunkImpl(r);
		},
		journalTerminal(r: ProviderCallTerminalRecordV1) {
			return store._journalTerminalImpl(r);
		},
		journalInterrupted(callId: string, chunkCount: number, recordedAt: string) {
			return store._journalInterruptedImpl(callId, chunkCount, recordedAt);
		},
		markDelivered(
			callId: string,
			ackEnvelopeId: string,
			ackEnvelopeDigest: string,
			outgoingRelayReceipt: DurableReceipt,
			recordedAt: string,
		) {
			return store._markDeliveredImpl(callId, ackEnvelopeId, ackEnvelopeDigest, outgoingRelayReceipt, recordedAt);
		},
		journalCancel(callId: string, recordedAt: string) {
			return store._journalCancelImpl(callId, recordedAt);
		},
		query(callId: string) {
			return store._queryImpl(callId);
		},
		replayOutput(callId: string, cursor: number, maxCount: number) {
			return store._replayOutputImpl(callId, cursor, maxCount);
		},
		replayCallRecords(callId: string) {
			return store._replayCallRecordsImpl(callId);
		},
		replayUndelivered(cursor: number | null, maxCount: number) {
			return store._replayUndeliveredImpl(cursor, maxCount);
		},
		close() {
			if (store._internalGetInsidePublish()) {
				const pResult: StoreResult<void> = Object.freeze({ ok: false, error: Object.freeze({ code: "POISONED" }) });
				return Promise.resolve(pResult);
			}
			try {
				return store._closeImpl();
			} catch {
				const cuResult: StoreResult<void> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "CLOSE_UNCERTAIN" }),
				});
				return Promise.resolve(cuResult);
			}
		},
		status(): Promise<StoreResult<ProviderCallStoreStatus>> {
			if (store._internalGetInsidePublish()) {
				const pResult: StoreResult<void> = Object.freeze({ ok: false, error: Object.freeze({ code: "POISONED" }) });
				return Promise.resolve(pResult);
			}
			return store._internalSerialized(async () => okValue(store._status()));
		},
	});
}
export async function createDurableProviderCallStore(raw: unknown): Promise<StoreResult<ProviderCallStoreCapability>> {
	return await DurableProviderCallStore.create(raw);
}
