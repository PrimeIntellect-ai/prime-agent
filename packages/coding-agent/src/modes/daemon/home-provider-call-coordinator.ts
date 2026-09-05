/**
 * HomeProviderCallCoordinator -- zero-cast, zero-any production coordinator.
 *
 * Home owns the proxy and ONE durable provider store.
 * Relay is a borrowed non-owning exact view -- never closed.
 *
 * All store operations are serialized through a single durability FIFO
 * (_tail).  External calls (handleRequest, handleCancel, close) use
 * _externalEnqueue which checks closed/reentry before chaining on _tail.
 * Background stream tasks use _storeEnqueue which chains raw on _tail.
 *
 * Factory acquires store close ownership FIRST, then validates remaining
 * inputs.  On any failure the store is closed once; on success the owner
 * is transferred to the coordinator.
 *
 * Every record gets actual sequential nextSequence from store.status() at
 * admission time, eliminating request-relative arithmetic races.
 *
 * Zero casts, zero as const, zero as T, zero as object, zero any,
 * zero non-null assertions, zero dynamic imports.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { isHomeProviderProxyInstance } from "../../core/home-provider-proxy.js";
import { isProviderCallStoreCapability } from "./durable-provider-call-store.js";
import type {
	CoordinatorErrorCode,
	CoordinatorResult,
	HandleCancelResult,
	HandleRequestResult,
	HomeProviderCallCoordinatorCapability,
	ReconcileResult,
} from "./home-provider-call-coordinator-types.js";
import { RECORDED_AT_RE, SAFE_ID_RE } from "./home-provider-call-coordinator-types.js";
import { createRelayEvidencePort, isOrderedDurableRelay, isRelayEvidencePort } from "./ordered-durable-relay.js";
import type { DurableReceipt } from "./provider-call-record-codec.js";
import type { ProviderCallJournaledReceipt, ProviderCallJournaledRecordV1 } from "./provider-call-store-types.js";
import { REMOTE_HOST_PROTOCOL_NAME, REMOTE_HOST_PROTOCOL_VERSION } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	canonicalJsonBytes,
	decodeEnvelope,
	isCanonicalUtcTimestamp,
	isValidDigest,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Module-captured intrinsics (exact non-Proxy descriptors, captured once)
// ===========================================================================

/** Captured Promise.prototype.then descriptor value (never live access). */
const PROMISE_THEN: (this: Promise<unknown>, ...args: readonly unknown[]) => unknown = (() => {
	const desc = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
	if (!desc || !("value" in desc) || typeof desc.value !== "function") {
		throw new Error("Cannot capture Promise.prototype.then");
	}
	return desc.value;
})();

/** Captured %TypedArray%.prototype.fill descriptor value (never live access). */
const UINT8_FILL: (this: Uint8Array, ...args: readonly unknown[]) => Uint8Array = (() => {
	// Uint8Array inherits fill from %TypedArray%.prototype -- walk the chain
	let proto: object | null = Uint8Array.prototype;
	while (proto !== null) {
		const desc = Object.getOwnPropertyDescriptor(proto, "fill");
		if (desc !== undefined) {
			if (!("value" in desc) || typeof desc.value !== "function") {
				throw new Error("Cannot capture Uint8Array.prototype.fill");
			}
			return desc.value;
		}
		proto = Object.getPrototypeOf(proto);
	}
	throw new Error("Cannot capture Uint8Array.prototype.fill");
})();

/** Captured %TypedArray%.prototype.length getter (never live access to bytes.length). */
const UINT8_LENGTH_GET: (this: Uint8Array) => number = (() => {
	let proto: object | null = Uint8Array.prototype;
	while (proto !== null) {
		const desc = Object.getOwnPropertyDescriptor(proto, "length");
		if (desc !== undefined) {
			if (!("get" in desc) || typeof desc.get !== "function") {
				throw new Error("Cannot capture Uint8Array.prototype.length getter");
			}
			return desc.get;
		}
		proto = Object.getPrototypeOf(proto);
	}
	throw new Error("Cannot capture Uint8Array.prototype.length getter");
})();

/** Captured %TypedArray%.prototype.byteOffset getter (never live access for ownership validation). */
const UINT8_BYTE_OFFSET_GET: (this: Uint8Array) => number = (() => {
	let proto: object | null = Uint8Array.prototype;
	while (proto !== null) {
		const desc = Object.getOwnPropertyDescriptor(proto, "byteOffset");
		if (desc !== undefined) {
			if (!("get" in desc) || typeof desc.get !== "function") {
				throw new Error("Cannot capture Uint8Array.prototype.byteOffset getter");
			}
			return desc.get;
		}
		proto = Object.getPrototypeOf(proto);
	}
	throw new Error("Cannot capture Uint8Array.prototype.byteOffset getter");
})();

/** Captured %TypedArray%.prototype.buffer getter (never live access for backing validation). */
const UINT8_BUFFER_GET: (this: Uint8Array) => ArrayBuffer | undefined = (() => {
	let proto: object | null = Uint8Array.prototype;
	while (proto !== null) {
		const desc = Object.getOwnPropertyDescriptor(proto, "buffer");
		if (desc !== undefined) {
			if (!("get" in desc) || typeof desc.get !== "function") {
				throw new Error("Cannot capture Uint8Array.prototype.buffer getter");
			}
			return desc.get;
		}
		proto = Object.getPrototypeOf(proto);
	}
	throw new Error("Cannot capture Uint8Array.prototype.buffer getter");
})();

/** Captured Uint8Array.prototype reference for brand validation. */
const UINT8_PROTOTYPE: object = (() => {
	const desc = Object.getOwnPropertyDescriptor(Uint8Array, "prototype");
	if (!desc || !("value" in desc) || typeof desc.value !== "object" || desc.value === null) {
		throw new Error("Cannot capture Uint8Array.prototype");
	}
	return desc.value;
})();

/** Captured ArrayBuffer.prototype reference for backing brand validation. */
const ARRAY_BUFFER_PROTOTYPE: object = (() => {
	const desc = Object.getOwnPropertyDescriptor(ArrayBuffer, "prototype");
	if (!desc || !("value" in desc) || typeof desc.value !== "object" || desc.value === null) {
		throw new Error("Cannot capture ArrayBuffer.prototype");
	}
	return desc.value;
})();

/** Captured ArrayBuffer.prototype.byteLength getter (never live access for backing validation). */
const ARRAY_BUFFER_BYTE_LENGTH_GET: (this: ArrayBuffer) => number = (() => {
	const desc = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");
	if (!desc || !("get" in desc) || typeof desc.get !== "function") {
		throw new Error("Cannot capture ArrayBuffer.prototype.byteLength");
	}
	return desc.get;
})();

/** Captured Reflect.get via descriptor (never live property access during erasure). */
const REFLECT_GET: (target: object, key: string | symbol | number) => unknown = (() => {
	const desc = Object.getOwnPropertyDescriptor(Reflect, "get");
	if (!desc || !("value" in desc) || typeof desc.value !== "function") {
		throw new Error("Cannot capture Reflect.get");
	}
	const reflectGet = desc.value;
	return (target: object, key: string | symbol | number): unknown => {
		return Reflect.apply(reflectGet, void 0, [target, key]);
	};
})();

/** Captured Promise.prototype reference (never live access for validation). */
const PROMISE_PROTOTYPE: object = (() => {
	const desc = Object.getOwnPropertyDescriptor(Promise, "prototype");
	if (!desc || !("value" in desc) || typeof desc.value !== "object" || desc.value === null) {
		throw new Error("Cannot capture Promise.prototype");
	}
	return desc.value;
})();

function ownResolve<T>(value: T): Promise<T> {
	return new Promise((resolve) => {
		resolve(value);
	});
}

function ownThen<T, TResult>(
	promise: Promise<T>,
	onfulfilled: (value: T) => TResult | PromiseLike<TResult>,
	onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
): Promise<TResult> {
	return new Promise<TResult>((resolve, reject) => {
		try {
			Reflect.apply(PROMISE_THEN, promise, [
				(value: T) => {
					try {
						resolve(onfulfilled(value));
					} catch (e) {
						reject(e);
					}
				},
				(reason: unknown) => {
					if (typeof onrejected === "function") {
						try {
							resolve(onrejected(reason));
						} catch (e) {
							reject(e);
						}
					} else {
						reject(reason);
					}
				},
			]);
		} catch {
			reject(new Error("ownThen: apply failed"));
		}
	});
}

// ===========================================================================
// Constants
// ===========================================================================

const MAX_JOURNAL_SEQ = 20_000;
const OUTPUT_PAGE_SIZE = 64;
const UNDELIVERED_PAGE_SIZE = 64;
const MAX_CHUNKS = 10_000;

// ===========================================================================
// Helpers
// ===========================================================================

function safeId(raw: unknown): raw is string {
	return typeof raw === "string" && SAFE_ID_RE.test(raw);
}

function safeTimestamp(raw: unknown): raw is string {
	if (typeof raw !== "string" || !RECORDED_AT_RE.test(raw)) return false;
	return isCanonicalUtcTimestamp(raw);
}

/** Distinguish absent optional descriptor from present-hostile descriptor on iterator.
 *  Returns:
 *   "absent"   — key not present on target or its prototype chain (optional).
 *   "hostile"  — key present but is accessor, Proxy-wrapped, or non-function value.
 *   function  — the captured owning function.
 */
function captureReturnDescriptor(
	target: object,
	key: string | symbol,
	startProto: object | null = null,
): "absent" | "hostile" | ((...args: readonly unknown[]) => unknown) {
	try {
		if (types.isProxy(target)) return "hostile";
		const ownDesc = Object.getOwnPropertyDescriptor(target, key);
		if (ownDesc !== undefined) {
			if (!("value" in ownDesc)) return "hostile";
			if (typeof ownDesc.value !== "function") return "hostile";
			if (types.isProxy(ownDesc.value)) return "hostile";
			return ownDesc.value;
		}
		let walk: object | null = startProto ?? Object.getPrototypeOf(target);
		while (walk !== null && walk !== Object.prototype) {
			if (types.isProxy(walk)) return "hostile";
			const desc = Object.getOwnPropertyDescriptor(walk, key);
			if (desc !== undefined) {
				if (!("value" in desc)) return "hostile";
				if (typeof desc.value !== "function") return "hostile";
				if (types.isProxy(desc.value)) return "hostile";
				return desc.value;
			}
			walk = Object.getPrototypeOf(walk);
		}
		return "absent";
	} catch {
		// Reflection, Proxy, or prototype-chain exceptions are hostile/uncertain,
		// not merely absent — the environment is tampered or unreliable.
		return "hostile";
	}
}

/** Validate that bytes is a genuine full-backing owned Uint8Array (not Buffer/subclass/slice/detached, no extra/hidden/accessor properties, no own symbols). */
function isGenuineOwnedUint8Array(raw: unknown): raw is Uint8Array {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		// types brand (reject non-Uint8Array, detached, or corrupted)
		if (!types.isUint8Array(raw)) return false;
		// Proxy rejection (own object)
		if (types.isProxy(raw)) return false;
		// Exact Uint8Array.prototype (reject Buffer/subclass)
		if (Object.getPrototypeOf(raw) !== UINT8_PROTOTYPE) return false;
		// Constructor must be own data property with exact Uint8Array (reject accessor/reassign)
		const ctorDesc = Object.getOwnPropertyDescriptor(raw, "constructor");
		if (ctorDesc !== undefined) {
			if (!("value" in ctorDesc)) return false;
			if (ctorDesc.value !== Uint8Array) return false;
		}
		// Own keys validation: zero-length must have none; nonzero only canonical numeric indices as data
		const ownKeys = Reflect.ownKeys(raw);
		const viewLen = Reflect.apply(UINT8_LENGTH_GET, raw, []);
		if (typeof viewLen !== "number" || !Number.isSafeInteger(viewLen) || viewLen < 0) return false;
		let numericCount = 0;
		for (let i = 0; i < ownKeys.length; i++) {
			const k = ownKeys[i];
			if (typeof k === "symbol") return false;
			const n = Number(k);
			if (!Number.isSafeInteger(n) || n < 0 || n >= viewLen || String(n) !== k) return false;
			const desc = Object.getOwnPropertyDescriptor(raw, k);
			if (!desc || !("value" in desc)) return false;
			numericCount++;
		}
		if (numericCount !== viewLen) return false;
		// Owned: zero byteOffset (reject slice/subarray views)
		const byteOffset = Reflect.apply(UINT8_BYTE_OFFSET_GET, raw, []);
		if (typeof byteOffset !== "number" || byteOffset !== 0) return false;
		// Backing buffer validation: captured AB prototype, no own names/symbols
		const buffer = Reflect.apply(UINT8_BUFFER_GET, raw, []);
		if (typeof buffer !== "object" || buffer === null) return false;
		if (Object.getPrototypeOf(buffer) !== ARRAY_BUFFER_PROTOTYPE) return false;
		if (Object.getOwnPropertyNames(buffer).length !== 0) return false;
		if (Object.getOwnPropertySymbols(buffer).length !== 0) return false;
		const bufLen = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GET, buffer, []);
		if (typeof bufLen !== "number" || bufLen !== viewLen) return false;
		return true;
	} catch {
		return false;
	}
}

function eraseKnownOwned(bytes: Uint8Array): boolean {
	try {
		// Pre-erasure validation — must be genuine full-backing owned Uint8Array
		if (!isGenuineOwnedUint8Array(bytes)) return false;
		Reflect.apply(UINT8_FILL, bytes, [0]);
		// Verify erasure took effect using captured length getter (no live bytes.length)
		const len = Reflect.apply(UINT8_LENGTH_GET, bytes, []);
		for (let i = 0; i < len; i++) {
			// Use captured REFLECT_GET for indexed access (never live property)
			const val = REFLECT_GET(bytes, i);
			if (val !== 0) {
				// Erasure uncertain — re-fill and return failure
				Reflect.apply(UINT8_FILL, bytes, [0]);
				return false;
			}
		}
		// Post-erasure validation — still genuine full-backing owned
		if (!isGenuineOwnedUint8Array(bytes)) return false;
		return true;
	} catch {
		// erasure failed — return false to dominate with uncertainty
		return false;
	}
}

function coordinatorError(code: CoordinatorErrorCode): CoordinatorResult<never> {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function okValue<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function okVoid(): Readonly<{ ok: true; value: undefined }> {
	return Object.freeze({ ok: true, value: undefined });
}

function storeErrorToCoordinator(code: string): CoordinatorErrorCode {
	switch (code) {
		case "CALL_ID_COLLISION":
			return "CALL_ID_COLLISION";
		case "NOT_FOUND":
			return "CALL_NOT_FOUND";
		case "CLOSED":
			return "CLOSED";
		case "CLOSE_UNCERTAIN":
			return "CLOSE_UNCERTAIN";
		case "INVALID_ARGUMENT":
			return "INVALID_ARGUMENT";
		case "POISONED":
			return "POISONED";
		case "RECOVERY_FAILED":
			return "RECOVERY_FAILED";
		default:
			return "STORE_FAILED";
	}
}

// ===========================================================================
// Digest helpers
// ===========================================================================

function _sha256Of(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function jsonBytesOf(value: unknown): { bytes: Uint8Array; digest: string } | null {
	try {
		const result = canonicalJsonBytes(value);
		if (!result) return null;
		return result;
	} catch {
		return null;
	}
}

// ===========================================================================
// Native Promise verification
// ===========================================================================

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		// Reject Proxy wrappers
		if (types.isProxy(raw)) return false;
		// types.isPromise confirms native Promise brand
		if (!types.isPromise(raw)) return false;
		// Exact Promise.prototype identity (not subclass) — captured at module load
		if (Object.getPrototypeOf(raw) !== PROMISE_PROTOTYPE) return false;
		// No own properties — real promises have none
		if (Object.getOwnPropertyNames(raw).length !== 0) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

// ===========================================================================
// AsyncIterator type guard
// ===========================================================================

function isAsyncIterator(raw: unknown): raw is AsyncIterator<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		// Reject Proxy at every level
		if (types.isProxy(raw)) return false;
		const proto = Object.getPrototypeOf(raw);
		if (proto === null || proto === Object.prototype) return false;
		if (types.isProxy(proto)) return false;
		// Must have next() on the prototype chain
		let walk: object | null = proto;
		while (walk !== null && walk !== Object.prototype) {
			const nextDesc = Object.getOwnPropertyDescriptor(walk, "next");
			if (nextDesc !== undefined) {
				if (!("value" in nextDesc) || typeof nextDesc.value !== "function") return false;
				if (types.isProxy(nextDesc.value)) return false;
				return true;
			}
			walk = Object.getPrototypeOf(walk);
			if (walk !== null && walk !== Object.prototype && types.isProxy(walk)) return false;
		}
		return false;
	} catch {
		return false;
	}
}

// ===========================================================================
// Observe native promise via native then
// ===========================================================================

type ObserveResult = Readonly<{ status: "fulfilled"; value: unknown }> | Readonly<{ status: "rejected" }>;

function observe(promise: Promise<unknown>): Promise<ObserveResult> {
	return new Promise((resolve) => {
		try {
			Reflect.apply(PROMISE_THEN, promise, [
				(v: unknown) => {
					resolve(Object.freeze({ status: "fulfilled", value: v }));
				},
				() => {
					resolve(Object.freeze({ status: "rejected" }));
				},
			]);
		} catch {
			resolve(Object.freeze({ status: "rejected" }));
		}
	});
}

// ===========================================================================
// DurableReceipt validation
// ===========================================================================

function validateDurableReceipt(raw: unknown): DurableReceipt | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const d = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(d);
		if (names.length !== 3) return null;
		if (!names.includes("sequence") || !names.includes("size") || !names.includes("sha256")) return null;
		for (const name of names) {
			const desc = d[name];
			if (!desc || !desc.enumerable || !("value" in desc)) return null;
		}
		const seq = d.sequence.value;
		const sz = d.size.value;
		const hash = d.sha256.value;
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
		if (typeof sz !== "number" || !Number.isSafeInteger(sz) || sz < 1) return null;
		if (typeof hash !== "string" || !isValidDigest(hash)) return null;
		return Object.freeze({ sequence: seq, size: sz, sha256: hash });
	} catch {
		return null;
	}
}

function validateStoreJournaledReceipt(raw: unknown): ProviderCallJournaledReceipt | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const d = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(d);
		if (names.length !== 4) return null;
		if (
			!names.includes("receipt") ||
			!names.includes("callId") ||
			!names.includes("requestDigest") ||
			!names.includes("canonicalRequestDigest")
		)
			return null;
		for (const name of names) {
			if (!d[name] || !d[name].enumerable || !("value" in d[name])) return null;
		}
		const receipt = validateDurableReceipt(d.receipt.value);
		if (!receipt) return null;
		const callId = d.callId.value;
		if (typeof callId !== "string") return null;
		const rd = d.requestDigest.value;
		const crd = d.canonicalRequestDigest.value;
		if (typeof rd !== "string" || typeof crd !== "string") return null;
		return Object.freeze({ receipt, callId, requestDigest: rd, canonicalRequestDigest: crd });
	} catch {
		return null;
	}
}

function validateStoreDurableReceipt(raw: unknown): DurableReceipt | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return validateDurableReceipt(raw);
	} catch {
		return null;
	}
}

function extractOkValue(raw: unknown): unknown | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		const d = Object.getOwnPropertyDescriptors(raw);
		const okDesc = d.ok;
		if (!okDesc || !("value" in okDesc) || okDesc.value !== true) return null;
		const valDesc = d.value;
		if (!valDesc || !("value" in valDesc)) return null;
		return valDesc.value;
	} catch {
		return null;
	}
}

function extractErrorCode(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		const d = Object.getOwnPropertyDescriptors(raw);
		const okDesc = d.ok;
		if (!okDesc || !("value" in okDesc) || okDesc.value !== false) return null;
		const errDesc = d.error;
		if (!errDesc || !("value" in errDesc)) return null;
		const errVal = errDesc.value;
		if (typeof errVal !== "object" || errVal === null) return null;
		const errD = Object.getOwnPropertyDescriptors(errVal);
		const codeDesc = errD.code;
		if (!codeDesc || !("value" in codeDesc)) return null;
		return typeof codeDesc.value === "string" ? codeDesc.value : null;
	} catch {
		return null;
	}
}

function boundCall(fn: (...args: readonly unknown[]) => unknown, thisArg: unknown, args: readonly unknown[]): unknown {
	try {
		return Reflect.apply(fn, thisArg, args);
	} catch {
		return void 0;
	}
}

// ===========================================================================
// Safe store/relay call helpers
// ===========================================================================

type SafeStoreResult =
	| Readonly<{ ok: true; value: unknown }>
	| Readonly<{ ok: false; error: Readonly<{ code: string }> }>;

async function safeStoreCall(
	fn: (...args: readonly unknown[]) => unknown,
	args: readonly unknown[],
): Promise<SafeStoreResult> {
	const raw = boundCall(fn, void 0, args);
	if (raw === void 0 || !isNativePromise(raw)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "STORE_FAILED" }) });
	}
	const observed = await observe(raw);
	if (observed.status !== "fulfilled") {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "STORE_FAILED" }) });
	}
	const okVal = extractOkValue(observed.value);
	if (okVal !== null) return Object.freeze({ ok: true, value: okVal });
	const errCode = extractErrorCode(observed.value);
	if (errCode !== null) return Object.freeze({ ok: false, error: Object.freeze({ code: errCode }) });
	return Object.freeze({ ok: false, error: Object.freeze({ code: "STORE_FAILED" }) });
}

interface SafeRelaySendResult {
	readonly frameId: string;
	readonly journalReceipt: DurableReceipt;
}

async function safeRelaySend(
	fn: (...args: readonly unknown[]) => unknown,
	args: readonly unknown[],
): Promise<SafeRelaySendResult | null> {
	const raw = boundCall(fn, void 0, args);
	if (raw === void 0 || !isNativePromise(raw)) return null;
	const observed = await observe(raw);
	if (observed.status !== "fulfilled") return null;
	const okVal = extractOkValue(observed.value);
	if (!okVal) return null;
	const d = Object.getOwnPropertyDescriptors(okVal);
	const frameIdDesc = d.frameId;
	const journalDesc = d.journalReceipt;
	const replayDesc = d.replay;
	if (!frameIdDesc || !("value" in frameIdDesc)) return null;
	if (!journalDesc || !("value" in journalDesc)) return null;
	if (!replayDesc || !("value" in replayDesc)) return null;
	const frameId = frameIdDesc.value;
	const journalReceipt = validateDurableReceipt(journalDesc.value);
	if (typeof frameId !== "string" || frameId.length === 0) return null;
	if (!journalReceipt) return null;
	return Object.freeze({ frameId, journalReceipt });
}

// ===========================================================================
// Own-first data function extractor (rejects accessors, non-functions, Proxies)
// ===========================================================================

/**
 * Walk own-then-prototype chain for a named data property whose value is a
 * callable non-hostile function.  Rejects own accessors instead of falling
 * through.  nearest prototype only — stops at the first (nearest) descriptor
 * encountered, regardless of whether it satisfies, so a hostile intermediate
 * prototype's broken descriptor is the terminal answer.
 */
function ownFirstDataFunction(
	target: object,
	key: string | symbol,
	startProto: object | null = null,
): ((...args: readonly unknown[]) => unknown) | undefined {
	try {
		// 0. Reject Proxy target before any descriptor trap
		if (types.isProxy(target)) return undefined;
		// 1. Own descriptor
		const ownDesc = Object.getOwnPropertyDescriptor(target, key);
		if (ownDesc !== undefined) {
			// Accessor (getter/setter) — reject (cannot trust the getter)
			if (!("value" in ownDesc)) return undefined;
			// Data property with non-function value — reject
			if (typeof ownDesc.value !== "function") return undefined;
			// Proxy-wrapped function — reject
			if (types.isProxy(ownDesc.value)) return undefined;
			return ownDesc.value;
		}
		// 2. Nearest prototype chain (one walk, stops at first match regardless)
		let walk: object | null = startProto ?? Object.getPrototypeOf(target);
		while (walk !== null && walk !== Object.prototype) {
			if (types.isProxy(walk)) return undefined;
			const desc = Object.getOwnPropertyDescriptor(walk, key);
			if (desc !== undefined) {
				if (!("value" in desc)) return undefined; // accessor -> reject
				if (typeof desc.value !== "function") return undefined;
				if (types.isProxy(desc.value)) return undefined;
				return desc.value;
			}
			walk = Object.getPrototypeOf(walk);
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function descStringValue(descs: Record<string, PropertyDescriptor>, name: string): string | undefined {
	const desc = descs[name];
	if (!desc || !("value" in desc)) return undefined;
	return typeof desc.value === "string" ? desc.value : undefined;
}

function descNumberValue(descs: Record<string, PropertyDescriptor>, name: string): number | undefined {
	const desc = descs[name];
	if (!desc || !("value" in desc)) return undefined;
	return typeof desc.value === "number" ? desc.value : undefined;
}

// ===========================================================================
// Proxy request record builder
// ===========================================================================

function buildProxyRequestRecord(
	callId: string,
	provider: string,
	modelId: string,
	systemPrompt: string | undefined,
	messages: unknown,
	tools: unknown | undefined,
	maxTokens: number | undefined,
	temperature: number | undefined,
	thinkingLevel: string | undefined,
): unknown {
	try {
		const context: Record<string, unknown> = {
			systemPrompt: systemPrompt !== undefined ? systemPrompt : "",
			messages: Array.isArray(messages) ? messages : [],
		};
		if (tools !== undefined) {
			context.tools = tools;
		}
		const options: Record<string, unknown> = {};
		if (maxTokens !== undefined) options.maxTokens = maxTokens;
		if (temperature !== undefined) options.temperature = temperature;
		if (thinkingLevel !== undefined) options.thinkingLevel = thinkingLevel;
		return Object.freeze({
			type: "request",
			requestId: callId,
			model: Object.freeze({ provider, modelId }),
			context: Object.freeze(context),
			options: Object.freeze(options),
		});
	} catch {
		return null;
	}
}

// ===========================================================================
// Coordinator class
// ===========================================================================

export class HomeProviderCallCoordinator {
	private _closed = false;
	private _poisoned = false;
	private _fifoTail: Promise<void> = new Promise<void>((resolve) => {
		resolve();
	});
	private _durabilityTail: Promise<void> = new Promise<void>((resolve) => {
		resolve();
	});
	private _closeP: Promise<CoordinatorResult<void>> | null = null;
	private _activeCallIds = new Set<string>();
	private _activeStreams = new Map<string, TrackedStream>();
	private readonly _als = new AsyncLocalStorage<boolean>();

	// Bound store methods
	private readonly _storeJournalProviderCall: (...args: readonly unknown[]) => unknown;
	private readonly _storeJournalStarted: (...args: readonly unknown[]) => unknown;
	private readonly _storeJournalChunk: (...args: readonly unknown[]) => unknown;
	private readonly _storeJournalTerminal: (...args: readonly unknown[]) => unknown;
	private readonly _storeJournalInterrupted: (...args: readonly unknown[]) => unknown;
	private readonly _storeMarkDelivered: (...args: readonly unknown[]) => unknown;
	private readonly _storeJournalCancel: (...args: readonly unknown[]) => unknown;
	private readonly _storeQuery: (...args: readonly unknown[]) => unknown;
	private readonly _storeReplayOutput: (...args: readonly unknown[]) => unknown;
	private readonly _storeReplayUndelivered: (...args: readonly unknown[]) => unknown;
	private readonly _storeStatus: (...args: readonly unknown[]) => unknown;
	private readonly _storeQueryReplayableRequest: (...args: readonly unknown[]) => unknown;

	// Bound proxy methods
	private readonly _proxyStream: (...args: readonly unknown[]) => unknown;
	private readonly _proxyCancel: (...args: readonly unknown[]) => unknown;

	// Bound relay methods
	private readonly _relaySend: (...args: readonly unknown[]) => unknown;
	private readonly _relayQueryAck: (...args: readonly unknown[]) => unknown;

	// Close ownership of the store
	private readonly _storeCloseOwned: () => Promise<CoordinatorResult<void>>;

	private readonly _hostId: string;
	private readonly _generation: string;
	private readonly _sessionId: string;

	private constructor(
		sJP: (...args: readonly unknown[]) => unknown,
		sJS: (...args: readonly unknown[]) => unknown,
		sJC: (...args: readonly unknown[]) => unknown,
		sJT: (...args: readonly unknown[]) => unknown,
		sJI: (...args: readonly unknown[]) => unknown,
		sMD: (...args: readonly unknown[]) => unknown,
		sJCa: (...args: readonly unknown[]) => unknown,
		sQ: (...args: readonly unknown[]) => unknown,
		sRO: (...args: readonly unknown[]) => unknown,
		sRU: (...args: readonly unknown[]) => unknown,
		_sRC: (...args: readonly unknown[]) => unknown,
		sSt: (...args: readonly unknown[]) => unknown,
		_sCl: (...args: readonly unknown[]) => unknown,
		sQR: (...args: readonly unknown[]) => unknown,
		pS: (...args: readonly unknown[]) => unknown,
		pC: (...args: readonly unknown[]) => unknown,
		rS: (...args: readonly unknown[]) => unknown,
		rQA: (...args: readonly unknown[]) => unknown,
		storeCloseOwned: () => Promise<CoordinatorResult<void>>,
		hostId: string,
		generation: string,
		sessionId: string,
	) {
		this._storeJournalProviderCall = sJP;
		this._storeJournalStarted = sJS;
		this._storeJournalChunk = sJC;
		this._storeJournalTerminal = sJT;
		this._storeJournalInterrupted = sJI;
		this._storeMarkDelivered = sMD;
		this._storeJournalCancel = sJCa;
		this._storeQuery = sQ;
		this._storeReplayOutput = sRO;
		this._storeReplayUndelivered = sRU;
		this._storeStatus = sSt;
		this._storeQueryReplayableRequest = sQR;
		this._proxyStream = pS;
		this._proxyCancel = pC;
		this._relaySend = rS;
		this._relayQueryAck = rQA;
		this._storeCloseOwned = storeCloseOwned;
		this._hostId = hostId;
		this._generation = generation;
		this._sessionId = sessionId;
	}

	// =========================================================================
	// Erasure helper — poisons coordinator on uncertainty
	// =========================================================================

	/**
	 * Erase owned Uint8Array bytes.  If erasure is uncertain (returns false),
	 * poison the coordinator so no further work can proceed, and return false.
	 * Every path that cannot prove erasure dominates with poison.
	 */
	private _eraseAndPoison(bytes: Uint8Array): boolean {
		if (!eraseKnownOwned(bytes)) {
			this._poisoned = true;
			return false;
		}
		return true;
	}

	// =========================================================================
	// Factory create
	// =========================================================================

	static async create(raw: unknown): Promise<CoordinatorResult<HomeProviderCallCoordinatorCapability>> {
		// ---- Validate outer shape ----
		if (typeof raw !== "object" || raw === null) return coordinatorError("INVALID_ARGUMENT");
		try {
			if (types.isProxy(raw)) return coordinatorError("INVALID_ARGUMENT");
		} catch {
			return coordinatorError("INVALID_ARGUMENT");
		}
		if (Object.getPrototypeOf(raw) !== Object.prototype) return coordinatorError("INVALID_ARGUMENT");
		if (Object.getOwnPropertySymbols(raw).length !== 0) return coordinatorError("INVALID_ARGUMENT");
		const descs = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(descs);
		if (
			names.length !== 4 ||
			!names.includes("store") ||
			!names.includes("proxy") ||
			!names.includes("relay") ||
			!names.includes("identity")
		) {
			return coordinatorError("INVALID_ARGUMENT");
		}
		for (const name of names) {
			const desc = descs[name];
			if (!desc || !desc.enumerable || !("value" in desc) || desc.value === undefined) {
				return coordinatorError("INVALID_ARGUMENT");
			}
		}
		const storeRaw = descs.store.value;
		const proxyRaw = descs.proxy.value;
		const relayRaw = descs.relay.value;
		const identityRaw = descs.identity.value;

		// ---- Validate store brand EARLY to acquire close ownership ----
		if (!isProviderCallStoreCapability(storeRaw)) return coordinatorError("INVALID_ARGUMENT");
		if (typeof storeRaw !== "object" || storeRaw === null) return coordinatorError("INVALID_ARGUMENT");

		// Capture store close descriptor IMMEDIATELY so any downstream failure closes it
		let storeClosed = false;

		const closeDesc = Object.getOwnPropertyDescriptor(storeRaw, "close");
		if (!closeDesc || !("value" in closeDesc) || typeof closeDesc.value !== "function") {
			return coordinatorError("INVALID_ARGUMENT");
		}

		const closeFn = closeDesc.value;
		async function closeStoreOnce(): Promise<boolean> {
			if (storeClosed) return false;
			storeClosed = true;
			const raw = boundCall(closeFn, storeRaw, []);
			if (raw === void 0 || !isNativePromise(raw)) {
				// Checked exact-Promise close uncertainty dominates every later factory failure
				return false;
			}
			const observed = await observe(raw);
			if (observed.status !== "fulfilled") {
				return false;
			}
			// Validate close result: store.close returns StoreResult<void> — reject {ok:false, error:{...}} or {status:"error"}
			const resolved = observed.value;
			if (typeof resolved !== "object" || resolved === null) return false;
			try {
				if (types.isProxy(resolved)) return false;
				if (Object.getPrototypeOf(resolved) !== Object.prototype) return false;
				if (Object.getOwnPropertySymbols(resolved).length !== 0) return false;
				const d = Object.getOwnPropertyDescriptors(resolved);
				const okDesc = d.ok;
				if (okDesc && "value" in okDesc && okDesc.value !== true) return false;
				if (!okDesc || !("value" in okDesc) || okDesc.value !== true) return false;
			} catch {
				return false;
			}
			return true;
		}

		// Bind store methods (close already captured above)
		const storeDescs = Object.getOwnPropertyDescriptors(storeRaw);
		const storeOwnNames = Object.getOwnPropertyNames(storeDescs);
		const expectedStoreNames = [
			"journalProviderCall",
			"journalStarted",
			"journalChunk",
			"journalTerminal",
			"journalInterrupted",
			"journalCancel",
			"markDelivered",
			"query",
			"replayOutput",
			"replayCallRecords",
			"replayUndelivered",
			"close",
			"status",
			"queryReplayableRequest",
		];
		for (const n of expectedStoreNames) {
			if (!storeOwnNames.includes(n)) {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
		}
		function bindStoreMethod(name: string): (...args: readonly unknown[]) => unknown {
			const desc = storeDescs[name];
			if (!desc || !("value" in desc) || typeof desc.value !== "function") {
				throw new Error("store method not bound");
			}
			const fn = desc.value;
			return (...args: readonly unknown[]): unknown => {
				try {
					return Reflect.apply(fn, storeRaw, args);
				} catch {
					return void 0;
				}
			};
		}

		let boundStoreFns: Array<(...args: readonly unknown[]) => unknown>;
		try {
			boundStoreFns = expectedStoreNames.map((name) => {
				return bindStoreMethod(name);
			});
		} catch {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}

		const [_sJP, _sJS, _sJC, _sJT, _sJI, _sJCa, _sMD, _sQ, _sRO, _sRC, _sRU, _sClose, _sSt, _sQR] = boundStoreFns;

		// ---- Validate identity ----
		if (typeof identityRaw !== "object" || identityRaw === null) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		try {
			if (types.isProxy(identityRaw)) {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
		} catch {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		if (Object.getPrototypeOf(identityRaw) !== Object.prototype) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		if (Object.getOwnPropertySymbols(identityRaw).length !== 0) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		const idDescs = Object.getOwnPropertyDescriptors(identityRaw);
		const idNames = Object.getOwnPropertyNames(idDescs);
		if (
			idNames.length !== 3 ||
			!idNames.includes("hostId") ||
			!idNames.includes("generation") ||
			!idNames.includes("sessionId")
		) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		for (const name of idNames) {
			const desc = idDescs[name];
			if (!desc || !desc.enumerable || !("value" in desc)) {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
		}
		const hostId = idDescs.hostId.value;
		const generation = idDescs.generation.value;
		const sessionId = idDescs.sessionId.value;
		if (
			typeof hostId !== "string" ||
			!safeId(hostId) ||
			typeof generation !== "string" ||
			!safeId(generation) ||
			typeof sessionId !== "string" ||
			!safeId(sessionId)
		) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}

		// ---- Validate proxy brand ----
		if (!isHomeProviderProxyInstance(proxyRaw)) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		if (typeof proxyRaw !== "object" || proxyRaw === null) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}

		// ---- Validate relay brand ----
		let boundRelaySend: (...args: readonly unknown[]) => unknown;
		let boundRelayQueryAck: (...args: readonly unknown[]) => unknown;

		if (isOrderedDurableRelay(relayRaw)) {
			const port = createRelayEvidencePort(relayRaw);
			if (port === null) {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			const portDescs = Object.getOwnPropertyDescriptors(port);
			const psD = portDescs.send;
			const pqD = portDescs.queryOutgoingAcknowledgment;
			if (!psD || !("value" in psD) || typeof psD.value !== "function") {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			if (!pqD || !("value" in pqD) || typeof pqD.value !== "function") {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			const psFn = psD.value;
			const pqFn = pqD.value;
			boundRelaySend = (...a: readonly unknown[]): unknown => {
				try {
					return Reflect.apply(psFn, port, a);
				} catch {
					return void 0;
				}
			};
			boundRelayQueryAck = (...a: readonly unknown[]): unknown => {
				try {
					return Reflect.apply(pqFn, port, a);
				} catch {
					return void 0;
				}
			};
		} else if (isRelayEvidencePort(relayRaw)) {
			const portDescs = Object.getOwnPropertyDescriptors(relayRaw);
			const psD = portDescs.send;
			const pqD = portDescs.queryOutgoingAcknowledgment;
			if (!psD || !("value" in psD) || typeof psD.value !== "function") {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			if (!pqD || !("value" in pqD) || typeof pqD.value !== "function") {
				await closeStoreOnce();
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			const psFn = psD.value;
			const pqFn = pqD.value;
			boundRelaySend = (...a: readonly unknown[]): unknown => {
				try {
					return Reflect.apply(psFn, relayRaw, a);
				} catch {
					return void 0;
				}
			};
			boundRelayQueryAck = (...a: readonly unknown[]): unknown => {
				try {
					return Reflect.apply(pqFn, relayRaw, a);
				} catch {
					return void 0;
				}
			};
		} else {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}

		// ---- Bind proxy methods ----
		const proxyProto = Object.getPrototypeOf(proxyRaw);
		if (proxyProto === null || proxyProto === Object.prototype) {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		const proxyProtoDescs = Object.getOwnPropertyDescriptors(proxyProto);
		const psD = proxyProtoDescs.stream;
		const pcD = proxyProtoDescs.cancel;
		if (!psD || !("value" in psD) || typeof psD.value !== "function") {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		if (!pcD || !("value" in pcD) || typeof pcD.value !== "function") {
			await closeStoreOnce();
			return coordinatorError("CLOSE_UNCERTAIN");
		}
		const proxyStreamFn = psD.value;
		const proxyCancelFn = pcD.value;
		const boundProxyStream = (...a: readonly unknown[]): unknown => {
			// stream() is async generator; return the generator or void 0 on throw.
			try {
				return Reflect.apply(proxyStreamFn, proxyRaw, a);
			} catch {
				return void 0;
			}
		};
		const boundProxyCancel = (...a: readonly unknown[]): unknown => {
			try {
				return Reflect.apply(proxyCancelFn, proxyRaw, a);
			} catch {
				return void 0;
			}
		};

		// ---- Create coordinator with store close ownership ----
		const storeCloseOwned = async (): Promise<CoordinatorResult<void>> => {
			if (storeClosed) return okVoid();
			storeClosed = true;
			const raw = boundCall(closeFn, storeRaw, []);
			if (raw === void 0 || !isNativePromise(raw)) {
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			const observed = await observe(raw);
			if (observed.status !== "fulfilled") {
				return coordinatorError("CLOSE_UNCERTAIN");
			}
			return okVoid();
		};

		const coordinator = new HomeProviderCallCoordinator(
			_sJP,
			_sJS,
			_sJC,
			_sJT,
			_sJI,
			_sMD,
			_sJCa,
			_sQ,
			_sRO,
			_sRU,
			_sRC,
			_sSt,
			_sClose,
			_sQR,
			boundProxyStream,
			boundProxyCancel,
			boundRelaySend,
			boundRelayQueryAck,
			storeCloseOwned,
			hostId,
			generation,
			sessionId,
		);

		// ---- Restart: replay undelivered calls under coordinator durability ----
		const restartResult = await coordinator._performRestart(boundRelaySend, boundRelayQueryAck);
		if (!restartResult.ok) {
			const cerr = await coordinator._closeAndReturnError();
			return cerr.ok ? coordinatorError("RECOVERY_FAILED") : coordinatorError("CLOSE_UNCERTAIN");
		}

		return okValue(coordinator._buildCapability());
	}

	private async _closeAndReturnError(): Promise<CoordinatorResult<void>> {
		return await this._storeCloseOwned();
	}

	// =========================================================================
	// Restart: replay undelivered calls
	// =========================================================================

	private async _performRestart(
		relaySend: (...args: readonly unknown[]) => unknown,
		_relayQueryAck: (...args: readonly unknown[]) => unknown,
	): Promise<CoordinatorResult<void>> {
		// Enumerate all undelivered records
		const undeliveredRecords: Array<{
			callId: string;
			state: string;
			recordId: string;
			recordedAt: string;
		}> = [];

		{
			let cursor: number | null = null;
			while (true) {
				const raw = boundCall(this._storeReplayUndelivered, void 0, [cursor, UNDELIVERED_PAGE_SIZE]);
				if (raw === void 0 || !isNativePromise(raw)) return coordinatorError("RECOVERY_FAILED");
				const observed = await observe(raw);
				if (observed.status !== "fulfilled") return coordinatorError("RECOVERY_FAILED");
				const page = extractOkValue(observed.value);
				if (!page) return coordinatorError("RECOVERY_FAILED");
				const pD = Object.getOwnPropertyDescriptors(page);
				const recsD = pD.records;
				if (!recsD || !("value" in recsD) || !Array.isArray(recsD.value)) break;
				const recs = recsD.value;
				for (const rec of recs) {
					if (typeof rec !== "object" || rec === null) continue;
					const rD = Object.getOwnPropertyDescriptors(rec);
					const stateD = rD.state;
					const callIdD = rD.callId;
					const recIdD = rD.recordId;
					const recAtD = rD.recordedAt;
					if (!stateD || !("value" in stateD)) continue;
					if (!callIdD || !("value" in callIdD)) continue;
					if (!recIdD || !("value" in recIdD)) continue;
					if (!recAtD || !("value" in recAtD)) continue;
					const st = stateD.value;
					const cid = callIdD.value;
					const rid = recIdD.value;
					const rat = recAtD.value;
					if (
						typeof st !== "string" ||
						typeof cid !== "string" ||
						typeof rid !== "string" ||
						typeof rat !== "string"
					)
						continue;
					undeliveredRecords.push({ callId: cid, state: st, recordId: rid, recordedAt: rat });
				}
				const nextD = pD.nextCursor;
				if (!nextD || !("value" in nextD) || nextD.value === null) break;
				const nextVal = nextD.value;
				if (typeof nextVal !== "number") break;
				cursor = nextVal;
			}
		}

		// For each terminal undelivered call, replay stored output through relay
		for (const rec of undeliveredRecords) {
			if (rec.state === "journaled") {
				// journaled-only: never reexecute started/streaming
				// Check if reexecutable from stored request bytes
				const qrr = await safeStoreCall(this._storeQueryReplayableRequest, [rec.callId]);
				if (qrr.ok) {
					// Has sufficient canonical request bytes -- can be reexecuted
					// But we leave it for the first explicit handleRequest
					// Just durably interrupt for now
					const interrupted = await safeStoreCall(this._storeJournalInterrupted, [rec.callId, 0, rec.recordedAt]);
					if (!interrupted.ok) return coordinatorError("RECOVERY_FAILED");
				} else {
					// No request bytes -- durably interrupt
					const interrupted = await safeStoreCall(this._storeJournalInterrupted, [rec.callId, 0, rec.recordedAt]);
					if (!interrupted.ok) return coordinatorError("RECOVERY_FAILED");
				}
				continue;
			}

			if (rec.state !== "terminal") {
				// started/streaming but not terminal -- durably interrupt
				const stateQuery = await safeStoreCall(this._storeQuery, [rec.callId]);
				if (stateQuery.ok) {
					const stateVal = stateQuery.value;
					const sD = Object.getOwnPropertyDescriptors(stateVal);
					const ctD = sD.chunkCount;
					const chunkCount = ctD && "value" in ctD && typeof ctD.value === "number" ? ctD.value : 0;
					await safeStoreCall(this._storeJournalInterrupted, [rec.callId, chunkCount, rec.recordedAt]);
				}
				continue;
			}

			// Terminal undelivered: relay all stored output
			const replayResult = await this._replayStoredOutput(relaySend, rec.callId, rec.recordedAt);
			if (!replayResult.ok) return coordinatorError("RECOVERY_FAILED");
		}

		return okVoid();
	}

	private async _replayStoredOutput(
		relaySend: (...args: readonly unknown[]) => unknown,
		callId: string,
		recordedAt: string,
	): Promise<CoordinatorResult<void>> {
		let outputCursor = 0;
		for (;;) {
			const raw = boundCall(this._storeReplayOutput, void 0, [callId, outputCursor, OUTPUT_PAGE_SIZE]);
			if (raw === void 0 || !isNativePromise(raw)) return coordinatorError("RECOVERY_FAILED");
			const observed = await observe(raw);
			if (observed.status !== "fulfilled") return coordinatorError("RECOVERY_FAILED");
			const page = extractOkValue(observed.value);
			if (!page) return coordinatorError("RECOVERY_FAILED");
			const pD = Object.getOwnPropertyDescriptors(page);
			const recsD = pD.records;
			if (!recsD || !("value" in recsD) || !Array.isArray(recsD.value)) break;
			const records = recsD.value;

			for (const record of records) {
				if (typeof record !== "object" || record === null) continue;
				const rD = Object.getOwnPropertyDescriptors(record);
				const kindD = rD.kind;
				if (!kindD || !("value" in kindD)) continue;
				const frameD = rD.frame;
				if (!frameD || !("value" in frameD)) continue;
				const frame = frameD.value;

				const idxD = rD.chunkIndex;
				const chunkIdx = idxD && "value" in idxD ? idxD.value : 0;
				const envId = `${callId}-rr-${String(chunkIdx)}`;
				const envelope = Object.freeze({
					type: "frame",
					frameId: envId,
					protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
					sentAt: recordedAt,
					frame,
				});
				// relay-send (best-effort restart -- failures are tolerated because
				// the outgoing queue preserves undelivered frames)
				const sendRaw = boundCall(relaySend, void 0, [envelope]);
				if (sendRaw !== void 0 && isNativePromise(sendRaw)) {
					await observe(sendRaw);
				}
			}

			const nextD = pD.nextChunkIndex;
			if (!nextD || !("value" in nextD) || typeof nextD.value !== "number") break;
			const nextChunkIdx = nextD.value;
			if (nextChunkIdx <= outputCursor) break;
			outputCursor = nextChunkIdx;
		}
		return okVoid();
	}

	private _buildCapability(): HomeProviderCallCoordinatorCapability {
		return Object.freeze({
			handleRequest: (envelope: unknown): Promise<CoordinatorResult<HandleRequestResult>> => {
				return this._handleRequest(envelope);
			},
			handleCancel: (callId: string, recordedAt: string): Promise<CoordinatorResult<HandleCancelResult>> => {
				return this._handleCancel(callId, recordedAt);
			},
			reconcile: (
				callId: string,
				terminalFrameId: string,
				recordedAt: string,
			): Promise<CoordinatorResult<ReconcileResult>> => {
				return this._reconcile(callId, terminalFrameId, recordedAt);
			},
			close: (): Promise<CoordinatorResult<void>> => {
				return this._closeHandle();
			},
		});
	}

	// =========================================================================
	// External call enqueue (with ALS reentry guard)
	// =========================================================================

	private _externalEnqueue<T>(operation: () => Promise<CoordinatorResult<T>>): Promise<CoordinatorResult<T>> {
		if (this._als.getStore() === true) return ownResolve(coordinatorError("POISONED"));
		if (this._closed) return ownResolve(coordinatorError("CLOSED"));

		const captured = ownThen(
			this._fifoTail,
			() => {
				if (this._poisoned) return coordinatorError("POISONED");
				return this._runWithGuard(operation);
			},
			() => coordinatorError("POISONED"),
		);

		const result = ownThen(
			captured,
			(v) => v,
			() => {
				this._poisoned = true;
				return coordinatorError("POISONED");
			},
		);

		this._fifoTail = ownThen(
			result,
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async _runWithGuard<T>(operation: () => Promise<CoordinatorResult<T>>): Promise<CoordinatorResult<T>> {
		return await this._als.run(true, async () => {
			return await operation();
		});
	}

	// =========================================================================
	// Internal store enqueue (raw chain on _tail, no reentry/closed check)
	// =========================================================================

	private _storeEnqueue<T>(operation: () => Promise<T>): Promise<T> {
		const captured = ownThen(
			this._durabilityTail,
			() => operation(),
			() => operation(),
		);
		const safe = ownThen(
			captured,
			(v) => v,
			(e: unknown) => {
				throw e instanceof Error ? e : new Error(String(e));
			},
		);
		this._durabilityTail = ownThen(
			safe,
			() => undefined,
			() => undefined,
		);
		return captured;
	}

	// =========================================================================
	// _handleRequest
	// =========================================================================

	private async _handleRequest(envelope: unknown): Promise<CoordinatorResult<HandleRequestResult>> {
		return await this._externalEnqueue(async () => {
			return await this._handleRequestImpl(envelope);
		});
	}

	private async _handleRequestImpl(envelope: unknown): Promise<CoordinatorResult<HandleRequestResult>> {
		if (this._closed) return coordinatorError("CLOSED");
		const self = this;

		// Step 1: codec-validate the envelope
		const decoded = decodeEnvelope(envelope);
		if (!decoded.ok) return coordinatorError("INVALID_ARGUMENT");
		const frameEnvelope = decoded.value;

		// Step 2: verify provider_proxy model_call_request
		const frame = frameEnvelope.frame;
		const frameDescs = Object.getOwnPropertyDescriptors(frame);
		const frameTypeDesc = frameDescs.type;
		const proxyTypeDesc = frameDescs.proxyType;
		if (!frameTypeDesc || !("value" in frameTypeDesc) || frameTypeDesc.value !== "provider_proxy") {
			return coordinatorError("INVALID_ARGUMENT");
		}
		if (!proxyTypeDesc || !("value" in proxyTypeDesc) || proxyTypeDesc.value !== "model_call_request") {
			return coordinatorError("INVALID_ARGUMENT");
		}

		const callIdDesc = frameDescs.callId;
		if (!callIdDesc || !("value" in callIdDesc)) return coordinatorError("INVALID_ARGUMENT");
		const callId = callIdDesc.value;
		if (typeof callId !== "string" || !safeId(callId)) return coordinatorError("INVALID_ARGUMENT");

		const provider = descStringValue(frameDescs, "provider");
		const modelId = descStringValue(frameDescs, "model");
		if (!provider || !modelId) return coordinatorError("INVALID_ARGUMENT");

		const systemPrompt = descStringValue(frameDescs, "systemPrompt");
		const messagesDesc = frameDescs.messages;
		const messagesVal = messagesDesc && "value" in messagesDesc ? messagesDesc.value : [];
		const toolsDesc = frameDescs.tools;
		const toolsVal = toolsDesc && "value" in toolsDesc ? toolsDesc.value : undefined;
		const maxTokens = descNumberValue(frameDescs, "maxTokens");
		const temperature = descNumberValue(frameDescs, "temperature");
		const thinkingLevel = descStringValue(frameDescs, "thinkingLevel");

		const recordedAt = frameEnvelope.sentAt;
		if (typeof recordedAt !== "string" || !safeTimestamp(recordedAt)) return coordinatorError("INVALID_ARGUMENT");
		const requestFrameId = frameEnvelope.frameId;
		if (typeof requestFrameId !== "string" || !safeId(requestFrameId)) return coordinatorError("INVALID_ARGUMENT");

		// Duplicate check
		if (this._activeCallIds.has(callId)) return coordinatorError("CALL_ID_COLLISION");

		// Compute actual canonical JSON bytes of the validated frame
		const frameBytesResult = jsonBytesOf(frame);
		if (!frameBytesResult) return coordinatorError("INVALID_ARGUMENT");
		const frameJsonBytes = frameBytesResult.bytes;
		const canonicalRequestDigest = frameBytesResult.digest;
		// requestDigest = canonicalDigest(frame) — validated by codec against parsed frame.
		const canonDigestResult = canonicalDigest(frame);
		if (!canonDigestResult.ok) {
			if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");
			return coordinatorError("INVALID_ARGUMENT");
		}
		const requestDigest = canonDigestResult.value;

		// Build ProxyRequestRecord for proxy.stream()
		const proxyRequest = buildProxyRequestRecord(
			callId,
			provider,
			modelId,
			systemPrompt,
			messagesVal,
			toolsVal,
			maxTokens,
			temperature,
			thinkingLevel,
		);
		if (!proxyRequest) {
			if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");
			return coordinatorError("INVALID_ARGUMENT");
		}

		// ---- Admission: all store operations serialized on _storeEnqueue ----
		return await this._storeEnqueue(async () => {
			// Get next sequence
			const statusResult = await safeStoreCall(this._storeStatus, []);
			if (!statusResult.ok) {
				if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");
				return coordinatorError("STORE_FAILED");
			}
			const statusVal = statusResult.value;
			const sD = Object.getOwnPropertyDescriptors(statusVal);
			const nsD = sD.nextSequence;
			if (!nsD || !("value" in nsD)) {
				if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");
				return coordinatorError("STORE_FAILED");
			}
			const nextSeq = nsD.value;
			if (
				typeof nextSeq !== "number" ||
				!Number.isSafeInteger(nextSeq) ||
				nextSeq < 0 ||
				nextSeq > MAX_JOURNAL_SEQ
			) {
				if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");
				return coordinatorError("STORE_FAILED");
			}

			// Build journaled record with actual frame JSON bytes
			const journaledRecord: ProviderCallJournaledRecordV1 = Object.freeze({
				version: 1,
				recordKind: "journaled",
				journalSeq: nextSeq,
				callId,
				hostId: this._hostId,
				generation: this._generation,
				sessionId: this._sessionId,
				recordedAt,
				requestFrameId,
				requestBytes: new Uint8Array(frameJsonBytes),
				requestDigest,
				canonicalRequestDigest,
			});
			if (!this._eraseAndPoison(frameJsonBytes)) return coordinatorError("POISONED");

			const journalResult = await safeStoreCall(this._storeJournalProviderCall, [journaledRecord]);
			if (!journalResult.ok) {
				return coordinatorError(storeErrorToCoordinator(journalResult.error.code));
			}
			const journaledReceiptValue = validateStoreJournaledReceipt(journalResult.value);
			if (!journaledReceiptValue) {
				return coordinatorError("STORE_FAILED");
			}

			// Get proxy stream
			const streamOutputRaw = boundCall(this._proxyStream, void 0, [proxyRequest]);
			if (streamOutputRaw === void 0 || typeof streamOutputRaw !== "object" || streamOutputRaw === null) {
				return coordinatorError("PROXY_FAILED");
			}

			// Shared orphan-containment helper for early errors after proxy acquisition.
			// Proxy has started making API calls; we must close iterator and cancel proxy.
			let _streamIterator: AsyncIterator<unknown> | null = null;
			let _streamReturnFn: ((...args: readonly unknown[]) => unknown) | undefined;
			let _streamReturnUncertain = false;

			async function closeProxyStream(_callId: string): Promise<boolean> {
				// Iterator-only containment — no proxy.cancel here.
				// Returns true if return closed cleanly, false = uncertainty.
				let returnClosedUncertain = false;
				if (_streamReturnUncertain) {
					returnClosedUncertain = true;
				}
				if (_streamReturnFn && _streamIterator) {
					try {
						const retRaw = Reflect.apply(_streamReturnFn, _streamIterator, []);
						if (retRaw === void 0 || retRaw === null) {
							returnClosedUncertain = true;
						} else if (isNativePromise(retRaw)) {
							const retObs = await observe(retRaw);
							if (retObs.status !== "fulfilled") {
								returnClosedUncertain = true;
							}
						} else {
							returnClosedUncertain = true;
						}
					} catch {
						returnClosedUncertain = true;
					}
				}
				return !returnClosedUncertain;
			}

			// Own-first Symbol.asyncIterator extraction
			const iterFn = ownFirstDataFunction(streamOutputRaw, Symbol.asyncIterator);
			if (!iterFn) {
				// streamOutputRaw is a live generator; NO durable started state exists.
				// Do NOT fabricate a cancellation — just return error without proxy.cancel.
				return coordinatorError("PROXY_FAILED");
			}
			let iterator: AsyncIterator<unknown>;
			try {
				const it = Reflect.apply(iterFn, streamOutputRaw, []);
				if (typeof it !== "object" || it === null) {
					// No durable started state — do not fabricate cancellation
					return coordinatorError("PROXY_FAILED");
				}
				if (!isAsyncIterator(it)) {
					// No durable started state — do not fabricate cancellation
					return coordinatorError("PROXY_FAILED");
				}
				iterator = it;
			} catch {
				// No durable started state — do not fabricate cancellation
				return coordinatorError("PROXY_FAILED");
			}

			// Own-first next() (iterator own, then prototype chain)
			const nextFn = ownFirstDataFunction(iterator, "next");
			if (!nextFn) {
				// No durable started state — do not fabricate cancellation
				return coordinatorError("PROXY_FAILED");
			}

			// Own-first return() for cleanup (iterator own, then prototype chain).
			// Distinguish absent optional return from present-hostile descriptor.
			const returnDesc = captureReturnDescriptor(iterator, "return");
			_streamIterator = iterator;
			if (returnDesc === "absent") {
				// No return method — optional, no uncertainty
				_streamReturnFn = undefined;
			} else if (returnDesc === "hostile") {
				// Present but hostile — mark uncertainty, treat as absent
				_streamReturnFn = undefined;
				_streamReturnUncertain = true;
			} else {
				_streamReturnFn = returnDesc;
			}

			// Capture next() raw result WITHOUT inspecting it
			let firstNextThrew = false;
			let firstNextPromise: Promise<unknown> = new Promise<void>((resolve) => {
				resolve();
			});
			try {
				const raw = Reflect.apply(nextFn, iterator, []);
				if (isNativePromise(raw)) {
					firstNextPromise = raw;
				} else {
					firstNextThrew = true;
				}
			} catch {
				firstNextThrew = true;
			}
			const firstNextThrewFlag = firstNextThrew;

			// Shared cleanup when journalStarted fails OR receipt is malformed.
			// NOTE: `self` is captured from _handleRequestImpl's `const self = this;` above.
			async function abortStoreStarted(errCode: CoordinatorErrorCode): Promise<CoordinatorResult<never>> {
				// 1. observe/consume first result (so no dangling stream)
				if (!firstNextThrewFlag) await observe(firstNextPromise);
				// 2. journalCancel durably before proxy.cancel -- check result
				const cancelRecAt = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
				const cancelChk = await safeStoreCall(self._storeJournalCancel, [callId, cancelRecAt]);
				const journalCancelOk = cancelChk.ok;
				// 3. close iterator via iterator-only helper (no proxy.cancel)
				// If iterator.return failed uncertainly, uncertainty dominates the outcome.
				const returnClosedClean = await closeProxyStream(callId);
				// 4. proxy.cancel only after successful durable journal
				if (journalCancelOk) {
					boundCall(self._proxyCancel, void 0, [callId]);
				}
				// Uncertainty from iterator.return dominates: if return couldn't be verified,
				// we can't claim clean cleanup even if journal succeeded.
				if (!returnClosedClean && journalCancelOk) {
					return coordinatorError("STORE_FAILED");
				}
				return coordinatorError(journalCancelOk ? errCode : "STORE_FAILED");
			}

			// IMMEDIATELY journal STARTED before inspecting next result
			const startedResult = await safeStoreCall(self._storeJournalStarted, [
				callId,
				requestDigest,
				journaledReceiptValue.receipt,
				recordedAt,
			]);
			if (!startedResult.ok) {
				return await abortStoreStarted(storeErrorToCoordinator(startedResult.error.code));
			}
			const startedReceiptValue = validateStoreDurableReceipt(startedResult.value);
			if (!startedReceiptValue) {
				return await abortStoreStarted("STORE_FAILED");
			}

			// Now inspect the captured next result
			if (firstNextThrewFlag) {
				// Provider threw -- durable store state IS committed (STARTED journaled above).
				// journalInterrupted durably, then proxy.cancel only if journal succeeds.
				const interruptedResult = await safeStoreCall(this._storeJournalInterrupted, [callId, 0, recordedAt]);
				const journalInterruptedOk = interruptedResult.ok;
				// close iterator via iterator-only helper (no proxy.cancel)
				const returnClosedClean = await closeProxyStream(callId);
				// proxy.cancel only after successful durable journal
				if (journalInterruptedOk) {
					boundCall(this._proxyCancel, void 0, [callId]);
				}
				// If journal succeeded but iterator.return was uncertain, report STORE_FAILED
				// (uncertainty dominates). Only report PROXY_FAILED when both succeed.
				if (!returnClosedClean && journalInterruptedOk) {
					return coordinatorError("STORE_FAILED");
				}
				return coordinatorError(journalInterruptedOk ? "PROXY_FAILED" : "STORE_FAILED");
			}

			// Register call and start background stream task
			this._activeCallIds.add(callId);
			const tracked = this._createTrackedStream(
				callId,
				iterator,
				nextFn,
				firstNextPromise,
				nextSeq,
				recordedAt,
				journaledReceiptValue,
				startedReceiptValue,
			);
			this._activeStreams.set(callId, tracked);

			return okValue(
				Object.freeze({
					callId,
					journaledReceipt: journaledReceiptValue,
					startedReceipt: startedReceiptValue,
				}),
			);
		});
	}

	// =========================================================================
	// Tracked stream task -- no fire-and-forget
	// =========================================================================

	private _createTrackedStream(
		callId: string,
		iterator: AsyncIterator<unknown>,
		nextFn: (...args: readonly unknown[]) => unknown,
		firstNextPromise: Promise<unknown>,
		nextSeq: number,
		recordedAt: string,
		journaledReceipt: ProviderCallJournaledReceipt,
		startedReceipt: DurableReceipt,
	): TrackedStream {
		// Internal resolver - never rejects externally
		let resolveStream: (result: CoordinatorResult<void>) => void;

		const promise = new Promise<CoordinatorResult<void>>((resolve) => {
			resolveStream = resolve;
		});

		// Start the stream processing in the background
		const runPromise = this._runStreamToCompletion(callId, iterator, nextFn, firstNextPromise, nextSeq, recordedAt);

		// Wire the runPromise to the tracked promise (observe, never reject)
		ownThen(
			runPromise,
			(result) => {
				this._activeStreams.delete(callId);
				this._activeCallIds.delete(callId);
				resolveStream(result);
			},
			() => {
				this._activeStreams.delete(callId);
				this._activeCallIds.delete(callId);
				resolveStream(coordinatorError("POISONED"));
			},
		);

		const tracked: TrackedStream = Object.freeze({
			promise,
			callId,
			journaledReceipt,
			startedReceipt,
		});

		return tracked;
	}

	private async _runStreamToCompletion(
		callId: string,
		iterator: AsyncIterator<unknown>,
		nextFn: (...args: readonly unknown[]) => unknown,
		firstNextRaw: Promise<unknown>,
		baseSeq: number,
		recordedAt: string,
	): Promise<CoordinatorResult<void>> {
		try {
			// Observe first next() result
			const firstObserved = await observe(firstNextRaw);
			if (firstObserved.status !== "fulfilled") {
				return await this._terminalizeInterrupted(callId, baseSeq, 0, recordedAt);
			}
			const firstIterResult = firstObserved.value;
			if (typeof firstIterResult !== "object" || firstIterResult === null) {
				return await this._terminalizeInterrupted(callId, baseSeq, 0, recordedAt);
			}
			const frD = Object.getOwnPropertyDescriptors(firstIterResult);
			const doneD = frD.done;
			if (doneD && "value" in doneD && doneD.value === true) {
				return await this._terminalizeInterrupted(callId, baseSeq, 0, recordedAt);
			}
			const valD = frD.value;
			if (!valD || !("value" in valD)) {
				return await this._terminalizeInterrupted(callId, baseSeq, 0, recordedAt);
			}

			let chunkCount = 0;
			let completedNormally = false;

			// Process first event
			const firstResult = await this._processStreamEvent(callId, valD.value, true, baseSeq, recordedAt, 0);
			if (firstResult === "terminal") {
				completedNormally = true;
			} else if (firstResult === "fail") {
				return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
			} else {
				chunkCount = 1;

				// Continue streaming remaining events
				while (chunkCount < MAX_CHUNKS) {
					let nextPromise: Promise<unknown>;
					try {
						const raw = Reflect.apply(nextFn, iterator, []);
						if (!isNativePromise(raw)) break;
						nextPromise = raw;
					} catch {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
					}

					const nextObs = await observe(nextPromise);
					if (nextObs.status !== "fulfilled") {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
					}
					const iterResult = nextObs.value;
					if (typeof iterResult !== "object" || iterResult === null) {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
					}
					const irD = Object.getOwnPropertyDescriptors(iterResult);
					const doneD2 = irD.done;
					if (doneD2 && "value" in doneD2 && doneD2.value === true) {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
					}
					const valD2 = irD.value;
					if (!valD2 || !("value" in valD2)) {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
					}

					const eventResult = await this._processStreamEvent(
						callId,
						valD2.value,
						false,
						baseSeq,
						recordedAt,
						chunkCount,
					);
					if (eventResult === "terminal") {
						completedNormally = true;
						break;
					}
					if (eventResult === "fail") {
						return await this._terminalizeInterrupted(callId, baseSeq, chunkCount + 1, recordedAt);
					}
					chunkCount += 1;
				}
			}

			if (!completedNormally) {
				return await this._terminalizeInterrupted(callId, baseSeq, chunkCount, recordedAt);
			}

			return okVoid();
		} catch {
			return await this._terminalizeInterrupted(callId, baseSeq, 0, recordedAt);
		}
	}

	private async _processStreamEvent(
		callId: string,
		eventValue: unknown,
		isFirst: boolean,
		_baseSeq: number,
		recordedAt: string,
		precedingChunks: number,
	): Promise<"continue" | "terminal" | "fail"> {
		if (typeof eventValue !== "object" || eventValue === null) return "fail";
		const evD = Object.getOwnPropertyDescriptors(eventValue);
		const typeD = evD.type;
		if (!typeD || !("value" in typeD)) return "fail";
		const eventType = typeD.value;

		// Build terminal payload from proxy events (common to both completion and error)
		let terminalPayload: Record<string, unknown> | null = null;
		let terminalKind: "normal" | "interrupted" = "interrupted";

		if (eventType === "completion") {
			// ProxyCompletionFrame: message + usage with pi-ai Usage fields.
			// Map usage.{input,output,cacheRead,cacheWrite} to remote {inputTokens,outputTokens}.
			const msgVal = evD.message && "value" in evD.message ? evD.message.value : undefined;
			const usageVal = evD.usage && "value" in evD.usage ? evD.usage.value : undefined;
			const payload: Record<string, unknown> = {
				type: "provider_proxy",
				proxyType: "model_call_complete",
				callId,
				result: msgVal !== undefined ? msgVal : Object.freeze({}),
			};
			if (usageVal !== undefined && typeof usageVal === "object" && usageVal !== null) {
				const usageKeys = Object.getOwnPropertyNames(usageVal);
				const inputDesc = usageKeys.includes("input")
					? Object.getOwnPropertyDescriptor(usageVal, "input")
					: undefined;
				const outputDesc = usageKeys.includes("output")
					? Object.getOwnPropertyDescriptor(usageVal, "output")
					: undefined;
				const inVal =
					inputDesc && "value" in inputDesc && typeof inputDesc.value === "number" ? inputDesc.value : undefined;
				const outVal =
					outputDesc && "value" in outputDesc && typeof outputDesc.value === "number"
						? outputDesc.value
						: undefined;
				if (inVal !== undefined && outVal !== undefined) {
					payload.usage = Object.freeze({ inputTokens: inVal, outputTokens: outVal });
				} else if (inVal !== undefined) {
					payload.usage = Object.freeze({ inputTokens: inVal });
				} else if (outVal !== undefined) {
					payload.usage = Object.freeze({ outputTokens: outVal });
				}
			}
			terminalPayload = payload;
			terminalKind = "normal";
		} else if (eventType === "error") {
			// ProxyErrorFrame: code, message, stopReason
			const codeDesc = evD.code;
			const msgDesc = evD.message;
			const _stopDesc = evD.stopReason;
			const codeVal =
				codeDesc && "value" in codeDesc && typeof codeDesc.value === "string" ? codeDesc.value : "PROVIDER_ERROR";
			const _msgVal2 =
				msgDesc && "value" in msgDesc && typeof msgDesc.value === "string" ? msgDesc.value : undefined;
			const resolution: Record<string, unknown> = {
				type: "provider_proxy",
				proxyType: "model_call_error",
				callId,
				error: codeVal,
			};
			terminalPayload = resolution;
			terminalKind = "interrupted";
		} else {
			// Stream event --> journal chunk and relay-send
			const chunkIndex = isFirst ? 0 : precedingChunks;
			const chunkFrame = Object.freeze({
				type: "provider_proxy",
				proxyType: "model_call_chunk",
				callId,
				index: chunkIndex,
				delta: eventValue,
			});

			// Serialize chunk through store enqueue to get accurate sequence
			const chunkResult: "continue" | "fail" = await this._storeEnqueue(async (): Promise<"continue" | "fail"> => {
				const statusResult = await safeStoreCall(this._storeStatus, []);
				if (!statusResult.ok) return "fail";
				const sD = Object.getOwnPropertyDescriptors(statusResult.value);
				const nsD = sD.nextSequence;
				if (!nsD || !("value" in nsD)) return "fail";
				const chunkSeq = nsD.value;
				if (
					typeof chunkSeq !== "number" ||
					!Number.isSafeInteger(chunkSeq) ||
					chunkSeq < 0 ||
					chunkSeq > MAX_JOURNAL_SEQ
				) {
					return "fail";
				}

				const chunkBytesResult = jsonBytesOf(chunkFrame);
				if (!chunkBytesResult) return "fail";
				const chunkBytesVal = chunkBytesResult.bytes;
				const chunkDigest = chunkBytesResult.digest;
				const canonDigResult = canonicalDigest(chunkFrame);
				if (!canonDigResult.ok) {
					if (!this._eraseAndPoison(chunkBytesVal)) return "fail";
					return "fail";
				}

				const chunkRecord = Object.freeze({
					version: 1,
					recordKind: "chunk",
					journalSeq: chunkSeq,
					callId,
					hostId: this._hostId,
					generation: this._generation,
					sessionId: this._sessionId,
					recordedAt,
					chunkIndex,
					chunkFrameBytes: new Uint8Array(chunkBytesVal),
					chunkFrameDigest: chunkDigest,
				});
				if (!this._eraseAndPoison(chunkBytesVal)) return "fail";

				const cResult = await safeStoreCall(this._storeJournalChunk, [chunkRecord]);
				if (!cResult.ok) return "fail";

				// Relay-send chunk envelope with validated send
				const chunkEnvelope = Object.freeze({
					type: "frame",
					frameId: `${callId}-c-${String(chunkIndex)}`,
					protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
					sentAt: recordedAt,
					frame: chunkFrame,
				});
				const sendResult = await safeRelaySend(this._relaySend, [chunkEnvelope]);
				if (sendResult === null) return "fail";

				return "continue";
			});

			return chunkResult;
		}

		// Terminal: journal and relay through store enqueue
		if (terminalPayload === null) return "fail";

		const finalResult: "terminal" | "fail" = await this._storeEnqueue(async (): Promise<"terminal" | "fail"> => {
			const statusResult = await safeStoreCall(this._storeStatus, []);
			if (!statusResult.ok) return "fail";
			const sD = Object.getOwnPropertyDescriptors(statusResult.value);
			const nsD = sD.nextSequence;
			if (!nsD || !("value" in nsD)) return "fail";
			const terminalSeq = nsD.value;
			if (
				typeof terminalSeq !== "number" ||
				!Number.isSafeInteger(terminalSeq) ||
				terminalSeq < 0 ||
				terminalSeq > MAX_JOURNAL_SEQ
			) {
				return "fail";
			}

			const terminalBytesResult = jsonBytesOf(terminalPayload);
			if (!terminalBytesResult) return "fail";
			const terminalBytesVal = terminalBytesResult.bytes;
			const terminalDigest = terminalBytesResult.digest;

			const terminalRecord = Object.freeze({
				version: 1,
				recordKind: "terminal",
				journalSeq: terminalSeq,
				callId,
				hostId: this._hostId,
				generation: this._generation,
				sessionId: this._sessionId,
				recordedAt,
				terminalKind,
				chunkCount: precedingChunks,
				terminalFrameBytes: new Uint8Array(terminalBytesVal),
				terminalFrameDigest: terminalDigest,
			});
			if (!this._eraseAndPoison(terminalBytesVal)) return "fail";

			const tResult = await safeStoreCall(this._storeJournalTerminal, [terminalRecord]);
			if (!tResult.ok) return "fail";

			// Relay-send terminal envelope with exact validation
			const terminalEnvelope = Object.freeze({
				type: "frame",
				frameId: `${callId}-t`,
				protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
				sentAt: recordedAt,
				frame: terminalPayload,
			});
			const sendResult = await safeRelaySend(this._relaySend, [terminalEnvelope]);
			if (sendResult === null) return "fail";

			return "terminal";
		});

		return finalResult;
	}

	// =========================================================================
	// Terminalize interrupted -- returns checked result
	// =========================================================================

	private async _terminalizeInterrupted(
		callId: string,
		_baseSeq: number,
		chunkCount: number,
		recordedAt: string,
	): Promise<CoordinatorResult<void>> {
		const result: CoordinatorResult<void> = await this._storeEnqueue(async () => {
			const intResult = await safeStoreCall(this._storeJournalInterrupted, [callId, chunkCount, recordedAt]);
			if (!intResult.ok) {
				return coordinatorError("POISONED");
			}

			// Relay-send error frame (best-effort; store durable already done)
			const errorFrame = Object.freeze({
				type: "provider_proxy",
				proxyType: "model_call_error",
				callId,
				error: "STREAM_FAILED",
			});
			const errorEnvelope = Object.freeze({
				type: "frame",
				frameId: `${callId}-t`,
				protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
				sentAt: recordedAt,
				frame: errorFrame,
			});
			const sendResult = await safeRelaySend(this._relaySend, [errorEnvelope]);
			if (sendResult === null) {
				return coordinatorError("RELAY_UNCERTAIN");
			}

			return okVoid();
		});

		return result;
	}

	// =========================================================================
	// _handleCancel
	// =========================================================================

	private async _handleCancel(callId: string, recordedAt: string): Promise<CoordinatorResult<HandleCancelResult>> {
		return await this._externalEnqueue(async () => {
			return await this._handleCancelImpl(callId, recordedAt);
		});
	}

	private async _handleCancelImpl(callId: string, recordedAt: string): Promise<CoordinatorResult<HandleCancelResult>> {
		if (this._closed) return coordinatorError("CLOSED");
		if (typeof callId !== "string" || !safeId(callId)) return coordinatorError("INVALID_ARGUMENT");
		if (!safeTimestamp(recordedAt)) return coordinatorError("INVALID_ARGUMENT");

		return await this._storeEnqueue(async () => {
			// journalCancel MUST complete before proxy.cancel
			const cancelResult = await safeStoreCall(this._storeJournalCancel, [callId, recordedAt]);
			if (!cancelResult.ok) {
				return coordinatorError(storeErrorToCoordinator(cancelResult.error.code));
			}
			const cancelReceipt = validateStoreDurableReceipt(cancelResult.value);
			if (!cancelReceipt) {
				return coordinatorError("STORE_FAILED");
			}

			// Now cancel real proxy (synchronous)
			boundCall(this._proxyCancel, void 0, [callId]);

			return okValue(Object.freeze({ callId, cancelReceipt }));
		});
	}

	// =========================================================================
	// _reconcile
	// =========================================================================

	private async _reconcile(
		callId: string,
		terminalFrameId: string,
		recordedAt: string,
	): Promise<CoordinatorResult<ReconcileResult>> {
		return await this._externalEnqueue(async () => {
			return await this._reconcileImpl(callId, terminalFrameId, recordedAt);
		});
	}

	private async _reconcileImpl(
		callId: string,
		terminalFrameId: string,
		recordedAt: string,
	): Promise<CoordinatorResult<ReconcileResult>> {
		if (this._closed) return coordinatorError("CLOSED");
		if (typeof callId !== "string" || !safeId(callId)) return coordinatorError("INVALID_ARGUMENT");
		if (typeof terminalFrameId !== "string" || !safeId(terminalFrameId)) return coordinatorError("INVALID_ARGUMENT");
		if (!safeTimestamp(recordedAt)) return coordinatorError("INVALID_ARGUMENT");

		return await this._storeEnqueue(async () => {
			const stateResult = await safeStoreCall(this._storeQuery, [callId]);
			if (!stateResult.ok) {
				if (stateResult.error.code === "NOT_FOUND") return coordinatorError("CALL_NOT_FOUND");
				return coordinatorError(storeErrorToCoordinator(stateResult.error.code));
			}
			const state = stateResult.value;
			const sD = Object.getOwnPropertyDescriptors(state);
			const stateFieldD = sD.state;
			if (!stateFieldD || !("value" in stateFieldD)) return coordinatorError("STORE_FAILED");
			const stateField = stateFieldD.value;

			// Already delivered
			if (stateField === "delivered") {
				const delD = sD.deliveredReceipt;
				if (!delD || !("value" in delD)) return coordinatorError("STORE_FAILED");
				const dr = validateDurableReceipt(delD.value);
				if (!dr) return coordinatorError("STORE_FAILED");
				return okValue(Object.freeze({ callId, deliveredReceipt: dr }));
			}

			if (stateField !== "terminal") {
				return coordinatorError("INVALID_STATE");
			}

			// Replay all stored output through relay, then reconcile
			return await this._replayAndReconcile(callId, terminalFrameId, recordedAt);
		});
	}

	private async _replayAndReconcile(
		callId: string,
		terminalFrameId: string,
		recordedAt: string,
	): Promise<CoordinatorResult<ReconcileResult>> {
		let terminalPayload: unknown = null;
		let outputCursor = 0;

		for (;;) {
			const raw = boundCall(this._storeReplayOutput, void 0, [callId, outputCursor, OUTPUT_PAGE_SIZE]);
			if (raw === void 0 || !isNativePromise(raw)) break;
			const observed = await observe(raw);
			if (observed.status !== "fulfilled") break;
			const page = extractOkValue(observed.value);
			if (!page) break;
			const pD = Object.getOwnPropertyDescriptors(page);
			const recsD = pD.records;
			if (!recsD || !("value" in recsD) || !Array.isArray(recsD.value)) break;

			for (const record of recsD.value) {
				if (typeof record !== "object" || record === null) continue;
				const rD = Object.getOwnPropertyDescriptors(record);
				const kindD = rD.kind;
				if (!kindD || !("value" in kindD)) continue;
				if (kindD.value === "terminal") {
					const frameD = rD.frame;
					if (frameD && "value" in frameD) terminalPayload = frameD.value;
					break;
				}
				if (kindD.value === "chunk") {
					const frameD = rD.frame;
					if (!frameD || !("value" in frameD)) continue;
					const idxD = rD.chunkIndex;
					const chunkIdx = idxD && "value" in idxD ? idxD.value : 0;
					const envId = `${callId}-rc-${String(chunkIdx)}`;
					const chunkEnv = Object.freeze({
						type: "frame",
						frameId: envId,
						protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
						sentAt: recordedAt,
						frame: frameD.value,
					});
					const sendResult = await safeRelaySend(this._relaySend, [chunkEnv]);
					if (sendResult === null) return coordinatorError("RELAY_UNCERTAIN");
				}
			}
			if (terminalPayload !== null) break;
			const nextD = pD.nextChunkIndex;
			if (!nextD || !("value" in nextD) || typeof nextD.value !== "number") break;
			const nextIdx = nextD.value;
			if (nextIdx <= outputCursor) break;
			outputCursor = nextIdx;
		}

		if (terminalPayload === null || typeof terminalPayload !== "object") {
			return coordinatorError("RECOVERY_FAILED");
		}

		// Relay-send terminal
		const terminalEnvelope = Object.freeze({
			type: "frame",
			frameId: terminalFrameId,
			protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
			sentAt: recordedAt,
			frame: terminalPayload,
		});
		const sendResult = await safeRelaySend(this._relaySend, [terminalEnvelope]);
		if (sendResult === null) return coordinatorError("RELAY_UNCERTAIN");

		// Query ACK
		const ackRaw = boundCall(this._relayQueryAck, void 0, [sendResult.frameId]);
		if (ackRaw === void 0 || !isNativePromise(ackRaw)) return coordinatorError("ACK_MISMATCH");
		const ackObserved = await observe(ackRaw);
		if (ackObserved.status !== "fulfilled") return coordinatorError("ACK_MISMATCH");
		const ackValue = extractOkValue(ackObserved.value);
		if (!ackValue) return coordinatorError("ACK_MISMATCH");

		const ackD = Object.getOwnPropertyDescriptors(ackValue);
		const ackEnvIdD = ackD.ackEnvelopeId;
		const ackEnvDigD = ackD.ackEnvelopeDigest;
		const ackOutD = ackD.outgoingJournalReceipt;
		if (!ackEnvIdD || !("value" in ackEnvIdD)) return coordinatorError("ACK_MISMATCH");
		if (!ackEnvDigD || !("value" in ackEnvDigD)) return coordinatorError("ACK_MISMATCH");
		if (!ackOutD || !("value" in ackOutD)) return coordinatorError("ACK_MISMATCH");
		const ackEnvelopeId = ackEnvIdD.value;
		const ackEnvelopeDigest = ackEnvDigD.value;
		const ackOutJournal = validateDurableReceipt(ackOutD.value);
		if (typeof ackEnvelopeId !== "string" || !safeId(ackEnvelopeId)) return coordinatorError("ACK_MISMATCH");
		if (typeof ackEnvelopeDigest !== "string" || !isValidDigest(ackEnvelopeDigest))
			return coordinatorError("ACK_MISMATCH");
		if (!ackOutJournal) return coordinatorError("ACK_MISMATCH");

		// Verify ACK matches outgoing send
		if (
			ackOutJournal.sequence !== sendResult.journalReceipt.sequence ||
			ackOutJournal.size !== sendResult.journalReceipt.size ||
			ackOutJournal.sha256 !== sendResult.journalReceipt.sha256
		) {
			return coordinatorError("ACK_MISMATCH");
		}

		const delResult = await safeStoreCall(this._storeMarkDelivered, [
			callId,
			ackEnvelopeId,
			ackEnvelopeDigest,
			sendResult.journalReceipt,
			recordedAt,
		]);
		if (!delResult.ok) {
			return coordinatorError(storeErrorToCoordinator(delResult.error.code));
		}
		const deliveredReceipt = validateStoreDurableReceipt(delResult.value);
		if (!deliveredReceipt) return coordinatorError("STORE_FAILED");

		return okValue(Object.freeze({ callId, deliveredReceipt }));
	}

	// =========================================================================
	// close -- non-async, returns cached promise
	// =========================================================================

	private _closeHandle(): Promise<CoordinatorResult<void>> {
		if (this._closeP !== null) return this._closeP;

		this._closed = true;

		// Snapshot active calls ONCE before any mutation
		const activeCallIds = Array.from(this._activeCallIds);

		this._closeP = ownThen(this._fifoTail, async () => {
			// Drain durability queue
			await this._durabilityTail;

			// Journal cancel for every snapshot'd active call (store enqueue)
			for (const cid of activeCallIds) {
				const cancelRecAt = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
				await this._storeEnqueue(async () => {
					await safeStoreCall(this._storeJournalCancel, [cid, cancelRecAt]);
				});
			}

			// Wait for cancel journals to complete
			await this._durabilityTail;

			// proxy.cancel each (synchronous, after durable journal)
			for (const cid of activeCallIds) {
				boundCall(this._proxyCancel, void 0, [cid]);
			}

			// Wait for external tail to drain
			await this._fifoTail;

			// Join all tracked stream tasks
			const streamPromises = Array.from(this._activeStreams.values()).map((ts) => ts.promise);
			if (streamPromises.length > 0) {
				// Owned allSettled via observe (zero-cast, zero-bind)
				const settledResults: Array<{ status: "fulfilled"; value: unknown } | { status: "rejected" }> = [];
				for (const sp of streamPromises) {
					const observed = await observe(sp);
					if (observed.status === "fulfilled") {
						settledResults.push(Object.freeze({ status: "fulfilled", value: observed.value }));
					} else {
						settledResults.push(Object.freeze({ status: "rejected" }));
					}
				}
				const results = settledResults;
				for (const r of results) {
					if (r.status === "rejected") {
						this._poisoned = true;
						return coordinatorError("POISONED");
					}
				}
			}
			this._activeStreams.clear();
			this._activeCallIds.clear();

			// Close store exactly once (owned resource)
			return await this._storeCloseOwned();
		});

		return this._closeP;
	}
}

// ===========================================================================
// TrackedStream interface
// ===========================================================================

interface TrackedStream {
	readonly promise: Promise<CoordinatorResult<void>>;
	readonly callId: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
}

// ===========================================================================
// Public factory export
// ===========================================================================

export async function createHomeProviderCallCoordinator(
	raw: unknown,
): Promise<CoordinatorResult<HomeProviderCallCoordinatorCapability>> {
	return await HomeProviderCallCoordinator.create(raw);
}
