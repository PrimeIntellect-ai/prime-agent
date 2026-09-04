/**
 * Private Home-daemon Bun CLI command runner.
 *
 * Executes argv arrays only. Returns exact frozen result unions, never
 * thrown Error objects.
 *
 * Process capture order (per contract):
 *   1. capture kill → validate function → wire tryKillDirect → cancelRunReady
 *   2. capture exit → capture then once via Reflect → attach observed exitPromise
 *      before stream getters
 *   3. capture stdout/stderr/getReader → validate getReader
 *
 * Uses a shared promise-based cancel signal (no AbortController) to avoid
 * Bun AbortSignal quirks.
 *
 * Cleanup: one boundedSettle deadline for pending operations.
 * Normal exit: no cleanup timer; original op timeout stays active.
 *
 * Hard security: 1 MiB per-stream cap, byte-verified zeroing, fatal UTF-8,
 * fixed frozen exact unions. No casts, assertions, non-null, any, or
 * dynamic imports. No process-group claim.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureCode =
	| "INPUT_INVALID"
	| "SPAWN_FAILED"
	| "ABORTED"
	| "TIMED_OUT"
	| "OUTPUT_OVERFLOW"
	| "STREAM_FAILED"
	| "PROCESS_UNCERTAIN";

export type CommandResult =
	| {
			readonly ok: true;
			readonly value: {
				readonly stdout: string;
				readonly stderr: string;
				readonly exitCode: number;
				readonly durationMs: number;
			};
	  }
	| { readonly ok: false; readonly code: FailureCode };

export interface SpawnedProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(): void;
}

export type SpawnFn = (cmd: string[]) => SpawnedProcess;

export interface CliCommandRunner {
	runCommand(argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ARGC = 1;
const MAX_ARGC = 64;
const MIN_ARG_BYTES = 1;
const MAX_ARG_BYTES = 4096;
const MAX_AGGREGATE_BYTES = 65536;
export const MAX_OUTPUT_BYTES = 1048576;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_CLEANUP_MS = 5000;

// ---------------------------------------------------------------------------
// Default spawn
// ---------------------------------------------------------------------------

declare var Bun: {
	spawn(
		cmd: string[],
		opts: {
			stdin: "ignore" | "pipe";
			stdout: "pipe" | "inherit";
			stderr: "pipe" | "inherit";
			killSignal: number;
			cwd: string;
			env: Readonly<Record<string, string>>;
		},
	): {
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
		exited: Promise<number>;
		kill(signal: number): void;
	};
	version: string;
};

function defaultSpawn(cmd: string[]): SpawnedProcess {
	const p = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		killSignal: 9,
		cwd: "/",
		env: Object.freeze({ PATH: "/usr/bin:/bin" }),
	});
	return {
		stdout: p.stdout,
		stderr: p.stderr,
		exited: p.exited,
		kill() {
			p.kill(9);
		},
	};
}

// ---------------------------------------------------------------------------
// Input validation (wrapped so runCommand never rejects)
// ---------------------------------------------------------------------------

const CONTROL_RE = /[\x00-\x1f\x7f]/;

function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			if (i + 1 >= s.length) return true;
			const n = s.charCodeAt(i + 1);
			if (n < 0xdc00 || n > 0xdfff) return true;
			i += 1;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function readAbortState(signal: AbortSignal): boolean | undefined {
	try {
		return signal.aborted;
	} catch {
		return undefined;
	}
}

function addAbortListener(signal: AbortSignal, listener: () => void): boolean {
	try {
		signal.addEventListener("abort", listener, { once: true });
		return true;
	} catch {
		return false;
	}
}

function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
	if (signal === undefined) return;
	try {
		signal.removeEventListener("abort", listener);
	} catch {
		// The listener target is hostile. Cleanup remains best-effort.
	}
}

function copyValidatedInputs(argv: readonly string[], timeoutMs: number): string[] | undefined {
	if (!(Number.isFinite(timeoutMs) && Number.isSafeInteger(timeoutMs))) return undefined;
	if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return undefined;

	let keys: (string | symbol)[];
	let lengthDescriptor: PropertyDescriptor | undefined;
	try {
		if (!Array.isArray(argv)) return undefined;
		keys = Reflect.ownKeys(argv);
		lengthDescriptor = Object.getOwnPropertyDescriptor(argv, "length");
	} catch {
		return undefined;
	}
	if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return undefined;
	const rawLength: unknown = lengthDescriptor.value;
	if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength)) return undefined;
	if (rawLength < MIN_ARGC || rawLength > MAX_ARGC) return undefined;
	if (keys.length !== rawLength + 1) return undefined;

	const owned: string[] = [];
	let aggregateBytes = 0;
	for (let index = 0; index < rawLength; index++) {
		const key = String(index);
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(argv, key);
		} catch {
			return undefined;
		}
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
		const arg: unknown = descriptor.value;
		if (typeof arg !== "string" || arg.length === 0) return undefined;
		if (CONTROL_RE.test(arg) || hasLoneSurrogate(arg)) return undefined;
		let byteLength: number;
		try {
			byteLength = new TextEncoder().encode(arg).byteLength;
		} catch {
			return undefined;
		}
		if (byteLength < MIN_ARG_BYTES || byteLength > MAX_ARG_BYTES) return undefined;
		aggregateBytes += byteLength;
		if (aggregateBytes > MAX_AGGREGATE_BYTES) return undefined;
		owned.push(arg);
	}
	for (const key of keys) {
		if (key === "length") continue;
		if (typeof key !== "string") return undefined;
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index < 0 || index >= rawLength || String(index) !== key) {
			return undefined;
		}
	}
	return owned;
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

function eraseAndVerify(buf: Uint8Array): void {
	buf.fill(0);
	for (let i = 0; i < buf.byteLength; i++) {
		if (buf[i] !== 0) buf[i] = 0;
	}
}

function clearChunks(sink: Uint8Array[]): void {
	for (const c of sink) eraseAndVerify(c);
	sink.length = 0;
}

// ---------------------------------------------------------------------------
// Merge (wrapped so calling code never throws)
// ---------------------------------------------------------------------------

function mergeChunks(chunks: Uint8Array[]): Uint8Array | undefined {
	try {
		if (chunks.length === 0) return new Uint8Array(0);
		let total = 0;
		for (let i = 0; i < chunks.length; i++) {
			let c: Uint8Array;
			try {
				c = chunks[i];
			} catch {
				return undefined;
			}
			if (!(c instanceof Uint8Array)) return undefined;
			let bl: number;
			try {
				bl = c.byteLength;
			} catch {
				return undefined;
			}
			total += bl;
		}
		const m = new Uint8Array(total);
		let off = 0;
		for (let i = 0; i < chunks.length; i++) {
			let c: Uint8Array;
			try {
				c = chunks[i];
			} catch {
				eraseAndVerify(m);
				return undefined;
			}
			if (!(c instanceof Uint8Array)) {
				eraseAndVerify(m);
				return undefined;
			}
			try {
				m.set(c, off);
				off += c.byteLength;
			} catch {
				eraseAndVerify(m);
				return undefined;
			}
		}
		return m;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Cancel-signal factory (promise-based, no AbortSignal)
// ---------------------------------------------------------------------------

interface CancelHandle {
	readonly promise: Promise<"CANCEL">;
	cancel(): void;
}

function createCancelHandle(): CancelHandle {
	let resolve: (value: "CANCEL") => void = () => {};
	const promise = new Promise<"CANCEL">((r) => {
		resolve = r;
	});
	return {
		promise,
		cancel() {
			resolve("CANCEL");
		},
	};
}

// ---------------------------------------------------------------------------
// Bounded settlement
// ---------------------------------------------------------------------------

function boundedSettle<T>(prom: Promise<T>, deadlineMs: number): Promise<"SETTLED" | "DEADLINE"> {
	let tid: ReturnType<typeof setTimeout>;
	const result = new Promise<"SETTLED" | "DEADLINE">((resolve) => {
		tid = setTimeout(() => resolve("DEADLINE"), deadlineMs);
		prom.then(
			() => {
				clearTimeout(tid);
				resolve("SETTLED");
			},
			() => {
				clearTimeout(tid);
				resolve("SETTLED");
			},
		);
	});
	return result;
}

// ---------------------------------------------------------------------------
// Safe thenable attach — one helper, no casts, Reflect-based

function safeExitThenAttach(value: unknown, onReject: () => void): Promise<number> | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "object" && typeof value !== "function") return undefined;
	const target: object = value;

	let thenFn: unknown;
	try {
		thenFn = Reflect.get(target, "then");
	} catch {
		return undefined;
	}
	if (typeof thenFn !== "function") return undefined;

	let once = false;

	const result = new Promise<number>((resolve) => {
		try {
			Reflect.apply(thenFn, target, [
				(code: unknown) => {
					if (once) return;
					once = true;
					if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) {
						resolve(code);
					} else {
						onReject();
						resolve(-1);
					}
				},
				() => {
					if (once) return;
					once = true;
					onReject();
					resolve(-1);
				},
			]);
		} catch {
			if (once) return;
			once = true;
			onReject();
			resolve(-1);
		}
	});
	result.catch(() => {});
	return result;
}

function captureGetReader(value: unknown): (() => unknown) | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "object" && typeof value !== "function") return undefined;
	const target: object = value;
	let getReader: unknown;
	try {
		getReader = Reflect.get(target, "getReader");
	} catch {
		return undefined;
	}
	if (typeof getReader !== "function") return undefined;
	return (): unknown => Reflect.apply(getReader, target, []);
}

function isExactPlainDataObject(target: object, expectedKeys: readonly string[]): boolean {
	try {
		const prototype: unknown = Object.getPrototypeOf(target);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const keys = Reflect.ownKeys(target);
		if (keys.length !== expectedKeys.length) return false;
		for (const expected of expectedKeys) {
			if (!keys.includes(expected)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(target, expected);
			if (descriptor === undefined || !("value" in descriptor)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPrimeCliCommandRunner(spawn?: SpawnFn, cleanupTimeoutMs?: number): CliCommandRunner {
	const spawnIsValid = spawn === undefined || typeof spawn === "function";
	const cleanupIsValid =
		cleanupTimeoutMs === undefined ||
		(typeof cleanupTimeoutMs === "number" &&
			Number.isFinite(cleanupTimeoutMs) &&
			Number.isSafeInteger(cleanupTimeoutMs) &&
			cleanupTimeoutMs > 0 &&
			cleanupTimeoutMs <= MAX_TIMEOUT_MS);
	const doSpawn: SpawnFn = spawnIsValid && spawn !== undefined ? spawn : defaultSpawn;
	const cleanupMs = cleanupIsValid && cleanupTimeoutMs !== undefined ? cleanupTimeoutMs : DEFAULT_CLEANUP_MS;

	return Object.freeze({
		async runCommand(argv: readonly string[], timeoutMs: number, signal?: AbortSignal) {
			if (!spawnIsValid || !cleanupIsValid) {
				return Object.freeze({ ok: false, code: "INPUT_INVALID" });
			}
			const ownedArgs = copyValidatedInputs(argv, timeoutMs);
			if (ownedArgs === undefined) {
				return Object.freeze({ ok: false, code: "INPUT_INVALID" });
			}

			// ---- shared cancellation machinery ----
			let primaryCode: FailureCode | null = null;
			let killed = false;
			let cancelRunReady = false;
			let callerAborted = false;

			function trySetPrimary(code: FailureCode): boolean {
				if (primaryCode !== null) return false;
				primaryCode = code;
				return true;
			}

			// cancelRun — function declaration hoists
			function cancelRun(code: FailureCode): void {
				if (!trySetPrimary(code)) return;
				cancelNotify();
				tryKillDirect();
			}

			const cancelHandle = createCancelHandle();
			const cancelNotify = cancelHandle.cancel;

			// ---- pre-abort check (before doSpawn, rechecked after listener wiring) ----
			function onAbort(): void {
				callerAborted = true;
				if (cancelRunReady) {
					cancelRun("ABORTED");
				}
			}

			if (signal !== undefined) {
				let isAbortSignal = false;
				try {
					isAbortSignal = signal instanceof AbortSignal;
				} catch {
					return Object.freeze({ ok: false, code: "INPUT_INVALID" });
				}
				if (!isAbortSignal) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
				const initialAbortState = readAbortState(signal);
				if (initialAbortState === undefined) {
					return Object.freeze({ ok: false, code: "INPUT_INVALID" });
				}
				if (initialAbortState) {
					return Object.freeze({ ok: false, code: "ABORTED" });
				}
				if (!addAbortListener(signal, onAbort)) {
					return Object.freeze({ ok: false, code: "INPUT_INVALID" });
				}
				const wiredAbortState = readAbortState(signal);
				if (wiredAbortState === undefined) {
					removeAbortListener(signal, onAbort);
					return Object.freeze({ ok: false, code: "INPUT_INVALID" });
				}
				if (wiredAbortState) callerAborted = true;
			}
			if (callerAborted) {
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "ABORTED" });
			}

			// ---- spawn ----
			let startTime: number;
			try {
				startTime = performance.now();
			} catch {
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}
			if (!Number.isFinite(startTime)) {
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}
			let spawnedValue: unknown;
			try {
				spawnedValue = doSpawn(ownedArgs);
			} catch {
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "SPAWN_FAILED" });
			}
			if (spawnedValue === null || (typeof spawnedValue !== "object" && typeof spawnedValue !== "function")) {
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}
			const procTarget: object = spawnedValue;

			// -----------------------------------------------------------------
			// Step 1: capture kill → validate function → wire tryKillDirect → cancelRunReady
			// -----------------------------------------------------------------

			let procKill: unknown;
			try {
				procKill = Reflect.get(procTarget, "kill");
			} catch {
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}

			if (typeof procKill !== "function") {
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}

			const procKillFn: () => void = () => {
				Reflect.apply(procKill, procTarget, []);
			};

			function tryKillDirect(): void {
				if (killed) return;
				killed = true;
				try {
					procKillFn();
				} catch {
					// kill threw — bounded cleanup will handle
				}
			}

			cancelRunReady = true;

			// ---- recheck after listener wiring (closes pre-abort race) ----
			if (callerAborted) {
				cancelRun("ABORTED");
			}

			// -----------------------------------------------------------------
			// Step 2: capture exit → capture then once via Reflect →
			//         attach observed exitPromise BEFORE stream getters
			// -----------------------------------------------------------------

			let procExitedRaw: unknown;
			try {
				procExitedRaw = Reflect.get(procTarget, "exited");
			} catch {
				tryKillDirect();
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}

			// Attach exit promise IMMEDIATELY (before stream getters).
			// Use the captured raw promise with one Reflect.get then call.
			let exitPromise: Promise<number>;
			const exitAttached = safeExitThenAttach(procExitedRaw, () => {
				cancelRun("PROCESS_UNCERTAIN");
			});
			if (exitAttached === undefined) {
				tryKillDirect();
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}
			exitPromise = exitAttached;

			if (!isExactPlainDataObject(procTarget, ["stdout", "stderr", "exited", "kill"])) {
				tryKillDirect();
				await boundedSettle(exitPromise, cleanupMs);
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
			}

			// -----------------------------------------------------------------
			// Step 3: capture stdout/stderr/getReader → validate getReader
			//         (uses already-observed exitPromise for bounded settle)
			// -----------------------------------------------------------------

			let stdoutValue: unknown;
			let stderrValue: unknown;
			try {
				stdoutValue = Reflect.get(procTarget, "stdout");
				stderrValue = Reflect.get(procTarget, "stderr");
			} catch {
				tryKillDirect();
				const settled = await boundedSettle(exitPromise, cleanupMs);
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({
					ok: false,
					code: settled === "DEADLINE" ? "PROCESS_UNCERTAIN" : "STREAM_FAILED",
				});
			}

			const getStdoutReader = captureGetReader(stdoutValue);
			const getStderrReader = captureGetReader(stderrValue);
			if (getStdoutReader === undefined || getStderrReader === undefined) {
				tryKillDirect();
				const settled = await boundedSettle(exitPromise, cleanupMs);
				cancelNotify();
				removeAbortListener(signal, onAbort);
				return Object.freeze({
					ok: false,
					code: settled === "DEADLINE" ? "PROCESS_UNCERTAIN" : "STREAM_FAILED",
				});
			}

			await Promise.resolve();

			// ---- start readers ----
			const stdoutSink: Uint8Array[] = [];
			const stderrSink: Uint8Array[] = [];
			let mergedStdout: Uint8Array | undefined;
			let mergedStderr: Uint8Array | undefined;

			const reader1 = readStream(getStdoutReader, stdoutSink, cancelHandle, cancelRun).then(
				() => {},
				() => {},
			);
			const reader2 = readStream(getStderrReader, stderrSink, cancelHandle, cancelRun).then(
				() => {},
				() => {},
			);

			let setupElapsed: number;
			try {
				setupElapsed = performance.now() - startTime;
			} catch {
				setupElapsed = Number.NaN;
			}
			const remainingMs = timeoutMs - setupElapsed;
			const timeoutId = setTimeout(() => cancelRun("TIMED_OUT"), Math.max(1, remainingMs));
			if (!Number.isFinite(setupElapsed) || setupElapsed < 0) {
				cancelRun("PROCESS_UNCERTAIN");
			} else if (remainingMs <= 0) {
				cancelRun("TIMED_OUT");
			}

			try {
				const outcome = await Promise.race([
					Promise.all([reader1, reader2]).then((): "READERS" => "READERS"),
					cancelHandle.promise,
				]);

				if (outcome === "CANCEL") {
					clearTimeout(timeoutId);
					const settled = await boundedSettle(Promise.all([reader1, reader2, exitPromise]), cleanupMs);
					if (settled === "DEADLINE") {
						return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
					}
					if (primaryCode === "TIMED_OUT" && callerAborted) {
						return Object.freeze({ ok: false, code: "ABORTED" });
					}
					return Object.freeze({
						ok: false,
						code: primaryCode ?? "PROCESS_UNCERTAIN",
					});
				}

				if (primaryCode !== null) {
					clearTimeout(timeoutId);
					if (!killed) tryKillDirect();
					const settled = await boundedSettle(exitPromise, cleanupMs);
					if (settled === "DEADLINE") {
						return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
					}
					if (primaryCode === "TIMED_OUT" && callerAborted) {
						return Object.freeze({ ok: false, code: "ABORTED" });
					}
					return Object.freeze({ ok: false, code: primaryCode });
				}

				// ---- normal path: readers finished, wait for exit ----
				let exitCode: number;
				try {
					const winner = await Promise.race([exitPromise, cancelHandle.promise]);
					if (winner === "CANCEL") {
						clearTimeout(timeoutId);
						if (!killed) tryKillDirect();
						const settled = await boundedSettle(exitPromise, cleanupMs);
						if (settled === "DEADLINE") {
							return Object.freeze({
								ok: false,
								code: "PROCESS_UNCERTAIN",
							});
						}
						if (primaryCode === "TIMED_OUT" && callerAborted) {
							return Object.freeze({ ok: false, code: "ABORTED" });
						}
						return Object.freeze({
							ok: false,
							code: primaryCode ?? "PROCESS_UNCERTAIN",
						});
					}
					exitCode = winner;
				} catch {
					clearTimeout(timeoutId);
					return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
				}
				clearTimeout(timeoutId);

				if (!(Number.isSafeInteger(exitCode) && exitCode >= 0)) {
					return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
				}

				mergedStdout = mergeChunks(stdoutSink);
				if (mergedStdout === undefined) {
					return Object.freeze({ ok: false, code: "STREAM_FAILED" });
				}
				let stdoutStr: string;
				try {
					stdoutStr = new TextDecoder("utf-8", { fatal: true }).decode(mergedStdout);
				} catch {
					return Object.freeze({ ok: false, code: "STREAM_FAILED" });
				}

				mergedStderr = mergeChunks(stderrSink);
				if (mergedStderr === undefined) {
					return Object.freeze({ ok: false, code: "STREAM_FAILED" });
				}
				let stderrStr: string;
				try {
					stderrStr = new TextDecoder("utf-8", { fatal: true }).decode(mergedStderr);
				} catch {
					return Object.freeze({ ok: false, code: "STREAM_FAILED" });
				}

				const rawDuration = performance.now() - startTime;
				if (!(Number.isFinite(rawDuration) && Number.isSafeInteger(Math.round(rawDuration)) && rawDuration >= 0)) {
					return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
				}
				const safeDurationMs = Math.round(rawDuration);

				return Object.freeze({
					ok: true,
					value: Object.freeze({
						stdout: stdoutStr,
						stderr: stderrStr,
						exitCode,
						durationMs: safeDurationMs,
					}),
				});
			} finally {
				clearTimeout(timeoutId);
				removeAbortListener(signal, onAbort);
				cancelNotify();
				clearChunks(stdoutSink);
				clearChunks(stderrSink);
				if (mergedStdout !== undefined) eraseAndVerify(mergedStdout);
				if (mergedStderr !== undefined) eraseAndVerify(mergedStderr);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Stream reader with guarded cancel (Reflect-based, no casts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Safe observe — wrap a potentially hostile value in an observed settlement
// promise that never throws and never lets hostile getters escape
// ---------------------------------------------------------------------------

function neverSettles(): Promise<void> {
	return new Promise<void>(() => {});
}

function safeObservePromise(raw: unknown): Promise<void> {
	if (raw === null || raw === undefined) return neverSettles();
	if (typeof raw !== "object" && typeof raw !== "function") return neverSettles();
	const target: object = raw;
	let thenFn: unknown;
	try {
		thenFn = Reflect.get(target, "then");
	} catch {
		return neverSettles();
	}
	if (typeof thenFn !== "function") return neverSettles();
	return new Promise<void>((resolve) => {
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		try {
			Reflect.apply(thenFn, target, [settle, settle]);
		} catch {
			if (!settled) return;
		}
	});
}

interface CapturedReader {
	read(): unknown;
	cancel(): unknown;
	release(): void;
}

function captureReader(getReader: () => unknown): CapturedReader | undefined {
	let rawReader: unknown;
	try {
		rawReader = getReader();
	} catch {
		return undefined;
	}
	if (rawReader === null || rawReader === undefined) return undefined;
	if (typeof rawReader !== "object" && typeof rawReader !== "function") return undefined;
	const target: object = rawReader;
	let readMethod: unknown;
	let cancelMethod: unknown;
	let releaseMethod: unknown;
	try {
		readMethod = Reflect.get(target, "read");
		cancelMethod = Reflect.get(target, "cancel");
		releaseMethod = Reflect.get(target, "releaseLock");
	} catch {
		return undefined;
	}
	if (typeof readMethod !== "function" || typeof cancelMethod !== "function") return undefined;
	if (typeof releaseMethod !== "function") return undefined;
	return Object.freeze({
		read: (): unknown => Reflect.apply(readMethod, target, []),
		cancel: (): unknown => Reflect.apply(cancelMethod, target, []),
		release: (): void => {
			Reflect.apply(releaseMethod, target, []);
		},
	});
}

function guardedCancel(cancelReader: () => unknown): Promise<void> {
	let rawResult: unknown;
	try {
		rawResult = cancelReader();
	} catch {
		return Promise.resolve();
	}
	if (rawResult === null || rawResult === undefined) return Promise.resolve();
	if (typeof rawResult !== "object" && typeof rawResult !== "function") return Promise.resolve();
	return safeObservePromise(rawResult);
}

interface DecodedReadResult {
	readonly done: boolean;
	readonly value: unknown;
}

function decodeReadResult(raw: unknown): DecodedReadResult | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	if (!isExactPlainDataObject(raw, ["value", "done"])) return undefined;
	const doneDescriptor = Object.getOwnPropertyDescriptor(raw, "done");
	const valueDescriptor = Object.getOwnPropertyDescriptor(raw, "value");
	if (doneDescriptor === undefined || valueDescriptor === undefined) return undefined;
	if (!("value" in doneDescriptor) || !("value" in valueDescriptor)) return undefined;
	const done: unknown = doneDescriptor.value;
	if (typeof done !== "boolean") return undefined;
	const value: unknown = valueDescriptor.value;
	return Object.freeze({ done, value });
}

async function readStream(
	getReader: () => unknown,
	chunks: Uint8Array[],
	cancelHandle: CancelHandle,
	cancelRun: (code: FailureCode) => void,
): Promise<void> {
	let total = 0;
	const reader = captureReader(getReader);
	if (reader === undefined) {
		cancelRun("STREAM_FAILED");
		return;
	}

	try {
		while (true) {
			let pendingRead: unknown;
			try {
				pendingRead = reader.read();
			} catch {
				cancelRun("STREAM_FAILED");
				await guardedCancel(reader.cancel);
				break;
			}

			let raced: unknown;
			try {
				raced = await Promise.race([pendingRead, cancelHandle.promise]);
			} catch {
				cancelRun("STREAM_FAILED");
				await Promise.all([guardedCancel(reader.cancel), safeObservePromise(pendingRead)]);
				break;
			}
			if (raced === "CANCEL") {
				await Promise.all([guardedCancel(reader.cancel), safeObservePromise(pendingRead)]);
				break;
			}
			const readResult = decodeReadResult(raced);
			if (readResult === undefined) {
				cancelRun("STREAM_FAILED");
				await guardedCancel(reader.cancel);
				break;
			}
			if (readResult.done) break;

			const value = readResult.value;
			if (!(value instanceof Uint8Array)) {
				cancelRun("STREAM_FAILED");
				await guardedCancel(reader.cancel);
				break;
			}
			let valueLength: number;
			try {
				valueLength = value.byteLength;
			} catch {
				cancelRun("STREAM_FAILED");
				await guardedCancel(reader.cancel);
				break;
			}
			const nextTotal = total + valueLength;
			if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_OUTPUT_BYTES) {
				cancelRun("OUTPUT_OVERFLOW");
				await guardedCancel(reader.cancel);
				break;
			}

			const owned = new Uint8Array(valueLength);
			try {
				owned.set(value);
			} catch {
				eraseAndVerify(owned);
				cancelRun("STREAM_FAILED");
				await guardedCancel(reader.cancel);
				break;
			}
			chunks.push(owned);
			total = nextTotal;
		}
	} catch {
		cancelRun("STREAM_FAILED");
		await guardedCancel(reader.cancel);
	} finally {
		try {
			reader.release();
		} catch {
			// The process outcome remains uncertain only when pending work fails to settle.
		}
	}
}
