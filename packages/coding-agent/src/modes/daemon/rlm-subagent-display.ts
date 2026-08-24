import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
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

export function writeRlmSubagentDisplayEntry(entry: RlmSubagentDisplayEntry): void {
	const path = rlmSubagentDisplayPath(entry.sessionDir);
	mkdirSync(entry.sessionDir, { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	const handle = openSync(tempPath, "wx", 0o600);
	try {
		try {
			writeSync(handle, `${JSON.stringify(entry)}\n`);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		renameSync(tempPath, path);
	} catch (error) {
		// A failed write, fsync, or rename must not leak the temp file.
		rmSync(tempPath, { force: true });
		throw error;
	}
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
