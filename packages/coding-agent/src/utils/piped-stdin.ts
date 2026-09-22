import type { Readable } from "node:stream";

/**
 * Env override for the no-input window of a non-interactive stdin read, in
 * milliseconds. `0` skips the read entirely; values above the cap are clamped.
 */
export const STDIN_IDLE_TIMEOUT_MS_ENV = "PI_STDIN_TIMEOUT_MS";

const DEFAULT_STDIN_IDLE_TIMEOUT_MS = 250;
const MAX_STDIN_IDLE_TIMEOUT_MS = 30_000;

export function resolveStdinIdleTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
	const raw = environment[STDIN_IDLE_TIMEOUT_MS_ENV];
	if (raw === undefined || raw === "") {
		return DEFAULT_STDIN_IDLE_TIMEOUT_MS;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		return DEFAULT_STDIN_IDLE_TIMEOUT_MS;
	}
	return Math.min(Math.floor(value), MAX_STDIN_IDLE_TIMEOUT_MS);
}

/** Readable stdin shape: real stdin also reports whether it is a TTY. */
export type StdinLike = Readable & { isTTY?: boolean };

export interface ReadPipedStdinOptions {
	/** Stream to read; defaults to process.stdin. */
	input?: StdinLike;
	/** No-input window before the read gives up. Defaults to resolveStdinIdleTimeoutMs(). */
	idleTimeoutMs?: number;
}

/**
 * Read all content from piped stdin without ever hanging a non-interactive boot.
 *
 * Returns undefined for TTY stdin (interactive terminal: nothing is piped), for
 * streams that already ended, and when a non-TTY stdin stays silent past the
 * idle window. Daemon workers, agent harnesses, and CI runners spawn this CLI
 * with a stdin pipe they never write to and never close; `end` then never
 * fires, so an unbounded read would hang boot forever. A short idle window is
 * enough for real pipes: a producer that has already written delivers its
 * buffered bytes the moment the listeners attach, and a live producer resets
 * the window on every chunk. On give-up the stream is paused with all listeners
 * detached, so bytes that arrive later stay buffered for a future reader and
 * stdin cannot keep the process alive.
 */
export async function readPipedStdin(options: ReadPipedStdinOptions = {}): Promise<string | undefined> {
	const input = options.input ?? (process.stdin as StdinLike);
	const idleTimeoutMs = options.idleTimeoutMs ?? resolveStdinIdleTimeoutMs();
	if (input.isTTY || input.destroyed || input.readableEnded || idleTimeoutMs === 0) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		let settled = false;
		let idleTimer: NodeJS.Timeout | undefined;

		const finish = (value: string | undefined, pauseInput: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			input.off("data", onData);
			input.off("end", onEnd);
			input.off("error", onError);
			input.off("close", onClose);
			if (pauseInput) {
				input.pause();
			}
			resolve(value);
		};
		const scheduleIdleTimeout = (): void => {
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
			}
			idleTimer = setTimeout(() => {
				console.error(
					`stdin did not close within ${idleTimeoutMs}ms; continuing without waiting for more piped input`,
				);
				finish(data.trim() || undefined, true);
			}, idleTimeoutMs);
			idleTimer.unref?.();
		};
		const onData = (chunk: string): void => {
			// A live producer keeps the read open; only silence gives up.
			data += chunk;
			scheduleIdleTimeout();
		};
		const onEnd = (): void => {
			finish(data.trim() || undefined, false);
		};
		const onError = (error: Error): void => {
			console.error(`stdin read failed (${error.message}); continuing without piped input`);
			finish(undefined, true);
		};
		const onClose = (): void => {
			// Covers a stream destroyed before `end` could fire.
			finish(data.trim() || undefined, false);
		};

		input.setEncoding("utf8");
		input.on("data", onData);
		input.on("end", onEnd);
		input.on("error", onError);
		input.on("close", onClose);
		scheduleIdleTimeout();
		input.resume();
	});
}
