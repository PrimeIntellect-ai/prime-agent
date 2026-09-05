/**
 * Node Readable -> StdinSource adapter for B14 bootstrap frame reader.
 */

import * as util from "node:util";
import type { StdinSource } from "./sandbox-stdin-bootstrap-frame.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOUND_MAX = 65_541;

// ---------------------------------------------------------------------------
// Closed error-code union
// ---------------------------------------------------------------------------

export type AdapterErrorCode = "INVALID_INPUT" | "INVALID_SOURCE";

export type CreateNodeStdinResult =
	| Readonly<{ ok: true; source: StdinSource }>
	| Readonly<{ ok: false; code: AdapterErrorCode }>;

const ERR_INVALID_INPUT: AdapterErrorCode = "INVALID_INPUT";
const ERR_INVALID_SOURCE: AdapterErrorCode = "INVALID_SOURCE";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AdapterState {
	dataCb: ((chunk: Uint8Array) => void) | null;
	endCb: (() => void) | null;
	errorCb: ((err: Error) => void) | null;

	sourceOn: (event: string, cb: (...args: Array<unknown>) => void) => void;
	sourceRemoveListener: (event: string, cb: (...args: Array<unknown>) => void) => void;
	sourceResume: () => void;

	ownedData: ((chunk: unknown) => void) | null;
	ownedEnd: (() => void) | null;
	ownedError: ((err: unknown) => void) | null;
	ownedClose: (() => void) | null;

	registeredData: boolean;
	registeredEnd: boolean;
	registeredError: boolean;
	registeredClose: boolean;

	terminal: boolean;

	/** Set only after terminal AND all owned removals confirmed. */
	disposed: boolean;

	resumed: boolean;
	cleaningUp: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNodeStdinAdapter(raw: unknown): CreateNodeStdinResult {
	if (!raw || typeof raw !== "object") {
		return Object.freeze({ ok: false as const, code: ERR_INVALID_INPUT });
	}

	try {
		if (util.types.isProxy(raw)) {
			return Object.freeze({ ok: false as const, code: ERR_INVALID_SOURCE });
		}
	} catch {
		return Object.freeze({ ok: false as const, code: ERR_INVALID_SOURCE });
	}

	const methods = extractReadableMethods(raw);
	if (!methods) {
		return Object.freeze({ ok: false as const, code: ERR_INVALID_SOURCE });
	}

	const { sourceOn, sourceRemoveListener, sourceResume } = methods;

	const state: AdapterState = {
		dataCb: null,
		endCb: null,
		errorCb: null,
		sourceOn,
		sourceRemoveListener,
		sourceResume,
		ownedData: null,
		ownedEnd: null,
		ownedError: null,
		ownedClose: null,
		registeredData: false,
		registeredEnd: false,
		registeredError: false,
		registeredClose: false,
		terminal: false,
		disposed: false,
		resumed: false,
		cleaningUp: false,
	};

	// ---- Public StdinSource methods ------------------------------------

	function on(event: string, cb: (...args: Array<unknown>) => void): void {
		if (state.terminal || state.disposed) return;
		try {
			if (event === "data" && typeof cb === "function") {
				state.dataCb = cb as (chunk: Uint8Array) => void;
			} else if (event === "end" && typeof cb === "function") {
				state.endCb = cb as () => void;
			} else if (event === "error" && typeof cb === "function") {
				state.errorCb = cb as (err: Error) => void;
			}
		} catch {
			// never throw
		}
	}

	/**
	 * When terminal: still clears downstream ref and retries stale owned
	 * removal so frame-reader cleanup fixes leaked listeners.
	 */
	function removeListener(event: string, cb: (...args: Array<unknown>) => void): void {
		if (state.disposed) return;
		try {
			if (event === "data") {
				const matchCb = state.dataCb === cb;
				if (matchCb) state.dataCb = null;
				if (state.ownedData && state.registeredData && (matchCb || state.dataCb === null)) {
					try {
						state.sourceRemoveListener("data", state.ownedData);
						state.ownedData = null;
						state.registeredData = false;
					} catch {
						// ref+flag survive for later retry
					}
				}
			} else if (event === "end") {
				const matchCb = state.endCb === cb;
				if (matchCb) state.endCb = null;
				if (state.ownedEnd && state.registeredEnd && (matchCb || state.endCb === null)) {
					try {
						state.sourceRemoveListener("end", state.ownedEnd);
						state.ownedEnd = null;
						state.registeredEnd = false;
					} catch {
						// ref+flag survive
					}
				}
			} else if (event === "error") {
				const matchCb = state.errorCb === cb;
				if (matchCb) state.errorCb = null;
				if (state.ownedError && state.registeredError && (matchCb || state.errorCb === null)) {
					try {
						state.sourceRemoveListener("error", state.ownedError);
						state.ownedError = null;
						state.registeredError = false;
					} catch {
						// ref+flag survive
					}
				}
			}
		} catch {
			// never throw
		}

		// After removeListener, if all three downstream callbacks are null
		// and we have owned wrappers (resume was called), the frame reader
		// has disposed of its interest. Treat as explicit downstream disposal:
		// set terminal, cleanupAll (including ownedClose), clear refs.
		if (
			state.resumed &&
			state.dataCb === null &&
			state.endCb === null &&
			state.errorCb === null &&
			!state.terminal &&
			!state.disposed
		) {
			state.terminal = true;
			cleanupAll(state);
			clearDownstreamRefs(state);
			maybeMarkDisposed(state);
		} else {
			maybeMarkDisposed(state);
		}
	}

	function resume(): void {
		if (state.terminal || state.disposed) return;
		if (state.resumed) return;
		try {
			_resumeImpl(state);
		} catch {
			// never throw
		}
	}

	return Object.freeze({
		ok: true as const,
		source: Object.freeze({
			on,
			removeListener,
			resume,
		} as StdinSource),
	});
}

// ---------------------------------------------------------------------------
// Resume implementation
// ---------------------------------------------------------------------------

function _resumeImpl(state: AdapterState): void {
	if (state.terminal || state.disposed) return;
	if (!state.dataCb || !state.endCb || !state.errorCb) return;

	const errorWrapper = makeErrorWrapper(state);
	const closeWrapper = makeCloseWrapper(state);
	const endWrapper = makeEndWrapper(state);
	const dataWrapper = makeDataWrapper(state);

	state.ownedError = errorWrapper;
	state.ownedClose = closeWrapper;
	state.ownedEnd = endWrapper;
	state.ownedData = dataWrapper;

	state.registeredError = true;
	try {
		state.sourceOn("error", errorWrapper);
	} catch {
		cleanupAll(state);
		reportError(state);
		return;
	}
	if (state.terminal || state.disposed) return;

	state.registeredClose = true;
	try {
		state.sourceOn("close", closeWrapper);
	} catch {
		cleanupAll(state);
		reportError(state);
		return;
	}
	if (state.terminal || state.disposed) return;

	state.registeredEnd = true;
	try {
		state.sourceOn("end", endWrapper);
	} catch {
		cleanupAll(state);
		reportError(state);
		return;
	}
	if (state.terminal || state.disposed) return;

	state.registeredData = true;
	try {
		state.sourceOn("data", dataWrapper);
	} catch {
		cleanupAll(state);
		reportError(state);
		return;
	}
	if (state.terminal || state.disposed) return;

	// All four registrations succeeded -- latch resumed before sourceResume
	// so synchronous emissions during sourceResume see resumed=true.
	state.resumed = true;

	try {
		state.sourceResume();
	} catch {
		// sourceResume threw after latch -- terminalize and clean up.
		// resumed stays true (registrations succeeded).
		reportError(state);
	}
}

// ---------------------------------------------------------------------------
// Stale wrapper retry — a wrapper fired after terminal because removal
// threw and the listener is still on the source.
// ---------------------------------------------------------------------------

function staleRetry(state: AdapterState): void {
	if (state.disposed) return;
	cleanupAll(state);
	maybeMarkDisposed(state);
}

/**
 * Mark disposed only when terminal AND all owned registrations cleared.
 */
function maybeMarkDisposed(state: AdapterState): boolean {
	if (state.disposed) return true;
	if (!state.terminal) return false;
	if (state.registeredData || state.registeredEnd || state.registeredClose || state.registeredError) {
		return false;
	}
	state.disposed = true;
	return true;
}

/**
 * Clear ALL downstream callback refs. Called unconditionally after every
 * terminal transition, regardless of whether a notification callback was
 * present.
 */
function clearDownstreamRefs(state: AdapterState): void {
	state.dataCb = null;
	state.endCb = null;
	state.errorCb = null;
}

// ---------------------------------------------------------------------------
// Data wrapper
// ---------------------------------------------------------------------------

/**
 * Validate chunk as a genuine Buffer: reject Proxy, exact Buffer.prototype,
 * no own buffer/byteOffset/byteLength overrides. All reads inside try/catch
 * so validation never throws into EventEmitter.
 */
function isValidBuffer(chunk: unknown): chunk is Buffer {
	try {
		if (!Buffer.isBuffer(chunk)) return false;
		// Reject Proxy(Buffer)
		if (util.types.isProxy(chunk)) return false;
		// Exact Buffer.prototype — reject subclasses
		if (Object.getPrototypeOf(chunk) !== Buffer.prototype) return false;
		// Reject own property overrides
		if (Object.getOwnPropertyDescriptor(chunk as object, "buffer") !== undefined) return false;
		if (Object.getOwnPropertyDescriptor(chunk as object, "byteOffset") !== undefined) return false;
		if (Object.getOwnPropertyDescriptor(chunk as object, "byteLength") !== undefined) return false;
	} catch {
		return false;
	}
	return true;
}

function intrinsicBufBuffer(buf: Buffer): ArrayBuffer {
	return Reflect.get(buf, "buffer") as ArrayBuffer;
}
function intrinsicBufOffset(buf: Buffer): number {
	return Reflect.get(buf, "byteOffset") as number;
}
function intrinsicBufLength(buf: Buffer): number {
	return Reflect.get(buf, "byteLength") as number;
}

function makeDataWrapper(state: AdapterState): (chunk: unknown) => void {
	return (chunk: unknown) => {
		if (state.terminal && !state.disposed) {
			staleRetry(state);
			return;
		}
		if (state.terminal || state.disposed) return;

		if (!isValidBuffer(chunk)) {
			reportError(state);
			return;
		}

		const buf = chunk as Buffer;
		let byteLen: number;
		let bufBuffer: ArrayBuffer;
		let bufOffset: number;

		try {
			byteLen = intrinsicBufLength(buf);
			bufBuffer = intrinsicBufBuffer(buf);
			bufOffset = intrinsicBufOffset(buf);
		} catch {
			reportError(state);
			return;
		}

		if (byteLen === 0) {
			reportError(state);
			return;
		}

		const len = byteLen > BOUND_MAX ? BOUND_MAX : byteLen;

		let fresh: Uint8Array;
		try {
			fresh = new Uint8Array(len);
			fresh.set(new Uint8Array(bufBuffer, bufOffset, len));
		} catch {
			reportError(state);
			return;
		}

		const cb = state.dataCb;
		if (cb) {
			try {
				cb(fresh);
			} catch {
				try {
					fresh.fill(0);
				} catch {
					/* best effort */
				}
				reportError(state);
				return;
			}
		}

		try {
			fresh.fill(0);
		} catch {
			/* best effort */
		}
	};
}

// ---------------------------------------------------------------------------
// End wrapper
// ---------------------------------------------------------------------------

function makeEndWrapper(state: AdapterState): () => void {
	return () => {
		if (state.terminal && !state.disposed) {
			staleRetry(state);
			return;
		}
		if (state.terminal || state.disposed) return;

		state.terminal = true;
		const cb = state.endCb;
		// Capture error callback before clearing downstream refs.
		const errCb = state.errorCb;
		const clean = cleanupAll(state);

		// Always clear downstream refs after terminal transition.
		clearDownstreamRefs(state);

		if (clean && cb) {
			try {
				cb();
			} catch {
				/* best effort */
			}
		} else if (!clean) {
			// Cleanup uncertainty: invoke error callback if present.
			if (errCb) {
				try {
					errCb(makeAdapterError());
				} catch {
					/* best effort */
				}
			}
		}
		maybeMarkDisposed(state);
	};
}

// ---------------------------------------------------------------------------
// Error wrapper
// ---------------------------------------------------------------------------

function makeErrorWrapper(state: AdapterState): (err: unknown) => void {
	return (_err: unknown) => {
		if (state.terminal && !state.disposed) {
			staleRetry(state);
			return;
		}
		if (state.terminal || state.disposed) return;

		state.terminal = true;
		const cb = state.errorCb;
		cleanupAll(state);

		// Always clear downstream refs after terminal transition.
		clearDownstreamRefs(state);

		if (cb) {
			try {
				cb(makeAdapterError());
			} catch {
				/* best effort */
			}
		}
		maybeMarkDisposed(state);
	};
}

// ---------------------------------------------------------------------------
// Close wrapper
// ---------------------------------------------------------------------------

function makeCloseWrapper(state: AdapterState): () => void {
	return () => {
		if (state.terminal && !state.disposed) {
			staleRetry(state);
			return;
		}
		if (state.terminal || state.disposed) return;

		state.terminal = true;
		cleanupAll(state);
		reportError(state);
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapterError(): Error {
	return Object.freeze(new Error("adapter error"));
}

function reportError(state: AdapterState): void {
	if (state.disposed) return;
	state.terminal = true;
	cleanupAll(state);
	const cb = state.errorCb;

	// Always clear downstream refs after terminal transition.
	clearDownstreamRefs(state);

	if (cb) {
		try {
			cb(makeAdapterError());
		} catch {
			/* best effort */
		}
	}
	maybeMarkDisposed(state);
}

/**
 * Attempt to remove all owned registered wrappers.
 * Returns true if all removals succeeded.
 * On throw, ref+flag survive for later retry.
 */
function cleanupAll(state: AdapterState): boolean {
	if (state.cleaningUp) return false;
	state.cleaningUp = true;
	let clean = true;

	if (state.ownedData && state.registeredData) {
		try {
			state.sourceRemoveListener("data", state.ownedData);
			state.ownedData = null;
			state.registeredData = false;
		} catch {
			clean = false;
		}
	}
	if (state.ownedEnd && state.registeredEnd) {
		try {
			state.sourceRemoveListener("end", state.ownedEnd);
			state.ownedEnd = null;
			state.registeredEnd = false;
		} catch {
			clean = false;
		}
	}
	if (state.ownedClose && state.registeredClose) {
		try {
			state.sourceRemoveListener("close", state.ownedClose);
			state.ownedClose = null;
			state.registeredClose = false;
		} catch {
			clean = false;
		}
	}
	if (state.ownedError && state.registeredError) {
		try {
			state.sourceRemoveListener("error", state.ownedError);
			state.ownedError = null;
			state.registeredError = false;
		} catch {
			clean = false;
		}
	}

	state.cleaningUp = false;
	return clean;
}

// ---------------------------------------------------------------------------
// Prototype-chain method extraction
// ---------------------------------------------------------------------------

interface ReadableMethods {
	sourceOn: (event: string, cb: (...args: Array<unknown>) => void) => void;
	sourceRemoveListener: (event: string, cb: (...args: Array<unknown>) => void) => void;
	sourceResume: () => void;
}

const MAX_PROTO_DEPTH = 10;

function extractReadableMethods(obj: object): ReadableMethods | null {
	const found: Record<string, (...args: Array<unknown>) => unknown> = {};
	const needed = new Set(["on", "removeListener", "resume"]);

	let descs: Record<string, PropertyDescriptor>;
	try {
		descs = Object.getOwnPropertyDescriptors(obj);
	} catch {
		return null;
	}
	for (const key of Object.keys(descs)) {
		if (!needed.has(key)) continue;
		const d = descs[key];
		if (!d) continue;
		if (d.get !== undefined || d.set !== undefined) return null;
		if (typeof d.value !== "function") return null;
		found[key] = d.value;
		needed.delete(key);
	}

	let depth = 0;
	let current: object | null;
	try {
		current = Object.getPrototypeOf(obj);
	} catch {
		return null;
	}

	while (current !== null && needed.size > 0 && depth < MAX_PROTO_DEPTH) {
		try {
			if (util.types.isProxy(current)) return null;
		} catch {
			return null;
		}

		try {
			descs = Object.getOwnPropertyDescriptors(current);
		} catch {
			return null;
		}

		for (const key of Object.keys(descs)) {
			if (!needed.has(key)) continue;
			const d = descs[key];
			if (!d) continue;
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
		sourceOn: found.on.bind(obj),
		sourceRemoveListener: found.removeListener.bind(obj),
		sourceResume: found.resume.bind(obj),
	};
}
