import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DirLockAttempt = "acquired" | "held" | "reclaimed";

/**
 * One rename-based acquisition attempt; a stale lock is renamed aside before deletion,
 * so no step can destroy a lock that changed owners after the staleness check.
 */
export async function tryAcquireDirLock(
	lockDir: string,
	ownerAlive: (ownerPid: number | undefined) => Promise<boolean> | boolean,
): Promise<DirLockAttempt> {
	const token = randomUUID();
	const candidateDirectory = `${lockDir}.candidate-${process.pid}-${token}`;
	mkdirSync(candidateDirectory, { mode: 0o700 });
	writeFileSync(join(candidateDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
	try {
		// The lock is published fully formed; no in-protocol state creates an empty lockDir.
		renameSync(candidateDirectory, lockDir);
		return "acquired";
	} catch (error) {
		rmSync(candidateDirectory, { recursive: true, force: true });
		const code = (error as NodeJS.ErrnoException).code;
		// win32 reports rename-onto-existing-directory as EPERM/EACCES, not EEXIST.
		if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
			throw error;
		}
		let judgedPid: string | undefined;
		try {
			judgedPid = readFileSync(join(lockDir, "pid"), "utf8");
		} catch {
			// The owner judgment for a missing or unreadable pid belongs to the caller.
		}
		// Strict parse: kill(0)/kill(-n) probe the caller's own process group, and
		// parseInt would accept "123garbage" — only an exact positive integer owns a lock.
		const trimmed = judgedPid?.trim();
		const parsed = trimmed !== undefined && /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
		if (await ownerAlive(Number.isInteger(parsed) && parsed > 0 ? parsed : undefined)) {
			return "held";
		}
		const staleDirectory = `${lockDir}.stale-${process.pid}-${token}`;
		try {
			renameSync(lockDir, staleDirectory);
		} catch (reclaimError) {
			// ENOENT: a racing reclaimer moved it first.
			if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw reclaimError;
			}
			return "reclaimed";
		}
		// Identity check: the lock may have changed owners between the staleness
		// judgment and the rename; a moved LIVE lock must be put back, not deleted.
		let movedPid: string | undefined;
		try {
			movedPid = readFileSync(join(staleDirectory, "pid"), "utf8");
		} catch {
			// Unreadable after the move: treat as the judged-stale lock.
		}
		if (movedPid !== judgedPid) {
			try {
				renameSync(staleDirectory, lockDir);
				return "held";
			} catch {
				// A third acquirer already owns the path; discard the displaced copy.
			}
		}
		rmSync(staleDirectory, { recursive: true, force: true });
		return "reclaimed";
	}
}
