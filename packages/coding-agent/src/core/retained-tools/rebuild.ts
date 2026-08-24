import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { loadSkillsFromDir } from "../skills.js";
import {
	emptyToolIndex,
	loadToolIndex,
	saveToolIndex,
	type ToolIndex,
	type ToolIndexEntry,
	type ToolScope,
	type ToolUsage,
} from "./index.js";
import { parseRetainedMeta, type RetainedMeta } from "./meta.js";

export type { RetainedMeta };

const log = getLogger("coding-agent.retained-tools");

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/** Hash used to detect skill-description drift at load (ADR-1, risk 5). */
export function hashDescription(description: string): string {
	return `sha256:${createHash("sha256").update(description, "utf8").digest("hex")}`;
}

export function zeroToolUsage(): ToolUsage {
	return {
		used: 0,
		explicit_ok: 0,
		explicit_fail: 0,
		last_used: null,
		last_status: null,
		recent_failures: [],
	};
}

/**
 * Read `metadata.prime-agent.retained.{version,status}` from a skill file's frontmatter.
 * Skills without the frontmatter (the common case in phase A) get defaults.
 */
export function readRetainedMeta(skillFilePath: string): RetainedMeta {
	const defaults: RetainedMeta = { version: 1, status: "active" };
	let frontmatter: unknown;
	try {
		frontmatter = parseFrontmatter(readFileSync(skillFilePath, "utf8")).frontmatter;
	} catch {
		return defaults;
	}
	return parseRetainedMeta(frontmatter as Record<string, unknown>) ?? defaults;
}

export interface ScopeIndexRefreshOptions {
	/** Index scope; determines the `scope` field written into entries. */
	scope: ToolScope;
	/** Directory holding this scope's `index.json`. */
	toolsDir: string;
	/** Canonical skills root to scan (the index is rebuilt from this disk state). */
	skillsRoot: string;
	/** Root that stored `path` values are relative to (agentDir for global, cwd for project). */
	pathRoot: string;
}

/**
 * Rebuild one scope's tool index from the skills on disk:
 * - upsert content fields (scope, path, version, status, description_hash) from each skill file
 * - carry over index-only state (usage counters, embedding) when `(name, path)` matches
 * - drop entries for skills that no longer exist
 * A missing or corrupted index file simply starts from an empty index, so the
 * refresh is also the rebuild path.
 */
export function refreshScopeIndex(options: ScopeIndexRefreshOptions): ToolIndex {
	const { scope, toolsDir, skillsRoot, pathRoot } = options;
	const index = loadToolIndex(toolsDir);
	const loaded = loadSkillsFromDir({
		dir: skillsRoot,
		source: scope === "global" ? "user" : "project",
	});

	const nextSkills: Record<string, ToolIndexEntry> = {};
	const seen = new Set<string>();
	for (const skill of loaded.skills) {
		if (seen.has(skill.name)) {
			// First-found-wins, mirroring loadSkills() name dedup.
			continue;
		}
		seen.add(skill.name);
		// Directory skills are identified by their dir; root-level .md skills by the file.
		const artifactPath = basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath;
		const relPath = toPosixPath(relative(pathRoot, artifactPath));
		const existing = index.skills[skill.name];
		const carried = existing && existing.path === relPath ? existing : undefined;
		nextSkills[skill.name] = {
			scope,
			path: relPath,
			...readRetainedMeta(skill.filePath),
			usage: carried ? carried.usage : zeroToolUsage(),
			description_hash: hashDescription(skill.description),
			embedding: carried ? carried.embedding : [],
		};
	}

	index.skills = nextSkills;
	index.updated = new Date().toISOString();
	saveToolIndex(toolsDir, index);
	return index;
}

export interface RefreshToolIndexesOptions {
	/** Project working directory (project skills root and project index live under it). */
	cwd: string;
	/** Global agent dir override; defaults to `getAgentDir()`. */
	agentDir?: string;
}

export interface RefreshToolIndexesResult {
	global: ToolIndex;
	project: ToolIndex;
}

/**
 * Refresh both scope indexes from disk. Each scope degrades independently: a
 * failure on one scope never blocks the other or the caller (skill load must
 * keep working even if the index is unwritable).
 */
export function refreshToolIndexes(options: RefreshToolIndexesOptions): RefreshToolIndexesResult {
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = resolve(options.cwd);

	const refresh = (scope: ToolScope, toolsDir: string, skillsRoot: string, pathRoot: string): ToolIndex => {
		try {
			return refreshScopeIndex({ scope, toolsDir, skillsRoot, pathRoot });
		} catch (error) {
			log.warn("tool index refresh failed", {
				scope,
				error: error instanceof Error ? error.message : String(error),
			});
			return emptyToolIndex();
		}
	};

	return {
		global: refresh("global", join(agentDir, "tools"), join(agentDir, "skills"), agentDir),
		project: refresh("project", join(cwd, CONFIG_DIR_NAME, "tools"), resolve(cwd, CONFIG_DIR_NAME, "skills"), cwd),
	};
}
