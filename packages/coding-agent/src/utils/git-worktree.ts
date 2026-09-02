import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKTREE_DIR_ENV_VAR = "PRIME_AGENT_WORKTREE_DIR";
const DEFAULT_WORKTREE_DIR_NAME = ".worktrees";

export interface GitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type GitCommandRunner = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

export interface CreateGitWorktreeOptions {
	/** Directory used to locate the repository the worktree is added to. */
	cwd: string;
	/** User-supplied worktree and branch name; sanitized into a single path segment. */
	name: string;
	/** `worktree.dir` setting; the env var still wins over it. */
	worktreeDir?: string;
	runGit?: GitCommandRunner;
	pathExists?: (path: string) => boolean;
}

export interface CreateGitWorktreeResult {
	path: string;
	branch: string;
	repoRoot: string;
	/** False when an existing worktree at the resolved path was reused. */
	created: boolean;
}

interface WorktreeEntry {
	path: string;
	branch?: string;
}

export const runGitCommand: GitCommandRunner = async (args, cwd) => {
	try {
		const { stdout, stderr } = await execFileAsync("git", [...args], { cwd, encoding: "utf-8" });
		return { stdout, stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message ?? "",
			exitCode: typeof failure.code === "number" ? failure.code : 1,
		};
	}
};

/** Reduce a free-form name to one safe path segment usable as a branch name. */
export function sanitizeWorktreeName(name: string): string {
	const sanitized = name
		.trim()
		.replace(/[^A-Za-z0-9._/-]+/g, "-")
		.replace(/\/+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._]+/, "")
		.replace(/[-._]+$/, "");
	if (!sanitized) {
		throw new Error(`Invalid worktree name: ${name}`);
	}
	return sanitized;
}

export async function resolveGitRepoRoot(cwd: string, runGit: GitCommandRunner = runGitCommand): Promise<string> {
	const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
	const root = result.stdout.trim();
	if (result.exitCode !== 0 || !root) {
		throw new Error(`Not a git repository: ${cwd}`);
	}
	return resolve(root);
}

/**
 * Resolution order: `PRIME_AGENT_WORKTREE_DIR`, then the `worktree.dir` setting
 * passed as `worktreeDir`, then `<repoRoot>/.worktrees`. A relative value
 * resolves against the repo root.
 */
export function resolveWorktreeParentDir(repoRoot: string, worktreeDir?: string): string {
	const trimmed = process.env[WORKTREE_DIR_ENV_VAR]?.trim() || worktreeDir?.trim();
	if (!trimmed) {
		return join(repoRoot, DEFAULT_WORKTREE_DIR_NAME);
	}
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(repoRoot, trimmed);
}

function parseWorktreeList(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: resolve(line.slice("worktree ".length).trim()) };
			entries.push(current);
			continue;
		}
		if (current && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).trim();
		}
	}
	return entries;
}

async function branchExists(repoRoot: string, branch: string, runGit: GitCommandRunner): Promise<boolean> {
	const result = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
	return result.exitCode === 0;
}

/**
 * Create (or reuse) a git worktree for `name` and return its absolute path.
 * An existing branch is attached instead of re-created.
 */
export async function createGitWorktree(options: CreateGitWorktreeOptions): Promise<CreateGitWorktreeResult> {
	const runGit = options.runGit ?? runGitCommand;
	const pathExists = options.pathExists ?? existsSync;
	const branch = sanitizeWorktreeName(options.name);
	const repoRoot = await resolveGitRepoRoot(options.cwd, runGit);
	const worktreePath = join(resolveWorktreeParentDir(repoRoot, options.worktreeDir), branch);

	const listed = await runGit(["worktree", "list", "--porcelain"], repoRoot);
	if (listed.exitCode !== 0) {
		throw new Error(`Failed to list worktrees: ${formatGitFailure(listed)}`);
	}
	const existing = parseWorktreeList(listed.stdout).find((entry) => entry.path === worktreePath);
	if (existing) {
		return {
			path: worktreePath,
			branch: existing.branch?.replace(/^refs\/heads\//, "") ?? branch,
			repoRoot,
			created: false,
		};
	}
	if (pathExists(worktreePath)) {
		throw new Error(`Worktree path already exists and is not a worktree: ${worktreePath}`);
	}

	const addArgs = (await branchExists(repoRoot, branch, runGit))
		? ["worktree", "add", worktreePath, branch]
		: ["worktree", "add", worktreePath, "-b", branch];
	const added = await runGit(addArgs, repoRoot);
	if (added.exitCode !== 0) {
		throw new Error(`git ${addArgs.join(" ")} failed: ${formatGitFailure(added)}`);
	}
	return { path: worktreePath, branch, repoRoot, created: true };
}

function formatGitFailure(result: GitCommandResult): string {
	const message = result.stderr.trim() || result.stdout.trim();
	return message || `exit code ${result.exitCode}`;
}
