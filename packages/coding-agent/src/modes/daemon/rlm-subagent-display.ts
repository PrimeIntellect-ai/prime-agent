import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-child RLM subagent hydration/display metadata.
 *
 * One JSON file per child in the child's own session dir
 * (`session-artifacts/<parentId>/<childId>/rlm-subagent.json`). Topology
 * (parent/child edges, depths, names) lives exclusively in the daemon-owned
 * spawn ledger and is never read from this file; it carries only what
 * hydration and display need. It is written at the same moments the legacy
 * per-parent `rlm-subagents.jsonl` registry used to be written: spawn
 * admission, completion, and deletion. Writes are atomic (temp file +
 * rename); reads are tolerant.
 */
const RLM_SUBAGENT_DISPLAY_FILE = "rlm-subagent.json";

/** Bounded rename retries for transient Windows sharing violations. */
const RLM_DISPLAY_RENAME_MAX_RETRIES = 8;
const RLM_DISPLAY_RENAME_BASE_DELAY_MS = 10;

export interface RlmSubagentDisplayEntry {
	type: "rlm_subagent";
	childId: string;
	sessionName: string;
	sessionDir: string;
	sessionFile: string;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	status: "running" | "completed" | "deleted";
	createdAt: number;
	updatedAt: string;
}

export function rlmSubagentDisplayPath(sessionDir: string): string {
	return join(sessionDir, RLM_SUBAGENT_DISPLAY_FILE);
}

function isRlmSubagentDisplayEntry(value: unknown): value is RlmSubagentDisplayEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<RlmSubagentDisplayEntry>;
	return (
		entry.type === "rlm_subagent" &&
		typeof entry.childId === "string" &&
		typeof entry.sessionName === "string" &&
		typeof entry.sessionDir === "string" &&
		typeof entry.sessionFile === "string" &&
		(entry.status === "running" || entry.status === "completed" || entry.status === "deleted") &&
		(entry.rlmMaxDepth === undefined || (Number.isSafeInteger(entry.rlmMaxDepth) && entry.rlmMaxDepth >= 0)) &&
		typeof entry.createdAt === "number"
	);
}

/** Synchronous sleep for bounded backoff; sync callers cannot await. */
function sleepSync(ms: number): void {
	const shared = new SharedArrayBuffer(4);
	const view = new Int32Array(shared);
	Atomics.wait(view, 0, 0, ms);
}

/** Return true when the error is a transient Windows sharing-violation suitable for rename retry. */
function isTransientRenameError(error: unknown): boolean {
	if (process.platform !== "win32") return false;
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code)
			: undefined;
	return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/**
 * Replace the display file by rename. On Windows a briefly-open destination
 * (Defender/indexer/another reader) can block the rename with
 * EPERM/EACCES/EBUSY; retry with bounded backoff. If the rename is still
 * blocked after the retry budget, fail closed: the existing destination is
 * left intact and the temp file is cleaned up by the caller. There is
 * deliberately no copy-in-place fallback. A non-atomic replace could expose
 * torn JSON to tolerant-but-live readers.
 */
function replaceDisplayEntryFile(tempPath: string, path: string): void {
	let lastError: Error | undefined;
	if (process.platform === "win32") {
		for (let attempt = 1; attempt <= RLM_DISPLAY_RENAME_MAX_RETRIES; attempt++) {
			try {
				renameSync(tempPath, path);
				return;
			} catch (error) {
				if (!isTransientRenameError(error)) {
					throw error;
				}
				lastError = error as Error;
				if (attempt < RLM_DISPLAY_RENAME_MAX_RETRIES) {
					sleepSync(RLM_DISPLAY_RENAME_BASE_DELAY_MS * attempt);
				}
			}
		}
		throw lastError ?? new Error("RLM subagent display rename failed after bounded retries");
	}

	// POSIX: rename replacement of existing file is naturally atomic. A
	// transient error on non-Windows is treated as a hard failure.
	renameSync(tempPath, path);
}

/** Sync read of the display entry, tolerant of missing or malformed files. */
function readRlmSubagentDisplayEntrySync(sessionDir: string): RlmSubagentDisplayEntry | undefined {
	let contents: string;
	try {
		contents = readFileSync(rlmSubagentDisplayPath(sessionDir), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(contents) as unknown;
		return isRlmSubagentDisplayEntry(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Persist one display entry. Returns `false` when the write was skipped
 * because a "deleted" tombstone already exists. All production display
 * writers run synchronously on the daemon supervisor event loop, so the
 * check and rename cannot interleave.
 *
 * On transient Windows sharing violations the rename retries with bounded
 * backoff, then fails closed with the destination intact.
 */
export function writeRlmSubagentDisplayEntry(entry: RlmSubagentDisplayEntry): boolean {
	const path = rlmSubagentDisplayPath(entry.sessionDir);
	// A late completion must not replace a deletion tombstone.
	if (entry.status !== "deleted") {
		const existing = readRlmSubagentDisplayEntrySync(entry.sessionDir);
		if (existing?.status === "deleted") {
			return false;
		}
	}
	mkdirSync(entry.sessionDir, { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const handle = openSync(tempPath, "wx", 0o600);
	try {
		try {
			writeSync(handle, `${JSON.stringify(entry)}\n`);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		replaceDisplayEntryFile(tempPath, path);
	} catch (error) {
		// A failed write, fsync, or rename must not leak the temp file.
		rmSync(tempPath, { force: true });
		throw error;
	}
	return true;
}

export async function readRlmSubagentDisplayEntry(sessionDir: string): Promise<RlmSubagentDisplayEntry | undefined> {
	let contents: string;
	try {
		contents = await readFile(rlmSubagentDisplayPath(sessionDir), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(contents) as unknown;
		return isRlmSubagentDisplayEntry(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
