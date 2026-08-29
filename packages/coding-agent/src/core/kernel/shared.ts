import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { KernelBootstrapProgressHandler, KernelPythonSkill } from "./bootstrap.js";
import type { RestoreResult, SnapshotResult } from "./state-snapshot.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 65536;
export const HOST_REQUEST_SHUTDOWN_TIMEOUT_MS = 5000;
export const KERNEL_SHUTDOWN_TIMEOUT_MS = 5000;
export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
export const SNAPSHOT_EXECUTION_TIMEOUT_MS = 5000;
export const KERNEL_ABORT_GRACE_MS = 1000;
export const KERNEL_BUSY_REUSE_WAIT_MS = 5000;
export const KERNEL_BUSY_INTERRUPT_INTERVAL_MS = 500;
export const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS = 256;
const KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE =
	"The Python kernel is still running the previously interrupted cell. Wait and try again, or kill the kernel to start fresh.";

export class KernelBusyAfterInterruptError extends Error {
	constructor() {
		super(KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE);
		this.name = "KernelBusyAfterInterruptError";
	}
}

/**
 * Handles one typed request from Python code running in the kernel.
 * The returned record is delivered verbatim to the Python caller.
 */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

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
	/** Python interpreter with the kernel runtime available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Runtime bootstrap re-run on a protocol-repaired kernel so live handles (rlm, bash, skills) exist again. */
	bootstrapCode?: string;
}

export interface KernelStartOptions {
	onBootstrapProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel out-of-band. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: KernelSentAgentMessage) => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
	/** Synthetic host cell (snapshot/restore/list); excluded from lastCellCode attribution. */
	internal?: boolean;
	/** The protocol repair's own restore; exempt from waiting on the repair it belongs to. */
	protocolRepair?: boolean;
}

/** MIME tag the `edit` skill emits diff payloads under. */
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** MIME tag the `attach-image` skill emits media payloads under. */
export const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";

/** MIME tag the `agent-message` skill emits after sending a message. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

/**
 * Hard ceiling on a single attachment's base64 payload, a defensive guard
 * against a runaway direct display emit. The `attach-image` skill caps
 * its own images well under this (see `_MAX_IMAGE_BYTES`), so a skill-produced
 * attachment is never dropped here — only a non-skill emit can hit this.
 */
export const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

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
	/** Text of the cell's trailing expression value, if the cell produced one. */
	result?: string;
	/** Diffs emitted via display events, in order. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments emitted via display events, in order. */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell, in order. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** Output that arrived without this cell's id (user threads, other cells' leftovers, raw fd writes). */
	backgroundOutput?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

/** Parse a {@link DIFF_DISPLAY_MIME} payload, tolerating malformed input. */
export function parseDiffDisplay(payload: unknown): KernelDiffDisplay | undefined {
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
export function parseAttachmentDisplay(payload: unknown): KernelAttachment | "oversized" | undefined {
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

export function parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {
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

export function createKernelStartupAbortError(): Error {
	return new Error("Kernel startup aborted");
}

export function raceStartupWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

export interface KernelShutdownOptions {
	snapshot?: boolean;
	drainHostRequests?: boolean;
}

/** Public surface every kernel client exposes to the provisioner and session layer. */
export interface KernelClient {
	readonly ownerSessionId: string | undefined;
	readonly isRunning: boolean;
	start(options?: KernelStartOptions): Promise<void>;
	execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
	shutdown(opts?: KernelShutdownOptions): Promise<boolean>;
	restart(): Promise<void>;
	kill(): Promise<void>;
	disposeSync(): void;
	snapshotState(): Promise<SnapshotResult | null>;
	pruneOversizedVariables(): Promise<SnapshotResult | null>;
	restoreState(): Promise<RestoreResult | null>;
	listNamespaceNames(signal?: AbortSignal): Promise<string[] | null>;
}

// One registry serves every client kind; two parallel registries would
// double-install process signal handlers.
export const liveKernels = new Set<KernelClient>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const k of liveKernels) {
		if (!sessionId || k.ownerSessionId === sessionId) {
			void k.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}
});

export function installSignalHandlersOnce(): void {
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
