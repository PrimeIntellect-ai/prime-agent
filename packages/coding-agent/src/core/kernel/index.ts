import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { v4 as uuid } from "uuid";
import { Dealer, Subscriber } from "zeromq";
import { recordOrphanProcessState } from "../orphan-process-journal.js";
import { ensureKernelPython, type KernelBootstrapProgressHandler, type KernelPythonSkill } from "./bootstrap.js";
import { type ForkedKernelHandle, ForkServerUnavailable, forkKernel, isForkServerEnabled } from "./fork-server.js";
import {
	buildListNamesCode,
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	parseListNamesResult,
	parseRestoreResult,
	parseSnapshotResult,
	type RestoreResult,
	type SnapshotResult,
} from "./state-snapshot.js";

const DELIM = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
// Generous backstop for a kernel that is alive but wedged: crashes are detected
// within one 25ms poll via the exit handler, warm boots return in under a second,
// and a cold first boot after a venv (re)provision may legitimately need tens of
// seconds of imports before it binds ports and answers the ready probe.
const PORTS_RESOLVE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;
// Loopback PUB/SUB subscription propagation is usually sub-ms, but keep a small guard before first execute.
const IOPUB_SUBSCRIBE_DELAY_MS = 50;
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const HOST_REQUEST_DISPOSE_TIMEOUT_MS = 5000;
const KERNEL_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
// How often to poll a forked kernel's pid for unexpected death.
const FORKED_LIVENESS_POLL_MS = 1000;
// Snapshot/restore cells can be large to (de)serialize; give them room beyond the user cap.
const SNAPSHOT_MAX_OUTPUT_CHARS = 1_000_000;
// Cap how long a graceful dispose waits on the final snapshot; the debounced
// on-disk copy is the fallback if this is exceeded.
const SNAPSHOT_DISPOSE_TIMEOUT_MS = 5000;
const SNAPSHOT_EXECUTION_TIMEOUT_MS = 5000;
const KERNEL_ABORT_GRACE_MS = 1000;
const KERNEL_BUSY_REUSE_WAIT_MS = 5000;
const KERNEL_BUSY_INTERRUPT_INTERVAL_MS = 500;
const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS = 256;
const KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE =
	"IPython kernel is still running the previously interrupted cell. Wait and try again, or kill the IPython kernel to start fresh.";

export class KernelBusyAfterInterruptError extends Error {
	constructor() {
		super(KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE);
		this.name = "KernelBusyAfterInterruptError";
	}
}

/** Comm target the kernel-side `rlm.host_request` shim opens for typed host requests. */
export const HOST_COMM_TARGET = "host.request";

/**
 * Handles one typed request from Python code running in the kernel.
 * The returned record is sent back verbatim as the comm reply payload.
 *
 * This legacy unary compatibility alias remains the dispatcher and registration
 * contract while context-aware handlers are staged separately below.
 */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Per-call authority supplied by the host-request dispatcher.
 * `requestId` is an opaque host-minted correlation token and `isCurrent()`
 * lets an implementation reject work after its authority is revoked.
 */
export interface HostRequestContext {
	readonly requestId: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

const hostRequestHandlerBrand = Symbol("hostRequestHandler");

/** A context-aware implementation that must receive dispatcher authority. */
export type HostRequestHandlerImplementation = (
	payload: Record<string, unknown>,
	context: HostRequestContext,
) => Promise<Record<string, unknown>>;

/** A factory-minted, context-aware host-request handler capability. */
type HostRequestHandlerCapability = HostRequestHandlerImplementation & { readonly [hostRequestHandlerBrand]: true };

/** Runtime provenance cannot be recreated by copying the nominal symbol property. */
const factoryCreatedHostRequestHandlers = new WeakSet<object>();

function assertGenuineHostRequestContext(context: unknown): asserts context is HostRequestContext {
	if (
		typeof context !== "object" ||
		context === null ||
		typeof (context as HostRequestContext).requestId !== "string" ||
		!(context as HostRequestContext).requestId ||
		!Number.isSafeInteger((context as HostRequestContext).generation) ||
		typeof (context as HostRequestContext).isCurrent !== "function" ||
		typeof (context as HostRequestContext).signal !== "object" ||
		(context as HostRequestContext).signal === null ||
		typeof (context as HostRequestContext).signal.aborted !== "boolean" ||
		typeof (context as HostRequestContext).signal.addEventListener !== "function"
	) {
		throw new Error("host request context is invalid");
	}
}

/**
 * Creates a branded wrapper rather than mutating its implementation. Both its
 * generic shape and runtime arity reject unary callbacks before they can run.
 */
export function createHostRequestHandler<T extends HostRequestHandlerImplementation>(
	implementation: T,
	..._unaryRejection: Parameters<T> extends [unknown, unknown, ...unknown[]]
		? []
		: ["host request handlers must accept payload and context"]
): HostRequestHandlerCapability {
	if (implementation.length < 2) throw new Error("host request handlers must accept payload and context");
	const handler = async (payload: Record<string, unknown>, context: HostRequestContext) => {
		assertGenuineHostRequestContext(context);
		return implementation(payload, context);
	};
	factoryCreatedHostRequestHandlers.add(handler);
	return Object.defineProperty(handler, hostRequestHandlerBrand, { value: true }) as HostRequestHandlerCapability;
}

/** Reject copied-symbol and raw-function forgeries before they observe authenticated payloads. */
export function assertHostRequestHandler(value: unknown): asserts value is HostRequestHandlerCapability {
	if (
		typeof value !== "function" ||
		(value as Partial<HostRequestHandlerCapability>)[hostRequestHandlerBrand] !== true ||
		!factoryCreatedHostRequestHandlers.has(value)
	) {
		throw new Error("host request handler is not a dispatcher-created capability");
	}
}

/** Host request handlers keyed by request type (e.g. "rlm.run", "goal.complete"). */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

/** Where and how to persist the kernel's user namespace so it survives resume. */
export interface KernelSnapshotConfig {
	/** Absolute path for the dill payload. */
	path: string;
	/** Absolute path for the JSON manifest written alongside the payload. */
	manifestPath: string;
	/** Maximum aggregate snapshot size. Default 256 MiB. */
	maxBytes?: number;
	/** Maximum serialized size of one variable. Default 16 MiB. */
	maxVariableBytes?: number;
	/** Debounce window for the auto-snapshot after a successful execution. Default 1500 ms. */
	debounceMs?: number;
}

export interface KernelManagerOptions {
	/** Python interpreter that has `ipykernel` available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Default: "prime-agent". */
	username?: string;
}

export interface KernelStartOptions {
	onBootstrapProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel via the control channel. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: KernelSentAgentMessage) => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
	/** Synthetic host cell (snapshot/restore/list); excluded from lastCellCode attribution. */
	internal?: boolean;
}

/** MIME tag the `edit` skill emits diff payloads under, via `display_data`. */
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** MIME tag the `attach-image` skill emits media payloads under, via `display_data`. */
export const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";

/** MIME tag the `agent-message` skill emits after sending a message. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

/**
 * Hard ceiling on a single attachment's base64 payload, a defensive guard
 * against a runaway direct `display_data` emit. The `attach-image` skill caps
 * its own images well under this (see `_MAX_IMAGE_BYTES`), so a skill-produced
 * attachment is never dropped here — only a non-skill emit can hit this.
 */
const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

/** One file edit, captured from a {@link DIFF_DISPLAY_MIME} display payload. */
export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file, for absolute line numbers. */
	startLine?: number;
}

/** One media attachment, captured from an {@link ATTACHMENT_DISPLAY_MIME} display payload. */
export interface KernelAttachment {
	mimeType: string;
	/** base64-encoded bytes. */
	data: string;
	/** Source path, surfaced to the TUI renderer. */
	path?: string;
}

export interface KernelSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Last `execute_result` payload (text/plain), if the cell produced one. */
	result?: string;
	/** Diffs emitted via display_data, in order. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments emitted via display_data, in order. */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell, in order. */
	sentAgentMessages?: KernelSentAgentMessage[];
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

/** Parse a {@link DIFF_DISPLAY_MIME} payload, tolerating malformed input. */
function parseDiffDisplay(payload: unknown): KernelDiffDisplay | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}
	const { path, old_str: oldStr, new_str: newStr, start_line: startLine } = payload;
	if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") {
		return undefined;
	}
	return { path, oldStr, newStr, startLine: typeof startLine === "number" ? startLine : undefined };
}

/**
 * Parse an {@link ATTACHMENT_DISPLAY_MIME} payload. Malformed payloads are
 * tolerantly ignored (`undefined`); a well-formed payload exceeding
 * {@link MAX_ATTACHMENT_DATA_CHARS} is reported as `"oversized"` so the caller
 * can fail the cell loudly rather than silently dropping the image.
 */
function parseAttachmentDisplay(payload: unknown): KernelAttachment | "oversized" | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}
	const { mime_type: mimeType, data, path } = payload;
	if (typeof mimeType !== "string" || typeof data !== "string") {
		return undefined;
	}
	if (data.length > MAX_ATTACHMENT_DATA_CHARS) {
		return "oversized";
	}
	return { mimeType, data, path: typeof path === "string" ? path : undefined };
}

function parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {
	if (!isRecord(payload) || !isRecord(payload.target)) {
		return undefined;
	}
	const { id, message, deliveryStatus, receiverRole, target } = payload;
	const { activeSessionId, sessionId, sessionName } = target;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		typeof activeSessionId !== "string" ||
		typeof sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(receiverRole === "parent" || receiverRole === "sibling" || receiverRole === "child" ? { receiverRole } : {}),
		target: {
			activeSessionId,
			sessionId,
			...(typeof sessionName === "string" ? { sessionName } : {}),
		},
	};
}

function createKernelStartupAbortError(): Error {
	return new Error("Kernel startup aborted");
}

function raceStartupWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(createKernelStartupAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(createKernelStartupAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

interface ConnectionInfo {
	ip: string;
	transport: "tcp";
	shell_port: number;
	iopub_port: number;
	stdin_port: number;
	control_port: number;
	hb_port: number;
	signature_scheme: "hmac-sha256";
	key: string;
	kernel_name: string;
}

interface JupyterMessage {
	header: {
		msg_id: string;
		session: string;
		username: string;
		date: string;
		msg_type: string;
		version: string;
	};
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface ActiveExecution {
	requestMsgId: string;
	/** Source of the cell currently executing; surfaced to rlm.run spawns. */
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	diffs: KernelDiffDisplay[];
	attachments: KernelAttachment[];
	sentAgentMessages: KernelSentAgentMessage[];
	error?: ExecuteResult["error"];
	status: ExecuteResult["status"];
	settled: boolean;
	resolve: (result: ExecuteResult) => void;
	reject: (error: Error) => void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function buildMessage(
	msgType: string,
	content: Record<string, unknown>,
	session: string,
	username: string,
): JupyterMessage {
	return {
		header: {
			msg_id: uuid(),
			session,
			username,
			date: new Date().toISOString(),
			msg_type: msgType,
			version: PROTOCOL_VERSION,
		},
		parent_header: {},
		metadata: {},
		content,
	};
}

function sign(parts: Buffer[], key: string): Buffer {
	const hmac = createHmac("sha256", key);
	for (const p of parts) hmac.update(p);
	return Buffer.from(hmac.digest("hex"));
}

function encode(msg: JupyterMessage, key: string): Buffer[] {
	const parts = [
		Buffer.from(JSON.stringify(msg.header)),
		Buffer.from(JSON.stringify(msg.parent_header)),
		Buffer.from(JSON.stringify(msg.metadata)),
		Buffer.from(JSON.stringify(msg.content)),
	];
	return [DELIM, sign(parts, key), ...parts];
}

function decode(frames: Buffer[]): JupyterMessage | null {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	if (i + 5 >= frames.length) return null;
	try {
		return {
			header: JSON.parse(frames[i + 2].toString()),
			parent_header: JSON.parse(frames[i + 3].toString()),
			metadata: JSON.parse(frames[i + 4].toString()),
			content: JSON.parse(frames[i + 5].toString()),
		};
	} catch {
		return null;
	}
}

const CONNECTION_PORT_KEYS = ["shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"] as const;

function hasResolvedPorts(info: ConnectionInfo): boolean {
	return CONNECTION_PORT_KEYS.every((key) => Number.isInteger(info[key]) && info[key] > 0);
}

function parseConnectionInfo(value: unknown): ConnectionInfo | null {
	if (!isRecord(value)) return null;
	if (value.ip !== "127.0.0.1") return null;
	if (value.transport !== "tcp") return null;
	if (value.signature_scheme !== "hmac-sha256") return null;
	if (typeof value.key !== "string") return null;
	const shellPort = value.shell_port;
	const iopubPort = value.iopub_port;
	const stdinPort = value.stdin_port;
	const controlPort = value.control_port;
	const hbPort = value.hb_port;
	if (typeof shellPort !== "number" || !Number.isInteger(shellPort)) return null;
	if (typeof iopubPort !== "number" || !Number.isInteger(iopubPort)) return null;
	if (typeof stdinPort !== "number" || !Number.isInteger(stdinPort)) return null;
	if (typeof controlPort !== "number" || !Number.isInteger(controlPort)) return null;
	if (typeof hbPort !== "number" || !Number.isInteger(hbPort)) return null;
	const kernelName = typeof value.kernel_name === "string" ? value.kernel_name : "python3";
	return {
		ip: value.ip,
		transport: value.transport,
		shell_port: shellPort,
		iopub_port: iopubPort,
		stdin_port: stdinPort,
		control_port: controlPort,
		hb_port: hbPort,
		signature_scheme: value.signature_scheme,
		key: value.key,
		kernel_name: kernelName,
	};
}

function readConnectionInfo(path: string): ConnectionInfo | null {
	try {
		return parseConnectionInfo(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

function makeConnection(): { info: ConnectionInfo; path: string; tempDir: string } {
	const info: ConnectionInfo = {
		ip: "127.0.0.1",
		transport: "tcp",
		shell_port: 0,
		iopub_port: 0,
		stdin_port: 0,
		control_port: 0,
		hb_port: 0,
		signature_scheme: "hmac-sha256",
		key: randomBytes(16).toString("hex"),
		kernel_name: "python3",
	};
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-"));
	const path = join(tempDir, "connection.json");
	writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
	return { info, path, tempDir };
}

const liveKernels = new Set<KernelManager>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const k of liveKernels) {
		if (!sessionId || k.ownerSessionId === sessionId) {
			void k.dispose();
		}
	}
});

function installSignalHandlersOnce(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;

	const asyncShutdown = async (): Promise<void> => {
		// These paths can await, so flush the namespace snapshot before tearing down.
		await Promise.allSettled([...liveKernels].map((k) => k.shutdown({ snapshot: true })));
	};

	// `beforeExit` and signal handlers can await async cleanup. `exit`
	// can only do sync work (Node won't run pending microtasks past it),
	// so it falls back to `disposeSync()` which kills the child synchronously.
	process.on("beforeExit", () => {
		void asyncShutdown();
	});
	process.on("SIGINT", () => {
		void asyncShutdown().finally(() => process.exit(130));
	});
	process.on("SIGTERM", () => {
		void asyncShutdown().finally(() => process.exit(143));
	});
	process.on("exit", () => {
		for (const k of liveKernels) k.disposeSync();
	});
}

export class KernelManager {
	private readonly options: Pick<
		KernelManagerOptions,
		"python" | "cwd" | "env" | "sessionId" | "hostHandlers" | "pythonSkills" | "snapshot"
	> &
		Required<Pick<KernelManagerOptions, "username">>;
	private readonly session = uuid();
	private readonly commTargets = new Map<string, string>();
	private readonly handledHostRequestCommIds = new Set<string>();
	private kernel?: ChildProcess;
	// Set instead of `kernel` for forkserver-forked kernels (not our child):
	// signaling/liveness go through the forkserver, never process.kill.
	private forkedKernel?: ForkedKernelHandle;
	/** Polls a forked kernel for death (no "exit" event on a non-child). */
	private forkedLivenessTimer?: ReturnType<typeof globalThis.setInterval>;
	private forkedLivenessProbeInFlight = false;
	private shell?: Dealer;
	private iopub?: Subscriber;
	private control?: Dealer;
	private iopubPumpPromise?: Promise<void>;
	private controlPumpPromise?: Promise<void>;
	private readonly pendingControlReplies = new Map<string, (message: JupyterMessage) => void>();
	private connection?: ConnectionInfo;
	private tempDir?: string;
	private kernelStderr = "";
	/** Serializes execute() calls — Jupyter shell channel is request/reply. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly activeExecutionIdleWaiters = new Set<() => void>();
	private readonly lateSentAgentMessageHandlers = new Map<string, (message: KernelSentAgentMessage) => void>();
	// Source of the most recently started cell, retained after it finishes so
	// rlm.run spawns from detached asyncio tasks (cell already idle) can still
	// attribute their spawning program.
	private lastCellCode?: string;
	private readonly inFlightHostRequests = new Set<Promise<void>>();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.snapshot,
			username: options.username ?? "prime-agent",
		};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	private appendKernelDiagnostic(message: string): void {
		this.kernelStderr += `[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`;
	}

	async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) {
			throw createKernelStartupAbortError();
		}
		if (!this.startPromise) {
			const startPromise = this.doStart({ onBootstrapProgress: options.onBootstrapProgress }).catch((error) => {
				// Only clear our own memoization: a stale start must not evict a newer one.
				if (this.startPromise === startPromise) this.startPromise = undefined;
				throw error;
			});
			this.startPromise = startPromise;
		}
		return raceStartupWithAbort(this.startPromise, options.signal);
	}

	private async doStart(startOptions: KernelStartOptions): Promise<void> {
		if (this.state !== "idle") return;
		const generation = ++this.startGeneration;
		this.state = "starting";
		installSignalHandlersOnce();
		// Tracked from the moment startup begins so session cleanup and signal
		// handlers can dispose a kernel that is still booting.
		liveKernels.add(this);

		let python: string;
		try {
			python =
				this.options.python ??
				(await ensureKernelPython({
					pythonSkills: this.options.pythonSkills,
					onProgress: startOptions.onBootstrapProgress,
				}));
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.options.python = python;
		} catch (error) {
			if (this.startStale(generation)) throw error; // never touch a newer start's state
			liveKernels.delete(this);
			if ((this.state as string) !== "shutdown") this.state = "idle";
			throw error;
		}

		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel was disposed during startup");
		}

		let connection = makeConnection();
		this.tempDir = connection.tempDir;

		// Fast path: fork a pre-imported kernel from the forkserver. Any failure
		// (disabled, unavailable, fork error) degrades to the direct-spawn path so
		// correctness never depends on fork.
		let forked = false;
		if (isForkServerEnabled()) {
			try {
				const handle = await forkKernel(python, {
					connectionPath: connection.path,
					cwd: this.options.cwd,
					// Applied fresh in the child (the template's env snapshot may be stale).
					// No JPY_PARENT_PID: forked children watch the forkserver by getppid().
					env: { ...process.env, ...this.options.env },
				});
				if (this.startStale(generation)) {
					// Nobody owns this kernel; the protocol kill is id-keyed and safe.
					void handle.kill("TERM").catch(() => {});
					throw new Error("Kernel start superseded");
				}
				this.forkedKernel = handle;
				recordOrphanProcessState(handle.pid, true);
				forked = true;
			} catch (err) {
				if (this.startStale(generation)) throw err; // never touch a newer start's state
				if (!(err instanceof ForkServerUnavailable)) throw err;
				this.appendKernelDiagnostic(`forkserver unavailable, spawning directly: ${err.message}`);
				this.forkedKernel = undefined;
				// A fork request that times out or loses its pid reply may still have
				// forked a child that binds the ports in this connection file. Mint a
				// fresh connection for the direct spawn so a possible orphan can never
				// collide with it (write the same file / re-bind the same ports).
				try {
					rmSync(connection.tempDir, { recursive: true, force: true });
				} catch {
					// Leave temporary kernel files for OS cleanup.
				}
				// A failed fork may leave stale ports; retry with a fresh connection file.
				connection = makeConnection();
				this.tempDir = connection.tempDir;
			}
		}

		if (!forked) {
			const kernel = spawn(python, ["-m", "ipykernel_launcher", "-f", connection.path], {
				cwd: this.options.cwd,
				// ipykernel's parent poller exits the kernel if this pid dies (covers SIGKILL of the owner).
				env: { ...process.env, ...this.options.env, JPY_PARENT_PID: String(process.pid) },
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.kernel = kernel;
			if (kernel.pid !== undefined) recordOrphanProcessState(kernel.pid, true);

			kernel.stderr?.on("data", (buf: Buffer) => {
				const s = buf.toString();
				this.kernelStderr += s;
			});

			kernel.on("error", (err) => {
				if (this.kernel !== kernel) return;
				this.appendKernelDiagnostic(`spawn error: ${err.message}`);
				this.state = "shutdown";
				liveKernels.delete(this);
				this.cleanupResources();
			});

			kernel.on("exit", (code, signal) => {
				if (this.kernel !== kernel) return;
				if (this.state !== "shutdown") {
					this.appendKernelDiagnostic(`unexpected exit code=${code} signal=${signal}`);
				}
				this.state = "shutdown";
				liveKernels.delete(this);
				this.cleanupResources();
			});
		}

		const connectionPath = connection.path;
		let conn: ConnectionInfo;
		try {
			conn = await this.waitForResolvedConnection(connectionPath);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.connection = conn;
		} catch (e) {
			if (this.startStale(generation)) throw e; // never tear down a newer start's kernel
			const canRetryStartup = (this.state as string) !== "shutdown";
			// Only the call that performed the cleanup may resurrect to idle; a
			// concurrent kill()/teardown owns the state otherwise.
			if ((await this.shutdown()) && canRetryStartup) this.state = "idle";
			throw e;
		}

		this.shell = new Dealer();
		this.iopub = new Subscriber();
		this.control = new Dealer();
		this.shell.connect(`${conn.transport}://${conn.ip}:${conn.shell_port}`);
		this.iopub.connect(`${conn.transport}://${conn.ip}:${conn.iopub_port}`);
		this.control.connect(`${conn.transport}://${conn.ip}:${conn.control_port}`);
		this.iopub.subscribe("");
		this.startControlPump();

		// ZMQ PUB/SUB slow-joiner: give the subscription a brief chance to reach the kernel before first execute.
		await sleep(IOPUB_SUBSCRIBE_DELAY_MS);
		if (this.startStale(generation)) throw new Error("Kernel start superseded");
		this.startIopubPump();

		try {
			await this.probeReady();
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
		} catch (e) {
			if (this.startStale(generation)) throw e; // never tear down a newer start's kernel
			const canRetryStartup = (this.state as string) !== "shutdown";
			// Only the call that performed the cleanup may resurrect to idle; a
			// concurrent kill()/teardown owns the state otherwise.
			if ((await this.shutdown()) && canRetryStartup) this.state = "idle";
			throw e;
		}

		this.state = "running";
		this.startForkedLivenessMonitor();
	}

	/** True when a teardown (or newer start) superseded the start that captured `generation`. */
	private startStale(generation: number): boolean {
		return generation !== this.startGeneration;
	}

	// No "exit" event fires for a non-child; poll the forkserver so a mid-run
	// death tears down like the direct-spawn exit handler.
	private startForkedLivenessMonitor(): void {
		if (!this.forkedKernel) return;
		this.forkedLivenessTimer = globalThis.setInterval(() => {
			void this.checkForkedKernelDeath();
		}, FORKED_LIVENESS_POLL_MS);
		this.forkedLivenessTimer.unref?.();
	}

	private async checkForkedKernelDeath(): Promise<void> {
		if (this.state !== "running" || this.forkedLivenessProbeInFlight) return;
		const probed = this.forkedKernel;
		this.forkedLivenessProbeInFlight = true;
		try {
			if (!(await this.forkedKernelDead(probed))) return;
		} finally {
			this.forkedLivenessProbeInFlight = false;
		}
		// Re-check after the await: teardown or a restart may have raced this poll.
		if (this.state !== "running" || this.forkedKernel !== probed) return;
		this.appendKernelDiagnostic("forked kernel exited unexpectedly");
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources();
	}

	// Liveness from the forkserver's reap table; a pid-0 probe would race reuse.
	// `timeoutMs` bounds the probe (timeout counts as alive so the caller's own
	// deadline decides); without it the protocol request timeout applies.
	private async forkedKernelDead(probed: ForkedKernelHandle | undefined, timeoutMs?: number): Promise<boolean> {
		if (!probed) return false;
		try {
			const alive = probed.isAlive();
			if (timeoutMs === undefined) return !(await alive);
			alive.catch(() => {}); // absorb a rejection that lands after the race is lost
			return !(await Promise.race([alive, sleep(timeoutMs, true, { ref: false })]));
		} catch (error) {
			// A timeout is unknown liveness, not proven death (the forkserver may just be stalled in a slow fork).
			if (error instanceof ForkServerUnavailable && error.timedOut) return false;
			// Forkserver gone: its kernels' parent_handle watchdogs exit them too.
			return true;
		}
	}

	private async waitForResolvedConnection(connectionPath: string): Promise<ConnectionInfo> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < PORTS_RESOLVE_TIMEOUT_MS) {
			const remainingBudget = PORTS_RESOLVE_TIMEOUT_MS - (Date.now() - startedAt);
			if (
				(this.state as string) === "shutdown" ||
				(await this.forkedKernelDead(this.forkedKernel, remainingBudget))
			) {
				const tail = this.kernelStderr.slice(-1024);
				throw new Error(`Kernel exited before resolving ports. stderr:\n${tail || "(empty)"}`);
			}

			const info = readConnectionInfo(connectionPath);
			if (info && hasResolvedPorts(info)) {
				return info;
			}

			await sleep(25);
		}

		const tail = this.kernelStderr.slice(-1024);
		throw new Error(
			`Kernel did not resolve connection ports within ${PORTS_RESOLVE_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
		);
	}

	private async probeReady(): Promise<void> {
		const conn = this.connection!;
		const shell = this.shell!;

		const msg = buildMessage("kernel_info_request", {}, this.session, this.options.username);
		const requestMsgId = msg.header.msg_id;
		await this.translateSocketClosure(shell.send(encode(msg, conn.key)));

		const startedAt = Date.now();
		while (Date.now() - startedAt < READY_TIMEOUT_MS) {
			const remainingBudget = READY_TIMEOUT_MS - (Date.now() - startedAt);
			if (
				(this.state as string) === "shutdown" ||
				(await this.forkedKernelDead(this.forkedKernel, remainingBudget))
			) {
				const tail = this.kernelStderr.slice(-1024);
				throw new Error(`Kernel exited during startup. stderr:\n${tail || "(empty)"}`);
			}

			const remaining = READY_TIMEOUT_MS - (Date.now() - startedAt);
			const winner = await Promise.race([
				this.translateSocketClosure(shell.receive()).then((frames) => ({ kind: "frames" as const, frames })),
				sleep(remaining).then(() => ({ kind: "timeout" as const })),
			]);
			if (winner.kind === "timeout") break;

			const incoming = decode(winner.frames);
			if (
				incoming?.header.msg_type === "kernel_info_reply" &&
				(incoming.parent_header as { msg_id?: string }).msg_id === requestMsgId
			) {
				return;
			}
		}
		const tail = this.kernelStderr.slice(-1024);
		throw new Error(
			`Kernel did not respond to kernel_info_request within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
		);
	}

	/**
	 * A zmq operation interrupted by socket teardown rejects with the raw libzmq
	 * EAGAIN text ("Operation was not possible or timed out"); surface the kernel
	 * lifecycle instead so callers see an actionable, retriable failure.
	 */
	private async translateSocketClosure<T>(operation: Promise<T>): Promise<T> {
		try {
			return await operation;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("not possible or timed out") || message.includes("Socket is closed")) {
				const tail = this.kernelStderr.slice(-1024);
				throw new Error(
					`IPython kernel channel closed while ${this.state === "starting" ? "starting up" : "communicating"} (retriable). stderr tail:\n${tail || "(empty)"}`,
				);
			}
			throw error;
		}
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		const result = await this.enqueueExecute(code, opts);
		// Refresh the on-disk snapshot after real work so a later resume (or a
		// crash before graceful shutdown) revives the most recent namespace.
		if (result.status === "ok") {
			this.scheduleSnapshot();
		}
		return result;
	}

	/** Queue and run a cell, serializing against all other executions. */
	private async enqueueExecute(
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<ExecuteResult> {
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		await this.start({ signal: opts.signal });
		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel has been shut down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		let executionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			await this.waitForActiveExecutionToClearForReuse(opts.signal);
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			if (executionTimeoutMs === undefined) {
				return await this.executeInner(code, opts, started);
			}

			const controller = new AbortController();
			executionTimeout = globalThis.setTimeout(() => controller.abort(), executionTimeoutMs);
			executionTimeout.unref?.();
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			return await this.executeInner(code, { ...opts, signal }, started);
		} finally {
			if (executionTimeout) globalThis.clearTimeout(executionTimeout);
			resolveNext();
		}
	}

	private async executeInner(code: string, opts: ExecuteOptions, started: number): Promise<ExecuteResult> {
		const conn = this.connection!;
		const shell = this.shell!;
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

		const msg = buildMessage(
			"execute_request",
			{
				code,
				silent: false,
				store_history: true,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			this.session,
			this.options.username,
		);
		const requestMsgId = msg.header.msg_id;

		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
		}
		if (this.activeExecution) {
			throw new Error("Kernel already has an active execution");
		}

		const result = createDeferred<ExecuteResult>();
		const execution: ActiveExecution = {
			requestMsgId,
			code,
			started,
			maxChars,
			opts,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			diffs: [],
			attachments: [],
			sentAgentMessages: [],
			status: "ok",
			settled: false,
			resolve: result.resolve,
			reject: result.reject,
		};
		let abortTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const clearAbortTimer = () => {
			if (abortTimer) {
				globalThis.clearTimeout(abortTimer);
				abortTimer = undefined;
			}
		};
		const forceAbort = () => {
			if (this.activeExecution !== execution) {
				return;
			}
			execution.status = "aborted";
			this.resolveExecution(execution, { clearActive: false });
		};
		const onAbort = () => {
			void this.interrupt().catch(() => undefined);
			clearAbortTimer();
			abortTimer = globalThis.setTimeout(forceAbort, KERNEL_ABORT_GRACE_MS);
			if (abortTimer && typeof abortTimer === "object" && "unref" in abortTimer) {
				abortTimer.unref();
			}
		};

		try {
			this.activeExecution = execution;
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts.signal?.aborted) {
				onAbort();
			}
			if (!opts.internal) {
				this.lastCellCode = code;
			}
			try {
				const sendPromise = this.translateSocketClosure(shell.send(encode(msg, conn.key)));
				sendPromise.catch(() => undefined);
				await Promise.race([sendPromise, result.promise.then(() => undefined)]);
				if (this.activeExecution === execution && execution.status !== "aborted") {
					await sendPromise;
				}
			} catch (error) {
				if (this.activeExecution === execution) {
					this.activeExecution = undefined;
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
			return await result.promise;
		} finally {
			clearAbortTimer();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	private startControlPump(): void {
		if (this.controlPumpPromise) return;
		this.controlPumpPromise = this.runControlPump();
	}

	private async runControlPump(): Promise<void> {
		const control = this.control;
		if (!control) return;
		try {
			for await (const frames of control) {
				const incoming = decode(frames);
				if (!incoming) continue;
				const parentMessageId = (incoming.parent_header as { msg_id?: string }).msg_id;
				if (!parentMessageId) continue;
				this.pendingControlReplies.get(parentMessageId)?.(incoming);
			}
		} catch (error) {
			if ((this.state as string) !== "shutdown") {
				this.appendKernelDiagnostic(`control pump failed: ${errorMessage(error)}`);
			}
		} finally {
			if (this.control === control) this.controlPumpPromise = undefined;
		}
	}

	private waitForControlReply(
		requestMessageId: string,
		messageType: string,
		timeoutMs: number,
	): { promise: Promise<void>; cancel: () => void } {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		let settled = false;
		const cleanup = () => {
			if (timeout) globalThis.clearTimeout(timeout);
			timeout = undefined;
			this.pendingControlReplies.delete(requestMessageId);
		};
		const promise = new Promise<void>((resolve, reject) => {
			this.pendingControlReplies.set(requestMessageId, (incoming) => {
				if (incoming.header.msg_type !== messageType || settled) return;
				settled = true;
				cleanup();
				resolve();
			});
			timeout = globalThis.setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(`Kernel did not reply to ${messageType} within ${timeoutMs}ms`));
			}, timeoutMs);
			timeout.unref?.();
		});
		return {
			promise,
			cancel: () => {
				if (settled) return;
				settled = true;
				cleanup();
			},
		};
	}

	private startIopubPump(): void {
		if (this.iopubPumpPromise) {
			return;
		}
		this.iopubPumpPromise = this.runIopubPump();
	}

	private async runIopubPump(): Promise<void> {
		const iopub = this.iopub;
		if (!iopub) {
			return;
		}

		try {
			for await (const frames of iopub) {
				const incoming = decode(frames);
				if (!incoming) continue;
				const t = incoming.header.msg_type;
				if (t === "comm_open" || t === "comm_msg" || t === "comm_close") {
					this.handleCommMessage(incoming);
					continue;
				}
				this.handleExecutionMessage(incoming);
			}
		} catch (error) {
			if ((this.state as string) !== "shutdown") {
				this.appendKernelDiagnostic(`iopub pump failed: ${errorMessage(error)}`);
				this.rejectActiveExecution(new Error(`Kernel IOPub channel failed: ${errorMessage(error)}`));
			}
		} finally {
			if (this.iopub === iopub) {
				this.iopubPumpPromise = undefined;
			}
		}
	}

	private handleExecutionMessage(incoming: JupyterMessage): void {
		const execution = this.activeExecution;
		const parentMessageId = (incoming.parent_header as { msg_id?: string }).msg_id;
		if (!execution || parentMessageId !== execution.requestMsgId) {
			if (incoming.header.msg_type === "display_data" || incoming.header.msg_type === "update_display_data") {
				const content = incoming.content as { data?: Record<string, unknown> };
				this.dispatchLateSentAgentMessage(parentMessageId, content.data?.[AGENT_MESSAGE_DISPLAY_MIME]);
			}
			return;
		}

		const t = incoming.header.msg_type;
		if (execution.settled && (t === "display_data" || t === "update_display_data")) {
			const content = incoming.content as { data?: Record<string, unknown> };
			if (this.dispatchLateSentAgentMessage(parentMessageId, content.data?.[AGENT_MESSAGE_DISPLAY_MIME])) {
				return;
			}
		}
		if (t === "stream") {
			const c = incoming.content as { name: "stdout" | "stderr"; text: string };
			if (c.name === "stdout") {
				if (execution.stdout.length < execution.maxChars) {
					execution.stdout += c.text;
					if (execution.stdout.length > execution.maxChars) {
						execution.stdout = execution.stdout.slice(0, execution.maxChars);
						execution.stdoutTruncated = true;
					}
				}
			} else if (c.name === "stderr") {
				if (execution.stderr.length < execution.maxChars) {
					execution.stderr += c.text;
					if (execution.stderr.length > execution.maxChars) {
						execution.stderr = execution.stderr.slice(0, execution.maxChars);
						execution.stderrTruncated = true;
					}
				}
			}
			execution.opts.onStream?.(c.text, c.name);
		} else if (t === "execute_result") {
			const c = incoming.content as { data: Record<string, string> };
			if (c.data["text/plain"]) execution.result = c.data["text/plain"];
		} else if (t === "display_data" || t === "update_display_data") {
			const c = incoming.content as { data?: Record<string, unknown> };
			const diff = parseDiffDisplay(c.data?.[DIFF_DISPLAY_MIME]);
			if (diff) execution.diffs.push(diff);
			const attachment = parseAttachmentDisplay(c.data?.[ATTACHMENT_DISPLAY_MIME]);
			if (attachment === "oversized") {
				execution.stderr += `${execution.stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				execution.status = "error";
			} else if (attachment) {
				execution.attachments.push(attachment);
			}
			const sentAgentMessage = parseSentAgentMessage(c.data?.[AGENT_MESSAGE_DISPLAY_MIME]);
			if (sentAgentMessage) execution.sentAgentMessages.push(sentAgentMessage);
		} else if (t === "error") {
			const c = incoming.content as { ename: string; evalue: string; traceback: string[] };
			execution.error = c;
			execution.status = "error";
		} else if (t === "status") {
			const c = incoming.content as { execution_state: string };
			if (c.execution_state === "idle") {
				this.finishActiveExecution(execution);
			}
		}
	}

	private finishActiveExecution(execution: ActiveExecution): void {
		if (this.activeExecution !== execution) {
			return;
		}
		this.resolveExecution(execution, { clearActive: true });
	}

	private resolveExecution(execution: ActiveExecution, options: { clearActive: boolean }): void {
		const didClearActive = options.clearActive && this.activeExecution === execution;
		if (options.clearActive && this.activeExecution === execution) {
			this.activeExecution = undefined;
		}
		if (!execution.settled) {
			execution.settled = true;
			if (execution.opts.onLateSentAgentMessage) {
				this.registerLateSentAgentMessageHandler(execution.requestMsgId, execution.opts.onLateSentAgentMessage);
			}

			let stdout = execution.stdout;
			let stderr = execution.stderr;
			let result = execution.result;
			let status = execution.status;
			if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (result !== undefined && result.length > execution.maxChars) {
				result = `${result.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
			}

			if (execution.opts.signal?.aborted) status = "aborted";

			execution.resolve({
				stdout,
				stderr,
				result,
				diffs: execution.diffs.length > 0 ? execution.diffs : undefined,
				attachments: execution.attachments.length > 0 ? execution.attachments : undefined,
				sentAgentMessages: execution.sentAgentMessages.length > 0 ? execution.sentAgentMessages : undefined,
				error: execution.error,
				status,
				durationMs: Date.now() - execution.started,
			});
		}
		if (didClearActive) {
			this.notifyActiveExecutionIdle();
		}
	}

	private dispatchLateSentAgentMessage(parentMessageId: string | undefined, value: unknown): boolean {
		const sentAgentMessage = parseSentAgentMessage(value);
		if (!sentAgentMessage || !parentMessageId) {
			return false;
		}
		const handler = this.lateSentAgentMessageHandlers.get(parentMessageId);
		if (!handler) {
			return false;
		}
		this.lateSentAgentMessageHandlers.delete(parentMessageId);
		this.lateSentAgentMessageHandlers.set(parentMessageId, handler);
		handler(sentAgentMessage);
		return true;
	}

	private registerLateSentAgentMessageHandler(
		requestMessageId: string,
		handler: (message: KernelSentAgentMessage) => void,
	): void {
		this.lateSentAgentMessageHandlers.set(requestMessageId, handler);
		while (this.lateSentAgentMessageHandlers.size > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS) {
			const oldestRequestMessageId = this.lateSentAgentMessageHandlers.keys().next().value;
			if (oldestRequestMessageId === undefined) {
				break;
			}
			this.lateSentAgentMessageHandlers.delete(oldestRequestMessageId);
		}
	}

	private rejectActiveExecution(error: Error): void {
		const execution = this.activeExecution;
		if (!execution) {
			return;
		}
		this.activeExecution = undefined;
		execution.reject(error);
		this.notifyActiveExecutionIdle();
	}

	private notifyActiveExecutionIdle(): void {
		for (const resolve of this.activeExecutionIdleWaiters) {
			resolve();
		}
		this.activeExecutionIdleWaiters.clear();
	}

	private waitForActiveExecutionToClear(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
		if (!this.activeExecution) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const finish = (cleared: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					globalThis.clearTimeout(timeout);
				}
				this.activeExecutionIdleWaiters.delete(onIdle);
				signal?.removeEventListener("abort", onAbort);
				resolve(cleared);
			};
			const onIdle = () => finish(true);
			const onAbort = () => finish(false);
			this.activeExecutionIdleWaiters.add(onIdle);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});
	}

	private async waitForActiveExecutionToClearForReuse(signal?: AbortSignal): Promise<void> {
		const started = Date.now();
		while (this.activeExecution && Date.now() - started < KERNEL_BUSY_REUSE_WAIT_MS) {
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			void this.interrupt().catch(() => undefined);
			const remaining = KERNEL_BUSY_REUSE_WAIT_MS - (Date.now() - started);
			const cleared = await this.waitForActiveExecutionToClear(
				signal,
				Math.max(1, Math.min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS, remaining)),
			);
			if (cleared || signal?.aborted) {
				return;
			}
		}
		if (this.activeExecution) {
			throw new KernelBusyAfterInterruptError();
		}
	}

	private handleCommMessage(incoming: JupyterMessage): void {
		const msgType = incoming.header.msg_type;
		const content = incoming.content;
		const commId = content.comm_id;
		if (typeof commId !== "string") {
			return;
		}

		if (msgType === "comm_close") {
			this.commTargets.delete(commId);
			this.handledHostRequestCommIds.delete(commId);
			return;
		}

		if (msgType === "comm_open") {
			const targetName = content.target_name;
			if (typeof targetName !== "string") {
				return;
			}
			this.commTargets.set(commId, targetName);
			if (targetName === HOST_COMM_TARGET) {
				this.startHostRequestFromComm(commId, content.data);
			}
			return;
		}

		const targetName = this.commTargets.get(commId);
		if (msgType === "comm_msg" && targetName === HOST_COMM_TARGET) {
			this.startHostRequestFromComm(commId, content.data);
		}
	}

	private startHostRequestFromComm(commId: string, data: unknown): void {
		if (this.handledHostRequestCommIds.has(commId)) {
			return;
		}
		this.handledHostRequestCommIds.add(commId);

		const task = (async () => {
			try {
				const result = await this.handleHostRequest(data);
				try {
					await this.sendCommMessage(commId, { status: "ok", ...result });
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request ok reply for comm ${commId}: ${errorMessage(replyError)}`,
					);
				}
			} catch (error) {
				this.appendKernelDiagnostic(`host request failed for comm ${commId}: ${errorMessage(error)}`);
				try {
					await this.sendCommMessage(commId, { status: "error", error: errorMessage(error) });
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request error reply for comm ${commId}: ${errorMessage(replyError)}`,
					);
				}
			}
		})();
		this.inFlightHostRequests.add(task);
		void task.finally(() => {
			this.inFlightHostRequests.delete(task);
		});
	}

	private async handleHostRequest(data: unknown): Promise<Record<string, unknown>> {
		if (!isRecord(data)) {
			throw new Error("host request payload must be an object");
		}
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}

		const handler = this.options.hostHandlers?.[data.type];
		if (!handler) {
			throw new Error(`host request type "${data.type}" is not available in this session`);
		}
		// Tag the request with the cell that triggered it. A blocking call is still
		// the in-flight execution; detached spawns (asyncio.create_task) fire after
		// the scheduling cell goes idle, so fall back to that last cell's source.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return handler({ ...data, cellSourceCode });
	}

	private async sendCommMessage(commId: string, data: Record<string, unknown>): Promise<void> {
		const channel = this.control ?? this.shell;
		if (!channel || !this.connection) {
			throw new Error("Kernel channel is not connected");
		}
		const msg = buildMessage("comm_msg", { comm_id: commId, data }, this.session, this.options.username);
		await channel.send(encode(msg, this.connection.key));
	}

	private async interrupt(): Promise<void> {
		if (!this.control || !this.connection) return;
		const msg = buildMessage("interrupt_request", {}, this.session, this.options.username);
		await this.control.send(encode(msg, this.connection.key));
	}

	private cleanupResources(killSignal: NodeJS.Signals = "SIGTERM"): void {
		this.startGeneration++; // any teardown invalidates in-flight starts
		this.clearSnapshotTimer();
		this.lateSentAgentMessageHandlers.clear();
		if (this.forkedLivenessTimer) {
			globalThis.clearInterval(this.forkedLivenessTimer);
			this.forkedLivenessTimer = undefined;
		}
		this.rejectActiveExecution(new Error("Kernel has been shut down"));
		this.shell?.close();
		this.iopub?.close();
		this.control?.close();
		this.pendingControlReplies.clear();
		this.shell = undefined;
		this.iopub = undefined;
		this.control = undefined;
		this.iopubPumpPromise = undefined;
		this.controlPumpPromise = undefined;
		if (this.kernel) {
			const directPid = this.kernel.pid;
			let signaled = false;
			try {
				signaled = this.kernel.kill(killSignal);
			} catch {
				// The kernel has already exited.
			}
			// Same rule as the forked branch below: inactive only when the signal proved the pid still ours.
			if (directPid !== undefined && signaled) recordOrphanProcessState(directPid, false);
		} else if (this.forkedKernel) {
			const forked = this.forkedKernel;
			// The journal is raw-pid keyed, so inactive is written only on "signaled"
			// — the one outcome proving the pid still named our un-reaped child. Any
			// other outcome leaves the record stale-active: the reaper's startId check
			// neutralizes it, while a wrong inactive write could mask a sibling's
			// record for a reused pid.
			void forked
				.kill(killSignal === "SIGKILL" ? "KILL" : "TERM")
				.then((outcome) => {
					if (outcome === "signaled") recordOrphanProcessState(forked.pid, false);
				})
				.catch(() => this.appendKernelDiagnostic("forkserver kill unconfirmed; leaving orphan record active"));
		}
		this.kernel = undefined;
		this.forkedKernel = undefined;
		this.connection = undefined;
		if (this.tempDir) {
			try {
				rmSync(this.tempDir, { recursive: true, force: true });
			} catch {
				// Leave temporary kernel files for OS cleanup.
			}
		}
		this.tempDir = undefined;
		this.startPromise = undefined;
	}

	private async waitForKernelExit(): Promise<void> {
		const kernel = this.kernel;
		if (kernel) {
			if (kernel.exitCode !== null || kernel.signalCode !== null) return;
			await new Promise<void>((resolve) => kernel.once("exit", () => resolve()));
			return;
		}
		const forked = this.forkedKernel;
		if (!forked) return;
		while (this.forkedKernel === forked && !(await this.forkedKernelDead(forked))) {
			await sleep(25);
		}
	}

	private async waitForHostRequestsToSettle(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) {
			globalThis.clearTimeout(timeout);
		}
		if (result === "timeout") {
			this.appendKernelDiagnostic(
				`timed out waiting ${timeoutMs}ms for ${tasks.length} host request task(s) during dispose`,
			);
		}
	}

	/** Resolves true when this call performed the cleanup (false: a concurrent teardown won). */
	async shutdown(opts: { snapshot?: boolean } = {}): Promise<boolean> {
		if (this.state === "shutdown") {
			liveKernels.delete(this);
			this.cleanupResources();
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		// Best-effort final flush (bounded) before teardown — used by signal handlers
		// so a SIGINT/SIGTERM exit doesn't lose work the debounced snapshot hasn't saved.
		if (opts.snapshot) {
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return false; // superseded mid-flush: the newer owner already cleaned this kernel
		}
		this.state = "shutdown";
		liveKernels.delete(this);

		let replyWait: { promise: Promise<void>; cancel: () => void } | undefined;
		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let performedCleanup = false;
		const shutdownDeadline = new Promise<never>((_resolve, reject) => {
			shutdownTimer = globalThis.setTimeout(
				() => reject(new Error(`Kernel did not shut down within ${KERNEL_SHUTDOWN_TIMEOUT_MS}ms`)),
				KERNEL_SHUTDOWN_TIMEOUT_MS,
			);
			shutdownTimer.unref?.();
		});
		try {
			if (this.control && this.connection) {
				const msg = buildMessage("shutdown_request", { restart: false }, this.session, this.options.username);
				replyWait = this.waitForControlReply(msg.header.msg_id, "shutdown_reply", KERNEL_SHUTDOWN_TIMEOUT_MS);
				const send = this.control.send(encode(msg, this.connection.key));
				send.catch(() => undefined);
				// A kernel that exits without delivering shutdown_reply must not stall the deadline.
				const kernelExit = this.waitForKernelExit();
				const gracefulReply = Promise.all([send, replyWait.promise]);
				// Abandoned by the race, a late send failure must not reject unhandled.
				gracefulReply.catch(() => undefined);
				await Promise.race([gracefulReply, kernelExit, shutdownDeadline]);
				await Promise.race([kernelExit, shutdownDeadline]);
			}
		} catch (error) {
			this.appendKernelDiagnostic(
				`graceful shutdown failed (killing instead): ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (shutdownTimer) globalThis.clearTimeout(shutdownTimer);
			replyWait?.cancel();
			// A superseded shutdown must not tear down the newer start's sockets. Ownership is decided
			// here, before cleanupResources bumps the generation and would misread this call as superseded.
			if (!this.startStale(generation)) {
				this.cleanupResources();
				performedCleanup = true;
			}
		}

		return performedCleanup;
	}

	async restart(): Promise<void> {
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		try {
			await this.shutdown();
			this.state = "idle";
			this.kernelStderr = "";
			await this.start();
		} finally {
			resolveNext();
		}
	}

	async kill(): Promise<void> {
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
	}

	/**
	 * Serialize the user namespace to disk (best-effort, per-variable). No-op when
	 * the kernel isn't running or no snapshot target was configured. Never throws.
	 */
	async snapshotState(): Promise<SnapshotResult | null> {
		return this.captureSnapshot();
	}

	/** Persist the namespace, then remove variables above the per-variable cap. */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		return this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, pruneOversized: true });
	}

	private async captureSnapshot(
		options: { executionTimeoutMs?: number; pruneOversized?: boolean } = {},
	): Promise<SnapshotResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg || !this.isRunning) return null;
		const code = buildSnapshotCode(
			cfg.path,
			cfg.manifestPath,
			cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
			cfg.maxVariableBytes ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
			options.pruneOversized,
		);
		try {
			const r = await this.enqueueExecute(
				code,
				{ maxOutputChars: SNAPSHOT_MAX_OUTPUT_CHARS, internal: true },
				options.executionTimeoutMs,
			);
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(
					`state snapshot ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return null;
			}
			return parseSnapshotResult(r.stdout, cfg.path);
		} catch (error) {
			this.appendKernelDiagnostic(`state snapshot error: ${errorMessage(error)}`);
			return null;
		}
	}

	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored. Never throws.
	 */
	async restoreState(): Promise<RestoreResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		const code = buildRestoreCode(cfg.path);
		try {
			const r = await this.enqueueExecute(code, { maxOutputChars: SNAPSHOT_MAX_OUTPUT_CHARS, internal: true });
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(`state restore failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
			return parseRestoreResult(r.stdout, cfg.path);
		} catch (error) {
			this.appendKernelDiagnostic(`state restore error: ${errorMessage(error)}`);
			return null;
		}
	}

	/** Live user-defined top-level names, or null if the kernel isn't running. Never throws. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.isRunning) return null;
		try {
			const r = await this.enqueueExecute(buildListNamesCode(), {
				maxOutputChars: SNAPSHOT_MAX_OUTPUT_CHARS,
				internal: true,
				signal,
			});
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(`namespace listing failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
			return parseListNamesResult(r.stdout);
		} catch (error) {
			this.appendKernelDiagnostic(`namespace listing error: ${errorMessage(error)}`);
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const cfg = this.options.snapshot;
		if (!cfg) return;
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = globalThis.setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		}, cfg.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		if (this.snapshotTimer && typeof this.snapshotTimer === "object" && "unref" in this.snapshotTimer) {
			this.snapshotTimer.unref();
		}
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}

	/** Best-effort final snapshot before a graceful dispose, bounded by a timeout. */
	private async flushSnapshotForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const guard = new Promise<void>((resolve) => {
			timeout = globalThis.setTimeout(resolve, SNAPSHOT_DISPOSE_TIMEOUT_MS);
			if (timeout && typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});
		try {
			await Promise.race([this.snapshotState().then(() => undefined), guard]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	/** Graceful cleanup. Waits briefly for in-flight host request handlers before closing sockets. */
	dispose(): Promise<void> {
		return (async () => {
			// Captured before any await: teardowns and newer starts bump the counter.
			const generation = this.startGeneration;
			// Final namespace flush while the kernel is still live (session end / reload).
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return; // superseded mid-flush: the newer owner already cleaned this kernel
			this.state = "shutdown";
			liveKernels.delete(this);
			const inFlightHostRequests = [...this.inFlightHostRequests];
			// TODO: plumb AbortSignal through AgentSession.prompt so disposal can cancel long-running child loops.
			try {
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_DISPOSE_TIMEOUT_MS);
				}
			} finally {
				if (!this.startStale(generation)) this.cleanupResources(); // else: superseded, the newer owner already cleaned
			}
		})();
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.state = "shutdown";
		liveKernels.delete(this);
		// TODO: replace this best-effort hard-exit path if Node exposes an awaitable process-exit cleanup hook.
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
