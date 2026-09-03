/**
 * ProviderCallJournal recovery scanner — reads durable provider-call journal
 * files through a paginated backend, validates per-call state machines,
 * and returns a deep-frozen recovered snapshot.
 *
 * Pure scanner: no store, publisher, provider execution, or filesystem
 * backend included.  Backend is injected at the call site.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ProviderCallRecordV1 } from "./provider-call-record-codec.js";
import { decodeProviderCallRecordV1 } from "./provider-call-record-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const PAGE_MAX_ENTRIES = 64;
const PAGE_MAX_BYTES = 16_777_216; // 16 MiB
const TOTAL_MAX_BYTES = 268_435_456; // 256 MiB
const FILE_MAX_BYTES = 1_310_720; // 1.25 MiB
const READ_MAX_BYTES = 65_536; // 64 KiB
const MAX_FILES = 20_000;
const MAX_PAGES = MAX_FILES;
const PROMISE_TIMEOUT_MS = 30_000; // 30 s

const FILE_NAME = /^(\d{20})\.b10-provider-call$/;
const CURSOR = /^[A-Za-z0-9._~-]{1,256}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

const INPUT_KEYS = new Set(["backend", "identity"]);
const IDENTITY_KEYS = new Set(["hostId", "generation", "sessionId"]);
const BACKEND_KEYS = new Set(["listPage", "open", "close"]);
const PAGE_RESULT_KEYS = new Set(["status", "entries", "nextCursor", "close"]);
const ENTRY_KEYS = new Set(["name", "stat"]);
const STAT_KEYS = new Set(["ctimeNs", "dev", "ino", "isFile", "isSymlink", "mode", "mtimeNs", "nlink", "size", "uid"]);
const OPEN_MISSING_KEYS = new Set(["status"]);
const OPENED_KEYS = new Set(["status", "handle"]);
const HANDLE_KEYS = new Set(["readAt", "confirmEof", "fstat", "close"]);
const STATUS_KEYS = new Set(["status"]);
const BYTES_KEYS = new Set(["status", "bytes"]);
const CLOSED_STATUS_KEYS = new Set(["status"]);

// ===========================================================================
// Error codes
// ===========================================================================

export const PROVIDER_RECOVERY_ERRORS = Object.freeze({
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	RECOVERY_FAILED: "RECOVERY_FAILED",
	IO_UNCONFIRMED: "IO_UNCONFIRMED",
	CLOSE_UNCERTAIN: "CLOSE_UNCERTAIN",
});

export type ProviderRecoveryErrorCode = (typeof PROVIDER_RECOVERY_ERRORS)[keyof typeof PROVIDER_RECOVERY_ERRORS];

// ===========================================================================
// Input/output types
// ===========================================================================

export interface ProviderCallIdentity {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
}

export interface ProviderCallEntryStat {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly mode: number;
	readonly size: number;
	readonly nlink: number;
	readonly isFile: boolean;
	readonly isSymlink: boolean;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
}

export interface ProviderCallEntry {
	readonly name: string;
	readonly stat: ProviderCallEntryStat;
}

export interface ProviderCallListPageRequest {
	readonly cursor: string | null;
	readonly maxEntries: 64;
	readonly maxBytes: 16_777_216;
}

export interface ProviderCallPageResult {
	readonly status: "page";
	readonly entries: readonly ProviderCallEntry[];
	readonly nextCursor: string | null;
	readonly close: () => unknown;
}

export interface ProviderCallOpenRequest {
	readonly name: string;
	readonly expected: ProviderCallEntryStat;
}

export interface ProviderCallReadHandle {
	readonly readAt: (offset: number, size: number) => unknown;
	readonly confirmEof: (size: number) => unknown;
	readonly fstat: () => unknown;
	readonly close: () => unknown;
}

export type ProviderCallOpenResult =
	| Readonly<{ status: "opened"; handle: ProviderCallReadHandle }>
	| Readonly<{ status: "missing" }>;

export interface ProviderCallBackend {
	readonly listPage: (request: ProviderCallListPageRequest) => unknown;
	readonly open: (request: ProviderCallOpenRequest) => unknown;
	readonly close: () => unknown;
}

export interface ProviderCallRecoveryInput {
	readonly backend: ProviderCallBackend;
	readonly identity: ProviderCallIdentity;
}

// ===========================================================================
// Output types
// ===========================================================================

export interface ProviderCallRecoveryOutput {
	readonly identity: ProviderCallIdentity;
	readonly records: readonly ProviderCallRecordV1[];
	readonly totalBytes: number;
	readonly nextJournalSeq: number;
	readonly interruptedCallIds: readonly string[];
}

export interface ProviderCallRecoveryOk {
	readonly ok: true;
	readonly value: ProviderCallRecoveryOutput;
}

export interface ProviderCallRecoveryError {
	readonly ok: false;
	readonly error: Readonly<{ code: ProviderRecoveryErrorCode }>;
}

export type ProviderCallRecoveryResult = ProviderCallRecoveryOk | ProviderCallRecoveryError;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

type BoundBackend = Readonly<{
	listPage: (request: ProviderCallListPageRequest) => unknown;
	open: (request: ProviderCallOpenRequest) => unknown;
}>;

type BoundHandle = Readonly<{
	readAt: (offset: number, size: number) => unknown;
	confirmEof: (size: number) => unknown;
	fstat: () => unknown;
}>;

type ParsedName = Readonly<{ sequence: number }>;

/** Observation result union — no Error objects are created or propagated. */
type ObserveResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;

// ===========================================================================
// Helpers
// ===========================================================================

function fail(code: ProviderRecoveryErrorCode): ProviderCallRecoveryError {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code }),
	});
}

// ---------------------------------------------------------------------------
// exactDtor   – validate a plain object has exactly the given own property set
// ---------------------------------------------------------------------------

function exactDtor(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((n) => !keys.has(n))) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const desc = descs[name];
			if (!desc || !("value" in desc) || !desc.enumerable) return null;
		}
		return descs;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// methodFn    – pull a function-typed own data descriptor, reject Proxy
// ---------------------------------------------------------------------------

function methodFn(values: Descriptors, owner: object, name: string): ((...args: readonly unknown[]) => unknown) | null {
	const desc = values[name];
	if (!desc || !("value" in desc) || typeof desc.value !== "function") return null;
	try {
		if (types.isProxy(desc.value)) return null;
	} catch {
		return null;
	}
	const rawFn = desc.value;
	return (...args: readonly unknown[]): unknown => Reflect.apply(rawFn, owner, args);
}

// ---------------------------------------------------------------------------
// validId    – printable ASCII, 1..128 chars
// ---------------------------------------------------------------------------

function validId(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	for (let i = 0; i < raw.length; i += 1) {
		const code = raw.charCodeAt(i);
		if (code <= 0x20 || code >= 0x7f) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// snapshotIdentity
// ---------------------------------------------------------------------------

function snapshotIdentity(raw: unknown): ProviderCallIdentity | null {
	const values = exactDtor(raw, IDENTITY_KEYS);
	if (!values) return null;
	const hostId = values.hostId?.value;
	const generation = values.generation?.value;
	const sessionId = values.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

// ---------------------------------------------------------------------------
// bindBackend – extract listPage & open (close extracted upstream)
// ---------------------------------------------------------------------------

function bindBackend(raw: unknown): BoundBackend | null {
	const values = exactDtor(raw, BACKEND_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const listPage = methodFn(values, raw, "listPage");
	const open = methodFn(values, raw, "open");
	if (!listPage || !open) return null;
	return Object.freeze({
		listPage: (request: ProviderCallListPageRequest): unknown => Reflect.apply(listPage, undefined, [request]),
		open: (request: ProviderCallOpenRequest): unknown => Reflect.apply(open, undefined, [request]),
	});
}

// ---------------------------------------------------------------------------
// decimal / safeInteger
// ---------------------------------------------------------------------------

function decimal(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length <= 64 && DECIMAL.test(raw);
}

function safeInteger(raw: unknown): raw is number {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

// ---------------------------------------------------------------------------
// snapshotStat
// ---------------------------------------------------------------------------

function snapshotStat(raw: unknown): ProviderCallEntryStat | null {
	const value = exactDtor(raw, STAT_KEYS);
	if (!value) return null;
	const dev = value.dev?.value;
	const ino = value.ino?.value;
	const uid = value.uid?.value;
	const mode = value.mode?.value;
	const size = value.size?.value;
	const nlink = value.nlink?.value;
	const isFile = value.isFile?.value;
	const isSymlink = value.isSymlink?.value;
	const mtimeNs = value.mtimeNs?.value;
	const ctimeNs = value.ctimeNs?.value;
	if (
		!decimal(dev) ||
		!decimal(ino) ||
		!decimal(uid) ||
		!safeInteger(mode) ||
		!safeInteger(size) ||
		!safeInteger(nlink) ||
		typeof isFile !== "boolean" ||
		typeof isSymlink !== "boolean" ||
		!decimal(mtimeNs) ||
		!decimal(ctimeNs)
	)
		return null;
	return Object.freeze({
		dev,
		ino,
		uid,
		mode,
		size,
		nlink,
		isFile,
		isSymlink,
		mtimeNs,
		ctimeNs,
	});
}

// ---------------------------------------------------------------------------
// snapshotEntry
// ---------------------------------------------------------------------------

function snapshotEntry(raw: unknown): ProviderCallEntry | null {
	const value = exactDtor(raw, ENTRY_KEYS);
	if (!value) return null;
	const name = value.name?.value;
	const stat = snapshotStat(value.stat?.value);
	return typeof name === "string" && stat ? Object.freeze({ name, stat }) : null;
}

// ---------------------------------------------------------------------------
// ownData
// ---------------------------------------------------------------------------

function ownData(raw: unknown, name: string): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
		const desc = Object.getOwnPropertyDescriptor(raw, name);
		return desc && "value" in desc ? desc.value : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// discoverClose – extract bare close function from own descriptor, reject
//                 Proxy / non-function / accessor / custom proto.
// ---------------------------------------------------------------------------

function discoverClose(raw: unknown): (() => unknown) | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const desc = Object.getOwnPropertyDescriptor(raw, "close");
		if (!desc || !("value" in desc) || typeof desc.value !== "function" || types.isProxy(desc.value)) return null;
		const closeFn = desc.value;
		return (): unknown => Reflect.apply(closeFn, raw, []);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// consumeCloseOnce – wrap a close function so it can be called at most once
// ---------------------------------------------------------------------------

function consumeCloseOnce(closeFn: () => unknown): () => unknown {
	let called = false;
	return (): unknown => {
		if (called) return undefined;
		called = true;
		return closeFn();
	};
}

// ---------------------------------------------------------------------------
// observeExact – validate a host-guaranteed bare native Promise and observe
//                it, returning an ObserveResult union (no Error objects).
//
// Validates: non-proxy, Promise.prototype, zero own names/symbols,
// types.isPromise.  Uses Reflect.apply(Promise.prototype.then, raw, [])
// to avoid invoking any custom-then from a hostile object that somehow
// passed the own-property check.  Bounded referenced timer.
// ---------------------------------------------------------------------------

function observeExact(raw: unknown, timeout: number = PROMISE_TIMEOUT_MS): Promise<ObserveResult> {
	return new Promise<ObserveResult>((resolve) => {
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
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Promise.prototype) {
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
		}, timeout);

		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					clearTimeout(timer);
					resolve({ ok: true, value });
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

// ---------------------------------------------------------------------------
// checkedCloseExact – observe a close function via observeExact and verify
//                     the result is {status:"closed"}.
//                     No arbitrary await closeFn() / thenables.
// ---------------------------------------------------------------------------

async function checkedCloseExact(closeFn: () => unknown): Promise<boolean> {
	try {
		const raw = closeFn();
		const observed = await observeExact(raw);
		if (!observed.ok) return false;
		const result = exactDtor(observed.value, CLOSED_STATUS_KEYS);
		return result?.status?.value === "closed";
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// eraseTransferred – zero-fill a Uint8Array in place
// ---------------------------------------------------------------------------

function eraseTransferred(raw: unknown): void {
	const taProto = Object.getPrototypeOf(Uint8Array.prototype);
	const byteLengthGetter = Object.getOwnPropertyDescriptor(taProto, "byteLength")?.get;
	try {
		if (typeof raw !== "object" || raw === null || types.isProxy(raw) || !byteLengthGetter) return;
		const length = Reflect.apply(byteLengthGetter, raw, []);
		if (typeof length === "number" && length > 0) Reflect.apply(Uint8Array.prototype.fill, raw, [0]);
	} catch {
		// Not safely writable.
	}
}

// ---------------------------------------------------------------------------
// exactTransferred – validate a full-backing genuine Uint8Array with no own
//                    property overrides on the prototype chain getters, no
//                    named extras, dense numeric indices, zero-offset and
//                    zero-own-buffer.
// ---------------------------------------------------------------------------

function exactTransferred(raw: unknown): raw is Uint8Array {
	const taProto = Object.getPrototypeOf(Uint8Array.prototype);
	const byteLengthGetter = Object.getOwnPropertyDescriptor(taProto, "byteLength")?.get;
	const byteOffsetGetter = Object.getOwnPropertyDescriptor(taProto, "byteOffset")?.get;
	const bufferGetter = Object.getOwnPropertyDescriptor(taProto, "buffer")?.get;
	const abLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			!byteLengthGetter ||
			!byteOffsetGetter ||
			!bufferGetter ||
			!abLengthGetter
		)
			return false;
		if (
			Object.getOwnPropertyDescriptor(raw, "buffer") ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset")
		)
			return false;
		const ownNames = Object.getOwnPropertyNames(raw);
		const byteLength = Reflect.apply(byteLengthGetter, raw, []);
		if (typeof byteLength !== "number" || ownNames.length !== byteLength) return false;
		for (let i = 0; i < byteLength; i++) {
			if (ownNames[i] !== String(i)) return false;
		}
		const byteOffset = Reflect.apply(byteOffsetGetter, raw, []);
		const buffer = Reflect.apply(bufferGetter, raw, []);
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(abLengthGetter, buffer, []);
		return (
			typeof byteOffset === "number" &&
			typeof backingLength === "number" &&
			byteOffset === 0 &&
			byteLength === backingLength &&
			byteLength > 0
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// bindHandle – extracts readAt, confirmEof, fstat (but NOT close – that is
//              acquired separately before validation)
// ---------------------------------------------------------------------------

function bindHandle(raw: unknown): BoundHandle | null {
	const values = exactDtor(raw, HANDLE_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const readAt = methodFn(values, raw, "readAt");
	const confirmEof = methodFn(values, raw, "confirmEof");
	const fstat = methodFn(values, raw, "fstat");
	if (!readAt || !confirmEof || !fstat) return null;
	return Object.freeze({
		readAt: (offset: number, size: number): unknown => Reflect.apply(readAt, undefined, [offset, size]),
		confirmEof: (size: number): unknown => Reflect.apply(confirmEof, undefined, [size]),
		fstat: (): unknown => Reflect.apply(fstat, undefined, []),
	});
}

// ---------------------------------------------------------------------------
// parseName
// ---------------------------------------------------------------------------

function parseName(name: string): ParsedName | null {
	const match = FILE_NAME.exec(name);
	if (!match) return null;
	const seqStr = match[1];
	const sequence = Number(seqStr);
	if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_FILES) return null;
	return Object.freeze({ sequence });
}

// ---------------------------------------------------------------------------
// statEqual
// ---------------------------------------------------------------------------

function statEqual(left: ProviderCallEntryStat, right: ProviderCallEntryStat): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.nlink === right.nlink &&
		left.isFile === right.isFile &&
		left.isSymlink === right.isSymlink &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

// ---------------------------------------------------------------------------
// parseAndClosePage – validate page shape, snapshot entries, close page
//
// "acquire page.close before page validation" – close is extracted first,
// before validating page content.  Then validate entries, then close page
// before returning.  close dominance reported.
// ---------------------------------------------------------------------------

interface ParsedPage {
	readonly entries: readonly ProviderCallEntry[];
	readonly nextCursor: string | null;
}

async function parseAndClosePage(
	raw: unknown,
): Promise<{ ok: true; page: ParsedPage; closeOk: boolean } | { ok: false; closeOk: boolean }> {
	// --- acquire close BEFORE validation ---
	const pageClose = discoverClose(raw);

	const value = exactDtor(raw, PAGE_RESULT_KEYS);
	if (!value) {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}
	if (value.status?.value !== "page") {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}

	const entriesRaw = value.entries?.value;
	const nextCursor = value.nextCursor?.value;
	const closeRaw = value.close?.value;

	// Validate entries array
	if (!Array.isArray(entriesRaw)) {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}
	try {
		if (
			types.isProxy(entriesRaw) ||
			Object.getPrototypeOf(entriesRaw) !== Array.prototype ||
			Object.getOwnPropertySymbols(entriesRaw).length !== 0
		) {
			const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
			return { ok: false, closeOk };
		}
	} catch {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}

	if (entriesRaw.length > PAGE_MAX_ENTRIES) {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}

	if (nextCursor !== null && (typeof nextCursor !== "string" || !CURSOR.test(nextCursor))) {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}
	if (typeof closeRaw !== "function") {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}
	try {
		if (types.isProxy(closeRaw)) {
			const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
			return { ok: false, closeOk };
		}
	} catch {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}

	// Snapshot entries
	const entries: ProviderCallEntry[] = [];
	for (let i = 0; i < entriesRaw.length; i += 1) {
		if (!Object.hasOwn(entriesRaw, i)) {
			const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
			return { ok: false, closeOk };
		}
		const desc = Object.getOwnPropertyDescriptor(entriesRaw, String(i));
		if (!desc || !("value" in desc) || !desc.enumerable) {
			const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
			return { ok: false, closeOk };
		}
		const entry = snapshotEntry(desc.value);
		if (!entry) {
			const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
			return { ok: false, closeOk };
		}
		entries.push(entry);
	}
	const ownNames = Object.getOwnPropertyNames(entriesRaw);
	if (ownNames.length !== entriesRaw.length + 1 || ownNames.at(-1) !== "length") {
		const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;
		return { ok: false, closeOk };
	}

	// --- close page immediately ---
	const closeOk = pageClose ? await checkedCloseExact(pageClose) : false;

	return {
		ok: true,
		page: Object.freeze({ entries: Object.freeze(entries), nextCursor }),
		closeOk,
	};
}

// ---------------------------------------------------------------------------
// acquireHandle – extract handle state and close from a raw open result
//
// Acquire handle.close from raw opened result's direct own "handle" data
// descriptor before validating the outer open result or handle itself.
// If the outer result is malformed but a valid close is discoverable, it
// is returned for invocation.  A legitimate exact {status:"missing"} has
// no handle and needs no handle close (closeOk=true).
// ---------------------------------------------------------------------------

interface AcquiredHandle {
	readonly close: (() => unknown) | null;
	readonly handleRaw: unknown | undefined;
	readonly state: "missing" | "opened" | "malformed";
}

function acquireHandle(rawOpen: unknown): AcquiredHandle {
	const missing = exactDtor(rawOpen, OPEN_MISSING_KEYS);
	if (missing?.status?.value === "missing") {
		return Object.freeze({ close: null, handleRaw: undefined, state: "missing" });
	}

	let handleRaw: unknown;
	let hasHandleData = false;
	try {
		if (typeof rawOpen === "object" && rawOpen !== null && !types.isProxy(rawOpen)) {
			const handleDescriptor = Object.getOwnPropertyDescriptor(rawOpen, "handle");
			if (handleDescriptor && "value" in handleDescriptor) {
				handleRaw = handleDescriptor.value;
				hasHandleData = true;
			}
		}
	} catch {
		return Object.freeze({ close: null, handleRaw: undefined, state: "malformed" });
	}
	const close = hasHandleData ? discoverClose(handleRaw) : null;
	const opened = exactDtor(rawOpen, OPENED_KEYS);
	if (opened?.status?.value === "opened" && hasHandleData) {
		return Object.freeze({ close, handleRaw, state: "opened" });
	}
	return Object.freeze({ close, handleRaw: undefined, state: "malformed" });
}

interface FileMeta {
	readonly sha256: string;
	readonly fileSize: number;
	readonly journalSeq: number;
}

// ---------------------------------------------------------------------------
// readSingleFile – open, validate, read, confirmEof, close handle, decode
//
// "acquire handle.close before validation, close handle on every path before
//  returning; close failure dominates"
// ---------------------------------------------------------------------------

async function readSingleFile(
	entry: ProviderCallEntry,
	parsed: ParsedName,
	identity: ProviderCallIdentity,
	backend: BoundBackend,
	closeDominates: boolean,
): Promise<
	{ ok: true; record: ProviderCallRecordV1; fileMeta: FileMeta } | { ok: false; code: ProviderRecoveryErrorCode }
> {
	// --- open ---
	let rawOpenPromise: unknown;
	try {
		rawOpenPromise = backend.open(Object.freeze({ name: entry.name, expected: entry.stat }));
	} catch {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	const openObserved = await observeExact(rawOpenPromise);
	if (!openObserved.ok) {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- acquire handle status and close BEFORE validation ---
	const acquired = acquireHandle(openObserved.value);

	if (acquired.state === "missing") {
		const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : true;
		if (!closeOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// A malformed outer result still transfers any directly discoverable handle owner.
	if (acquired.state === "malformed") {
		const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : false;
		if (!closeOk || closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}
	if (!acquired.close) return { ok: false, code: "CLOSE_UNCERTAIN" };

	// Bind handle methods (readAt, confirmEof, fstat — not close, acquired above)
	const hnd = bindHandle(acquired.handleRaw);
	if (!hnd) {
		const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : false;
		if (!closeOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- read contents ---
	const assembledBytes = new Uint8Array(entry.stat.size);
	let offset = 0;
	let readOk = true;

	// fstat before read
	let initialStat: ProviderCallEntryStat | null = null;
	try {
		const initialRaw = hnd.fstat();
		const observedStat = await observeExact(initialRaw);
		if (observedStat.ok) {
			initialStat = snapshotStat(observedStat.value);
		}
	} catch {
		readOk = false;
	}
	if (!initialStat || !statEqual(initialStat, entry.stat)) readOk = false;

	while (readOk && offset < assembledBytes.byteLength) {
		const requested = Math.min(READ_MAX_BYTES, assembledBytes.byteLength - offset);
		let rawReadPromise: unknown;
		try {
			rawReadPromise = hnd.readAt(offset, requested);
		} catch {
			readOk = false;
			break;
		}
		const readObserved = await observeExact(rawReadPromise);
		if (!readObserved.ok) {
			readOk = false;
			break;
		}
		const transferredCandidate = ownData(readObserved.value, "bytes");
		const bytesResult = exactDtor(readObserved.value, BYTES_KEYS);
		if (!bytesResult || bytesResult.status?.value !== "bytes") {
			eraseTransferred(transferredCandidate);
			readOk = false;
			break;
		}
		const transferred = bytesResult.bytes?.value;
		if (transferred === undefined) {
			readOk = false;
			break;
		}
		if (!exactTransferred(transferred)) {
			eraseTransferred(transferred);
			readOk = false;
			break;
		}
		const tLen = transferred.byteLength;
		if (tLen < 1 || tLen > requested) {
			eraseTransferred(transferred);
			readOk = false;
			break;
		}
		try {
			assembledBytes.set(transferred, offset);
			offset += tLen;
		} finally {
			eraseTransferred(transferred);
		}
	}

	// Confirm EOF
	if (readOk) {
		let confirmRawPromise: unknown;
		try {
			confirmRawPromise = hnd.confirmEof(assembledBytes.byteLength);
		} catch {
			readOk = false;
		}
		if (readOk) {
			const confirmObserved = await observeExact(confirmRawPromise);
			if (!confirmObserved.ok) {
				readOk = false;
			} else {
				const confirmStatus = exactDtor(confirmObserved.value, STATUS_KEYS);
				if (!confirmStatus || confirmStatus.status?.value !== "eof") readOk = false;
			}
		}
	}

	// Final fstat
	if (readOk) {
		let finalStat: ProviderCallEntryStat | null = null;
		try {
			const finalRaw = hnd.fstat();
			const finalObserved = await observeExact(finalRaw);
			if (finalObserved.ok) {
				finalStat = snapshotStat(finalObserved.value);
			}
		} catch {
			readOk = false;
		}
		if (!finalStat || !statEqual(finalStat, entry.stat)) readOk = false;
	}

	// --- close handle on every path, close-dominance ---
	const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : false;

	if (!readOk) {
		assembledBytes.fill(0);
		if (!closeOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// Save a fresh copy for decode after close.
	const ownBytes = new Uint8Array(assembledBytes.byteLength);
	ownBytes.set(assembledBytes);
	assembledBytes.fill(0);

	if (!closeOk) {
		ownBytes.fill(0);
		return { ok: false, code: "CLOSE_UNCERTAIN" };
	}

	// Compute sha256 of the actual immutable bytes before erasure
	let canonicalSha256 = "";
	try {
		const hash = createHash("sha256");
		hash.update(ownBytes);
		canonicalSha256 = hash.digest("hex");
	} catch {
		ownBytes.fill(0);
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- decode after close ---
	const decoded = decodeProviderCallRecordV1(ownBytes);
	ownBytes.fill(0);
	if (!decoded.ok) {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- verify decoded record identity ---
	const record = decoded.record;
	if (
		record.journalSeq !== parsed.sequence ||
		record.hostId !== identity.hostId ||
		record.generation !== identity.generation ||
		record.sessionId !== identity.sessionId
	) {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	const fileMeta: FileMeta = Object.freeze({
		sha256: canonicalSha256,
		fileSize: entry.stat.size,
		journalSeq: parsed.sequence,
	});

	return { ok: true, record, fileMeta };
}

// ---------------------------------------------------------------------------
// Per-call state machine helpers
// ---------------------------------------------------------------------------

type ProviderCallState = "none" | "journaled" | "started" | "chunking" | "terminal" | "delivered";

interface CallTracking {
	readonly callId: string;
	state: ProviderCallState;
	readonly requestDigest: string | null;
	chunkCount: number;
	readonly startJournalSeq: number;
	cancelRequested: boolean;
}

function validateStateTransition(kind: ProviderCallRecordV1["recordKind"], entry: CallTracking | null): string | null {
	if (!entry) {
		if (kind === "journaled") return null;
		return "INVALID_SEQUENCE";
	}
	switch (entry.state) {
		case "journaled":
			if (kind === "started") return null;
			return "INVALID_SEQUENCE";
		case "started":
			if (kind === "chunk" || kind === "terminal" || kind === "cancel_requested") return null;
			return "INVALID_SEQUENCE";
		case "chunking":
			if (kind === "chunk" || kind === "terminal" || kind === "cancel_requested") return null;
			return "INVALID_SEQUENCE";
		case "terminal":
			if (kind === "delivered") return null;
			return "INVALID_SEQUENCE";
		case "delivered":
			return "INVALID_SEQUENCE";
		case "none":
			return "INVALID_SEQUENCE";
	}
	return "INVALID_SEQUENCE";
}

function determineState(kind: ProviderCallRecordV1["recordKind"], current: ProviderCallState): ProviderCallState {
	switch (kind) {
		case "journaled":
			return "journaled";
		case "started":
			return "started";
		case "chunk":
			return "chunking";
		case "terminal":
			return "terminal";
		case "delivered":
			return "delivered";
		case "cancel_requested":
			return current;
	}
	return current;
}

// ---------------------------------------------------------------------------
// Preliminary backend.close acquisition
//
// "Factory preliminary-acquires exact backend.close from direct own backend
//  descriptor before outer/identity/backend validation"
// ---------------------------------------------------------------------------

function tryPreliminaryClose(raw: unknown): {
	close: (() => unknown) | null;
	accessorOrProxy: boolean;
} {
	const result: { close: (() => unknown) | null; accessorOrProxy: boolean } = { close: null, accessorOrProxy: false };

	if (typeof raw !== "object" || raw === null) {
		result.accessorOrProxy = true;
		return result;
	}
	try {
		if (types.isProxy(raw)) {
			result.accessorOrProxy = true;
			return result;
		}
	} catch {
		result.accessorOrProxy = true;
		return result;
	}

	let backendValue: unknown;
	try {
		const backendDesc = Object.getOwnPropertyDescriptor(raw, "backend");
		if (!backendDesc) {
			result.accessorOrProxy = true;
			return result;
		}
		if (!("value" in backendDesc)) {
			result.accessorOrProxy = true;
			return result;
		}
		backendValue = backendDesc.value;
	} catch {
		result.accessorOrProxy = true;
		return result;
	}

	if (typeof backendValue !== "object" || backendValue === null) {
		result.accessorOrProxy = true;
		return result;
	}

	try {
		if (types.isProxy(backendValue)) {
			result.accessorOrProxy = true;
			return result;
		}
	} catch {
		result.accessorOrProxy = true;
		return result;
	}

	// Extract close from its direct descriptor before full backend validation.
	try {
		const closeDesc = Object.getOwnPropertyDescriptor(backendValue, "close");
		if (!closeDesc) {
			result.accessorOrProxy = true;
			return result;
		}
		if (!("value" in closeDesc)) {
			result.accessorOrProxy = true;
			return result;
		}
		if (typeof closeDesc.value !== "function" || types.isProxy(closeDesc.value)) {
			result.accessorOrProxy = true;
			return result;
		}
		const closeFn = closeDesc.value;
		result.close = consumeCloseOnce((): unknown => Reflect.apply(closeFn, backendValue, []));
	} catch {
		result.accessorOrProxy = true;
		return result;
	}

	return result;
}

// ===========================================================================
// runRecovery – inner scan logic, never closes the backend itself.
//               Returns success/error code; caller handles backend close.
// ===========================================================================

type RunRecoveryResult =
	| Readonly<{ ok: true; output: ProviderCallRecoveryOutput }>
	| Readonly<{ ok: false; code: ProviderRecoveryErrorCode }>;

async function runRecovery(raw: unknown): Promise<RunRecoveryResult> {
	// Validate outer input, identity, backend shape
	const input = exactDtor(raw, INPUT_KEYS);
	if (!input) return { ok: false, code: "INVALID_ARGUMENT" };

	const identity = snapshotIdentity(input.identity?.value);
	if (!identity) return { ok: false, code: "INVALID_ARGUMENT" };

	const backend = bindBackend(input.backend?.value);
	if (!backend) return { ok: false, code: "INVALID_ARGUMENT" };

	// -----------------------------------------------------------------------
	// Pass 1: list pages, snapshot entries, close each page immediately
	// -----------------------------------------------------------------------
	let cursor: string | null = null;
	let lastName: string | null = null;
	let nextSequence = 1;
	let totalBytes = 0;
	let allEntries: ProviderCallEntry[] = [];
	let pageCount = 0;
	let closeDominates = false;
	const seenCursors = new Set<string | null>();

	for (;;) {
		if (nextSequence > MAX_FILES + 1) break;

		// --- list page ---
		let rawPagePromise: unknown;
		try {
			rawPagePromise = backend.listPage(
				Object.freeze({
					cursor,
					maxEntries: PAGE_MAX_ENTRIES,
					maxBytes: PAGE_MAX_BYTES,
				}),
			);
		} catch {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const pageObserved = await observeExact(rawPagePromise);
		if (!pageObserved.ok) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		// --- parse and close page ---
		const parsed = await parseAndClosePage(pageObserved.value);
		if (!parsed.closeOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
		if (!parsed.ok) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const page = parsed.page;

		// --- empty page ---
		if (page.entries.length === 0) {
			if (cursor !== null || page.nextCursor !== null) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			break;
		}

		// --- cursor tracking ---
		pageCount += 1;
		if (pageCount > MAX_PAGES) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		if (page.nextCursor !== null) {
			if (seenCursors.has(page.nextCursor)) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			seenCursors.add(page.nextCursor);
		}

		// --- validate entries ---
		let prospectiveLast: string | null = lastName;
		let prospectiveSeq = nextSequence;
		let pageBytes = 0;
		const pageEntries: ProviderCallEntry[] = [];

		for (const entry of page.entries) {
			const parsedName = parseName(entry.name);
			if (!parsedName) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (prospectiveLast !== null && prospectiveLast >= entry.name) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (!entry.stat.isFile || entry.stat.isSymlink || entry.stat.mode !== 0o600 || entry.stat.nlink !== 1) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (entry.stat.size < 1 || entry.stat.size > FILE_MAX_BYTES) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			pageBytes += entry.stat.size;
			if (!Number.isSafeInteger(pageBytes) || pageBytes > PAGE_MAX_BYTES) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (parsedName.sequence !== prospectiveSeq) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			prospectiveSeq += 1;
			prospectiveLast = entry.name;
			pageEntries.push(entry);
		}

		// --- total bytes bound ---
		if (totalBytes + pageBytes > TOTAL_MAX_BYTES) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		allEntries = allEntries.concat(pageEntries);
		lastName = prospectiveLast;
		nextSequence = prospectiveSeq;
		totalBytes += pageBytes;
		cursor = page.nextCursor;

		if (cursor === null) break;
	}

	// --- non-null cursor at page bound ---
	if (cursor !== null) {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// -----------------------------------------------------------------------
	// Pass 2: open files serially, read, close handle, decode
	// -----------------------------------------------------------------------
	const records: ProviderCallRecordV1[] = [];
	const fileMetas = new Map<number, FileMeta>(); // journalSeq -> FileMeta

	for (const entry of allEntries) {
		const parsedName = parseName(entry.name);
		if (!parsedName) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const fileResult = await readSingleFile(entry, parsedName, identity, backend, closeDominates);

		if (!fileResult.ok) {
			if (fileResult.code === "CLOSE_UNCERTAIN") closeDominates = true;
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: fileResult.code };
		}

		fileMetas.set(fileResult.fileMeta.journalSeq, fileResult.fileMeta);
		records.push(fileResult.record);
	}

	// -----------------------------------------------------------------------
	// Build per-call state, classify interrupted calls, freeze output
	// -----------------------------------------------------------------------
	const callStates = new Map<string, CallTracking>();
	const requestFrameIds = new Set<string>();
	const interruptedCallIds: string[] = [];

	for (const record of records) {
		if (record.recordKind === "journaled") {
			if (requestFrameIds.has(record.requestFrameId)) return { ok: false, code: "RECOVERY_FAILED" };
			requestFrameIds.add(record.requestFrameId);
		}
		const existing = callStates.get(record.callId) ?? null;
		const stateErr = validateStateTransition(record.recordKind, existing);
		if (stateErr !== null) return { ok: false, code: "RECOVERY_FAILED" };

		// Cross-record field validation
		if (record.recordKind === "started") {
			if (existing === null || existing.requestDigest === null) {
				// started must have prior journaled record
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (record.requestDigest !== existing.requestDigest || record.requestJournalSeq !== existing.startJournalSeq) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			// Validate requestReceipt against the journaled file's actual bytes.
			// sha256 must match the canonical file bytes before erasure.
			// sequence must match the journaled file's journalSeq.
			// size must match the journaled file's actual file size.
			if (record.requestReceipt) {
				const journalMeta = fileMetas.get(existing.startJournalSeq);
				if (!journalMeta) return { ok: false, code: "RECOVERY_FAILED" };
				if (
					record.requestReceipt.sha256 !== journalMeta.sha256 ||
					record.requestReceipt.size !== journalMeta.fileSize ||
					record.requestReceipt.sequence !== journalMeta.journalSeq
				) {
					return { ok: false, code: "RECOVERY_FAILED" };
				}
			}
		}

		if (record.recordKind === "chunk") {
			if (existing === null) return { ok: false, code: "RECOVERY_FAILED" };
			if (record.chunkIndex !== existing.chunkCount) {
				// chunkIndex must equal the current chunk count (0, 1, 2, ...)
				return { ok: false, code: "RECOVERY_FAILED" };
			}
		}

		if (record.recordKind === "terminal") {
			if (existing === null) return { ok: false, code: "RECOVERY_FAILED" };
			if (record.chunkCount !== existing.chunkCount) {
				// terminal chunkCount must match number of preceding chunk records
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			// cancelled terminal requires prior cancel_requested
			if (record.terminalKind === "cancelled" && !existing.cancelRequested) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
		}

		if (record.recordKind === "cancel_requested") {
			if (existing === null) return { ok: false, code: "RECOVERY_FAILED" };
			if (existing.cancelRequested) {
				// Only one cancel_requested allowed
				return { ok: false, code: "RECOVERY_FAILED" };
			}
		}

		if (existing === null) {
			callStates.set(record.callId, {
				callId: record.callId,
				state: determineState(record.recordKind, "none"),
				requestDigest: record.recordKind === "journaled" ? record.requestDigest : null,
				chunkCount: 0,
				startJournalSeq: record.journalSeq,
				cancelRequested: false,
			});
		} else {
			const newState = determineState(record.recordKind, existing.state);
			const chunkDelta = record.recordKind === "chunk" ? 1 : 0;
			const cancelDelta = record.recordKind === "cancel_requested" ? 1 : 0;
			callStates.set(record.callId, {
				...existing,
				state: newState,
				chunkCount: existing.chunkCount + chunkDelta,
				cancelRequested: existing.cancelRequested || cancelDelta > 0,
			});
		}
	}

	for (const [callId, tracking] of callStates) {
		if (tracking.state === "started" || tracking.state === "chunking") {
			interruptedCallIds.push(callId);
		}
	}

	const frozenRecords: readonly ProviderCallRecordV1[] = Object.freeze(records.map((r) => r));

	const output: ProviderCallRecoveryOutput = Object.freeze({
		identity: Object.freeze({
			hostId: identity.hostId,
			generation: identity.generation,
			sessionId: identity.sessionId,
		}),
		records: frozenRecords,
		totalBytes,
		nextJournalSeq: nextSequence,
		interruptedCallIds: Object.freeze(interruptedCallIds),
	});

	// Close dominance: if ANY page/handle close failed during scan,
	// return CLOSE_UNCERTAIN even if the scan produced valid output.
	if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };

	return { ok: true, output };
}

// ===========================================================================
// recoverProviderCallJournal — main export
//
// Structure: acquire backend.close preliminarily, run scan, then close
// backend and return CLOSE_UNCERTAIN if close is not exact. Closure of
// backend is always last after all page/handle cleanup.
// ===========================================================================

export async function recoverProviderCallJournal(raw: unknown): Promise<ProviderCallRecoveryResult> {
	// Preliminary backend.close acquisition (before any validation)
	const preliminary = tryPreliminaryClose(raw);
	if (preliminary.accessorOrProxy) return fail("CLOSE_UNCERTAIN");
	const prelimClose = preliminary.close;
	if (!prelimClose) return fail("CLOSE_UNCERTAIN");

	// Run inner scan (never closes backend directly). A rejected internal path
	// must not bypass the backend owner acquired above.
	let scan: RunRecoveryResult;
	try {
		scan = await runRecovery(raw);
	} catch {
		scan = { ok: false, code: "RECOVERY_FAILED" };
	}

	// Backend close — always last on EVERY path, uncertainty dominates.
	// Must close backend even when state-machine validation fails.
	const backendCloseOk = await checkedCloseExact(prelimClose);

	if (!backendCloseOk) return fail("CLOSE_UNCERTAIN");
	if (!scan.ok) return fail(scan.code);
	return Object.freeze({ ok: true, value: scan.output });
}
