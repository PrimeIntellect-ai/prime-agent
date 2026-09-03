/**
 * SandboxCommandStore -- restart-durable store for sandbox command lifecycle
 * records with four variants: pending, started, completed, interrupted.
 *
 * Uses the accepted sandbox-command-record-codec for encode/decode and
 * sandbox-command-recovery for journal recovery.  On startup, every
 * recovered started command without a terminal record gets one real
 * durable CRASH interrupted record before capability exposure.
 *
 * Design follows DurableProviderCallStore ownership/FIFO/receipt/close
 * pattern: preliminary-acquire publisher.close before validation,
 * FIFO serialized operations via tail Promise chain, reentry protection,
 * and publisher-backed durable append with receipt verification.
 *
 * Factory exact input: {identity, publisher, recoveryBackend, recordedAt}.
 * Canonical key is recordedAt.  Scanner owns/closes recovery backend;
 * store exclusively owns publisher.
 *
 * No casts, no any, no dynamic imports, no sync fs.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalDigest, decodeCommandBody, isValidDigest } from "./remote-host-frame-codec.js";
import {
	decodeSandboxCommandRecordV1,
	encodeSandboxCommandRecordV1,
	type SandboxCommandCompletedRecordV1,
	type SandboxCommandInterruptedRecordV1,
	type SandboxCommandPendingRecordV1,
	type SandboxCommandRecordV1,
	type SandboxCommandStartedRecordV1,
} from "./sandbox-command-record-codec.js";
import {
	recoverSandboxCommandJournal,
	type SandboxCommandFileReceipt,
	type SandboxCommandIdentity,
} from "./sandbox-command-recovery.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const MAX_RECOVERY_TOTAL_BYTES = 268_435_456; // 256 MiB
const FILE_MAX_BYTES = 1_310_720; // 1.25 MiB
const RELAY_SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ===========================================================================
// Error codes
// ===========================================================================

export const SANDBOX_COMMAND_STORE_ERRORS = {
	ADMIT_COLLISION: "ADMIT_COLLISION",
	CLOSED: "CLOSED",
	CLOSE_UNCERTAIN: "CLOSE_UNCERTAIN",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	NOT_FOUND: "NOT_FOUND",
	POISONED: "POISONED",
	RECOVERY_FAILED: "RECOVERY_FAILED",
	UNCERTAIN: "UNCERTAIN",
} satisfies Record<string, string>;

export type SandboxCommandStoreErrorCode =
	(typeof SANDBOX_COMMAND_STORE_ERRORS)[keyof typeof SANDBOX_COMMAND_STORE_ERRORS];

// ===========================================================================
// Store result types
// ===========================================================================

type StoreOk<T> = Readonly<{ ok: true; value: T }>;
type StoreErr = Readonly<{ ok: false; error: Readonly<{ code: SandboxCommandStoreErrorCode }> }>;
type StoreResult<T> = StoreOk<T> | StoreErr;

function okValue<T>(value: T): StoreOk<T> {
	return Object.freeze({
		ok: true,
		value: typeof value === "object" && value !== null ? Object.freeze(value) : value,
	});
}

function errValue(code: SandboxCommandStoreErrorCode): StoreErr {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function publicArgFailure(): StoreErr {
	return errValue("INVALID_ARGUMENT");
}

// ===========================================================================
// Publisher types
// ===========================================================================

export interface SandboxCommandPublishOk {
	readonly ok: true;
	readonly receipt: SandboxCommandFileReceipt;
}

export interface SandboxCommandPublisher {
	readonly publish: (seq: number, bytes: Uint8Array) => Promise<SandboxCommandPublishOutcome>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type SandboxCommandPublishOutcome =
	| SandboxCommandPublishOk
	| Readonly<{
			ok: false;
			error: "IO_UNCONFIRMED" | "SEQ_COLLISION" | "POST_PUBLICATION_UNCERTAIN" | "INVALID_ARGUMENT";
	  }>;

// ===========================================================================
// DTO types
// ===========================================================================

export interface SandboxCommandAdmitInput {
	readonly command: Readonly<{ type: "command"; commandId: string; body: Record<string, unknown> }>;
	readonly recordedAt: string;
}

export interface SandboxCommandTransitionInput {
	readonly commandId: string;
	readonly recordedAt: string;
}

export interface SandboxCommandInterruptedInput {
	readonly commandId: string;
	readonly outcome: "INTERRUPTED";
	readonly recordedAt: string;
}

export interface SandboxCommandAdmitResult {
	readonly record: SandboxCommandPendingRecordV1;
	readonly receipt: SandboxCommandFileReceipt;
	readonly sequence: number;
}

export interface SandboxCommandTransitionResult {
	readonly record: SandboxCommandRecordV1;
	readonly receipt: SandboxCommandFileReceipt;
}

export interface SandboxCommandQueryResult {
	readonly commandId: string;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly state: "pending" | "started" | "completed" | "interrupted";
	readonly outcome: "COMPLETED" | "INTERRUPTED" | "CRASH" | null;
	readonly bodyDigest: string;
	readonly commandType: string;
	readonly command: Readonly<{ type: "command"; commandId: string; body: Record<string, unknown> }>;
	readonly record: SandboxCommandRecordV1;
	readonly receipt: SandboxCommandFileReceipt;
}

export interface SandboxCommandReplayEntry {
	readonly record: SandboxCommandPendingRecordV1;
	readonly receipt: SandboxCommandFileReceipt;
}

export interface SandboxCommandReplayPage {
	readonly entries: readonly SandboxCommandReplayEntry[];
	readonly nextCursor: number | null;
}

export interface SandboxCommandStoreStatus {
	readonly commandCount: number;
	readonly recordCount: number;
	readonly totalBytes: number;
	readonly nextSequence: number;
}

// ===========================================================================
// Capability type
// ===========================================================================

export interface SandboxCommandStoreCapability {
	readonly admit: (input: SandboxCommandAdmitInput) => Promise<StoreResult<SandboxCommandAdmitResult>>;
	readonly markStarted: (input: SandboxCommandTransitionInput) => Promise<StoreResult<SandboxCommandTransitionResult>>;
	readonly markCompleted: (
		input: SandboxCommandTransitionInput,
	) => Promise<StoreResult<SandboxCommandTransitionResult>>;
	readonly markInterrupted: (
		input: SandboxCommandInterruptedInput,
	) => Promise<StoreResult<SandboxCommandTransitionResult>>;
	readonly query: (commandId: string) => Promise<StoreResult<SandboxCommandQueryResult>>;
	readonly replayPending: (cursor: number | null, maxCount: number) => Promise<StoreResult<SandboxCommandReplayPage>>;
	readonly status: () => Promise<StoreResult<SandboxCommandStoreStatus>>;
	readonly close: () => Promise<StoreResult<void>>;
}

// ===========================================================================
// Intrinsic erasure
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
		// detached
	}
}

// ===========================================================================
// Digest helper
// ===========================================================================

function digestSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// ===========================================================================
// Field validation helpers
// ===========================================================================

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
// Exact descriptor helpers
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
		if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0 || len > MAX_JOURNAL_SEQ) return null;
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
// Promise observation
// ===========================================================================

async function observeExactNativePromise(raw: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
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

async function observePublisherPublish(rawResult: unknown): Promise<SandboxCommandPublishOutcome> {
	const observed = await observeExactNativePromise(rawResult);
	if (!observed.ok) return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });

	const successCheck = exactDescriptors(observed.value, new Set(["ok", "receipt"]));
	if (successCheck !== null) {
		const okVal = successCheck.ok?.value;
		if (okVal === true) {
			const receiptRaw = successCheck.receipt?.value;
			const receipt = decodeFileReceipt(receiptRaw);
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

// ===========================================================================
// File receipt decoder
// ===========================================================================

function decodeFileReceipt(raw: unknown): SandboxCommandFileReceipt | null {
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
// Mock canonicalDigest for store-level body digest verification
// ===========================================================================

function computedDigest(command: { type: "command"; commandId: string; body: Record<string, unknown> }): string {
	const r = canonicalDigest(command);
	if (r.ok) return r.value;
	return "";
}

// ===========================================================================
// Factory input keys
// ===========================================================================

const FACTORY_KEYS = new Set(["identity", "publisher", "recoveryBackend", "recordedAt"]);
const IDENTITY_KEYS = new Set(["hostId", "generation", "sessionId"]);
const RECOVERY_OUTPUT_KEYS = new Set(["identity", "records", "receipts", "totalBytes", "nextSequence"]);

// ===========================================================================
// Internal index types
// ===========================================================================

type InternalCommandState = "pending" | "started" | "terminal";

interface CommandIndexEntry {
	readonly commandId: string;
	readonly bodyDigest: string;
	readonly commandType: string;
	readonly command: Readonly<{ type: "command"; commandId: string; body: Record<string, unknown> }>;
	readonly pendingRecord: SandboxCommandPendingRecordV1;
	readonly pendingReceipt: SandboxCommandFileReceipt;
	readonly startedRecord: SandboxCommandStartedRecordV1 | null;
	readonly startedReceipt: SandboxCommandFileReceipt | null;
	readonly terminalRecord: SandboxCommandCompletedRecordV1 | SandboxCommandInterruptedRecordV1 | null;
	readonly terminalReceipt: SandboxCommandFileReceipt | null;
	readonly computedOutcome: "COMPLETED" | "INTERRUPTED" | "CRASH" | null;
	readonly computedState: InternalCommandState;
}

interface RecoveredIndex {
	readonly byCommandId: ReadonlyMap<string, CommandIndexEntry>;
	readonly sequenceIndex: readonly string[];
	readonly nextSequence: number;
	readonly totalBytes: number;
}

// ===========================================================================
// Internal state helpers
// ===========================================================================

function sPending(): InternalCommandState {
	return "pending";
}
function sStarted(): InternalCommandState {
	return "started";
}
function sTerminal(): InternalCommandState {
	return "terminal";
}

// ===========================================================================
// Share detection
// ===========================================================================

// ===========================================================================
// Command frame normalizer — validate raw command envelope from public inputs
// ===========================================================================

interface NormalizedCommandFrame {
	readonly type: "command";
	readonly commandId: string;
	readonly body: Record<string, unknown>;
}

function normalizeCommandFrame(raw: unknown): NormalizedCommandFrame | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== 3) return null;
		const allowed = new Set(["type", "commandId", "body"]);
		for (const n of names) {
			if (!allowed.has(n)) return null;
		}
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const n of names) {
			const desc = descs[n];
			if (!desc || !desc.enumerable || !("value" in desc)) return null;
		}
		const typeVal = descs.type?.value;
		if (typeVal !== "command") return null;
		const commandIdVal = descs.commandId?.value;
		if (typeof commandIdVal !== "string" || !RELAY_SAFE_ID_RE.test(commandIdVal)) return null;
		const bodyVal = descs.body?.value;
		// Snapshot body with exact own-enumerable data descriptors before decode.
		// This rejects Proxy/null-proto/symbols/accessors/non-enumerable/extra/undefined.
		if (typeof bodyVal !== "object" || bodyVal === null || Array.isArray(bodyVal)) return null;
		if (types.isProxy(bodyVal)) return null;
		const bodyProto = Object.getPrototypeOf(bodyVal);
		if (bodyProto !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(bodyVal).length !== 0) return null;
		const bodyDescs = Object.getOwnPropertyDescriptors(bodyVal);
		const bodyKeys = Object.getOwnPropertyNames(bodyVal);
		if (bodyKeys.length < 1) return null;
		const bodySnap: Record<string, unknown> = {};
		for (const bk of bodyKeys) {
			const bd = bodyDescs[bk];
			if (!bd || !bd.enumerable || !("value" in bd)) return null;
			if (bd.value === undefined) return null;
			bodySnap[bk] = bd.value;
		}
		// The only nested command input is sync_workspace.artifact. Snapshot it
		// before the shared codec can inspect caller-owned properties.
		if (bodySnap.type === "sync_workspace") {
			const artifactRaw = bodySnap.artifact;
			if (typeof artifactRaw !== "object" || artifactRaw === null || Array.isArray(artifactRaw)) return null;
			if (types.isProxy(artifactRaw) || Object.getPrototypeOf(artifactRaw) !== Object.prototype) return null;
			if (Object.getOwnPropertySymbols(artifactRaw).length !== 0) return null;
			const artifactDescriptors = Object.getOwnPropertyDescriptors(artifactRaw);
			const artifactNames = Object.getOwnPropertyNames(artifactRaw);
			const artifactAllowed = new Set(["workspaceId", "snapshotId", "changesetId"]);
			if (artifactNames.length < 1 || artifactNames.some((name) => !artifactAllowed.has(name))) return null;
			const artifactSnapshot: Record<string, unknown> = {};
			for (const name of artifactNames) {
				const descriptor = artifactDescriptors[name];
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined)
					return null;
				artifactSnapshot[name] = descriptor.value;
			}
			bodySnap.artifact = artifactSnapshot;
		}
		const bodyResult = decodeCommandBody(bodySnap);
		if (!bodyResult.ok) return null;
		return {
			type: "command",
			commandId: commandIdVal,
			body: bodyResult.value,
		};
	} catch {
		return null;
	}
} // ===========================================================================
// Share detection
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
// Index rebuilding
// ===========================================================================

function rebuildIndex(output: unknown, identity: SandboxCommandIdentity): RecoveredIndex | null {
	const descs = exactDescriptors(output, RECOVERY_OUTPUT_KEYS);
	if (descs === null) return null;

	const identityRaw = descs.identity?.value;
	const recordsRaw = descs.records?.value;
	const fileReceiptsRaw = descs.receipts?.value;
	const totalBytesRaw = descs.totalBytes?.value;
	const nextSequenceRaw = descs.nextSequence?.value;

	const identDesc = exactDescriptors(identityRaw, IDENTITY_KEYS);
	if (identDesc === null) return null;
	if (
		identDesc.hostId?.value !== identity.hostId ||
		identDesc.generation?.value !== identity.generation ||
		identDesc.sessionId?.value !== identity.sessionId
	) {
		return null;
	}

	const recordsRawArr = validateDenseArray(recordsRaw);
	if (recordsRawArr === null) return null;
	const fileReceiptsRawArr = validateDenseArray(fileReceiptsRaw);
	if (fileReceiptsRawArr === null) return null;
	if (recordsRawArr.length !== fileReceiptsRawArr.length) return null;

	// Normalize: encode then decode each record, verify against receipt
	const normalizedRecords: SandboxCommandRecordV1[] = [];
	const recordProofs: Array<{ size: number; sha256: string }> = [];
	let rebuildKeep = false;
	try {
		for (let i = 0; i < recordsRawArr.length; i++) {
			const enc = Reflect.apply(encodeSandboxCommandRecordV1, undefined, [recordsRawArr[i]]);
			if (!enc.ok) return null;
			let proofSize = 0;
			let proofSha = "";
			let record: SandboxCommandRecordV1;
			try {
				proofSize = enc.bytes.byteLength;
				proofSha = digestSha256(enc.bytes);
				const dec = Reflect.apply(decodeSandboxCommandRecordV1, undefined, [enc.bytes]);
				if (!dec.ok) return null;
				record = dec.record;
			} finally {
				eraseKnownOwned(enc.bytes);
			}
			normalizedRecords.push(record);
			recordProofs.push(Object.freeze({ size: proofSize, sha256: proofSha }));
		}

		// Verify each file receipt against its proof
		const fileReceipts: SandboxCommandFileReceipt[] = new Array<SandboxCommandFileReceipt>(fileReceiptsRawArr.length);
		for (let i = 0; i < fileReceiptsRawArr.length; i++) {
			const receipt = decodeFileReceipt(fileReceiptsRawArr[i]);
			if (receipt === null) return null;
			if (receipt.sequence !== i + 1) return null;
			if (receipt.size !== recordProofs[i].size) return null;
			if (receipt.sha256 !== recordProofs[i].sha256) return null;
			fileReceipts[i] = receipt;
		}

		if (
			typeof totalBytesRaw !== "number" ||
			!Number.isSafeInteger(totalBytesRaw) ||
			totalBytesRaw < 0 ||
			totalBytesRaw > MAX_RECOVERY_TOTAL_BYTES
		) {
			return null;
		}

		if (
			typeof nextSequenceRaw !== "number" ||
			!Number.isSafeInteger(nextSequenceRaw) ||
			nextSequenceRaw < 1 ||
			nextSequenceRaw > MAX_JOURNAL_SEQ + 1
		) {
			return null;
		}

		// Build index from normalized records
		const byCommandId = new Map<string, CommandIndexEntry>();
		const sequenceIndex: string[] = [];

		for (let i = 0; i < normalizedRecords.length; i++) {
			const record = normalizedRecords[i];
			const expectedSeq = i + 1;
			const receipt = fileReceipts[i];

			if (record.recordSeq !== expectedSeq) return null;
			if (receipt.sequence !== expectedSeq) return null;

			// Validate identity
			if (
				record.hostId !== identity.hostId ||
				record.generation !== identity.generation ||
				record.sessionId !== identity.sessionId
			) {
				return null;
			}

			const rk = record.recordKind;
			const cmdId = record.commandId;

			if (rk === "pending") {
				if (byCommandId.has(cmdId)) return null; // duplicate pending
				if (record.recordKind !== "pending") return null;
				const pendingRecord = record;
				byCommandId.set(
					cmdId,
					Object.freeze({
						commandId: cmdId,
						bodyDigest: pendingRecord.bodyDigest,
						commandType: pendingRecord.commandType,
						command: pendingRecord.command,
						pendingRecord,
						pendingReceipt: receipt,
						startedRecord: null,
						startedReceipt: null,
						terminalRecord: null,
						terminalReceipt: null,
						computedOutcome: null,
						computedState: sPending(),
					}),
				);
				sequenceIndex.push(cmdId);
				continue;
			}

			// Transition records
			const entry = byCommandId.get(cmdId);
			if (entry === undefined) return null;

			switch (rk) {
				case "started": {
					if (entry.computedState !== "pending") return null;
					if (record.recordKind !== "started") return null;
					const startedRecord = record;
					if (startedRecord.bodyDigest !== entry.bodyDigest || startedRecord.commandType !== entry.commandType) {
						return null;
					}
					byCommandId.set(
						cmdId,
						Object.freeze({
							...entry,
							startedRecord,
							startedReceipt: receipt,
							computedState: sStarted(),
						}),
					);
					sequenceIndex.push(cmdId);
					break;
				}
				case "completed": {
					if (entry.computedState !== "started") return null;
					if (record.recordKind !== "completed") return null;
					const completedRecord = record;
					if (
						completedRecord.bodyDigest !== entry.bodyDigest ||
						completedRecord.commandType !== entry.commandType
					) {
						return null;
					}
					byCommandId.set(
						cmdId,
						Object.freeze({
							...entry,
							terminalRecord: completedRecord,
							terminalReceipt: receipt,
							computedOutcome: "COMPLETED",
							computedState: sTerminal(),
						}),
					);
					sequenceIndex.push(cmdId);
					break;
				}
				case "interrupted": {
					if (entry.computedState !== "started") return null;
					if (record.recordKind !== "interrupted") return null;
					const interruptedRecord = record;
					if (
						interruptedRecord.bodyDigest !== entry.bodyDigest ||
						interruptedRecord.commandType !== entry.commandType
					) {
						return null;
					}
					byCommandId.set(
						cmdId,
						Object.freeze({
							...entry,
							terminalRecord: interruptedRecord,
							terminalReceipt: receipt,
							computedOutcome: interruptedRecord.outcome,
							computedState: sTerminal(),
						}),
					);
					sequenceIndex.push(cmdId);
					break;
				}
				default:
					return null;
			}
		}

		// Validate nextSequence
		if (normalizedRecords.length > 0) {
			const last = normalizedRecords[normalizedRecords.length - 1];
			if (nextSequenceRaw !== last.recordSeq + 1) return null;
		} else {
			if (nextSequenceRaw !== 1) return null;
		}

		// Validate totalBytes
		let computedTotalBytes = 0;
		for (let i = 0; i < fileReceipts.length; i++) {
			const s = fileReceipts[i].size;
			if (!Number.isSafeInteger(computedTotalBytes + s)) return null;
			computedTotalBytes += s;
		}
		if (totalBytesRaw !== computedTotalBytes) return null;

		rebuildKeep = true;
		return Object.freeze({
			byCommandId,
			sequenceIndex: Object.freeze(sequenceIndex),
			nextSequence: nextSequenceRaw,
			totalBytes: totalBytesRaw,
		});
	} finally {
		if (!rebuildKeep) {
			// Erase normalized record buffers on failure
			for (const r of normalizedRecords) {
				if (typeof r === "object" && r !== null) {
					// Command records have no byte buffers to erase beyond codec bytes
				}
			}
		}
	}
}

// ===========================================================================
// Build recovery input
// ===========================================================================

function buildRecoveryInput(
	backend: unknown,
	identity: SandboxCommandIdentity,
): Readonly<{ backend: unknown; identity: SandboxCommandIdentity }> {
	return Object.freeze({ backend, identity });
}

// ===========================================================================
// SandboxCommandStore -- internal implementation class
// ===========================================================================

class SandboxCommandStore {
	private readonly _publisher: BoundPublisher;
	private readonly _identity: SandboxCommandIdentity;
	private _index: RecoveredIndex;
	private _tail: Promise<void> = Promise.resolve();
	private _closed = false;
	private _poisoned = false;
	private _insidePublish = false;
	private _closeOwner: (() => Promise<Readonly<{ status: "closed" | "error" }>>) | null = null;
	private _closeP: Promise<StoreResult<void>> | null = null;
	private _closeTail: Promise<void> | null = null;

	private constructor(
		publisher: BoundPublisher,
		identity: SandboxCommandIdentity,
		index: RecoveredIndex,
		closeOnce: () => Promise<Readonly<{ status: "closed" | "error" }>>,
	) {
		this._publisher = publisher;
		this._identity = identity;
		this._index = index;
		this._closeOwner = closeOnce;
	}

	internalGetInsidePublish(): boolean {
		return this._insidePublish;
	}

	internalSerialized<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
		return this._serialized(fn);
	}

	// =========================================================================
	// Factory
	// =========================================================================

	static async create(raw: unknown): Promise<StoreResult<SandboxCommandStoreCapability>> {
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
								status: pDesc.enumerable === true ? "owner" : "owner_uncertain",
								close: (): unknown => Reflect.apply(rawCloseFn, publisherRaw, []),
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
			code: SandboxCommandStoreErrorCode,
			storeToErase?: SandboxCommandStore,
		): Promise<StoreResult<SandboxCommandStoreCapability>> {
			if (storeToErase !== undefined) {
				// Erase store-owned buffers
			}
			const closeResult = await closeOnce();
			if (closeResult.status === "error") return errValue("CLOSE_UNCERTAIN");
			return errValue(code);
		}

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

		// Acquire publisher
		const acquired = acquirePublisher(publisherRaw);
		if (acquired === null) {
			if (prelim.status === "none") return errValue("INVALID_ARGUMENT");
			return await failWith("INVALID_ARGUMENT");
		}
		const publisher = acquired;

		if (prelim.status === "owner") {
			prelim = Object.freeze({
				status: "owner",
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

		const recordedAt = factoryInput.recordedAt?.value;
		if (!safeTimestamp(recordedAt)) return await failWith("INVALID_ARGUMENT");

		// Transfer recovery backend
		const recoveryBackend = factoryInput.recoveryBackend?.value;
		if (sharesPublisherOwner(publisherRaw, recoveryBackend)) {
			return await failWith("INVALID_ARGUMENT");
		}
		const recoveryInput = buildRecoveryInput(recoveryBackend, identity);

		// Run recovery
		let index: RecoveredIndex;
		try {
			const recoveryResult = await recoverSandboxCommandJournal(recoveryInput);
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

		const store = new SandboxCommandStore(publisher, identity, index, closeOnce);

		// Terminalize CRASH for started commands without terminal records
		const crashCommands: string[] = [];
		for (const [cmdId, entry] of store._index.byCommandId) {
			if (entry.computedState === "started" && entry.terminalRecord === null) {
				crashCommands.push(cmdId);
			}
		}
		for (const cmdId of crashCommands) {
			const entry = store._index.byCommandId.get(cmdId);
			if (entry === undefined) return await failWith("RECOVERY_FAILED");
			try {
				const crashResult = await store._crashRecord(cmdId, recordedAt);
				if (!crashResult.ok) {
					const code =
						crashResult.error.code === "INVALID_ARGUMENT" || crashResult.error.code === "NOT_FOUND"
							? "RECOVERY_FAILED"
							: "UNCERTAIN";
					return await failWith(code, store);
				}
			} catch {
				return await failWith("RECOVERY_FAILED", store);
			}
		}

		const cap = buildCapability(store);
		return okValue(cap);
	}

	// =========================================================================
	// CRASH record for started-but-not-terminated commands
	// =========================================================================

	private async _crashRecord(commandId: string, recordedAt: string): Promise<StoreResult<void>> {
		const entry = this._index.byCommandId.get(commandId);
		if (entry === undefined) return errValue("NOT_FOUND");
		if (entry.terminalRecord !== null) return okValue(undefined);

		const seq = this._index.nextSequence;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const crashInput = {
			version: 1,
			recordKind: "interrupted",
			recordSeq: seq,
			commandId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt,
			bodyDigest: entry.bodyDigest,
			commandType: entry.commandType,
			command: entry.command,
			outcome: "CRASH",
		};
		const encoded = encodeSandboxCommandRecordV1(crashInput);
		if (!encoded.ok) return errValue("INVALID_ARGUMENT");
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) {
				this._poisoned = true;
				return errValue("UNCERTAIN");
			}
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "interrupted") return errValue("RECOVERY_FAILED");
			const interruptedRecord = codecRecord;

			this._index = Object.freeze({
				...this._index,
				byCommandId: frozenCloneSet(this._index.byCommandId, commandId, {
					...entry,
					terminalRecord: interruptedRecord,
					terminalReceipt: receipt,
					computedOutcome: "CRASH",
					computedState: sTerminal(),
				}),
				sequenceIndex: Object.freeze([...this._index.sequenceIndex, commandId]),
				nextSequence: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			return okValue(undefined);
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	// =========================================================================
	// Serialization
	// =========================================================================

	private async _serialized<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
		if (this._closed) return errValue("CLOSED");

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
	// Publisher invocation
	// =========================================================================

	private async _invokePublish(seq: number, bytes: Uint8Array): Promise<SandboxCommandPublishOutcome> {
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
		let outcome: SandboxCommandPublishOutcome;
		try {
			outcome = await observePublisherPublish(rawPromise);
		} catch {
			const fallback: SandboxCommandPublishOutcome = Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
			outcome = fallback;
		} finally {
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
	// Private ops
	// =========================================================================

	private _poisonResult(code: SandboxCommandStoreErrorCode): StoreErr {
		this._poisoned = true;
		return errValue(code);
	}

	private _publishError(result: SandboxCommandPublishOutcome): StoreErr {
		if (!result.ok) {
			if (result.error === "IO_UNCONFIRMED" || result.error === "POST_PUBLICATION_UNCERTAIN") {
				this._poisoned = true;
				return errValue("UNCERTAIN");
			}
			if (result.error === "SEQ_COLLISION") {
				this._poisoned = true;
				return errValue("UNCERTAIN");
			}
		}
		return errValue("INVALID_ARGUMENT");
	}

	// =========================================================================
	// admit
	// =========================================================================

	async _admitImpl(input: SandboxCommandAdmitInput): Promise<StoreResult<SandboxCommandAdmitResult>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(() => this._admitOp(input));
	}

	private async _admitOp(input: SandboxCommandAdmitInput): Promise<StoreResult<SandboxCommandAdmitResult>> {
		// Normalize the admit input: validate outer input, command frame, recordedAt
		const snap = exactDescriptors(input, new Set(["command", "recordedAt"]));
		if (snap === null) return publicArgFailure();
		const recordedAtVal = snap.recordedAt?.value;
		if (!safeTimestamp(recordedAtVal)) return publicArgFailure();
		const cmdRaw = snap.command?.value;
		const normalizedCmd = normalizeCommandFrame(cmdRaw);
		if (normalizedCmd === null) return publicArgFailure();
		const cmdId = normalizedCmd.commandId;
		const bodyDigest = computedDigest(normalizedCmd);
		if (bodyDigest.length !== 64) return publicArgFailure();

		// Existing-record idempotency check before sequence checks
		const existing = this._index.byCommandId.get(cmdId);
		if (existing !== undefined) {
			if (existing.bodyDigest === bodyDigest) {
				const _idemCopy = freshRecordCopy(existing.pendingRecord);
				if (_idemCopy === null || _idemCopy.recordKind !== "pending") return errValue("RECOVERY_FAILED");
				return okValue({
					record: _idemCopy,
					receipt: freshReceiptCopy(existing.pendingReceipt),
					sequence: existing.pendingRecord.recordSeq,
				});
			}
			return this._poisonResult("ADMIT_COLLISION");
		}

		const seq = this._index.nextSequence;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const pendingInput = {
			version: 1,
			recordKind: "pending",
			recordSeq: seq,
			commandId: cmdId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt: recordedAtVal,
			bodyDigest,
			commandType: normalizedCmd.body.type,
			command: normalizedCmd,
		};

		const encoded = encodeSandboxCommandRecordV1(pendingInput);
		if (!encoded.ok) return publicArgFailure();
		const codecRecord = encoded.record;
		try {
			if (codecRecord.recordKind !== "pending") return publicArgFailure();

			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			if (codecRecord.recordKind !== "pending") return publicArgFailure();
			const pendingRecord = codecRecord;

			this._index = Object.freeze({
				byCommandId: frozenCloneAdd(this._index.byCommandId, cmdId, {
					commandId: cmdId,
					bodyDigest,
					commandType: pendingRecord.commandType,
					command: pendingRecord.command,
					pendingRecord,
					pendingReceipt: receipt,
					startedRecord: null,
					startedReceipt: null,
					terminalRecord: null,
					terminalReceipt: null,
					computedOutcome: null,
					computedState: sPending(),
				}),
				sequenceIndex: Object.freeze([...this._index.sequenceIndex, cmdId]),
				nextSequence: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			const _newCopy = freshRecordCopy(pendingRecord);
			if (_newCopy === null || _newCopy.recordKind !== "pending") return errValue("RECOVERY_FAILED");
			return okValue({
				record: _newCopy,
				receipt: freshReceiptCopy(receipt),
				sequence: seq,
			});
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	// =========================================================================
	// markStarted
	// =========================================================================

	async _markStartedImpl(input: SandboxCommandTransitionInput): Promise<StoreResult<SandboxCommandTransitionResult>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(() => this._markStartedOp(input));
	}

	private async _markStartedOp(
		input: SandboxCommandTransitionInput,
	): Promise<StoreResult<SandboxCommandTransitionResult>> {
		const snap = exactDescriptors(input, new Set(["commandId", "recordedAt"]));
		if (snap === null) return publicArgFailure();
		const cmdIdIn = snap.commandId?.value;
		const recordedAtIn = snap.recordedAt?.value;
		if (!safeId(cmdIdIn) || !safeTimestamp(recordedAtIn)) return publicArgFailure();

		const entry = this._index.byCommandId.get(cmdIdIn);
		if (entry === undefined) return errValue("NOT_FOUND");

		if (entry.startedRecord !== null) {
			// Idempotent: return stored started receipt regardless of current state
			const sr = entry.startedRecord;
			const srReceipt = entry.startedReceipt;
			if (srReceipt !== null) {
				const record = freshRecordCopy(sr);
				return record === null
					? errValue("RECOVERY_FAILED")
					: okValue({ record, receipt: freshReceiptCopy(srReceipt) });
			}
			return errValue("RECOVERY_FAILED");
		}

		if (entry.computedState !== "pending") return errValue("INVALID_ARGUMENT");

		const seq = this._index.nextSequence;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const startedInput = {
			version: 1,
			recordKind: "started",
			recordSeq: seq,
			commandId: cmdIdIn,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt: recordedAtIn,
			bodyDigest: entry.bodyDigest,
			commandType: entry.commandType,
			command: entry.command,
		};

		const encoded = encodeSandboxCommandRecordV1(startedInput);
		if (!encoded.ok) return publicArgFailure();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "started") return publicArgFailure();
			const startedRecord = codecRecord;

			this._index = Object.freeze({
				...this._index,
				byCommandId: frozenCloneSet(this._index.byCommandId, cmdIdIn, {
					...entry,
					startedRecord,
					startedReceipt: receipt,
					computedState: sStarted(),
				}),
				sequenceIndex: Object.freeze([...this._index.sequenceIndex, cmdIdIn]),
				nextSequence: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			const record = freshRecordCopy(startedRecord);
			return record === null ? errValue("RECOVERY_FAILED") : okValue({ record, receipt: freshReceiptCopy(receipt) });
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	// =========================================================================
	// markCompleted
	// =========================================================================

	async _markCompletedImpl(
		input: SandboxCommandTransitionInput,
	): Promise<StoreResult<SandboxCommandTransitionResult>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(() => this._markCompletedOp(input));
	}

	private async _markCompletedOp(
		input: SandboxCommandTransitionInput,
	): Promise<StoreResult<SandboxCommandTransitionResult>> {
		const snap = exactDescriptors(input, new Set(["commandId", "recordedAt"]));
		if (snap === null) return publicArgFailure();
		const cmdIdIn = snap.commandId?.value;
		const recordedAtIn = snap.recordedAt?.value;
		if (!safeId(cmdIdIn) || !safeTimestamp(recordedAtIn)) return publicArgFailure();

		const entry = this._index.byCommandId.get(cmdIdIn);
		if (entry === undefined) return errValue("NOT_FOUND");

		if (entry.terminalRecord !== null) {
			// Idempotent: same terminal outcome
			const tr = entry.terminalRecord;
			const trReceipt = entry.terminalReceipt;
			if (trReceipt !== null && tr.recordKind === "completed" && tr.outcome === "COMPLETED") {
				const record = freshRecordCopy(tr);
				return record === null
					? errValue("RECOVERY_FAILED")
					: okValue({ record, receipt: freshReceiptCopy(trReceipt) });
			}
			if (trReceipt !== null) return this._poisonResult("ADMIT_COLLISION");
			return errValue("RECOVERY_FAILED");
		}

		if (entry.computedState !== "started") return errValue("INVALID_ARGUMENT");

		const seq = this._index.nextSequence;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const completedInput = {
			version: 1,
			recordKind: "completed",
			recordSeq: seq,
			commandId: cmdIdIn,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt: recordedAtIn,
			bodyDigest: entry.bodyDigest,
			commandType: entry.commandType,
			command: entry.command,
			outcome: "COMPLETED",
		};

		const encoded = encodeSandboxCommandRecordV1(completedInput);
		if (!encoded.ok) return publicArgFailure();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "completed") return publicArgFailure();
			const completedRecord = codecRecord;

			this._index = Object.freeze({
				...this._index,
				byCommandId: frozenCloneSet(this._index.byCommandId, cmdIdIn, {
					...entry,
					terminalRecord: completedRecord,
					terminalReceipt: receipt,
					computedOutcome: "COMPLETED",
					computedState: sTerminal(),
				}),
				sequenceIndex: Object.freeze([...this._index.sequenceIndex, cmdIdIn]),
				nextSequence: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			const record = freshRecordCopy(completedRecord);
			return record === null ? errValue("RECOVERY_FAILED") : okValue({ record, receipt: freshReceiptCopy(receipt) });
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	// =========================================================================
	// markInterrupted
	// =========================================================================

	async _markInterruptedImpl(
		input: SandboxCommandInterruptedInput,
	): Promise<StoreResult<SandboxCommandTransitionResult>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(() => this._markInterruptedOp(input));
	}

	private async _markInterruptedOp(
		input: SandboxCommandInterruptedInput,
	): Promise<StoreResult<SandboxCommandTransitionResult>> {
		const snap = exactDescriptors(input, new Set(["commandId", "outcome", "recordedAt"]));
		if (snap === null) return publicArgFailure();
		const cmdIdIn = snap.commandId?.value;
		const outcomeIn = snap.outcome?.value;
		const recordedAtIn = snap.recordedAt?.value;
		if (!safeId(cmdIdIn) || outcomeIn !== "INTERRUPTED" || !safeTimestamp(recordedAtIn)) return publicArgFailure();

		const entry = this._index.byCommandId.get(cmdIdIn);
		if (entry === undefined) return errValue("NOT_FOUND");

		if (entry.terminalRecord !== null) {
			const tr = entry.terminalRecord;
			const trReceipt = entry.terminalReceipt;
			if (trReceipt !== null && tr.recordKind === "interrupted" && tr.outcome === outcomeIn) {
				const record = freshRecordCopy(tr);
				return record === null
					? errValue("RECOVERY_FAILED")
					: okValue({ record, receipt: freshReceiptCopy(trReceipt) });
			}
			if (trReceipt !== null) return this._poisonResult("ADMIT_COLLISION");
			return errValue("RECOVERY_FAILED");
		}

		if (entry.computedState !== "started") return errValue("INVALID_ARGUMENT");

		const seq = this._index.nextSequence;
		if (seq > MAX_JOURNAL_SEQ) return errValue("UNCERTAIN");

		const interruptedInput = {
			version: 1,
			recordKind: "interrupted",
			recordSeq: seq,
			commandId: cmdIdIn,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			recordedAt: recordedAtIn,
			bodyDigest: entry.bodyDigest,
			commandType: entry.commandType,
			command: entry.command,
			outcome: "INTERRUPTED",
		};

		const encoded = encodeSandboxCommandRecordV1(interruptedInput);
		if (!encoded.ok) return publicArgFailure();
		try {
			const publishResult = await this._invokePublish(seq, encoded.bytes);
			if (!publishResult.ok) return this._publishError(publishResult);
			const receipt = publishResult.receipt;

			const codecRecord = encoded.record;
			if (codecRecord.recordKind !== "interrupted") return publicArgFailure();
			const interruptedRecord = codecRecord;

			this._index = Object.freeze({
				...this._index,
				byCommandId: frozenCloneSet(this._index.byCommandId, cmdIdIn, {
					...entry,
					terminalRecord: interruptedRecord,
					terminalReceipt: receipt,
					computedOutcome: "INTERRUPTED",
					computedState: sTerminal(),
				}),
				sequenceIndex: Object.freeze([...this._index.sequenceIndex, cmdIdIn]),
				nextSequence: seq + 1,
				totalBytes: this._index.totalBytes + receipt.size,
			});

			const record = freshRecordCopy(interruptedRecord);
			return record === null ? errValue("RECOVERY_FAILED") : okValue({ record, receipt: freshReceiptCopy(receipt) });
		} finally {
			eraseKnownOwned(encoded.bytes);
		}
	}

	// =========================================================================
	// query
	// =========================================================================

	async _queryImpl(commandId: string): Promise<StoreResult<SandboxCommandQueryResult>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(async () => this._queryOp(commandId));
	}

	private async _queryOp(commandId: string): Promise<StoreResult<SandboxCommandQueryResult>> {
		if (!safeId(commandId)) return publicArgFailure();

		const entry = this._index.byCommandId.get(commandId);
		if (entry === undefined) return errValue("NOT_FOUND");

		let state: "pending" | "started" | "completed" | "interrupted";
		let outcome: "COMPLETED" | "INTERRUPTED" | "CRASH" | null = null;

		switch (entry.computedState) {
			case "pending":
				state = "pending";
				break;
			case "started":
				state = "started";
				break;
			case "terminal": {
				const tr = entry.terminalRecord;
				if (tr !== null) {
					state = tr.recordKind === "completed" ? "completed" : "interrupted";
					outcome = entry.computedOutcome;
				} else {
					state = "interrupted";
					outcome = "CRASH";
				}
				break;
			}
			default:
				state = "pending";
		}

		const record = freshRecordCopy(entry.terminalRecord ?? entry.startedRecord ?? entry.pendingRecord);
		if (record === null) return errValue("RECOVERY_FAILED");
		const receipt = freshReceiptCopy(entry.terminalReceipt ?? entry.startedReceipt ?? entry.pendingReceipt);

		return okValue({
			commandId: entry.commandId,
			hostId: this._identity.hostId,
			generation: this._identity.generation,
			sessionId: this._identity.sessionId,
			state,
			outcome,
			bodyDigest: entry.bodyDigest,
			commandType: entry.commandType,
			command: record.command,
			record,
			receipt,
		});
	}

	// =========================================================================
	// replayPending
	// =========================================================================

	async _replayPendingImpl(cursor: number | null, maxCount: number): Promise<StoreResult<SandboxCommandReplayPage>> {
		if (this._insidePublish) return errValue("POISONED");
		return await this._serialized(async () => this._replayPendingOp(cursor, maxCount));
	}

	private async _replayPendingOp(
		cursor: number | null,
		maxCount: number,
	): Promise<StoreResult<SandboxCommandReplayPage>> {
		if (
			typeof maxCount !== "number" ||
			!Number.isSafeInteger(maxCount) ||
			maxCount < 1 ||
			maxCount > MAX_JOURNAL_SEQ
		) {
			return publicArgFailure();
		}
		if (cursor !== null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) {
			return publicArgFailure();
		}

		const sequenceIndex = this._index.sequenceIndex;
		const seqLen = sequenceIndex.length;
		let startSeq = 0;
		if (cursor !== null) {
			startSeq = cursor;
		}
		if (startSeq >= seqLen) {
			return okValue({
				entries: Object.freeze([]),
				nextCursor: null,
			});
		}

		const endSeq = Math.min(startSeq + maxCount, seqLen);
		const entries: SandboxCommandReplayEntry[] = [];

		for (let seq = startSeq; seq < endSeq; seq++) {
			const cmdId = sequenceIndex[seq];
			const entry = this._index.byCommandId.get(cmdId);
			if (entry === undefined) return errValue("RECOVERY_FAILED");
			if (entry.computedState === "pending") {
				const _replayRec = freshRecordCopy(entry.pendingRecord);
				if (_replayRec === null || _replayRec.recordKind !== "pending") return errValue("RECOVERY_FAILED");
				entries.push(
					Object.freeze({
						record: _replayRec,
						receipt: freshReceiptCopy(entry.pendingReceipt),
					}),
				);
			}
		}

		const nextCursor = endSeq < seqLen ? endSeq : null;

		return okValue({
			entries: Object.freeze(entries),
			nextCursor,
		});
	} // =========================================================================
	// status
	// =========================================================================

	_status(): SandboxCommandStoreStatus {
		return Object.freeze({
			commandCount: this._index.byCommandId.size,
			recordCount: this._index.sequenceIndex.length,
			totalBytes: this._index.totalBytes,
			nextSequence: this._index.nextSequence,
		});
	}

	// =========================================================================
	// close
	// =========================================================================

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
}

// ===========================================================================
// Frozen clone helpers
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

// ===========================================================================
// buildCapability
// ===========================================================================

// ===========================================================================

// ===========================================================================
// freshRecordCopy — re-encode via codec for a fully normalized frozen copy
// ===========================================================================

function freshRecordCopy(record: SandboxCommandRecordV1): SandboxCommandRecordV1 | null {
	const encoded = encodeSandboxCommandRecordV1(record);
	if (!encoded.ok) return null;
	try {
		const decoded = decodeSandboxCommandRecordV1(encoded.bytes);
		return decoded.ok ? decoded.record : null;
	} finally {
		eraseKnownOwned(encoded.bytes);
	}
}

// ===========================================================================
// freshReceiptCopy — exact literal copy
// ===========================================================================

function freshReceiptCopy(receipt: SandboxCommandFileReceipt): SandboxCommandFileReceipt {
	return Object.freeze({
		sequence: receipt.sequence,
		size: receipt.size,
		sha256: receipt.sha256,
	});
}
function buildCapability(store: SandboxCommandStore): SandboxCommandStoreCapability {
	return Object.freeze({
		admit(input: SandboxCommandAdmitInput) {
			return store._admitImpl(input);
		},
		markStarted(input: SandboxCommandTransitionInput) {
			return store._markStartedImpl(input);
		},
		markCompleted(input: SandboxCommandTransitionInput) {
			return store._markCompletedImpl(input);
		},
		markInterrupted(input: SandboxCommandInterruptedInput) {
			return store._markInterruptedImpl(input);
		},
		query(commandId: string) {
			return store._queryImpl(commandId);
		},
		replayPending(cursor: number | null, maxCount: number) {
			return store._replayPendingImpl(cursor, maxCount);
		},
		status(): Promise<StoreResult<SandboxCommandStoreStatus>> {
			if (store.internalGetInsidePublish()) {
				const pResult: StoreResult<void> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "POISONED" }),
				});
				return Promise.resolve(pResult);
			}
			return store.internalSerialized(async () => okValue(store._status()));
		},
		close() {
			if (store.internalGetInsidePublish()) {
				const pResult: StoreResult<void> = Object.freeze({
					ok: false,
					error: Object.freeze({ code: "POISONED" }),
				});
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
	});
}

// ===========================================================================
// Public factory
// ===========================================================================

export async function createSandboxCommandStore(raw: unknown): Promise<StoreResult<SandboxCommandStoreCapability>> {
	return await SandboxCommandStore.create(raw);
}
