import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { v4 as uuid } from "uuid";
import { Dealer, Subscriber } from "zeromq";
import { recordOrphanProcessState } from "../orphan-process-journal.js";
import {
	recordWorkflowCheckpointBudgetTelemetry,
	type WorkflowCheckpointBudgetTelemetryHost,
	type WorkflowCheckpointBudgetTelemetryObservationInput,
} from "../workflow/checkpoint-budget-telemetry.js";
import { ensureKernelPython, type KernelBootstrapProgressHandler, type KernelPythonSkill } from "./bootstrap.js";
import { type ForkedKernelHandle, ForkServerUnavailable, forkKernel, isForkServerEnabled } from "./fork-server.js";
import {
	canonicalizeKernelWritablePath,
	createKernelContainer,
	KernelContainerCleanupError,
	KernelContainerCreationError,
	type KernelContainerIsolationOptions,
	KernelContainerOwnerCleanupError,
	removeKernelContainer,
	reserveKernelPorts,
	writeContainerConnectionFile,
} from "./isolation.js";

export type { KernelContainerIsolationOptions } from "./isolation.js";
export {
	KernelContainerCleanupError,
	KernelContainerCreationError,
	KernelContainerOwnerCleanupError,
} from "./isolation.js";

import {
	buildListNamesCode,
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	type KernelSnapshotRetainedValue,
	type KernelSnapshotRetentionClass,
	parseKernelStateError,
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
const MAX_EXECUTE_OUTPUT_CHARS = 1_000_000;
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
const KERNEL_TERMINATE_GRACE_MS = 2000;
const KERNEL_BUSY_REUSE_WAIT_MS = 5000;
const KERNEL_BUSY_INTERRUPT_INTERVAL_MS = 500;
const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS = 256;
const MAX_EXECUTION_COLLECTION_ITEMS = 256;
const MAX_KERNEL_STDERR_CHARS = 65_536;
const KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE =
	"IPython kernel is still running the previously interrupted cell. Wait and try again, or kill the IPython kernel to start fresh.";

export class KernelBusyAfterInterruptError extends Error {
	constructor() {
		super(KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE);
		this.name = "KernelBusyAfterInterruptError";
	}
}

/** Raised when a checkpoint cannot be committed or a persisted state cannot be verified. */
export class KernelSnapshotError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "KernelSnapshotError";
	}
}

/** Comm target the kernel-side `rlm.host_request` shim opens for typed host requests. */
export const HOST_COMM_TARGET = "host.request";

/** Current host-request gateway contract. The Python bridge may omit this for legacy calls. */
export const HOST_REQUEST_GATEWAY_VERSION = 1 as const;

export type HostRequestAccess = "read" | "mutate";

/** Host-owned authority installed out-of-band from the Python request payload. */
export interface HostRequestCapabilityContext {
	readonly workflowId?: string;
	readonly decisionId?: string;
	readonly decisionRevision?: number;
	readonly capabilities: readonly string[];
	readonly expiresAt?: number;
	readonly nonce?: string;
}

/** A bounded field in one closed host-request descriptor. */
export interface HostRequestFieldDescriptor {
	readonly kind: "string" | "boolean" | "integer" | "number" | "record" | "array";
	readonly required?: boolean;
	readonly maxChars?: number;
	readonly min?: number;
	readonly max?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly maxKeys?: number;
	readonly items?: HostRequestFieldDescriptor;
	readonly properties?: Readonly<Record<string, HostRequestFieldDescriptor>>;
}

/** Closed request metadata owned by the TypeScript host. */
export interface HostRequestDescriptor {
	readonly type: string;
	readonly version: typeof HOST_REQUEST_GATEWAY_VERSION;
	readonly access: HostRequestAccess;
	readonly requiredCapability?: string;
	readonly fields: Readonly<Record<string, HostRequestFieldDescriptor>>;
	readonly maxPayloadBytes: number;
	readonly maxNodes: number;
	readonly availability: "available" | "injectable";
}

/** Nested result envelope returned by the host gateway before legacy wire flattening. */
export interface HostRequestGatewaySuccess {
	readonly status: "ok";
	readonly result: Record<string, unknown>;
}

const HOST_REQUEST_CAPABILITY_CONTEXT = new WeakMap<object, HostRequestCapabilityContext>();

/** A bounded value accepted by a descriptor's JSON-shaped payload schema. */
interface HostRequestValueLimits {
	readonly maxBytes: number;
	readonly maxNodes: number;
	readonly maxDepth: number;
}

interface HostRequestDispatchOptions {
	/** Host-derived source attribution; never read from caller data. */
	readonly cellSourceCode?: string;
}

export interface HostRequestGatewayOptions {
	handlers?: HostRequestHandlers;
	capabilityContext?: HostRequestCapabilityContext;
	capabilityResolver?: HostRequestCapabilityResolver;
	now?: () => number;
}

/**
 * Handles one typed request from Python code running in the kernel.
 * The returned record is sent back verbatim as the comm reply payload.
 * The optional context is host-owned and never comes from the Python payload.
 */
export type HostRequestHandler = (
	payload: Record<string, unknown>,
	context?: HostRequestContext,
) => Promise<Record<string, unknown>>;

/**
 * Per-request authority supplied only by the host gateway.
 * `requestId` is an opaque host-minted correlation token and `isCurrent()`
 * lets an implementation reject work after its authority is revoked.
 */
export interface HostRequestContext {
	readonly requestId: string;
	readonly generation: number;
	readonly version: typeof HOST_REQUEST_GATEWAY_VERSION;
	readonly signal: AbortSignal;
	readonly capability: HostRequestCapabilityContext;
	readonly cellSourceCode?: string;
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

/** Resolve current host authority for one canonical request type. */
export type HostRequestCapabilityResolver = (requestType: string) => HostRequestCapabilityContext;

const HOST_REQUEST_CAPABILITY_RESOLVER = new WeakMap<object, HostRequestCapabilityResolver>();

function cloneHostRequestCapabilityContext(
	context: HostRequestCapabilityContext | undefined,
): HostRequestCapabilityContext {
	const capabilities = context?.capabilities ?? [];
	if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string" && value.length > 0)) {
		throw new Error("host request capabilities must be a list of non-empty strings");
	}
	if (
		context?.workflowId !== undefined &&
		(typeof context.workflowId !== "string" || context.workflowId.length === 0)
	) {
		throw new Error("host request workflowId must be a non-empty string when provided");
	}
	if (
		context?.decisionId !== undefined &&
		(typeof context.decisionId !== "string" || context.decisionId.length === 0)
	) {
		throw new Error("host request decisionId must be a non-empty string when provided");
	}
	if (
		context?.decisionRevision !== undefined &&
		(!Number.isSafeInteger(context.decisionRevision) || context.decisionRevision < 1)
	) {
		throw new Error("host request decisionRevision must be a positive integer when provided");
	}
	if (context?.expiresAt !== undefined && (!Number.isFinite(context.expiresAt) || context.expiresAt <= 0)) {
		throw new Error("host request expiresAt must be a positive timestamp when provided");
	}
	if (context?.nonce !== undefined && (typeof context.nonce !== "string" || context.nonce.length === 0)) {
		throw new Error("host request nonce must be a non-empty string when provided");
	}
	return Object.freeze({
		...(context?.workflowId === undefined ? {} : { workflowId: context.workflowId }),
		...(context?.decisionId === undefined ? {} : { decisionId: context.decisionId }),
		...(context?.decisionRevision === undefined ? {} : { decisionRevision: context.decisionRevision }),
		capabilities: Object.freeze([...capabilities]),
		...(context?.expiresAt === undefined ? {} : { expiresAt: context.expiresAt }),
		...(context?.nonce === undefined ? {} : { nonce: context.nonce }),
	});
}

/**
 * Install host authority on a copied handler table. Caller payloads cannot carry
 * this context, and later mutation of the caller's table cannot substitute a handler.
 */
export function installHostRequestCapabilityContext(
	handlers: HostRequestHandlers,
	context: HostRequestCapabilityContext = { capabilities: [] },
): HostRequestHandlers {
	const installed = { ...handlers };
	HOST_REQUEST_CAPABILITY_CONTEXT.set(installed, cloneHostRequestCapabilityContext(context));
	return installed;
}

/** Install a current-state authority resolver on a copied handler table. */
export function installHostRequestCapabilityResolver(
	handlers: HostRequestHandlers,
	resolver: HostRequestCapabilityResolver,
): HostRequestHandlers {
	const installed = { ...handlers };
	HOST_REQUEST_CAPABILITY_RESOLVER.set(installed, resolver);
	return installed;
}

/** Where and how to persist the kernel's user namespace so it survives resume. */
export interface KernelSnapshotConfig {
	/** Absolute path for the dill payload. */
	path: string;
	/** Absolute path for the JSON manifest written alongside the payload. */
	manifestPath: string;
	/** Aggregate inline durable-state ceiling. Declared required values above it fail closed. Default 256 MiB. */
	maxBytes?: number;
	/** Maximum serialized size of one variable. Default 16 MiB. */
	maxVariableBytes?: number;
	/** Debounce window for the auto-snapshot after a successful execution. Default 1500 ms. */
	debounceMs?: number;
	/** Names omitted before serialization as transient tool/output state. */
	transientNames?: readonly string[];
	/** Host-owned names that must remain in the host workflow/session stores. */
	hostOnlyNames?: readonly string[];
	/** Per-name classification for declared transient values. */
	transientClassifications?: Readonly<Record<string, KernelSnapshotRetentionClass>>;
	/** Names whose large values may be externalized to local content-addressed artifacts. */
	reproducibleNames?: readonly string[];
	/** Names that must be durable or cause the checkpoint/restore to fail closed. */
	requiredNames?: readonly string[];
	/** Optional local CAS directory for externalized values. */
	artifactRoot?: string;
	/** Maximum retained metadata records in one checkpoint. */
	maxRetainedValues?: number;
	/** Host-owned checkpoint telemetry authority; receipts and journal commits never come from the kernel. */
	checkpointTelemetry?: WorkflowCheckpointBudgetTelemetryHost;
}

export interface KernelManagerOptions {
	/** Python interpreter that has `ipykernel` available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	/** Host-owned agent directory used for the default bootstrapped Python runtime. */
	agentDir?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Optional physical Docker boundary for untrusted worker/coordinator kernels. */
	isolation?: KernelContainerIsolationOptions;
	/** Additional host-owned writable capability roots for an isolated kernel. */
	isolationOutputPaths?: readonly string[];
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
	deliveryStatus: "delivered" | "queued" | "blocked";
	blockedReason?: string;
	auditOnly?: true;
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
	const { id, message, deliveryStatus, blockedReason, auditOnly, receiverRole, target } = payload;
	const { activeSessionId, sessionId, sessionName } = target;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued" && deliveryStatus !== "blocked") ||
		(blockedReason !== undefined && typeof blockedReason !== "string") ||
		(auditOnly !== undefined && auditOnly !== true) ||
		typeof activeSessionId !== "string" ||
		typeof sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(typeof blockedReason === "string" ? { blockedReason } : {}),
		...(auditOnly === true ? { auditOnly: true as const } : {}),
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
	streamedOutputChars: { stdout: number; stderr: number };
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

const OUTPUT_TRUNCATION_MARKER = "\n[... output truncated ...]";

function truncateKernelText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= OUTPUT_TRUNCATION_MARKER.length) return OUTPUT_TRUNCATION_MARKER.slice(0, maxChars);
	return `${value.slice(0, maxChars - OUTPUT_TRUNCATION_MARKER.length)}${OUTPUT_TRUNCATION_MARKER}`;
}

function truncateKernelTraceback(traceback: readonly string[], maxChars: number): string[] {
	if (maxChars <= 0) return [];
	let bounded = "";
	let truncated = false;
	for (const line of traceback) {
		if (bounded.length >= maxChars) {
			truncated = true;
			break;
		}
		const prefix = bounded.length === 0 ? "" : "\n";
		const remaining = maxChars - bounded.length - prefix.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		if (line.length > remaining) {
			bounded += `${prefix}${line.slice(0, remaining)}`;
			truncated = true;
			break;
		}
		bounded += `${prefix}${line}`;
	}
	if (truncated) bounded = truncateKernelText(`${bounded}${"\n"}`, maxChars);
	return bounded.length === 0 ? [] : bounded.split("\n");
}

function normalizeMaxOutputChars(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_OUTPUT_CHARS;
	if (value === Number.POSITIVE_INFINITY) return MAX_EXECUTE_OUTPUT_CHARS;
	if (!Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_CHARS;
	return Math.min(MAX_EXECUTE_OUTPUT_CHARS, Math.max(0, Math.floor(value)));
}

/** Validate host-supplied snapshot bounds before any kernel is spawned. */
function validateKernelSnapshotConfig(config: KernelSnapshotConfig): void {
	if (!Number.isSafeInteger(config.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES) || (config.maxBytes ?? 1) < 1) {
		throw new KernelSnapshotError("snapshot maxBytes must be a positive safe integer");
	}
	if (
		!Number.isSafeInteger(config.maxRetainedValues ?? 256) ||
		(config.maxRetainedValues ?? 1) < 1 ||
		(config.maxRetainedValues ?? 256) > 256
	) {
		throw new KernelSnapshotError("snapshot maxRetainedValues must be between 1 and 256");
	}
	for (const [label, names] of [
		["transientNames", config.transientNames],
		["hostOnlyNames", config.hostOnlyNames],
		["reproducibleNames", config.reproducibleNames],
		["requiredNames", config.requiredNames],
	] as const) {
		if (names && (!Array.isArray(names) || !names.every((name) => typeof name === "string" && name.length > 0))) {
			throw new KernelSnapshotError(`snapshot ${label} must contain non-empty names`);
		}
	}
}

function checkpointTelemetryReason(
	value: KernelSnapshotRetainedValue,
): WorkflowCheckpointBudgetTelemetryObservationInput["retainedValues"][number]["reasonCode"] {
	if (value.representation === "durable") return null;
	switch (value.reason) {
		case "declared transient":
		case "host-owned":
			return "transient";
		case "value missing":
			return "missing";
		case "value failed to restore":
			return "restore_failed";
		default:
			return "not_serializable";
	}
}

function buildCheckpointTelemetryInput(
	snapshot: SnapshotResult,
	restoreTiming: {
		readonly restoreStartedAtMonotonicMs: number;
		readonly restoreEndedAtMonotonicMs: number;
	} | null,
): WorkflowCheckpointBudgetTelemetryObservationInput {
	if (
		snapshot.checkpointTurn === undefined ||
		snapshot.serializeStartedAtMonotonicMs === undefined ||
		snapshot.serializeEndedAtMonotonicMs === undefined ||
		snapshot.retainedValues === undefined
	) {
		throw new KernelSnapshotError("state snapshot did not return complete checkpoint telemetry metadata");
	}
	return {
		schemaVersion: 1,
		checkpointTurn: snapshot.checkpointTurn,
		serializeStartedAtMonotonicMs: snapshot.serializeStartedAtMonotonicMs,
		serializeEndedAtMonotonicMs: snapshot.serializeEndedAtMonotonicMs,
		restoreStartedAtMonotonicMs: restoreTiming?.restoreStartedAtMonotonicMs ?? null,
		restoreEndedAtMonotonicMs: restoreTiming?.restoreEndedAtMonotonicMs ?? null,
		bytesWritten: snapshot.bytes,
		retainedValues: snapshot.retainedValues.map((value) => ({
			valueId: value.valueId,
			type: value.type,
			bytes: value.bytes,
			classification: value.classification,
			representation: value.representation,
			digest: value.digest,
			artifactRef: value.artifactRef,
			reasonCode: checkpointTelemetryReason(value),
		})),
	};
}

const DEFAULT_HOST_REQUEST_MAX_BYTES = 64 * 1024;
const DEFAULT_HOST_REQUEST_MAX_NODES = 1024;
const DEFAULT_HOST_REQUEST_MAX_DEPTH = 8;
const MAX_HOST_REQUEST_OBJECT_KEYS = 128;

function stringField(options: Omit<HostRequestFieldDescriptor, "kind"> = {}): HostRequestFieldDescriptor {
	return Object.freeze({ kind: "string", ...options });
}

function boolField(options: Omit<HostRequestFieldDescriptor, "kind"> = {}): HostRequestFieldDescriptor {
	return Object.freeze({ kind: "boolean", ...options });
}

function integerField(options: Omit<HostRequestFieldDescriptor, "kind"> = {}): HostRequestFieldDescriptor {
	return Object.freeze({ kind: "integer", ...options });
}

function recordField(options: Omit<HostRequestFieldDescriptor, "kind"> = {}): HostRequestFieldDescriptor {
	return Object.freeze({ kind: "record", ...options });
}

function arrayField(options: Omit<HostRequestFieldDescriptor, "kind"> = {}): HostRequestFieldDescriptor {
	return Object.freeze({ kind: "array", ...options });
}

function artifactReferenceField(): HostRequestFieldDescriptor {
	return recordField({
		maxKeys: 5,
		properties: Object.freeze({
			artifact_id: stringField({ required: true, maxChars: 512 }),
			relative_path: stringField({ required: true, maxChars: 512 }),
			digest: stringField({ required: true, maxChars: 64 }),
			size_bytes: integerField({ required: true, min: 0, max: 8_388_608 }),
			source_event_sequence: integerField({ required: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
		}),
	});
}

const ARTIFACT_REFERENCE_FIELD = artifactReferenceField();

function descriptor(
	type: string,
	access: HostRequestAccess,
	fields: Readonly<Record<string, HostRequestFieldDescriptor>> = {},
	options: Pick<HostRequestDescriptor, "requiredCapability" | "availability"> = { availability: "available" },
): HostRequestDescriptor {
	return Object.freeze({
		type,
		version: HOST_REQUEST_GATEWAY_VERSION,
		access,
		fields: Object.freeze({ ...fields }),
		maxPayloadBytes: DEFAULT_HOST_REQUEST_MAX_BYTES,
		maxNodes: DEFAULT_HOST_REQUEST_MAX_NODES,
		...options,
	});
}

function mempalaceProposalFields(): Readonly<Record<string, HostRequestFieldDescriptor>> {
	const procedure = recordField({
		maxKeys: 4,
		properties: Object.freeze({
			inputs: recordField({ required: true, maxKeys: 256 }),
			steps: arrayField({
				required: true,
				minItems: 1,
				maxItems: 256,
				items: stringField({ required: true, maxChars: 4_000 }),
			}),
			successChecks: arrayField({
				required: true,
				minItems: 1,
				maxItems: 256,
				items: stringField({ required: true, maxChars: 4_000 }),
			}),
			failureChecks: arrayField({
				required: true,
				minItems: 1,
				maxItems: 256,
				items: stringField({ required: true, maxChars: 4_000 }),
			}),
		}),
	});
	return Object.freeze({
		knowledge_kind: stringField({ required: true, maxChars: 32 }),
		source_evidence_refs: arrayField({
			required: true,
			minItems: 1,
			maxItems: 32,
			items: ARTIFACT_REFERENCE_FIELD,
		}),
		title: stringField({ maxChars: 256 }),
		statement: stringField({ maxChars: 4_000 }),
		procedure,
	});
}

const HOST_REQUEST_DESCRIPTOR_LIST: readonly HostRequestDescriptor[] = Object.freeze([
	descriptor(
		"rlm.run",
		"mutate",
		{
			prompt: stringField({ required: true, maxChars: 32_000 }),
			kwargs: recordField({ maxKeys: 32 }),
		},
		{ requiredCapability: "rlm.run", availability: "available" },
	),
	descriptor("rlm.find_models", "read", {
		query: stringField({ required: true, maxChars: 256 }),
		limit: integerField({ min: 1, max: 20 }),
	}),
	descriptor("rlm.list_subagents", "read"),
	descriptor(
		"rlm.delete_subagent",
		"mutate",
		{
			target: stringField({ required: true, maxChars: 256 }),
		},
		{ requiredCapability: "rlm.delete_subagent", availability: "available" },
	),
	descriptor("model.info", "read"),
	descriptor("goal.get", "read"),
	descriptor(
		"goal.create",
		"mutate",
		{
			objective: stringField({ required: true, maxChars: 4_000 }),
			token_budget: integerField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
		},
		{ requiredCapability: "goal.create", availability: "available" },
	),
	descriptor("goal.complete", "mutate", {}, { requiredCapability: "goal.complete", availability: "available" }),
	descriptor("compact.status", "read"),
	descriptor(
		"compact.run",
		"mutate",
		{
			instructions: stringField({ maxChars: 16_000 }),
		},
		{ requiredCapability: "compact.run", availability: "available" },
	),
	descriptor("refine.status", "read"),
	descriptor(
		"refine.run",
		"mutate",
		{
			instructions: stringField({ maxChars: 16_000 }),
			global: boolField(),
		},
		{ requiredCapability: "refine.run", availability: "available" },
	),
	descriptor("rlm_heartbeat.list", "read", {
		include_inactive: boolField(),
		includeInactive: boolField(),
	}),
	descriptor(
		"rlm_heartbeat.create",
		"mutate",
		{
			instruction: stringField({ required: true, maxChars: 16_000 }),
			interval: stringField({ maxChars: 128 }),
			label: stringField({ maxChars: 256 }),
			delivery_mode: stringField({ maxChars: 32 }),
			deliveryMode: stringField({ maxChars: 32 }),
		},
		{ requiredCapability: "rlm_heartbeat.create", availability: "available" },
	),
	descriptor(
		"rlm_heartbeat.update",
		"mutate",
		{
			id: stringField({ required: true, maxChars: 256 }),
			instruction: stringField({ maxChars: 16_000 }),
			interval: stringField({ maxChars: 128 }),
			label: stringField({ maxChars: 256 }),
			status: stringField({ maxChars: 32 }),
			delivery_mode: stringField({ maxChars: 32 }),
			deliveryMode: stringField({ maxChars: 32 }),
		},
		{ requiredCapability: "rlm_heartbeat.update", availability: "available" },
	),
	descriptor(
		"rlm_heartbeat.delete",
		"mutate",
		{
			id: stringField({ required: true, maxChars: 256 }),
		},
		{ requiredCapability: "rlm_heartbeat.delete", availability: "available" },
	),
	descriptor("agent_message.list_agents", "read"),
	descriptor(
		"agent_message.send",
		"mutate",
		{
			target: stringField({ maxChars: 256 }),
			message: stringField({ required: true, maxChars: 32_000 }),
			receiver_role: stringField({ maxChars: 32 }),
			receiver_name: stringField({ maxChars: 256 }),
			mode: stringField({ maxChars: 32 }),
		},
		{ requiredCapability: "agent_message.send", availability: "available" },
	),
	descriptor("agent_observe.list", "read"),
	descriptor("agent_observe.get", "read", {
		target: stringField({ required: true, maxChars: 256 }),
	}),
	descriptor("agent_observe.recent", "read", {
		target: stringField({ required: true, maxChars: 256 }),
		limit: integerField({ min: 1, max: 50 }),
		max_chars: integerField({ min: 80, max: 2_000 }),
		maxChars: integerField({ min: 80, max: 2_000 }),
	}),
	descriptor(
		"mcp.refresh",
		"mutate",
		{
			server: stringField({ required: true, maxChars: 256 }),
		},
		{ requiredCapability: "mcp.refresh", availability: "available" },
	),
	descriptor("mcp.config", "read", {
		server: stringField({ required: true, maxChars: 256 }),
	}),
	descriptor(
		"mcp.begin_login",
		"mutate",
		{
			server: stringField({ required: true, maxChars: 256 }),
		},
		{ requiredCapability: "mcp.begin_login", availability: "available" },
	),
	descriptor(
		"autoresearch.run",
		"mutate",
		{
			recipe_digest: stringField({ required: true, maxChars: 64 }),
			evidence_refs: arrayField({ required: true, maxItems: 32, items: ARTIFACT_REFERENCE_FIELD }),
		},
		{ requiredCapability: "autoresearch.run", availability: "injectable" },
	),
	descriptor(
		"mempalace.recall",
		"read",
		{
			query: stringField({ required: true, maxChars: 250 }),
			knowledge_kind: stringField({ maxChars: 32 }),
			limit: integerField({ required: true, min: 1, max: 5 }),
		},
		{ availability: "injectable" },
	),
	descriptor("mempalace.propose", "mutate", mempalaceProposalFields(), {
		requiredCapability: "mempalace.propose",
		availability: "injectable",
	}),
	descriptor(
		"workflow.v1.autoresearch.run",
		"mutate",
		{
			recipe_digest: stringField({ required: true, maxChars: 64 }),
			evidence_refs: arrayField({ required: true, maxItems: 32, items: ARTIFACT_REFERENCE_FIELD }),
		},
		{ requiredCapability: "autoresearch.run", availability: "injectable" },
	),
	descriptor(
		"workflow.v1.mempalace.recall",
		"read",
		{
			query: stringField({ required: true, maxChars: 250 }),
			knowledge_kind: stringField({ maxChars: 32 }),
			limit: integerField({ required: true, min: 1, max: 5 }),
		},
		{ availability: "injectable" },
	),
	descriptor("workflow.v1.mempalace.propose", "mutate", mempalaceProposalFields(), {
		requiredCapability: "mempalace.propose",
		availability: "injectable",
	}),
	descriptor(
		"workflow.v1.pipeline.record",
		"mutate",
		{
			stage_id: stringField({ required: true, maxChars: 256 }),
			evidence_refs: arrayField({ required: true, maxItems: 32, items: ARTIFACT_REFERENCE_FIELD }),
		},
		{ requiredCapability: "pipeline.record", availability: "injectable" },
	),
	descriptor("workflow.v1.execution_evidence.read", "read", {}, { availability: "injectable" }),
	descriptor(
		"workflow.v1.learning.review",
		"mutate",
		{ experience_id: stringField({ required: true, maxChars: 512 }) },
		{ requiredCapability: "learning.review", availability: "injectable" },
	),
	descriptor(
		"workflow.v1.learning.rollback",
		"mutate",
		{ candidate_id: stringField({ required: true, maxChars: 512 }) },
		{ requiredCapability: "learning.rollback", availability: "injectable" },
	),
	descriptor(
		"workflow.v1.completion.request",
		"mutate",
		{},
		{
			requiredCapability: "completion.request",
			availability: "injectable",
		},
	),
]);

const HOST_REQUEST_DESCRIPTORS = new Map(HOST_REQUEST_DESCRIPTOR_LIST.map((entry) => [entry.type, entry]));

const HOST_REQUEST_TYPE_ALIASES: Readonly<Record<string, string>> = {
	"autoresearch.run": "workflow.v1.autoresearch.run",
	"mempalace.recall": "workflow.v1.mempalace.recall",
	"mempalace.propose": "workflow.v1.mempalace.propose",
	"pipeline.record": "workflow.v1.pipeline.record",
	"execution_evidence.read": "workflow.v1.execution_evidence.read",
	"learning.review": "workflow.v1.learning.review",
	"learning.rollback": "workflow.v1.learning.rollback",
	"completion.request": "workflow.v1.completion.request",
};

/** Return the closed host-owned descriptor set for diagnostics and contract tests. */
export function getHostRequestDescriptors(): readonly HostRequestDescriptor[] {
	return HOST_REQUEST_DESCRIPTOR_LIST;
}

function assertBoundedHostRequestValue(value: unknown, limits: HostRequestValueLimits): void {
	let bytes = 0;
	let nodes = 0;
	const ancestors = new Set<object>();
	const visit = (entry: unknown, depth: number): void => {
		if (depth > limits.maxDepth) throw new Error("host request payload is too deeply nested");
		nodes += 1;
		if (nodes > limits.maxNodes) throw new Error("host request payload has too many values");
		if (typeof entry === "string") {
			bytes += Buffer.byteLength(entry);
		} else if (typeof entry === "number") {
			if (!Number.isFinite(entry)) throw new Error("host request payload numbers must be finite");
			bytes += 16;
		} else if (typeof entry === "boolean" || entry === null) {
			bytes += 8;
		} else if (Array.isArray(entry)) {
			if (ancestors.has(entry)) throw new Error("host request payload must not contain cycles");
			ancestors.add(entry);
			for (const child of entry) visit(child, depth + 1);
			ancestors.delete(entry);
		} else if (isRecord(entry)) {
			const prototype = Object.getPrototypeOf(entry);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new Error("host request payload must contain plain JSON objects");
			}
			if (ancestors.has(entry)) throw new Error("host request payload must not contain cycles");
			const entries = Object.entries(entry);
			if (entries.length > MAX_HOST_REQUEST_OBJECT_KEYS)
				throw new Error("host request payload has too many object keys");
			ancestors.add(entry);
			for (const [key, child] of entries) {
				bytes += Buffer.byteLength(key);
				visit(child, depth + 1);
			}
			ancestors.delete(entry);
		} else {
			throw new Error("host request payload must contain JSON-compatible values");
		}
		if (bytes > limits.maxBytes) throw new Error("host request payload is too large");
	};
	visit(value, 0);
}

function assertHostRequestField(value: unknown, name: string, field: HostRequestFieldDescriptor): void {
	if (field.kind === "string") {
		if (typeof value !== "string") throw new Error(`host request field ${name} must be a string`);
		if (field.maxChars !== undefined && value.length > field.maxChars) {
			throw new Error(`host request field ${name} exceeds ${field.maxChars} characters`);
		}
		return;
	}
	if (field.kind === "boolean") {
		if (typeof value !== "boolean") throw new Error(`host request field ${name} must be a boolean`);
		return;
	}
	if (field.kind === "integer") {
		if (!Number.isSafeInteger(value)) throw new Error(`host request field ${name} must be a safe integer`);
		if (field.min !== undefined && (value as number) < field.min)
			throw new Error(`host request field ${name} is below its minimum`);
		if (field.max !== undefined && (value as number) > field.max)
			throw new Error(`host request field ${name} exceeds its maximum`);
		return;
	}
	if (field.kind === "number") {
		if (typeof value !== "number" || !Number.isFinite(value))
			throw new Error(`host request field ${name} must be finite`);
		if (field.min !== undefined && value < field.min)
			throw new Error(`host request field ${name} is below its minimum`);
		if (field.max !== undefined && value > field.max)
			throw new Error(`host request field ${name} exceeds its maximum`);
		return;
	}
	if (field.kind === "record") {
		if (!isRecord(value)) throw new Error(`host request field ${name} must be an object`);
		if (field.maxKeys !== undefined && Object.keys(value).length > field.maxKeys) {
			throw new Error(`host request field ${name} has too many object keys`);
		}
		if (field.properties !== undefined) {
			const allowed = new Set(Object.keys(field.properties));
			for (const key of Object.keys(value)) {
				if (!allowed.has(key)) throw new Error(`host request field ${name} has unknown property ${key}`);
			}
			for (const [propertyName, property] of Object.entries(field.properties)) {
				const propertyValue = value[propertyName];
				if (propertyValue === undefined) {
					if (property.required) throw new Error(`host request field ${name} requires property ${propertyName}`);
					continue;
				}
				assertHostRequestField(propertyValue, `${name}.${propertyName}`, property);
			}
		}
		return;
	}
	if (!Array.isArray(value)) throw new Error(`host request field ${name} must be an array`);
	if (field.minItems !== undefined && value.length < field.minItems) {
		throw new Error(`host request field ${name} has too few items`);
	}
	if (field.maxItems !== undefined && value.length > field.maxItems) {
		throw new Error(`host request field ${name} has too many references`);
	}
	if (field.items !== undefined) {
		for (const [index, item] of value.entries()) {
			assertHostRequestField(item, `${name}[${index}]`, field.items);
		}
	}
}

function validateHostRequestPayload(
	data: Record<string, unknown>,
	descriptorEntry: HostRequestDescriptor,
): Record<string, unknown> {
	assertBoundedHostRequestValue(data, {
		maxBytes: descriptorEntry.maxPayloadBytes,
		maxNodes: descriptorEntry.maxNodes,
		maxDepth: DEFAULT_HOST_REQUEST_MAX_DEPTH,
	});
	const version = data.version;
	if (version !== undefined && version !== descriptorEntry.version) {
		throw new Error(`host request ${descriptorEntry.type} has unsupported version ${String(version)}`);
	}
	if (Object.hasOwn(data, "capability")) {
		throw new Error("host request capability must be installed by the host, not supplied by the caller");
	}
	const allowed = new Set(["type", "version", ...Object.keys(descriptorEntry.fields)]);
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) throw new Error(`host request ${descriptorEntry.type} has unknown field ${key}`);
	}
	for (const [name, field] of Object.entries(descriptorEntry.fields)) {
		const value = data[name];
		if (value === undefined) {
			if (field.required) throw new Error(`host request ${descriptorEntry.type} requires field ${name}`);
			continue;
		}
		assertHostRequestField(value, name, field);
	}
	const payload: Record<string, unknown> = { type: descriptorEntry.type };
	for (const name of Object.keys(descriptorEntry.fields)) {
		if (data[name] !== undefined) payload[name] = data[name];
	}
	return payload;
}

/** Monotonic per-process counter stamped on every minted host-request context. */
let hostRequestGeneration = 0;

function mintHostRequestContext(
	capability: HostRequestCapabilityContext,
	cellSourceCode: string | undefined,
	controller: AbortController,
	now: () => number,
	renewAuthority?: () => number | undefined,
): HostRequestContext {
	let current = true;
	let authorityExpiresAt = capability.expiresAt;
	let renewalTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRenewal = (): void => {
		if (!current || renewAuthority === undefined || authorityExpiresAt === undefined) return;
		const remainingMilliseconds = authorityExpiresAt - now();
		const delayMilliseconds = Math.max(1, Math.floor(remainingMilliseconds / 2));
		renewalTimer = setTimeout(() => {
			renewalTimer = undefined;
			const renewedExpiresAt = renewAuthority();
			if (renewedExpiresAt === undefined || renewedExpiresAt <= now()) {
				current = false;
				return;
			}
			authorityExpiresAt = renewedExpiresAt;
			scheduleRenewal();
		}, delayMilliseconds);
		renewalTimer.unref?.();
	};
	const context: HostRequestContext = Object.freeze({
		requestId: uuid(),
		generation: ++hostRequestGeneration,
		version: HOST_REQUEST_GATEWAY_VERSION,
		signal: controller.signal,
		capability,
		...(cellSourceCode === undefined ? {} : { cellSourceCode }),
		isCurrent: () => {
			if (!current || controller.signal.aborted) return false;
			if (authorityExpiresAt === undefined || authorityExpiresAt > now()) return true;
			const renewedExpiresAt = renewAuthority?.();
			if (renewedExpiresAt === undefined || renewedExpiresAt <= now()) return false;
			authorityExpiresAt = renewedExpiresAt;
			return true;
		},
	});
	controller.signal.addEventListener(
		"abort",
		() => {
			current = false;
			if (renewalTimer !== undefined) clearTimeout(renewalTimer);
		},
		{ once: true },
	);
	scheduleRenewal();
	return context;
}

/** One host-owned, bounded, closed request gateway. */
export class HostRequestGateway {
	private readonly handlers: ReadonlyMap<string, HostRequestHandler>;
	private readonly capability: HostRequestCapabilityContext;
	private readonly capabilityResolver?: HostRequestCapabilityResolver;
	private readonly now: () => number;
	private readonly usedCapabilityNonces = new Set<string>();
	private readonly activeControllers = new Set<AbortController>();

	constructor(options: HostRequestGatewayOptions = {}) {
		const source = options.handlers ?? {};
		const entries = Object.entries(source).filter(
			(entry): entry is [string, HostRequestHandler] => typeof entry[1] === "function",
		);
		this.handlers = new Map(entries);
		this.capability = cloneHostRequestCapabilityContext(
			options.capabilityContext ?? HOST_REQUEST_CAPABILITY_CONTEXT.get(source),
		);
		this.capabilityResolver = options.capabilityResolver ?? HOST_REQUEST_CAPABILITY_RESOLVER.get(source);
		this.now = options.now ?? (() => Date.now());
	}

	/** Dispatch one caller payload and return a nested host-owned result envelope. */
	async dispatch(data: unknown, options: HostRequestDispatchOptions = {}): Promise<HostRequestGatewaySuccess> {
		if (!isRecord(data)) throw new Error("host request payload must be an object");
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}
		const incomingType = data.type;
		const handlerType =
			this.handlers.has(incomingType) || !HOST_REQUEST_TYPE_ALIASES[incomingType]
				? incomingType
				: HOST_REQUEST_TYPE_ALIASES[incomingType];
		const descriptorEntry = HOST_REQUEST_DESCRIPTORS.get(handlerType);
		if (!descriptorEntry) throw new Error(`host request type "${incomingType}" is not available in this session`);
		const payload = validateHostRequestPayload(data, descriptorEntry);
		const capability = cloneHostRequestCapabilityContext(this.capabilityResolver?.(handlerType) ?? this.capability);
		const handler = this.handlers.get(handlerType);
		if (!handler) {
			if (descriptorEntry.availability === "injectable") {
				throw new Error(`host request type "${incomingType}" is unavailable until its host module is injected`);
			}
			throw new Error(`host request type "${incomingType}" is not available in this session`);
		}

		if (descriptorEntry.access === "mutate") {
			const required = descriptorEntry.requiredCapability;
			if (!required || !capability.capabilities.includes(required)) {
				throw new Error(`host request ${incomingType} requires host capability ${required ?? "unknown"}`);
			}
			if (
				!capability.workflowId ||
				!capability.decisionId ||
				!Number.isSafeInteger(capability.decisionRevision) ||
				capability.expiresAt === undefined ||
				capability.expiresAt <= this.now()
			) {
				throw new Error(`host request ${incomingType} capability is expired or not bound to a current decision`);
			}
			const nonce = capability.nonce;
			if (!nonce) throw new Error(`host request ${incomingType} capability has no replay nonce`);
			const nonceKey = `${capability.workflowId}:${capability.decisionId}:${capability.decisionRevision}:${handlerType}:${nonce}`;
			if (this.usedCapabilityNonces.has(nonceKey))
				throw new Error(`host request ${incomingType} capability was already used`);
			this.usedCapabilityNonces.add(nonceKey);
		}

		const controller = new AbortController();
		this.activeControllers.add(controller);
		const renewAuthority =
			this.capabilityResolver === undefined
				? undefined
				: (): number | undefined => {
						const renewed = cloneHostRequestCapabilityContext(this.capabilityResolver?.(handlerType));
						if (
							renewed.workflowId !== capability.workflowId ||
							renewed.decisionId !== capability.decisionId ||
							renewed.decisionRevision !== capability.decisionRevision ||
							capability.capabilities.some((name) => !renewed.capabilities.includes(name))
						)
							return undefined;
						return renewed.expiresAt;
					};
		const context = mintHostRequestContext(capability, options.cellSourceCode, controller, this.now, renewAuthority);
		try {
			const result = await handler(
				options.cellSourceCode === undefined ? payload : { ...payload, cellSourceCode: options.cellSourceCode },
				context,
			);
			if (!context.isCurrent()) throw new Error(`host request ${incomingType} authority was revoked`);
			if (!isRecord(result)) throw new Error(`host request ${incomingType} returned a non-object result`);
			return { status: "ok", result: { ...result } };
		} finally {
			controller.abort();
			this.activeControllers.delete(controller);
		}
	}

	/** Revoke active handler contexts when the owning kernel is torn down. */
	revoke(): void {
		for (const controller of this.activeControllers) controller.abort();
		this.activeControllers.clear();
	}
}

export function createHostRequestGateway(options: HostRequestGatewayOptions = {}): HostRequestGateway {
	return new HostRequestGateway(options);
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

function decode(frames: Buffer[], key: string): JupyterMessage | null {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	if (i + 5 >= frames.length) return null;
	const signedParts = frames.slice(i + 2, i + 6);
	const expectedSignature = sign(signedParts, key);
	const receivedSignature = frames[i + 1];
	if (
		receivedSignature.byteLength !== expectedSignature.byteLength ||
		!timingSafeEqual(receivedSignature, expectedSignature)
	)
		return null;
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

async function makeContainerConnection(): Promise<{
	info: ConnectionInfo;
	path: string;
	tempDir: string;
	ports: readonly number[];
}> {
	const base = makeConnection();
	const ports = await reserveKernelPorts();
	const [shellPort, iopubPort, stdinPort, controlPort, hbPort] = ports;
	const info: ConnectionInfo = {
		...base.info,
		shell_port: shellPort!,
		iopub_port: iopubPort!,
		stdin_port: stdinPort!,
		control_port: controlPort!,
		hb_port: hbPort!,
	};
	writeFileSync(base.path, JSON.stringify(info, null, 2), { mode: 0o600 });
	writeContainerConnectionFile(base.tempDir, { ...info });
	return { ...base, info, ports };
}

function kernelContainerOutputPaths(snapshot: KernelSnapshotConfig | undefined): readonly string[] {
	if (!snapshot) return [];
	if (!snapshot.artifactRoot) {
		throw new Error("kernel isolation snapshots require an explicit artifact capability root");
	}
	const capabilityRoot = resolve(snapshot.artifactRoot);
	for (const output of [dirname(resolve(snapshot.path)), dirname(resolve(snapshot.manifestPath))]) {
		const remainder = relative(capabilityRoot, output);
		if (remainder === ".." || remainder.startsWith(`..${resolve("/")}`) || resolve(output) === resolve("/")) {
			throw new Error("kernel snapshot paths must be contained by the explicit artifact capability root");
		}
	}
	return [capabilityRoot];
}

function canonicalizeKernelSnapshot(snapshot: KernelSnapshotConfig | undefined): KernelSnapshotConfig | undefined {
	if (!snapshot) return undefined;
	return {
		...snapshot,
		path: canonicalizeKernelWritablePath(snapshot.path),
		manifestPath: canonicalizeKernelWritablePath(snapshot.manifestPath),
		artifactRoot: snapshot.artifactRoot ? canonicalizeKernelWritablePath(snapshot.artifactRoot) : undefined,
	};
}

function kernelContainerEnvironment(
	environment: Record<string, string> | undefined,
	pythonSkills: readonly KernelPythonSkill[] | undefined,
): Readonly<Record<string, string>> {
	const result = { ...(environment ?? {}) };
	const skillSources = [...new Set((pythonSkills ?? []).map((skill) => join(skill.packagePath, "src")))];
	if (skillSources.length > 0) result.PYTHONPATH = skillSources.join(delimiter);
	return result;
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
		const outcomes = await Promise.allSettled([...liveKernels].map((k) => k.shutdown({ snapshot: true })));
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") {
				console.error(`[kernel] final checkpoint flush failed: ${errorMessage(outcome.reason)}`);
			}
		}
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
		| "python"
		| "agentDir"
		| "cwd"
		| "env"
		| "sessionId"
		| "hostHandlers"
		| "pythonSkills"
		| "snapshot"
		| "isolation"
		| "isolationOutputPaths"
	> &
		Required<Pick<KernelManagerOptions, "username">>;
	private readonly session = uuid();
	private containerId?: string;
	private readonly containerIds = new Set<string>();
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
	private iopubReady?: Deferred<void>;
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
	private readonly hostRequestGateway: HostRequestGateway;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;
	/** Monotonic checkpoint turn assigned by the host for state snapshots. */
	private checkpointTurn = 0;
	/** Last committed durable bytes, used for growth-per-turn telemetry. */
	private previousDurableBytes: number | null = null;
	/** Restore timing is attached to the first checkpoint after a verified restore. */
	private pendingRestoreTiming: {
		readonly restoreStartedAtMonotonicMs: number;
		readonly restoreEndedAtMonotonicMs: number;
	} | null = null;

	constructor(options: KernelManagerOptions) {
		if (options.snapshot) validateKernelSnapshotConfig(options.snapshot);
		this.options = {
			python: options.python,
			agentDir: options.agentDir,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.isolation ? canonicalizeKernelSnapshot(options.snapshot) : options.snapshot,
			isolation: options.isolation,
			isolationOutputPaths: options.isolationOutputPaths,
			username: options.username ?? "prime-agent",
		};
		this.hostRequestGateway = createHostRequestGateway({
			handlers: this.options.hostHandlers,
		});
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	private appendKernelDiagnostic(message: string): void {
		this.appendKernelStderr(`[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`);
	}

	private appendKernelStderr(chunk: string): void {
		this.kernelStderr = `${this.kernelStderr}${chunk}`;
		if (this.kernelStderr.length > MAX_KERNEL_STDERR_CHARS) {
			this.kernelStderr = this.kernelStderr.slice(-MAX_KERNEL_STDERR_CHARS);
		}
	}

	private attachKernelProcess(kernel: ChildProcess): void {
		this.kernel = kernel;
		kernel.stderr?.on("data", (buf: Buffer) => {
			this.appendKernelStderr(buf.toString());
		});
		kernel.on("error", (err) => {
			if (this.kernel !== kernel) return;
			this.appendKernelDiagnostic(`spawn error: ${err.message}`);
			this.state = "shutdown";
			liveKernels.delete(this);
			const cleanupError = this.cleanupResources();
			if (cleanupError) this.appendKernelDiagnostic(cleanupError.message);
		});
		kernel.on("exit", (code, signal) => {
			if (this.kernel !== kernel) return;
			if (this.state !== "shutdown") {
				this.appendKernelDiagnostic(`unexpected exit code=${code} signal=${signal}`);
			}
			this.state = "shutdown";
			liveKernels.delete(this);
			const cleanupError = this.cleanupResources();
			if (cleanupError) this.appendKernelDiagnostic(cleanupError.message);
		});
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

		let python = this.options.python ?? "python";
		try {
			if (!this.options.isolation) {
				python =
					this.options.python ??
					(await ensureKernelPython({
						agentDir: this.options.agentDir,
						pythonSkills: this.options.pythonSkills,
						onProgress: startOptions.onBootstrapProgress,
					}));
				if (this.startStale(generation)) throw new Error("Kernel start superseded");
				this.options.python = python;
			}
		} catch (error) {
			if (this.startStale(generation)) throw error; // never touch a newer start's state
			liveKernels.delete(this);
			if ((this.state as string) !== "shutdown") this.state = "idle";
			throw error;
		}

		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel was disposed during startup");
		}

		let connection = this.options.isolation ? await makeContainerConnection() : makeConnection();
		this.tempDir = connection.tempDir;

		let forked = false;
		if (this.options.isolation) {
			try {
				const containerPorts = (connection as { ports?: readonly number[] }).ports;
				if (!containerPorts) throw new Error("container kernel connection ports were not reserved");
				const containerId = await createKernelContainer({
					isolation: this.options.isolation,
					workspace: this.options.cwd ?? process.cwd(),
					tempDir: connection.tempDir,
					ports: containerPorts,
					outputPaths: [
						...new Set([
							...kernelContainerOutputPaths(this.options.snapshot),
							...(this.options.isolationOutputPaths ?? []),
						]),
					],
					environment: kernelContainerEnvironment(this.options.env, this.options.pythonSkills),
				});
				this.containerId = containerId;
				this.containerIds.add(containerId);
				const kernel = spawn(this.options.isolation.dockerBinary ?? "docker", ["start", "--attach", containerId], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				this.attachKernelProcess(kernel);
			} catch (error) {
				if (error instanceof KernelContainerOwnerCleanupError) {
					for (const containerId of error.containerIds) this.containerIds.add(containerId);
					if (error.containerIds.length === 1) this.containerId = error.containerIds[0];
				} else if (
					(error instanceof KernelContainerCreationError || error instanceof KernelContainerCleanupError) &&
					error.containerId !== undefined
				) {
					this.containerId = error.containerId;
					this.containerIds.add(error.containerId);
				}
				this.state = "shutdown";
				liveKernels.delete(this);
				const cleanupError = this.cleanupResources();
				if (cleanupError) {
					if (error instanceof KernelContainerOwnerCleanupError) {
						throw new KernelContainerOwnerCleanupError(
							error.ownerIdentity,
							error.containerIds,
							`${error.message}; ${cleanupError.message}`,
							cleanupError,
						);
					}
					throw cleanupError;
				}
				throw error;
			}
		} else if (isForkServerEnabled()) {
			// Fast path: fork a pre-imported kernel from the forkserver. Any failure
			// (disabled, unavailable, fork error) degrades to the direct-spawn path so
			// correctness never depends on fork.
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

		if (!this.options.isolation && !forked) {
			const kernel = spawn(python, ["-m", "ipykernel_launcher", "-f", connection.path], {
				cwd: this.options.cwd,
				// ipykernel's parent poller exits the kernel if this pid dies (covers SIGKILL of the owner).
				env: { ...process.env, ...this.options.env, JPY_PARENT_PID: String(process.pid) },
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.attachKernelProcess(kernel);
			if (kernel.pid !== undefined) recordOrphanProcessState(kernel.pid, true);
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
		this.iopubReady = createDeferred<void>();
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
		const cleanupError = this.cleanupResources();
		if (cleanupError) this.appendKernelDiagnostic(cleanupError.message);
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
		const conn = this.connection;
		const shell = this.shell;
		if ((this.state as string) === "shutdown" || !conn || !shell) {
			const tail = this.kernelStderr.slice(-1024);
			throw new Error(`Kernel exited during startup. stderr:\n${tail || "(empty)"}`);
		}

		const msg = buildMessage("kernel_info_request", {}, this.session, this.options.username);
		const requestMsgId = msg.header.msg_id;
		await this.translateSocketClosure(shell.send(encode(msg, conn.key)));

		const startedAt = Date.now();
		let shellReady = false;
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

			const incoming = decode(winner.frames, conn.key);
			if (
				incoming?.header.msg_type === "kernel_info_reply" &&
				(incoming.parent_header as { msg_id?: string }).msg_id === requestMsgId
			) {
				shellReady = true;
				break;
			}
		}
		if (shellReady && this.iopubReady) {
			const remaining = READY_TIMEOUT_MS - (Date.now() - startedAt);
			if (remaining > 0) {
				const iopub = await Promise.race([
					this.iopubReady.promise.then(() => "ready" as const),
					sleep(remaining).then(() => "timeout" as const),
				]);
				if (iopub === "ready") return;
			}
		}
		const tail = this.kernelStderr.slice(-1024);
		throw new Error(
			`Kernel did not complete shell and IOPub readiness within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
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
		const maxChars = normalizeMaxOutputChars(opts.maxOutputChars);

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
			streamedOutputChars: { stdout: 0, stderr: 0 },
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
				const key = this.connection?.key;
				if (key === undefined) continue;
				const incoming = decode(frames, key);
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
				const key = this.connection?.key;
				if (key === undefined) continue;
				const incoming = decode(frames, key);
				if (!incoming) continue;
				this.iopubReady?.resolve();
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
				this.state = "shutdown";
				liveKernels.delete(this);
				const cleanupError = this.cleanupResources();
				if (cleanupError) this.appendKernelDiagnostic(cleanupError.message);
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
			const streamed = execution.streamedOutputChars[c.name];
			if (streamed < execution.maxChars) {
				const chunk = c.text.slice(0, execution.maxChars - streamed);
				execution.streamedOutputChars[c.name] += chunk.length;
				execution.opts.onStream?.(chunk, c.name);
			}
		} else if (t === "execute_result") {
			const c = incoming.content as { data: Record<string, string> };
			if (c.data["text/plain"]) execution.result = truncateKernelText(c.data["text/plain"], execution.maxChars);
		} else if (t === "display_data" || t === "update_display_data") {
			const c = incoming.content as { data?: Record<string, unknown> };
			const diff = parseDiffDisplay(c.data?.[DIFF_DISPLAY_MIME]);
			if (diff && execution.diffs.length < MAX_EXECUTION_COLLECTION_ITEMS) execution.diffs.push(diff);
			const attachment = parseAttachmentDisplay(c.data?.[ATTACHMENT_DISPLAY_MIME]);
			if (attachment === "oversized") {
				const message = `${execution.stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				const nextStderr = truncateKernelText(`${execution.stderr}${message}`, execution.maxChars);
				execution.stderrTruncated ||= nextStderr.length < execution.stderr.length + message.length;
				execution.stderr = nextStderr;
				execution.status = "error";
			} else if (attachment && execution.attachments.length < MAX_EXECUTION_COLLECTION_ITEMS) {
				execution.attachments.push(attachment);
			}
			const sentAgentMessage = parseSentAgentMessage(c.data?.[AGENT_MESSAGE_DISPLAY_MIME]);
			if (sentAgentMessage && execution.sentAgentMessages.length < MAX_EXECUTION_COLLECTION_ITEMS) {
				execution.sentAgentMessages.push(sentAgentMessage);
			}
		} else if (t === "error") {
			const c = incoming.content as { ename: string; evalue: string; traceback: string[] };
			execution.error = {
				...c,
				evalue: truncateKernelText(c.evalue, execution.maxChars),
				traceback: truncateKernelTraceback(c.traceback, execution.maxChars),
			};
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
			if (execution.stdoutTruncated) stdout = truncateKernelText(stdout, execution.maxChars);
			if (execution.stderrTruncated) stderr = truncateKernelText(stderr, execution.maxChars);
			if (result !== undefined) result = truncateKernelText(result, execution.maxChars);

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
				const response = await this.handleHostRequest(data);
				try {
					// Keep the legacy Python response flat while making the nested gateway
					// result the only source of handler data. Host status is written last.
					await this.sendCommMessage(commId, { ...response.result, status: response.status });
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

	private async handleHostRequest(data: unknown): Promise<HostRequestGatewaySuccess> {
		// Tag the request with the cell that triggered it without letting Python
		// provide or overwrite this host-owned attribution field.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return this.hostRequestGateway.dispatch(data, { cellSourceCode });
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

	private cleanupResources(killSignal: NodeJS.Signals = "SIGTERM"): KernelContainerCleanupError | undefined {
		this.startGeneration++; // any teardown invalidates in-flight starts
		this.hostRequestGateway.revoke();
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
		this.iopubReady = undefined;
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
		let containerCleanupError: KernelContainerCleanupError | undefined;
		const containerIds = new Set(this.containerIds);
		if (this.containerId) containerIds.add(this.containerId);
		for (const containerId of containerIds) {
			try {
				removeKernelContainer(this.options.isolation?.dockerBinary ?? "docker", containerId);
				this.containerIds.delete(containerId);
				if (this.containerId === containerId) this.containerId = undefined;
			} catch (error) {
				if (this.containerId === undefined) this.containerId = containerId;
				containerCleanupError ??=
					error instanceof KernelContainerCleanupError
						? error
						: new KernelContainerCleanupError(containerId, errorMessage(error));
			}
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
		return containerCleanupError;
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
			const cleanupError = this.cleanupResources();
			if (cleanupError) throw cleanupError;
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		let flushError: unknown;
		// Bounded final flush before teardown — used by signal handlers so a
		// SIGINT/SIGTERM exit does not silently lose an uncommitted checkpoint.
		if (opts.snapshot) {
			try {
				await this.flushSnapshotForDispose();
			} catch (error) {
				flushError = error;
			}
			if (this.startStale(generation)) return false; // superseded mid-flush: the newer owner already cleaned this kernel
		}
		this.state = "shutdown";
		liveKernels.delete(this);

		let replyWait: { promise: Promise<void>; cancel: () => void } | undefined;
		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let performedCleanup = false;
		let cleanupError: KernelContainerCleanupError | undefined;
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
				cleanupError = this.cleanupResources();
				performedCleanup = true;
			}
		}

		if (cleanupError) throw cleanupError;
		if (flushError !== undefined) throw flushError;
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
		const kernel = this.kernel;
		const forked = this.forkedKernel;
		const exited =
			kernel && kernel.exitCode === null && kernel.signalCode === null
				? new Promise<void>((resolve) => {
						kernel.once("exit", () => resolve());
						kernel.once("error", () => resolve());
					})
				: Promise.resolve();
		this.state = "shutdown";
		liveKernels.delete(this);
		const cleanupError = this.cleanupResources("SIGTERM");
		await Promise.race([exited, sleep(KERNEL_TERMINATE_GRACE_MS)]);
		try {
			if (kernel && kernel.exitCode === null && kernel.signalCode === null) kernel.kill("SIGKILL");
			else if (forked && !(await this.forkedKernelDead(forked))) {
				if ((await forked.kill("KILL")) === "signaled") recordOrphanProcessState(forked.pid, false);
			}
		} catch {
			// The exact kernel exited during the graceful termination window.
		}
		if (cleanupError) throw cleanupError;
	}

	/**
	 * Serialize the user namespace to a verified durable checkpoint.
	 *
	 * Args:
	 * None.
	 * Return: Host-safe checkpoint metadata, or null when snapshots are disabled.
	 * Throws: KernelSnapshotError when a required value, payload, or manifest is not durable.
	 */
	async snapshotState(): Promise<SnapshotResult | null> {
		return this.captureSnapshot();
	}

	/** Persist the namespace, then remove variables above the per-variable cap. */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		try {
			return await this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, pruneOversized: true });
		} catch (error) {
			this.appendKernelDiagnostic(`oversized variable compaction failed: ${errorMessage(error)}`);
			return null;
		}
	}

	private async captureSnapshot(
		options: { executionTimeoutMs?: number; pruneOversized?: boolean } = {},
	): Promise<SnapshotResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg || !this.isRunning) return null;
		const nextTurn = this.checkpointTurn + 1;
		const code = buildSnapshotCode(cfg.path, cfg.manifestPath, cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES, {
			transientNames: cfg.transientNames,
			hostOnlyNames: cfg.hostOnlyNames,
			transientClassifications: cfg.transientClassifications,
			reproducibleNames: cfg.reproducibleNames,
			requiredNames: cfg.requiredNames,
			artifactRoot: cfg.artifactRoot,
			checkpointTurn: nextTurn,
			previousCheckpointTurn: this.checkpointTurn > 0 ? this.checkpointTurn : null,
			previousDurableBytes: this.previousDurableBytes,
			maxRetainedValues: cfg.maxRetainedValues,
			maxVariableBytes: cfg.maxVariableBytes ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
			pruneOversized: options.pruneOversized,
		});
		const r = await this.enqueueExecute(
			code,
			{ maxOutputChars: SNAPSHOT_MAX_OUTPUT_CHARS, internal: true },
			options.executionTimeoutMs,
		);
		if (r.status !== "ok") {
			throw new KernelSnapshotError(
				`state snapshot ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
			);
		}
		const parsed = parseSnapshotResult(r.stdout, cfg.path);
		if (!parsed) {
			throw new KernelSnapshotError(
				`state snapshot failed closed: ${parseKernelStateError(r.stdout) ?? "the kernel did not commit a verifiable payload and manifest"}`,
			);
		}
		this.checkpointTurn = parsed.checkpointTurn ?? nextTurn;
		this.previousDurableBytes = parsed.durableBytes ?? this.previousDurableBytes;
		if (cfg.checkpointTelemetry) {
			try {
				await recordWorkflowCheckpointBudgetTelemetry(
					buildCheckpointTelemetryInput(parsed, this.pendingRestoreTiming),
					cfg.checkpointTelemetry,
				);
			} catch (error) {
				throw new KernelSnapshotError(`checkpoint telemetry failed: ${errorMessage(error)}`);
			}
			this.pendingRestoreTiming = null;
		}
		return parsed;
	}

	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored.
	 *
	 * Args:
	 * None.
	 * Return: Host-safe restore metadata, or null when snapshots are disabled.
	 * Throws: KernelSnapshotError when an existing checkpoint is missing, corrupt, or unverifiable.
	 */
	async restoreState(): Promise<RestoreResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		const code = buildRestoreCode(
			cfg.path,
			cfg.manifestPath,
			cfg.artifactRoot,
			cfg.requiredNames,
			cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
			cfg.maxRetainedValues,
		);
		const r = await this.enqueueExecute(code, { maxOutputChars: SNAPSHOT_MAX_OUTPUT_CHARS, internal: true });
		if (r.status !== "ok") {
			throw new KernelSnapshotError(`state restore failed: ${r.error?.evalue ?? r.stderr}`);
		}
		const parsed = parseRestoreResult(r.stdout, cfg.path);
		if (!parsed) {
			throw new KernelSnapshotError(
				"state restore failed closed: the existing checkpoint is missing, corrupt, or unverifiable",
			);
		}
		if (parsed.missing) {
			if (cfg.requiredNames && cfg.requiredNames.length > 0) {
				throw new KernelSnapshotError("state restore failed closed: required snapshot state is missing");
			}
			this.pendingRestoreTiming = null;
			return parsed;
		}
		this.checkpointTurn = parsed.checkpointTurn ?? this.checkpointTurn;
		this.previousDurableBytes = parsed.durableBytes ?? this.previousDurableBytes;
		this.pendingRestoreTiming =
			parsed.restoreStartedAtMonotonicMs !== undefined && parsed.restoreEndedAtMonotonicMs !== undefined
				? {
						restoreStartedAtMonotonicMs: parsed.restoreStartedAtMonotonicMs,
						restoreEndedAtMonotonicMs: parsed.restoreEndedAtMonotonicMs,
					}
				: null;
		return parsed;
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
			void this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS }).catch((error: unknown) => {
				this.appendKernelDiagnostic(`state snapshot error: ${errorMessage(error)}`);
			});
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

	/** Final snapshot before a graceful dispose, bounded by a timeout and fail-closed. */
	private async flushSnapshotForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		this.clearSnapshotTimer();
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const guard = new Promise<void>((resolve) => {
			timeout = globalThis.setTimeout(resolve, SNAPSHOT_DISPOSE_TIMEOUT_MS);
			if (timeout && typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});
		const snapshot = this.snapshotState();
		try {
			const result = await Promise.race([
				snapshot.then(() => "committed" as const),
				guard.then(() => "timed_out" as const),
			]);
			if (result === "timed_out") {
				throw new KernelSnapshotError(
					`final state snapshot did not commit within ${SNAPSHOT_DISPOSE_TIMEOUT_MS}ms`,
				);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
			if (snapshot) void snapshot.catch(() => undefined);
		}
	}

	/** Graceful cleanup. Waits briefly for in-flight host request handlers before closing sockets. */
	dispose(): Promise<void> {
		return (async () => {
			// Captured before any await: teardowns and newer starts bump the counter.
			const generation = this.startGeneration;
			// Final namespace flush while the kernel is still live (session end / reload).
			let flushError: unknown;
			try {
				await this.flushSnapshotForDispose();
			} catch (error) {
				flushError = error;
			}
			if (this.startStale(generation)) {
				// Superseded mid-flush: the newer owner already cleaned this kernel.
				if (flushError !== undefined) throw flushError;
				return;
			}
			this.state = "shutdown";
			liveKernels.delete(this);
			const inFlightHostRequests = [...this.inFlightHostRequests];
			// TODO: plumb AbortSignal through AgentSession.prompt so disposal can cancel long-running child loops.
			let cleanupError: KernelContainerCleanupError | undefined;
			try {
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_DISPOSE_TIMEOUT_MS);
				}
			} finally {
				if (!this.startStale(generation)) cleanupError = this.cleanupResources(); // else: superseded, the newer owner already cleaned
			}
			if (cleanupError) throw cleanupError;
			if (flushError !== undefined) throw flushError;
		})();
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.state = "shutdown";
		liveKernels.delete(this);
		// TODO: replace this best-effort hard-exit path if Node exposes an awaitable process-exit cleanup hook.
		const cleanupError = this.cleanupResources();
		if (cleanupError) this.appendKernelDiagnostic(cleanupError.message);
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
