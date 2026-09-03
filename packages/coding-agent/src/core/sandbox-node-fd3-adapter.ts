/**
 * Node fd 3 -> StdinSource adapter for B14 runtime bootstrap.
 *
 * Owns numeric file descriptor 3.  The fd must be open and readable at
 * construction — it is inherited from the wrapper/parent process that
 * passes the PAB1 bootstrap frame.
 *
 * The production adapter copies every Node Buffer chunk into a genuine
 * full-backing Uint8Array via createNodeStdinAdapter and erases only the
 * owned copy after synchronous callback dispatch.  The original Node Buffer
 * is left intact.
 *
 * Close installs/returns one exact shared native Promise before any external
 * calls, consumes ownership even on throw, destroys the owned ReadStream
 * only as cleanup (never evidence), calls callback-style fs.close(3, cb),
 * resolves ok:true only after that callback reports success, resolves
 * CLOSE_UNCERTAIN on callback error/throw or a short injected bounded
 * REFERENCED timer (never unref'd), and ignores late callbacks safely.
 *
 * Every post-acquisition failure invokes and AWAITS the same callback-style
 * fd close observer.  If close is unconfirmed, CLOSE_UNCERTAIN dominates.
 *
 * No promisify, no unref, no /dev/fd/3, no unsafe casts, no process.exit,
 * no require("node:util"), no exported arbitrary-fd close surface.
 *
 * Production input is fixed: fd number 3 is never a parameter.
 *
 * For testing, use the exported _createNodeFd3Adapter with injected
 * { stream, close, closeTimeoutMs } only.
 */

import { createReadStream, close as fsClose } from "node:fs";
import { types } from "node:util";
import { createNodeStdinAdapter } from "./sandbox-node-stdin-adapter.js";
import type { StdinSource } from "./sandbox-stdin-bootstrap-frame.js";

// ---------------------------------------------------------------------------
// Error code union
// ---------------------------------------------------------------------------

export type Fd3AdapterErrorCode = "CLOSE_UNCERTAIN" | "INVALID_FD" | "SETUP_FAILED";

export type CreateFd3AdapterResult =
	| Readonly<{ ok: true; source: StdinSource; close: () => Promise<Fd3CloseResult> }>
	| Readonly<{ ok: false; code: Fd3AdapterErrorCode }>;

export type Fd3CloseResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "CLOSE_UNCERTAIN" }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed production fd number — never /dev/fd/3. */
const PRODUCTION_FD = 3;

/** Default bounded window for close(2) callback outcome. Referenced (never unref'd). */
const DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS = 5_000;

/** Minimum allowed closeTimeoutMs (safe integer). */
const MIN_CLOSE_TIMEOUT_MS = 1;

/** Maximum allowed closeTimeoutMs (safe integer). */
const MAX_CLOSE_TIMEOUT_MS = 120_000;

/** Accepted input key set for _createNodeFd3Adapter. */
const ACCEPTED_INPUT_KEYS = new Set(["stream", "close", "closeTimeoutMs"]);

/** Frozen sentinel owner for fsClose (fs.close ignores `this`). */
const FS_CLOSE_OWNER: object = Object.freeze({});

// ---------------------------------------------------------------------------
// Callback-style close function type
// ---------------------------------------------------------------------------

type CallbackClose = (fd: number, cb: (err: Error | null) => void) => void;

function isCallbackClose(v: unknown): v is CallbackClose {
	return typeof v === "function";
}

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

function isDataDescriptor(d: PropertyDescriptor): d is PropertyDescriptor & { value: unknown } {
	return "value" in d && d.get === undefined && d.set === undefined;
}

/** Require safe integer for timeout values — reject fractional and non-integer. */
function isSafeCloseTimeoutMs(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= MIN_CLOSE_TIMEOUT_MS && v <= MAX_CLOSE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Safe property accessor — retrieves an own-or-prototype data-descriptor
// property value from an object without casting.  Returns undefined if
// the property does not exist, is an accessor, or access throws.
// ---------------------------------------------------------------------------

function safeProperty(obj: object, key: string): unknown {
	try {
		let current: object | null = obj;
		let depth = 0;
		while (current !== null && depth < 20) {
			const d = Object.getOwnPropertyDescriptor(current, key);
			if (d !== undefined) {
				if ("value" in d && d.get === undefined && d.set === undefined) {
					return d.value;
				}
				return undefined;
			}
			current = Object.getPrototypeOf(current);
			depth++;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Validate and snapshot a destroy capability from a stream object.
 * Returns a destroy wrapper if the property is a genuine non-Proxy
 * function (own data descriptor or prototype-chain data descriptor).
 * Returns null (no valid destroy) for missing, accessor, or Proxy values.
 *
 * The returned wrapper uses Reflect.apply for correct `this` binding and
 * fires exactly once.
 */
function snapshotDestroy(raw: object): (() => void) | null {
	const maybe = safeProperty(raw, "destroy");
	if (typeof maybe !== "function") return null;
	// Reject Proxy-wrapped destroy — a Proxy can hide hostile behaviour.
	try {
		if (types.isProxy(maybe)) return null;
	} catch {
		return null;
	}
	let called = false;
	return () => {
		if (called) return;
		called = true;
		try {
			Reflect.apply(maybe, raw, []);
		} catch {
			// best effort — never used as fd-close evidence
		}
	};
}

// ---------------------------------------------------------------------------
// Private close observer (fixed to PRODUCTION_FD — not exported)
// ---------------------------------------------------------------------------

/**
 * Creates a Promise that resolves when the callback-style close(2)
 * completes or the bounded referenced timer fires.
 *
 * Reuses Reflect.apply for exact original-owner binding.
 * Never exported — the only injection surface is _createNodeFd3Adapter.
 */
function createCloseObserver(
	close: CallbackClose,
	closeOwner: object,
	closeTimeoutMs: number,
): Promise<Fd3CloseResult> {
	return new Promise<Fd3CloseResult>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const }));
			}
		}, closeTimeoutMs);

		try {
			Reflect.apply(close, closeOwner, [
				PRODUCTION_FD,
				(err: Error | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (err) {
						resolve(Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const }));
					} else {
						resolve(Object.freeze({ ok: true as const }));
					}
				},
			]);
		} catch {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const }));
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Validated input type after descriptor extraction
// ---------------------------------------------------------------------------

interface ValidatedInput {
	readonly stream: object;
	readonly close: CallbackClose;
	readonly closeTimeoutMs: number;
	/** The original input object for Reflect.apply `this` binding. */
	readonly owner: object;
	/**
	 * Snapshot of the destroy function before any external call, or null
	 * if the property is missing, an accessor, or a Proxy.
	 */
	readonly destroy: (() => void) | null;
}

/**
 * Stateless helper that validates the input shape and returns a typed
 * ValidatedInput or null.  Uses only control-flow narrowing — no casts.
 * Captures destroy before any external adaptation.
 */
function validateInput(input: unknown): ValidatedInput | null {
	// Reject non-object / null / Proxy.
	if (typeof input !== "object" || input === null) return null;
	try {
		if (types.isProxy(input)) return null;
	} catch {
		return null;
	}

	// Snapshot proto, symbols, descriptors.
	let proto: object | null;
	let symbols: symbol[];
	let descs: Record<string, PropertyDescriptor>;
	try {
		proto = Object.getPrototypeOf(input);
		symbols = Object.getOwnPropertySymbols(input);
		descs = Object.getOwnPropertyDescriptors(input);
	} catch {
		return null;
	}

	// Require Object.prototype exactly.
	if (proto !== Object.prototype) return null;
	// Reject symbols.
	if (symbols.length > 0) return null;

	// Validate descriptor names — exactly 3 allowed.
	const descNames = Object.keys(descs);
	if (descNames.length !== 3) return null;
	for (const name of descNames) {
		if (!ACCEPTED_INPUT_KEYS.has(name)) return null;
	}
	if (!descNames.includes("stream") || !descNames.includes("close") || !descNames.includes("closeTimeoutMs")) {
		return null;
	}

	// Extract and validate each descriptor.
	const sd = descs.stream;
	const cd = descs.close;
	const td = descs.closeTimeoutMs;

	// All must be enumerable data descriptors.
	if (!sd || !isDataDescriptor(sd) || !sd.enumerable) return null;
	if (!cd || !isDataDescriptor(cd) || !cd.enumerable) return null;
	if (!td || !isDataDescriptor(td) || !td.enumerable) return null;

	const streamVal = sd.value;
	const closeVal = cd.value;
	const timeoutVal = td.value;

	// Validate value types.
	if (typeof streamVal !== "object" || streamVal === null) return null;
	if (!isCallbackClose(closeVal)) return null;
	if (!isSafeCloseTimeoutMs(timeoutVal)) return null;

	// Reject Proxy on stream and close values.
	try {
		if (types.isProxy(streamVal) || types.isProxy(closeVal)) return null;
	} catch {
		return null;
	}

	// Snapshot destroy synchronously before any external side-effect.
	const destroyFn = snapshotDestroy(streamVal);

	return { stream: streamVal, close: closeVal, closeTimeoutMs: timeoutVal, owner: input, destroy: destroyFn };
}

// ---------------------------------------------------------------------------
// Core result builder (synchronous)
// ---------------------------------------------------------------------------

/**
 * Build the frozen CreateFd3AdapterResult.  Receives a destroy wrapper for
 * the raw ReadStream — invoked before callback close as cleanup only.  The
 * callback close success (or its uncertainty) is the only evidence of fd
 * closure.
 *
 * The destroy wrapper is idempotent: snapshotDestroy ensures exactly one
 * call even if the user calls closeHandle multiple times (only the first
 * enters this code path due to the consumed gate above).
 */
function createFd3Result(
	source: StdinSource,
	destroy: () => void,
	close: CallbackClose,
	closeOwner: object,
	closeTimeoutMs: number,
): CreateFd3AdapterResult {
	let consumed = false;
	let pendingResolve!: (result: Fd3CloseResult) => void;
	const closePromise = new Promise<Fd3CloseResult>((resolve) => {
		pendingResolve = resolve;
	});

	function closeHandle(): Promise<Fd3CloseResult> {
		if (consumed) return closePromise;
		consumed = true;

		// Destroy raw ReadStream as cleanup only — never used as fd-close
		// evidence.  Error is best-effort; callback close still runs.
		try {
			destroy();
		} catch {
			// best effort
		}

		// Install the observer — forwards result to pendingResolve.
		createCloseObserver(close, closeOwner, closeTimeoutMs).then(
			(r) => pendingResolve(r),
			() => pendingResolve(Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const })),
		);

		return closePromise;
	}

	return Object.freeze({
		ok: true as const,
		source,
		close: closeHandle,
	});
}

// ---------------------------------------------------------------------------
// Acquire-attempt helper for object-validated paths (test and production)
// ---------------------------------------------------------------------------

/**
 * Try to create the adapter from a validated input.  If adaptation fails,
 * invokes the snapshot destroy exactly once, awaits the callback close
 * observer, and returns a non-ok result with CLOSE_UNCERTAIN if the
 * close was unconfirmed.
 */
/**
 * Helper: invoke the validated destroy wrapper if it exists.
 */
function invokeDestroy(validated: ValidatedInput): void {
	const d = validated.destroy;
	if (d !== null) {
		try {
			d();
		} catch {
			// best effort
		}
	}
}

async function tryAdaptAndCloseOnFailure(validated: ValidatedInput): Promise<CreateFd3AdapterResult> {
	// A successful adapter requires a genuine non-Proxy destroy capability.
	if (validated.destroy === null) {
		const closeResult = await createCloseObserver(validated.close, validated.owner, validated.closeTimeoutMs);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	let adapterResult: ReturnType<typeof createNodeStdinAdapter>;
	try {
		adapterResult = createNodeStdinAdapter(validated.stream);
	} catch {
		// Unexpected throw — destroy if available, then close.
		invokeDestroy(validated);
		const closeResult = await createCloseObserver(validated.close, validated.owner, validated.closeTimeoutMs);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	if (!adapterResult.ok) {
		// Adapter rejected — destroy if available, then close.
		invokeDestroy(validated);
		const closeResult = await createCloseObserver(validated.close, validated.owner, validated.closeTimeoutMs);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	// Success — wrap with close handle.
	return createFd3Result(
		adapterResult.source,
		validated.destroy,
		validated.close,
		validated.owner,
		validated.closeTimeoutMs,
	);
}

// ---------------------------------------------------------------------------
// Public test-only injected factory (async)
// ---------------------------------------------------------------------------

/**
 * Create an fd3 adapter with explicit dependency injection.
 *
 * Intended for testing only.  `input` must be an object with Object.prototype,
 * no symbols, and exactly 3 own enumerable data property descriptors
 * for keys "stream", "close", and "closeTimeoutMs".
 *
 * The close function is bound via Reflect.apply to the input object as `this`.
 *
 * Never touches the production fd 3.
 */
export async function _createNodeFd3Adapter(input: unknown): Promise<CreateFd3AdapterResult> {
	if (typeof input !== "object" || input === null) {
		return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
	}
	const validated = validateInput(input);
	if (validated === null) {
		return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
	}
	return tryAdaptAndCloseOnFailure(validated);
}

// ---------------------------------------------------------------------------
// Production factory (async)
// ---------------------------------------------------------------------------

/**
 * Create a StdinSource backed by numeric fd 3 inherited from the parent.
 *
 * Async production-only adapter so every post-acquisition failure can
 * await the same callback-style fd close.  The production caller must
 * await the result and the CLI must never exit before cleanup.
 *
 * Tests must use _createNodeFd3Adapter with injected dependencies.
 */
export async function createNodeFd3Adapter(): Promise<CreateFd3AdapterResult> {
	// Acquire the ReadStream over fd 3 (autoClose=false so we own the
	// close lifecycle).
	let readable: ReturnType<typeof createReadStream>;
	try {
		readable = createReadStream("", { fd: PRODUCTION_FD, autoClose: false });
	} catch {
		// createReadStream threw — fd 3 is still owned by the runtime.
		// Attempt callback-style close.
		const closeResult = await createCloseObserver(fsClose, FS_CLOSE_OWNER, DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "INVALID_FD" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	// Build destroy snapshot before adaptation — requires genuine non-Proxy destroy.
	const destroy = snapshotDestroy(readable);
	if (destroy === null) {
		// No valid destroy capability — close fd 3 and return failure.
		const closeResult = await createCloseObserver(fsClose, FS_CLOSE_OWNER, DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	// Build the StdinSource; catch unexpected throw.
	let adapterResult: ReturnType<typeof createNodeStdinAdapter>;
	try {
		adapterResult = createNodeStdinAdapter(readable);
	} catch {
		destroy();
		const closeResult = await createCloseObserver(fsClose, FS_CLOSE_OWNER, DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	if (!adapterResult.ok) {
		// Setup failed after fd acquisition — destroy exactly once then close.
		destroy();
		const closeResult = await createCloseObserver(fsClose, FS_CLOSE_OWNER, DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS);
		if (closeResult.ok) {
			return Object.freeze({ ok: false as const, code: "SETUP_FAILED" as const });
		}
		return Object.freeze({ ok: false as const, code: "CLOSE_UNCERTAIN" as const });
	}

	// Create result with close handle.  fsClose ignores `this`.
	return createFd3Result(adapterResult.source, destroy, fsClose, FS_CLOSE_OWNER, DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS);
}
