export type IdleEvictionMinutes = number | "off";

export interface SessionEvictionSnapshot {
	isSessionActive: boolean;
	attachedClients: number;
	hasRegisteredCronJob: boolean;
	lastActivityAt: number;
}

export interface SessionPassivationSnapshot extends SessionEvictionSnapshot {
	hasParent: boolean;
	hasNonPassiveDescendants: boolean;
	isHydrating: boolean;
}

export interface WorkerEvictionSnapshot {
	lifecycle: "starting" | "ready" | "recovering" | "stopping" | "failed";
	isConnected: boolean;
	isStopping: boolean;
	hasOwnerClient: boolean;
	isPreparingUpdateRestart: boolean;
	hasWakeBlindSchedule: boolean;
	sessions: readonly SessionEvictionSnapshot[];
}

function isIdleEvictionThresholdMet(
	session: SessionEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now: number,
): boolean {
	if (idleEvictionMinutes === "off" || !Number.isFinite(idleEvictionMinutes) || idleEvictionMinutes <= 0) {
		return false;
	}
	return (
		!session.isSessionActive &&
		session.attachedClients === 0 &&
		!session.hasRegisteredCronJob &&
		Number.isFinite(session.lastActivityAt) &&
		now - session.lastActivityAt >= idleEvictionMinutes * 60_000
	);
}

/** Pure per-node residency policy. Roots remain owned by whole-worker eviction. */
export function canPassivateSession(
	session: SessionPassivationSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	return (
		session.hasParent &&
		!session.hasNonPassiveDescendants &&
		!session.isHydrating &&
		isIdleEvictionThresholdMet(session, idleEvictionMinutes, now)
	);
}

/** Pure whole-tree residency policy. Callers must supply supervisor-owned attachment state. */
export function canEvictWorker(
	worker: WorkerEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	if (
		worker.lifecycle !== "ready" ||
		!worker.isConnected ||
		worker.isStopping ||
		worker.hasOwnerClient ||
		worker.isPreparingUpdateRestart ||
		worker.hasWakeBlindSchedule ||
		worker.sessions.length === 0
	) {
		return false;
	}
	return worker.sessions.every((session) => isIdleEvictionThresholdMet(session, idleEvictionMinutes, now));
}
