/**
 * FD3 wrapper composition: Node stdin/stdout adapter + launcher bridge.
 *
 * Production entry: `createSandboxFd3WrapperComposition({readyNonce})` —
 * exactly one field, 32-hex-char nonce.  Creates a Node stdin adapter from
 * process.stdin, snapshots/binds process.stdout.write, wraps
 * startFd3RuntimeLauncher into the bridge launcher protocol, assembles the
 * bridge input, and delegates to createSandboxFd3BootstrapBridge.
 *
 * Returns the exact bridge result — no additional wrapping or synthesis.
 *
 * Mapper adds no timeout.  Bridge owns launch timeout and late result
 * cleanup.  No fire-and-forget cleanup in the wrapper.
 *
 * Publisher accepts only genuine non-Proxy exact-prototype, nonshared,
 * non-detached, nonempty, full-backing Uint8Array.  Rejects symbols and
 * any own name beyond canonical typed-array indexes.  Snapshot original
 * stdout once and bind the prototype write method to it.  Callback state
 * recorded while write is on stack, exact boolean return validated after
 * call, then settled.  Malformed return errors immediately even if
 * callback sync.  Bounded referenced timer.
 *
 * No dynamic imports, no `any`, no casts except `as const`, no non-null
 * assertions, no sync fs, no shell strings, no raw paths/credentials/errors.
 * Production invalid input returns an exact native Promise result (async
 * entry).
 *
 * No CLI wiring yet.
 */

import process from "node:process";
import { types } from "node:util";
import {
	type CreateSandboxFd3BridgeResult,
	createSandboxFd3BootstrapBridge,
	type SandboxFd3BridgeErrorCode,
} from "./sandbox-fd3-bootstrap-bridge.js";
import { startFd3RuntimeLauncher } from "./sandbox-fd3-runtime-launcher.js";
import { createNodeStdinAdapter } from "./sandbox-node-stdin-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INPUT_KEYS: ReadonlySet<string> = Object.freeze(new Set(["readyNonce"]));
const NONCE_RE = /^[0-9a-f]{32}$/;
const FRAME_READ_TIMEOUT_MS = 60_000;
const CREDENTIAL_WRITE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const MONITOR_TIMEOUT_MS = 120_000;
const PUBLISH_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Exact own-key descriptor helpers
// ---------------------------------------------------------------------------

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function bindMethod(
	raw: object,
	descriptors: Descriptors,
	key: string,
): ((...args: readonly unknown[]) => unknown) | null {
	const value = descriptors[key]?.value;
	if (typeof value !== "function") return null;
	try {
		if (types.isProxy(value)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(value, raw, args);
}

function nativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			types.isPromise(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Failure result helper
// ---------------------------------------------------------------------------

function failure(code: SandboxFd3BridgeErrorCode): CreateSandboxFd3BridgeResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

// ---------------------------------------------------------------------------
// TypedArray validation
// ---------------------------------------------------------------------------

const TYPED_ARRAY_PROTO: object = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER: ((this: unknown) => unknown) | undefined = Object.getOwnPropertyDescriptor(
	TYPED_ARRAY_PROTO,
	"byteLength",
)?.get;
const BYTE_OFFSET_GETTER: ((this: unknown) => unknown) | undefined = Object.getOwnPropertyDescriptor(
	TYPED_ARRAY_PROTO,
	"byteOffset",
)?.get;
const BUFFER_GETTER: ((this: unknown) => unknown) | undefined = Object.getOwnPropertyDescriptor(
	TYPED_ARRAY_PROTO,
	"buffer",
)?.get;
const AB_BYTE_LENGTH_GETTER: ((this: unknown) => unknown) | undefined = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get;

function isGenuineFrame(raw: unknown): raw is Uint8Array {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			BYTE_LENGTH_GETTER === undefined ||
			BYTE_OFFSET_GETTER === undefined ||
			BUFFER_GETTER === undefined ||
			AB_BYTE_LENGTH_GETTER === undefined
		)
			return false;
		const ownNames = Object.getOwnPropertyNames(raw);
		const byteLenUnknown = Reflect.apply(BYTE_LENGTH_GETTER, raw, []);
		if (typeof byteLenUnknown !== "number" || !Number.isSafeInteger(byteLenUnknown) || byteLenUnknown < 1)
			return false;
		if (ownNames.length !== byteLenUnknown) return false;
		for (let i = 0; i < byteLenUnknown; i += 1) {
			if (ownNames[i] !== String(i)) return false;
		}
		if (Object.getOwnPropertyDescriptor(raw, "buffer") !== undefined) return false;
		if (Object.getOwnPropertyDescriptor(raw, "byteLength") !== undefined) return false;
		if (Object.getOwnPropertyDescriptor(raw, "byteOffset") !== undefined) return false;
		const offsetUnknown = Reflect.apply(BYTE_OFFSET_GETTER, raw, []);
		if (typeof offsetUnknown !== "number") return false;
		const backing = Reflect.apply(BUFFER_GETTER, raw, []);
		if (
			typeof backing !== "object" ||
			backing === null ||
			types.isProxy(backing) ||
			Object.getPrototypeOf(backing) !== ArrayBuffer.prototype
		)
			return false;
		const backingLengthUnknown = Reflect.apply(AB_BYTE_LENGTH_GETTER, backing, []);
		if (typeof backingLengthUnknown !== "number") return false;
		return offsetUnknown === 0 && byteLenUnknown === backingLengthUnknown;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Monitor validation (mirrors bridge discoverMonitor)
// ---------------------------------------------------------------------------

const MONITOR_KEYS: ReadonlySet<string> = Object.freeze(new Set(["close", "closed", "ready"]));
const MONITOR_FAILURE_CODES: ReadonlySet<string> = Object.freeze(
	new Set([
		"CLOSED",
		"CLEANUP_UNCONFIRMED",
		"EXIT",
		"INVALID_CHUNK",
		"INVALID_INPUT",
		"INVALID_PID",
		"LINE_TOO_LONG",
		"NONCE_MISMATCH",
		"PROCESS_ERROR",
		"PROCESS_EVENT",
		"READY_TIMEOUT",
		"STDERR",
		"SUBSCRIBE_REJECTED",
		"SYNCHRONOUS_OVERFLOW",
		"TRAILING_DATA",
	]),
);

interface OwnedMonitor {
	readonly identity: object;
	readonly ready: Promise<unknown>;
	readonly closed: Promise<unknown>;
	readonly close: (...args: readonly unknown[]) => unknown;
}

function discoverMonitor(raw: unknown): OwnedMonitor | null {
	if (typeof raw !== "object" || raw === null) return null;
	const descriptors = exact(raw, MONITOR_KEYS);
	if (!descriptors) return null;
	const close = bindMethod(raw, descriptors, "close");
	const ready = descriptors.ready?.value;
	const closed = descriptors.closed?.value;
	if (!close || !nativePromise(ready) || !nativePromise(closed)) return null;
	return Object.freeze({ identity: raw, ready, closed, close });
}

// ---------------------------------------------------------------------------
// Observe helper (wraps native Promise with timeout)
// ---------------------------------------------------------------------------

type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "timeout" }>;

function observe(raw: unknown, timeoutMs: number): Promise<Observed> {
	if (!nativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise<Observed>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(Object.freeze({ status: "timeout" as const }));
			}
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "rejected" as const }));
				},
			]);
		} catch {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(Object.freeze({ status: "invalid" as const }));
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Launcher error decoding
// ---------------------------------------------------------------------------

const LAUNCHER_RESULT_OK_KEYS: ReadonlySet<string> = Object.freeze(new Set(["monitor", "ok", "credentialWritable"]));
const LAUNCHER_RESULT_ERROR_KEYS: ReadonlySet<string> = Object.freeze(new Set(["cleanupConfirmed", "code", "ok"]));
const LAUNCHER_FAILURE_CODES: ReadonlySet<string> = Object.freeze(
	new Set(["INVALID_INPUT", "SPAWN_FAILED", "INVALID_CHILD", "MONITOR_FAILED", "STDIN_FAILED"]),
);

function decodeLauncherSuccess(raw: unknown): Readonly<{ monitor: OwnedMonitor; writable: unknown }> | null {
	const descriptors = exact(raw, LAUNCHER_RESULT_OK_KEYS);
	if (!descriptors) return null;
	const okVal = descriptors.ok?.value;
	const monitorRaw = descriptors.monitor?.value;
	const writable = descriptors.credentialWritable?.value;
	if (okVal !== true) return null;
	const monitor = discoverMonitor(monitorRaw);
	if (!monitor) return null;
	return Object.freeze({ monitor, writable });
}

function decodeLauncherError(raw: unknown): Readonly<{ code: "LAUNCH_FAILED" | "CLEANUP_UNCERTAIN" }> | null {
	const descriptors = exact(raw, LAUNCHER_RESULT_ERROR_KEYS);
	if (!descriptors) return null;
	const okVal = descriptors.ok?.value;
	const codeVal = descriptors.code?.value;
	const cleanupVal = descriptors.cleanupConfirmed?.value;
	if (okVal !== false) return null;
	if (typeof codeVal !== "string" || !LAUNCHER_FAILURE_CODES.has(codeVal)) return null;
	if (typeof cleanupVal !== "boolean") return null;
	const code = cleanupVal ? ("LAUNCH_FAILED" as const) : ("CLEANUP_UNCERTAIN" as const);
	return Object.freeze({ code });
}

// ---------------------------------------------------------------------------
// Monitor close with observed timeout
// ---------------------------------------------------------------------------

function closeMonitorChecked(monitor: OwnedMonitor, timeoutMs: number): Promise<boolean> {
	let closeRaw: unknown;
	try {
		closeRaw = monitor.close();
	} catch {
		return Promise.resolve(false);
	}
	return observe(closeRaw, timeoutMs).then((observed: Observed): boolean => {
		if (observed.status !== "fulfilled") return false;
		// Match real Fd3CloseResult: {ok:true} or {ok:false,code,cleanupConfirmed}
		const okExact = exact(observed.value, new Set(["ok"]));
		if (okExact?.ok?.value === true) return true;
		const fullExact = exact(observed.value, new Set(["cleanupConfirmed", "code", "ok"]));
		if (
			fullExact?.ok?.value === false &&
			fullExact.cleanupConfirmed?.value === true &&
			typeof fullExact.code?.value === "string" &&
			MONITOR_FAILURE_CODES.has(fullExact.code.value)
		)
			return true;
		return false;
	});
}

// ---------------------------------------------------------------------------
// Malformed launcher result handler
// ---------------------------------------------------------------------------

function launcherMonitorOwner(raw: unknown): Readonly<{ monitor: OwnedMonitor | null; uncertain: boolean }> {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ monitor: null, uncertain: false });
	let descriptor: PropertyDescriptor | undefined;
	try {
		if (types.isProxy(raw)) return Object.freeze({ monitor: null, uncertain: true });
		descriptor = Object.getOwnPropertyDescriptor(raw, "monitor");
	} catch {
		return Object.freeze({ monitor: null, uncertain: true });
	}
	if (descriptor === undefined) return Object.freeze({ monitor: null, uncertain: false });
	if (!("value" in descriptor) || !descriptor.enumerable) {
		return Object.freeze({ monitor: null, uncertain: true });
	}
	const monitor = discoverMonitor(descriptor.value);
	return monitor ? Object.freeze({ monitor, uncertain: false }) : Object.freeze({ monitor: null, uncertain: true });
}

async function mapLauncherResult(raw: unknown, timeoutMs: number): Promise<unknown> {
	const acquired = launcherMonitorOwner(raw);
	if (acquired.uncertain) {
		return Object.freeze({ status: "error" as const, code: "CLEANUP_UNCERTAIN" as const });
	}
	const success = decodeLauncherSuccess(raw);
	if (success) {
		if (acquired.monitor?.identity !== success.monitor.identity || !validateWritable(success.writable)) {
			const monitor = acquired.monitor ?? success.monitor;
			return closeMonitorCheckedAndMap(monitor, timeoutMs, "LAUNCH_FAILED");
		}
		return Object.freeze({
			status: "started" as const,
			monitor: success.monitor.identity,
			writable: success.writable,
		});
	}
	const error = decodeLauncherError(raw);
	if (error) {
		if (acquired.monitor) return closeMonitorCheckedAndMap(acquired.monitor, timeoutMs, "LAUNCH_FAILED");
		return Object.freeze({ status: "error" as const, code: error.code });
	}
	if (acquired.monitor) return closeMonitorCheckedAndMap(acquired.monitor, timeoutMs, "LAUNCH_FAILED");
	return Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const });
}

// ---------------------------------------------------------------------------
// Stdout write snapshot
// ---------------------------------------------------------------------------

function snapshotWriteMethod(owner: object): ((chunk: Uint8Array, cb: (err?: Error) => void) => boolean) | null {
	let current: object | null = owner;
	for (let depth = 0; current !== null && depth <= 10; depth += 1) {
		try {
			if (types.isProxy(current)) return null;
			const descriptor = Object.getOwnPropertyDescriptor(current, "write");
			if (descriptor) {
				if (!("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value))
					return null;
				return (chunk: Uint8Array, cb: (err?: Error) => void): boolean =>
					Reflect.apply(descriptor.value, owner, [chunk, "utf8", cb]);
			}
			current = Object.getPrototypeOf(current);
		} catch {
			return null;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Publisher factory (single implementation)
// ---------------------------------------------------------------------------

function createPublisher(
	writeCall: (chunk: Uint8Array, cb: (err?: Error) => void) => boolean,
	timeoutMs: number,
): Readonly<{ publish: (frame: Uint8Array) => Promise<unknown> }> {
	return Object.freeze({
		publish(frame: Uint8Array): Promise<unknown> {
			if (!isGenuineFrame(frame)) return Promise.resolve(Object.freeze({ status: "error" as const }));
			return new Promise<unknown>((resolve) => {
				let inWrite = true;
				let callbackSeen = false;
				let callbackError: Error | undefined;
				let settled = false;

				const timer = setTimeout(() => {
					if (!settled) {
						settled = true;
						resolve(Object.freeze({ status: "error" as const }));
					}
				}, timeoutMs);

				const cb = (err?: Error): void => {
					if (callbackSeen) return;
					callbackSeen = true;
					callbackError = err;
					if (!inWrite && !settled) {
						settled = true;
						clearTimeout(timer);
						resolve(
							err
								? Object.freeze({ status: "error" as const })
								: Object.freeze({ status: "published" as const }),
						);
					}
				};

				let ret: unknown;
				try {
					ret = writeCall(frame, cb);
				} catch {
					// Throw dominates — resolve error even if callback fired synchronously
					inWrite = false;
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						// If callback already fired synchronously with success, exception still dominates
						resolve(Object.freeze({ status: "error" as const }));
					}
					return;
				}

				inWrite = false;

				if (typeof ret !== "boolean") {
					// Malformed return — resolve error immediately, even if callback sync
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(Object.freeze({ status: "error" as const }));
					}
					return;
				}

				// If callback already fired while inWrite was true, settle now
				if (callbackSeen && !settled) {
					settled = true;
					clearTimeout(timer);
					resolve(
						callbackError
							? Object.freeze({ status: "error" as const })
							: Object.freeze({ status: "published" as const }),
					);
					return;
				}

				// Callback not yet seen — timer or callback settles
			});
		},
	});
}

// ---------------------------------------------------------------------------
// Launcher wrapper factory
// ---------------------------------------------------------------------------

function createWrapperLauncher(productionNonce: string): Readonly<{
	launch: (request: Readonly<{ readyNonce: string }>) => Promise<unknown>;
}> {
	return Object.freeze({
		launch(request: Readonly<{ readyNonce: string }>): Promise<unknown> {
			const reqDesc = exact(request, new Set(["readyNonce"]));
			if (!reqDesc) {
				return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
			}
			const reqNonce = reqDesc.readyNonce?.value;
			if (reqNonce !== productionNonce) {
				return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
			}

			let launchRaw: unknown;
			try {
				launchRaw = startFd3RuntimeLauncher(request);
			} catch {
				return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
			}

			if (!nativePromise(launchRaw)) {
				return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
			}

			return new Promise<unknown>((resolve) => {
				Reflect.apply(Promise.prototype.then, launchRaw, [
					(value: unknown): void => {
						resolve(mapLauncherResult(value, MONITOR_TIMEOUT_MS));
					},
					(): void => {
						resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
					},
				]);
			});
		},
	});
}

function closeMonitorCheckedAndMap(
	monitor: OwnedMonitor,
	timeoutMs: number,
	baseCode: "LAUNCH_FAILED",
): Promise<unknown> {
	return closeMonitorChecked(monitor, timeoutMs).then((closed: boolean): unknown =>
		Object.freeze({
			status: "error" as const,
			code: closed ? baseCode : ("CLEANUP_UNCERTAIN" as const),
		}),
	);
}

// ---------------------------------------------------------------------------
// Writable validation
// ---------------------------------------------------------------------------

const WRITABLE_KEYS: ReadonlySet<string> = Object.freeze(new Set(["end", "release", "write"]));

function validateWritable(raw: unknown): boolean {
	const descriptors = exact(raw, WRITABLE_KEYS);
	if (!descriptors) return false;
	const write = descriptors.write?.value;
	const release = descriptors.release?.value;
	const end = descriptors.end?.value;
	if (typeof write !== "function" || typeof release !== "function" || typeof end !== "function") return false;
	try {
		if (types.isProxy(write) || types.isProxy(release) || types.isProxy(end)) return false;
	} catch {
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Exact launcher capability (DI path)
// ---------------------------------------------------------------------------

const LAUNCH_CAP_KEYS: ReadonlySet<string> = Object.freeze(new Set(["launch"]));

function validateLaunchCap(raw: unknown): ((request: Readonly<{ readyNonce: string }>) => unknown) | null {
	const descriptors = exact(raw, LAUNCH_CAP_KEYS);
	if (!descriptors) return null;
	const launch = descriptors.launch?.value;
	if (typeof launch !== "function") return null;
	try {
		if (types.isProxy(launch)) return null;
	} catch {
		return null;
	}
	return (request: Readonly<{ readyNonce: string }>): unknown => Reflect.apply(launch, raw, [request]);
}

// ---------------------------------------------------------------------------
// DI factory
// ---------------------------------------------------------------------------

export interface Fd3WrapperCompositionDeps {
	readonly readyNonce: string;
	readonly stdin: unknown;
	readonly stdout: object;
	readonly launcher: Readonly<{ launch: (request: Readonly<{ readyNonce: string }>) => Promise<unknown> }>;
	readonly timeouts: Readonly<{
		frameReadTimeoutMs: number;
		credentialWriteTimeoutMs: number;
		launchTimeoutMs: number;
		monitorTimeoutMs: number;
		publishTimeoutMs: number;
	}>;
}

const DEP_KEYS: ReadonlySet<string> = Object.freeze(new Set(["readyNonce", "stdin", "stdout", "launcher", "timeouts"]));
const TIMEOUT_KEYS: ReadonlySet<string> = Object.freeze(
	new Set([
		"frameReadTimeoutMs",
		"credentialWriteTimeoutMs",
		"launchTimeoutMs",
		"monitorTimeoutMs",
		"publishTimeoutMs",
	]),
);

export async function createSandboxFd3WrapperCompositionWithDeps(raw: unknown): Promise<CreateSandboxFd3BridgeResult> {
	const descriptors = exact(raw, DEP_KEYS);
	if (!descriptors) return failure("INPUT_INVALID");

	const readyNonceVal = descriptors.readyNonce?.value;
	const stdinRaw = descriptors.stdin?.value;
	const stdoutRaw = descriptors.stdout?.value;
	const launcherRaw = descriptors.launcher?.value;
	const timeoutsRaw = descriptors.timeouts?.value;

	if (
		typeof readyNonceVal !== "string" ||
		!NONCE_RE.test(readyNonceVal) ||
		typeof stdinRaw !== "object" ||
		stdinRaw === null ||
		typeof stdoutRaw !== "object" ||
		stdoutRaw === null ||
		typeof launcherRaw !== "object" ||
		launcherRaw === null
	) {
		return failure("INPUT_INVALID");
	}
	const readyNonce: string = readyNonceVal;

	// Validate timeouts as exact typed literal
	const timeoutDesc = exact(timeoutsRaw, TIMEOUT_KEYS);
	if (!timeoutDesc) return failure("INPUT_INVALID");
	const frameReadTimeoutMsV = timeoutDesc.frameReadTimeoutMs?.value;
	const credentialWriteTimeoutMsV = timeoutDesc.credentialWriteTimeoutMs?.value;
	const launchTimeoutMsV = timeoutDesc.launchTimeoutMs?.value;
	const monitorTimeoutMsV = timeoutDesc.monitorTimeoutMs?.value;
	const publishTimeoutMsV = timeoutDesc.publishTimeoutMs?.value;
	if (
		typeof frameReadTimeoutMsV !== "number" ||
		!Number.isSafeInteger(frameReadTimeoutMsV) ||
		frameReadTimeoutMsV < 1 ||
		frameReadTimeoutMsV > MAX_TIMEOUT_MS ||
		typeof credentialWriteTimeoutMsV !== "number" ||
		!Number.isSafeInteger(credentialWriteTimeoutMsV) ||
		credentialWriteTimeoutMsV < 1 ||
		credentialWriteTimeoutMsV > MAX_TIMEOUT_MS ||
		typeof launchTimeoutMsV !== "number" ||
		!Number.isSafeInteger(launchTimeoutMsV) ||
		launchTimeoutMsV < 1 ||
		launchTimeoutMsV > MAX_TIMEOUT_MS ||
		typeof monitorTimeoutMsV !== "number" ||
		!Number.isSafeInteger(monitorTimeoutMsV) ||
		monitorTimeoutMsV < 1 ||
		monitorTimeoutMsV > MAX_TIMEOUT_MS ||
		typeof publishTimeoutMsV !== "number" ||
		!Number.isSafeInteger(publishTimeoutMsV) ||
		publishTimeoutMsV < 1 ||
		publishTimeoutMsV > MAX_TIMEOUT_MS
	) {
		return failure("INPUT_INVALID");
	}

	// Validate launcher is an exact {launch} capability
	const launchCall = validateLaunchCap(launcherRaw);
	if (!launchCall) return failure("INPUT_INVALID");

	// Create stdin adapter
	const stdinResult = createNodeStdinAdapter(stdinRaw);
	if (!stdinResult.ok) return failure("INPUT_INVALID");
	const stdinSource = stdinResult.source;

	// Create publisher from injected stdout
	const stdoutWrite = snapshotWriteMethod(stdoutRaw);
	if (!stdoutWrite) return failure("INPUT_INVALID");
	const publisher = createPublisher(stdoutWrite, publishTimeoutMsV);

	// Create launcher wrapper
	const launcherCap: Readonly<{ launch: (request: Readonly<{ readyNonce: string }>) => Promise<unknown> }> =
		Object.freeze({
			launch(request: Readonly<{ readyNonce: string }>): Promise<unknown> {
				const reqDesc = exact(request, new Set(["readyNonce"]));
				if (!reqDesc) {
					return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
				}
				const reqNonce = reqDesc.readyNonce?.value;
				if (reqNonce !== readyNonce) {
					return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
				}

				let resultRaw: unknown;
				try {
					resultRaw = launchCall(request);
				} catch {
					return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
				}
				if (!nativePromise(resultRaw)) {
					return Promise.resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
				}
				return new Promise<unknown>((resolve) => {
					Reflect.apply(Promise.prototype.then, resultRaw, [
						(value: unknown): void => {
							resolve(mapLauncherResult(value, monitorTimeoutMsV));
						},
						(): void => {
							resolve(Object.freeze({ status: "error" as const, code: "LAUNCH_FAILED" as const }));
						},
					]);
				});
			},
		});

	// Assemble bridge input
	const bridgeInput = Object.freeze({
		stdinSource,
		launcher: launcherCap,
		publisher,
		readyNonce,
		timeouts: Object.freeze({
			frameReadTimeoutMs: frameReadTimeoutMsV,
			credentialWriteTimeoutMs: credentialWriteTimeoutMsV,
			launchTimeoutMs: launchTimeoutMsV,
			monitorTimeoutMs: monitorTimeoutMsV,
			publishTimeoutMs: publishTimeoutMsV,
		}),
	});

	return createSandboxFd3BootstrapBridge(bridgeInput);
}

// ---------------------------------------------------------------------------
// Production entry
// ---------------------------------------------------------------------------

export async function createSandboxFd3WrapperComposition(raw: unknown): Promise<CreateSandboxFd3BridgeResult> {
	const descriptors = exact(raw, INPUT_KEYS);
	if (!descriptors) return failure("INPUT_INVALID");
	const readyNonce = descriptors.readyNonce.value;
	if (typeof readyNonce !== "string" || !NONCE_RE.test(readyNonce)) return failure("INPUT_INVALID");

	// Create publisher backed by stdout write — fail early if stdout is invalid
	const stdoutWrite = snapshotWriteMethod(process.stdout);
	if (!stdoutWrite) return failure("INPUT_INVALID");

	// Create Node stdin adapter
	const stdinResult = createNodeStdinAdapter(process.stdin);
	if (!stdinResult.ok) return failure("INPUT_INVALID");

	// Create launcher that wraps startFd3RuntimeLauncher
	const launcher = createWrapperLauncher(readyNonce);
	const publisher = createPublisher(stdoutWrite, PUBLISH_TIMEOUT_MS);

	// Assemble bridge input
	const bridgeInput = Object.freeze({
		stdinSource: stdinResult.source,
		launcher,
		publisher,
		readyNonce,
		timeouts: Object.freeze({
			frameReadTimeoutMs: FRAME_READ_TIMEOUT_MS,
			credentialWriteTimeoutMs: CREDENTIAL_WRITE_TIMEOUT_MS,
			launchTimeoutMs: LAUNCH_TIMEOUT_MS,
			monitorTimeoutMs: MONITOR_TIMEOUT_MS,
			publishTimeoutMs: PUBLISH_TIMEOUT_MS,
		}),
	});

	return createSandboxFd3BootstrapBridge(bridgeInput);
}
