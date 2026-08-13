/**
 * Default silence budget for a provider stream that has already started.
 *
 * A server that holds the connection open while sending nothing is indistinguishable
 * from a hung request, and the read never returns on its own. Five minutes is well past
 * any real inter-event gap, including long reasoning turns, so crossing it means the
 * stream is broken rather than slow.
 */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

/**
 * Raised when a stream produces no bytes within its stall budget. Classified as a
 * server error so the existing retry path treats it as transient: a false positive
 * costs one retry, never a failed turn.
 */
export class StreamStallError extends Error {
	readonly type = "server_error";
	readonly stallTimeoutMs: number;

	constructor(stallTimeoutMs: number) {
		super(`Provider stream sent no data for ${Math.round(stallTimeoutMs / 1000)}s`);
		this.name = "StreamStallError";
		this.stallTimeoutMs = stallTimeoutMs;
	}
}

/** Normalize a configured stall budget. Zero, negative, and non-finite values disable it. */
export function resolveStallTimeoutMs(configured: number | undefined): number {
	if (configured === undefined) return DEFAULT_STREAM_STALL_TIMEOUT_MS;
	if (!Number.isFinite(configured) || configured <= 0) return 0;
	return Math.round(configured);
}

/**
 * Await one read, failing if it produces nothing within the budget. The timer is armed
 * per read rather than for the whole stream, so a long but progressing response is never
 * cut off; only silence counts against it.
 */
export async function readWithStallTimeout<T>(read: () => Promise<T>, stallTimeoutMs: number): Promise<T> {
	if (stallTimeoutMs <= 0) return read();

	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<never>((_resolve, reject) => {
				timer = globalThis.setTimeout(() => reject(new StreamStallError(stallTimeoutMs)), stallTimeoutMs);
				if (timer && typeof timer === "object" && "unref" in timer) {
					timer.unref();
				}
			}),
		]);
	} finally {
		if (timer) globalThis.clearTimeout(timer);
	}
}
