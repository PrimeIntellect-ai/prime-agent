import lockfile from "proper-lockfile";

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 20;

export function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error) || error.code === undefined) {
		return undefined;
	}
	return String(error.code);
}

const retrySignal = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire a cross-process lock without yielding the event loop. These callers
 * expose synchronous APIs and cannot await, so contention is retried on a
 * bounded synchronous wait and any non-ELOCKED failure is surfaced immediately.
 */
export function acquireSyncFileLock(
	target: string,
	options: { lockfilePath?: string; staleMs?: number } = {},
): () => void {
	for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
		try {
			return lockfile.lockSync(target, {
				realpath: false,
				...(options.lockfilePath ? { lockfilePath: options.lockfilePath } : {}),
				...(options.staleMs === undefined ? {} : { stale: options.staleMs }),
			});
		} catch (error) {
			if (errorCode(error) !== "ELOCKED" || attempt === MAX_LOCK_ATTEMPTS) throw error;
			// Atomics.wait sleeps the thread against the monotonic scheduler, so a wall-clock
			// jump cannot extend the wait and the retry does not burn a core while it waits.
			Atomics.wait(retrySignal, 0, 0, LOCK_RETRY_DELAY_MS);
		}
	}
	throw new Error(`Unable to lock ${target}`);
}
