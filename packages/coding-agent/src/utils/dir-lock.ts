import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	linkSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type DirLockAttempt = "acquired" | "held" | "reclaimed";

/**
 * link(2)-published lock file: born with its owner content, EEXIST the only
 * collision signal; stale locks are renamed aside, verified, then deleted or
 * restored. A directory at the lock path is a legacy lock from the old protocol.
 */
const CANDIDATE_SWEEP_AGE_MS = 60 * 60 * 1000;

// The candidate prefix can never match the lock; the age gate spares mid-publish rivals.
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
			// NFS can report failure for a link that landed: nlink 2 means it published.
			let candidateSwept = false;
			let recheckedNlink: number | undefined;
			try {
				recheckedNlink = statSync(tempPath).nlink;
			} catch (statError) {
				// Only a definite ENOENT means the candidate was swept.
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
		// One immutable dev+ino capture keys every later decision about the judged lock.
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
		// An open descriptor pins the inode number against Linux's immediate reuse.
		let pinned: number | undefined;
		try {
			try {
				pinned = openSync(lockPath, "r");
				const pinnedIdentity = fstatSync(pinned, { bigint: true });
				if (pinnedIdentity.dev !== captured.dev || pinnedIdentity.ino !== captured.ino) {
					// The lock changed hands between the capture and the pin: treat as live.
					return "held";
				}
			} catch {
				// Unpinnable (Windows directories): stat identity without the reuse guarantee.
			}
			return await judgeAndReclaim(lockPath, ownerAlive, captured, token);
		} finally {
			if (pinned !== undefined) closeSync(pinned);
		}
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Cleanup only: a leaked candidate must never mask a settled acquisition.
		}
	}
}

async function judgeAndReclaim(
	lockPath: string,
	ownerAlive: (ownerPid: number | undefined) => Promise<boolean> | boolean,
	captured: { dev: bigint; ino: bigint; isDir: boolean },
	token: string,
): Promise<DirLockAttempt> {
	{
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
			// A lost-reply rename: if the lock path is gone, something moved - fall to verify.
			if (statIdentity(lockPath) !== undefined) {
				throw reclaimError;
			}
		}
		const aside = statIdentity(asidePath);
		if (aside !== undefined && aside.dev === captured.dev && aside.ino === captured.ino) {
			rmSync(asidePath, { recursive: true, force: true });
			return "reclaimed";
		}
		// Not the judged lock: restore, never delete. Known dirs rename back; everything
		// else links back (link can never replace a rival). Any failure leaves it aside.
		try {
			if (aside?.isDir === true) {
				renameSync(asidePath, lockPath);
			} else {
				linkSync(asidePath, lockPath);
				rmSync(asidePath, { force: true });
			}
		} catch {
			// Preserved aside.
		}
		return "held";
	}
}

function statIdentity(path: string): { dev: bigint; ino: bigint; isDir: boolean } | undefined {
	try {
		const measured = statSync(path, { bigint: true });
		return { dev: measured.dev, ino: measured.ino, isDir: measured.isDirectory() };
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

// kill(0)/kill(-n) probe our own process group: only an exact positive integer owns.
function strictPid(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || !/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
