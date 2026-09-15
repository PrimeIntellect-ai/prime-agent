import { expect } from "vitest";

/**
 * Teardown for suites that leave a real daemon supervisor running.
 *
 * Vitest gives a hook a fixed budget (`hookTimeout`), so every deadline a hook waits on has to
 * stay strictly below that budget. A wait that is allowed to run as long as the hook itself can
 * only ever be killed mid-cleanup, which reports "Hook timed out" instead of the real failure and
 * leaks the supervisor into the next test. These budgets are therefore small multiples under the
 * shared `hookTimeout` in vitest.config.ts.
 */
export const SUPERVISOR_GRACEFUL_EXIT_TIMEOUT = 3000;
export const SUPERVISOR_TEARDOWN_TIMEOUT = 10000;

export function hasExited(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

/** SIGKILL cannot be blocked, so the supervisor exit is reached without waiting on a graceful shutdown. */
export async function terminateSupervisor(pid: number): Promise<void> {
	const escalateAt = Date.now() + SUPERVISOR_GRACEFUL_EXIT_TIMEOUT;
	await expect
		.poll(
			() => {
				if (hasExited(pid)) return true;
				if (Date.now() >= escalateAt) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* Exited between the check and the signal. */
					}
				}
				return false;
			},
			{ timeout: SUPERVISOR_TEARDOWN_TIMEOUT },
		)
		.toBe(true);
}
