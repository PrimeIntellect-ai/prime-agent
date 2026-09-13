import type { KernelAttachment, KernelDiffDisplay, KernelSentAgentMessage } from "./contracts.js";

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

/** MIME tag the `edit` skill emits diff payloads under. */
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

/** MIME tag the `attach-image` skill emits media payloads under. */
export const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";

/** MIME tag the `agent-message` skill emits after sending a message. */
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

/** Internal lifetime notices, consumed before user display rendering. */
export const BASH_ACTIVITY_DISPLAY_MIME = "application/vnd.prime-agent.bash-activity+json";

/**
 * Hard ceiling on a single attachment's base64 payload, a defensive guard
 * against a runaway direct display emit. The `attach-image` skill caps
 * its own images well under this (see `_MAX_IMAGE_BYTES`), so a skill-produced
 * attachment is never dropped here — only a non-skill emit can hit this.
 */
export const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

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
