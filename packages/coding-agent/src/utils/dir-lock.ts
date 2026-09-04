import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DirLockAttempt = "acquired" | "held" | "reclaimed";

/**
 * link(2)-published lock file: the owner pid is written to a private temp file
 * and published with a hard link, so the lock is born with its content and
 * EEXIST is the only collision signal. A stale lock is renamed aside before
 * deletion and linked back if it changed owners after the staleness judgment.
 * A directory at the lock path is a legacy lock from the previous protocol.
 */
export async function tryAcquireDirLock(
	lockPath: string,
	ownerAlive: (ownerPid: number | undefined) => Promise<boolean> | boolean,
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
			if (statSync(tempPath).nlink === 2) {
				return "acquired";
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}
		const legacyDir = isDirectory(lockPath);
		const judged = readOwnerRaw(lockPath, legacyDir);
		if (await ownerAlive(strictPid(judged))) {
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
		// Identity check: the lock may have changed owners between the staleness
		// judgment and the rename; a moved LIVE lock must be put back, not deleted.
		if (readOwnerRaw(asidePath, legacyDir) !== judged) {
			try {
				if (legacyDir) {
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
		rmSync(tempPath, { force: true });
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readOwnerRaw(path: string, legacyDir: boolean): string | undefined {
	try {
		return readFileSync(legacyDir ? join(path, "pid") : path, "utf8");
	} catch {
		// The owner judgment for a missing or unreadable pid belongs to the caller.
		return undefined;
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
