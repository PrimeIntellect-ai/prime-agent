import { randomUUID } from "node:crypto";

import {
	CONNECT_FRAME_COMPRESSED,
	CONNECT_FRAME_END_OF_STREAM,
	type CommandInputChannel,
	type CommandSessionEndEvent,
	type CommandSessionEvent,
	CommandSessionProtoError,
	type CommandSpec,
	ConnectFrameDecoder,
	decodeCommandSessionEventResponse,
	encodeConnectFrame,
	encodeConnectRequest,
	encodeSendInputRequest,
	encodeSendSignalRequest,
	encodeStartRequest,
	encodeUpdateRequest,
	OversizeConnectFrameError,
	type PtySize,
	type StartRequest,
	type VmSignalName,
} from "./command-session-proto.js";

/**
 * ConnectRPC client for the sandboxd `command_session.CommandSession` service
 * (VM sandboxes only), spoken over the sandbox gateway's authenticated
 * `/{user_ns}/{job_id}` path with the sandbox-bound gateway token.
 *
 * This is the raw process API the cloud-delegation plan needs, not a subprocess
 * wrapper: a Start with a caller-supplied session UUID is create-or-attach
 * (re-issuing the identical request attaches to the session or replays its
 * retained end event — never a second process), so the local daemon can confirm
 * a resident launch and then release the transport without terminating the
 * process it started. There is no `close()` that signals: the only ways to
 * affect the process are the explicit SendInput/SendSignal/Update RPCs.
 *
 * Wire contract (verified against platform source, sandboxd process service
 * and the sandbox gateway):
 * - Unary RPCs (SendInput/SendSignal/Update): `POST
 *   {gateway}/{ns}/{job}/command_session.CommandSession/{Method}`, request body
 *   `application/proto`, response body the empty response message.
 * - Server-streaming RPCs (Start/Connect): request body one enveloped frame
 *   (`application/connect+proto`), response frames of StartResponse/
 *   ConnectResponse events, terminated by an end-of-stream JSON frame.
 * - Errors: connect JSON bodies (`{"code","message"}`) win; gateway-shaped
 *   bodies (`{"error","message"}`) and bare statuses fall back to an
 *   HTTP-status map. 401/unauthenticated re-auths exactly once per operation.
 * - `Connect-Timeout-Ms` on Start also bounds the remote process (sandboxd
 *   reads it as the process deadline; `0` disables the deadline). Reattach
 *   attempts do not extend the deadline the first Start set.
 * - `Keepalive-Ping-Interval` (seconds) paces sandboxd's keepalive events,
 *   which keep long-lived attachment streams from being reaped as idle.
 *
 * Safety contract:
 * - The gateway token never appears in URLs, error messages, or previews.
 * - Every frame and body is bounded; oversize frames abort the stream.
 * - Responses are strictly decoded; malformed input is a typed
 *   `invalid_response`, never a silent default.
 * - Control RPCs resend byte-identical requests across retries; input and
 *   signal UUIDs make duplicates at-most-once on the server.
 */

// ---------------------------------------------------------------------------
// Errors and codes
// ---------------------------------------------------------------------------

/** Client-side failure codes plus the Connect codes this surface can surface. */
export type VmProcessErrorCode =
	/** Bad caller input; nothing was sent. */
	| "invalid_request"
	/** Transport-level fault before/at HTTP. */
	| "network"
	/** Client-side deadline elapsed. */
	| "timeout"
	/** Peer response violated the wire contract. */
	| "invalid_response"
	/** Peer data exceeded a bound. */
	| "too_large"
	/** The stream was released locally before the process ended. */
	| "released"
	| "canceled"
	| "unknown"
	| "invalid_argument"
	| "deadline_exceeded"
	| "not_found"
	| "already_exists"
	| "permission_denied"
	| "resource_exhausted"
	| "failed_precondition"
	| "aborted"
	| "out_of_range"
	| "unimplemented"
	| "internal"
	| "unavailable"
	| "data_loss"
	| "unauthenticated"
	/** Gateway 502 with `{ error: "sandbox_not_found" }`: the sandbox is gone. */
	| "sandbox_not_found";

/** Typed error for every client and Connect failure. Never carries a secret. */
export class VmProcessError extends Error {
	readonly code: VmProcessErrorCode;
	/** RPC method name when the failure is tied to an RPC. */
	readonly method?: string;
	/** Sanitized request URL (no credentials) when applicable. */
	readonly url?: string;
	/** HTTP status for gateway/HTTP-level failures. */
	readonly status?: number;
	/** Bounded, secret-scrubbed response preview when a body was read. */
	readonly details?: string;

	constructor(
		code: VmProcessErrorCode,
		message: string,
		properties: {
			method?: string;
			url?: string;
			status?: number;
			details?: string;
			cause?: unknown;
		} = {},
	) {
		super(message, properties.cause !== undefined ? { cause: properties.cause } : undefined);
		this.name = "VmProcessError";
		this.code = code;
		this.method = properties.method;
		this.url = properties.url;
		this.status = properties.status;
		this.details = properties.details;
	}
}

const CONNECT_CODES: ReadonlySet<string> = new Set([
	"canceled",
	"unknown",
	"invalid_argument",
	"deadline_exceeded",
	"not_found",
	"already_exists",
	"permission_denied",
	"resource_exhausted",
	"failed_precondition",
	"aborted",
	"out_of_range",
	"unimplemented",
	"internal",
	"unavailable",
	"data_loss",
	"unauthenticated",
]);

const MAX_PREVIEW_CHARS = 512;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_UNARY_BODY_BYTES = 1024 * 1024;

const URL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Budgets the platform documents for live processes (SDK-verified defaults).
export const MAX_PROCESS_INPUT_BYTES = 1024 * 1024;
export const DEFAULT_EVENT_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SEND_INPUT_TIMEOUT_MS = 30_000;
export const DEFAULT_SEND_SIGNAL_TIMEOUT_MS = 10_000;
export const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;
export const DEFAULT_UNARY_ATTEMPTS = 3;
export const DEFAULT_UNARY_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_RECONNECTS = 5;
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_PENDING_EVENTS = 1024;
/** sandboxd's own default keepalive cadence (permissions/keep_alive.go). */
export const DEFAULT_KEEPALIVE_INTERVAL_SECONDS = 90;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Gateway credentials resolved per operation. `PrimeSandboxAuth` satisfies this. */
export interface VmGatewayAuth {
	gatewayUrl: string;
	userNamespace: string;
	jobId: string;
	/** Sandbox-bound gateway bearer token. Never logged. */
	token: string;
}

/** Injected auth source. Callers own caching and proactive expiry refresh. */
export interface VmProcessAuthSource {
	/** Current (cached) sandbox auth. */
	getAuth(): Promise<VmGatewayAuth>;
	/** Force-refresh on 401/unauthenticated; defaults to `getAuth`. */
	refreshAuth?(): Promise<VmGatewayAuth>;
}

export interface VmProcessClientOptions {
	auth: VmProcessAuthSource;
	/** Injectable fetch; defaults to the global fetch. */
	fetchFn?: typeof fetch;
	/** Default per-RPC client deadline; per-call `connectTimeoutMs` overrides. */
	requestTimeoutMs?: number;
	/** Hard cap on a single streaming frame; default 4 MiB. */
	maxEventFrameBytes?: number;
	/** `Keepalive-Ping-Interval` seconds header on streaming RPCs; default 90. */
	keepaliveIntervalSeconds?: number;
	/** Permit plain http:// for loopback gateway URLs. */
	allowInsecureLocalhost?: boolean;
	/** Injectable sleep for retry backoff. */
	sleepFn?: (ms: number) => Promise<void>;
}

/** Attach tuning for one process stream. */
export interface VmProcessStreamOptions {
	/** Reattach budget for recoverable stream faults; default 5. */
	maxReconnects?: number;
	/** Exponential backoff base: base * 2^(n-1); default 500ms. */
	reconnectBaseDelayMs?: number;
	/** In-memory event backlog bound; the stream stops reading when full. */
	maxPendingEvents?: number;
	/** Injectable sleep for reconnect backoff (tests). */
	sleepFn?: (ms: number) => Promise<void>;
}

export interface VmStartOptions extends VmProcessStreamOptions {
	/**
	 * `Connect-Timeout-Ms` on Start: sandboxd kills the process at this
	 * deadline (the attachment aborts at it too). `0` sends an explicit
	 * no-deadline; omit to inherit the server default. Reconnecting does not
	 * extend the deadline the first Start set. Unary control RPCs never set
	 * the process deadline; sandboxd reads the header as one only in Start.
	 */
	connectTimeoutMs?: number;
}

export interface VmControlOptions {
	/** Client deadline for the control RPC. */
	connectTimeoutMs?: number;
}

export interface VmSendInputOptions extends VmControlOptions {
	/**
	 * At-most-once key for this write. Generated when omitted; a retried
	 * attempt resends it byte-identically, and the server acknowledges a
	 * duplicate without writing again.
	 */
	inputUuid?: string;
}

export interface VmSendSignalOptions extends VmControlOptions {
	/** At-most-once key for this delivery; generated when omitted. */
	signalUuid?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaType(contentType: string | null): string {
	if (contentType === null) return "";
	return contentType.split(";")[0].trim().toLowerCase();
}

function redactSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret !== "") {
			redacted = redacted.split(secret).join("[redacted]");
		}
	}
	return redacted;
}

function boundPreview(text: string): string {
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	return `${text.slice(0, MAX_PREVIEW_CHARS)}…`;
}

/** Map an HTTP status onto a Connect code when no JSON code is available. */
function codeFromStatus(status: number): VmProcessErrorCode {
	switch (status) {
		case 400:
			return "invalid_argument";
		case 401:
			return "unauthenticated";
		case 403:
			return "permission_denied";
		case 404:
			return "unimplemented";
		case 408:
			return "deadline_exceeded";
		case 429:
			return "unavailable";
		case 500:
			return "internal";
		case 501:
			return "unimplemented";
		case 502:
			return "unavailable";
		case 503:
			return "unavailable";
		case 504:
			return "deadline_exceeded";
		default:
			return "unknown";
	}
}

/** Codec and transport faults mapped onto the typed client error. */
function toVmProcessError(error: unknown): VmProcessError {
	if (error instanceof VmProcessError) {
		return error;
	}
	if (error instanceof OversizeConnectFrameError) {
		return new VmProcessError("too_large", `Command session stream frame exceeds the ${error.maxBytes} byte limit`, {
			cause: error,
		});
	}
	if (error instanceof CommandSessionProtoError) {
		const code = error.kind === "invalid_input" ? "invalid_request" : "invalid_response";
		return new VmProcessError(code, error.message, { cause: error });
	}
	if (error instanceof Error) {
		return new VmProcessError("network", error.message, { cause: error });
	}
	return new VmProcessError("network", String(error), { cause: error });
}

/**
 * Recoverable-for-reattach faults: link-level trouble and retryable server
 * codes, not definitive protocol answers. The Python SDK uses a deny-list
 * (everything except not_found/failed_precondition); this client uses this
 * stricter allow-list so permanent answers (invalid_argument,
 * unauthenticated-after-refresh, permission_denied, sandbox_not_found) do not
 * burn the reconnect budget retrying a request that cannot succeed.
 */
function isRecoverableStreamFault(error: VmProcessError): boolean {
	switch (error.code) {
		case "network":
		case "timeout":
		case "unavailable":
		case "deadline_exceeded":
		case "canceled":
		case "unknown":
		case "internal":
			return true;
		default:
			return false;
	}
}

/** Transient unary control faults worth retrying (SDK parity). */
function isTransientControlFault(error: VmProcessError): boolean {
	switch (error.code) {
		case "network":
		case "timeout":
		case "unavailable":
		case "deadline_exceeded":
			return true;
		default:
			return false;
	}
}

function isAbortLike(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// ---------------------------------------------------------------------------
// Process stream
// ---------------------------------------------------------------------------

/** Process start request; `sessionUuid` is the create-or-attach key. */
export interface VmStartRequest {
	command: CommandSpec;
	/** Initial PTY size; presence runs the command under a PTY. */
	pty?: PtySize;
	/**
	 * Explicit stdin pipe flag, encoded on the wire. `false` gives the process
	 * /dev/null stdin (sandboxd defaults an ABSENT field to true, so `false`
	 * must be sent explicitly).
	 */
	stdin: boolean;
	/** Caller-supplied create-or-attach UUID; canonicalized client-side. */
	sessionUuid: string;
}

/**
 * One live command-session stream produced by `start` or `connect`. Event
 * ordering is the sandboxd stream contract: a start event, then data and
 * keepalive events, then exactly one end event (replayed for sessions that
 * exited within sandboxd's retention window).
 */
export interface VmProcessStream {
	/** Resolves with the pid from the first start event. */
	readonly started: Promise<number>;
	/** Resolves with the end event; rejects on fault or release before exit. */
	readonly exit: Promise<CommandSessionEndEvent>;
	/**
	 * Yields start/stdout/stderr/pty/end events once. Keepalives are
	 * transport liveness only and are not yielded. Throws the typed fault when
	 * the stream failed and the reconnect budget is exhausted.
	 */
	[Symbol.asyncIterator](): AsyncIterator<CommandSessionEvent>;
	/**
	 * Close the attachment without touching the process: no signal is sent, the
	 * transport is aborted, and the exit promise rejects with
	 * `code === "released"`. This is the resident-process release path — a
	 * later Start with the same session UUID re-attaches.
	 */
	release(): Promise<void>;
	/** True once `release` was called. */
	readonly released: boolean;
}

/** One opened streaming RPC: its reader plus request context for errors. */
export interface VmProcessStreamHandle {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	method: string;
	url: string;
}

type StreamQueueItem =
	| { type: "event"; event: CommandSessionEvent }
	| { type: "end"; event: CommandSessionEndEvent }
	| { type: "fault"; error: VmProcessError };

class VmProcessStreamImpl implements VmProcessStream {
	readonly started: Promise<number>;
	readonly exit: Promise<CommandSessionEndEvent>;
	private startedSettled = false;
	private exitSettled = false;
	private releaseFlag = false;
	private readonly queue: StreamQueueItem[] = [];
	private closed = false;
	private capacityFree?: () => void;
	private itemAvailable?: () => void;
	private readonly controller = new AbortController();
	private iterating = false;
	private currentReader?: ReadableStreamDefaultReader<Uint8Array>;
	private readonly pumpDone: Promise<void>;
	private resolveStarted!: (pid: number) => void;
	private rejectStarted!: (error: VmProcessError) => void;
	private resolveExit!: (end: CommandSessionEndEvent) => void;
	private rejectExit!: (error: VmProcessError) => void;

	constructor(
		private readonly client: VmProcessClient,
		private readonly startBytes: Uint8Array,
		private readonly connectBytes: Uint8Array,
		private readonly initialSawStart: boolean,
		private readonly maxReconnects: number,
		private readonly reconnectBaseDelayMs: number,
		private readonly maxPendingEvents: number,
		private readonly sleep: (ms: number) => Promise<void>,
		private readonly connectTimeoutMs: number | undefined,
	) {
		this.started = new Promise<number>((resolve, reject) => {
			this.resolveStarted = (pid) => {
				this.startedSettled = true;
				resolve(pid);
			};
			this.rejectStarted = (error) => {
				if (!this.startedSettled) {
					this.startedSettled = true;
					reject(error);
				}
			};
		});
		this.exit = new Promise<CommandSessionEndEvent>((resolve, reject) => {
			this.resolveExit = (end) => {
				this.exitSettled = true;
				resolve(end);
			};
			this.rejectExit = (error) => {
				if (!this.exitSettled) {
					this.exitSettled = true;
					reject(error);
				}
			};
		});
		// Mark both promises handled so an unobserved rejection (e.g. exit
		// after release) never surfaces as an unhandled rejection; callers
		// that do await them still get the rejection.
		this.started.catch(() => undefined);
		this.exit.catch(() => undefined);
		this.pumpDone = this.pump().catch((error) => {
			this.finishFault(toVmProcessError(error));
		});
	}

	get released(): boolean {
		return this.releaseFlag;
	}

	async release(): Promise<void> {
		if (!this.releaseFlag) {
			this.releaseFlag = true;
			this.controller.abort();
			// Aborting the fetch should reject the pending body read, but a
			// transport that ignores the signal must still unblock: cancel the
			// reader directly, which resolves pending reads as done.
			this.currentReader?.cancel().catch(() => undefined);
			this.notifyCapacity();
		}
		await this.pumpDone;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<CommandSessionEvent> {
		if (this.iterating) {
			throw new VmProcessError("invalid_request", "Process stream already has an iterator");
		}
		this.iterating = true;
		try {
			while (true) {
				const item = await this.nextItem();
				if (item === undefined) {
					return;
				}
				if (item.type === "fault") {
					throw item.error;
				}
				if (item.type === "end") {
					yield item.event;
					return;
				}
				yield item.event;
			}
		} finally {
			this.iterating = false;
		}
	}

	// --- bounded queue with backpressure ---

	private async push(item: StreamQueueItem): Promise<void> {
		while (this.queue.length >= this.maxPendingEvents && !this.releaseFlag && !this.closed) {
			await this.waitCapacity();
		}
		if (this.releaseFlag || this.closed) {
			throw new VmProcessError("released", "Process stream was released");
		}
		this.queue.push(item);
		this.notifyItem();
	}

	private async nextItem(): Promise<StreamQueueItem | undefined> {
		while (this.queue.length === 0) {
			if (this.closed) {
				return undefined;
			}
			await this.waitItem();
		}
		const item = this.queue.shift();
		if (item === undefined) {
			return undefined;
		}
		this.notifyCapacity();
		return item;
	}

	private waitCapacity(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.capacityFree = resolve;
		});
	}

	private waitItem(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.itemAvailable = resolve;
		});
	}

	private notifyCapacity(): void {
		const waiter = this.capacityFree;
		this.capacityFree = undefined;
		waiter?.();
	}

	private notifyItem(): void {
		const waiter = this.itemAvailable;
		this.itemAvailable = undefined;
		waiter?.();
	}

	// --- pump ---

	private async pump(): Promise<void> {
		const state = { sawStart: this.initialSawStart };
		let reconnects = 0;
		while (true) {
			let fault: VmProcessError | undefined;
			let ended = false;
			try {
				const opened = await this.client.openEventStream({
					startBytes: this.startBytes,
					connectBytes: this.connectBytes,
					connectTimeoutMs: this.connectTimeoutMs,
					sawStart: state.sawStart,
					signal: this.controller.signal,
				});
				this.currentReader = opened.reader;
				try {
					ended = await this.readEvents(opened, state);
				} finally {
					this.currentReader = undefined;
					await opened.reader.cancel().catch(() => undefined);
				}
			} catch (error) {
				fault = this.mapPumpFault(error);
			}
			if (this.releaseFlag) {
				this.finishReleased();
				return;
			}
			if (ended) {
				this.finishClosed();
				return;
			}
			const recoverable = fault ?? new VmProcessError("network", "Process stream ended without an exit event");
			if (!isRecoverableStreamFault(recoverable) || reconnects >= this.maxReconnects) {
				this.finishFault(recoverable);
				return;
			}
			reconnects++;
			await this.sleep(this.reconnectBaseDelayMs * 2 ** (reconnects - 1));
			if (this.releaseFlag) {
				this.finishReleased();
				return;
			}
		}
	}

	private mapPumpFault(error: unknown): VmProcessError {
		if (this.releaseFlag && isAbortLike(error)) {
			return new VmProcessError("released", "Process stream was released");
		}
		return toVmProcessError(error);
	}

	/** Read one body chunk, mapping release and transport faults. */
	private async readChunk(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<{ done: true } | { done: false; value: Uint8Array }> {
		try {
			const result = await reader.read();
			if (result.done) {
				return { done: true };
			}
			return { done: false, value: result.value };
		} catch (error) {
			if (this.releaseFlag && isAbortLike(error)) {
				throw new VmProcessError("released", "Process stream was released");
			}
			throw toVmProcessError(error);
		}
	}

	/** Reads one attempt's frames to its end event, clean end frame, or fault. */
	private async readEvents(opened: VmProcessStreamHandle, state: { sawStart: boolean }): Promise<boolean> {
		const decoder = new ConnectFrameDecoder(this.client.maxEventFrameBytes);
		while (true) {
			const read = await this.readChunk(opened.reader);
			if (read.done) {
				if (decoder.bufferedByteLength > 0) {
					throw new VmProcessError("network", "Process stream ended mid-frame");
				}
				return false;
			}
			decoder.push(read.value);
			let frame: { flags: number; payload: Uint8Array } | null;
			try {
				frame = decoder.next();
			} catch (error) {
				throw toVmProcessError(error);
			}
			while (frame !== null) {
				if ((frame.flags & CONNECT_FRAME_COMPRESSED) !== 0) {
					throw new VmProcessError(
						"invalid_response",
						"Command session stream sent compressed frames, which this client does not negotiate",
						{ method: opened.method, url: opened.url },
					);
				}
				if ((frame.flags & CONNECT_FRAME_END_OF_STREAM) !== 0) {
					this.client.parseEndOfStreamFrame(frame.payload, opened.method, opened.url);
					return false;
				}
				const event = this.client.decodeEventFrame(frame.payload, opened.method);
				if (event === undefined || event.kind === "keepalive") {
					frame = decoder.next();
					continue;
				}
				if (event.kind === "start") {
					state.sawStart = true;
					if (!this.startedSettled) {
						this.resolveStarted(event.pid);
						await this.push({ type: "event", event });
					}
					frame = decoder.next();
					continue;
				}
				if (event.kind === "end") {
					await this.push({ type: "end", event });
					this.resolveExit(event);
					return true;
				}
				await this.push({ type: "event", event });
				frame = decoder.next();
			}
		}
	}

	private finishClosed(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.notifyItem();
		this.notifyCapacity();
	}

	private finishFault(error: VmProcessError): void {
		this.rejectStarted(error);
		this.rejectExit(error);
		if (!this.closed) {
			this.closed = true;
			this.queue.push({ type: "fault", error });
		}
		this.notifyItem();
		this.notifyCapacity();
	}

	private finishReleased(): void {
		const released = new VmProcessError("released", "Process stream was released before the process ended");
		this.rejectStarted(released);
		this.rejectExit(released);
		this.finishClosed();
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Client for the sandboxd command-session service of one sandbox. One client
 * may hold many concurrent process streams; each stream owns its own HTTP
 * request/connection because a live session occupies it for the session's
 * lifetime (the gateway caps concurrent streams per connection).
 */
export class VmProcessClient {
	private readonly auth: VmProcessAuthSource;
	private readonly fetchFn: typeof fetch;
	readonly maxEventFrameBytes: number;
	private readonly keepaliveIntervalSeconds: number;
	private readonly allowInsecureLocalhost: boolean;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: VmProcessClientOptions) {
		if (!options.auth || typeof options.auth.getAuth !== "function") {
			throw new VmProcessError("invalid_request", "VmProcessClient requires an auth source with getAuth");
		}
		this.auth = options.auth;
		this.fetchFn = options.fetchFn ?? fetch;
		const maxFrame = options.maxEventFrameBytes ?? DEFAULT_EVENT_FRAME_MAX_BYTES;
		if (!Number.isInteger(maxFrame) || maxFrame <= 0) {
			throw new VmProcessError("invalid_request", "maxEventFrameBytes must be a positive integer");
		}
		this.maxEventFrameBytes = maxFrame;
		const keepalive = options.keepaliveIntervalSeconds ?? DEFAULT_KEEPALIVE_INTERVAL_SECONDS;
		if (!Number.isInteger(keepalive) || keepalive <= 0) {
			throw new VmProcessError("invalid_request", "keepaliveIntervalSeconds must be a positive integer");
		}
		this.keepaliveIntervalSeconds = keepalive;
		this.allowInsecureLocalhost = options.allowInsecureLocalhost === true;
		this.sleep = options.sleepFn ?? defaultSleep;
	}

	/**
	 * Start (or attach to) a process. Resolves once the start event confirms
	 * the session, making it the resident-launch primitive: call `release()`
	 * right after to leave the process running. A Start whose stream faults
	 * before its start event is re-issued with identical bytes (create-or-
	 * attach); after it, reattach uses Connect with the session selector.
	 */
	async start(request: VmStartRequest, options: VmStartOptions = {}): Promise<VmProcessStream> {
		const startRequest: StartRequest = {
			command: request.command,
			pty: request.pty,
			stdin: request.stdin,
			sessionUuid: request.sessionUuid,
		};
		const startBytes = this.encodeRequest(() => encodeStartRequest(startRequest), "Start");
		const connectBytes = this.encodeRequest(() => encodeConnectRequest(request.sessionUuid), "Connect");
		const stream = this.openStream(startBytes, connectBytes, false, options);
		await stream.started;
		return stream;
	}

	/**
	 * Attach to a session by its UUID without starting anything. Replays the
	 * retained start+end events of a session that exited within the retention
	 * window. Reattach on recoverable faults re-Connects.
	 */
	async connect(sessionUuid: string, options: VmProcessStreamOptions = {}): Promise<VmProcessStream> {
		const connectBytes = this.encodeRequest(() => encodeConnectRequest(sessionUuid), "Connect");
		const stream = this.openStream(connectBytes, connectBytes, true, options);
		await stream.started;
		return stream;
	}

	/**
	 * Write bytes to the process's stdin (or its PTY). Retries transient faults
	 * with the same input UUID, so a duplicate application is acknowledged by
	 * the server without writing again.
	 */
	async sendInput(
		sessionUuid: string,
		channel: CommandInputChannel,
		data: Uint8Array,
		options: VmSendInputOptions = {},
	): Promise<void> {
		if (!(data instanceof Uint8Array)) {
			throw new VmProcessError("invalid_request", "sendInput data must be a Uint8Array");
		}
		if (data.byteLength === 0) {
			throw new VmProcessError("invalid_request", "sendInput data must not be empty");
		}
		if (data.byteLength > MAX_PROCESS_INPUT_BYTES) {
			throw new VmProcessError("too_large", `sendInput data exceeds the ${MAX_PROCESS_INPUT_BYTES} byte limit`);
		}
		const inputUuid = options.inputUuid ?? randomUUID();
		const requestBytes = this.encodeRequest(
			() => encodeSendInputRequest(sessionUuid, channel, data, inputUuid),
			"SendInput",
		);
		await this.unaryWithRetry("SendInput", requestBytes, options, DEFAULT_SEND_INPUT_TIMEOUT_MS);
	}

	/** Deliver SIGTERM (`terminate`) or SIGKILL (`kill`) to the session. */
	async sendSignal(sessionUuid: string, signal: VmSignalName, options: VmSendSignalOptions = {}): Promise<void> {
		const signalUuid = options.signalUuid ?? randomUUID();
		const requestBytes = this.encodeRequest(
			() => encodeSendSignalRequest(sessionUuid, signal, signalUuid),
			"SendSignal",
		);
		await this.unaryWithRetry("SendSignal", requestBytes, options, DEFAULT_SEND_SIGNAL_TIMEOUT_MS);
	}

	/** Resize the session's PTY (`Update`). */
	async resize(sessionUuid: string, size: PtySize, options: VmControlOptions = {}): Promise<void> {
		const requestBytes = this.encodeRequest(() => encodeUpdateRequest(sessionUuid, size), "Update");
		await this.unaryWithRetry("Update", requestBytes, options, DEFAULT_UPDATE_TIMEOUT_MS);
	}

	// --- internals ---

	private encodeRequest(encode: () => Uint8Array, method: string): Uint8Array {
		try {
			return encode();
		} catch (error) {
			const fault = toVmProcessError(error);
			if (fault.code === "invalid_request" || fault.code === "invalid_response") {
				throw fault;
			}
			throw new VmProcessError("invalid_request", `${method} request encoding failed: ${fault.message}`, {
				method,
				cause: fault,
			});
		}
	}

	private openStream(
		startBytes: Uint8Array,
		connectBytes: Uint8Array,
		initialSawStart: boolean,
		options: VmProcessStreamOptions,
	): VmProcessStream {
		const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
		if (!Number.isInteger(maxReconnects) || maxReconnects < 0) {
			throw new VmProcessError("invalid_request", "maxReconnects must be a non-negative integer");
		}
		const baseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
		if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
			throw new VmProcessError("invalid_request", "reconnectBaseDelayMs must be a non-negative integer");
		}
		const maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
		if (!Number.isInteger(maxPendingEvents) || maxPendingEvents < 1) {
			throw new VmProcessError("invalid_request", "maxPendingEvents must be a positive integer");
		}
		const connectTimeoutMs = (options as VmStartOptions).connectTimeoutMs;
		if (connectTimeoutMs !== undefined && (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 0)) {
			throw new VmProcessError("invalid_request", "connectTimeoutMs must be a non-negative integer");
		}
		return new VmProcessStreamImpl(
			this,
			startBytes,
			connectBytes,
			initialSawStart,
			maxReconnects,
			baseDelayMs,
			maxPendingEvents,
			options.sleepFn ?? this.sleep,
			connectTimeoutMs,
		);
	}

	/** Open one streaming attempt: auth, Start-vs-Connect routing, framing. */
	async openEventStream(request: {
		startBytes: Uint8Array;
		connectBytes: Uint8Array;
		connectTimeoutMs: number | undefined;
		sawStart: boolean;
		signal: AbortSignal;
	}): Promise<VmProcessStreamHandle> {
		const method = request.sawStart ? "Connect" : "Start";
		const payload = request.sawStart ? request.connectBytes : request.startBytes;
		return this.withAuthRetry(async (auth) => {
			const url = this.rpcUrl(auth, method);
			const headers = this.streamHeaders(auth, request.connectTimeoutMs);
			const response = await this.fetchWithDeadline(
				"POST",
				url,
				headers,
				encodeConnectFrame(payload),
				request.connectTimeoutMs === undefined || request.connectTimeoutMs === 0
					? undefined
					: request.connectTimeoutMs,
				[auth.token],
				request.signal,
				method,
			);
			if (!response.ok) {
				throw await this.errorFromResponse(response, method, url, [auth.token], `Command session ${method}`);
			}
			const contentType = mediaType(response.headers.get("content-type"));
			if (contentType !== "application/connect+proto") {
				throw new VmProcessError(
					"invalid_response",
					`Command session ${method} must respond application/connect+proto`,
					{ method, url, status: response.status },
				);
			}
			if (response.body === null || typeof response.body.getReader !== "function") {
				throw new VmProcessError("invalid_response", `Command session ${method} response has no streamable body`, {
					method,
					url,
					status: response.status,
				});
			}
			return { reader: response.body.getReader(), method, url };
		});
	}

	/** Decode one event frame; `undefined` for an event-less response message. */
	decodeEventFrame(payload: Uint8Array, method: string): CommandSessionEvent | undefined {
		try {
			return decodeCommandSessionEventResponse(payload, `${method}Response`);
		} catch (error) {
			throw toVmProcessError(error);
		}
	}

	/** Parse a Connect end-of-stream frame; throws the stream error when set. */
	parseEndOfStreamFrame(payload: Uint8Array, method: string, url: string): void {
		let parsed: unknown = {};
		if (payload.byteLength > 0) {
			try {
				parsed = JSON.parse(new TextDecoder().decode(payload));
			} catch (error) {
				throw new VmProcessError("invalid_response", `Command session ${method} end-of-stream frame is not JSON`, {
					method,
					url,
					cause: error,
				});
			}
		}
		if (!isRecord(parsed)) {
			throw new VmProcessError(
				"invalid_response",
				`Command session ${method} end-of-stream frame is not an object`,
				{ method, url },
			);
		}
		const streamError = parsed.error;
		if (streamError === undefined) {
			return;
		}
		if (!isRecord(streamError)) {
			throw new VmProcessError("invalid_response", `Command session ${method} end-of-stream error is malformed`, {
				method,
				url,
			});
		}
		const code =
			typeof streamError.code === "string" && CONNECT_CODES.has(streamError.code)
				? (streamError.code as VmProcessErrorCode)
				: "unknown";
		const message =
			typeof streamError.message === "string" ? streamError.message : `Command session ${method} failed (${code})`;
		throw new VmProcessError(code, message, { method, url });
	}

	private async unaryWithRetry(
		method: string,
		requestBytes: Uint8Array,
		options: VmControlOptions,
		defaultTimeoutMs: number,
	): Promise<void> {
		const timeoutMs = options.connectTimeoutMs ?? defaultTimeoutMs;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
			throw new VmProcessError("invalid_request", "connectTimeoutMs must be a positive integer");
		}
		let attempt = 0;
		while (true) {
			attempt++;
			try {
				await this.unary(method, requestBytes, timeoutMs);
				return;
			} catch (error) {
				const fault = toVmProcessError(error);
				if (attempt >= DEFAULT_UNARY_ATTEMPTS || !isTransientControlFault(fault)) {
					throw fault;
				}
				await this.sleep(DEFAULT_UNARY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
			}
		}
	}

	private async unary(method: string, requestBytes: Uint8Array, timeoutMs: number): Promise<void> {
		await this.withAuthRetry(async (auth) => {
			const url = this.rpcUrl(auth, method);
			const headers = this.unaryHeaders(auth, timeoutMs);
			const response = await this.fetchWithDeadline(
				"POST",
				url,
				headers,
				requestBytes,
				timeoutMs,
				[auth.token],
				undefined,
				method,
			);
			if (!response.ok) {
				throw await this.errorFromResponse(response, method, url, [auth.token], `Command session ${method}`);
			}
			const contentType = mediaType(response.headers.get("content-type"));
			if (contentType !== "application/proto") {
				throw new VmProcessError("invalid_response", `Command session ${method} must respond application/proto`, {
					method,
					url,
					status: response.status,
				});
			}
			const body = await this.readUnaryBody(response, method, url);
			if (body.byteLength !== 0) {
				try {
					decodeEmptyMessage(body);
				} catch (error) {
					throw toVmProcessError(error);
				}
			}
		});
	}

	private async readUnaryBody(response: Response, method: string, url: string): Promise<Uint8Array> {
		const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_UNARY_BODY_BYTES) {
			throw new VmProcessError("too_large", `Command session ${method} response exceeds the unary body limit`, {
				method,
				url,
				status: response.status,
			});
		}
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > MAX_UNARY_BODY_BYTES) {
			throw new VmProcessError("too_large", `Command session ${method} response exceeds the unary body limit`, {
				method,
				url,
				status: response.status,
			});
		}
		return new Uint8Array(buffer);
	}

	private async withAuthRetry<T>(operation: (auth: VmGatewayAuth) => Promise<T>): Promise<T> {
		let refreshed = false;
		while (true) {
			const auth = refreshed
				? await this.resolveAuth(this.auth.refreshAuth ?? this.auth.getAuth, true)
				: await this.resolveAuth(this.auth.getAuth, false);
			try {
				return await operation(auth);
			} catch (error) {
				if (!refreshed && error instanceof VmProcessError && error.code === "unauthenticated") {
					refreshed = true;
					continue;
				}
				throw error;
			}
		}
	}

	private async resolveAuth(resolve: () => Promise<VmGatewayAuth>, refresh: boolean): Promise<VmGatewayAuth> {
		let auth: VmGatewayAuth;
		try {
			auth = await resolve.call(this.auth);
		} catch (error) {
			throw toVmProcessError(error);
		}
		if (!auth || typeof auth.gatewayUrl !== "string" || typeof auth.token !== "string" || auth.token === "") {
			throw new VmProcessError(
				"invalid_response",
				refresh ? "refreshAuth returned no usable gateway auth" : "getAuth returned no usable gateway auth",
			);
		}
		return auth;
	}

	private rpcUrl(auth: VmGatewayAuth, method: string): string {
		const gatewayUrl = this.validateGatewayUrl(auth.gatewayUrl);
		if (!URL_SEGMENT_PATTERN.test(auth.userNamespace) || !URL_SEGMENT_PATTERN.test(auth.jobId)) {
			throw new VmProcessError("invalid_response", "Gateway auth userNamespace and jobId must be URL-safe segments");
		}
		return `${gatewayUrl}/${encodeURIComponent(auth.userNamespace)}/${encodeURIComponent(auth.jobId)}/command_session.CommandSession/${method}`;
	}

	private validateGatewayUrl(raw: string): string {
		if (typeof raw !== "string" || raw.includes("?") || raw.includes("#")) {
			throw new VmProcessError("invalid_response", "Gateway auth gatewayUrl must be a URL");
		}
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new VmProcessError("invalid_response", "Gateway auth gatewayUrl must be a URL");
		}
		if (url.username !== "" || url.password !== "" || url.hostname === "") {
			throw new VmProcessError("invalid_response", "Gateway auth gatewayUrl must be a credential-free URL");
		}
		if (url.protocol === "https:") {
			return raw.replace(/\/+$/, "");
		}
		if (url.protocol === "http:" && this.allowInsecureLocalhost && LOCAL_HOSTNAMES.has(url.hostname)) {
			return raw.replace(/\/+$/, "");
		}
		throw new VmProcessError("invalid_response", "Gateway auth gatewayUrl must be an https URL");
	}

	private streamHeaders(auth: VmGatewayAuth, connectTimeoutMs: number | undefined): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.token}`,
			"Content-Type": "application/connect+proto",
			"Connect-Protocol-Version": "1",
			"Keepalive-Ping-Interval": String(this.keepaliveIntervalSeconds),
		};
		if (connectTimeoutMs !== undefined) {
			headers["Connect-Timeout-Ms"] = String(connectTimeoutMs);
		}
		return headers;
	}

	private unaryHeaders(auth: VmGatewayAuth, timeoutMs: number): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.token}`,
			"Content-Type": "application/proto",
			"Connect-Protocol-Version": "1",
			// The standard Connect deadline header; sandboxd additionally
			// reads it as the process deadline only in Start.
			"Connect-Timeout-Ms": String(timeoutMs),
		};
		return headers;
	}

	private async errorFromResponse(
		response: Response,
		method: string,
		url: string,
		secrets: readonly string[],
		context: string,
	): Promise<VmProcessError> {
		const text = await this.boundedErrorBody(response);
		const preview = text === undefined || text === "" ? undefined : boundPreview(redactSecrets(text, secrets));
		let parsed: unknown;
		if (text !== undefined) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = undefined;
			}
		}
		let code: VmProcessErrorCode | undefined;
		let message: string | undefined;
		if (isRecord(parsed)) {
			if (typeof parsed.code === "string" && CONNECT_CODES.has(parsed.code)) {
				code = parsed.code as VmProcessErrorCode;
				message = typeof parsed.message === "string" ? parsed.message : undefined;
			} else if (parsed.error === "sandbox_not_found" && response.status === 502) {
				code = "sandbox_not_found";
				message = typeof parsed.message === "string" ? parsed.message : undefined;
			} else if (typeof parsed.error === "string") {
				// Gateway-shaped errors: {"error": "...", "message": "..."}.
				const gatewayMessage = typeof parsed.message === "string" ? parsed.message : undefined;
				code = codeFromStatus(response.status);
				message = gatewayMessage ?? `${context} failed with gateway error ${JSON.stringify(parsed.error)}`;
			}
		}
		code ??= codeFromStatus(response.status);
		message ??= `${context} failed with HTTP ${response.status}`;
		// Error messages can echo peer-controlled bytes; never leak the token.
		return new VmProcessError(code, redactSecrets(message, secrets), {
			method,
			url,
			status: response.status,
			details: preview,
		});
	}

	private async boundedErrorBody(response: Response): Promise<string | undefined> {
		if (response.body !== null && typeof response.body.getReader === "function") {
			const reader = response.body.getReader();
			const chunks: string[] = [];
			const decoder = new TextDecoder();
			let received = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					received += value.byteLength;
					chunks.push(decoder.decode(value, { stream: true }));
					if (received > MAX_ERROR_BODY_BYTES) {
						break;
					}
				}
			} catch {
				return undefined;
			} finally {
				await reader.cancel().catch(() => undefined);
			}
			return chunks.join("");
		}
		try {
			return await response.text();
		} catch {
			return undefined;
		}
	}

	private async fetchWithDeadline(
		method: string,
		url: string,
		headers: Record<string, string>,
		body: Uint8Array,
		timeoutMs: number | undefined,
		secrets: readonly string[],
		externalSignal: AbortSignal | undefined,
		rpcMethod: string,
	): Promise<Response> {
		const controller = new AbortController();
		const requestSignal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutMessage = `Command session ${rpcMethod} timed out after ${timeoutMs}ms`;
		const timeoutPromise =
			timeoutMs === undefined
				? new Promise<never>(() => undefined)
				: new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => {
							timedOut = true;
							controller.abort();
							reject(new VmProcessError("timeout", timeoutMessage, { method: rpcMethod, url }));
						}, timeoutMs);
					});
		const fetchPromise = (async () => {
			try {
				return await this.fetchFn(url, {
					method,
					headers,
					body,
					signal: requestSignal,
				});
			} catch (error) {
				if (externalSignal?.aborted === true) {
					throw new VmProcessError("canceled", `Command session ${rpcMethod} was released`, {
						method: rpcMethod,
					});
				}
				if (timedOut) {
					throw new VmProcessError("timeout", timeoutMessage, { method: rpcMethod, url });
				}
				const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
				throw new VmProcessError("network", detail, { method: rpcMethod, url, cause: error });
			}
		})();
		try {
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			clearTimeout(timer);
			fetchPromise.catch(() => undefined);
		}
	}
}

/** Decode a proto message that may contain only unknown fields; otherwise throw. */
function decodeEmptyMessage(body: Uint8Array): void {
	let offset = 0;
	while (offset < body.byteLength) {
		const tag = readVarint(body, offset);
		offset = tag.next;
		const field = Math.floor(tag.value / 8);
		const wire = tag.value % 8;
		if (field === 0) {
			throw new CommandSessionProtoError("invalid_wire", "empty response: field number 0 is invalid");
		}
		switch (wire) {
			case 0:
				offset = readVarint(body, offset).next;
				break;
			case 1:
				if (offset + 8 > body.byteLength) {
					throw new CommandSessionProtoError("invalid_wire", "empty response: truncated 64-bit field");
				}
				offset += 8;
				break;
			case 2: {
				const length = readVarint(body, offset);
				offset = length.next;
				if (offset + length.value > body.byteLength) {
					throw new CommandSessionProtoError("invalid_wire", "empty response: truncated length-delimited field");
				}
				offset += length.value;
				break;
			}
			case 5:
				if (offset + 4 > body.byteLength) {
					throw new CommandSessionProtoError("invalid_wire", "empty response: truncated 32-bit field");
				}
				offset += 4;
				break;
			default:
				throw new CommandSessionProtoError("invalid_wire", `empty response: unsupported wire type ${wire}`);
		}
	}
}

function readVarint(data: Uint8Array, offset: number): { value: number; next: number } {
	let value = 0;
	let shift = 0;
	let count = 0;
	while (true) {
		if (offset >= data.byteLength) {
			throw new CommandSessionProtoError("invalid_wire", "empty response: truncated varint");
		}
		const byte = data[offset];
		offset++;
		count++;
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			return { value, next: offset };
		}
		shift += 7;
		if (count >= 10) {
			throw new CommandSessionProtoError("invalid_wire", "empty response: varint exceeds 10 bytes");
		}
	}
}
