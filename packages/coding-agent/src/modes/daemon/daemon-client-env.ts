import { DAEMON_CLIENT_ENV_KEYS } from "./daemon-protocol.js";

/** Re-filter client-sent env to the allowlist; the socket peer is untrusted. */
export function filterClientEnv(env?: Record<string, string>): Record<string, string> | undefined {
	if (!env) {
		return undefined;
	}
	const filtered: Record<string, string> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		if (Object.hasOwn(env, key) && typeof env[key] === "string") {
			filtered[key] = env[key];
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

// The daemon's own allowlisted env, captured at startup before any env window
// can mutate process.env.
const baseClientEnv: Record<string, string | undefined> = {};
for (const key of DAEMON_CLIENT_ENV_KEYS) {
	baseClientEnv[key] = key === "PI_SLACK_CONSENT_MODE" ? undefined : process.env[key];
}

/**
 * Exec env for a session's subprocesses: pins every allowlisted key to the
 * session's value (unset when the client didn't send it), or to the daemon's
 * startup value for env-less sessions. Pinning makes subprocess env
 * independent of any env window another session has open at spawn time.
 */
export function execEnvForSession(clientEnv?: Record<string, string>): Record<string, string | undefined> {
	const source = clientEnv ?? baseClientEnv;
	const env: Record<string, string | undefined> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		env[key] = source[key];
	}
	return env;
}

// Shared/exclusive lock: env windows are exclusive (they mutate process.env),
// env-less loads are shared — they run concurrently with each other but never
// inside an env window, so they can't capture another session's identity.
let lastExclusive: Promise<unknown> = Promise.resolve();
const activeShared = new Set<Promise<unknown>>();

/**
 * Run fn with the client's env applied to process.env, restoring afterwards.
 * Extensions capture vars like HERDR_PANE_ID synchronously at module load, so
 * they must be in process.env while the session loads its extensions; after
 * this window the session's exec env covers subprocess reads.
 */
export async function withClientEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
	// Consent is session-owned, never inherited from the daemon. Use an exclusive
	// window when ambient consent must be cleared; ordinary env-less loads stay shared.
	if (!env && process.env.PI_SLACK_CONSENT_MODE !== undefined) {
		env = {};
		for (const key of DAEMON_CLIENT_ENV_KEYS) {
			const value = baseClientEnv[key];
			if (value !== undefined) env[key] = value;
		}
	}
	if (!env) {
		const gate = lastExclusive;
		const run = (async () => {
			await gate.catch(() => undefined);
			return fn();
		})();
		const tracked = run.catch(() => undefined);
		activeShared.add(tracked);
		void tracked.then(() => activeShared.delete(tracked));
		return run;
	}
	const prior = lastExclusive;
	// Snapshot synchronously: shareds arriving later gate on this window via
	// lastExclusive, so waiting for them here would deadlock.
	const sharedAtRequest = [...activeShared];
	const run = (async () => {
		await prior.catch(() => undefined);
		await Promise.all(sharedAtRequest);
		const previous = new Map<string, string | undefined>();
		// Pin the full allowlist (unsetting keys the client didn't send) so a
		// partially-forwarded env can't mix with the daemon's ambient values —
		// mirroring execEnvForSession.
		for (const key of DAEMON_CLIENT_ENV_KEYS) {
			previous.set(key, process.env[key]);
			const value = env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			return await fn();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	})();
	lastExclusive = run.catch(() => undefined);
	return run;
}
