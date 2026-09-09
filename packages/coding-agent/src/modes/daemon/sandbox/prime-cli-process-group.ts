import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { types } from "node:util";
import { readAbortState as signalState } from "./prime-sandbox-validation.js";

const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 8_192;
const MAX_TOTAL_ARG_BYTES = 65_536;
const MAX_ENV_KEYS = 16;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_CHUNKS = 1_024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 1_000;
const GROUP_CHECK_MS = 10;
const LOCK_READY = 0x4c;

export type PrimeCliProcessFailureCode =
	| "INPUT_INVALID"
	| "SPAWN_FAILED"
	| "ABORTED"
	| "TIMED_OUT"
	| "OUTPUT_OVERFLOW"
	| "STREAM_FAILED"
	| "DESCENDANTS_FOUND"
	| "PROCESS_UNCERTAIN";

export type PrimeCliProcessResult =
	| Readonly<{
			ok: true;
			value: Readonly<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;
	  }>
	| Readonly<{ ok: false; code: PrimeCliProcessFailureCode }>;

function failure(code: PrimeCliProcessFailureCode): Readonly<{ ok: false; code: PrimeCliProcessFailureCode }> {
	return Object.freeze({ ok: false, code });
}

function success(stdout: string, stderr: string, exitCode: number, durationMs: number): PrimeCliProcessResult {
	return Object.freeze({ ok: true, value: Object.freeze({ stdout, stderr, exitCode, durationMs }) });
}

function exactString(value: unknown, maxBytes: number): value is string {
	if (typeof value !== "string" || value.length < 1) return false;
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit <= 0x7f) bytes += 1;
		else if (unit <= 0x7ff) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
		else bytes += 3;
		if (bytes > maxBytes) return false;
	}
	return true;
}

function copyArgv(value: unknown): string[] | undefined {
	try {
		if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
			return undefined;
		const length = value.length;
		if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ARG_COUNT) return undefined;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== length + 1 || keys[length] !== "length") return undefined;
		const result: string[] = [];
		let total = 0;
		for (let index = 0; index < length; index += 1) {
			if (keys[index] !== String(index)) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor === undefined || !("value" in descriptor) || !exactString(descriptor.value, MAX_ARG_BYTES)) {
				return undefined;
			}
			total += new TextEncoder().encode(descriptor.value).byteLength;
			if (total > MAX_TOTAL_ARG_BYTES) return undefined;
			result.push(descriptor.value);
		}
		if (result[0].charCodeAt(0) !== 0x2f) return undefined;
		return result;
	} catch {
		return undefined;
	}
}

function copyEnvironment(value: unknown): Record<string, string> | undefined {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			types.isProxy(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.getOwnPropertySymbols(value).length !== 0
		) {
			return undefined;
		}
		const keys = Object.keys(value);
		if (keys.length > MAX_ENV_KEYS) return undefined;
		const result: Record<string, string> = {};
		for (const key of keys) {
			if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor) || !exactString(descriptor.value, 8_192)) {
				return undefined;
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, "code");
		return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
			? descriptor.value
			: undefined;
	} catch {
		return undefined;
	}
}

function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (caught) {
		return errorCode(caught) !== "ESRCH";
	}
}

async function waitGroupAbsent(pgid: number, timeoutMs: number): Promise<boolean> {
	const checks = Math.ceil(timeoutMs / GROUP_CHECK_MS);
	for (let index = 0; index < checks; index += 1) {
		if (!groupExists(pgid)) return true;
		await delay(GROUP_CHECK_MS);
	}
	return !groupExists(pgid);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Absence is confirmed separately.
	}
}

interface ChildClose {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function childClosePromise(child: ChildProcess): Promise<ChildClose> {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => resolve(Object.freeze({ code, signal })));
	});
}

async function closeSettled(closed: Promise<ChildClose>, timeoutMs: number): Promise<boolean> {
	return await Promise.race([closed.then(() => true).catch(() => false), delay(timeoutMs).then(() => false)]);
}

async function settleGroup(pgid: number, closed: Promise<ChildClose>): Promise<boolean> {
	signalGroup(pgid, "SIGTERM");
	await Promise.race([closed, delay(TERM_GRACE_MS)]);
	if (await waitGroupAbsent(pgid, TERM_GRACE_MS)) return await closeSettled(closed, TERM_GRACE_MS);
	signalGroup(pgid, "SIGKILL");
	await Promise.race([closed, delay(KILL_GRACE_MS)]);
	if (!(await waitGroupAbsent(pgid, KILL_GRACE_MS))) return false;
	return await closeSettled(closed, KILL_GRACE_MS);
}

function mergeAndZero(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
		chunk.fill(0);
	}
	chunks.length = 0;
	return result;
}

function zeroChunks(chunks: Uint8Array[]): void {
	for (const chunk of chunks) chunk.fill(0);
	chunks.length = 0;
}

type ProcessOutcome =
	| Readonly<{ kind: "CLOSED"; close: ChildClose }>
	| Readonly<{ kind: "SPAWN_FAILED" }>
	| Readonly<{ kind: "ABORTED" }>
	| Readonly<{ kind: "TIMED_OUT" }>
	| Readonly<{ kind: "OUTPUT_OVERFLOW" }>
	| Readonly<{ kind: "STREAM_FAILED" }>;

export async function runPrimeCliProcess(
	argvValue: unknown,
	environmentValue: unknown,
	cwdValue: unknown,
	timeoutValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeCliProcessResult> {
	const argv = copyArgv(argvValue);
	const environment = copyEnvironment(environmentValue);
	const initialSignal = signalState(signal);
	if (
		argv === undefined ||
		environment === undefined ||
		typeof cwdValue !== "string" ||
		!exactString(cwdValue, MAX_ARG_BYTES) ||
		cwdValue.charCodeAt(0) !== 0x2f ||
		typeof timeoutValue !== "number" ||
		!Number.isSafeInteger(timeoutValue) ||
		timeoutValue < MIN_TIMEOUT_MS ||
		timeoutValue > MAX_TIMEOUT_MS ||
		initialSignal === undefined
	) {
		return failure("INPUT_INVALID");
	}
	if (initialSignal) return failure("ABORTED");
	if (process.platform !== "darwin" && process.platform !== "linux") return failure("INPUT_INVALID");
	const startedAt = performance.now();
	let child: ChildProcess;
	try {
		child = spawn(argv[0], argv.slice(1), {
			cwd: cwdValue,
			env: environment,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return failure("SPAWN_FAILED");
	}
	const pid = child.pid;
	const stdout = child.stdout;
	const stderr = child.stderr;
	const closed = childClosePromise(child);
	if (pid === undefined || stdout === null || stderr === null) {
		if (pid !== undefined) await settleGroup(pid, closed);
		return failure("SPAWN_FAILED");
	}
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let stdoutCount = 0;
	let stderrCount = 0;
	let settled = false;
	let resolveOutcome: ((outcome: ProcessOutcome) => void) | undefined;
	const outcome = new Promise<ProcessOutcome>((resolve) => {
		resolveOutcome = resolve;
	});
	const finish = (value: ProcessOutcome): void => {
		if (settled) return;
		settled = true;
		resolveOutcome?.(value);
	};
	const append = (target: Uint8Array[], chunk: Buffer, stdoutTarget: boolean): void => {
		const nextBytes = (stdoutTarget ? stdoutBytes : stderrBytes) + chunk.byteLength;
		const nextCount = (stdoutTarget ? stdoutCount : stderrCount) + 1;
		if (nextBytes > MAX_OUTPUT_BYTES || nextCount > MAX_OUTPUT_CHUNKS) {
			finish(Object.freeze({ kind: "OUTPUT_OVERFLOW" }));
			return;
		}
		const copied = new Uint8Array(new ArrayBuffer(chunk.byteLength));
		copied.set(chunk);
		target.push(copied);
		if (stdoutTarget) {
			stdoutBytes = nextBytes;
			stdoutCount = nextCount;
		} else {
			stderrBytes = nextBytes;
			stderrCount = nextCount;
		}
	};
	stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk, true));
	stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk, false));
	stdout.once("error", () => finish(Object.freeze({ kind: "STREAM_FAILED" })));
	stderr.once("error", () => finish(Object.freeze({ kind: "STREAM_FAILED" })));
	child.once("error", () => finish(Object.freeze({ kind: "SPAWN_FAILED" })));
	closed
		.then((close) => finish(Object.freeze({ kind: "CLOSED", close })))
		.catch(() => finish(Object.freeze({ kind: "SPAWN_FAILED" })));
	const timer = setTimeout(() => finish(Object.freeze({ kind: "TIMED_OUT" })), timeoutValue);
	const abortHandler = (): void => finish(Object.freeze({ kind: "ABORTED" }));
	if (signal !== undefined) {
		try {
			signal.addEventListener("abort", abortHandler, { once: true });
			if (signal.aborted) finish(Object.freeze({ kind: "ABORTED" }));
		} catch {
			finish(Object.freeze({ kind: "SPAWN_FAILED" }));
		}
	}
	const completed = await outcome;
	clearTimeout(timer);
	if (signal !== undefined) {
		try {
			signal.removeEventListener("abort", abortHandler);
		} catch {
			// The native process is still settled below.
		}
	}
	if (completed.kind !== "CLOSED") {
		const certain = await settleGroup(pid, closed);
		zeroChunks(stdoutChunks);
		zeroChunks(stderrChunks);
		if (!certain) return failure("PROCESS_UNCERTAIN");
		return failure(completed.kind);
	}
	if (groupExists(pid)) {
		const certain = await settleGroup(pid, closed);
		zeroChunks(stdoutChunks);
		zeroChunks(stderrChunks);
		return failure(certain ? "DESCENDANTS_FOUND" : "PROCESS_UNCERTAIN");
	}
	if (completed.close.code === null || completed.close.signal !== null) {
		zeroChunks(stdoutChunks);
		zeroChunks(stderrChunks);
		return failure("SPAWN_FAILED");
	}
	const stdoutBytesValue = mergeAndZero(stdoutChunks, stdoutBytes);
	const stderrBytesValue = mergeAndZero(stderrChunks, stderrBytes);
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const durationMs = Math.max(0, Math.floor(performance.now() - startedAt));
		return success(
			decoder.decode(stdoutBytesValue),
			decoder.decode(stderrBytesValue),
			completed.close.code,
			durationMs,
		);
	} catch {
		return failure("STREAM_FAILED");
	} finally {
		stdoutBytesValue.fill(0);
		stderrBytesValue.fill(0);
	}
}

function copyTrailingArguments(value: unknown): string[] | undefined {
	try {
		if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
			return undefined;
		const length = value.length;
		if (!Number.isSafeInteger(length) || length < 0 || length >= MAX_ARG_COUNT) return undefined;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== length + 1 || keys[length] !== "length") return undefined;
		const result: string[] = [];
		let total = 0;
		for (let index = 0; index < length; index += 1) {
			if (keys[index] !== String(index)) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor === undefined || !("value" in descriptor) || !exactString(descriptor.value, MAX_ARG_BYTES)) {
				return undefined;
			}
			total += new TextEncoder().encode(descriptor.value).byteLength;
			if (total > MAX_TOTAL_ARG_BYTES) return undefined;
			result.push(descriptor.value);
		}
		return result;
	} catch {
		return undefined;
	}
}

export async function runPrimeCliReplacingExecutable(
	actualExecutableValue: unknown,
	expectedExecutableValue: unknown,
	argvValue: unknown,
	environmentValue: unknown,
	cwdValue: unknown,
	timeoutValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeCliProcessResult> {
	const argv = copyArgv(argvValue);
	if (
		typeof actualExecutableValue !== "string" ||
		!exactString(actualExecutableValue, MAX_ARG_BYTES) ||
		actualExecutableValue.charCodeAt(0) !== 0x2f ||
		typeof expectedExecutableValue !== "string" ||
		argv === undefined ||
		argv[0] !== expectedExecutableValue
	) {
		return failure("INPUT_INVALID");
	}
	return await runPrimeCliProcess(
		[actualExecutableValue, ...argv.slice(1)],
		environmentValue,
		cwdValue,
		timeoutValue,
		signal,
	);
}

export async function runPrimeCliExecutable(
	executableValue: unknown,
	argumentsValue: unknown,
	environmentValue: unknown,
	cwdValue: unknown,
	timeoutValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeCliProcessResult> {
	const copiedArguments = copyTrailingArguments(argumentsValue);
	if (
		typeof executableValue !== "string" ||
		!exactString(executableValue, MAX_ARG_BYTES) ||
		executableValue.charCodeAt(0) !== 0x2f ||
		copiedArguments === undefined
	) {
		return failure("INPUT_INVALID");
	}
	return await runPrimeCliProcess(
		[executableValue, ...copiedArguments],
		environmentValue,
		cwdValue,
		timeoutValue,
		signal,
	);
}

const LOCK_SCRIPT = [
	"import fcntl, os, stat, sys",
	"path = sys.argv[1]",
	"flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)",
	"fd = os.open(path, flags, 0o600)",
	"try:",
	"    s = os.fstat(fd)",
	"    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600: raise SystemExit(91)",
	"    fcntl.flock(fd, fcntl.LOCK_EX)",
	"    s = os.fstat(fd)",
	"    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600: raise SystemExit(91)",
	"    sys.stdout.buffer.write(b'L')",
	"    sys.stdout.buffer.flush()",
	"    sys.stdin.buffer.read(1)",
	"finally:",
	"    os.close(fd)",
].join("\n");
const LOCK_COMMAND = `import base64;exec(base64.b64decode('${Buffer.from(LOCK_SCRIPT).toString("base64")}'))`;

interface LockState {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly closed: Promise<ChildClose>;
	failed: boolean;
	released: boolean;
}

export class PrimeCliProvisioningLock {
	constructor(token: object) {
		if (token !== LOCK_ISSUE) throw new Error();
		Object.freeze(this);
	}
}

const LOCK_ISSUE = Object.freeze({});
const locks = new WeakMap<object, LockState>();
Object.freeze(PrimeCliProvisioningLock.prototype);
Object.freeze(PrimeCliProvisioningLock);

export type PrimeCliLockResult =
	| Readonly<{ ok: true; value: PrimeCliProvisioningLock }>
	| Readonly<{ ok: false; code: PrimeCliProcessFailureCode | "LOCK_FAILED" }>;

export async function acquirePrimeCliProvisioningLock(
	pythonValue: unknown,
	lockPathValue: unknown,
	environmentValue: unknown,
	timeoutValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeCliLockResult> {
	const argv = copyArgv(
		typeof pythonValue === "string" && typeof lockPathValue === "string"
			? [pythonValue, "-I", "-S", "-c", LOCK_COMMAND, lockPathValue]
			: undefined,
	);
	const environment = copyEnvironment(environmentValue);
	const initialSignal = signalState(signal);
	if (
		argv === undefined ||
		typeof lockPathValue !== "string" ||
		lockPathValue.charCodeAt(0) !== 0x2f ||
		environment === undefined ||
		typeof timeoutValue !== "number" ||
		!Number.isSafeInteger(timeoutValue) ||
		timeoutValue < MIN_TIMEOUT_MS ||
		timeoutValue > MAX_TIMEOUT_MS ||
		initialSignal === undefined
	) {
		return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	}
	if (initialSignal) return Object.freeze({ ok: false, code: "ABORTED" });
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	}
	let child: ChildProcess;
	try {
		child = spawn(argv[0], argv.slice(1), {
			cwd: "/",
			env: environment,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return Object.freeze({ ok: false, code: "SPAWN_FAILED" });
	}
	const pid = child.pid;
	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderr = child.stderr;
	const closed = childClosePromise(child);
	if (pid === undefined || stdin === null || stdout === null || stderr === null) {
		if (pid !== undefined) await settleGroup(pid, closed);
		return Object.freeze({ ok: false, code: "SPAWN_FAILED" });
	}
	let settled = false;
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let resolveOutcome: ((value: "READY" | PrimeCliProcessFailureCode | "LOCK_FAILED") => void) | undefined;
	const outcome = new Promise<"READY" | PrimeCliProcessFailureCode | "LOCK_FAILED">((resolve) => {
		resolveOutcome = resolve;
	});
	const finish = (value: "READY" | PrimeCliProcessFailureCode | "LOCK_FAILED"): void => {
		if (settled) return;
		settled = true;
		resolveOutcome?.(value);
	};
	stdout.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.byteLength;
		if (stdoutBytes === 1 && chunk.byteLength === 1 && chunk[0] === LOCK_READY) finish("READY");
		else finish("LOCK_FAILED");
	});
	stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.byteLength;
		finish(stderrBytes > MAX_OUTPUT_BYTES ? "OUTPUT_OVERFLOW" : "LOCK_FAILED");
	});
	stdout.once("error", () => finish("STREAM_FAILED"));
	stderr.once("error", () => finish("STREAM_FAILED"));
	child.once("error", () => finish("SPAWN_FAILED"));
	closed
		.then((close) => {
			if (close.code === 0 && close.signal === null) finish("LOCK_FAILED");
			else finish("LOCK_FAILED");
		})
		.catch(() => finish("SPAWN_FAILED"));
	const timer = setTimeout(() => finish("TIMED_OUT"), timeoutValue);
	const abortHandler = (): void => finish("ABORTED");
	if (signal !== undefined) {
		try {
			signal.addEventListener("abort", abortHandler, { once: true });
			if (signal.aborted) finish("ABORTED");
		} catch {
			finish("INPUT_INVALID");
		}
	}
	const completed = await outcome;
	clearTimeout(timer);
	if (signal !== undefined) {
		try {
			signal.removeEventListener("abort", abortHandler);
		} catch {
			// Settlement follows for failure.
		}
	}
	if (completed !== "READY") {
		const certain = await settleGroup(pid, closed);
		return Object.freeze({ ok: false, code: certain ? completed : "PROCESS_UNCERTAIN" });
	}
	const lock = new PrimeCliProvisioningLock(LOCK_ISSUE);
	const state: LockState = { child, pid, closed, failed: false, released: false };
	locks.set(lock, state);
	stderr.on("data", () => {
		state.failed = true;
	});
	stdout.on("data", () => {
		state.failed = true;
	});
	closed
		.then(() => {
			if (!state.released) state.failed = true;
		})
		.catch(() => {
			state.failed = true;
		});
	return Object.freeze({ ok: true, value: lock });
}

export function primeCliProvisioningLockAlive(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const state = locks.get(value);
	return state !== undefined && !state.failed && !state.released && groupExists(state.pid);
}

export async function releasePrimeCliProvisioningLock(value: unknown): Promise<PrimeCliLockResult> {
	if (typeof value !== "object" || value === null) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	const state = locks.get(value);
	if (state === undefined || state.released) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	state.released = true;
	try {
		state.child.stdin?.end();
	} catch {
		// Settlement below remains authoritative.
	}
	const normal = await Promise.race([
		state.closed.then((close) => close).catch(() => undefined),
		delay(TERM_GRACE_MS).then(() => undefined),
	]);
	const exitedCleanly = normal !== undefined && normal.code === 0 && normal.signal === null && !state.failed;
	const certain = exitedCleanly && !groupExists(state.pid) ? true : await settleGroup(state.pid, state.closed);
	if (!certain || !exitedCleanly) return Object.freeze({ ok: false, code: "PROCESS_UNCERTAIN" });
	locks.delete(value);
	return Object.freeze({ ok: true, value });
}
