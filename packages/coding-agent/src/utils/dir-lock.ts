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
		renameSync(candidateDirectory, lockDir);
		return "acquired";
	} catch (error) {
		rmSync(candidateDirectory, { recursive: true, force: true });
		const code = (error as NodeJS.ErrnoException).code;
		// win32 reports rename-onto-existing-directory as EPERM/EACCES, not EEXIST.
		if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
			throw error;
		}
		let ownerPid: number | undefined;
		try {
			const parsed = Number.parseInt(readFileSync(join(lockDir, "pid"), "utf8").trim(), 10);
			ownerPid = Number.isFinite(parsed) ? parsed : undefined;
		} catch {
			// The owner judgment for a missing or unreadable pid belongs to the caller.
		}
		if (await ownerAlive(ownerPid)) {
			return "held";
		}
		const staleDirectory = `${lockDir}.stale-${process.pid}-${token}`;
		try {
			renameSync(lockDir, staleDirectory);
			rmSync(staleDirectory, { recursive: true, force: true });
		} catch (reclaimError) {
			// ENOENT: a racing reclaimer moved it first.
			if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw reclaimError;
			}
		}
		return "reclaimed";
	}
}
