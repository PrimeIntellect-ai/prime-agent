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
		// One immutable identity capture keys every later decision: the judged lock
		// IS this dev+ino, whatever else happens to the path meanwhile.
		let captured: { dev: bigint; ino: bigint; isDir: boolean };
		try {
			const measured = statSync(lockPath, { bigint: true });
			captured = { dev: measured.dev, ino: measured.ino, isDir: measured.isDirectory() };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "reclaimed";
			}
			// An unjudgeable lock may be live: fail safe.
			return "held";
		}
		if (captured.ino === 0n) {
			// Some Windows filesystems report no stable file index: identity unavailable.
			return "held";
		}
		const judged = readOwnerRaw(lockPath, captured.isDir);
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
			if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") {
				return "reclaimed";
			}
			// Ambiguous failure (NFS can lose the reply of a completed rename): re-probe.
			if (statIdentity(lockPath) !== undefined) {
				throw reclaimError;
			}
			const moved = statIdentity(asidePath);
			if (!(moved !== undefined && moved.dev === captured.dev && moved.ino === captured.ino)) {
				return "reclaimed";
			}
			// The rename completed; continue as its success path.
		}
		const aside = statIdentity(asidePath);
		if (aside !== undefined && aside.dev === captured.dev && aside.ino === captured.ino) {
			rmSync(asidePath, { recursive: true, force: true });
			return "reclaimed";
		}
		// The moved entry is not the judged lock: restore it, never delete. A file
		// links back so a rival re-acquirer is never clobbered; a directory renames
		// back (a directory rename cannot clobber). Any failure leaves it aside.
		try {
			if (captured.isDir) {
				renameSync(asidePath, lockPath);
			} else {
				linkSync(asidePath, lockPath);
				rmSync(asidePath, { force: true });
			}
		} catch {
			// The displaced entry stays aside rather than risk deleting a live lock.
		}
		return "held";
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Cleanup only: a leaked candidate must never mask a settled acquisition.
		}
	}
}

function statIdentity(path: string): { dev: bigint; ino: bigint } | undefined {
	try {
		const measured = statSync(path, { bigint: true });
		return { dev: measured.dev, ino: measured.ino };
	} catch {
		return undefined;
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
