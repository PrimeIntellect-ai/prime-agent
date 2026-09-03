/**
 * Home-private opaque lifecycle-key resolution for sandbox deletion.
 *
 * This module implements a narrow deletion facade.  No raw SandboxIdentity,
 * sandbox ID, region, match count, runner output, or runner errors are ever
 * exported or returned.  The caller sees only frozen DeleteResult objects.
 *
 * Resolution (via provider.lookupByLabel):
 *  - 0 exact matches -> {status:"absent"}
 *  - 1 exact match  -> resolve and delete privately once
 *  - >1 exact match -> {status:"error", code:"COLLISION"}
 *  - Malformed JSON, missing/extra entries, wrong labels, CLI failure,
 *    exceptions -> {status:"error", code:"RESOLUTION_UNCERTAIN"}
 *
 * Delete:
 *  - Invoke provider.deleteResolved privately once (exit-0-only, never stderr).
 *  - If delete fails, re-list with the same label.  Accept absent only on
 *    exact 0 evidence; anything else -> DELETE_UNCERTAIN.
 *
 * ## Safety
 *
 * All external inputs enter as `unknown`.  Every descriptor operation is
 * wrapped in Proxy-safe try/catch with isProxy check first.
 * Exact Object.prototype required on untrusted objects (rejects proxies and
 * custom proto).  Promise observation uses one agent-owned Promise,
 * a referenced bounded timer (no unref), Reflect.apply on
 * Promise.prototype.then only.  Provider functions are bound via captured
 * descriptor value + Reflect.apply at call site, never `.bind()`.
 * `deleteResolved` results are exact-checked as `undefined`.
 * `lifecycleKeyDto` accepts `unknown` and handles Symbol safely.
 */

import { types } from "node:util";

const { isProxy: isProxyNative } = types;

// -------------------------------------------------------------------------
// Own-proto sentinel for exact Object.prototype check
// -------------------------------------------------------------------------

const OBJECT_PROTO = Object.prototype;

// -------------------------------------------------------------------------
// Lifecycle key DTO -- plain object, no branded type
// -------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Safe UUID v4 test that handles Symbol/unknown inputs without throwing.
 */
function safeUuidTest(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	return UUID_RE.test(raw);
}

/**
 * Validate a raw value as a UUID v4 lifecycle key.
 * Accepts `unknown` and never throws.
 * Returns the validated DTO or an INVALID_ARGUMENT error.
 * The returned DTO is frozen (descriptor-snapshot).
 */
export function lifecycleKeyDto(raw: unknown): { readonly lifecycleKey: string } | DeleteErrorResult {
	// Narrow via local variable -- never 'as' cast
	const key = raw;
	if (typeof key !== "string" || !safeUuidTest(key)) {
		return freezeError("INVALID_ARGUMENT");
	}
	return Object.freeze({ lifecycleKey: key });
}

// -------------------------------------------------------------------------
// DeleteResult -- typed constructors replace as-casts
// -------------------------------------------------------------------------

export type DeleteSuccessResult = { readonly status: "deleted" } | { readonly status: "absent" };

export type DeleteErrorCode = "INVALID_ARGUMENT" | "RESOLUTION_UNCERTAIN" | "COLLISION" | "DELETE_UNCERTAIN";

export type DeleteErrorResult = {
	readonly status: "error";
	readonly code: DeleteErrorCode;
};

export type DeleteResult = DeleteSuccessResult | DeleteErrorResult;

// Typed constructors -- private to this module, no as-casts exported
function freezeDeleted(): DeleteSuccessResult {
	return Object.freeze({ status: "deleted" });
}
function freezeAbsent(): DeleteSuccessResult {
	return Object.freeze({ status: "absent" });
}
function freezeError(code: DeleteErrorCode): DeleteErrorResult {
	return Object.freeze({ status: "error", code });
}

// -------------------------------------------------------------------------
// Copy-freeze: create a fresh frozen copy of a plain object
// -------------------------------------------------------------------------

function _copyFreeze<T extends object>(src: T): T {
	const copy = Object.create(null);
	for (const k of Object.keys(src)) {
		const d = Object.getOwnPropertyDescriptor(src, k);
		if (d && "value" in d) {
			Object.defineProperty(copy, k, { value: d.value, enumerable: true });
		}
	}
	return Object.freeze(copy);
}

// -------------------------------------------------------------------------
// ObserveExactPromise -- bounded promise observation, referenced timer
// -------------------------------------------------------------------------

/**
 * Safe bounded promise observation.
 *
 * Validates `raw` as a genuine native Promise with exact Promise.prototype,
 * zero own string-keyed or symbol-keyed properties, and no Proxy
 * (util.types.isPromise returns false for Proxy).  Then uses one
 * agent-owned Promise, a referenced bounded timer, and
 * Reflect.apply(Promise.prototype.then, raw, handlers) to observe
 * fulfillment/rejection without invoking the promise's own `.then`.
 *
 * The returned Promise **always resolves** (never rejects):
 *  - `{ok:true, value}` -- fulfillment with the resolved value
 *  - `{ok:false}` -- bad promise, rejection, or timeout (30s)
 *
 * The timer is referenced (no unref) so pending observation cannot
 * disappear during cleanup.
 *
 * For Promise<void>, exact-checks the resolved value as `undefined`.
 */
const OBSERVE_TIMEOUT_MS = 30_000;

function observeExactPromise(raw: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
	return new Promise<{ ok: true; value: unknown } | { ok: false }>((resolve) => {
		// Non-object / null
		if (typeof raw !== "object" || raw === null) {
			resolve({ ok: false });
			return;
		}
		// isProxy check BEFORE any trap
		if (isProxyNative(raw)) {
			resolve({ ok: false });
			return;
		}
		// util.types.isPromise rejects Proxies (no [[PromiseState]])
		if (!types.isPromise(raw)) {
			resolve({ ok: false });
			return;
		}
		// Exact Promise.prototype -- reject subclassed promises
		if (Object.getPrototypeOf(raw) !== Promise.prototype) {
			resolve({ ok: false });
			return;
		}
		// Zero own enumerable string-keyed properties
		if (Object.getOwnPropertyNames(raw).length > 0) {
			resolve({ ok: false });
			return;
		}
		// Zero own symbol-keyed properties
		if (Object.getOwnPropertySymbols(raw).length > 0) {
			resolve({ ok: false });
			return;
		}

		// Bounded timer -- referenced (no unref) to prevent
		// pending observations from being silently dropped.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const done = (ok: false): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ ok });
		};

		const onFulfilled = (value: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ ok: true as const, value });
		};

		const onRejected = (): void => {
			done(false);
		};

		// Timer protects against never-settling promises
		timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve({ ok: false });
			}
		}, OBSERVE_TIMEOUT_MS);
		// timer.unref() deliberately omitted -- referenced timer

		// Use Reflect.apply on Promise.prototype.then only --
		// never call the promise's own .then
		try {
			Reflect.apply(Promise.prototype.then, raw, [onFulfilled, onRejected]);
		} catch {
			done(false);
		}
	});
}

/**
 * Like observeExactPromise but exact-checks the fulfillment value
 * as `undefined`.  Provider contract is `Promise<void>`, so any
 * non-undefined fulfillment is treated as rejection.
 */
function observeExactVoidPromise(raw: unknown): Promise<{ ok: true } | { ok: false }> {
	return new Promise<{ ok: true } | { ok: false }>((resolve) => {
		if (typeof raw !== "object" || raw === null) {
			resolve({ ok: false });
			return;
		}
		if (isProxyNative(raw)) {
			resolve({ ok: false });
			return;
		}
		if (!types.isPromise(raw)) {
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

		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const done = (ok: false): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ ok });
		};

		const onFulfilled = (value: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			// Promise<void> -- only undefined is a valid fulfillment
			if (value !== undefined) {
				resolve({ ok: false });
				return;
			}
			resolve({ ok: true as const });
		};

		const onRejected = (): void => {
			done(false);
		};

		timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve({ ok: false });
			}
		}, OBSERVE_TIMEOUT_MS);

		try {
			Reflect.apply(Promise.prototype.then, raw, [onFulfilled, onRejected]);
		} catch {
			done(false);
		}
	});
}

// -------------------------------------------------------------------------
// Module-private type alias for the resolved lookup shape
// -------------------------------------------------------------------------

type PrivateLabelLookupResult_Resolved =
	| { readonly status: "absent" }
	| {
			readonly status: "found";
			readonly identity: { readonly id: string };
	  }
	| { readonly status: "collision" };

// -------------------------------------------------------------------------
// Safe descriptor read with Proxy rejection
// -------------------------------------------------------------------------

/**
 * Check that `value` is a plain object with exact Object.prototype,
 * no symbols, exactly the expected own keys, and all descriptors are
 * enumerable value descriptors (not accessors, not non-enumerable).
 *
 * Checks isProxyNative BEFORE any trap-triggering operation.
 * Every descriptor operation is inside try/catch.
 *
 * Returns the value descriptors keyed by property name, or null on
 * any violation.
 */
function safeReadObject(value: unknown, expectedKeys: ReadonlySet<string>): Record<string, PropertyDescriptor> | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	// isProxy check BEFORE any trap
	try {
		if (isProxyNative(value)) return null;
	} catch {
		return null;
	}
	// Exact Object.prototype -- rejects Proxy, custom proto, null proto
	try {
		if (Object.getPrototypeOf(value) !== OBJECT_PROTO) return null;
	} catch {
		return null;
	}
	// Zero symbols
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) return null;
	} catch {
		return null;
	}
	// Exact own keys
	let ownKeys: string[];
	try {
		ownKeys = Object.getOwnPropertyNames(value);
	} catch {
		return null;
	}
	if (ownKeys.length !== expectedKeys.size) {
		return null;
	}
	for (const k of ownKeys) {
		if (!expectedKeys.has(k)) {
			return null;
		}
	}
	// All descriptors must be enumerable value
	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	const result: Record<string, PropertyDescriptor> = {};
	for (const k of ownKeys) {
		const d = descriptors[k];
		if (!d) return null;
		// Must be value descriptor (not accessor), enumerable
		if (!("value" in d) || !d.enumerable) {
			return null;
		}
		// Reject getters/setters
		if ("get" in d || "set" in d) {
			return null;
		}
		result[k] = d;
	}
	return result;
}

/**
 * Validate a lookup result variant before accessing any field.
 * Returns a fresh frozen private identity snapshot.
 * No getter/raw id access is permitted.
 * The input is `unknown` and all reads are wrapped in Proxy-safe try/catch,
 * with isProxy check first.
 */
function validateLookupResult(raw: unknown): PrivateLabelLookupResult_Resolved {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("sandbox-lifecycle-resolver: lookup result is not an object");
	}
	if (isProxyNative(raw)) {
		throw new Error("sandbox-lifecycle-resolver: lookup result is a Proxy");
	}
	if (Object.getPrototypeOf(raw) !== OBJECT_PROTO) {
		throw new Error("sandbox-lifecycle-resolver: lookup result has non-Object prototype");
	}
	if (Object.getOwnPropertySymbols(raw).length > 0) {
		throw new Error("sandbox-lifecycle-resolver: lookup result has own symbol keys");
	}

	let statusDesc: PropertyDescriptor | undefined;
	try {
		statusDesc = Object.getOwnPropertyDescriptor(raw, "status");
	} catch {
		throw new Error("sandbox-lifecycle-resolver: cannot read lookup status");
	}
	if (!statusDesc || !("value" in statusDesc) || !statusDesc.enumerable) {
		throw new Error("sandbox-lifecycle-resolver: lookup status not enumerable value");
	}
	const statusVal: unknown = statusDesc.value;
	// Exact string check -- no String() coercion
	if (typeof statusVal !== "string") {
		throw new Error("sandbox-lifecycle-resolver: lookup status is not a string");
	}
	const status: string = statusVal;

	if (status === "absent") {
		let ownKeys: string[];
		try {
			ownKeys = Object.getOwnPropertyNames(raw);
		} catch {
			throw new Error("sandbox-lifecycle-resolver: cannot read keys");
		}
		if (ownKeys.length !== 1) {
			throw new Error("sandbox-lifecycle-resolver: absent variant has unexpected own keys");
		}
		return Object.freeze({ status: "absent" });
	}

	if (status === "collision") {
		let ownKeys: string[];
		try {
			ownKeys = Object.getOwnPropertyNames(raw);
		} catch {
			throw new Error("sandbox-lifecycle-resolver: cannot read keys");
		}
		if (ownKeys.length !== 1) {
			throw new Error("sandbox-lifecycle-resolver: collision variant has unexpected own keys");
		}
		return Object.freeze({ status: "collision" });
	}

	if (status !== "found") {
		throw new Error("sandbox-lifecycle-resolver: lookup result unknown status");
	}

	// "found" variant requires exactly 2 own keys: status + identity
	let ownKeys: string[];
	try {
		ownKeys = Object.getOwnPropertyNames(raw);
	} catch {
		throw new Error("sandbox-lifecycle-resolver: cannot read keys");
	}
	if (ownKeys.length !== 2 || !ownKeys.includes("identity")) {
		throw new Error("sandbox-lifecycle-resolver: found variant missing or has unexpected own keys");
	}

	let identityDesc: PropertyDescriptor | undefined;
	try {
		identityDesc = Object.getOwnPropertyDescriptor(raw, "identity");
	} catch {
		throw new Error("sandbox-lifecycle-resolver: cannot read found identity");
	}
	if (!identityDesc || !("value" in identityDesc) || !identityDesc.enumerable) {
		throw new Error("sandbox-lifecycle-resolver: found identity not enumerable value");
	}
	const identityVal: unknown = identityDesc.value;

	// Validate identity is {id: string}
	const idExpected = new Set<string>(["id"]);
	const idDescMap = safeReadObject(identityVal, idExpected);
	if (!idDescMap || !idDescMap.id) {
		throw new Error("sandbox-lifecycle-resolver: found identity.id not valid");
	}
	const sidVal: unknown = idDescMap.id.value;
	// Bounded printable safe string: 1-2048 printable ASCII chars
	if (typeof sidVal !== "string" || sidVal.length === 0 || sidVal.length > 2048 || !/^[ -~]+$/.test(sidVal)) {
		throw new Error("sandbox-lifecycle-resolver: found identity.id is not a bounded printable safe string");
	}

	// Fresh frozen private identity snapshot -- no getter/raw id access
	return Object.freeze({
		status: "found",
		identity: Object.freeze({ id: sidVal }),
	});
}

// -------------------------------------------------------------------------
// Provider method binding -- no .bind(), Proxy-safe
// -------------------------------------------------------------------------

interface CapturedProviderMethods {
	provider: unknown;
	// Use explicit function signature -- never Function type
	lookupFn: (...args: unknown[]) => unknown;
	deleteFn: (...args: unknown[]) => unknown;
}

/**
 * Type predicate: narrow a value to a function without casts.
 */
function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	if (typeof value !== "function") return false;
	try {
		if (isProxyNative(value)) return false;
	} catch {
		return false;
	}
	return true;
}

/**
 * Verify a function has Function.prototype in its prototype chain.
 * Rejects non-function proxies that pass typeof check, and functions
 * with anomalous prototypes.
 */
function hasFunctionProto(fn: unknown): boolean {
	if (typeof fn !== "function") return false;
	try {
		if (isProxyNative(fn)) return false;
	} catch {
		return false;
	}
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(fn);
	} catch {
		return false;
	}
	while (proto !== null) {
		if (proto === Function.prototype) return true;
		// Reject Proxy prototypes before the next Object.getPrototypeOf
		try {
			if (isProxyNative(proto)) return false;
		} catch {
			return false;
		}
		try {
			proto = Object.getPrototypeOf(proto);
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Bind captive provider methods without using `.bind()`.
 *
 * Exact-descriptor snapshot a `{provider}` from raw unknown.
 * Each provider method is validated as own non-proxy function before
 * capture.  At call time, uses `Reflect.apply(fn, provider, args)` so
 * `this` points to the original `provider` object.
 *
 * Rejects:
 *  - Non-object, wrong proto, symbols, extra/accessor/nonenum keys
 *  - Missing or non-function methods
 *  - Proxy-wrapped factory options or provider object
 *  - Proxy-wrapped function values (isProxy check before proto walk)
 *
 * No type assertions (`as`) are used.
 */
function captureProviderMethods(raw: unknown): CapturedProviderMethods | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (isProxyNative(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(raw) !== OBJECT_PROTO) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getOwnPropertySymbols(raw).length > 0) return null;
	} catch {
		return null;
	}
	let rKeys: string[];
	try {
		rKeys = Object.getOwnPropertyNames(raw);
	} catch {
		return null;
	}
	if (rKeys.length !== 1 || rKeys[0] !== "provider") return null;

	let pDesc: PropertyDescriptor | undefined;
	try {
		pDesc = Object.getOwnPropertyDescriptor(raw, "provider");
	} catch {
		return null;
	}
	if (!pDesc || !("value" in pDesc) || !pDesc.enumerable) return null;
	const pv: unknown = pDesc.value;
	if (typeof pv !== "object" || pv === null) return null;
	try {
		if (isProxyNative(pv)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(pv) !== OBJECT_PROTO) return null;
	} catch {
		return null;
	}

	// Validate lookupByLabel exists as own enumerable value function
	let ld: PropertyDescriptor | undefined;
	try {
		ld = Object.getOwnPropertyDescriptor(pv, "lookupByLabel");
	} catch {
		return null;
	}
	if (!ld || !("value" in ld) || !ld.enumerable) return null;
	const lv: unknown = ld.value;
	if (!isFunction(lv)) return null;

	// Validate deleteResolved exists as own enumerable value function
	let dd: PropertyDescriptor | undefined;
	try {
		dd = Object.getOwnPropertyDescriptor(pv, "deleteResolved");
	} catch {
		return null;
	}
	if (!dd || !("value" in dd) || !dd.enumerable) return null;
	const dv: unknown = dd.value;
	if (!isFunction(dv)) return null;

	// Verify both functions have Function.prototype in proto chain
	if (!hasFunctionProto(lv) || !hasFunctionProto(dv)) return null;

	// Zero own properties beyond standard name/length
	const fnExtraKeys = Object.getOwnPropertyNames(lv).filter((k) => k !== "length" && k !== "name");
	if (fnExtraKeys.length > 0) return null;
	if (Object.getOwnPropertySymbols(lv).length > 0) return null;
	const fnExtraKeys2 = Object.getOwnPropertyNames(dv).filter((k) => k !== "length" && k !== "name");
	if (fnExtraKeys2.length > 0) return null;
	if (Object.getOwnPropertySymbols(dv).length > 0) return null;

	// No 'as' cast -- the predicate `isFunction` already narrowed
	return {
		provider: pv,
		lookupFn: lv,
		deleteFn: dv,
	};
}

// -------------------------------------------------------------------------
// DeletionFacade -- single-method, factory-constructed, frozen/bound
// -------------------------------------------------------------------------

export interface DeletionFacade {
	/**
	 * Delete the sandbox identified by the given lifecycle key.
	 * Accepts raw unknown; descriptor-snapshots and validates.
	 * Never returns raw provider identity, sandbox ID, runner output, or errors.
	 */
	deleteByLifecycleKey(dto: unknown): Promise<DeleteResult>;
}

// -------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------

/**
 * Create a DeletionFacade bound to the given SandboxProvider.
 *
 * Takes raw:unknown and exact descriptor-snapshots only `{provider}`.
 * The provider is used for private label-lookup and delete.  No reference
 * to the provider is returned; the caller interacts only through
 * DeleteResult.  The returned facade is frozen and its method is bound
 * via captured reference + Reflect.apply.
 *
 * Returns a fixed result on hostile input instead of throwing.
 * All returned result objects are fresh copies (never stale references).
 */
export function createDeletionFacade(raw: unknown): DeletionFacade {
	const captured = captureProviderMethods(raw);

	const deleteByLifecycleKey = async (dto: unknown): Promise<DeleteResult> => {
		// If provider binding failed at factory time, return fixed error
		if (!captured) {
			return freezeError("INVALID_ARGUMENT");
		}
		const { provider, lookupFn, deleteFn } = captured;

		// --- Validate dto as exact {lifecycleKey:string} ---
		const dtoExpected = new Set<string>(["lifecycleKey"]);
		const dtoDesc = safeReadObject(dto, dtoExpected);
		if (!dtoDesc || !dtoDesc.lifecycleKey) {
			return freezeError("INVALID_ARGUMENT");
		}
		const lifecycleKeyVal: unknown = dtoDesc.lifecycleKey.value;
		// Exact string check -- no String() coercion
		if (typeof lifecycleKeyVal !== "string") {
			return freezeError("INVALID_ARGUMENT");
		}
		if (!safeUuidTest(lifecycleKeyVal)) {
			return freezeError("INVALID_ARGUMENT");
		}

		const label = `ovn-${lifecycleKeyVal}`;

		// --- Resolve identity via provider-private label lookup ---
		let lookupRaw: unknown;
		try {
			const rawPromise = Reflect.apply(lookupFn, provider, [label]);
			const observed = await observeExactPromise(rawPromise);
			if (!observed.ok) {
				return freezeError("RESOLUTION_UNCERTAIN");
			}
			lookupRaw = observed.value;
		} catch {
			return freezeError("RESOLUTION_UNCERTAIN");
		}

		// Validate lookup result
		let lookupResult: PrivateLabelLookupResult_Resolved;
		try {
			lookupResult = validateLookupResult(lookupRaw);
		} catch {
			return freezeError("RESOLUTION_UNCERTAIN");
		}

		if (lookupResult.status === "absent") {
			return freezeAbsent();
		}
		if (lookupResult.status === "collision") {
			return freezeError("COLLISION");
		}

		// lookupResult.status === "found" -- use fresh private identity snapshot
		const sandboxId: string = lookupResult.identity.id;

		// --- Delete once via deleteResolved (exit-0-only, never parses stderr) ---
		// exact-checks result as undefined (Promise<void> contract)
		try {
			const rawPromise = Reflect.apply(deleteFn, provider, [sandboxId]);
			const observed = await observeExactVoidPromise(rawPromise);
			if (!observed.ok) {
				// Delete failed or promise invalid -- re-list
				try {
					const relistRawPromise = Reflect.apply(lookupFn, provider, [label]);
					const relistObserved = await observeExactPromise(relistRawPromise);
					if (!relistObserved.ok) {
						return freezeError("DELETE_UNCERTAIN");
					}

					let relistResult: PrivateLabelLookupResult_Resolved;
					try {
						relistResult = validateLookupResult(relistObserved.value);
					} catch {
						return freezeError("DELETE_UNCERTAIN");
					}

					if (relistResult.status === "absent") {
						return freezeAbsent();
					}
				} catch {
					return freezeError("DELETE_UNCERTAIN");
				}

				return freezeError("DELETE_UNCERTAIN");
			}
		} catch {
			return freezeError("DELETE_UNCERTAIN");
		}

		return freezeDeleted();
	};

	const facade: DeletionFacade = Object.freeze({
		deleteByLifecycleKey,
	});
	return facade;
}
