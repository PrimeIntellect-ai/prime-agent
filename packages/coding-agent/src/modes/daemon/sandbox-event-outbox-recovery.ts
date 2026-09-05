/**
 * SandboxEventOutboxJournal recovery scanner — reads durable event-outbox
 * journal files through a paginated backend, validates per-file identity
 * and sequence order, and returns a deep-frozen recovered snapshot.
 *
 * Pure scanner: no store, publisher, or filesystem backend included.
 * Backend is injected at the call site.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { SandboxEventOutboxRecordV1 } from "./sandbox-event-outbox-record-codec.js";
import { decodeSandboxEventOutboxRecordV1 } from "./sandbox-event-outbox-record-codec.js";

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

const FILE_NAME = /^(\d{20})\.b14-event-outbox$/;
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

export const EVENT_OUTBOX_RECOVERY_ERRORS = Object.freeze({
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	RECOVERY_FAILED: "RECOVERY_FAILED",
	IO_UNCONFIRMED: "IO_UNCONFIRMED",
	CLOSE_UNCERTAIN: "CLOSE_UNCERTAIN",
});

export type EventOutboxRecoveryErrorCode =
	(typeof EVENT_OUTBOX_RECOVERY_ERRORS)[keyof typeof EVENT_OUTBOX_RECOVERY_ERRORS];

// ===========================================================================
// Input/output types
// ===========================================================================

export interface EventOutboxIdentity {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
}

export interface EventOutboxEntryStat {
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

export interface EventOutboxEntry {
	readonly name: string;
	readonly stat: EventOutboxEntryStat;
}

export interface EventOutboxListPageRequest {
	readonly cursor: string | null;
	readonly maxEntries: 64;
	readonly maxBytes: 16_777_216;
}

export interface EventOutboxPageResult {
	readonly status: "page";
	readonly entries: readonly EventOutboxEntry[];
	readonly nextCursor: string | null;
	readonly close: () => unknown;
}

export interface EventOutboxOpenRequest {
	readonly name: string;
	readonly expected: EventOutboxEntryStat;
}

export interface EventOutboxReadHandle {
	readonly readAt: (offset: number, size: number) => unknown;
	readonly confirmEof: (size: number) => unknown;
	readonly fstat: () => unknown;
	readonly close: () => unknown;
}

export type EventOutboxOpenResult =
	| Readonly<{ status: "opened"; handle: EventOutboxReadHandle }>
	| Readonly<{ status: "missing" }>;

export interface EventOutboxBackend {
	readonly listPage: (request: EventOutboxListPageRequest) => unknown;
	readonly open: (request: EventOutboxOpenRequest) => unknown;
	readonly close: () => unknown;
}

export interface EventOutboxRecoveryInput {
	readonly backend: EventOutboxBackend;
	readonly identity: EventOutboxIdentity;
}

// ===========================================================================
// Output types
// ===========================================================================

export interface EventOutboxFileReceipt {
	readonly sequence: number;
	readonly size: number;
	readonly sha256: string;
}

export interface EventOutboxRecoveryOutput {
	readonly identity: EventOutboxIdentity;
	readonly records: readonly SandboxEventOutboxRecordV1[];
	readonly totalBytes: number;
	readonly nextJournalSeq: number;
	readonly receipts: readonly EventOutboxFileReceipt[];
}

export interface EventOutboxRecoveryOk {
	readonly ok: true;
	readonly value: EventOutboxRecoveryOutput;
}

export interface EventOutboxRecoveryError {
	readonly ok: false;
	readonly error: Readonly<{ code: EventOutboxRecoveryErrorCode }>;
}

export type EventOutboxRecoveryResult = EventOutboxRecoveryOk | EventOutboxRecoveryError;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

type BoundBackend = Readonly<{
	listPage: (request: EventOutboxListPageRequest) => unknown;
	open: (request: EventOutboxOpenRequest) => unknown;
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
// CleanupRegistry — tracks backend, page, and handle close ownership
//
// Records object identity after a valid direct own enumerable non-Proxy
// close function is proven.  Distinguishes:
//   - "owner":  direct own enumerable non-Proxy close function found
//   - "alias":  close function identical to an already-registered close
//   - "uncertain": Proxy/accessor/non-enumerable/hidden close (cannot safely invoke)
//   - "none":   no descriptor or non-function value (provable absence)
//
// closeAll() invokes each owner close ≤1 time, in strict reverse
// acquisition order, with backend last.  Any close failure causes the
// entire result to be CLOSE_UNCERTAIN.
// ===========================================================================

export type CleanupState = "none" | "owner" | "alias" | "uncertain";

/**
 * Classify how a close function relates to a raw object.
 *
 * Rules:
 * - Proxy object → uncertain
 * - No own `close` descriptor → none (provable absence on non-proxy object)
 * - Accessor descriptor → uncertain
 * - Value descriptor, value not a function → none (provably not a close function)
 * - Value descriptor, value is function but is Proxy → uncertain
 * - Non-enumerable descriptor → uncertain (hidden close)
 * - Value descriptor, value is function, not Proxy, enumerable → owner
 */
function classifyClose(raw: unknown): {
	state: CleanupState;
	close: (() => unknown) | null;
	rawFn: ((...args: readonly unknown[]) => unknown) | null;
} {
	if (raw === null || raw === undefined || typeof raw !== "object") {
		return { state: "none", close: null, rawFn: null };
	}
	try {
		if (types.isProxy(raw)) {
			return { state: "uncertain", close: null, rawFn: null };
		}
	} catch {
		return { state: "uncertain", close: null, rawFn: null };
	}
	try {
		const desc = Object.getOwnPropertyDescriptor(raw, "close");
		// No own close descriptor => provable absence
		if (!desc) {
			return { state: "none", close: null, rawFn: null };
		}
		// Non-enumerable => hidden, uncertain
		if (!desc.enumerable) {
			return { state: "uncertain", close: null, rawFn: null };
		}
		// Accessor descriptor => uncertain
		if (!("value" in desc)) {
			return { state: "uncertain", close: null, rawFn: null };
		}
		// Value is not a function => provably not a close function
		if (typeof desc.value !== "function") {
			return { state: "none", close: null, rawFn: null };
		}
		// Value is a function but is a Proxy => uncertain
		if (types.isProxy(desc.value)) {
			return { state: "uncertain", close: null, rawFn: null };
		}
		const fn: (...args: readonly unknown[]) => unknown = desc.value;
		const bound = (): unknown => Reflect.apply(fn, raw, []);
		return { state: "owner", close: bound, rawFn: fn };
	} catch {
		return { state: "uncertain", close: null, rawFn: null };
	}
}

interface CloseEntry {
	raw: object | null;
	rawFn: ((...args: readonly unknown[]) => unknown) | null;
	close: (() => unknown) | null;
	state: CleanupState;
	closed: boolean;
	closeFailed: boolean;
}

export class CleanupRegistry {
	private readonly _entryClose: CloseEntry[] = [];
	private readonly _knownCloseFns = new Set<(...args: readonly unknown[]) => unknown>();
	private readonly _objectToEntry = new WeakMap<object, number>();
	private _didCloseAll = false;
	private _closeAllPromise: Promise<boolean> | null = null;

	/**
	 * Record a raw object for cleanup.  Returns the classification state and
	 * entry index.
	 */
	record(raw: unknown, _label: string): { state: CleanupState; index: number } {
		const idx = this._entryClose.length;
		if (raw === null || raw === undefined || typeof raw !== "object") {
			this._entryClose.push({
				raw: null,
				rawFn: null,
				close: null,
				state: "none",
				closed: false,
				closeFailed: false,
			});
			return { state: "none", index: idx };
		}
		// If the exact same object was already registered, re-register is alias
		// regardless of whether its close function reference changed.
		const existingIdx = this._objectToEntry.get(raw);
		if (existingIdx !== undefined) {
			const existing = this._entryClose[existingIdx];
			const sameFn = existing.state === "owner" && existing.rawFn !== null;
			this._entryClose.push({
				raw,
				rawFn: sameFn ? existing.rawFn : null,
				close: null,
				state: "alias",
				closed: false,
				closeFailed: false,
			});
			return { state: "alias", index: idx };
		}
		const classified = classifyClose(raw);
		if (classified.state === "owner" && classified.rawFn !== null) {
			if (this._knownCloseFns.has(classified.rawFn)) {
				this._entryClose.push({
					raw,
					rawFn: classified.rawFn,
					close: null,
					state: "alias",
					closed: false,
					closeFailed: false,
				});
				return { state: "alias", index: idx };
			}
			this._knownCloseFns.add(classified.rawFn);
			this._entryClose.push({
				raw,
				rawFn: classified.rawFn,
				close: classified.close,
				state: "owner",
				closed: false,
				closeFailed: false,
			});
			this._objectToEntry.set(raw, idx);
			return { state: "owner", index: idx };
		}
		this._entryClose.push({
			raw,
			rawFn: classified.rawFn,
			close: classified.close,
			state: classified.state,
			closed: false,
			closeFailed: false,
		});
		this._objectToEntry.set(raw, idx);
		return { state: classified.state, index: idx };
	}

	/**
	 * Close the owner entry for a specific raw object.
	 * Looks up the entry by object identity via WeakMap.
	 */
	async closeRegistered(raw: object): Promise<boolean> {
		const idx = this._objectToEntry.get(raw);
		if (idx === undefined) return true;
		const entry = this._entryClose[idx];
		if (entry.closed || entry.state !== "owner" || entry.close === null) return true;
		entry.closed = true;
		try {
			const rawResult = entry.close();
			const observed = await observeExact(rawResult);
			if (!observed.ok) {
				entry.closeFailed = true;
				return false;
			}
			const result = exactDtor(observed.value, CLOSED_STATUS_KEYS);
			if (result?.status?.value !== "closed") {
				entry.closeFailed = true;
				return false;
			}
			return true;
		} catch {
			entry.closeFailed = true;
			return false;
		}
	}

	/**
	 * Close every owner ≤1 time in strict reverse acquisition order.
	 * Skips already-closed entries.
	 * Idempotent: only the first call does work.
	 */
	async closeAll(): Promise<boolean> {
		if (this._didCloseAll) {
			return this._closeAllPromise ?? Promise.resolve(true);
		}
		this._didCloseAll = true;
		const p = this._doCloseAll();
		this._closeAllPromise = p;
		return p;
	}

	private async _doCloseAll(): Promise<boolean> {
		let allOk = true;
		for (let i = this._entryClose.length - 1; i >= 0; i -= 1) {
			const entry = this._entryClose[i];
			if (entry.closed || entry.state !== "owner" || entry.close === null) continue;
			entry.closed = true;
			try {
				const raw = entry.close();
				const observed = await observeExact(raw);
				if (!observed.ok) {
					entry.closeFailed = true;
					allOk = false;
					continue;
				}
				const result = exactDtor(observed.value, CLOSED_STATUS_KEYS);
				if (result?.status?.value !== "closed") {
					entry.closeFailed = true;
					allOk = false;
				}
			} catch {
				entry.closeFailed = true;
				allOk = false;
			}
		}
		return allOk;
	}

	/**
	 * Return true if ANY entry has uncertain or alias state.
	 */
	get hasUncertainty(): boolean {
		return this._entryClose.some((e) => e.state === "uncertain" || e.state === "alias");
	}

	/**
	 * Return true if ANY entry has uncertain state.
	 */
	get hasCloseUncertainty(): boolean {
		return this._entryClose.some((e) => e.state === "uncertain");
	}

	/**
	 * Return true if any close failed.
	 */
	get anyCloseFailed(): boolean {
		return this._entryClose.some((e) => e.closeFailed);
	}

	/**
	 * Return the count of owner entries.
	 */
	get ownerCount(): number {
		return this._entryClose.filter((e) => e.state === "owner").length;
	}

	/**
	 * Return the count of alias entries.
	 */
	get aliasCount(): number {
		return this._entryClose.filter((e) => e.state === "alias").length;
	}

	/**
	 * Return the count of uncertain entries.
	 */
	get uncertainCount(): number {
		return this._entryClose.filter((e) => e.state === "uncertain").length;
	}

	/**
	 * Return the count of none entries.
	 */
	get noneCount(): number {
		return this._entryClose.filter((e) => e.state === "none").length;
	}

	/** Total entries. */
	get size(): number {
		return this._entryClose.length;
	}

	/** Snapshot for assertions. */
	snapshot(): ReadonlyArray<{ state: CleanupState; closed: boolean; closeFailed: boolean }> {
		return Object.freeze(
			this._entryClose.map((e) => Object.freeze({ state: e.state, closed: e.closed, closeFailed: e.closeFailed })),
		);
	}
}
// ===========================================================================
// isPromise — descriptor-safe exact native Promise classifier
//
// Uses types.isPromise (node:util), exact Promise.prototype comparison,
// zero own names/symbols check, Proxy reject.  No instanceof, no .then
// reads.  Returns true only for a bare native Promise with no own
// properties or symbols.
// ===========================================================================

export function isPromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
	} catch {
		return false;
	}
	const proto = Object.getPrototypeOf(raw);
	if (proto !== Promise.prototype) return false;
	if (Object.getOwnPropertyNames(raw).length > 0) return false;
	if (Object.getOwnPropertySymbols(raw).length > 0) return false;
	if (!types.isPromise(raw)) return false;
	return true;
}

// ===========================================================================
// Module-level TypedArray getter captures — captured once at initialization
// ===========================================================================

const _taProto = Object.getPrototypeOf(Uint8Array.prototype);
const _byteLengthGetter = Object.getOwnPropertyDescriptor(_taProto, "byteLength")?.get;
const _byteOffsetGetter = Object.getOwnPropertyDescriptor(_taProto, "byteOffset")?.get;
const _bufferGetter = Object.getOwnPropertyDescriptor(_taProto, "buffer")?.get;
const _abLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const _fillFn = Uint8Array.prototype.fill;

// ===========================================================================
// exactTransferred — validate a full-backing genuine Uint8Array
//
// Rejects Buffer/subclass, SAB, detached, subview, extras/overrides,
// own symbols, custom proto, Proxy.  Uses getters captured at module init.
// Only accepted genuine bytes are erased; invalid bytes remain untouched.
// ===========================================================================

export function exactTransferred(raw: unknown): raw is Uint8Array {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			!_byteLengthGetter ||
			!_byteOffsetGetter ||
			!_bufferGetter ||
			!_abLengthGetter
		)
			return false;
		// Reject own overrides for buffer/byteLength/byteOffset
		if (
			Object.getOwnPropertyDescriptor(raw, "buffer") ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset")
		)
			return false;
		// Reject own symbols and named extras beyond the numeric indices
		if (Object.getOwnPropertySymbols(raw).length > 0) return false;
		const ownNames = Object.getOwnPropertyNames(raw);
		const byteLength = Reflect.apply(_byteLengthGetter, raw, []);
		if (typeof byteLength !== "number" || byteLength <= 0) return false;
		// Must have exactly byteLength numeric-indexed own properties
		if (ownNames.length !== byteLength) return false;
		for (let i = 0; i < byteLength; i++) {
			if (ownNames[i] !== String(i)) return false;
		}
		const byteOffset = Reflect.apply(_byteOffsetGetter, raw, []);
		const buffer = Reflect.apply(_bufferGetter, raw, []);
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(_abLengthGetter, buffer, []);
		return (
			typeof byteOffset === "number" &&
			typeof backingLength === "number" &&
			byteOffset === 0 &&
			byteLength === backingLength
		);
	} catch {
		return false;
	}
}

// ===========================================================================
// eraseTransferred — zero-fill a Uint8Array in place
//
// ONLY called after exactTransferred accepts.  Invalid bytes remain
// byte-for-byte unchanged.  Sync genuine bytes are erased.
// ===========================================================================

function eraseTransferred(raw: unknown): void {
	if (!exactTransferred(raw)) return;
	try {
		const getter = _byteLengthGetter;
		if (!getter) return;
		const length: number = Reflect.apply(getter, raw, []);
		if (length > 0) Reflect.apply(_fillFn, raw, [0]);
	} catch {
		// Not safely writable.
	}
}

// ===========================================================================
// Helpers
// ===========================================================================

function fail(code: EventOutboxRecoveryErrorCode): EventOutboxRecoveryError {
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

function snapshotIdentity(raw: unknown): EventOutboxIdentity | null {
	const values = exactDtor(raw, IDENTITY_KEYS);
	if (!values) return null;
	const hostId = values.hostId?.value;
	const generation = values.generation?.value;
	const sessionId = values.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

// ---------------------------------------------------------------------------
// bindBackend – extract listPage & open (close extracted separately)
// ---------------------------------------------------------------------------

function bindBackend(raw: unknown): BoundBackend | null {
	const values = exactDtor(raw, BACKEND_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const listPage = methodFn(values, raw, "listPage");
	const open = methodFn(values, raw, "open");
	if (!listPage || !open) return null;
	return Object.freeze({
		listPage: (request: EventOutboxListPageRequest): unknown => Reflect.apply(listPage, undefined, [request]),
		open: (request: EventOutboxOpenRequest): unknown => Reflect.apply(open, undefined, [request]),
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

function snapshotStat(raw: unknown): EventOutboxEntryStat | null {
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

function snapshotEntry(raw: unknown): EventOutboxEntry | null {
	const value = exactDtor(raw, ENTRY_KEYS);
	if (!value) return null;
	const name = value.name?.value;
	const stat = snapshotStat(value.stat?.value);
	return typeof name === "string" && stat ? Object.freeze({ name, stat }) : null;
}

// ---------------------------------------------------------------------------
// ownData
// ---------------------------------------------------------------------------

function _ownData(raw: unknown, name: string): unknown {
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
// checkedCloseExact – observe a close function via observeExact and verify
//                     the result is {status:"closed"}.
// ---------------------------------------------------------------------------

async function _checkedCloseExact(closeFn: () => unknown): Promise<boolean> {
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
// observeExact – validate a host-guaranteed bare native Promise and observe
//                it, returning an ObserveResult union (no Error objects).
//
// Validates: non-proxy, Promise.prototype, zero own names/symbols,
// types.isPromise.  Uses isPromise() classifier (no instanceof, no .then
// reads).  Bounded referenced timer.
// ---------------------------------------------------------------------------

function observeExact(raw: unknown, timeout: number = PROMISE_TIMEOUT_MS): Promise<ObserveResult> {
	return new Promise<ObserveResult>((resolve) => {
		if (!isPromise(raw)) {
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
// parseAndClosePage – validate page shape, snapshot entries, close page
//
// Records page via CleanupRegistry.  Returns closeOk=false if page close
// failed, but still validates page content.
// ---------------------------------------------------------------------------

interface ParsedPage {
	readonly entries: readonly EventOutboxEntry[];
	readonly nextCursor: string | null;
}

async function parseAndClosePage(
	raw: unknown,
	cleanup: CleanupRegistry,
): Promise<{ ok: true; page: ParsedPage; closeOk: boolean } | { ok: false; closeOk: boolean; domainError: boolean }> {
	// --- record page in cleanup registry (any discoverable close) ---
	const { state: pageState } = cleanup.record(raw, "page");
	const pageCloseSafe = pageState === "owner" || pageState === "none";

	const value = exactDtor(raw, PAGE_RESULT_KEYS);
	if (!value) {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}
	if (value.status?.value !== "page") {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}

	const entriesRaw = value.entries?.value;
	const nextCursor = value.nextCursor?.value;
	const closeRaw = value.close?.value;

	// Validate entries array
	if (!Array.isArray(entriesRaw)) {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}
	try {
		if (
			types.isProxy(entriesRaw) ||
			Object.getPrototypeOf(entriesRaw) !== Array.prototype ||
			Object.getOwnPropertySymbols(entriesRaw).length !== 0
		) {
			return { ok: false, closeOk: pageCloseSafe, domainError: true };
		}
	} catch {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}

	if (entriesRaw.length > PAGE_MAX_ENTRIES) {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}

	if (nextCursor !== null && (typeof nextCursor !== "string" || !CURSOR.test(nextCursor))) {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}
	if (typeof closeRaw !== "function") {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}
	try {
		if (types.isProxy(closeRaw)) {
			return { ok: false, closeOk: pageCloseSafe, domainError: true };
		}
	} catch {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}

	// Snapshot entries
	const entries: EventOutboxEntry[] = [];
	for (let i = 0; i < entriesRaw.length; i += 1) {
		if (!Object.hasOwn(entriesRaw, i)) {
			return { ok: false, closeOk: pageCloseSafe, domainError: true };
		}
		const desc = Object.getOwnPropertyDescriptor(entriesRaw, String(i));
		if (!desc || !("value" in desc) || !desc.enumerable) {
			return { ok: false, closeOk: pageCloseSafe, domainError: true };
		}
		const entry = snapshotEntry(desc.value);
		if (!entry) {
			return { ok: false, closeOk: pageCloseSafe, domainError: true };
		}
		entries.push(entry);
	}
	const ownNames = Object.getOwnPropertyNames(entriesRaw);
	if (ownNames.length !== entriesRaw.length + 1 || ownNames.at(-1) !== "length") {
		return { ok: false, closeOk: pageCloseSafe, domainError: true };
	}

	// Close page immediately after parsing (before next page)
	const pageCloseOkResult = typeof raw === "object" && raw !== null ? await cleanup.closeRegistered(raw) : true;

	return {
		ok: true,
		page: Object.freeze({ entries: Object.freeze(entries), nextCursor }),
		closeOk: pageCloseOkResult && pageCloseSafe,
	};
}

// ---------------------------------------------------------------------------
// acquireHandle – extract handle from a raw open result
//
// Discovers the handle's `handle` descriptor BEFORE full validation.
// Records only the handle inside (not the outer open result) in the
// CleanupRegistry.  The outer {status,handle} / {status:'missing'}
// result is a data envelope, not a close owner.
//
// If handle has a valid close, records it.  If handle is missing from
// a non-missing result, it's malformed.
// ---------------------------------------------------------------------------

interface AcquiredHandle {
	readonly close: (() => unknown) | null;
	readonly handleRaw: unknown | undefined;
	readonly state: "missing" | "opened" | "malformed";
	/** How the handle close was classified in the registry. */
	readonly cleanup: CleanupState;
}

function acquireHandle(rawOpen: unknown, cleanup: CleanupRegistry): AcquiredHandle {
	// Primitive/null resolved open result => provable absence, not uncertainty
	if (typeof rawOpen !== "object" || rawOpen === null) {
		return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "none" });
	}

	// Check for {status:"missing"} first
	const missing = exactDtor(rawOpen, OPEN_MISSING_KEYS);
	if (missing?.status?.value === "missing") {
		return Object.freeze({ close: null, handleRaw: undefined, state: "missing", cleanup: "none" });
	}

	// Proxy outer open result => uncertain (cannot inspect handle descriptor)
	try {
		if (types.isProxy(rawOpen)) {
			return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "uncertain" });
		}
	} catch {
		return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "uncertain" });
	}

	// Discover handle descriptor directly from rawOpen BEFORE full validation
	let handleRaw: unknown;
	try {
		const handleDescriptor = Object.getOwnPropertyDescriptor(rawOpen, "handle");
		if (!handleDescriptor) {
			// No own handle descriptor at all
			return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "none" });
		}
		if (!("value" in handleDescriptor)) {
			// Accessor `handle` descriptor => uncertainty
			return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "uncertain" });
		}
		handleRaw = handleDescriptor.value;
		if (!handleDescriptor.enumerable) {
			// Non-enumerable data `handle` (hidden structure)
			// Register the nested owner if genuine, but mark cleanup uncertain
			cleanup.record(handleRaw, "handle");
			const fns = classifyClose(handleRaw);
			const hClose = fns.state === "owner" ? fns.close : null;
			return Object.freeze({
				close: hClose,
				handleRaw,
				state: "malformed",
				cleanup: "uncertain",
			});
		}
	} catch {
		// Reflection failure => uncertainty
		return Object.freeze({ close: null, handleRaw: undefined, state: "malformed", cleanup: "uncertain" });
	}

	// Enumerable value descriptor for `handle` — normal path
	const { state: handleState } = cleanup.record(handleRaw, "handle");
	const handleCloseFns = classifyClose(handleRaw);
	let close: (() => unknown) | null = null;
	if (handleCloseFns.state === "owner") {
		close = handleCloseFns.close;
	}

	// Validate the outer open result has {status:"opened"}
	const opened = exactDtor(rawOpen, OPENED_KEYS);
	if (opened?.status?.value === "opened") {
		return Object.freeze({ close, handleRaw, state: "opened", cleanup: handleState });
	}

	// Outer result has enumerable value handle but not {status:"opened"} — malformed
	return Object.freeze({ close, handleRaw: undefined, state: "malformed", cleanup: handleState });
}

interface FileMeta {
	readonly sha256: string;
	readonly fileSize: number;
	readonly journalSeq: number;
}

// ---------------------------------------------------------------------------
// readSingleFile – open, validate, read, confirmEof, close handle, decode
//
// Records handle close in CleanupRegistry.  Close failure propagates via
// cleanup.closeAll() at the end.
// ---------------------------------------------------------------------------

async function readSingleFile(
	entry: EventOutboxEntry,
	parsed: ParsedName,
	identity: EventOutboxIdentity,
	backend: BoundBackend,
	cleanup: CleanupRegistry,
): Promise<
	| { ok: true; record: SandboxEventOutboxRecordV1; fileMeta: FileMeta }
	| { ok: false; code: EventOutboxRecoveryErrorCode }
> {
	let readUncertain = false;

	// --- open ---
	let rawOpenPromise: unknown;
	try {
		rawOpenPromise = backend.open(Object.freeze({ name: entry.name, expected: entry.stat }));
	} catch {
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	const openObserved = await observeExact(rawOpenPromise);
	if (!openObserved.ok) {
		// Sync/non-promise open result — descriptor-snapshot handle property directly
		// for exact nested owner registration and closure.
		// Primitive/null sync result => provable absence of nested owner
		if (typeof rawOpenPromise !== "object" || rawOpenPromise === null) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}
		// Guard: Proxy sync result => uncertainty with zero traps
		try {
			if (types.isProxy(rawOpenPromise)) return { ok: false, code: "CLOSE_UNCERTAIN" };
		} catch {
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}
		let syncHandleDesc: PropertyDescriptor | undefined;
		try {
			syncHandleDesc = Object.getOwnPropertyDescriptor(rawOpenPromise, "handle");
		} catch {
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}
		if (syncHandleDesc && "value" in syncHandleDesc && syncHandleDesc.enumerable) {
			// Enumerable value descriptor — register the handle owner, close immediately
			const { state: syncHandleState } = cleanup.record(syncHandleDesc.value, "sync-open-handle");
			if (syncHandleState === "owner") {
				await cleanup.closeRegistered(syncHandleDesc.value);
			} else if (syncHandleState === "uncertain" || syncHandleState === "alias") {
				return { ok: false, code: "CLOSE_UNCERTAIN" };
			}
		} else if (syncHandleDesc && "value" in syncHandleDesc && !syncHandleDesc.enumerable) {
			// Non-enumerable data handle => hidden structure
			// Register the handle close owner and close it, but keep uncertainty
			const { state: hiddenState } = cleanup.record(syncHandleDesc.value, "sync-open-nonenum-handle");
			if (hiddenState === "owner") {
				await cleanup.closeRegistered(syncHandleDesc.value);
			}
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		} else if (syncHandleDesc && !("value" in syncHandleDesc)) {
			// Accessor handle descriptor => uncertainty
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}
		// No handle descriptor at all
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- acquire handle descriptor before full validation ---
	const acquired = acquireHandle(openObserved.value, cleanup);

	if (acquired.state === "missing") {
		return { ok: false, code: "RECOVERY_FAILED" };
	}
	if (acquired.state === "malformed") {
		// Propagate uncertainty from handle classification
		if (acquired.cleanup === "uncertain" || acquired.cleanup === "alias") {
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}
		return { ok: false, code: "RECOVERY_FAILED" };
	}
	// opened state but no close function: provable absence => RECOVERY_FAILED
	if (!acquired.close) {
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// Bind handle methods (readAt, confirmEof, fstat)
	const hnd = bindHandle(acquired.handleRaw);
	if (!hnd) {
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- read contents ---
	const assembledBytes = new Uint8Array(entry.stat.size);
	let offset = 0;
	let readOk = true;

	// fstat before read
	let initialStat: EventOutboxEntryStat | null = null;
	try {
		const initialRaw = hnd.fstat();
		if (!isPromise(initialRaw)) {
			// Sync fstat is always invalid — snapshot to discover any owner, then reject
			readOk = false;
		} else {
			const observedStat = await observeExact(initialRaw);
			if (observedStat.ok) {
				initialStat = snapshotStat(observedStat.value);
			}
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
		// --- Sync/non-exact-Promise readAt return ---
		// Descriptor-snapshot the direct page/handle/bytes before rejecting.
		// Erase only genuine transferred bytes; eraseTransferred is safe-only.
		if (!isPromise(rawReadPromise)) {
			// Sync read is always invalid — descriptor-snapshot for uncertainty/erasure, then reject
			// Primitive/null sync result => provable absence of bytes
			if (typeof rawReadPromise !== "object" || rawReadPromise === null) {
				readOk = false;
				break;
			}
			// Guard: Proxy sync result => uncertainty with zero traps
			try {
				if (types.isProxy(rawReadPromise)) {
					readUncertain = true;
					readOk = false;
					break;
				}
			} catch {
				readUncertain = true;
				readOk = false;
				break;
			}
			let syncReadBytesDesc: PropertyDescriptor | undefined;
			try {
				syncReadBytesDesc = Object.getOwnPropertyDescriptor(rawReadPromise, "bytes");
			} catch {
				readUncertain = true;
				readOk = false;
				break;
			}
			if (!syncReadBytesDesc) {
				readOk = false;
				break;
			}
			if (!("value" in syncReadBytesDesc)) {
				readUncertain = true;
				readOk = false;
				break;
			}
			if (!syncReadBytesDesc.enumerable) {
				// Non-enumerable data descriptor (hidden bytes) => uncertainty
				eraseTransferred(syncReadBytesDesc.value);
				readUncertain = true;
				readOk = false;
				break;
			}
			// Enumerable data descriptor - snapshot and erase genuine bytes, reject
			eraseTransferred(syncReadBytesDesc.value);
			readOk = false;
			break;
		}
		const readObserved = await observeExact(rawReadPromise);
		if (!readObserved.ok) {
			readOk = false;
			break;
		}
		// --- Handle promised value, which may be Proxy/accessor/hidden ---
		const readValue = readObserved.value;
		let isReadUncertain = false;
		try {
			if (types.isProxy(readValue)) {
				isReadUncertain = true;
			}
		} catch {
			isReadUncertain = true;
		}
		if (isReadUncertain) {
			// Proxy/accessor result: cannot safely inspect bytes or erase
			readUncertain = true;
			readOk = false;
			break;
		}
		// Discover bytes descriptor independently of status/exactness
		let bytesDescriptor: PropertyDescriptor | undefined;
		try {
			bytesDescriptor = Object.getOwnPropertyDescriptor(readValue, "bytes");
		} catch {
			readOk = false;
			break;
		}
		if (!bytesDescriptor) {
			readOk = false;
			break;
		}
		if (!("value" in bytesDescriptor)) {
			// Accessor bytes descriptor => uncertain
			readUncertain = true;
			readOk = false;
			break;
		}
		const bytesRaw = bytesDescriptor.value;
		// Non-enumerable data descriptor (hidden bytes) => uncertain even if genuine
		if (!bytesDescriptor.enumerable) {
			// Erase if genuine (re-checked by exactTransferred called from eraseTransferred)
			eraseTransferred(bytesRaw);
			readUncertain = true;
			readOk = false;
			break;
		}
		// Check if bytes is an exact genuine full-backing Uint8Array before status validation
		if (!exactTransferred(bytesRaw)) {
			// Invalid bytes (Buffer/subclass/Proxy/subview/extras) left untouched
			readOk = false;
			break;
		}
		// Owned genuine bytes captured — erase on any exit path below
		let erased = false;
		const eraseBytes = (): void => {
			if (!erased) {
				erased = true;
				eraseTransferred(bytesRaw);
			}
		};
		// Validate status shape (may reject, but bytes already captured)
		const bytesResult = exactDtor(readValue, BYTES_KEYS);
		if (!bytesResult || bytesResult.status?.value !== "bytes") {
			eraseBytes();
			readOk = false;
			break;
		}
		const blen = _byteLengthGetter;
		if (!blen) {
			eraseBytes();
			readOk = false;
			break;
		}
		const tLen: number = Reflect.apply(blen, bytesRaw, []);
		if (typeof tLen !== "number" || tLen < 1 || tLen > requested) {
			eraseBytes();
			readOk = false;
			break;
		}
		try {
			assembledBytes.set(bytesRaw, offset);
			offset += tLen;
		} finally {
			eraseBytes();
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
			if (!isPromise(confirmRawPromise)) {
				// Sync confirm is always invalid
				readOk = false;
			} else {
				const confirmObserved = await observeExact(confirmRawPromise);
				if (!confirmObserved.ok) {
					readOk = false;
				} else {
					const confirmStatus = exactDtor(confirmObserved.value, STATUS_KEYS);
					if (!confirmStatus || confirmStatus.status?.value !== "eof") readOk = false;
				}
			}
		}
	}

	// Final fstat
	if (readOk) {
		let finalStat: EventOutboxEntryStat | null = null;
		try {
			const finalRaw = hnd.fstat();
			if (!isPromise(finalRaw)) {
				// Sync fstat is always invalid
				readOk = false;
			} else {
				const finalObserved = await observeExact(finalRaw);
				if (finalObserved.ok) {
					finalStat = snapshotStat(finalObserved.value);
				}
			}
		} catch {
			readOk = false;
		}
		if (!finalStat || !statEqual(finalStat, entry.stat)) readOk = false;
	}

	if (!readOk) {
		assembledBytes.fill(0);
		if (readUncertain) return { ok: false, code: "CLOSE_UNCERTAIN" };
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// Close handle immediately after reading (before next file)
	if (acquired.handleRaw !== undefined && typeof acquired.handleRaw === "object" && acquired.handleRaw !== null)
		await cleanup.closeRegistered(acquired.handleRaw);

	// Save a fresh copy for decode
	const ownBytes = new Uint8Array(assembledBytes.byteLength);
	ownBytes.set(assembledBytes);
	assembledBytes.fill(0);

	// Compute sha256 of the actual immutable bytes
	let canonicalSha256 = "";
	try {
		const hash = createHash("sha256");
		hash.update(ownBytes);
		canonicalSha256 = hash.digest("hex");
	} catch {
		ownBytes.fill(0);
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// --- decode ---
	const decoded = decodeSandboxEventOutboxRecordV1(ownBytes);
	ownBytes.fill(0);
	if (!decoded.ok) {
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
// eventContentEq – compare two event outbox records for content identity.
// A delivered record must have the same event frame/digest as its preceding
// pending record.
// ---------------------------------------------------------------------------

function eventContentEq(left: SandboxEventOutboxRecordV1, right: SandboxEventOutboxRecordV1): boolean {
	if (left.eventId !== right.eventId) return false;
	if (left.eventSequence !== right.eventSequence) return false;
	if (left.eventDigest !== right.eventDigest) return false;
	if (left.eventType !== right.eventType) return false;
	return true;
}

// ===========================================================================
// runRecovery – inner scan logic, never closes the backend itself.
//               Returns success/error code; caller handles backend close.
//               Uses shared CleanupRegistry for all page/handle cleanup.
//               Backend is registered by the caller, NOT inside runRecovery.
// ===========================================================================

type RunRecoveryResult =
	| Readonly<{ ok: true; output: EventOutboxRecoveryOutput }>
	| Readonly<{ ok: false; code: EventOutboxRecoveryErrorCode }>;

async function runRecovery(raw: unknown, cleanup: CleanupRegistry): Promise<RunRecoveryResult> {
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
	let allEntries: EventOutboxEntry[] = [];
	let pageCount = 0;
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

		// Handle sync (non-promise) listPage return — snapshot and reject
		if (!isPromise(rawPagePromise)) {
			// Descriptor-snapshot to discover and record any page close
			cleanup.record(rawPagePromise, "sync-listPage");
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const pageObserved = await observeExact(rawPagePromise);
		if (!pageObserved.ok) {
			// Sync/non-promise or rejected page — snapshot to discover any page close
			cleanup.record(rawPagePromise, "sync-page");
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		// --- parse and close page ---
		const parsed = await parseAndClosePage(pageObserved.value, cleanup);
		if (cleanup.hasCloseUncertainty) {
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}
		if (!parsed.ok) {
			// Domain errors (bad status/entries/shape) => RECOVERY_FAILED
			// Close failures are tracked separately via closeOk
			if (parsed.domainError) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			return { ok: false, code: "RECOVERY_FAILED" };
		}
		if (!parsed.closeOk) {
			return { ok: false, code: "CLOSE_UNCERTAIN" };
		}

		const page = parsed.page;

		// --- empty page ---
		if (page.entries.length === 0) {
			if (cursor !== null || page.nextCursor !== null) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			break;
		}

		// --- cursor tracking ---
		pageCount += 1;
		if (pageCount > MAX_PAGES) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		if (page.nextCursor !== null) {
			if (seenCursors.has(page.nextCursor)) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			seenCursors.add(page.nextCursor);
		}

		// --- validate entries ---
		let prospectiveLast: string | null = lastName;
		let prospectiveSeq = nextSequence;
		let pageBytes = 0;
		const pageEntries: EventOutboxEntry[] = [];

		for (const entry of page.entries) {
			const parsedName = parseName(entry.name);
			if (!parsedName) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (prospectiveLast !== null && prospectiveLast >= entry.name) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (!entry.stat.isFile || entry.stat.isSymlink || entry.stat.mode !== 0o600 || entry.stat.nlink !== 1) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (entry.stat.size < 1 || entry.stat.size > FILE_MAX_BYTES) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			pageBytes += entry.stat.size;
			if (!Number.isSafeInteger(pageBytes) || pageBytes > PAGE_MAX_BYTES) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (parsedName.sequence !== prospectiveSeq) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			prospectiveSeq += 1;
			prospectiveLast = entry.name;
			pageEntries.push(entry);
		}

		// --- total bytes bound ---
		if (totalBytes + pageBytes > TOTAL_MAX_BYTES) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		allEntries = allEntries.concat(pageEntries);
		lastName = prospectiveLast;
		nextSequence = prospectiveSeq;
		totalBytes += pageBytes;
		cursor = page.nextCursor;

		if (cursor === null) break;
	}

	// --- non-null cursor at page bound (domain error => RECOVERY_FAILED) ---
	if (cursor !== null) {
		// Non-null cursor after page iteration without null termination
		return { ok: false, code: "RECOVERY_FAILED" };
	}

	// -----------------------------------------------------------------------
	// Pass 2: open files serially, read, close handle, decode
	// -----------------------------------------------------------------------
	const records: SandboxEventOutboxRecordV1[] = [];
	const receipts: EventOutboxFileReceipt[] = [];

	for (const entry of allEntries) {
		const parsedName = parseName(entry.name);
		if (!parsedName) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		const fileResult = await readSingleFile(entry, parsedName, identity, backend, cleanup);

		if (!fileResult.ok) {
			return { ok: false, code: fileResult.code };
		}

		receipts.push(
			Object.freeze({
				sequence: fileResult.fileMeta.journalSeq,
				size: fileResult.fileMeta.fileSize,
				sha256: fileResult.fileMeta.sha256,
			}),
		);
		records.push(fileResult.record);
	}

	// -----------------------------------------------------------------------
	// Validate record ordering — strict monotonic recordSeq and identity
	// Domain errors => RECOVERY_FAILED (not CLOSE_UNCERTAIN)
	// -----------------------------------------------------------------------
	for (let i = 1; i < records.length; i += 1) {
		const prev = records[i - 1];
		const curr = records[i];
		if (curr.recordSeq !== prev.recordSeq + 1) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}
		if (
			curr.hostId !== identity.hostId ||
			curr.generation !== identity.generation ||
			curr.sessionId !== identity.sessionId
		) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}
	}

	// -----------------------------------------------------------------------
	// Event state validation:
	//   - _nextEventSequence is a global counter independent of pending map
	//   - Each NEW pending gets eventSequence = ++_nextEventSequence
	//   - Delivered matches its pending's eventSequence (by eventId)
	//   - Unique event IDs for pending records; delivered reuses its pending eventId
	//   - Unique eventSequences across all records (one eventId per sequence)
	//   - eventContentEq is verified for delivered vs its pending
	//   - No delivery without pending or after delivery
	//   - Valid nonadjacent matching (eventId lookup, not positional)
	//   Domain/chronology errors => RECOVERY_FAILED (not CLOSE_UNCERTAIN)
	// -----------------------------------------------------------------------
	let _nextEventSequence = 0;
	const pendingByEventId = new Map<string, SandboxEventOutboxRecordV1>();
	const eventSequenceForEventId = new Map<string, string>();
	const pendingEventIds = new Set<string>();
	const deliveredEventIds = new Set<string>();

	for (const record of records) {
		if (!Number.isSafeInteger(record.eventSequence) || record.eventSequence < 1) {
			return { ok: false, code: "RECOVERY_FAILED" };
		}

		if (record.recordKind === "pending") {
			// Pending eventId must be unique
			if (pendingEventIds.has(record.eventId)) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			pendingEventIds.add(record.eventId);

			// Each new pending gets exactly _nextEventSequence + 1
			const expectedSeq = _nextEventSequence + 1;
			if (record.eventSequence !== expectedSeq) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			_nextEventSequence = expectedSeq;

			// No duplicate eventSequence
			const existingForSeq = eventSequenceForEventId.get(String(record.eventSequence));
			if (existingForSeq !== undefined) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			eventSequenceForEventId.set(String(record.eventSequence), record.eventId);

			pendingByEventId.set(record.eventId, record);
		} else if (record.recordKind === "delivered") {
			// Delivered eventId must be unique among delivered
			if (deliveredEventIds.has(record.eventId)) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			deliveredEventIds.add(record.eventId);

			// Delivered must match a pending by eventId
			const pending = pendingByEventId.get(record.eventId);
			if (!pending) {
				// No matching pending for this eventId
				return { ok: false, code: "RECOVERY_FAILED" };
			}

			// eventSequence must match the pending's eventSequence
			if (record.eventSequence !== pending.eventSequence) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}

			// eventSequence must be unique (no two event IDs share one)
			const existingForSeq = eventSequenceForEventId.get(String(record.eventSequence));
			if (existingForSeq !== undefined && existingForSeq !== record.eventId) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}
			if (existingForSeq === undefined) {
				eventSequenceForEventId.set(String(record.eventSequence), record.eventId);
			}

			// Full event content equality (type, digest, etc.)
			if (!eventContentEq(pending, record)) {
				return { ok: false, code: "RECOVERY_FAILED" };
			}

			// Remove from pending (delivered)
			pendingByEventId.delete(record.eventId);
		} else {
			return { ok: false, code: "RECOVERY_FAILED" };
		}
	}

	const frozenRecords: readonly SandboxEventOutboxRecordV1[] = Object.freeze(records.map((r) => r));
	const frozenReceipts: readonly EventOutboxFileReceipt[] = Object.freeze(receipts);

	const output: EventOutboxRecoveryOutput = Object.freeze({
		identity: Object.freeze({
			hostId: identity.hostId,
			generation: identity.generation,
			sessionId: identity.sessionId,
		}),
		records: frozenRecords,
		totalBytes,
		nextJournalSeq: nextSequence,
		receipts: frozenReceipts,
	});

	return { ok: true, output };
}

// ===========================================================================
// recoverSandboxEventOutboxJournal — main export
//
// One CleanupRegistry.  Backend registered exactly once (first).
// closeAll() called exactly once from outer finally, in strict reverse
// order so pages/handles close before backend.
// ===========================================================================

export async function recoverSandboxEventOutboxJournal(raw: unknown): Promise<EventOutboxRecoveryResult> {
	// Null/primitive => INVALID_ARGUMENT before any ownership acquisition
	if (raw === null || raw === undefined || typeof raw !== "object") return fail("INVALID_ARGUMENT");
	// Proxy outer input => CLOSE_UNCERTAIN (cannot trust any descriptor inspection)
	try {
		if (types.isProxy(raw)) return fail("CLOSE_UNCERTAIN");
	} catch {
		return fail("CLOSE_UNCERTAIN");
	}

	const cleanup = new CleanupRegistry();

	// --- Acquire backend value from raw input, tracking certainty ---
	// States:
	//   "none":       backend property absent (provable — no desc, non-object value)
	//   "owner":      backend present with a value-descriptor, directly inspectable
	//   "uncertain":  backend is accessor/Proxy/non-enumerable data — cannot trust ownership
	let backendState: "none" | "owner" | "uncertain" = "none";
	let backendValue: unknown;

	try {
		const backendDesc = Object.getOwnPropertyDescriptor(raw, "backend");
		if (backendDesc) {
			if (!("value" in backendDesc)) {
				// Accessor descriptor => uncertain
				backendState = "uncertain";
			} else if (!backendDesc.enumerable) {
				// Non-enumerable data backend (hidden owner)
				// Register to close its proven close if available, but result is uncertain
				backendValue = backendDesc.value;
				if (typeof backendValue === "object" && backendValue !== null) {
					cleanup.record(backendValue, "backend-hidden");
				}
				backendState = "uncertain";
			} else {
				backendValue = backendDesc.value;
				if (typeof backendValue !== "object" || backendValue === null) {
					// Non-object value is provable absence of a close owner
					backendState = "none";
				} else {
					backendState = "owner";
				}
			}
		}
		// No descriptor => backend property absent => provable "none"
	} catch {
		// Reflection failure => cannot trust any descriptor inspection
		backendState = "uncertain";
	}

	if (backendState === "uncertain") {
		// Even with uncertainty, closeAll drains any registered hidden backend
		await cleanup.closeAll();
		return fail("CLOSE_UNCERTAIN");
	}

	// Register backend as the FIRST entry (closes LAST in reverse order).
	// Only register when backend is a proper object (owner).
	if (backendState === "owner") {
		const { state: regState } = cleanup.record(backendValue, "backend");
		if (regState === "uncertain") {
			await cleanup.closeAll();
			return fail("CLOSE_UNCERTAIN");
		}
	}

	// Run inner scan (never closes backend directly)
	let scan: RunRecoveryResult;
	try {
		scan = await runRecovery(raw, cleanup);
	} catch {
		scan = { ok: false, code: "RECOVERY_FAILED" };
	}

	// Single closeAll from outer scope — pages/handles close first
	// (registered after backend), then backend last (registered first).
	const closeOk = await cleanup.closeAll();

	// Uncertainty dominance: if any entry is uncertain/alias, the result
	// is CLOSE_UNCERTAIN regardless of closeAll return value.
	const anyUncertainty = cleanup.hasUncertainty || cleanup.anyCloseFailed;

	if (scan.ok) {
		if (closeOk && !anyUncertainty) {
			return Object.freeze({ ok: true, value: scan.output });
		}
		// Close failure or uncertainty dominates
		return fail("CLOSE_UNCERTAIN");
	}

	if (!closeOk || anyUncertainty) return fail("CLOSE_UNCERTAIN");
	return fail(scan.code);
}

// ---------------------------------------------------------------------------
// bindHandle – extracts readAt, confirmEof, fstat (NOT close – that is
//              acquired separately via CleanupRegistry)
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

function statEqual(left: EventOutboxEntryStat, right: EventOutboxEntryStat): boolean {
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
