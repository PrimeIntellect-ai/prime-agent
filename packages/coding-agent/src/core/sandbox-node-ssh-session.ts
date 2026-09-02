import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { types } from "node:util";
import {
	type CreateNodeWritableAdapterResult,
	createNodeWritableCredentialAdapter,
} from "./sandbox-node-writable-credential-adapter.js";
import {
	createSshProcessMonitor,
	type SshProcessEventListener,
	type SshProcessMonitor,
} from "./sandbox-ssh-process-monitor.js";
import { buildSandboxSshSpawnSpec } from "./sandbox-ssh-spawn-spec.js";

const INPUT_KEYS = new Set(["confirmRelayAdmission", "spawnRequest", "timeouts"]);
const DEPENDENCY_KEYS = new Set(["signal", "spawn"]);
const TIMEOUT_KEYS = new Set([
	"admissionTimeoutMs",
	"closeConfirmTimeoutMs",
	"readyTimeoutMs",
	"sigintTimeoutMs",
	"sigkillTimeoutMs",
	"sigtermTimeoutMs",
]);
const STATUS_SUBSCRIBED = "subscribed";
const MAX_PROTOTYPE_DEPTH = 16;
const MAX_TIMEOUT_MS = 120_000;
const PROCESS_KILL = process.kill;

type CredentialWritable = Extract<CreateNodeWritableAdapterResult, { readonly ok: true }>["writable"];
type SpawnFunction = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcessWithoutNullStreams;
type SignalFunction = (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => boolean;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

export interface NodeSshSessionDependencies {
	readonly spawn: SpawnFunction;
	readonly signal: SignalFunction;
}

export type StartNodeSshSessionResult =
	| Readonly<{
			ok: true;
			monitor: SshProcessMonitor;
			credentialWritable: CredentialWritable;
	  }>
	| Readonly<{
			ok: false;
			code: "INVALID_INPUT" | "SPAWN_FAILED" | "INVALID_CHILD" | "MONITOR_FAILED" | "STDIN_FAILED";
			cleanupConfirmed: boolean;
	  }>;

interface BoundDependencies {
	readonly spawn: SpawnFunction;
	readonly signal: SignalFunction;
}

interface StreamBridge {
	readonly on: BoundMethod;
	readonly off: BoundMethod;
	readonly destroy: BoundMethod;
}

interface ChildBridge {
	readonly pid: number;
	readonly childEvents: Readonly<{ on: BoundMethod; off: BoundMethod }>;
	readonly stdin: unknown;
	readonly stdinBridge: StreamBridge;
	readonly stdoutBridge: StreamBridge;
	readonly stderrBridge: StreamBridge;
}

interface Attachment {
	readonly off: BoundMethod;
	readonly event: string;
	readonly handler: (...args: readonly unknown[]) => void;
}

function resultError(
	code: Extract<StartNodeSshSessionResult, { readonly ok: false }>["code"],
	cleanupConfirmed: boolean,
): StartNodeSshSessionResult {
	return Object.freeze({ ok: false as const, code, cleanupConfirmed });
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

function dependencies(raw: unknown): BoundDependencies | null {
	const descriptors = exact(raw, DEPENDENCY_KEYS);
	const spawnRaw = descriptors?.spawn?.value;
	const signalRaw = descriptors?.signal?.value;
	if (typeof spawnRaw !== "function" || typeof signalRaw !== "function") return null;
	try {
		if (types.isProxy(spawnRaw) || types.isProxy(signalRaw)) return null;
	} catch {
		return null;
	}
	return Object.freeze({
		spawn: (command: string, args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams =>
			Reflect.apply(spawnRaw as CallableFunction, raw, [command, args, options]) as ChildProcessWithoutNullStreams,
		signal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): boolean =>
			Reflect.apply(signalRaw as CallableFunction, raw, [pid, signal]) === true,
	});
}

const PRODUCTION_DEPENDENCIES: NodeSshSessionDependencies = Object.freeze({
	spawn: (command: string, args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams =>
		nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams,
	signal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): boolean =>
		Reflect.apply(PROCESS_KILL, process, [pid, signal]),
});

function timeoutSnapshot(raw: unknown): Readonly<Record<string, number>> | null {
	const descriptors = exact(raw, TIMEOUT_KEYS);
	if (!descriptors) return null;
	const output: Record<string, number> = {};
	for (const key of TIMEOUT_KEYS) {
		const value = descriptors[key]?.value;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
			return null;
		}
		output[key] = value;
	}
	return Object.freeze(output);
}

function ownData(raw: object, name: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
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
	const stdin = ownData(raw, "stdin");
	const stdout = ownData(raw, "stdout");
	const stderr = ownData(raw, "stderr");
	const on = method(raw, "on");
	const off = method(raw, "off");
	const stdinBridge = stream(stdin);
	const stdoutBridge = stream(stdout);
	const stderrBridge = stream(stderr);
	const identities = new Set([raw, stdin, stdout, stderr]);
	if (
		identities.size !== 4 ||
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		pid > 2_147_483_647 ||
		!on ||
		!off ||
		!stdinBridge ||
		!stdoutBridge ||
		!stderrBridge
	) {
		return null;
	}
	return Object.freeze({
		pid,
		childEvents: Object.freeze({ on, off }),
		stdin,
		stdinBridge,
		stdoutBridge,
		stderrBridge,
	});
}

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

function makeProcessCapability(
	bridge: ChildBridge,
	deps: BoundDependencies,
): Readonly<{
	subscribe: BoundMethod;
	signalGroup: BoundMethod;
	destroyStdio: BoundMethod;
}> {
	let subscriptionConsumed = false;
	let unsubscribeConsumed = false;
	let destroyConsumed = false;
	let active = false;
	let exitObserved = false;
	let closeObserved = false;
	let attachments: Attachment[] = [];

	const removeAttachments = (): boolean => {
		let certain = true;
		const owned = attachments;
		attachments = [];
		active = false;
		for (const attachment of owned) {
			try {
				attachment.off(attachment.event, attachment.handler);
			} catch {
				certain = false;
			}
		}
		return certain;
	};

	const subscribe = (rawListener: unknown): unknown => {
		if (subscriptionConsumed || typeof rawListener !== "object" || rawListener === null) {
			return Object.freeze({ status: "error" });
		}
		subscriptionConsumed = true;
		const listener = rawListener as SshProcessEventListener;
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
		const planned: Attachment[] = [
			{ off: bridge.childEvents.off, event: "error", handler: onError },
			{ off: bridge.childEvents.off, event: "exit", handler: onExit },
			{ off: bridge.childEvents.off, event: "close", handler: onClose },
			{ off: bridge.stdoutBridge.off, event: "data", handler: onStdout },
			{ off: bridge.stderrBridge.off, event: "data", handler: onStderr },
		];
		const ons = [
			bridge.childEvents.on,
			bridge.childEvents.on,
			bridge.childEvents.on,
			bridge.stdoutBridge.on,
			bridge.stderrBridge.on,
		];
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
		return Object.freeze({ status: STATUS_SUBSCRIBED, unsubscribe });
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

	const destroyStdio = (): unknown => {
		if (destroyConsumed) return Object.freeze({ status: "error" });
		destroyConsumed = true;
		let certain = true;
		for (const destroy of [bridge.stdinBridge.destroy, bridge.stdoutBridge.destroy, bridge.stderrBridge.destroy]) {
			try {
				destroy();
			} catch {
				certain = false;
			}
		}
		return Object.freeze({ status: certain ? "destroyed" : "error" });
	};

	return Object.freeze({ subscribe, signalGroup, destroyStdio });
}

function emergencyCleanup(rawChild: unknown, deps: BoundDependencies): boolean {
	if (typeof rawChild !== "object" || rawChild === null) return false;
	const pid = ownData(rawChild, "pid");
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return false;
	try {
		deps.signal(-pid, "SIGKILL");
	} catch {
		return false;
	}
	return false;
}

export async function startNodeSshSession(
	raw: unknown,
	rawDependencies: unknown = PRODUCTION_DEPENDENCIES,
): Promise<StartNodeSshSessionResult> {
	const input = exact(raw, INPUT_KEYS);
	const deps = dependencies(rawDependencies);
	const spawnRequest = input?.spawnRequest?.value;
	const confirmRaw = input?.confirmRelayAdmission?.value;
	const timeouts = timeoutSnapshot(input?.timeouts?.value);
	if (!input || !deps || typeof confirmRaw !== "function" || !timeouts) {
		return resultError("INVALID_INPUT", true);
	}
	try {
		if (types.isProxy(confirmRaw)) return resultError("INVALID_INPUT", true);
	} catch {
		return resultError("INVALID_INPUT", true);
	}
	const specification = buildSandboxSshSpawnSpec(spawnRequest);
	if (!specification.ok) return resultError("INVALID_INPUT", true);
	const spec = specification.value;
	let child: unknown;
	try {
		child = deps.spawn(spec.command, spec.args, {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: true,
			cwd: spec.options.cwd,
			env: { ...spec.options.env },
		});
	} catch {
		return resultError("SPAWN_FAILED", true);
	}
	const bridge = childBridge(child);
	if (!bridge) {
		return resultError("INVALID_CHILD", emergencyCleanup(child, deps));
	}
	const processCapability = makeProcessCapability(bridge, deps);
	const monitorResult = createSshProcessMonitor(
		Object.freeze({
			process: processCapability,
			expectedNonce: spec.args[8],
			confirmRelayAdmission: (): unknown => Reflect.apply(confirmRaw as CallableFunction, raw, []),
			timeouts,
		}),
	);
	if (!monitorResult.ok) {
		return resultError("MONITOR_FAILED", emergencyCleanup(child, deps));
	}
	const writableResult = createNodeWritableCredentialAdapter(Object.freeze({ writable: bridge.stdin }));
	if (!writableResult.ok) {
		const closed = await monitorResult.monitor.close();
		return resultError("STDIN_FAILED", closed.ok || closed.cleanupConfirmed);
	}
	return Object.freeze({
		ok: true as const,
		monitor: monitorResult.monitor,
		credentialWritable: writableResult.writable,
	});
}
