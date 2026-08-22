import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";

export type ToolScope = "global" | "project";

export type ToolStatus = "active" | "flagged" | "disabled" | "archived";

export interface ToolFailureEvent {
	at: string;
	note: string;
}

export interface ToolUsage {
	used: number;
	explicit_ok: number;
	explicit_fail: number;
	last_used: string | null;
	last_status: "ok" | "fail" | null;
	recent_failures: ToolFailureEvent[];
}

export interface ToolIndexEntry {
	scope: ToolScope;
	path: string;
	version: number;
	status: ToolStatus;
	usage: ToolUsage;
	description_hash: string;
	embedding: number[];
}

export interface ToolIndex {
	schema: 1;
	updated: string;
	skills: Record<string, ToolIndexEntry>;
	embedding_model: string | null;
	embedding_dim: number | null;
}

export function emptyToolIndex(): ToolIndex {
	return {
		schema: 1,
		updated: new Date().toISOString(),
		skills: {},
		embedding_model: null,
		embedding_dim: null,
	};
}

export function getGlobalToolsDir(): string {
	return join(getAgentDir(), "tools");
}

export function getProjectToolsDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "tools");
}

export function getToolIndexPath(toolsDir: string): string {
	return join(toolsDir, "index.json");
}

export function loadToolIndex(toolsDir: string): ToolIndex {
	const indexPath = getToolIndexPath(toolsDir);
	if (!existsSync(indexPath)) {
		return emptyToolIndex();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(indexPath, "utf8"));
	} catch {
		// A corrupt index must degrade to empty rather than break startup; the next
		// rebuild restores content fields from disk.
		return emptyToolIndex();
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return emptyToolIndex();
	}
	return raw as ToolIndex;
}

export function saveToolIndex(toolsDir: string, index: ToolIndex): string {
	const indexPath = getToolIndexPath(toolsDir);
	const tempPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(toolsDir, { recursive: true });
	try {
		const mode = existsSync(indexPath) ? statSync(indexPath).mode & 0o777 : 0o600;
		writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tempPath, indexPath);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return indexPath;
}
