/**
 * SandboxCommand journal recovery scanner — reads durable `<N>.b14-command`
 * journal files through a paginated backend, validates exact contiguous
 * 1-based ordered records with identity binding, and returns a deep-frozen
 * recovered snapshot with per-file receipts.
 *
 * Pure scanner: no store, publisher, or filesystem backend included.
 * Backend is injected at the call site.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { SandboxCommandRecordV1 } from "./sandbox-command-record-codec.js";
import { decodeSandboxCommandRecordV1 } from "./sandbox-command-record-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const PAGE_MAX_ENTRIES = 64;
const PAGE_MAX_BYTES = 16_777_216; // 16 MiB
const TOTAL_MAX_BYTES = 268_435_456; // 256 MiB
const FILE_MAX_BYTES = 1_310_720; // 1.25 MiB (matches codec MAX_ENCODED_BYTES)
const READ_MAX_BYTES = 65_536; // 64 KiB
const MAX_FILES = 20_000;
const MAX_PAGES = MAX_FILES;
const PROMISE_TIMEOUT_MS = 30_000; // 30 s

const FILE_NAME = /^(\d{20})\.b14-command$/;
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

// Module-level intrinsic captures — no dynamic lookup at erase time.
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const U8_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "byteLength")?.get;
const U8_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "byteOffset")?.get;
const U8_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "buffer")?.get;
const AB_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const U8_FILL = Uint8Array.prototype.fill;

// ===========================================================================
// Error codes
// ===========================================================================

export const SANDBOX_RECOVERY_ERRORS = Object.freeze({
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	RECOVERY_FAILED: "RECOVERY_FAILED",
	IO_UNCONFIRMED: "IO_UNCONFIRMED",
	CLOSE_UNCERTAIN: "CLOSE_UNCERTAIN",
});

export type SandboxRecoveryErrorCode = (typeof SANDBOX_RECOVERY_ERRORS)[keyof typeof SANDBOX_RECOVERY_ERRORS];

// ---------------------------------------------------------------------------
// CloseDiscovery — tagged result for discoverClose: distinct "close found",
// "no close", and "alias detected" signals so callers can produce the correct
// error code (CLOSE_UNCERTAIN for aliases, no close for absent).
// ---------------------------------------------------------------------------

type CloseDiscovery =
	| { readonly kind: "close"; readonly fn: () => unknown }
	| { readonly kind: "absent" }
	| { readonly kind: "uncertain" }
	| { readonly kind: "alias" };

// ---------------------------------------------------------------------------
// isExactNativePromise — non-observing descriptor-safe classification that
// never uses `instanceof` (which triggers hostile Proxy [[HasInstance]]).
// Validates: types.isProxy rejection, exact Promise.prototype, zero own
// names/symbols, types.isPromise.
// ---------------------------------------------------------------------------

function isExactNativePromise(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (Object.getPrototypeOf(raw) !== Promise.prototype) return false;
		if (Object.getOwnPropertyNames(raw).length > 0) return false;
		if (Object.getOwnPropertySymbols(raw).length > 0) return false;
		return types.isPromise(raw);
	} catch {
		return false;
	}
}

// ===========================================================================
// Input/output types
// ===========================================================================

export interface SandboxCommandIdentity {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
}

export interface SandboxCommandEntryStat {
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

export interface SandboxCommandEntry {
	readonly name: string;
	readonly stat: SandboxCommandEntryStat;
}

export interface SandboxCommandListPageRequest {
	readonly cursor: string | null;
	readonly maxEntries: 64;
	readonly maxBytes: 16_777_216;
}

export interface SandboxCommandPageResult {
	readonly status: "page";
	readonly entries: readonly SandboxCommandEntry[];
	readonly nextCursor: string | null;
	readonly close: () => unknown;
}

export interface SandboxCommandOpenRequest {
	readonly name: string;
	readonly expected: SandboxCommandEntryStat;
}

export interface SandboxCommandReadHandle {
	readonly readAt: (offset: number, size: number) => unknown;
	readonly confirmEof: (size: number) => unknown;
	readonly fstat: () => unknown;
	readonly close: () => unknown;
}

export type SandboxCommandOpenResult =
	| Readonly<{ status: "opened"; handle: SandboxCommandReadHandle }>
	| Readonly<{ status: "missing" }>;

export interface SandboxCommandBackend {
	readonly listPage: (request: SandboxCommandListPageRequest) => unknown;
	readonly open: (request: SandboxCommandOpenRequest) => unknown;
	readonly close: () => unknown;
}

export interface SandboxCommandRecoveryInput {
	readonly backend: SandboxCommandBackend;
	readonly identity: SandboxCommandIdentity;
}

// ===========================================================================
// Output types
// ===========================================================================

export interface SandboxCommandFileReceipt {
	readonly sequence: number;
	readonly size: number;
	readonly sha256: string;
}

export interface SandboxCommandRecoveryOutput {
	readonly identity: SandboxCommandIdentity;
	readonly records: readonly SandboxCommandRecordV1[];
	readonly receipts: readonly SandboxCommandFileReceipt[];
	readonly totalBytes: number;
	readonly nextSequence: number;
}

export interface SandboxCommandRecoveryOk {
	readonly ok: true;
	readonly value: SandboxCommandRecoveryOutput;
}

export interface SandboxCommandRecoveryError {
	readonly ok: false;
	readonly error: Readonly<{ code: SandboxRecoveryErrorCode }>;
}

export type SandboxCommandRecoveryResult = SandboxCommandRecoveryOk | SandboxCommandRecoveryError;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

type BoundBackend = Readonly<{
	listPage: (request: SandboxCommandListPageRequest) => unknown;
	open: (request: SandboxCommandOpenRequest) => unknown;
}>;

type BoundHandle = Readonly<{
	readAt: (offset: number, size: number) => unknown;
	confirmEof: (size: number) => unknown;
	fstat: () => unknown;
}>;

type ParsedName = Readonly<{ sequence: number }>;

/** Observation result union — no Error objects created or propagated. */
type ObserveResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;

// ===========================================================================
// Helpers
// ===========================================================================

function fail(code: SandboxRecoveryErrorCode): SandboxCommandRecoveryError {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code }),
	}) satisfies SandboxCommandRecoveryError;
}

// ---------------------------------------------------------------------------
// exactDtor — validate a plain object has exactly the given own property set
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
// methodFn — pull a function-typed own data descriptor, reject Proxy
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
// validId — printable ASCII, 1..128 chars
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

function snapshotIdentity(raw: unknown): SandboxCommandIdentity | null {
	const values = exactDtor(raw, IDENTITY_KEYS);
	if (!values) return null;
	const hostId = values.hostId?.value;
	const generation = values.generation?.value;
	const sessionId = values.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

// ---------------------------------------------------------------------------
// bindBackend — extract listPage & open (close extracted upstream)
// ---------------------------------------------------------------------------

function bindBackend(raw: unknown): BoundBackend | null {
	const values = exactDtor(raw, BACKEND_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const listPage = methodFn(values, raw, "listPage");
	const open = methodFn(values, raw, "open");
	if (!listPage || !open) return null;
	return Object.freeze({
		listPage: (request: SandboxCommandListPageRequest): unknown => Reflect.apply(listPage, undefined, [request]),
		open: (request: SandboxCommandOpenRequest): unknown => Reflect.apply(open, undefined, [request]),
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

function snapshotStat(raw: unknown): SandboxCommandEntryStat | null {
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

function snapshotEntry(raw: unknown): SandboxCommandEntry | null {
	const value = exactDtor(raw, ENTRY_KEYS);
	if (!value) return null;
	const name = value.name?.value;
	const stat = snapshotStat(value.stat?.value);
	return typeof name === "string" && stat ? Object.freeze({ name, stat }) : null;
}

// ---------------------------------------------------------------------------
// seenCloseOwners — track object identity across backend/page/handle
// transfers so aliases never invoke a physical close twice.
// A fresh WeakSet is created per runRecovery call.
// ---------------------------------------------------------------------------

type CloseGuard = WeakSet<object>;

// ---------------------------------------------------------------------------
// discoverClose — extract bare close from own descriptor, reject
//                 Proxy / non-function / accessor / custom proto.
//                 Returns CloseDiscovery tagged union:
//                   kind:"close"  – close function available (registered in
//                                   guard only after proven valid)
//                   kind:"absent" – no close found (proto wrong, no desc, etc.)
//                   kind:"alias"  – guard already contains this raw object
//                                   (caller must produce CLOSE_UNCERTAIN)
// ---------------------------------------------------------------------------

function discoverClose(raw: unknown, guard?: CloseGuard): CloseDiscovery {
	if (typeof raw !== "object" || raw === null) return { kind: "absent" };
	try {
		if (types.isProxy(raw)) return { kind: "uncertain" };
		if (guard) {
			if (guard.has(raw)) return { kind: "alias" };
		}
		const desc = Object.getOwnPropertyDescriptor(raw, "close");
		if (!desc) return { kind: "absent" };
		if (!desc.enumerable) return { kind: "uncertain" };
		if (!("value" in desc)) return { kind: "uncertain" };
		if (typeof desc.value !== "function") return { kind: "absent" };
		if (types.isProxy(desc.value)) return { kind: "uncertain" };
		const closeFn = desc.value;
		// Register only after a valid own close is proven (rule 4).
		if (guard) guard.add(raw);
		return { kind: "close", fn: (): unknown => Reflect.apply(closeFn, raw, []) };
	} catch {
		return { kind: "uncertain" };
	}
}

// ---------------------------------------------------------------------------
// consumeCloseOnce — wrap a close function so it can be called at most once
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
// observeExact — validate a host-guaranteed bare native Promise and observe
//                it, returning an ObserveResult union (no Error objects).
//
// Validates: non-proxy, Promise.prototype, zero own names/symbols,
// types.isPromise. Uses Reflect.apply(Promise.prototype.then, raw, [])
// to avoid invoking any custom-then from a hostile object that somehow
// passed the own-property check. Bounded referenced timer.
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
// checkedCloseExact — observe a close via observeExact and verify the result
//                     is {status:"closed"}. No arbitrary await closeFn().
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
// eraseTransferred — zero-fill a Uint8Array in place
// ---------------------------------------------------------------------------

function eraseTransferred(raw: unknown): void {
	try {
		if (typeof raw !== "object" || raw === null || types.isProxy(raw) || !U8_BYTE_LENGTH_GETTER) return;
		const length = Reflect.apply(U8_BYTE_LENGTH_GETTER, raw, []);
		if (typeof length === "number" && length > 0) Reflect.apply(U8_FILL, raw, [0]);
	} catch {
		// Not safely writable.
	}
}

// ---------------------------------------------------------------------------
// exactTransferred — validate a full-backing genuine Uint8Array with no own
//                    property overrides on prototype chain getters, no named
//                    extras, dense numeric indices, zero-offset and
//                    zero-own-buffer.
// ---------------------------------------------------------------------------

function exactTransferred(raw: unknown): raw is Uint8Array {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			!U8_BYTE_LENGTH_GETTER ||
			!U8_BYTE_OFFSET_GETTER ||
			!U8_BUFFER_GETTER ||
			!AB_BYTE_LENGTH_GETTER
		)
			return false;
		if (
			Object.getOwnPropertyDescriptor(raw, "buffer") ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset")
		)
			return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		const ownNames = Object.getOwnPropertyNames(raw);
		const byteLength = Reflect.apply(U8_BYTE_LENGTH_GETTER, raw, []);
		if (typeof byteLength !== "number" || ownNames.length !== byteLength) return false;
		for (let i = 0; i < byteLength; i++) {
			if (ownNames[i] !== String(i)) return false;
		}
		const byteOffset = Reflect.apply(U8_BYTE_OFFSET_GETTER, raw, []);
		const buffer = Reflect.apply(U8_BUFFER_GETTER, raw, []);
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(AB_BYTE_LENGTH_GETTER, buffer, []);
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
// bindHandle — extracts readAt, confirmEof, fstat (but NOT close — that is
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

function statEqual(left: SandboxCommandEntryStat, right: SandboxCommandEntryStat): boolean {
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
// parseAndClosePage — validate page shape, snapshot entries, close page
//
// "acquire page.close before page validation" — close is extracted first,
// before validating page content. Then validate entries, then close page
// before returning. Close dominance reported.
// ---------------------------------------------------------------------------

interface ParsedPage {
	readonly entries: readonly SandboxCommandEntry[];
	readonly nextCursor: string | null;
}

/** Resolve a CloseDiscovery into a boolean closeOk. */
function discoveryCloseOk(disc: CloseDiscovery): Promise<boolean> {
	if (disc.kind === "close") return checkedCloseExact(disc.fn);
	// alias/uncertain → cannot confirm clean close
	if (disc.kind === "alias" || disc.kind === "uncertain") return Promise.resolve(false);
	// absent → no close to clean up
	return Promise.resolve(true);
}

async function parseAndClosePage(
	raw: unknown,
	guard?: CloseGuard,
): Promise<{ ok: true; page: ParsedPage; closeOk: boolean } | { ok: false; closeOk: boolean }> {
	// --- acquire close BEFORE validation ---
	const pageClose = discoverClose(raw, guard);

	const value = exactDtor(raw, PAGE_RESULT_KEYS);
	if (!value) {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}
	if (value.status?.value !== "page") {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}

	const entriesRaw = value.entries?.value;
	const nextCursor = value.nextCursor?.value;
	const closeRaw = value.close?.value;

	// Validate entries array
	if (!Array.isArray(entriesRaw)) {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}
	try {
		if (
			types.isProxy(entriesRaw) ||
			Object.getPrototypeOf(entriesRaw) !== Array.prototype ||
			Object.getOwnPropertySymbols(entriesRaw).length !== 0
		) {
			const closeOk = await discoveryCloseOk(pageClose);
			return { ok: false, closeOk };
		}
	} catch {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}

	if (entriesRaw.length > PAGE_MAX_ENTRIES) {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}

	if (nextCursor !== null && (typeof nextCursor !== "string" || !CURSOR.test(nextCursor))) {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}
	if (typeof closeRaw !== "function") {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}
	try {
		if (types.isProxy(closeRaw)) {
			const closeOk = await discoveryCloseOk(pageClose);
			return { ok: false, closeOk };
		}
	} catch {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}

	// Snapshot entries
	const entries: SandboxCommandEntry[] = [];
	for (let i = 0; i < entriesRaw.length; i += 1) {
		if (!Object.hasOwn(entriesRaw, i)) {
			const closeOk = await discoveryCloseOk(pageClose);
			return { ok: false, closeOk };
		}
		const desc = Object.getOwnPropertyDescriptor(entriesRaw, String(i));
		if (!desc || !("value" in desc) || !desc.enumerable) {
			const closeOk = await discoveryCloseOk(pageClose);
			return { ok: false, closeOk };
		}
		const entry = snapshotEntry(desc.value);
		if (!entry) {
			const closeOk = await discoveryCloseOk(pageClose);
			return { ok: false, closeOk };
		}
		entries.push(entry);
	}
	const ownNames = Object.getOwnPropertyNames(entriesRaw);
	if (ownNames.length !== entriesRaw.length + 1 || ownNames.at(-1) !== "length") {
		const closeOk = await discoveryCloseOk(pageClose);
		return { ok: false, closeOk };
	}

	// --- close page immediately ---
	const closeOk = await discoveryCloseOk(pageClose);

	return {
		ok: true,
		page: Object.freeze({ entries: Object.freeze(entries), nextCursor }),
		closeOk,
	};
}

// ---------------------------------------------------------------------------
// acquireHandle — extract handle state and close from a raw open result
//
// Acquire handle.close from raw opened result's direct own "handle" data
// descriptor before validating the outer open result or handle itself.
// If the outer result is malformed but a valid close is discoverable, it
// is returned for invocation. A legitimate exact {status:"missing"} has
// no handle and needs no handle close (closeOk=true).
// ---------------------------------------------------------------------------

interface AcquiredHandle {
	readonly close: (() => unknown) | null;
	readonly handleRaw: unknown | undefined;
	readonly state: "missing" | "opened" | "malformed";
	readonly closeAlias: boolean;
	readonly closeUncertain: boolean;
}

function acquireHandle(rawOpen: unknown, guard?: CloseGuard): AcquiredHandle {
	const missing = exactDtor(rawOpen, OPEN_MISSING_KEYS);
	if (missing?.status?.value === "missing") {
		return Object.freeze({
			close: null,
			handleRaw: undefined,
			state: "missing",
			closeAlias: false,
			closeUncertain: false,
		});
	}

	let handleRaw: unknown;
	let hasHandleData = false;
	try {
		if (typeof rawOpen === "object" && rawOpen !== null && !types.isProxy(rawOpen)) {
			const handleDescriptor = Object.getOwnPropertyDescriptor(rawOpen, "handle");
			if (handleDescriptor) {
				if ("value" in handleDescriptor) {
					handleRaw = handleDescriptor.value;
					hasHandleData = true;
				} else {
					// Accessor handle -> uncertain
					return Object.freeze({
						close: null,
						handleRaw: undefined,
						state: "malformed",
						closeAlias: false,
						closeUncertain: true,
					});
				}
			}
		} else if (typeof rawOpen === "object" && rawOpen !== null && types.isProxy(rawOpen)) {
			// Proxy outer result -> uncertain
			return Object.freeze({
				close: null,
				handleRaw: undefined,
				state: "malformed",
				closeAlias: false,
				closeUncertain: true,
			});
		}
	} catch {
		// Catch from safe operations (getOwnPropertyDescriptor) is a system
		// error, not adversarial uncertainty. Return plain malformed.
		return Object.freeze({
			close: null,
			handleRaw: undefined,
			state: "malformed",
			closeAlias: false,
			closeUncertain: false,
		});
	}
	const disc = hasHandleData ? discoverClose(handleRaw, guard) : null;
	const close = disc?.kind === "close" ? disc.fn : null;
	const closeAlias = disc !== null && disc.kind === "alias";
	const closeUncertain = disc !== null && disc.kind === "uncertain";
	const opened = exactDtor(rawOpen, OPENED_KEYS);
	if (opened?.status?.value === "opened" && hasHandleData) {
		return Object.freeze({ close, handleRaw, state: "opened", closeAlias, closeUncertain });
	}
	return Object.freeze({ close, handleRaw: undefined, state: "malformed", closeAlias, closeUncertain });
}

// ---------------------------------------------------------------------------
// Decoded file metadata
// ---------------------------------------------------------------------------

interface FileMeta {
	readonly sha256: string;
	readonly fileSize: number;
	readonly sequence: number;
}

// ---------------------------------------------------------------------------
// readSingleFile — open, validate, read, confirmEof, close handle, decode
//
// "acquire handle.close before validation, close handle on every path before
//  returning; close failure dominates"
// ---------------------------------------------------------------------------

async function readSingleFile(
	entry: SandboxCommandEntry,
	parsed: ParsedName,
	identity: SandboxCommandIdentity,
	backend: BoundBackend,
	closeGuard: CloseGuard,
	closeDominates: boolean,
): Promise<
	{ ok: true; record: SandboxCommandRecordV1; fileMeta: FileMeta } | { ok: false; code: SandboxRecoveryErrorCode }
> {
	// --- open ---
	let rawOpenPromise: unknown;
	try {
		rawOpenPromise = backend.open(Object.freeze({ name: entry.name, expected: entry.stat }));
	} catch {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- sync-return handle close cleanup ---
	let openSyncClose: (() => unknown) | null = null;
	let openSyncUncertain = false;
	try {
		if (typeof rawOpenPromise === "object" && rawOpenPromise !== null && !isExactNativePromise(rawOpenPromise)) {
			if (types.isProxy(rawOpenPromise)) {
				openSyncUncertain = true;
			} else {
				const a = acquireHandle(rawOpenPromise, closeGuard);
				openSyncClose = a.close;
				openSyncUncertain = a.closeAlias || a.closeUncertain;
			}
		}
	} catch {
		openSyncUncertain = true;
	}

	const openObserved = await observeExact(rawOpenPromise);
	if (!openObserved.ok) {
		const openSyncCloseOk = openSyncClose ? await checkedCloseExact(openSyncClose) : !openSyncUncertain;
		if (!openSyncCloseOk || closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- acquire handle status and close BEFORE validation ---
	const acquired = acquireHandle(openObserved.value, closeGuard);
	const handleUncertain = acquired.closeAlias || acquired.closeUncertain;

	if (acquired.state === "missing") {
		const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : !handleUncertain;
		if (!closeOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// A malformed outer result still transfers any directly discoverable handle owner.
	if (acquired.state === "malformed") {
		const closeOk = acquired.close ? await checkedCloseExact(acquired.close) : !handleUncertain;
		if (!closeOk || closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}
	if (!acquired.close) {
		if (handleUncertain) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

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
	let readUncertain = false;

	// fstat before read
	let initialStat: SandboxCommandEntryStat | null = null;
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
		// --- sync-return descriptor-snapshot {status,bytes} ---
		// Descriptor-snapshot BEFORE observe to capture sync-return bytes
		// without triggering Proxy traps or reading accessors live.
		let syncBytesSnap: { bytesDesc?: PropertyDescriptor; statusDesc?: PropertyDescriptor } | null = null;
		let syncReadUncertain = false;
		try {
			if (typeof rawReadPromise === "object" && rawReadPromise !== null && !isExactNativePromise(rawReadPromise)) {
				if (types.isProxy(rawReadPromise)) {
					syncReadUncertain = true;
				} else {
					const statusDesc = Object.getOwnPropertyDescriptor(rawReadPromise, "status");
					const bytesDesc = Object.getOwnPropertyDescriptor(rawReadPromise, "bytes");
					// Snapshot bytes independently of status — a sync return with
					// only {bytes:genuine} and no status must still erase bytes.
					if (bytesDesc) {
						if ("value" in bytesDesc) {
							// Data descriptor — safe to snapshot even if
							// non-enumerable. Non-enumerable keeps uncertainty.
							if (!bytesDesc.enumerable) syncReadUncertain = true;
							syncBytesSnap = { bytesDesc };
						} else {
							// Accessor bytes — cannot read without trap.
							syncReadUncertain = true;
						}
					}
					// Accessor/non-enumerable status -> uncertainty
					if (statusDesc && (!("value" in statusDesc) || !statusDesc.enumerable)) {
						syncReadUncertain = true;
					}
				}
			}
		} catch {
			syncReadUncertain = true;
		}

		const readObserved = await observeExact(rawReadPromise);
		if (!readObserved.ok) {
			// Erase sync-return bytes if genuine exact transferred
			if (syncBytesSnap) {
				const syncBytes = syncBytesSnap.bytesDesc?.value;
				if (exactTransferred(syncBytes)) eraseTransferred(syncBytes);
			}
			if (syncReadUncertain) {
				readUncertain = true;
				readOk = false;
				break;
			}
			readOk = false;
			break;
		}

		// Descriptor-snapshot bytes field BEFORE any validation.
		// If the resolved value is a Proxy or has accessor/non-enumerable
		// bytes, that is uncertainty. If it holds a genuine exact-transferred
		// Uint8Array, erase it on every invalid-path exit.
		let promisedBytesDesc: PropertyDescriptor | undefined;
		let bytesIsUncertain = false;
		const rawVal = readObserved.value;
		if (typeof rawVal === "object" && rawVal !== null) {
			try {
				if (types.isProxy(rawVal)) {
					bytesIsUncertain = true;
				} else {
					const bd = Object.getOwnPropertyDescriptor(rawVal, "bytes");
					if (bd) {
						if ("value" in bd) {
							// Data descriptor — safe to snapshot.
							// Non-enumerable keeps cleanup uncertainty.
							if (!bd.enumerable) bytesIsUncertain = true;
							promisedBytesDesc = bd;
						} else {
							// Accessor bytes — cannot read without trap.
							bytesIsUncertain = true;
						}
					}
				}
			} catch {
				bytesIsUncertain = true;
			}
		}

		const bytesResult = exactDtor(rawVal, BYTES_KEYS);
		if (!bytesResult || bytesResult.status?.value !== "bytes") {
			// Erase genuine bytes even when status/keys are invalid.
			if (promisedBytesDesc && exactTransferred(promisedBytesDesc.value)) {
				eraseTransferred(promisedBytesDesc.value);
			}
			if (bytesIsUncertain) {
				readUncertain = true;
				readOk = false;
				break;
			}
			readOk = false;
			break;
		}
		const transferred = bytesResult.bytes?.value;
		if (transferred === undefined) {
			if (promisedBytesDesc && exactTransferred(promisedBytesDesc.value)) {
				eraseTransferred(promisedBytesDesc.value);
			}
			readOk = false;
			break;
		}
		if (!exactTransferred(transferred)) {
			// Genuine bytes already extracted via exactDtor; if the result
			// diverges from the descriptor snapshot, erase the genuine copy.
			if (promisedBytesDesc && exactTransferred(promisedBytesDesc.value)) {
				eraseTransferred(promisedBytesDesc.value);
			}
			if (bytesIsUncertain) {
				readUncertain = true;
				readOk = false;
				break;
			}
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
		let finalStat: SandboxCommandEntryStat | null = null;
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
		if (readUncertain) return { ok: false, code: "CLOSE_UNCERTAIN" };
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
	const decoded = decodeSandboxCommandRecordV1(ownBytes);
	ownBytes.fill(0);
	if (!decoded.ok) {
		if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- verify decoded record identity ---
	const record = decoded.record;
	if (
		record.recordSeq !== parsed.sequence ||
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
		sequence: parsed.sequence,
	});

	return { ok: true, record, fileMeta };
}

// ---------------------------------------------------------------------------
// Preliminary backend.close acquisition
//
// "Factory preliminary-acquires exact backend.close from direct own backend
//  descriptor before outer/identity/backend validation"
// ---------------------------------------------------------------------------

type PreliminaryState =
	| { readonly kind: "owner"; readonly close: () => unknown }
	| { readonly kind: "absent" }
	| { readonly kind: "uncertain" }
	| { readonly kind: "alias" };

function tryPreliminaryClose(raw: unknown, guard?: CloseGuard): PreliminaryState {
	if (typeof raw !== "object" || raw === null) {
		// null/undefined/primitive has provably no owner → absent
		return { kind: "absent" };
	}
	try {
		if (types.isProxy(raw)) return { kind: "uncertain" };
	} catch {
		return { kind: "uncertain" };
	}
	if (guard && guard.has(raw)) return { kind: "alias" };

	let backendValue: unknown;
	try {
		const backendDesc = Object.getOwnPropertyDescriptor(raw, "backend");
		if (!backendDesc) return { kind: "absent" };
		if (!("value" in backendDesc)) return { kind: "uncertain" };
		backendValue = backendDesc.value;
	} catch {
		return { kind: "uncertain" };
	}

	if (typeof backendValue !== "object" || backendValue === null) {
		// non-object backend value → provably no owner
		return { kind: "absent" };
	}

	try {
		if (types.isProxy(backendValue)) return { kind: "uncertain" };
	} catch {
		return { kind: "uncertain" };
	}

	// Extract close from its direct descriptor before full backend validation.
	try {
		const closeDesc = Object.getOwnPropertyDescriptor(backendValue, "close");
		if (!closeDesc) return { kind: "absent" };
		if (!closeDesc.enumerable) return { kind: "uncertain" };
		if (!("value" in closeDesc)) return { kind: "uncertain" };
		if (typeof closeDesc.value !== "function") return { kind: "absent" };
		if (types.isProxy(closeDesc.value)) return { kind: "uncertain" };
		const closeFn = closeDesc.value;
		// Register backend identity only after a valid own close is proven (rule 4).
		if (guard) guard.add(backendValue);
		return { kind: "owner", close: consumeCloseOnce((): unknown => Reflect.apply(closeFn, backendValue, [])) };
	} catch {
		return { kind: "uncertain" };
	}
}

// ---------------------------------------------------------------------------
// Sandbox command state machine — validates recordKind transitions and
// command identity (commandId/bodyDigest/commandType) across records.
// Valid sequences: none -> pending -> started -> completed | interrupted
// Invalid: duplicate pending, started without pending, transition after
// terminal, mutated command identity; cross-command interleaving allowed.
// ---------------------------------------------------------------------------

type SandboxCommandState = "none" | "pending" | "started" | "terminal";

interface CommandTracking {
	readonly commandId: string;
	state: SandboxCommandState;
	readonly bodyDigest: string;
	readonly commandType: string;
}

function validateCommandTransition(record: SandboxCommandRecordV1, entry: CommandTracking | null): string | null {
	if (!entry) {
		if (record.recordKind === "pending") return null;
		return "RECOVERY_FAILED";
	}
	switch (entry.state) {
		case "pending":
			if (record.recordKind === "started") return null;
			return "RECOVERY_FAILED";
		case "started":
			if (record.recordKind === "completed" || record.recordKind === "interrupted") return null;
			return "RECOVERY_FAILED";
		case "terminal":
			return "RECOVERY_FAILED";
		case "none":
			return "RECOVERY_FAILED";
	}
	return "RECOVERY_FAILED";
}

function determineCommandState(record: SandboxCommandRecordV1, _current: SandboxCommandState): SandboxCommandState {
	switch (record.recordKind) {
		case "pending":
			return "pending";
		case "started":
			return "started";
		case "completed":
		case "interrupted":
			return "terminal";
	}
	return _current;
}

// ===========================================================================
// runRecovery — inner scan logic, never closes the backend itself.
//               Returns success/error code; caller handles backend close.
// ===========================================================================

type RunRecoveryResult =
	| Readonly<{ ok: true; output: SandboxCommandRecoveryOutput }>
	| Readonly<{ ok: false; code: SandboxRecoveryErrorCode }>;

async function runRecovery(raw: unknown, closeGuard: CloseGuard): Promise<RunRecoveryResult> {
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
	let allEntries: SandboxCommandEntry[] = [];
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

		// --- sync-return page close cleanup ---
		let pageSyncClose: (() => unknown) | null = null;
		let pageSyncUncertain = false;
		try {
			if (typeof rawPagePromise === "object" && rawPagePromise !== null && !isExactNativePromise(rawPagePromise)) {
				const disc = discoverClose(rawPagePromise, closeGuard);
				pageSyncClose = disc.kind === "close" ? disc.fn : null;
				if (disc.kind === "uncertain" || disc.kind === "alias") pageSyncUncertain = true;
			}
		} catch {
			pageSyncUncertain = true;
		}

		const pageObserved = await observeExact(rawPagePromise);
		if (!pageObserved.ok) {
			const pageSyncCloseOk = pageSyncClose ? await checkedCloseExact(pageSyncClose) : !pageSyncUncertain;
			if (!pageSyncCloseOk) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		// --- parse and close page ---
		const parsed = await parseAndClosePage(pageObserved.value, closeGuard);
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
		const pageEntries: SandboxCommandEntry[] = [];

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
	const records: SandboxCommandRecordV1[] = [];
	const receipts: SandboxCommandFileReceipt[] = [];

	for (const entry of allEntries) {
		const parsedName = parseName(entry.name);
		if (!parsedName) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const fileResult = await readSingleFile(entry, parsedName, identity, backend, closeGuard, closeDominates);

		if (!fileResult.ok) {
			if (fileResult.code === "CLOSE_UNCERTAIN") closeDominates = true;
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: fileResult.code };
		}

		receipts.push(
			Object.freeze({
				sequence: fileResult.fileMeta.sequence,
				size: fileResult.fileMeta.fileSize,
				sha256: fileResult.fileMeta.sha256,
			}),
		);
		records.push(fileResult.record);
	}

	// -----------------------------------------------------------------------
	// Command state-machine validation — verify legal state transitions
	// per commandId and exact command identity (bodyDigest/commandType).
	// -----------------------------------------------------------------------
	const commandStates = new Map<string, CommandTracking>();
	for (const record of records) {
		const existing = commandStates.get(record.commandId) ?? null;
		if (existing !== null) {
			// Verify command identity consistency across transitions
			if (existing.bodyDigest !== record.bodyDigest || existing.commandType !== record.commandType) {
				if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
				return { ok: false, code: "RECOVERY_FAILED" };
			}
		}
		const stateErr = validateCommandTransition(record, existing);
		if (stateErr !== null) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}
		if (!existing) {
			commandStates.set(record.commandId, {
				commandId: record.commandId,
				state: determineCommandState(record, "none"),
				bodyDigest: record.bodyDigest,
				commandType: record.commandType,
			});
		} else {
			existing.state = determineCommandState(record, existing.state);
		}
	}

	// -----------------------------------------------------------------------
	// Verify record ordering — each recordSeq must match the file order
	// (contiguous 1-based sequence already enforced by parseName checks in
	// pass 1, but we also verify decoded recordSeq matches parsed sequence)
	// -----------------------------------------------------------------------
	for (let i = 0; i < records.length; i += 1) {
		const expectedSeq = i + 1;
		if (records[i].recordSeq !== expectedSeq) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}
	}

	// Verify receipts match their decoded records in ordering
	for (let i = 0; i < receipts.length; i += 1) {
		if (receipts[i].sequence !== i + 1) {
			if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };
			return { ok: false, code: "RECOVERY_FAILED" };
		}
	}

	const frozenRecords: readonly SandboxCommandRecordV1[] = Object.freeze(records.map((r) => r));
	const frozenReceipts: readonly SandboxCommandFileReceipt[] = Object.freeze(receipts.map((r) => r));

	const output: SandboxCommandRecoveryOutput = Object.freeze({
		identity: Object.freeze({
			hostId: identity.hostId,
			generation: identity.generation,
			sessionId: identity.sessionId,
		}),
		records: frozenRecords,
		receipts: frozenReceipts,
		totalBytes,
		nextSequence,
	});

	// Close dominance: if ANY page/handle close failed during scan,
	// return CLOSE_UNCERTAIN even if the scan produced valid output.
	if (closeDominates) return { ok: false, code: "CLOSE_UNCERTAIN" };

	return { ok: true, output };
}

// ===========================================================================
// recoverSandboxCommandJournal — main export
//
// Structure: acquire backend.close preliminarily, run scan, then close
// backend and return CLOSE_UNCERTAIN if close is not exact. Closure of
// backend is always last after all page/handle cleanup.
// ===========================================================================

export async function recoverSandboxCommandJournal(raw: unknown): Promise<SandboxCommandRecoveryResult> {
	// ONE ownership registry from preliminary backend acquisition through pages/handles.
	const closeGuard: CloseGuard = new WeakSet();

	// Preliminary backend.close acquisition (before any validation)
	const preliminary = tryPreliminaryClose(raw, closeGuard);
	if (preliminary.kind === "uncertain" || preliminary.kind === "alias") return fail("CLOSE_UNCERTAIN");
	if (preliminary.kind === "absent") return fail("INVALID_ARGUMENT");
	const prelimClose = preliminary.close;

	// Run inner scan (never closes backend directly). A rejected internal path
	// must not bypass the backend owner acquired above.
	let scan: RunRecoveryResult;
	try {
		scan = await runRecovery(raw, closeGuard);
	} catch {
		scan = { ok: false, code: "RECOVERY_FAILED" };
	}

	// Backend close — always last on EVERY path, uncertainty dominates.
	// Must close backend even when state-machine validation fails.
	const backendCloseOk = await checkedCloseExact(prelimClose);

	if (!backendCloseOk) return fail("CLOSE_UNCERTAIN");
	if (!scan.ok) return fail(scan.code);
	return Object.freeze({ ok: true, value: scan.output }) satisfies SandboxCommandRecoveryOk;
}
