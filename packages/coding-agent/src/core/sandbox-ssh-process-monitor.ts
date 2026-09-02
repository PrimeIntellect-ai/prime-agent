/**
 * Pure exact SSH process readiness monitor (B14).
 *
 * Watches a bound SSH process (stdout/stderr/exit/close), validates the
 * `PRIME_AGENT_READY <nonce> <pid>\n` handshake, awaits relay admission, and
 * drives a deterministic cleanup sequence (SIGINT → SIGTERM → SIGKILL, then
 * destroyStdio after confirmed close/exit).  All inputs are validated through
 * exact descriptor checks — no Proxy, no accessor, no Symbol, no shared
 * TypedArray, no mismatched prototype.  All output results are frozen.
 *
 * No dynamic imports, no `any`, no sync fs, no child_process spawns.
 */

import { types } from "node:util";

// ─────────────────────────────────────────────────────────────────────────────
// Public API types
// ─────────────────────────────────────────────────────────────────────────────

export type SshMonitorFailureCode =
	| "ADMISSION_ERROR"
	| "ADMISSION_REJECTED"
	| "ADMISSION_TIMEOUT"
	| "CLOSED"
	| "CLEANUP_UNCONFIRMED"
	| "EXIT"
	| "INVALID_CHUNK"
	| "INVALID_INPUT"
	| "INVALID_PID"
	| "LINE_TOO_LONG"
	| "NONCE_MISMATCH"
	| "PROCESS_ERROR"
	| "PROCESS_EVENT"
	| "READY_TIMEOUT"
	| "STDERR"
	| "SUBSCRIBE_REJECTED"
	| "SYNCHRONOUS_OVERFLOW"
	| "TRAILING_DATA";

export type SshMonitorReadyResult =
	| Readonly<{ ok: true; pid: number }>
	| Readonly<{ ok: false; code: SshMonitorFailureCode; cleanupConfirmed: boolean }>;

export type SshMonitorCloseResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: SshMonitorFailureCode; cleanupConfirmed: boolean }>;

export interface SshProcessMonitor {
	readonly ready: Promise<SshMonitorReadyResult>;
	readonly closed: Promise<SshMonitorCloseResult>;
	readonly close: () => Promise<SshMonitorCloseResult>;
}

export type CreateSshProcessMonitorResult =
	| Readonly<{ ok: true; monitor: SshProcessMonitor }>
	| Readonly<{ ok: false; code: "INVALID_INPUT" }>;

export interface SshProcessEventListener {
	readonly onStdout: (raw: unknown) => void;
	readonly onStderr: (raw: unknown) => void;
	readonly onExit: (raw: unknown) => void;
	readonly onClose: () => void;
	readonly onProcessError: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

type BoundProcess = Readonly<{
	subscribe: (listener: SshProcessEventListener) => unknown;
	signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => unknown;
	destroyStdio: () => unknown;
}>;

type BoundInput = Readonly<{
	process: BoundProcess;
	expectedNonce: string;
	confirmRelayAdmission: () => unknown;
	timeouts: Readonly<{
		readyTimeoutMs: number;
		admissionTimeoutMs: number;
		sigintTimeoutMs: number;
		sigtermTimeoutMs: number;
		sigkillTimeoutMs: number;
		closeConfirmTimeoutMs: number;
	}>;
}>;

type OwnedEvent =
	| Readonly<{ type: "stdout"; bytes: Uint8Array }>
	| Readonly<{ type: "stderr" }>
	| Readonly<{ type: "exit"; code: number | null; signal: string | null }>
	| Readonly<{ type: "close" }>
	| Readonly<{ type: "process_error" }>
	| Readonly<{ type: "failure"; code: SshMonitorFailureCode }>;

type Phase = "subscribing" | "reading" | "admission" | "connected" | "cleanup" | "finalizing" | "done";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_KEYS = new Set(["confirmRelayAdmission", "expectedNonce", "process", "timeouts"]);
const PROCESS_KEYS = new Set(["destroyStdio", "signalGroup", "subscribe"]);
const TIMEOUT_KEYS = new Set([
	"admissionTimeoutMs",
	"closeConfirmTimeoutMs",
	"readyTimeoutMs",
	"sigintTimeoutMs",
	"sigkillTimeoutMs",
	"sigtermTimeoutMs",
]);
const SUBSCRIPTION_KEYS = new Set(["status", "unsubscribe"]);
const STATUS_KEYS = new Set(["status"]);
const EXIT_KEYS = new Set(["code", "signal"]);
const READY_PREFIX = "PRIME_AGENT_READY ";
const NONCE_RE = /^[0-9a-f]{32}$/;
const PID_RE = /^(?:[1-9][0-9]{0,9})$/;
const MAX_PID = 2_147_483_647;
const MAX_LINE_BYTES = 256;
const MAX_TOTAL_STDOUT_BYTES = 8192;
const MAX_SYNCHRONOUS_EVENTS = 16;
const MAX_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// Frozen error results
// ─────────────────────────────────────────────────────────────────────────────

const INVALID_INPUT = Object.freeze({ ok: false as const, code: "INVALID_INPUT" });

function readyError(code: SshMonitorFailureCode, cleanupConfirmed: boolean): SshMonitorReadyResult {
	return Object.freeze({ ok: false as const, code, cleanupConfirmed });
}

function closeError(code: SshMonitorFailureCode, cleanupConfirmed: boolean): SshMonitorCloseResult {
	return Object.freeze({ ok: false as const, code, cleanupConfirmed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor-level validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns property descriptors of `raw` iff it is a plain frozen-like object
 * with exactly `keys` own enumerable data properties, no symbols, no Proxy,
 * no accessors, no undefined values.
 */
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

/**
 * Binds a method descriptor value to `owner` via Reflect.apply, rejecting
 * Proxy-wrapped functions.
 */
function bindMethod(
	values: Descriptors,
	owner: object,
	name: string,
): ((...args: readonly unknown[]) => unknown) | null {
	const value = values[name]?.value;
	if (typeof value !== "function") return null;
	try {
		if (types.isProxy(value)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(value as CallableFunction, owner, args);
}

/** Validates a raw timeout value: safe integer, 1..MAX_TIMEOUT_MS. */
function timeout(raw: unknown): number | null {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= MAX_TIMEOUT_MS ? raw : null;
}

/** Extracts a `status` string from an object whose only own key is "status". */
function status(raw: unknown, values: ReadonlySet<string>): string | null {
	const descriptor = exact(raw, STATUS_KEYS)?.status;
	return typeof descriptor?.value === "string" && values.has(descriptor.value) ? descriptor.value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input preflight
// ─────────────────────────────────────────────────────────────────────────────

function preflight(raw: unknown): BoundInput | null {
	const input = exact(raw, INPUT_KEYS);
	const processRaw = input?.process?.value;
	const expectedNonce = input?.expectedNonce?.value;
	const confirmRaw = input?.confirmRelayAdmission?.value;
	const timeoutRaw = input?.timeouts?.value;

	if (
		!input ||
		typeof processRaw !== "object" ||
		processRaw === null ||
		typeof confirmRaw !== "function" ||
		typeof expectedNonce !== "string" ||
		!NONCE_RE.test(expectedNonce)
	)
		return null;
	try {
		if (types.isProxy(confirmRaw)) return null;
	} catch {
		return null;
	}

	const processValues = exact(processRaw, PROCESS_KEYS);
	if (!processValues) return null;

	const subscribe = bindMethod(processValues, processRaw, "subscribe");
	const signalGroup = bindMethod(processValues, processRaw, "signalGroup");
	const destroyStdio = bindMethod(processValues, processRaw, "destroyStdio");
	if (!subscribe || !signalGroup || !destroyStdio) return null;

	const timeoutValues = exact(timeoutRaw, TIMEOUT_KEYS);
	if (!timeoutValues) return null;

	const readyTimeoutMs = timeout(timeoutValues.readyTimeoutMs?.value);
	const admissionTimeoutMs = timeout(timeoutValues.admissionTimeoutMs?.value);
	const sigintTimeoutMs = timeout(timeoutValues.sigintTimeoutMs?.value);
	const sigtermTimeoutMs = timeout(timeoutValues.sigtermTimeoutMs?.value);
	const sigkillTimeoutMs = timeout(timeoutValues.sigkillTimeoutMs?.value);
	const closeConfirmTimeoutMs = timeout(timeoutValues.closeConfirmTimeoutMs?.value);
	if (
		readyTimeoutMs === null ||
		admissionTimeoutMs === null ||
		sigintTimeoutMs === null ||
		sigtermTimeoutMs === null ||
		sigkillTimeoutMs === null ||
		closeConfirmTimeoutMs === null
	)
		return null;

	return Object.freeze({
		process: Object.freeze({
			subscribe: (listener: SshProcessEventListener): unknown => Reflect.apply(subscribe, undefined, [listener]),
			signalGroup: (signal: "SIGINT" | "SIGTERM" | "SIGKILL"): unknown =>
				Reflect.apply(signalGroup, undefined, [signal]),
			destroyStdio: (): unknown => Reflect.apply(destroyStdio, undefined, []),
		}),
		expectedNonce,
		confirmRelayAdmission: (): unknown => Reflect.apply(confirmRaw as CallableFunction, raw, []),
		timeouts: Object.freeze({
			readyTimeoutMs,
			admissionTimeoutMs,
			sigintTimeoutMs,
			sigtermTimeoutMs,
			sigkillTimeoutMs,
			closeConfirmTimeoutMs,
		}),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// TypedArray transfer validation and erasure helpers
// ─────────────────────────────────────────────────────────────────────────────

const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

/** Erase the contents of a typed array (if safely writable). */
function eraseTransferred(raw: unknown): void {
	try {
		if (typeof raw !== "object" || raw === null || types.isProxy(raw) || !BYTE_LENGTH_GETTER) return;
		const length = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		if (length > 0) Uint8Array.prototype.fill.call(raw, 0);
	} catch {
		// Not safely writable.
	}
}

/**
 * Returns true iff `raw` is an *exact* non-shared TypedArray: it owns the
 * full backing ArrayBuffer from byteOffset=0, is not a Proxy, is not a
 * subclass, and has no own buffer/byteLength/byteOffset properties.
 */
function exactTransferred(raw: unknown): raw is Uint8Array {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			!BYTE_LENGTH_GETTER ||
			!BYTE_OFFSET_GETTER ||
			!BUFFER_GETTER ||
			!ARRAY_BUFFER_LENGTH_GETTER
		)
			return false;
		if (
			Object.getOwnPropertyDescriptor(raw, "buffer") ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset")
		)
			return false;
		const length = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		const offset = Reflect.apply(BYTE_OFFSET_GETTER, raw, []) as number;
		const backing = Reflect.apply(BUFFER_GETTER, raw, []) as unknown;
		if (
			typeof backing !== "object" ||
			backing === null ||
			types.isProxy(backing) ||
			Object.getPrototypeOf(backing) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(ARRAY_BUFFER_LENGTH_GETTER, backing, []) as number;
		return length > 0 && offset === 0 && length === backingLength;
	} catch {
		return false;
	}
}

/**
 * Try to take ownership of a transferred chunk: validate it's an exact
 * nonshared TypedArray, then copy it.  Always erase the source on exit.
 */
function takeTransferred(raw: unknown): Uint8Array | null {
	if (!exactTransferred(raw)) {
		eraseTransferred(raw);
		return null;
	}
	try {
		return new Uint8Array(raw);
	} catch {
		return null;
	} finally {
		eraseTransferred(raw);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit event validation
// ─────────────────────────────────────────────────────────────────────────────

function exitEvent(raw: unknown): Readonly<{ code: number | null; signal: string | null }> | null {
	const values = exact(raw, EXIT_KEYS);
	const code = values?.code?.value;
	const signal = values?.signal?.value;
	if (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0 || code > 255))
		return null;
	if (signal !== null && (typeof signal !== "string" || !/^[A-Z][A-Z0-9]{0,31}$/.test(signal))) return null;
	return values ? Object.freeze({ code, signal }) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription unpacking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a subscription object with `status: "subscribed"` and an
 * `unsubscribe` function, return a bound unsubscribe.  Returns null if the
 * object is not a plain frozen-like exact match.
 */
function discoverUnsubscribe(raw: unknown): (() => unknown) | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		const statusDescriptor = Object.getOwnPropertyDescriptor(raw, "status");
		const unsubscribeDescriptor = Object.getOwnPropertyDescriptor(raw, "unsubscribe");
		if (
			!statusDescriptor ||
			!("value" in statusDescriptor) ||
			statusDescriptor.value !== "subscribed" ||
			!unsubscribeDescriptor ||
			!("value" in unsubscribeDescriptor) ||
			typeof unsubscribeDescriptor.value !== "function" ||
			types.isProxy(unsubscribeDescriptor.value)
		)
			return null;
		const unsubscribe = unsubscribeDescriptor.value;
		return (): unknown => Reflect.apply(unsubscribe as CallableFunction, raw, []);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSshProcessMonitor(raw: unknown): CreateSshProcessMonitorResult {
	const input = preflight(raw);
	if (!input) return INVALID_INPUT;

	// ── Internal mutable state ────────────────────────────────────────────

	let phase: Phase = "subscribing";
	let readyPid = 0;
	let stdoutBuffer = new Uint8Array(0);
	let totalStdoutBytes = 0;
	let primaryFailure: SshMonitorFailureCode | null = null;
	let exitObserved = false;
	let closeObserved = false;
	let signalUncertain = false;
	let registrationConfirmed = false;
	let unsubscribe: (() => unknown) | null = null;
	let unsubscribeConsumed = false;
	let destroyConsumed = false;
	let cleanupFinalized = false;
	let stage = 0;

	let readyTimer: ReturnType<typeof setTimeout> | null = null;
	let admissionTimer: ReturnType<typeof setTimeout> | null = null;
	let stageTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let admissionState: 0 | 1 | 2 | 3 = 0; // 0=inactive, 1=active-pending, 2=settled, 3=cancelled

	// Synchronous events collected before subscribe returns.
	const synchronousEvents: OwnedEvent[] = [];
	let synchronousOverflow = false;

	// ── Promise controllers ───────────────────────────────────────────────

	let resolveReady!: (result: SshMonitorReadyResult) => void;
	const ready = new Promise<SshMonitorReadyResult>((resolve) => {
		resolveReady = resolve;
	});
	let readyPending = true;

	let resolveClosed!: (result: SshMonitorCloseResult) => void;
	const closed = new Promise<SshMonitorCloseResult>((resolve) => {
		resolveClosed = resolve;
	});

	// ── Timer helpers ─────────────────────────────────────────────────────

	function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
		if (timer !== null) clearTimeout(timer);
	}

	function clearOperationTimers(): void {
		clearTimer(readyTimer);
		readyTimer = null;
		clearTimer(admissionTimer);
		admissionTimer = null;
		clearTimer(stageTimer);
		stageTimer = null;
		clearTimer(closeTimer);
		closeTimer = null;
	}

	// ── Stdout buffer erasure ─────────────────────────────────────────────

	function eraseStdout(): void {
		stdoutBuffer.fill(0);
		stdoutBuffer = new Uint8Array(0);
	}

	// ── Ready promise failure (idempotent) ────────────────────────────────

	function resolveReadyFailure(cleanupConfirmed: boolean): void {
		if (!readyPending) return;
		readyPending = false;
		resolveReady(readyError(primaryFailure ?? "CLEANUP_UNCONFIRMED", cleanupConfirmed));
	}

	// ── Finish cleanup: destroy stdio, unsubscribe, finalize promises ─────

	function finishCleanup(processConfirmed: boolean): void {
		if (cleanupFinalized) return;
		cleanupFinalized = true;
		phase = "finalizing";
		const admissionPending = admissionState === 1;
		if (admissionState === 1) admissionState = 3;
		clearOperationTimers();
		eraseStdout();

		// Unsubscribe.
		let unsubscribeOk = registrationConfirmed && unsubscribe === null;
		if (unsubscribe !== null && !unsubscribeConsumed) {
			unsubscribeConsumed = true;
			try {
				unsubscribeOk = status(unsubscribe(), new Set(["unsubscribed"])) === "unsubscribed";
			} catch {
				unsubscribeOk = false;
			}
		}

		// Destroy stdio.
		let destroyOk = false;
		if (!destroyConsumed) {
			destroyConsumed = true;
			try {
				destroyOk = status(input.process.destroyStdio(), new Set(["destroyed"])) === "destroyed";
			} catch {
				destroyOk = false;
			}
		}

		const cleanupConfirmed = processConfirmed && !admissionPending && unsubscribeOk && destroyOk && !signalUncertain;

		phase = "done";
		resolveReadyFailure(cleanupConfirmed);

		if (cleanupConfirmed) {
			resolveClosed(Object.freeze({ ok: true as const }));
		} else {
			resolveClosed(closeError("CLEANUP_UNCONFIRMED", false));
		}
	}

	// ── Wait for close event after exit observed ──────────────────────────

	function waitForClose(): void {
		if (phase !== "cleanup") return;
		clearTimer(stageTimer);
		stageTimer = null;
		if (closeObserved) {
			finishCleanup(true);
			return;
		}
		if (closeTimer !== null) return;
		closeTimer = setTimeout(() => {
			closeTimer = null;
			finishCleanup(false);
		}, input.timeouts.closeConfirmTimeoutMs);
	}

	// ── Signal the process group (SIGINT → SIGTERM → SIGKILL) ────────────

	function signalNext(): void {
		if (phase !== "cleanup") return;
		if (exitObserved) {
			waitForClose();
			return;
		}
		if (stage >= 3) {
			finishCleanup(false);
			return;
		}

		const signals = ["SIGINT", "SIGTERM", "SIGKILL"] as const;
		const delays = [
			input.timeouts.sigintTimeoutMs,
			input.timeouts.sigtermTimeoutMs,
			input.timeouts.sigkillTimeoutMs,
		] as const;
		const signal = signals[stage];
		const delay = delays[stage];
		stage += 1;

		try {
			const result = status(input.process.signalGroup(signal), new Set(["sent", "not_found", "error"]));
			if (result === null || result === "error") signalUncertain = true;
		} catch {
			signalUncertain = true;
		}

		if (exitObserved) {
			waitForClose();
			return;
		}

		stageTimer = setTimeout(() => {
			stageTimer = null;
			signalNext();
		}, delay);
	}

	// ── Begin cleanup sequence ────────────────────────────────────────────

	function beginCleanup(code: SshMonitorFailureCode): void {
		if (phase === "done" || phase === "finalizing") return;
		if (primaryFailure === null) primaryFailure = code;
		if (phase === "cleanup") return;
		phase = "cleanup";
		clearTimer(readyTimer);
		readyTimer = null;
		clearTimer(admissionTimer);
		admissionTimer = null;
		if (exitObserved) {
			waitForClose();
		} else {
			signalNext();
		}
	}

	// ── Relay admission ───────────────────────────────────────────────────

	function startAdmission(): void {
		if (phase !== "reading") return;
		phase = "admission";
		clearTimer(readyTimer);
		readyTimer = null;

		admissionTimer = setTimeout(() => {
			admissionTimer = null;
			if (phase === "admission") beginCleanup("ADMISSION_TIMEOUT");
		}, input.timeouts.admissionTimeoutMs);

		let admission: unknown;
		try {
			admission = input.confirmRelayAdmission();
		} catch {
			beginCleanup("ADMISSION_ERROR");
			return;
		}

		try {
			if (
				typeof admission !== "object" ||
				admission === null ||
				types.isProxy(admission) ||
				Object.getPrototypeOf(admission) !== Promise.prototype ||
				Object.getOwnPropertyNames(admission).length !== 0 ||
				Object.getOwnPropertySymbols(admission).length !== 0
			) {
				beginCleanup("ADMISSION_ERROR");
				return;
			}
			admissionState = 1;
			Promise.prototype.then.call(
				admission as Promise<unknown>,
				(result: unknown) => {
					if (admissionState !== 1) return;
					admissionState = 2;
					if (phase !== "admission") return;
					clearTimer(admissionTimer);
					admissionTimer = null;
					if (status(result, new Set(["admitted"])) !== "admitted") {
						beginCleanup(
							status(result, new Set(["rejected"])) === "rejected" ? "ADMISSION_REJECTED" : "ADMISSION_ERROR",
						);
						return;
					}
					phase = "connected";
					if (readyPending) {
						readyPending = false;
						resolveReady(Object.freeze({ ok: true as const, pid: readyPid }));
					}
				},
				() => {
					if (admissionState !== 1) return;
					admissionState = 2;
					if (phase === "admission") beginCleanup("ADMISSION_ERROR");
				},
			);
		} catch {
			beginCleanup("ADMISSION_ERROR");
		}
	}

	// ── Ready line parsing ────────────────────────────────────────────────

	function parseReady(): void {
		if (phase !== "reading") return;

		const newline = stdoutBuffer.indexOf(0x0a);
		if (newline < 0) {
			if (stdoutBuffer.byteLength > MAX_LINE_BYTES) beginCleanup("LINE_TOO_LONG");
			return;
		}
		if (newline > MAX_LINE_BYTES) {
			beginCleanup("LINE_TOO_LONG");
			return;
		}
		if (newline !== stdoutBuffer.byteLength - 1) {
			beginCleanup("TRAILING_DATA");
			return;
		}

		// Decode ASCII portion before the newline.
		let line = "";
		for (let index = 0; index < newline; index += 1) {
			const byte = stdoutBuffer[index];
			if (byte < 0x20 || byte > 0x7e) {
				beginCleanup("TRAILING_DATA");
				return;
			}
			line += String.fromCharCode(byte);
		}
		eraseStdout();

		if (!line.startsWith(READY_PREFIX)) {
			beginCleanup("TRAILING_DATA");
			return;
		}
		const remainder = line.slice(READY_PREFIX.length);
		const separator = remainder.indexOf(" ");
		if (separator < 0 || remainder.indexOf(" ", separator + 1) >= 0) {
			beginCleanup("TRAILING_DATA");
			return;
		}
		const nonce = remainder.slice(0, separator);
		if (!NONCE_RE.test(nonce) || nonce !== input.expectedNonce) {
			beginCleanup("NONCE_MISMATCH");
			return;
		}
		const pidText = remainder.slice(separator + 1);
		if (!PID_RE.test(pidText)) {
			beginCleanup("INVALID_PID");
			return;
		}
		const pid = Number(pidText);
		if (!Number.isSafeInteger(pid) || pid > MAX_PID) {
			beginCleanup("INVALID_PID");
			return;
		}
		readyPid = pid;
		startAdmission();
	}

	// ── Feed an owned (copied, erased-source) stdout chunk ────────────────

	function feedOwned(bytes: Uint8Array): void {
		if (phase !== "reading") {
			bytes.fill(0);
			beginCleanup("TRAILING_DATA");
			return;
		}
		try {
			if (totalStdoutBytes + bytes.byteLength > MAX_TOTAL_STDOUT_BYTES) {
				beginCleanup("LINE_TOO_LONG");
				return;
			}
			const combined = new Uint8Array(stdoutBuffer.byteLength + bytes.byteLength);
			combined.set(stdoutBuffer);
			combined.set(bytes, stdoutBuffer.byteLength);
			stdoutBuffer.fill(0);
			stdoutBuffer = combined;
			totalStdoutBytes += bytes.byteLength;
		} catch {
			beginCleanup("INVALID_CHUNK");
		} finally {
			bytes.fill(0);
		}
		parseReady();
	}

	// ── Queue synchronous events ──────────────────────────────────────────

	function queue(event: OwnedEvent): void {
		if (synchronousEvents.length >= MAX_SYNCHRONOUS_EVENTS) {
			if (event.type === "stdout") event.bytes.fill(0);
			synchronousOverflow = true;
			return;
		}
		synchronousEvents.push(event);
	}

	// ── Event handlers ────────────────────────────────────────────────────

	function handleStdout(rawChunk: unknown): void {
		const bytes = takeTransferred(rawChunk);
		if (!bytes) {
			if (phase === "subscribing") {
				queue(Object.freeze({ type: "failure", code: "INVALID_CHUNK" }));
			} else if (phase !== "done" && phase !== "finalizing") {
				beginCleanup("INVALID_CHUNK");
			}
			return;
		}
		if (phase === "subscribing") {
			queue(Object.freeze({ type: "stdout", bytes }));
		} else if (phase === "cleanup" || phase === "finalizing" || phase === "done") {
			bytes.fill(0);
		} else {
			feedOwned(bytes);
		}
	}

	function handleStderr(rawChunk: unknown): void {
		const bytes = takeTransferred(rawChunk);
		if (bytes) bytes.fill(0);
		const code: SshMonitorFailureCode = bytes ? "STDERR" : "INVALID_CHUNK";
		if (phase === "subscribing") {
			queue(Object.freeze({ type: "failure", code }));
		} else if (phase !== "cleanup" && phase !== "finalizing" && phase !== "done") {
			beginCleanup(code);
		}
	}

	function handleExit(rawEvent: unknown): void {
		const event = exitEvent(rawEvent);
		if (!event) {
			if (phase === "subscribing") {
				queue(Object.freeze({ type: "failure", code: "PROCESS_EVENT" }));
			} else if (phase !== "done" && phase !== "finalizing") {
				beginCleanup("PROCESS_EVENT");
			}
			return;
		}
		if (phase === "subscribing") {
			queue(Object.freeze({ type: "exit", ...event }));
			return;
		}
		exitObserved = true;
		if (phase === "cleanup") {
			clearTimer(stageTimer);
			stageTimer = null;
			waitForClose();
		} else if (phase !== "done" && phase !== "finalizing") {
			beginCleanup("EXIT");
		}
	}

	function handleClose(): void {
		if (phase === "subscribing") {
			queue(Object.freeze({ type: "close" }));
			return;
		}
		closeObserved = true;
		if (phase === "cleanup" && exitObserved) {
			clearTimer(closeTimer);
			closeTimer = null;
			finishCleanup(true);
		} else if (phase !== "cleanup" && phase !== "done" && phase !== "finalizing") {
			beginCleanup("CLOSED");
		}
	}

	function handleProcessError(): void {
		if (phase === "subscribing") {
			queue(Object.freeze({ type: "process_error" }));
		} else if (phase !== "cleanup" && phase !== "done" && phase !== "finalizing") {
			beginCleanup("PROCESS_ERROR");
		}
	}

	const listener = Object.freeze({
		onStdout: handleStdout,
		onStderr: handleStderr,
		onExit: handleExit,
		onClose: handleClose,
		onProcessError: handleProcessError,
	});

	// ── Subscribe ─────────────────────────────────────────────────────────

	let rawSubscription: unknown;
	try {
		rawSubscription = input.process.subscribe(listener);
	} catch {
		// Subscribe threw — backout: scan for validated terminal events before drain.
		phase = "reading";
		registrationConfirmed = false;
		for (const event of synchronousEvents) {
			if (event.type === "exit") {
				exitObserved = true;
			} else if (event.type === "close") {
				closeObserved = true;
			} else if (event.type === "stdout") {
				event.bytes.fill(0);
			}
		}
		synchronousEvents.length = 0;
		beginCleanup("SUBSCRIBE_REJECTED");
		return successMonitor();
	}

	// Examine the subscription result.
	const exactSubscription = exact(rawSubscription, SUBSCRIPTION_KEYS);
	const exactError = exact(rawSubscription, STATUS_KEYS);
	if (
		exactSubscription?.status?.value === "subscribed" &&
		typeof exactSubscription.unsubscribe?.value === "function"
	) {
		unsubscribe = discoverUnsubscribe(rawSubscription);
		registrationConfirmed = unsubscribe !== null;
	} else if (exactError?.status?.value === "error" && synchronousEvents.length === 0) {
		// Error with no synchronous events: registration is confirmed (no events to replay).
		registrationConfirmed = true;
	} else {
		// Invalid or error with queued events — backout.
		unsubscribe = discoverUnsubscribe(rawSubscription);
		registrationConfirmed = false;
	}

	phase = "reading";

	if (!registrationConfirmed || unsubscribe === null || synchronousOverflow) {
		// Backout: scan for validated terminal events before drain.
		for (const event of synchronousEvents) {
			if (event.type === "exit") {
				exitObserved = true;
			} else if (event.type === "close") {
				closeObserved = true;
			} else if (event.type === "stdout") {
				event.bytes.fill(0);
			}
		}
		synchronousEvents.length = 0;
		beginCleanup(synchronousOverflow ? "SYNCHRONOUS_OVERFLOW" : "SUBSCRIBE_REJECTED");
		return successMonitor();
	}

	// Start the ready timer.
	readyTimer = setTimeout(() => {
		readyTimer = null;
		if (phase === "reading") beginCleanup("READY_TIMEOUT");
	}, input.timeouts.readyTimeoutMs);

	// Replay queued synchronous events.
	for (let index = 0; index < synchronousEvents.length; index += 1) {
		const event = synchronousEvents[index];
		if (event.type === "stdout") {
			feedOwned(event.bytes);
		} else if (event.type === "stderr") {
			beginCleanup("STDERR");
		} else if (event.type === "failure") {
			beginCleanup(event.code);
		} else if (event.type === "exit") {
			handleExit(Object.freeze({ code: event.code, signal: event.signal }));
		} else if (event.type === "close") {
			handleClose();
		} else {
			handleProcessError();
		}
		if (phase === "cleanup" || phase === "finalizing" || phase === "done") {
			// Erase any remaining queued chunks.
			for (let rest = index + 1; rest < synchronousEvents.length; rest += 1) {
				const pending = synchronousEvents[rest];
				if (pending.type === "stdout") pending.bytes.fill(0);
			}
			break;
		}
	}
	synchronousEvents.length = 0;

	return successMonitor();

	// ── Build the returned monitor object ─────────────────────────────────

	function successMonitor(): CreateSshProcessMonitorResult {
		const close = (): Promise<SshMonitorCloseResult> => {
			if (phase !== "cleanup" && phase !== "finalizing" && phase !== "done") {
				beginCleanup("CLOSED");
			}
			return closed;
		};
		return Object.freeze({
			ok: true as const,
			monitor: Object.freeze({ ready, closed, close }),
		});
	}
}
