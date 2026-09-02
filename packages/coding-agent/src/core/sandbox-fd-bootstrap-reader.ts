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

export type ReadResult = { ok: true; payload: Uint8Array } | { ok: false; code: ErrorCode };

export type ConsumeResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

export interface ReadOptions {
	/** Total wall-clock timeout in ms (default 30 000). */
	totalTimeoutMs?: number;
	/** Bounded close-callback confirmation timeout in ms (default 2 000). */
	closeConfirmTimeoutMs?: number;
	/**
	 * Internal/test-only: inject a custom FsFdAdapter.
	 * Enables synthetic delay, never-callback reads/closes, and
	 * deterministic error injection without inspecting raw Error objects.
	 */
	_adapter?: FsFdAdapter;
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
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS = 2_000;
const MAX_PAYLOAD_BYTES = 65_536; // 64 KiB
const HEADER_BYTES = 4;
const TRAILING_BYTES = 1;

const DEFAULT_ADAPTER: FsFdAdapter = { read: fsRead, close: fsClose };

// ---------------------------------------------------------------------------
// Options preflight
// ---------------------------------------------------------------------------

function preflightOptions(raw: unknown): {
	totalTimeoutMs: number;
	closeConfirmTimeoutMs: number;
	adapter: FsFdAdapter;
} | null {
	if (raw === null || raw === undefined) {
		return {
			totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
			closeConfirmTimeoutMs: DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS,
			adapter: DEFAULT_ADAPTER,
		};
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return null;

	const o = raw as Record<string, unknown>;

	// Reject Proxy, getter-heavy, symbols, non-enumerable, unknown keys,
	// cycles by enumerating own keys only.
	let ownKeys: string[];
	try {
		ownKeys = Object.keys(o);
	} catch {
		return null;
	}

	const ALLOWED = new Set(["totalTimeoutMs", "closeConfirmTimeoutMs", "_adapter"]);
	for (const k of ownKeys) {
		if (!ALLOWED.has(k)) return null;
	}

	let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
	if ("totalTimeoutMs" in o) {
		const v = o.totalTimeoutMs;
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
		totalTimeoutMs = v;
	}

	let closeConfirmTimeoutMs = DEFAULT_CLOSE_CONFIRM_TIMEOUT_MS;
	if ("closeConfirmTimeoutMs" in o) {
		const v = o.closeConfirmTimeoutMs;
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
		closeConfirmTimeoutMs = v;
	}

	let adapter = DEFAULT_ADAPTER;
	if ("_adapter" in o) {
		const a = o._adapter;
		if (
			!a ||
			typeof a !== "object" ||
			typeof (a as FsFdAdapter).read !== "function" ||
			typeof (a as FsFdAdapter).close !== "function"
		) {
			return null;
		}
		adapter = a as FsFdAdapter;
	}

	return { totalTimeoutMs, closeConfirmTimeoutMs, adapter };
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
		if (!Number.isSafeInteger(fd) || fd <= 0) {
			resolve({ ok: false, code: "INVALID_FD" });
			return;
		}

		// ---- options preflight -------------------------------------------
		const opts = preflightOptions(options ?? null);
		if (!opts) {
			resolve({ ok: false, code: "INVALID_OPTIONS" });
			return;
		}

		const { totalTimeoutMs, closeConfirmTimeoutMs, adapter } = opts;

		// ---- persistent state --------------------------------------------
		let settled = false;
		let cancelled = false;
		let closeCalled = false;

		// Buffer currently lent to a pending adapter.read().
		// Null when no read is outstanding.
		let pendingReadBuf: Uint8Array | null = null;

		// Intermediate buffers
		const headerBuf = new Uint8Array(HEADER_BYTES);
		let payloadScratch: Uint8Array | null = null;
		const trailingBuf = new Uint8Array(TRAILING_BYTES);
		let freshPayload: Uint8Array | null = null;

		// Accumulated bytes for the current short-read loop
		let accHeader = 0;
		let accPayload = 0;
		let frameLength = 0;

		// Timer references (keep alive — no unref)
		let totalTimer: ReturnType<typeof setTimeout> | null = null;
		let closeConfirmTimer: ReturnType<typeof setTimeout> | null = null;

		// Close-outcome dispatcher, installed by doClose.
		let closeDispatch: ((code: "CLOSE_OK" | "CLOSE_FAILED" | "CLOSE_UNCONFIRMED") => void) | null = null;

		// ---- helpers -----------------------------------------------------

		function erase(buf: Uint8Array | null): void {
			if (buf) buf.fill(0);
		}

		/** Erase every intermediate buffer except the one lent to a pending read. */
		function eraseCleanBuffers(): void {
			if (pendingReadBuf !== headerBuf) erase(headerBuf);
			if (payloadScratch && pendingReadBuf !== payloadScratch) erase(payloadScratch);
			if (pendingReadBuf !== trailingBuf) erase(trailingBuf);
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
			resolve(result);
		}

		// ---- close -------------------------------------------------------

		function doClose(onDone: (code: "CLOSE_OK" | "CLOSE_FAILED" | "CLOSE_UNCONFIRMED") => void): void {
			if (closeCalled) {
				(onDone as (code: string) => void)("INTERNAL");
				return;
			}
			closeCalled = true;
			closeDispatch = onDone;

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

			closeConfirmTimer = setTimeout(() => {
				if (closeDispatch) {
					const d = closeDispatch;
					closeDispatch = null;
					d("CLOSE_UNCONFIRMED");
				}
			}, closeConfirmTimeoutMs);
		}

		// ---- read callback interceptor -----------------------------------

		/**
		 * Called from every adapter.read callback.
		 * Manages buffer lifecycle (erase-on-cancel, erase-on-double-callback),
		 * maps adapter errors to phase codes, and dispatches to the
		 * phase-specific continuation.
		 */
		function onReadDone(
			err: Error | null,
			bytesReadArg: number | undefined,
			phase: "header" | "payload" | "trailing",
			onOk: (bytesRead: number) => void,
		): void {
			const lentBuf = pendingReadBuf;
			pendingReadBuf = null;

			// If lentBuf is null, no read was pending — ignore (double callback).
			if (lentBuf === null) {
				return;
			}

			if (cancelled) {
				erase(lentBuf);
				return;
			}

			if (settled) {
				erase(lentBuf);
				return;
			}

			const bytesRead = typeof bytesReadArg === "number" ? bytesReadArg : 0;

			if (err) {
				const code: ErrorCode =
					phase === "header" ? "READ_HEADER" : phase === "payload" ? "READ_PAYLOAD" : "READ_TRAILING";
				erase(lentBuf);
				doClose((cc) => settle({ ok: false, code: cc === "CLOSE_OK" ? code : cc }));
				return;
			}

			onOk(bytesRead);
		}

		// ---- read schedulers ---------------------------------------------

		function scheduleHeaderRead(): void {
			if (cancelled || settled) return;
			const remaining = HEADER_BYTES - accHeader;
			pendingReadBuf = headerBuf;
			adapter.read(fd, headerBuf, accHeader, remaining, null, (err, br) => {
				onReadDone(err, br, "header", (bytesRead) => {
					accHeader += bytesRead;
					if (accHeader < HEADER_BYTES) {
						scheduleHeaderRead();
					} else {
						onHeaderComplete();
					}
				});
			});
		}

		function schedulePayloadRead(): void {
			if (cancelled || settled) return;
			const remaining = frameLength - accPayload;
			pendingReadBuf = payloadScratch!;
			adapter.read(fd, payloadScratch!, accPayload, remaining, null, (err, br) => {
				onReadDone(err, br, "payload", (bytesRead) => {
					accPayload += bytesRead;
					if (accPayload < frameLength) {
						schedulePayloadRead();
					} else {
						onPayloadComplete();
					}
				});
			});
		}

		function scheduleTrailingRead(): void {
			if (cancelled || settled) return;
			pendingReadBuf = trailingBuf;
			adapter.read(fd, trailingBuf, 0, TRAILING_BYTES, null, (err, br) => {
				onReadDone(err, br, "trailing", (bytesRead) => {
					onTrailingComplete(bytesRead);
				});
			});
		}

		// ---- phase completion handlers -----------------------------------

		function onHeaderComplete(): void {
			frameLength = (headerBuf[0]! << 24) | (headerBuf[1]! << 16) | (headerBuf[2]! << 8) | headerBuf[3]!;

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

			// Exact EOF confirmed
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
	if (!frame.ok) return frame;
	try {
		const value = await consumer(frame.payload);
		return { ok: true, value };
	} catch {
		return { ok: false, code: "INTERNAL" };
	} finally {
		frame.payload.fill(0);
	}
}

// ---------------------------------------------------------------------------
// Testing utilities
// ---------------------------------------------------------------------------

/** Exported for testing: validate options without side effects. */
export function _preflightOptions(raw: unknown): ReturnType<typeof preflightOptions> {
	return preflightOptions(raw);
}
