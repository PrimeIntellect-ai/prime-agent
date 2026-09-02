/**
 * PAB1 streaming SSH-stdin bootstrap frame reader — B14 wrapper.
 *
 * Reads exactly one uint32BE length-prefixed frame from an injected
 * Readable-like event source.
 *
 * The injected source delivers exact genuine non-shared Uint8Array chunks.
 * Node.js Readable emits Buffer objects, which are Uint8Array subclasses; a
 * production adapter must convert each Buffer into a genuine Uint8Array via
 * `new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)`. That
 * adapter is implemented separately — this module's source contract is narrow:
 * exact ArrayBuffer-backed Uint8Array only.
 *
 * Wire format:
 *   [0-3]   frameLength (uint32 BE)          (4 bytes)
 *   [4..]   payload bytes                    (exact frameLength bytes, 1..65536)
 *   EOF     no trailing bytes
 *
 * The returned payload is a fresh caller-owned Uint8Array; all intermediate
 * buffers are zeroed on non-success terminal paths.
 *
 * Timeout model: one total wall-clock timeout (default 30 s, bounded 1..120000 ms).
 * On fire the promise settles with TIMEOUT after removing all listeners.
 *
 * No dynamic imports, no require, no sync fs/process, no Buffer, no strings
 * containing payload, no concat, no O(n^2).
 */

// ---------------------------------------------------------------------------
// Error code union
// ---------------------------------------------------------------------------

export type StdinBootstrapErrorCode =
	| "INVALID_SOURCE"
	| "INVALID_OPTIONS"
	| "TIMEOUT"
	| "READ_HEADER"
	| "READ_PAYLOAD"
	| "INVALID_LENGTH"
	| "PREMATURE_END"
	| "TRAILING"
	| "INPUT_DETACHED"
	| "INPUT_SHARED"
	| "INPUT_SUBCLASS"
	| "INPUT_PROXY"
	| "INTERNAL"
	| "CALLBACK_FAILED";

// ---------------------------------------------------------------------------
// Result types — frozen, readonly
// ---------------------------------------------------------------------------

export type StdinBootstrapReadResult =
	| Readonly<{ ok: true; payload: Uint8Array }>
	| Readonly<{ ok: false; code: StdinBootstrapErrorCode }>;

export type StdinBootstrapConsumeResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: StdinBootstrapErrorCode }>;

// ---------------------------------------------------------------------------
// Injected source adapter interface
// ---------------------------------------------------------------------------

export interface StdinSource {
	on(event: "data", cb: (chunk: Uint8Array) => void): void;
	on(event: "end", cb: () => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	removeListener(event: "data" | "end" | "error", cb: (...args: Array<unknown>) => void): void;
	resume(): void;
}

// ---------------------------------------------------------------------------
// Read options
// ---------------------------------------------------------------------------

export interface StdinBootstrapReadOptions {
	/** Total wall-clock timeout in ms (default 30 000, bounded 1..120000). */
	totalTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADER_BYTES = 4;
const MAX_PAYLOAD_BYTES = 65_536; // 64 KiB
const MIN_PAYLOAD_BYTES = 1;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const MIN_TOTAL_TIMEOUT_MS = 1;
const MAX_TOTAL_TIMEOUT_MS = 120_000;
const MAX_SYNC_DEPTH = 128;

// Phase constants
const PHASE_HEADER = 0;
const PHASE_PAYLOAD = 1;
const PHASE_TRAILING = 2;
const PHASE_DONE = 3;

/** Check if a genuine Uint8Array's backing buffer is detached. */
function isDetached(buf: Uint8Array): boolean {
	try {
		// ArrayBuffer.prototype.slice throws on a detached buffer.
		// This is more reliable than checking byteLength, which returns 0
		// on some engines (Node 26) rather than throwing.
		ArrayBuffer.prototype.slice.call(buf.buffer, 0, 0);
		return false;
	} catch {
		return true;
	}
}

/** Human-readable chunk rejection code. */
function chunkRejectionCode(chunk: unknown): StdinBootstrapErrorCode | null {
	if (!chunk || typeof chunk !== "object") return "INPUT_PROXY";
	try {
		const proto = Object.getPrototypeOf(chunk);
		if (proto !== Uint8Array.prototype) {
			if (typeof Buffer !== "undefined" && proto === Buffer.prototype) return "INPUT_SUBCLASS";
			return "INPUT_PROXY";
		}
		const buf = (chunk as Uint8Array).buffer;
		const bufProto = Object.getPrototypeOf(buf);
		if (bufProto === SharedArrayBuffer.prototype) return "INPUT_SHARED";
		if (bufProto !== ArrayBuffer.prototype) return "INPUT_DETACHED";
		return null;
	} catch {
		return "INPUT_PROXY";
	}
}

// ---------------------------------------------------------------------------
// Strict options copier
// ---------------------------------------------------------------------------

interface ParsedOptions {
	totalTimeoutMs: number;
}

const OPT_ALLOWED = new Set(["totalTimeoutMs"]);

function copyOptions(raw: unknown): ParsedOptions | null {
	if (raw === null || raw === undefined) {
		return { totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS };
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return null;

	let proto: object | null;
	let descs: Record<string, PropertyDescriptor>;
	let ownSymbols: symbol[];
	try {
		proto = Object.getPrototypeOf(raw);
		descs = Object.getOwnPropertyDescriptors(raw);
		ownSymbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return null;
	}

	if (proto !== Object.prototype && proto !== null) return null;
	if (ownSymbols.length > 0) return null;

	const keys = Object.keys(descs);
	for (const k of keys) {
		const d = descs[k];
		if (!d) return null;
		if (!d.enumerable) return null;
		if (d.get !== undefined || d.set !== undefined) return null;
		if (!OPT_ALLOWED.has(k)) return null;
	}

	let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
	if ("totalTimeoutMs" in descs) {
		const v = descs.totalTimeoutMs.value;
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			!Number.isInteger(v) ||
			v < MIN_TOTAL_TIMEOUT_MS ||
			v > MAX_TOTAL_TIMEOUT_MS
		)
			return null;
		totalTimeoutMs = v;
	}

	return { totalTimeoutMs };
}

// ---------------------------------------------------------------------------
// Strict source adapter copier — returns fresh frozen object from descriptors
// ---------------------------------------------------------------------------

function copySource(raw: unknown): StdinSource | null {
	if (!raw || typeof raw !== "object") return null;

	let proto: object | null;
	let descs: Record<string, PropertyDescriptor>;
	let ownSymbols: symbol[];
	try {
		proto = Object.getPrototypeOf(raw);
		descs = Object.getOwnPropertyDescriptors(raw);
		ownSymbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return null;
	}

	if (proto !== Object.prototype && proto !== null) return null;
	if (ownSymbols.length > 0) return null;

	// Require: on, removeListener, resume — all functions, exactly 3 keys.
	const requiredMethods = new Set(["on", "removeListener", "resume"]);
	const keys = Object.keys(descs);
	if (keys.length !== requiredMethods.size) return null;

	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const d = descs[k];
		if (!d) return null;
		if (!d.enumerable) return null;
		if (d.get !== undefined || d.set !== undefined) return null;
		if (!requiredMethods.has(k)) return null;
		if (typeof d.value !== "function") return null;
		// Copy value from descriptor, never re-read from raw source
		out[k] = d.value;
	}

	return Object.freeze(out as unknown as StdinSource);
}

// ---------------------------------------------------------------------------
// readStdinBootstrapFrame
// ---------------------------------------------------------------------------

/**
 * Read one PAB1 frame from an injected Readable-like event source.
 *
 * Protocol: uint32BE length (big-endian 4 bytes), then payload of exactly
 * that many bytes (1..65536), then EOF with no trailing bytes.
 *
 * The returned `payload` is a fresh caller-owned Uint8Array; all
 * intermediate buffers are zeroed on non-success terminal paths.
 */
export function readStdinBootstrapFrame(
	source: StdinSource,
	options?: StdinBootstrapReadOptions,
): Promise<StdinBootstrapReadResult> {
	return new Promise<StdinBootstrapReadResult>((resolve) => {
		// ---- strict source adapter copy ----------------------------------
		const src = copySource(source);
		if (!src) {
			resolve(Object.freeze({ ok: false, code: "INVALID_SOURCE" } as const));
			return;
		}

		// ---- strict options copy -----------------------------------------
		const opts = copyOptions(options ?? null);
		if (!opts) {
			resolve(Object.freeze({ ok: false, code: "INVALID_OPTIONS" } as const));
			return;
		}

		const { totalTimeoutMs } = opts;

		// ---- persistent state --------------------------------------------
		let settled = false;
		let cancelled = false;
		let syncDepth = 0;

		// Phase
		let phase = PHASE_HEADER;

		// Intermediate buffers
		const headerBuf = new Uint8Array(HEADER_BYTES);
		let payloadScratch: Uint8Array | null = null;
		let freshPayload: Uint8Array | null = null;

		// Accumulated bytes and decoded frame length
		let accHeader = 0;
		let accPayload = 0;
		let frameLength = 0;

		// Timer
		let totalTimer: ReturnType<typeof setTimeout> | null = null;

		// Listener references — set before any registration attempt
		let onDataCb: ((chunk: Uint8Array) => void) | null = null;
		let onEndCb: (() => void) | null = null;
		let onErrorCb: ((err: Error) => void) | null = null;

		// Track which registrations succeeded so cleanup only removes those
		let registeredData = false;
		let registeredEnd = false;
		let registeredError = false;

		// ---- helpers -----------------------------------------------------

		function erase(buf: Uint8Array | null): void {
			if (buf && buf.byteLength > 0) {
				try {
					buf.fill(0);
				} catch {
					// best effort
				}
			}
		}

		function eraseAll(): void {
			erase(headerBuf);
			if (payloadScratch) {
				erase(payloadScratch);
				payloadScratch = null;
			}
			if (freshPayload) {
				erase(freshPayload);
				freshPayload = null;
			}
		}

		function clearTimer(): void {
			if (totalTimer !== null) {
				clearTimeout(totalTimer);
				totalTimer = null;
			}
		}

		function removeOwnListeners(): void {
			if (registeredData && onDataCb) {
				try {
					src.removeListener("data", onDataCb);
				} catch {
					// best effort
				}
				onDataCb = null;
				registeredData = false;
			}
			if (registeredEnd && onEndCb) {
				try {
					src.removeListener("end", onEndCb);
				} catch {
					// best effort
				}
				onEndCb = null;
				registeredEnd = false;
			}
			if (registeredError && onErrorCb) {
				try {
					src.removeListener("error", onErrorCb);
				} catch {
					// best effort
				}
				onErrorCb = null;
				registeredError = false;
			}
		}

		/** Terminal settle — clears timer, removes own listeners, erases buffers, resolves once. */
		function settle(result: StdinBootstrapReadResult): void {
			if (settled) return;
			settled = true;
			cancelled = true;
			clearTimer();
			removeOwnListeners();
			eraseAll();
			resolve(Object.freeze(result));
		}

		function settleWithCode(code: StdinBootstrapErrorCode): void {
			settle({ ok: false, code });
		}

		// ---- onData handler ----------------------------------------------

		function onData(chunk: Uint8Array): void {
			if (settled || cancelled) return;

			// Guard recursion.
			syncDepth++;
			if (syncDepth > MAX_SYNC_DEPTH) {
				syncDepth--;
				settleWithCode("INTERNAL");
				return;
			}

			try {
				// Validate chunk: must be genuine Uint8Array, not detached, not shared, not subclass, not proxy.
				const rejectCode = chunkRejectionCode(chunk);
				if (rejectCode !== null) {
					settleWithCode(rejectCode);
					return;
				}

				if (isDetached(chunk)) {
					settleWithCode("INPUT_DETACHED");
					return;
				}

				let offset = 0;
				const avail = chunk.byteLength;

				// ---- HEADER phase -----------------------------------------
				if (phase === PHASE_HEADER) {
					const need = HEADER_BYTES - accHeader;
					const copyLen = avail < need ? avail : need;

					// Copy from chunk into headerBuf
					headerBuf.set(chunk.subarray(offset, offset + copyLen), accHeader);
					accHeader += copyLen;
					offset += copyLen;

					if (accHeader === HEADER_BYTES) {
						// Decode frame length via DataView
						const dv = new DataView(headerBuf.buffer, headerBuf.byteOffset, HEADER_BYTES);
						frameLength = dv.getUint32(0, false); // big-endian

						// Validate frame length
						if (frameLength < MIN_PAYLOAD_BYTES || frameLength > MAX_PAYLOAD_BYTES) {
							settleWithCode("INVALID_LENGTH");
							return;
						}

						// Exact payload allocation
						payloadScratch = new Uint8Array(frameLength);
						phase = PHASE_PAYLOAD;
					}
				}

				// ---- PAYLOAD phase ----------------------------------------
				if (phase === PHASE_PAYLOAD && offset < avail) {
					const remaining = avail - offset;
					const need = frameLength - accPayload;
					const copyLen = remaining < need ? remaining : need;

					// Before copying, check if chunk has trailing bytes
					if (remaining > need) {
						// Trailing bytes in this chunk
						payloadScratch!.set(chunk.subarray(offset, offset + need), accPayload);
						accPayload += need;
						phase = PHASE_TRAILING;
						settleWithCode("TRAILING");
						return;
					}

					payloadScratch!.set(chunk.subarray(offset, offset + copyLen), accPayload);
					accPayload += copyLen;
					offset += copyLen;

					if (accPayload === frameLength) {
						// Payload complete — wait for EOF (TRAILING phase)
						phase = PHASE_TRAILING;
					}
				}

				// ---- TRAILING phase (any leftover data in chunk) ----------
				if (phase === PHASE_TRAILING && offset < avail) {
					settleWithCode("TRAILING");
					return;
				}
			} catch {
				settleWithCode("INTERNAL");
			} finally {
				syncDepth--;
			}
		}

		// ---- onEnd handler -----------------------------------------------

		function onEnd(): void {
			if (settled || cancelled) return;

			syncDepth++;
			if (syncDepth > MAX_SYNC_DEPTH) {
				syncDepth--;
				settleWithCode("INTERNAL");
				return;
			}

			try {
				if (phase === PHASE_TRAILING && payloadScratch !== null) {
					// Success: payload complete, EOF confirms no trailing bytes
					freshPayload = payloadScratch;
					payloadScratch = null;
					phase = PHASE_DONE;

					// Erase header buffer (caller owns payload only)
					erase(headerBuf);

					// Clear timer and remove listeners BEFORE resolving
					clearTimer();
					removeOwnListeners();

					if (!settled) {
						settled = true;
						cancelled = true;
						resolve(Object.freeze({ ok: true, payload: freshPayload } as const));
					}
					return;
				}

				// End before complete payload
				settleWithCode("PREMATURE_END");
			} catch {
				settleWithCode("INTERNAL");
			} finally {
				syncDepth--;
			}
		}

		// ---- onError handler ---------------------------------------------

		function onError(_err: Error): void {
			if (settled || cancelled) return;

			syncDepth++;
			if (syncDepth > MAX_SYNC_DEPTH) {
				syncDepth--;
				settleWithCode("INTERNAL");
				return;
			}

			try {
				const code: StdinBootstrapErrorCode =
					phase === PHASE_HEADER ? "READ_HEADER" : phase === PHASE_PAYLOAD ? "READ_PAYLOAD" : "INTERNAL";
				settleWithCode(code);
			} catch {
				settleWithCode("INTERNAL");
			} finally {
				syncDepth--;
			}
		}

		// ---- Register listeners one at a time, checking settled after each ----

		onDataCb = onData;
		onEndCb = onEnd;
		onErrorCb = onError;

		// Register data first.
		try {
			src.on("data", onDataCb);
			registeredData = true;
		} catch {
			settleWithCode("INVALID_SOURCE");
			return;
		}
		// A reentrant on("data") could already have settled.
		if (settled || cancelled) return;

		// Register end.
		try {
			src.on("end", onEndCb);
			registeredEnd = true;
		} catch {
			settleWithCode("INVALID_SOURCE");
			return;
		}
		if (settled || cancelled) return;

		// Register error.
		try {
			src.on("error", onErrorCb);
			registeredError = true;
		} catch {
			settleWithCode("INVALID_SOURCE");
			return;
		}
		if (settled || cancelled) return;

		// ---- Create timer only after all registrations succeed ------------
		totalTimer = setTimeout(() => {
			if (settled || cancelled) return;
			settleWithCode("TIMEOUT");
		}, totalTimeoutMs);

		// ---- Start consuming. ---------------------------------------------
		try {
			src.resume();
		} catch {
			settleWithCode("INVALID_SOURCE");
		}
	});
}

// ---------------------------------------------------------------------------
// consumeStdinBootstrapFrame
// ---------------------------------------------------------------------------

export type StdinBootstrapConsumeResultOk<T> = Readonly<{ ok: true; value: T }>;
export type StdinBootstrapConsumeResultFail = Readonly<{ ok: false; code: StdinBootstrapErrorCode }>;

/**
 * Read one PAB1 frame, hand the payload to `fn`, then always zero the
 * payload buffer. If `fn` throws, the error is mapped to CALLBACK_FAILED.
 */
export async function consumeStdinBootstrapFrame<T>(
	source: StdinSource,
	fn: (payload: Uint8Array) => Promise<T>,
	options?: StdinBootstrapReadOptions,
): Promise<StdinBootstrapConsumeResult<T>> {
	const result = await readStdinBootstrapFrame(source, options);
	if (!result.ok) {
		return result as StdinBootstrapConsumeResultFail;
	}
	const payload = result.payload;
	try {
		const value = await fn(payload);
		return Object.freeze({ ok: true as const, value });
	} catch {
		return Object.freeze({ ok: false as const, code: "CALLBACK_FAILED" } as const);
	} finally {
		// Always erase payload, even if fn threw
		try {
			if (payload.byteLength > 0) {
				payload.fill(0);
			}
		} catch {
			// best effort
		}
	}
}
