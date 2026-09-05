/**
 * Single owner of the "disposable ghost" decision: a session file that holds no
 * user intent whatsoever and is safe to delete automatically. Callers assemble
 * a candidate from state that existing owners already hold (the saved-session
 * scan, the roster, durable schedule/ledger artifacts); this predicate performs
 * no IO of its own. Every unknown fails toward "keep".
 */

/** A session younger than this is never a ghost: its owner may still be coming back. */
export const DISPOSABLE_GHOST_GRACE_MS = 10 * 60_000;

export interface DisposableGhostCandidate {
	/**
	 * Scan-provided result of the shared user-content rule
	 * (sessionEntryTypesHaveUserContent). undefined means the snapshot predates
	 * the rule and the session must be kept.
	 */
	hasUserContent: boolean | undefined;
	createdAtMs: number;
	modifiedAtMs: number;
	/** Open in a daemon worker or listed as active in the roster. */
	resident: boolean;
	/** Any client attached. */
	attached: boolean;
	/** A live foreign-process session lease exists for the file. */
	leased: boolean;
	/** Queued or stashed prompt input recorded for the session (roster/recovery truth). */
	hasQueuedInput: boolean;
	/** Armed heartbeat or registered cron descriptor (durable schedule artifact). */
	hasScheduledJob: boolean;
	/** The RLM spawn ledger records live children under this session. */
	hasSpawnLedgerChildren: boolean;
}

export function isDisposableGhost(candidate: DisposableGhostCandidate, nowMs = Date.now()): boolean {
	if (candidate.hasUserContent !== false) return false;
	if (candidate.resident || candidate.attached || candidate.leased) return false;
	if (candidate.hasQueuedInput) return false;
	if (candidate.hasScheduledJob) return false;
	if (candidate.hasSpawnLedgerChildren) return false;
	const lastTouchedMs = Math.max(candidate.createdAtMs, candidate.modifiedAtMs);
	if (!Number.isFinite(lastTouchedMs)) return false;
	return nowMs - lastTouchedMs >= DISPOSABLE_GHOST_GRACE_MS;
}
