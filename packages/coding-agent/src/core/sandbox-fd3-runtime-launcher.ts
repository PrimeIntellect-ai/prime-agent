/**
 * Fixed local runtime child launcher (B14).
 *
 * Spawns a Node child process with FD3 bootstrap args, creates a readiness
 * monitor on its stdout/stderr, and wraps the FD3 pipe as a credential
 * WritableCapability via createNodeWritableCredentialAdapter.
 *
 * Production entry: `startFd3RuntimeLauncher({readyNonce})` — exactly one
 * field, no caller executable/argv/cwd/env/paths/process/dependencies.
 * Returns a native Promise resolving to the start result.
 *
 * Test-only factory: `createFd3RuntimeLauncher(deps)` — accepts dependency
 * overrides validated through exact own-key descriptor checks.
 *
 * Adapted from the accepted sandbox-node-ssh-session.ts childBridge/stream/
 * event-attachment/cleanup patterns.  All post-spawn failure paths await
 * checked monitor close before resolving the promise.
 *
 * No dynamic imports, no `any`, no sync fs, no shell strings, no raw errors.
 * Exact native promises and shared close.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import {
	type CreateFd3ReadinessMonitorResult,
	createFd3ReadinessMonitor,
	type Fd3CloseResult,
	type Fd3ProcessEventListener,
	type Fd3ProcessMonitor,
	type Fd3ReadyResult,
} from "./sandbox-fd3-readiness-monitor.js";
import {
	type CreateNodeWritableAdapterResult,
	createNodeWritableCredentialAdapter,
} from "./sandbox-node-writable-credential-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type Fd3RuntimeLauncherFailureCode =
	| "INVALID_INPUT"
	| "SPAWN_FAILED"
	| "INVALID_CHILD"
	| "MONITOR_FAILED"
	| "STDIN_FAILED";

export type StartFd3RuntimeLauncherResult =
	| Readonly<{
			ok: true;
			monitor: Fd3ProcessMonitor;
			credentialWritable: Extract<CreateNodeWritableAdapterResult, { readonly ok: true }>["writable"];
	  }>
	| Readonly<{
			ok: false;
			code: Fd3RuntimeLauncherFailureCode;
			cleanupConfirmed: boolean;
	  }>;

/** Test-only dependency injection type. */
export interface Fd3RuntimeLauncherDeps {
	readonly readyNonce: string;
	readonly executable: string;
	readonly entry: string;
	readonly env: Readonly<Record<string, string>>;
	readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
	readonly signal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => boolean;
	/** Timeout in ms for post-spawn-failure process group cleanup. */
	readonly cleanupTimeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

type BoundMethod = (...args: readonly unknown[]) => unknown;
type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type Fd3KillSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
type SignalFunction = (pid: number, signal: Fd3KillSignal) => boolean;
type ResultErrorCode = Extract<StartFd3RuntimeLauncherResult, { readonly ok: false }>["code"];

const RUNTIME_FLAG = "--prime-agent-runtime-fd3";
const NONCE_FLAG = "--ready-nonce";

const DEPENDENCY_KEYS: ReadonlySet<string> = Object.freeze(
	new Set(["readyNonce", "executable", "entry", "env", "spawn", "signal", "cleanupTimeoutMs"]),
);
const ALLOWED_ENV_KEYS: ReadonlyArray<string> = Object.freeze(["PATH", "HOME", "USER", "TMPDIR"]);
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAX_PROTOTYPE_DEPTH = 16;
const PATH_RE = /^\/[^\x00-\x1f\x7f]{1,4095}$/;
const PROCESS_KILL = process.kill;

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor / method extraction helpers (matching SSH session patterns)
// ─────────────────────────────────────────────────────────────────────────────

function rawDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const names = Object.getOwnPropertyNames(descriptors);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
}

function method(raw: object, name: string): BoundMethod | null {
	let current: object | null = raw;
	for (let depth = 0; current !== null && depth <= MAX_PROTOTYPE_DEPTH; depth += 1) {
		try {
			if (types.isProxy(current)) return null;
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (descriptor) {
				if (!("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) {
					return null;
				}
				const callable = descriptor.value as CallableFunction;
				return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
			}
			current = Object.getPrototypeOf(current);
		} catch {
			return null;
		}
	}
	return null;
}

function ownData(raw: object, name: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Child bridge (matching SSH session childBridge)
// ─────────────────────────────────────────────────────────────────────────────

interface StreamBridge {
	readonly on: BoundMethod;
	readonly off: BoundMethod;
	readonly destroy: BoundMethod;
}

interface ChildBridge {
	readonly pid: number;
	readonly childEvents: Readonly<{ on: BoundMethod; off: BoundMethod }>;
	readonly fd3: unknown;
	readonly fd3Bridge: StreamBridge;
	readonly stdoutBridge: StreamBridge;
	readonly stderrBridge: StreamBridge;
}

function stream(raw: unknown): StreamBridge | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	const on = method(raw, "on");
	const off = method(raw, "off");
	const destroy = method(raw, "destroy");
	return on && off && destroy ? Object.freeze({ on, off, destroy }) : null;
}

function childBridge(raw: unknown): ChildBridge | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	const pid = ownData(raw, "pid");
	const stdout = ownData(raw, "stdout");
	const stderr = ownData(raw, "stderr");
	const stdioDesc = Object.getOwnPropertyDescriptor(raw, "stdio");
	const stdio = stdioDesc && "value" in stdioDesc ? stdioDesc.value : undefined;

	// Validate stdio is a plain array (no Proxy/getter) with >=4 entries;
	// read index 3 via own data descriptor to reject Proxy/getter.
	let fd3: unknown;
	try {
		if (
			Array.isArray(stdio) &&
			!types.isProxy(stdio) &&
			Object.getPrototypeOf(stdio) === Array.prototype &&
			stdio.length >= 4
		) {
			const thirdDesc = Object.getOwnPropertyDescriptor(stdio, "3");
			if (thirdDesc && "value" in thirdDesc && thirdDesc.enumerable) {
				fd3 = thirdDesc.value;
			}
		}
	} catch {
		// Hostile or Proxy stdio array — fd3 stays undefined, bridge fails below.
	}

	const on = method(raw, "on");
	const off = method(raw, "off");
	const stdoutBridge = stream(stdout);
	const stderrBridge = stream(stderr);
	const fd3Bridge = stream(fd3);
	const identities = new Set([raw, stdout, stderr, fd3]);
	if (
		identities.size !== 4 ||
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		pid > 2_147_483_647 ||
		!on ||
		!off ||
		!stdoutBridge ||
		!stderrBridge ||
		!fd3Bridge
	) {
		return null;
	}
	return Object.freeze({
		pid,
		childEvents: Object.freeze({ on, off }),
		fd3,
		fd3Bridge,
		stdoutBridge,
		stderrBridge,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer copy (matching SSH session copyNodeChunk)
// ─────────────────────────────────────────────────────────────────────────────

function copyNodeChunk(raw: unknown): Uint8Array | null {
	if (!Buffer.isBuffer(raw) || raw.byteLength < 1) return null;
	try {
		const output = new Uint8Array(raw.byteLength);
		Uint8Array.prototype.set.call(output, raw);
		return output;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Error code extraction (matching SSH session caughtCode)
// ─────────────────────────────────────────────────────────────────────────────

function caughtCode(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "code");
		return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Process capability (matching SSH session makeProcessCapability)
// ─────────────────────────────────────────────────────────────────────────────

interface ProcessCapability {
	readonly subscribe: BoundMethod;
	readonly signalGroup: BoundMethod;
	readonly destroyStdio: BoundMethod;
}

interface ProcessCapabilityResult {
	readonly capability: ProcessCapability;
	readonly releaseForEmergency: () => boolean;
	readonly transferFd3: () => void;
}

interface BoundDependencies {
	readonly signal: SignalFunction;
}

function makeProcessCapability(bridge: ChildBridge, deps: BoundDependencies): ProcessCapabilityResult {
	let subscriptionConsumed = false;
	let unsubscribeConsumed = false;
	let destroyConsumed = false;
	let fd3Transferred = false;
	let active = false;
	let exitObserved = false;
	let closeObserved = false;
	const attachments: {
		readonly off: BoundMethod;
		readonly event: string;
		readonly handler: (...args: readonly unknown[]) => void;
	}[] = [];

	const removeAttachments = (): boolean => {
		const owned = attachments.slice();
		attachments.length = 0;
		active = false;
		for (const attachment of owned) {
			try {
				attachment.off(attachment.event, attachment.handler);
			} catch {
				attachments.push(attachment);
			}
		}
		return attachments.length === 0;
	};

	const subscribe = (rawListener: unknown): unknown => {
		if (subscriptionConsumed || typeof rawListener !== "object" || rawListener === null) {
			return Object.freeze({ status: "error" });
		}
		subscriptionConsumed = true;
		const listener = rawListener as Fd3ProcessEventListener;
		const deliver = (call: () => void): void => {
			try {
				call();
			} catch {
				active = false;
			}
		};
		const onStdout = (raw: unknown): void => {
			if (!active) return;
			const bytes = copyNodeChunk(raw);
			if (!bytes) deliver(() => listener.onProcessError());
			else deliver(() => listener.onStdout(bytes));
		};
		const onStderr = (raw: unknown): void => {
			if (!active) return;
			const bytes = copyNodeChunk(raw);
			if (!bytes) deliver(() => listener.onProcessError());
			else deliver(() => listener.onStderr(bytes));
		};
		const onExit = (rawCode: unknown, rawSignal: unknown): void => {
			if (exitObserved) return;
			exitObserved = true;
			if (!active) return;
			const code =
				typeof rawCode === "number" && Number.isSafeInteger(rawCode) && rawCode >= 0 && rawCode <= 255
					? rawCode
					: null;
			const signal = typeof rawSignal === "string" && /^[A-Z][A-Z0-9]{0,31}$/.test(rawSignal) ? rawSignal : null;
			deliver(() => listener.onExit(Object.freeze({ code, signal })));
		};
		const onClose = (): void => {
			if (closeObserved) return;
			closeObserved = true;
			if (active) deliver(() => listener.onClose());
		};
		const onError = (): void => {
			if (active) deliver(() => listener.onProcessError());
		};
		const planned: ReadonlyArray<{
			readonly off: BoundMethod;
			readonly event: string;
			readonly handler: (...args: readonly unknown[]) => void;
		}> = Object.freeze([
			Object.freeze({ off: bridge.childEvents.off, event: "error", handler: onError }),
			Object.freeze({ off: bridge.childEvents.off, event: "exit", handler: onExit }),
			Object.freeze({ off: bridge.childEvents.off, event: "close", handler: onClose }),
			Object.freeze({ off: bridge.stdoutBridge.off, event: "data", handler: onStdout }),
			Object.freeze({ off: bridge.stderrBridge.off, event: "data", handler: onStderr }),
		]);
		const ons: ReadonlyArray<BoundMethod> = Object.freeze([
			bridge.childEvents.on,
			bridge.childEvents.on,
			bridge.childEvents.on,
			bridge.stdoutBridge.on,
			bridge.stderrBridge.on,
		]);
		active = true;
		for (let index = 0; index < planned.length; index += 1) {
			try {
				ons[index](planned[index].event, planned[index].handler);
				attachments.push(planned[index]);
			} catch {
				removeAttachments();
				return Object.freeze({ status: "error" });
			}
		}
		const unsubscribe = (): unknown => {
			if (unsubscribeConsumed) return Object.freeze({ status: "error" });
			unsubscribeConsumed = true;
			return Object.freeze({ status: removeAttachments() ? "unsubscribed" : "error" });
		};
		return Object.freeze({ status: "subscribed" as const, unsubscribe });
	};

	const signalGroup = (rawSignal: unknown): unknown => {
		if (rawSignal !== "SIGINT" && rawSignal !== "SIGTERM" && rawSignal !== "SIGKILL") {
			return Object.freeze({ status: "error" });
		}
		if (exitObserved || closeObserved) return Object.freeze({ status: "not_found" });
		try {
			return Object.freeze({ status: deps.signal(-bridge.pid, rawSignal) ? "sent" : "error" });
		} catch (error) {
			return Object.freeze({ status: caughtCode(error) === "ESRCH" ? "not_found" : "error" });
		}
	};

	const releaseForEmergency = (): boolean => removeAttachments();

	const transferFd3 = (): void => {
		fd3Transferred = true;
	};

	const destroyStdio = (): unknown => {
		if (destroyConsumed) return Object.freeze({ status: "error" });
		destroyConsumed = true;
		let certain = removeAttachments();
		for (const destroy of [bridge.stdoutBridge.destroy, bridge.stderrBridge.destroy]) {
			try {
				destroy();
			} catch {
				certain = false;
			}
		}
		if (!fd3Transferred) {
			try {
				bridge.fd3Bridge.destroy();
			} catch {
				certain = false;
			}
		}
		return Object.freeze({ status: certain ? "destroyed" : "error" });
	};

	const capability: ProcessCapability = Object.freeze({ subscribe, signalGroup, destroyStdio });
	return Object.freeze({ capability, releaseForEmergency, transferFd3 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Emergency cleanup (matching SSH session)
// ─────────────────────────────────────────────────────────────────────────────

async function emergencyCleanup(rawChild: unknown, deps: BoundDependencies, timeoutMs: number): Promise<boolean> {
	if (typeof rawChild !== "object" || rawChild === null) return false;
	try {
		if (types.isProxy(rawChild)) return false;
	} catch {
		return false;
	}

	const child = rawChild;
	const pid = ownData(child, "pid");
	const pidValid = typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 1 && pid <= 2_147_483_647;
	const childOn = method(child, "on");
	const childOff = method(child, "off");
	const destroys: Array<() => boolean> = [];
	const destroyIdentities = new Set<object>();
	let snapshotCertain = true;

	const captureDestroy = (raw: unknown): void => {
		if (raw === null) return;
		if (typeof raw !== "object") {
			snapshotCertain = false;
			return;
		}
		if (destroyIdentities.has(raw)) return;
		const destroy = method(raw, "destroy");
		if (!destroy) {
			snapshotCertain = false;
			return;
		}
		destroyIdentities.add(raw);
		destroys.push(() => {
			try {
				destroy();
				return true;
			} catch {
				return false;
			}
		});
	};

	captureDestroy(ownData(child, "stdout"));
	captureDestroy(ownData(child, "stderr"));
	try {
		const stdio = ownData(child, "stdio");
		const length = Array.isArray(stdio) ? Object.getOwnPropertyDescriptor(stdio, "length")?.value : undefined;
		if (
			!Array.isArray(stdio) ||
			types.isProxy(stdio) ||
			Object.getPrototypeOf(stdio) !== Array.prototype ||
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 4
		) {
			snapshotCertain = false;
		} else {
			const descriptor = Object.getOwnPropertyDescriptor(stdio, "3");
			if (!descriptor || !("value" in descriptor)) snapshotCertain = false;
			else captureDestroy(descriptor.value);
		}
	} catch {
		snapshotCertain = false;
	}

	let exitObserved = false;
	let closeObserved = false;
	let attachedExit = false;
	let attachedClose = false;
	let removalCertain = true;
	let waitResolve: (() => void) | null = null;
	let waitTimer: ReturnType<typeof setTimeout> | null = null;

	const maybeFinish = (): void => {
		if (!exitObserved || !closeObserved || waitResolve === null) return;
		if (waitTimer !== null) clearTimeout(waitTimer);
		waitTimer = null;
		const resolve = waitResolve;
		waitResolve = null;
		resolve();
	};
	const onExit = (): void => {
		exitObserved = true;
		maybeFinish();
	};
	const onClose = (): void => {
		closeObserved = true;
		maybeFinish();
	};

	if (childOn && childOff) {
		attachedExit = true;
		try {
			childOn("exit", onExit);
		} catch {
			try {
				childOff("exit", onExit);
				attachedExit = false;
			} catch {
				removalCertain = false;
			}
		}
		if (attachedExit && removalCertain) {
			attachedClose = true;
			try {
				childOn("close", onClose);
			} catch {
				try {
					childOff("close", onClose);
					attachedClose = false;
				} catch {
					removalCertain = false;
				}
				try {
					childOff("exit", onExit);
					attachedExit = false;
				} catch {
					removalCertain = false;
				}
			}
		}
	}

	if (pidValid && !exitObserved && !closeObserved) {
		try {
			deps.signal(-pid, "SIGKILL");
		} catch {
			// Independent exit and close evidence may still confirm cleanup.
		}
	}

	await new Promise<void>((resolve) => {
		waitResolve = resolve;
		waitTimer = setTimeout(() => {
			waitTimer = null;
			waitResolve = null;
			resolve();
		}, timeoutMs);
		maybeFinish();
	});

	if (attachedExit && childOff) {
		try {
			childOff("exit", onExit);
		} catch {
			removalCertain = false;
		}
	}
	if (attachedClose && childOff) {
		try {
			childOff("close", onClose);
		} catch {
			removalCertain = false;
		}
	}

	let destroyCertain = true;
	for (const destroy of destroys) {
		if (!destroy()) destroyCertain = false;
	}

	return (
		pidValid &&
		attachedExit &&
		attachedClose &&
		exitObserved &&
		closeObserved &&
		snapshotCertain &&
		removalCertain &&
		destroyCertain
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Result helper
// ─────────────────────────────────────────────────────────────────────────────

function resultError(code: ResultErrorCode, cleanupConfirmed: boolean): StartFd3RuntimeLauncherResult {
	return Object.freeze({ ok: false as const, code, cleanupConfirmed });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency validation
// ─────────────────────────────────────────────────────────────────────────────

function depsSnapshot(raw: unknown): Readonly<{
	readyNonce: string;
	executable: string;
	entry: string;
	env: Readonly<Record<string, string>>;
	cleanupTimeoutMs: number;
	spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
	signal: SignalFunction;
}> | null {
	// Validate outer shape: exact own keys, no proxy, no getter, no symbol.
	const descriptors = exact(raw, DEPENDENCY_KEYS);
	if (!descriptors) return null;

	const readyNonce = descriptors.readyNonce?.value;
	const executable = descriptors.executable?.value;
	const entry = descriptors.entry?.value;
	const envRaw = descriptors.env?.value;
	const spawnRaw = descriptors.spawn?.value;
	const signalRaw = descriptors.signal?.value;
	const cleanupTimeoutRaw = descriptors.cleanupTimeoutMs?.value;

	if (
		typeof readyNonce !== "string" ||
		!NONCE_RE.test(readyNonce) ||
		typeof executable !== "string" ||
		typeof entry !== "string" ||
		!PATH_RE.test(executable) ||
		!PATH_RE.test(entry) ||
		typeof envRaw !== "object" ||
		envRaw === null ||
		typeof spawnRaw !== "function" ||
		typeof signalRaw !== "function"
	) {
		return null;
	}
	if (
		typeof cleanupTimeoutRaw !== "number" ||
		!Number.isSafeInteger(cleanupTimeoutRaw) ||
		cleanupTimeoutRaw < 1 ||
		cleanupTimeoutRaw > 120_000
	) {
		return null;
	}
	const cleanupTimeoutMs = cleanupTimeoutRaw;

	// Reject Proxy on function values and env object.
	try {
		if (types.isProxy(spawnRaw) || types.isProxy(signalRaw) || types.isProxy(envRaw)) return null;
	} catch {
		return null;
	}

	// Validate env object: plain, no symbol, all value descriptors, only ALLOWED_ENV_KEYS.
	if (Object.getPrototypeOf(envRaw) !== Object.prototype || Object.getOwnPropertySymbols(envRaw).length !== 0) {
		return null;
	}
	const envDescriptors = Object.getOwnPropertyDescriptors(envRaw);
	const envNames = Object.getOwnPropertyNames(envDescriptors);
	const allowedSet = new Set(ALLOWED_ENV_KEYS);
	for (const name of envNames) {
		if (!allowedSet.has(name)) return null;
		const d = envDescriptors[name];
		if (!d || !("value" in d) || !d.enumerable) return null;
	}

	// Read each allowed key as own enumerable string data property.
	const env: Record<string, string> = {};
	for (const key of ALLOWED_ENV_KEYS) {
		const descriptor = Object.getOwnPropertyDescriptor(envRaw, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) continue;
		const value = descriptor.value;
		if (typeof value !== "string") return null;
		env[key] = value;
	}

	return Object.freeze({
		readyNonce,
		executable,
		entry,
		env: Object.freeze(env),
		cleanupTimeoutMs,
		spawn: (command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
			Reflect.apply(spawnRaw as CallableFunction, raw, [command, [...args], options]) as ChildProcess,
		signal: (pid: number, signal: Fd3KillSignal): boolean =>
			Reflect.apply(signalRaw as CallableFunction, raw, [pid, signal]) === true,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Production entry
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_NONCE_KEYS: ReadonlySet<string> = Object.freeze(new Set(["readyNonce"]));

/**
 * Start a fixed local FD3 runtime child.
 *
 * Production entry point — accepts exactly `{readyNonce}` with a 32-hex-char
 * nonce string.  All other parameters are derived from the runtime environment.
 * No caller executable, argv, cwd, env, paths, process objects, or dependencies.
 *
 * Returns a native Promise resolving to the start result.
 */
export function startFd3RuntimeLauncher(raw: unknown): Promise<StartFd3RuntimeLauncherResult> {
	const descriptors = exact(raw, PRODUCTION_NONCE_KEYS);
	if (!descriptors) return Promise.resolve(resultError("INVALID_INPUT", true));
	const readyNonce = descriptors.readyNonce.value;
	if (typeof readyNonce !== "string" || !NONCE_RE.test(readyNonce)) {
		return Promise.resolve(resultError("INVALID_INPUT", true));
	}

	const executable = process.execPath;
	const entry = fileURLToPath(new URL("../cli.js", import.meta.url));
	const env: Record<string, string> = {};
	for (const key of ALLOWED_ENV_KEYS) {
		const value = process.env[key];
		if (typeof value === "string") {
			env[key] = value;
		}
	}

	return createFd3RuntimeLauncher({
		readyNonce,
		executable,
		entry,
		env,
		cleanupTimeoutMs: 5_000,
		spawn: (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess =>
			nodeSpawn(cmd, [...args], opts),
		signal: (pid: number, sig: "SIGINT" | "SIGTERM" | "SIGKILL"): boolean =>
			Reflect.apply(PROCESS_KILL, process, [pid, sig]),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-only factory (dependency injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fixed local FD3 runtime child with explicit dependency overrides.
 *
 * This is the test-only factory.  Production code calls this factory via
 * `startFd3RuntimeLauncher`, which constructs validated deps from the
 * runtime environment.
 *
 * Accepts validated exact own-key dependencies for executable, entry, env,
 * spawn, and signal.
 *
 * Returns a native Promise.  All post-spawn failure paths await checked
 * monitor/process cleanup before resolving.
 */
export async function createFd3RuntimeLauncher(raw: unknown): Promise<StartFd3RuntimeLauncherResult> {
	const deps = depsSnapshot(raw);
	if (!deps) return resultError("INVALID_INPUT", true);
	const boundDeps: BoundDependencies = Object.freeze({ signal: deps.signal });

	// Build argv.
	const args: readonly string[] = Object.freeze([deps.entry, RUNTIME_FLAG, NONCE_FLAG, deps.readyNonce]);

	// Build spawn options — no cwd, no caller env.
	const spawnOptions: SpawnOptions = Object.freeze({
		shell: false,
		detached: true,
		stdio: Object.freeze(["ignore", "pipe", "pipe", "pipe"]) as StdioOptions,
		env: deps.env,
	});

	// Spawn child.
	let child: unknown;
	try {
		child = deps.spawn(deps.executable, args, spawnOptions);
	} catch {
		return resultError("SPAWN_FAILED", true);
	}

	// Validate child shape (own-data, no proxy, no alias).
	const bridge = childBridge(child);
	if (!bridge) {
		return resultError("INVALID_CHILD", await emergencyCleanup(child, boundDeps, deps.cleanupTimeoutMs));
	}

	// Create process capability (subscribe/signalGroup/destroyStdio).
	const processCapability = makeProcessCapability(bridge, boundDeps);

	// Set default timeouts.
	const timeouts: Readonly<Record<string, number>> = Object.freeze({
		readyTimeoutMs: 60_000,
		sigintTimeoutMs: 5_000,
		sigtermTimeoutMs: 10_000,
		sigkillTimeoutMs: 10_000,
		closeConfirmTimeoutMs: 5_000,
	});

	// Create readiness monitor.
	const monitorInput = Object.freeze({
		process: processCapability.capability,
		expectedNonce: deps.readyNonce,
		timeouts,
	});
	const monitorResult: CreateFd3ReadinessMonitorResult = createFd3ReadinessMonitor(monitorInput);
	if (!monitorResult.ok) {
		const released = processCapability.releaseForEmergency();
		const cleaned = await emergencyCleanup(child, boundDeps, deps.cleanupTimeoutMs);
		return resultError("MONITOR_FAILED", released && cleaned);
	}

	const monitor: Fd3ProcessMonitor = monitorResult.monitor;

	// Create credential writable adapter for FD3 pipe.
	const writableResult: CreateNodeWritableAdapterResult = createNodeWritableCredentialAdapter(
		Object.freeze({ writable: bridge.fd3 }),
	);
	if (!writableResult.ok) {
		const closed = await monitor.close();
		const cc: boolean = closed.ok ? true : closed.cleanupConfirmed;
		return resultError("STDIN_FAILED", cc);
	}
	processCapability.transferFd3();

	// Validate PID: wrap monitor.ready so that on ok:true, the reported pid
	// MUST equal the actual child pid.  On mismatch, close the monitor first,
	// then report exact Fd3ReadyResult with INVALID_PID and the actual
	// cleanupConfirmed from the close result.
	const childPid = bridge.pid;
	const originalReady = monitor.ready;
	const wrappedReady = Promise.prototype.then.call(
		originalReady,
		(value: unknown) => {
			const asReady = value as Fd3ReadyResult;
			if (asReady.ok === true && asReady.pid !== childPid) {
				return Promise.prototype.then.call(
					monitor.close(),
					(closeValue: unknown) => {
						const closeResult = closeValue as Fd3CloseResult;
						const cc: boolean = closeResult.ok ? true : closeResult.cleanupConfirmed;
						return Object.freeze({
							ok: false as const,
							code: "INVALID_PID" as const,
							cleanupConfirmed: cc,
						}) as Fd3ReadyResult;
					},
					() =>
						Object.freeze({
							ok: false as const,
							code: "INVALID_PID" as const,
							cleanupConfirmed: false as const,
						}) as Fd3ReadyResult,
				);
			}
			return value;
		},
		() =>
			Promise.prototype.then.call(
				monitor.close(),
				(closeValue: unknown) => {
					const closeResult = closeValue as Fd3CloseResult;
					return Object.freeze({
						ok: false as const,
						code: "INVALID_PID" as const,
						cleanupConfirmed: closeResult.ok ? true : closeResult.cleanupConfirmed,
					}) as Fd3ReadyResult;
				},
				() =>
					Object.freeze({
						ok: false as const,
						code: "INVALID_PID" as const,
						cleanupConfirmed: false as const,
					}) as Fd3ReadyResult,
			),
	);

	const wrappedMonitor: Fd3ProcessMonitor = Object.freeze({
		ready: wrappedReady as Promise<Fd3ReadyResult>,
		closed: monitor.closed,
		close: monitor.close,
	});

	return Object.freeze({
		ok: true as const,
		monitor: wrappedMonitor,
		credentialWritable: writableResult.writable,
	});
}
