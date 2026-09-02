import { close as fsClose, read as fsRead } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCode =
	| "INVALID_FD"
	| "INVALID_OPTIONS"
	| "TIMEOUT"
	| "CLOSE_FAILED"
	| "CLOSE_UNCONFIRMED"
	| "READ_HEADER"
	| "EMPTY"
	| "OVERSIZE"
	| "READ_PAYLOAD"
	| "TRAILING"
	| "READ_TRAILING"
	| "INTERNAL";

export type ReadResult = Readonly<{ ok: true; payload: Uint8Array }> | Readonly<{ ok: false; code: ErrorCode }>;

export type ConsumeResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: ErrorCode }>;

export interface ReadOptions {
	/** Total wall-clock timeout in ms (default 30 000, bounded 1..120000). */
	readonly totalTimeoutMs?: number;
	/** Bounded close-callback confirmation timeout in ms (default 2 000, bounded 1..10000). */
	readonly closeConfirmTimeoutMs?: number;
	/**
	 * Internal/test-only: inject a custom FsFdAdapter.
	 * Enables synthetic delay, never-callback reads/closes, and
	 * deterministic error injection without inspecting raw Error objects.
	 */
	readonly _adapter?: FsFdAdapter;
}

/**
 * Semantic adapter for the two node:fs operations this module needs.
 * Guards callers from direct err.message / err.code inspection:
 * error is detected solely by whether the callback receives a truthy first
 * argument.
 */
export interface FsFdAdapter {
	read(
		fd: number,
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number | null,
		cb: (err: Error | null, bytesRead: number, buffer: Uint8Array) => void,
	): void;
	close(fd: number, cb: (err: Error | null) => void): void;
}

// ---------------------------------------------------------------------------
// Internal read-token type
// ---------------------------------------------------------------------------

interface ReadToken {
	id: number;
	buf: Uint8Array;
	requested: number;
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS = 2_000;
const MAX_PAYLOAD_BYTES = 65_536; // 64 KiB
const HEADER_BYTES = 4;
const TRAILING_BYTES = 1;
const MAX_SYNC_DEPTH = 128;
const MIN_TOTAL_TIMEOUT_MS = 1;
const MAX_TOTAL_TIMEOUT_MS = 120_000;
const MIN_CLOSE_CONFIRM_TIMEOUT_MS = 1;
const MAX_CLOSE_CONFIRM_TIMEOUT_MS = 10_000;

const DEFAULT_ADAPTER: FsFdAdapter = Object.freeze({ read: fsRead, close: fsClose });

// ---------------------------------------------------------------------------
// Strict options copier
// ---------------------------------------------------------------------------

interface ParsedOptions {
	totalTimeoutMs: number;
	closeConfirmTimeoutMs: number;
	adapter: FsFdAdapter;
}

const OPT_ALLOWED = new Set(["totalTimeoutMs", "closeConfirmTimeoutMs", "_adapter"]);

function copyOptions(raw: unknown): ParsedOptions | null {
	if (raw === null || raw === undefined) {
		return {
			totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
			closeConfirmTimeoutMs: DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS,
			adapter: DEFAULT_ADAPTER,
		};
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return null;

	// Snapshot prototype, descriptors, and symbols in one guarded pass so
	// that a hostile Proxy trap cannot throw past the public Promise boundary.
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

	// Reject non-plain prototype (allow Object.prototype and null-prototype).
	if (proto !== Object.prototype && proto !== null) return null;

	// Reject symbol keys.
	if (ownSymbols.length > 0) return null;

	// Only own enumerable data descriptors permitted.
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

	let closeConfirmTimeoutMs = DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS;
	if ("closeConfirmTimeoutMs" in descs) {
		const v = descs.closeConfirmTimeoutMs.value;
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			!Number.isInteger(v) ||
			v < MIN_CLOSE_CONFIRM_TIMEOUT_MS ||
			v > MAX_CLOSE_CONFIRM_TIMEOUT_MS
		)
			return null;
		closeConfirmTimeoutMs = v;
	}

	let adapter: FsFdAdapter = DEFAULT_ADAPTER;

	// Validate _adapter — snapshot in a second guarded pass.
	if ("_adapter" in descs) {
		const a = descs._adapter.value;
		if (!a || typeof a !== "object") return null;

		let aProto: object | null;
		let aDescs: Record<string, PropertyDescriptor>;
		let aSymbols: symbol[];
		try {
			aProto = Object.getPrototypeOf(a);
			aDescs = Object.getOwnPropertyDescriptors(a);
			aSymbols = Object.getOwnPropertySymbols(a);
		} catch {
			return null;
		}

		if (aProto !== Object.prototype && aProto !== null) return null;
		if (aSymbols.length > 0) return null;

		// Exactly two own enumerable data descriptor keys: read, close.
		const aKeys = Object.keys(aDescs);
		if (aKeys.length !== 2) return null;
		const aKeySet = new Set(aKeys);
		if (!aKeySet.has("read") || !aKeySet.has("close")) return null;

		for (const k of aKeys) {
			const d = aDescs[k];
			if (!d || !d.enumerable || d.get !== undefined || d.set !== undefined || typeof d.value !== "function")
				return null;
		}

		adapter = a as FsFdAdapter;
	}

	return Object.freeze({ totalTimeoutMs, closeConfirmTimeoutMs, adapter });
}

// ---------------------------------------------------------------------------
// readSandboxBootstrapFrame
// ---------------------------------------------------------------------------

/**
 * Read one bootstrap frame from an inherited anonymous fd.
 *
 * Protocol: uint32BE length (big-endian 4 bytes), then payload
 * of exactly that many bytes (1..65536), then EOF with no trailing bytes.
 *
 * The returned `payload` is a fresh caller-owned Uint8Array; all
 * intermediate buffers are zeroed on normal terminal paths.
 *
 * Timeout model: one total wall-clock timeout (default 30 s). On fire,
 * the fd is closed once and the promise settles after a bounded
 * close-confirmation window (default 2 s). Any buffer still owned by
 * a pending fs.read callback is retained without zeroing until its
 * actual callback fires (or never, if the adapter never calls back).
 */
export function readSandboxBootstrapFrame(fd: number, options?: ReadOptions): Promise<ReadResult> {
	return new Promise<ReadResult>((resolve) => {
		// ---- fd preflight ------------------------------------------------
		if (!Number.isSafeInteger(fd) || fd < 3) {
			resolve(Object.freeze({ ok: false, code: "INVALID_FD" }));
			return;
		}

		// ---- strict options copy -----------------------------------------
		const opts = copyOptions(options ?? null);
		if (!opts) {
			resolve(Object.freeze({ ok: false, code: "INVALID_OPTIONS" }));
			return;
		}

		const { totalTimeoutMs, closeConfirmTimeoutMs, adapter } = opts;

		// ---- persistent state --------------------------------------------
		let settled = false;
		let cancelled = false;
		let closeCalled = false;

		// Token of the currently outstanding read, or null.
		let pendingReadToken: ReadToken | null = null;
		let nextReadId = 0;

		// Intermediate buffers
		const headerBuf = new Uint8Array(HEADER_BYTES);
		let payloadScratch: Uint8Array | null = null;
		const trailingBuf = new Uint8Array(TRAILING_BYTES);
		let freshPayload: Uint8Array | null = null;

		// Accumulated bytes
		let accHeader = 0;
		let accPayload = 0;
		let frameLength = 0;

		// Timer references (keep alive — no unref)
		let totalTimer: ReturnType<typeof setTimeout> | null = null;
		let closeConfirmTimer: ReturnType<typeof setTimeout> | null = null;

		// Close-outcome dispatcher, installed by doClose.
		let closeDispatch: ((code: "CLOSE_OK" | "CLOSE_FAILED" | "CLOSE_UNCONFIRMED") => void) | null = null;

		// Synchronous-call-depth guard.
		let syncDepth = 0;

		// ---- helpers -----------------------------------------------------

		function erase(buf: Uint8Array | null): void {
			if (buf) buf.fill(0);
		}

		/** Erase every intermediate buffer except the one behind pendingReadToken. */
		function eraseCleanBuffers(): void {
			if (pendingReadToken === null || pendingReadToken.buf !== headerBuf) erase(headerBuf);
			if (payloadScratch && (pendingReadToken === null || pendingReadToken.buf !== payloadScratch))
				erase(payloadScratch);
			if (pendingReadToken === null || pendingReadToken.buf !== trailingBuf) erase(trailingBuf);
		}

		function clearTimers(): void {
			if (totalTimer !== null) {
				clearTimeout(totalTimer);
				totalTimer = null;
			}
			if (closeConfirmTimer !== null) {
				clearTimeout(closeConfirmTimer);
				closeConfirmTimer = null;
			}
		}

		/** Terminal settle — clears timers, erases non-pending buffers, resolves once. */
		function settle(result: ReadResult): void {
			if (settled) return;
			settled = true;
			clearTimers();
			eraseCleanBuffers();
			// Erase freshPayload for every non-ok result; preserve only for ok success.
			if (!result.ok) {
				erase(freshPayload);
				freshPayload = null;
			}
			resolve(Object.freeze(result));
		}

		// ---- close -------------------------------------------------------

		function doClose(onDone: (code: "CLOSE_OK" | "CLOSE_FAILED" | "CLOSE_UNCONFIRMED") => void): void {
			if (closeCalled) {
				// Double close — silently ignore.
				return;
			}
			closeCalled = true;
			closeDispatch = onDone;

			// Create timer BEFORE calling adapter.close so that a synchronous
			// close callback does not leave an orphan referenced timer.
			closeConfirmTimer = setTimeout(() => {
				if (closeDispatch) {
					const d = closeDispatch;
					closeDispatch = null;
					d("CLOSE_UNCONFIRMED");
				}
			}, closeConfirmTimeoutMs);

			try {
				adapter.close(fd, (err) => {
					if (closeConfirmTimer !== null) {
						clearTimeout(closeConfirmTimer);
						closeConfirmTimer = null;
					}
					if (closeDispatch) {
						const d = closeDispatch;
						closeDispatch = null;
						d(err ? "CLOSE_FAILED" : "CLOSE_OK");
					}
				});
			} catch {
				if (closeConfirmTimer !== null) {
					clearTimeout(closeConfirmTimer);
					closeConfirmTimer = null;
				}
				if (closeDispatch) {
					const d = closeDispatch;
					closeDispatch = null;
					d("CLOSE_FAILED");
				}
			}
		}

		// ---- read callback interceptor -----------------------------------

		/**
		 * Called from every adapter.read callback.
		 * Validates the token matches the active operation.
		 * bytesRead validation:
		 *   - undefined/non-integer/negative/ > requested → phase error
		 *   - 0 READ in header/payload phase → premature EOF → phase error
		 *   - 0 READ in trailing phase → successful EOF (success)
		 * Continuations are deferred with setImmediate when the
		 * synchronous depth exceeds the limit; the deferred callback
		 * re-checks cancelled/settled before running onOk.
		 */
		function onReadCallback(
			token: ReadToken,
			err: Error | null,
			bytesReadArg: number | undefined,
			phase: "header" | "payload" | "trailing",
			onOk: (br: number) => void,
		): void {
			// Stale/double callback: token does not match current operation.
			if (pendingReadToken !== token) {
				return;
			}
			pendingReadToken = null;

			if (cancelled) {
				erase(token.buf);
				return;
			}
			if (settled) {
				erase(token.buf);
				return;
			}

			// Validate bytesRead.
			const isValid =
				typeof bytesReadArg === "number" &&
				Number.isSafeInteger(bytesReadArg) &&
				bytesReadArg >= 0 &&
				bytesReadArg <= token.requested;

			if (err || !isValid) {
				const code: ErrorCode =
					phase === "header" ? "READ_HEADER" : phase === "payload" ? "READ_PAYLOAD" : "READ_TRAILING";
				erase(token.buf);
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? code : cc }));
				return;
			}

			const bytesRead = bytesReadArg;

			// Zero bytes in header or payload phase → premature EOF.
			if (bytesRead === 0 && phase !== "trailing") {
				const code: ErrorCode = phase === "header" ? "READ_HEADER" : "READ_PAYLOAD";
				erase(token.buf);
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? code : cc }));
				return;
			}

			// Defer continuation if sync depth limit exceeded.
			syncDepth++;
			if (syncDepth >= MAX_SYNC_DEPTH) {
				const br = bytesRead;
				syncDepth = 0;
				setImmediate(() => {
					// Re-check settlement/cancellation before continuing.
					if (settled || cancelled) return;
					onOk(br);
				});
			} else {
				onOk(bytesRead);
			}
		}

		// ---- read schedulers ---------------------------------------------

		function startRead(
			buf: Uint8Array,
			offset: number,
			requested: number,
			phase: "header" | "payload" | "trailing",
			onCb: (br: number) => void,
		): void {
			if (cancelled || settled) return;
			const token: ReadToken = { id: nextReadId++, buf, requested };
			pendingReadToken = token;

			try {
				adapter.read(fd, buf, offset, requested, null, (err, br) => {
					onReadCallback(token, err, br, phase, onCb);
				});
			} catch {
				if (pendingReadToken === token) {
					pendingReadToken = null;
				}
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? "INTERNAL" : cc }));
			}
		}

		function scheduleHeaderRead(): void {
			if (cancelled || settled) return;
			const remaining = HEADER_BYTES - accHeader;
			startRead(headerBuf, accHeader, remaining, "header", (bytesRead) => {
				accHeader += bytesRead;
				if (accHeader < HEADER_BYTES) {
					scheduleHeaderRead();
				} else {
					onHeaderComplete();
				}
			});
		}

		function schedulePayloadRead(): void {
			if (cancelled || settled) return;
			const remaining = frameLength - accPayload;
			startRead(payloadScratch!, accPayload, remaining, "payload", (bytesRead) => {
				accPayload += bytesRead;
				if (accPayload < frameLength) {
					schedulePayloadRead();
				} else {
					onPayloadComplete();
				}
			});
		}

		function scheduleTrailingRead(): void {
			if (cancelled || settled) return;
			startRead(trailingBuf, 0, TRAILING_BYTES, "trailing", (bytesRead) => {
				onTrailingComplete(bytesRead);
			});
		}

		// ---- phase completion handlers -----------------------------------

		function onHeaderComplete(): void {
			const view = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
			frameLength = view.getUint32(0, false);

			if (frameLength === 0) {
				erase(headerBuf);
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? "EMPTY" : cc }));
				return;
			}
			if (frameLength > MAX_PAYLOAD_BYTES) {
				erase(headerBuf);
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? "OVERSIZE" : cc }));
				return;
			}

			payloadScratch = new Uint8Array(frameLength);
			accPayload = 0;
			schedulePayloadRead();
		}

		function onPayloadComplete(): void {
			freshPayload = new Uint8Array(payloadScratch!);
			erase(payloadScratch);
			payloadScratch = null;
			scheduleTrailingRead();
		}

		function onTrailingComplete(bytesRead: number): void {
			if (bytesRead > 0) {
				erase(trailingBuf);
				erase(headerBuf);
				erase(freshPayload);
				freshPayload = null;
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? "TRAILING" : cc }));
				return;
			}

			erase(trailingBuf);
			erase(headerBuf);

			doClose((cc) => {
				if (cc === "CLOSE_OK") {
					settle({ ok: true, payload: freshPayload! });
				} else {
					erase(freshPayload);
					freshPayload = null;
					settle({ ok: false, code: cc });
				}
			});
		}

		// ---- total timeout -----------------------------------------------

		totalTimer = setTimeout(() => {
			if (settled) return;
			cancelled = true;

			if (!closeCalled) {
				doClose((cc) => {
					settle({ ok: false, code: cc === "CLOSE_OK" ? "TIMEOUT" : cc });
				});
			} else if (closeDispatch) {
				// Total deadline fires while a normal terminal close is pending.
				// Override the close outcome: TIMEOUT wins (unless close
				// fails or remains unconfirmed).
				closeDispatch = (cc) => {
					settle({ ok: false, code: cc === "CLOSE_OK" ? "TIMEOUT" : cc });
				};
			}
		}, totalTimeoutMs);

		// ---- start -------------------------------------------------------
		scheduleHeaderRead();
	});
}

// ---------------------------------------------------------------------------
// consumeSandboxBootstrapFrame
// ---------------------------------------------------------------------------

/**
 * Read a bootstrap frame, pass the payload to `consumer`, then erase the
 * payload buffer.  If the consumer throws, the exception is caught and
 * converted to a fixed INTERNAL error code (no raw error string escapes).
 */
export async function consumeSandboxBootstrapFrame<T>(
	fd: number,
	consumer: (payload: Uint8Array) => T | Promise<T>,
	options?: ReadOptions,
): Promise<ConsumeResult<T>> {
	const frame = await readSandboxBootstrapFrame(fd, options);
	if (!frame.ok) return Object.freeze(frame);
	try {
		const value = await consumer(frame.payload);
		return Object.freeze({ ok: true, value });
	} catch {
		return Object.freeze({ ok: false, code: "INTERNAL" });
	} finally {
		frame.payload.fill(0);
	}
}
