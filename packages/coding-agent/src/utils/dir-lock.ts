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
				// Litter collection only.
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
	return acquireAttempt(lockPath, ownerAlive, true);
}

async function acquireAttempt(
	lockPath: string,
	ownerAlive: (ownerPid: number | undefined) => Promise<boolean> | boolean,
	retryOnSweptCandidate: boolean,
): Promise<DirLockAttempt> {
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
			let candidateSwept = false;
			let recheckedNlink: number | undefined;
			try {
				recheckedNlink = statSync(tempPath).nlink;
			} catch (statError) {
				// Only a definite ENOENT means a rival's sweep claimed the candidate;
				// a transient probe failure must not invent that answer.
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
				candidateSwept = true;
			}
			if (recheckedNlink === 2) {
				return "acquired";
			}
			if (candidateSwept && retryOnSweptCandidate) {
				return acquireAttempt(lockPath, ownerAlive, false);
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}
		const lockShape = pathShape(lockPath);
		if (lockShape === "unknown") {
			// An unjudgeable lock may be live: fail safe.
			return "held";
		}
		const judged = readOwnerRaw(lockPath, lockShape === "directory");
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
		// Identity check on the MOVED entry's actual shape: the owner and the
		// file-vs-directory type may both have changed since the staleness judgment.
		const asideShape = pathShape(asidePath);
		if (asideShape !== "unknown" && readOwnerRaw(asidePath, asideShape === "directory") === judged) {
			rmSync(asidePath, { recursive: true, force: true });
			return "reclaimed";
		}
		// Changed owners since the judgment, or no longer judgeable: restore, never
		// delete. A file links back so a third acquirer is never clobbered; anything
		// else renames back (shape-agnostic, and a directory rename cannot clobber).
		try {
			if (asideShape === "file") {
				linkSync(asidePath, lockPath);
				rmSync(asidePath, { force: true });
			} else {
				renameSync(asidePath, lockPath);
			}
			return "held";
		} catch {
			if (asideShape === "unknown") {
				// Never delete what cannot be judged; the displaced copy stays aside.
				return "held";
			}
			// A third acquirer already owns the path; discard the displaced copy.
			rmSync(asidePath, { recursive: true, force: true });
			return "reclaimed";
		}
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Cleanup only: a leaked candidate must never mask a settled acquisition.
		}
	}
}

type PathShape = "file" | "directory" | "absent" | "unknown";

// A probe failure must never collapse into a definite shape: "unknown" is not destructible.
function pathShape(path: string): PathShape {
	try {
		return statSync(path).isDirectory() ? "directory" : "file";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
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
