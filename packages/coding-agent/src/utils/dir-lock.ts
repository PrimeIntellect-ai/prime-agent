import { randomUUID } from "node:crypto";
import { linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type DirLockAttempt = "acquired" | "held" | "reclaimed";

/**
 * link(2)-published lock file: the owner pid is written to a private temp file
 * and published with a hard link, so the lock is born with its content and
 * EEXIST is the only collision signal. A stale lock is renamed aside before
 * deletion and linked back if it changed owners after the staleness judgment.
 * A directory at the lock path is a legacy lock from the previous protocol.
 */
const CANDIDATE_SWEEP_AGE_MS = 60 * 60 * 1000;

// Litter collection for candidates leaked by crashed or cleanup-blocked acquirers;
// the prefix can never match the lock itself and the age gate spares mid-publish rivals.
function sweepAbandonedCandidates(lockPath: string): void {
	try {
		const directory = dirname(lockPath);
		const prefix = `${basename(lockPath)}.candidate-`;
		const cutoff = Date.now() - CANDIDATE_SWEEP_AGE_MS;
		for (const name of readdirSync(directory)) {
			if (!name.startsWith(prefix)) continue;
			try {
				const abandoned = join(directory, name);
				if (statSync(abandoned).mtimeMs < cutoff) {
					rmSync(abandoned, { force: true });
				}
			} catch {
				// Litter collection only: the next acquire retries.
			}
		}
	} catch {
		// Litter collection only: the next acquire retries.
	}
}

export async function tryAcquireDirLock(
	lockPath: string,
	ownerAlive: (ownerPid: number | undefined) => Promise<boolean> | boolean,
): Promise<DirLockAttempt> {
	sweepAbandonedCandidates(lockPath);
	const token = `${process.pid}-${randomUUID()}`;
	const tempPath = `${lockPath}.candidate-${token}`;
	writeFileSync(tempPath, `${process.pid}\n`, { mode: 0o600 });
	try {
		try {
			linkSync(tempPath, lockPath);
			return "acquired";
		} catch (error) {
			// NFS can report failure for a link that landed: a second name for the
			// temp inode means the publish succeeded.
			if (statSync(tempPath).nlink === 2) {
				return "acquired";
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}
		const judged = readOwnerRaw(lockPath, isDirectory(lockPath));
		if (judged === "unreadable") {
			// A transient read failure may hide a LIVE lock: never judge it stale.
			return "held";
		}
		if (await ownerAlive(strictPid(judged === "absent" ? undefined : judged))) {
			return "held";
		}
		const asidePath = `${lockPath}.stale-${token}`;
		try {
			renameSync(lockPath, asidePath);
		} catch (reclaimError) {
			// ENOENT: a racing reclaimer moved it first.
			if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw reclaimError;
			}
			return "reclaimed";
		}
		// Identity check on the MOVED entry's actual shape: both the owner and the
		// file-vs-directory type may have changed since the staleness judgment.
		const asideIsDir = isDirectory(asidePath);
		if (readOwnerRaw(asidePath, asideIsDir) !== judged) {
			try {
				if (asideIsDir) {
					renameSync(asidePath, lockPath);
					return "held";
				}
				linkSync(asidePath, lockPath);
				rmSync(asidePath, { force: true });
				return "held";
			} catch {
				// A third acquirer already owns the path; discard the displaced copy.
			}
		}
		rmSync(asidePath, { recursive: true, force: true });
		return "reclaimed";
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Cleanup only: a leaked candidate must never mask a settled acquisition.
		}
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// "absent" is safely stale territory; "unreadable" may be a LIVE lock (transient EPERM/EBUSY).
function readOwnerRaw(path: string, legacyDir: boolean): string | "absent" | "unreadable" {
	try {
		return readFileSync(legacyDir ? join(path, "pid") : path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
}

// kill(0)/kill(-n) probe the caller's own process group, and parseInt would
// accept "123garbage" - only an exact positive integer names an owner.
function strictPid(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || !/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
