import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { canonicalizeDirectory } from "../utils/paths.js";
import { acquireSyncFileLock } from "../utils/sync-file-lock.js";

export type ProjectTrustDecision = boolean | null;

type TrustFile = Record<string, boolean | null | undefined>;

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

function readTrustFile(path: string): TrustFile {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		sorted[key] = data[key];
	}

	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(sorted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const release = acquireSyncFileLock(trustDir, { lockfilePath: `${path}.lock` });
	try {
		return fn();
	} finally {
		release();
	}
}

export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const userAgentsSkillsDir = canonicalizeDirectory(join(process.env.HOME || homedir(), ".agents", "skills"));
	// Walks the lexical ancestry the resource loaders walk, not the symlink-resolved one. Resolving
	// here would scan a different chain for a symlinked cwd and skip the prompt for a file that loads.
	let currentDir = resolvePath(cwd);
	// A project config dir is not inherited, so it counts only at the start directory.
	if (existsSync(join(currentDir, CONFIG_DIR_NAME))) {
		return true;
	}

	while (true) {
		for (const filename of CONTEXT_FILE_NAMES) {
			if (existsSync(join(currentDir, filename))) {
				return true;
			}
		}
		const agentsSkillsDir = canonicalizeDirectory(join(currentDir, ".agents", "skills"));
		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private readonly trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			let currentDir = canonicalizeDirectory(cwd);
			while (true) {
				const value = data[currentDir];
				if (value === true || value === false) {
					return value;
				}
				const parentDir = dirname(currentDir);
				if (parentDir === currentDir) {
					return null;
				}
				currentDir = parentDir;
			}
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			const key = canonicalizeDirectory(cwd);
			if (decision === null) {
				delete data[key];
			} else {
				data[key] = decision;
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
