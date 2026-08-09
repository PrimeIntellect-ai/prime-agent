import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	if (!sessionId) return;
	const artifactDir = join(dirname(dirname(sessionPath)), "session-artifacts", sessionId);
	await rm(artifactDir, { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}

// Entry types that are always present when a session is created. A file that
// contains only these plus session_state holds nothing worth keeping.
const BOOTSTRAP_ENTRY_TYPES = new Set(["session", "model_change", "thinking_level_change", "service_tier_change"]);

/**
 * True when a session file is an empty draft: it has no messages and its only
 * entries are the bootstrap prefix (session header, model/thinking/tier changes)
 * optionally followed by a daemon-written session_state. Such files are ghost
 * sessions — created on disk for crash recovery but never receiving a message.
 */
function isEmptyDraftSessionFile(sessionPath: string): boolean {
	let content: string;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch {
		return false;
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string };
		try {
			entry = JSON.parse(line);
		} catch {
			return false;
		}
		const type = entry.type;
		if (!type) return false;
		if (BOOTSTRAP_ENTRY_TYPES.has(type)) continue;
		if (type === "session_state") continue;
		// Any other entry type means the session has real content.
		return false;
	}
	return true;
}

/**
 * Scan a session directory for ghost session files — empty drafts left behind
 * when a daemon shuts down or crashes before the user sends their first message.
 * Returns the count of files removed.
 */
export async function sweepGhostSessionFiles(sessionDir: string): Promise<number> {
	if (!existsSync(sessionDir)) return 0;
	let swept = 0;
	for (const entry of readdirSync(sessionDir)) {
		if (!entry.endsWith(".jsonl")) continue;
		const filePath = join(sessionDir, entry);
		if (isEmptyDraftSessionFile(filePath)) {
			await deleteSessionFile(filePath).catch(() => undefined);
			swept++;
		}
	}
	return swept;
}
