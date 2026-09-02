import { types } from "node:util";
import {
	decodeSandboxBootstrapPayload,
	encodeSandboxBootstrapPayload,
	withBootstrapGrant,
} from "./sandbox-bootstrap-payload.js";
import { createCredentialFrameWrite } from "./sandbox-credential-writer.js";
import { consumeStdinBootstrapFrame, type StdinSource } from "./sandbox-stdin-bootstrap-frame.js";

const INPUT_KEYS = new Set(["launcher", "publisher", "readyNonce", "stdinSource", "timeouts"]);
const TIMEOUT_KEYS = new Set([
	"credentialWriteTimeoutMs",
	"frameReadTimeoutMs",
	"launchTimeoutMs",
	"monitorTimeoutMs",
	"publishTimeoutMs",
]);
const LAUNCHER_KEYS = new Set(["launch"]);
const PUBLISHER_KEYS = new Set(["publish"]);
const STARTED_KEYS = new Set(["monitor", "status", "writable"]);
const MONITOR_KEYS = new Set(["close", "closed", "ready"]);
const READY_OK_KEYS = new Set(["ok", "pid"]);
const STATUS_KEYS = new Set(["status"]);
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAX_TIMEOUT_MS = 300_000;
const MAX_FRAME_READ_TIMEOUT_MS = 120_000;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

export type SandboxFd3BridgeErrorCode =
	| "CLEANUP_UNCERTAIN"
	| "CREDENTIAL_WRITE_FAILED"
	| "INPUT_INVALID"
	| "LAUNCH_FAILED"
	| "LAUNCH_UNCERTAIN"
	| "MONITOR_FAILED"
	| "PAB1_INVALID"
	| "PUBLISH_UNCERTAIN"
	| "READY_FAILED";

export type SandboxFd3BridgeCloseResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "CLEANUP_UNCERTAIN" }>;

export type SandboxFd3BridgeLifetimeResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: "RUNTIME_CLOSED_UNCONFIRMED" }>;

export interface SandboxFd3BridgeSession {
	readonly pid: number;
	readonly lifetime: Promise<SandboxFd3BridgeLifetimeResult>;
	readonly close: () => Promise<SandboxFd3BridgeCloseResult>;
}

export type CreateSandboxFd3BridgeResult =
	| Readonly<{ ok: true; session: SandboxFd3BridgeSession }>
	| Readonly<{ ok: false; error: Readonly<{ code: SandboxFd3BridgeErrorCode }> }>;

interface BoundMonitor {
	readonly identity: object;
	readonly ready: Promise<unknown>;
	readonly closed: Promise<unknown>;
	readonly close: BoundMethod;
}

interface Snapshot {
	readonly stdinSource: object;
	readonly launch: BoundMethod;
	readonly launcherIdentity: object;
	readonly publish: BoundMethod;
	readonly publisherIdentity: object;
	readonly readyNonce: string;
	readonly timeouts: Readonly<Record<string, number>>;
}

function failure(code: SandboxFd3BridgeErrorCode): CreateSandboxFd3BridgeResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

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

function nativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observe(raw: unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	if (!nativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise<Observed>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) {
						late?.(value);
						return;
					}
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
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function bind(raw: unknown, descriptors: Descriptors, key: string): BoundMethod | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = descriptors[key]?.value;
	if (typeof value !== "function") return null;
	try {
		if (types.isProxy(value)) return null;
	} catch {
		return null;
	}
	const callable = value as CallableFunction;
	return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
}

function snapshot(raw: unknown): Snapshot | null {
	const input = exact(raw, INPUT_KEYS);
	if (!input) return null;
	const stdinSource = input.stdinSource.value;
	const launcherRaw = input.launcher.value;
	const publisherRaw = input.publisher.value;
	const readyNonce = input.readyNonce.value;
	const timeoutRaw = input.timeouts.value;
	if (
		typeof stdinSource !== "object" ||
		stdinSource === null ||
		typeof launcherRaw !== "object" ||
		launcherRaw === null ||
		typeof publisherRaw !== "object" ||
		publisherRaw === null ||
		stdinSource === launcherRaw ||
		stdinSource === publisherRaw ||
		launcherRaw === publisherRaw ||
		typeof readyNonce !== "string" ||
		!NONCE_RE.test(readyNonce)
	)
		return null;
	try {
		if (types.isProxy(stdinSource)) return null;
	} catch {
		return null;
	}
	const launcher = exact(launcherRaw, LAUNCHER_KEYS);
	const publisher = exact(publisherRaw, PUBLISHER_KEYS);
	const launch = launcher ? bind(launcherRaw, launcher, "launch") : null;
	const publish = publisher ? bind(publisherRaw, publisher, "publish") : null;
	const timeouts = exact(timeoutRaw, TIMEOUT_KEYS);
	if (!launch || !publish || !timeouts) return null;
	const timeoutSnapshot: Record<string, number> = {};
	for (const key of TIMEOUT_KEYS) {
		const value = timeouts[key]?.value;
		const maximum = key === "frameReadTimeoutMs" ? MAX_FRAME_READ_TIMEOUT_MS : MAX_TIMEOUT_MS;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
			return null;
		}
		timeoutSnapshot[key] = value;
	}
	return Object.freeze({
		stdinSource,
		launch,
		launcherIdentity: launcherRaw,
		publish,
		publisherIdentity: publisherRaw,
		readyNonce,
		timeouts: Object.freeze(timeoutSnapshot),
	});
}

function discoverMonitor(raw: unknown): BoundMonitor | null {
	const descriptors = exact(raw, MONITOR_KEYS);
	if (!descriptors) return null;
	const close = bind(raw, descriptors, "close");
	const ready = descriptors.ready.value;
	const closed = descriptors.closed.value;
	if (!close || !nativePromise(ready) || !nativePromise(closed)) return null;
	return Object.freeze({ identity: raw as object, ready, closed, close });
}

function started(raw: unknown): Readonly<{ monitor: BoundMonitor; writable: object }> | null {
	const descriptors = exact(raw, STARTED_KEYS);
	if (!descriptors || descriptors.status.value !== "started") return null;
	const monitor = discoverMonitor(descriptors.monitor.value);
	const writable = descriptors.writable.value;
	if (!monitor || typeof writable !== "object" || writable === null) return null;
	try {
		if (types.isProxy(writable) || writable === monitor.identity) return null;
	} catch {
		return null;
	}
	return Object.freeze({ monitor, writable });
}

function status(raw: unknown, expected: string): boolean {
	const descriptors = exact(raw, STATUS_KEYS);
	return descriptors?.status?.value === expected;
}

function closeMonitor(monitor: BoundMonitor, timeoutMs: number): () => Promise<SandboxFd3BridgeCloseResult> {
	let shared: Promise<SandboxFd3BridgeCloseResult> | null = null;
	return (): Promise<SandboxFd3BridgeCloseResult> => {
		if (shared !== null) return shared;
		let raw: unknown;
		try {
			raw = monitor.close();
		} catch {
			shared = Promise.resolve(Object.freeze({ ok: false as const, code: "CLEANUP_UNCERTAIN" as const }));
			return shared;
		}
		shared = observe(raw, timeoutMs).then((observed) =>
			observed.status === "fulfilled" && exact(observed.value, new Set(["ok"]))?.ok?.value === true
				? Object.freeze({ ok: true as const })
				: Object.freeze({ ok: false as const, code: "CLEANUP_UNCERTAIN" as const }),
		);
		return shared;
	};
}

function readyPid(raw: unknown): number | null {
	const descriptors = exact(raw, READY_OK_KEYS);
	const pid = descriptors?.pid?.value;
	return descriptors?.ok?.value === true &&
		typeof pid === "number" &&
		Number.isSafeInteger(pid) &&
		pid >= 1 &&
		pid <= 2_147_483_647
		? pid
		: null;
}

function lifetime(monitor: BoundMonitor): Promise<SandboxFd3BridgeLifetimeResult> {
	return Promise.prototype.then.call(
		monitor.closed,
		(value: unknown) =>
			exact(value, new Set(["ok"]))?.ok?.value === true
				? Object.freeze({ ok: true as const })
				: Object.freeze({ ok: false as const, code: "RUNTIME_CLOSED_UNCONFIRMED" as const }),
		() => Object.freeze({ ok: false as const, code: "RUNTIME_CLOSED_UNCONFIRMED" as const }),
	) as Promise<SandboxFd3BridgeLifetimeResult>;
}

function erase(bytes: Uint8Array): void {
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		// The caller still fails closed.
	}
}

async function cleanupFailure(
	code: SandboxFd3BridgeErrorCode,
	close: () => Promise<SandboxFd3BridgeCloseResult>,
): Promise<CreateSandboxFd3BridgeResult> {
	const result = await close();
	return result.ok ? failure(code) : failure("CLEANUP_UNCERTAIN");
}

function closeLateStarted(raw: unknown, timeoutMs: number): void {
	const value = started(raw);
	if (value) {
		void closeMonitor(value.monitor, timeoutMs)();
		return;
	}
	const preliminary = rawDescriptors(raw);
	const descriptor = preliminary?.monitor;
	const monitor = discoverMonitor(descriptor && "value" in descriptor ? descriptor.value : undefined);
	if (monitor) void closeMonitor(monitor, timeoutMs)();
}

export async function createSandboxFd3BootstrapBridge(raw: unknown): Promise<CreateSandboxFd3BridgeResult> {
	const input = snapshot(raw);
	if (!input) return failure("INPUT_INVALID");
	const read = await consumeStdinBootstrapFrame(
		input.stdinSource as StdinSource,
		async (payload: Uint8Array) => decodeSandboxBootstrapPayload(payload),
		Object.freeze({ totalTimeoutMs: input.timeouts.frameReadTimeoutMs }),
	);
	if (!read.ok || !read.value.ok) return failure("PAB1_INVALID");
	const decoded = read.value.value;
	const reencoded = await withBootstrapGrant(decoded.grant, async (grant) =>
		encodeSandboxBootstrapPayload(
			Object.freeze({
				metadata: decoded.metadata,
				grant,
			}),
		),
	);
	if (!reencoded.ok || !reencoded.value.ok) return failure("PAB1_INVALID");
	const payload = reencoded.value.value;
	let launchRaw: unknown;
	try {
		launchRaw = input.launch(Object.freeze({ readyNonce: input.readyNonce }));
	} catch {
		erase(payload);
		return failure("LAUNCH_FAILED");
	}
	const launched = await observe(launchRaw, input.timeouts.launchTimeoutMs, (late) =>
		closeLateStarted(late, input.timeouts.monitorTimeoutMs),
	);
	if (launched.status !== "fulfilled") {
		erase(payload);
		return failure(launched.status === "timeout" ? "LAUNCH_UNCERTAIN" : "LAUNCH_FAILED");
	}
	const start = started(launched.value);
	if (!start) {
		erase(payload);
		const preliminary = rawDescriptors(launched.value);
		const monitorDescriptor = preliminary?.monitor;
		const monitor = discoverMonitor(
			monitorDescriptor && "value" in monitorDescriptor ? monitorDescriptor.value : undefined,
		);
		if (!monitor) return failure("LAUNCH_FAILED");
		return await cleanupFailure("LAUNCH_FAILED", closeMonitor(monitor, input.timeouts.monitorTimeoutMs));
	}
	if (
		start.monitor.identity === input.stdinSource ||
		start.monitor.identity === input.launcherIdentity ||
		start.monitor.identity === input.publisherIdentity ||
		start.writable === input.stdinSource ||
		start.writable === input.launcherIdentity ||
		start.writable === input.publisherIdentity
	) {
		erase(payload);
		return await cleanupFailure("LAUNCH_FAILED", closeMonitor(start.monitor, input.timeouts.monitorTimeoutMs));
	}
	const close = closeMonitor(start.monitor, input.timeouts.monitorTimeoutMs);
	const write = createCredentialFrameWrite(
		Object.freeze({
			payload,
			timeoutMs: input.timeouts.credentialWriteTimeoutMs,
			writable: start.writable,
		}),
	);
	if (!write.ok) return await cleanupFailure("CREDENTIAL_WRITE_FAILED", close);
	const completion = await observe(write.handle.completion, input.timeouts.credentialWriteTimeoutMs);
	if (completion.status !== "fulfilled" || exact(completion.value, new Set(["code", "ok"]))?.ok?.value !== true) {
		write.handle.cancel();
		return await cleanupFailure("CREDENTIAL_WRITE_FAILED", close);
	}
	const ready = await observe(start.monitor.ready, input.timeouts.monitorTimeoutMs);
	if (ready.status !== "fulfilled") return await cleanupFailure("MONITOR_FAILED", close);
	const pid = readyPid(ready.value);
	if (pid === null) return await cleanupFailure("READY_FAILED", close);
	const readyBytes = new TextEncoder().encode(`PRIME_AGENT_READY ${input.readyNonce} ${pid}\n`);
	let publishRaw: unknown;
	try {
		publishRaw = input.publish(readyBytes);
	} catch {
		return await cleanupFailure("PUBLISH_UNCERTAIN", close);
	}
	const published = await observe(publishRaw, input.timeouts.publishTimeoutMs);
	if (published.status !== "fulfilled" || !status(published.value, "published")) {
		return await cleanupFailure("PUBLISH_UNCERTAIN", close);
	}
	const session: SandboxFd3BridgeSession = Object.freeze({
		pid,
		lifetime: lifetime(start.monitor),
		close,
	});
	return Object.freeze({ ok: true as const, session });
}
