/**
 * Minimal Node Writable -> credential WritableCapability adapter v2.
 *
 * Binds only prototype-chain `write` and `end` from a genuine non-Proxy
 * Node-like Writable.  Returns a frozen `{write, release, end}` cap suitable
 * for `createCredentialFrameWrite({writable, ...})`.
 *
 * No EventEmitter listeners are registered, and the secret frame is never
 * copied inside this adapter.
 */

import * as util from "node:util";

// Inline WritableCapability type (not exported from sandbox-credential-writer.ts)
// Must match the interface expected by createCredentialFrameWrite.
interface WritableCapability {
	readonly write: (frame: Uint8Array, callback: (result: unknown) => void) => unknown;
	readonly release: (callback: (result: unknown) => void) => unknown;
	readonly end: (callback: (result: unknown) => void) => unknown;
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export type CreateNodeWritableAdapterResult =
	| Readonly<{ ok: true; writable: WritableCapability }>
	| Readonly<{ ok: false; code: "INVALID_INPUT" }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ERR_INVALID = Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
const STATUS_STARTED = Object.freeze({ status: "started" as const });
const STATUS_RELEASED = Object.freeze({ status: "released" as const });
const STATUS_ERROR = Object.freeze({ status: "error" as const });
const STATUS_ENDED = Object.freeze({ status: "ended" as const });
const STATUS_WRITTEN = Object.freeze({ status: "written" as const });

const MAX_PROTO_DEPTH = 10;

// ---------------------------------------------------------------------------
// Prototype-chain method extraction for Node Writable
// ---------------------------------------------------------------------------

interface BoundWritableMethods {
	write: (chunk: Uint8Array, cb: (error?: unknown) => void) => boolean;
	end: (cb: (error?: unknown) => void) => unknown;
}

/**
 * Walk the prototype chain to find non-getter value-property `write` and
 * `end` functions.  Returns null on Proxy, getter, or missing method.
 */
function extractWriteEnd(raw: object): BoundWritableMethods | null {
	const needed = new Set(["write", "end"]);
	const found: Record<string, (...args: Array<unknown>) => unknown> = {};

	let current: object | null = raw;
	let depth = 0;

	while (current !== null && needed.size > 0 && depth <= MAX_PROTO_DEPTH) {
		try {
			if (util.types.isProxy(current)) return null;
		} catch {
			return null;
		}

		let descs: Record<string, PropertyDescriptor>;
		try {
			descs = Object.getOwnPropertyDescriptors(current);
		} catch {
			return null;
		}

		for (const key of Object.keys(descs)) {
			if (!needed.has(key)) continue;
			const d = descs[key];
			if (!d) continue;
			// Reject getter/setter
			if (d.get !== undefined || d.set !== undefined) return null;
			if (typeof d.value !== "function") return null;
			found[key] = d.value;
			needed.delete(key);
		}

		try {
			current = Object.getPrototypeOf(current);
		} catch {
			return null;
		}
		depth++;
	}

	if (needed.size > 0) return null;

	return {
		write: found.write.bind(raw) as (chunk: Uint8Array, cb: (error?: unknown) => void) => boolean,
		end: found.end.bind(raw) as (cb: (error?: unknown) => void) => unknown,
	};
}

// ---------------------------------------------------------------------------
// Frame validation — genuine full-backing nonshared Uint8Array
// ---------------------------------------------------------------------------

/**
 * Walk up the typed-array prototype chain to find the buffer/byteOffset/
 * byteLength accessors.  In some engines these live on TypedArray.prototype
 * rather than directly on Uint8Array.prototype.
 */
function findTypedArrayGetter(
	value: object,
	key: "buffer" | "byteOffset" | "byteLength",
): ((this: unknown) => unknown) | null {
	let current: object | null = Object.getPrototypeOf(value);
	let depth = 0;
	while (current !== null && depth < 5) {
		const d = Object.getOwnPropertyDescriptor(current, key);
		if (d?.get) return d.get;
		current = Object.getPrototypeOf(current);
		depth++;
	}
	return null;
}

/**
 * Returns true when `value` is a genuine Uint8Array (exact prototype), backed
 * by a standalone nonshared ArrayBuffer starting at offset 0, with no own
 * property overrides.  Subarrays, Proxy, Buffer subclasses, and
 * SharedArrayBuffer views all return false.
 */
function isGenuineFullBackingUint8Array(value: unknown): value is Uint8Array {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (util.types.isProxy(value)) return false;
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return false;

		// No own property overrides that might hide getter-based detection
		if (Object.hasOwn(value, "buffer") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "byteLength"))
			return false;

		const bufGetter = findTypedArrayGetter(value, "buffer");
		const byteOffGetter = findTypedArrayGetter(value, "byteOffset");
		const byteLenGetter = findTypedArrayGetter(value, "byteLength");
		if (!bufGetter || !byteOffGetter || !byteLenGetter) return false;

		const backing = bufGetter.call(value);
		if (typeof backing !== "object" || backing === null || util.types.isProxy(backing)) return false;
		// SharedArrayBuffer has a different prototype
		if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype) return false;

		const offset = byteOffGetter.call(value);
		const byteLen = byteLenGetter.call(value);
		if (offset !== 0 || typeof byteLen !== "number" || !Number.isSafeInteger(byteLen)) return false;

		const abByteLenGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
		if (!abByteLenGetter) return false;
		const backingLen = abByteLenGetter.call(backing);
		if (byteLen < 1 || byteLen !== backingLen) return false;

		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Exact-descriptors check for writable input validation
// (rejects Proxy, extra keys, getter keys)
// ---------------------------------------------------------------------------

function exactDescriptors(
	raw: unknown,
	keys: ReadonlySet<string>,
): Readonly<Record<string, PropertyDescriptor>> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (util.types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((n) => !keys.has(n))) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const d = descs[name];
			if (!d || !("value" in d) || !d.enumerable) return null;
		}
		return descs;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a frozen `WritableCapability` from a Node `stream.Writable`.
 *
 * The returned cap has three methods:
 * - `write(frame, callback)`  — one-shot write, returns `{status:"started"}`
 * - `release(callback)`       — release frame ownership
 * - `end(callback)`           — signal end-of-write
 */
export function createNodeWritableCredentialAdapter(raw: unknown): CreateNodeWritableAdapterResult {
	// --- Phase 1: validate outer shape ---
	const outerDescs = exactDescriptors(raw, new Set(["writable"]));
	if (!outerDescs) return ERR_INVALID;
	const writableRaw = outerDescs.writable.value;
	if (typeof writableRaw !== "object" || writableRaw === null) return ERR_INVALID;

	// --- Phase 2: extract prototype-chain write/end ---
	let methods: BoundWritableMethods;
	try {
		const m = extractWriteEnd(writableRaw);
		if (!m) return ERR_INVALID;
		methods = m;
	} catch {
		return ERR_INVALID;
	}

	const { write: nodeWrite, end: nodeEnd } = methods;

	// --- Phase 3: state ---
	type WriteState = "idle" | "writing" | "done";
	type EndPhase = "idle" | "ending" | "ended";

	let writeState: WriteState = "idle";
	let writeCallbackFired = false;
	let userWriteCallback: ((result: unknown) => void) | null = null;
	let pendingReleaseCallback: ((result: unknown) => void) | null = null;
	let releaseConsumed = false; // true once release() was called at least once
	let endState: EndPhase = "idle";
	let userEndCallback: ((result: unknown) => void) | null = null;
	let nodeEndCallbackFired = false;

	// -- Write method (one-shot) -------------------------------------------

	/**
	 * The returned `write(frame, callback)`.
	 *
	 * Validates that `frame` is a genuine full-backing nonshared Uint8Array
	 * and `callback` is a function.  Delegates to Node's `write(frame, nodeCallback)`.
	 *
	 * Node boolean true/false both map to `{status:"started"}`.
	 * On Node callback: error -> `{status:"error"}`, else `{status:"written"}`.
	 *
	 * If Node write throws before callback: ownership uncertain; user callback
	 * is never invoked and release stays pending.  If callback fired
	 * synchronously before the throw, its definitive result stands.
	 */
	function capWrite(frame: Uint8Array, callback: (result: unknown) => void): unknown {
		if (writeState !== "idle") throw new Error("write already initiated");
		if (typeof callback !== "function") throw new Error("callback must be a function");
		if (!isGenuineFullBackingUint8Array(frame))
			throw new Error("frame must be a genuine full-backing nonshared Uint8Array");

		writeState = "writing";
		userWriteCallback = callback;
		writeCallbackFired = false;

		function nodeCallback(err?: unknown): void {
			if (writeCallbackFired) return; // hostile duplicate
			writeCallbackFired = true;
			writeState = "done";

			if (err) {
				// Notify the user callback
				const cb = userWriteCallback;
				if (cb) {
					userWriteCallback = null;
					try {
						cb(STATUS_ERROR);
					} catch {
						// swallow
					}
				}
				// Fire pending release callback if any
				const rc = pendingReleaseCallback;
				if (rc) {
					pendingReleaseCallback = null;
					try {
						rc(STATUS_RELEASED);
					} catch {
						// swallow
					}
				}
			} else {
				const cb = userWriteCallback;
				if (cb) {
					userWriteCallback = null;
					try {
						cb(STATUS_WRITTEN);
					} catch {
						// swallow
					}
				}
				// Fire pending release callback if any
				const rc = pendingReleaseCallback;
				if (rc) {
					pendingReleaseCallback = null;
					try {
						rc(STATUS_RELEASED);
					} catch {
						// swallow
					}
				}
			}
		}

		try {
			nodeWrite(frame, nodeCallback);
		} catch {
			// Node write threw.  If nodeCallback already fired synchronously
			// before the throw, its result is definitive.
			if (writeCallbackFired) {
				// callback already processed — state is "done"
				return STATUS_STARTED;
			}
			// nodeCallback never fired (and may never fire).  Stay in
			// "writing" state without invoking user callback.  Release
			// stays pending forever unless nodeCallback eventually fires.
			// writeState remains "writing"
			return STATUS_STARTED;
		}

		return STATUS_STARTED;
	}

	// -- Release method ---------------------------------------------------

	/**
	 * release(cb):
	 * - If write callback already happened or no write transferred:
	 *   synchronously callback + return `{status:"released"}`.
	 * - If write still possibly owns frame (writing, including throw w/o
	 *   callback): store one release callback and return `{status:"started"}`;
	 *   fire `{status:"released"}` only after write callback fires.
	 * - Reuse/double callbacks: return `{status:"error"}` without invoking
	 *   the existing owner.
	 * - Never fabricate cancellation.
	 */
	function capRelease(callback: (result: unknown) => void): unknown {
		if (typeof callback !== "function") throw new Error("callback must be a function");

		// Consume one release attempt
		if (releaseConsumed) {
			// Already had a release attempt.  Reuse/double: return error.
			return STATUS_ERROR;
		}
		releaseConsumed = true;

		// If write callback already happened or no write transferred
		if (writeState === "done" || writeState === "idle") {
			try {
				callback(STATUS_RELEASED);
			} catch {
				// swallow
			}
			return STATUS_RELEASED;
		}

		// Write still pending or in throw-without-callback state.
		// Store one release callback.
		if (pendingReleaseCallback) {
			// Shouldn't happen since we checked releaseConsumed, but guard.
			return STATUS_ERROR;
		}
		pendingReleaseCallback = callback;
		return STATUS_STARTED;
	}

	// -- End method -------------------------------------------------------

	/**
	 * end(cb):
	 * - Accepted only once after write callback definitive.
	 * - Invokes Node `end(nodeCallback)`.
	 * - Return `{status:"started"}` until node callback, then invoke cb
	 *   with `{status:"ended"}` (or `{status:"error"}` on Node error).
	 * - If Node end throws before node callback, return `{status:"error"}`
	 *   without invoking cb.
	 * - If node callback fired synchronously before throw, its definitive
	 *   result stands.
	 */
	function capEnd(callback: (result: unknown) => void): unknown {
		if (endState !== "idle") return STATUS_ERROR;
		if (writeState !== "done") return STATUS_ERROR; // only after write callback definitive
		if (typeof callback !== "function") return STATUS_ERROR;

		endState = "ending";
		userEndCallback = callback;
		nodeEndCallbackFired = false;

		function nodeEndCallback(err?: unknown): void {
			if (nodeEndCallbackFired) return;
			nodeEndCallbackFired = true;

			if (err) {
				const cb = userEndCallback;
				if (cb) {
					userEndCallback = null;
					try {
						cb(STATUS_ERROR);
					} catch {
						// swallow
					}
				}
			} else {
				const cb = userEndCallback;
				if (cb) {
					userEndCallback = null;
					try {
						cb(STATUS_ENDED);
					} catch {
						// swallow
					}
				}
			}

			endState = "ended";
		}

		try {
			nodeEnd(nodeEndCallback);
		} catch {
			if (nodeEndCallbackFired) {
				// Callback fired synchronously before throw — result stands.
				return STATUS_ENDED;
			}
			// throw before callback
			return STATUS_ERROR;
		}

		// If node callback fired synchronously, return definitive status.
		if (nodeEndCallbackFired) {
			return STATUS_ENDED;
		}

		// Callback will fire later.
		return STATUS_STARTED;
	}

	// --- Phase 4: build frozen cap ---------------------------------------

	const cap: WritableCapability = Object.freeze({
		write: capWrite,
		release: capRelease,
		end: capEnd,
	});

	return Object.freeze({ ok: true as const, writable: cap });
}
