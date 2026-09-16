/**
 * Repository-snapshot manifest generation for cloud sandbox uploads.
 *
 * A snapshot enumerates a Git repository or linked worktree (tracked files plus
 * non-ignored untracked files), hashes the current working-tree bytes (so staged
 * and unstaged modifications are captured as they exist on disk), copies regular
 * files and repository-internal symlinks into an independent staging directory,
 * and verifies the staged copies and the source against the manifest to detect
 * unstable captures.
 *
 * Security posture:
 * - Never captures `.git` directories or worktree pointer files, so host git
 *   config, credentials, and hooks never reach the staging directory.
 * - Never captures credential/key material by filename pattern.
 * - Never captures node_modules/venv directories.
 * - Captures regular files and symlinks whose targets stay inside the repository
 *   only; absolute symlink targets, sockets, devices, FIFOs, and escaping
 *   symlinks are skipped with a recorded reason.
 * - Runs git via `spawn` with an args array and `shell: false`; never interpolates
 *   shell strings.
 * - Produces a deterministic manifest (sorted entries, canonical JSON) and a
 *   SHA-256 digest of that canonical form as baseline provenance.
 *
 * Staging layout:
 * - `<stagingDir>/workspace/...` holds the captured repository bytes.
 * - `<stagingDir>/workspace-manifest.json` holds the manifest plus provenance,
 *   beside (never inside) the workspace directory, so a repository file named
 *   `workspace-manifest.json` cannot collide with the metadata.
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnHidden } from "../../utils/child-process.js";

/** Version of the manifest format produced by this module. */
const MANIFEST_VERSION = 1;

/**
 * Capture caps. Defaults are chosen to fit a 200 MiB single-upload gateway cap:
 * 100 MiB per file leaves headroom for other entries inside the 200 MiB total.
 */
const DEFAULT_MAX_FILE_COUNT = 100_000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const STAGING_DIR_PREFIX = "pi-workspace-snapshot-";
const WORKSPACE_DIR_NAME = "workspace";
const MANIFEST_FILE_NAME = "workspace-manifest.json";

/**
 * Directory names that are never captured, wherever they appear as a path
 * component. Applied to tracked and untracked candidates alike.
 */
export const DEFAULT_EXCLUDED_DIR_NAMES: readonly string[] = [".git", "node_modules", "venv", ".venv", ".tox"];

/**
 * Basename glob patterns for credential/key material that is never captured.
 * Matched case-insensitively against the file basename; `*` matches any run of
 * characters within the basename. Patterns are additive: callers can extend
 * them via {@link WorkspaceSnapshotOptions} but never remove the defaults.
 */
export const DEFAULT_CREDENTIAL_FILE_NAME_PATTERNS: readonly string[] = [
	".git",
	".env*",
	".netrc",
	".git-credentials",
	"*.pem",
	"*.key",
	"*.pfx",
	"*.p12",
	"*.keystore",
	"id_rsa*",
	"id_dsa*",
	"id_ecdsa*",
	"id_ed25519*",
];

/** Git-mode string for a regular file. */
type RegularFileMode = "100644" | "100755";

/** A single captured entry in the snapshot manifest. */
export interface WorkspaceSnapshotEntry {
	/** Repo-relative POSIX path ("/"-separated, never absolute, no "." or ".." components). */
	path: string;
	/** "file" for regular files, "symlink" for symlinks with in-repo targets. */
	kind: "file" | "symlink";
	/** Git-style mode: "100644" or "100755" for files, "120000" for symlinks. */
	mode: RegularFileMode | "120000";
	/** True when any executable bit is set (regular files only). */
	executable: boolean;
	/** Content length in bytes: file bytes, or the symlink target string's UTF-8 bytes. */
	size: number;
	/** SHA-256 of the content: file bytes, or the symlink target string's UTF-8 bytes. */
	sha256: string;
	/** Symlink target string exactly as recorded on disk. Present only for symlinks. */
	target?: string;
	/** True when the path is tracked in the git index (committed or staged). */
	tracked: boolean;
}

/** Deterministic manifest of a captured workspace. */
export interface WorkspaceSnapshotManifest {
	/** Manifest format version. Currently 1. */
	version: 1;
	/** Entries sorted by repo-relative path. */
	entries: WorkspaceSnapshotEntry[];
	/**
	 * Sorted repo-relative paths of tracked files (relative to HEAD or the index)
	 * that are deleted from the working tree, staged or unstaged. A consumer
	 * reconstructing HEAD applies these deletions after checkout. Policy-excluded
	 * names (credentials, node_modules, ...) are omitted.
	 */
	deletedPaths: string[];
}

/** Baseline provenance for a snapshot. */
export interface WorkspaceSnapshotProvenance {
	/** Absolute real path of the captured repository or worktree root. */
	repoRoot: string;
	/** HEAD commit hex digest when HEAD exists; null on an unborn branch. */
	headCommit: string | null;
	/** SHA-256 of the canonical manifest JSON (see {@link canonicalizeWorkspaceManifest}). */
	manifestDigest: string;
}

/** Reason a candidate path was excluded from the capture. */
export type WorkspaceExclusionReason =
	| "excluded-directory"
	| "credential-or-key-file"
	| "symlink-target-outside-repo"
	| "symlink-absolute-target"
	| "irregular-file"
	| "directory"
	| "symlinked-parent"
	| "invalid-path";

/** A policy exclusion encountered while enumerating the workspace. */
export interface WorkspaceExclusion {
	/** Repo-relative POSIX path of the excluded candidate. */
	path: string;
	reason: WorkspaceExclusionReason;
	/** Matched directory name or credential pattern, or an error detail. */
	detail?: string;
}

/** Caps applied while capturing. Exceeding any cap fails the snapshot. */
export interface WorkspaceSnapshotLimits {
	/** Maximum number of captured entries (files plus symlinks). Default 100000. */
	maxFileCount?: number;
	/**
	 * Maximum content size in bytes of a single captured entry (file bytes or
	 * symlink target bytes). Default 100 MiB.
	 */
	maxFileSizeBytes?: number;
	/** Maximum aggregate content size in bytes of all captured entries. Default 200 MiB. */
	maxTotalSizeBytes?: number;
}

export interface WorkspaceSnapshotOptions {
	/** Capture caps. Defaults are documented on {@link WorkspaceSnapshotLimits}. */
	limits?: WorkspaceSnapshotLimits;
	/** Extra directory names excluded in addition to the defaults (any path component). */
	additionalExcludedDirNames?: readonly string[];
	/** Extra credential/key basename globs in addition to the defaults. */
	additionalCredentialFileNamePatterns?: readonly string[];
	/** Parent directory for the staging directory. Must be outside the repository. Default os.tmpdir(). */
	stagingRoot?: string;
	/** Cooperative cancellation; checked before start, after git commands, and per entry. */
	signal?: AbortSignal;
	/** Timeout for each git command in milliseconds. Default 20000. */
	gitTimeoutMs?: number;
	/** Maximum buffered stdout bytes per git command. Default 256 MiB. */
	gitOutputCapBytes?: number;
}

/** Successful snapshot result. */
export interface WorkspaceSnapshot {
	/** Absolute real path of the captured repository or worktree root. */
	repoRoot: string;
	/** HEAD commit when present; null on an unborn branch. */
	headCommit: string | null;
	/** Deterministic manifest (entries sorted by path). */
	manifest: WorkspaceSnapshotManifest;
	/** SHA-256 of the canonical manifest JSON. */
	manifestDigest: string;
	/** Independent staging directory holding the captured bytes and the manifest file. */
	stagingDir: string;
	/** Number of captured entries. */
	fileCount: number;
	/** Aggregate captured size in bytes. */
	totalSizeBytes: number;
	/** Policy exclusions (sorted by path). */
	exclusions: WorkspaceExclusion[];
	/** Remove the staging directory. Idempotent; safe to call more than once. */
	cleanup(): void;
}

/** Failure kinds for {@link WorkspaceSnapshotError}. */
export type WorkspaceSnapshotErrorCode =
	| "invalid-options"
	| "invalid-cwd"
	| "not-a-git-repository"
	| "git-command-failed"
	| "limit-exceeded"
	| "unstable-capture"
	| "staging-error"
	| "aborted";

/** Error thrown by {@link createWorkspaceSnapshot}. */
export class WorkspaceSnapshotError extends Error {
	readonly code: WorkspaceSnapshotErrorCode;

	constructor(message: string, code: WorkspaceSnapshotErrorCode, options?: { cause?: unknown }) {
		super(message, options && options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "WorkspaceSnapshotError";
		this.code = code;
	}
}

interface GitRunResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

interface GitRunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	maxOutputBytes: number;
}

interface ResolvedLimits {
	maxFileCount: number;
	maxFileSizeBytes: number;
	maxTotalSizeBytes: number;
}

interface CredentialPattern {
	pattern: string;
	regexp: RegExp;
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function isExecutable(stat: Stats): boolean {
	return (stat.mode & 0o111) !== 0;
}

function regularFileMode(stat: Stats): RegularFileMode {
	return isExecutable(stat) ? "100755" : "100644";
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function safeLstat(absPath: string): Stats | null {
	try {
		return lstatSync(absPath);
	} catch (error) {
		if (isErrnoError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			return null;
		}
		throw error;
	}
}

function safeReadlink(absPath: string): string | null {
	try {
		return readlinkSync(absPath);
	} catch {
		return null;
	}
}

async function hashFile(absPath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(absPath)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

function globToRegExp(pattern: string): RegExp {
	const source = pattern
		.replace(/[\\^$.+()[\]{}|]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${source}$`, "i");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new WorkspaceSnapshotError("workspace snapshot aborted", "aborted");
	}
}

function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new WorkspaceSnapshotError(`${name} must be a positive integer, got: ${value}`, "invalid-options");
	}
	return value;
}

/**
 * Build a canonical, deterministic JSON string for a manifest. Entries are
 * sorted by path and entry keys are re-ordered, so the canonical form does not
 * depend on how the caller constructed the objects.
 */
export function canonicalizeWorkspaceManifest(manifest: WorkspaceSnapshotManifest): string {
	const canonical = {
		version: manifest.version,
		entries: [...manifest.entries]
			.sort((a, b) => compareStrings(a.path, b.path))
			.map((entry) => {
				const canonicalEntry: WorkspaceSnapshotEntry = {
					path: entry.path,
					kind: entry.kind,
					mode: entry.mode,
					executable: entry.executable,
					size: entry.size,
					sha256: entry.sha256,
					...(entry.target === undefined ? {} : { target: entry.target }),
					tracked: entry.tracked,
				};
				return canonicalEntry;
			}),
		deletedPaths: [...manifest.deletedPaths].sort(compareStrings),
	};
	return JSON.stringify(canonical);
}

/** SHA-256 of the canonical manifest JSON. */
export function digestWorkspaceManifest(manifest: WorkspaceSnapshotManifest): string {
	return sha256Hex(canonicalizeWorkspaceManifest(manifest));
}

/**
 * Environment for git child processes. Ambient `GIT_*` variables that could
 * redirect which repository git operates on are removed so the snapshot always
 * reads the repository at `cwd`. Config-file selection variables are preserved
 * so callers (and tests) can pin `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`.
 */
function gitEnv(): NodeJS.ProcessEnv {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_CONFIG",
		"GIT_NAMESPACE",
	]) {
		delete env[key];
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/**
 * Run a git command with `shell: false` and an args array. stdout is collected
 * as raw bytes so NUL-separated output survives intact regardless of encoding.
 */
function runGit(args: readonly string[], cwd: string, options: GitRunOptions): Promise<GitRunResult> {
	return new Promise((resolve, reject) => {
		const proc = spawnHidden("git", ["--no-optional-locks", ...args], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: gitEnv(),
		});

		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrText = "";
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		let killed = false;

		const onAbort = () => kill();

		const kill = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			forceKillId = setTimeout(() => {
				forceKillId = undefined;
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}
			}, 5000);
		};

		const cleanup = () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (forceKillId !== undefined) clearTimeout(forceKillId);
			options.signal?.removeEventListener("abort", onAbort);
		};

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr: stderrText });
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > options.maxOutputBytes) {
				// Bounded git output: kill instead of buffering unbounded bytes.
				fail(new Error(`git ${args[0] ?? ""} output exceeded ${options.maxOutputBytes} bytes`));
				proc.kill("SIGKILL");
				return;
			}
			stdoutChunks.push(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrText.length < MAX_STDERR_CHARS) {
				stderrText += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - stderrText.length);
			}
		});
		proc.once("error", fail);
		proc.once("close", (code) => settle(code ?? -1));

		if (options.signal?.aborted) {
			kill();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}
		if (options.timeoutMs > 0) {
			timeoutId = setTimeout(kill, options.timeoutMs);
		}
	});
}

/**
 * Run a git command and surface any failure (spawn error, kill, or output cap)
 * as a typed git-command-failed error.
 */
async function runGitChecked(args: readonly string[], cwd: string, options: GitRunOptions): Promise<GitRunResult> {
	try {
		return await runGit(args, cwd, options);
	} catch (error) {
		throw new WorkspaceSnapshotError(`git command failed: ${args.join(" ")}`, "git-command-failed", {
			cause: error,
		});
	}
}

function isValidRepoRelativePath(relPath: string): boolean {
	if (relPath.length === 0 || isAbsolute(relPath) || relPath.includes("\0")) {
		return false;
	}
	const components = relPath.split("/");
	return components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

function findExcludedDir(relPath: string, dirNames: ReadonlySet<string>): { dirPath: string; name: string } | null {
	const components = relPath.split("/");
	for (let index = 0; index < components.length - 1; index++) {
		const component = components[index];
		if (component !== undefined && dirNames.has(component)) {
			return { dirPath: components.slice(0, index + 1).join("/"), name: component };
		}
	}
	return null;
}

function matchesCredentialPattern(relPath: string, patterns: readonly CredentialPattern[]): CredentialPattern | null {
	const baseName = basename(relPath);
	return patterns.find((entry) => entry.regexp.test(baseName)) ?? null;
}

function isInsideRepo(absPath: string, repoRoot: string): boolean {
	return absPath === repoRoot || absPath.startsWith(repoRoot + sep);
}

/**
 * The first symlinked intermediate directory component of relPath, if any.
 * Only intermediate components are inspected: the final component is
 * classified separately by lstat on the candidate itself.
 */
function findSymlinkedParentComponent(repoRoot: string, relPath: string): string | null {
	const components = relPath.split("/");
	if (components.length < 2) {
		return null;
	}
	let current = repoRoot;
	for (let index = 0; index < components.length - 1; index++) {
		const component = components[index];
		if (component === undefined) {
			return null;
		}
		current = join(current, component);
		const stats = safeLstat(current);
		if (stats === null) {
			return null;
		}
		if (stats.isSymbolicLink()) {
			return component;
		}
	}
	return null;
}

/**
 * A symlink is captured only when its recorded target stays inside the
 * repository. The check resolves the link's real parent directory first, so
 * targets routed through an intermediate symlink that escapes the repository
 * are excluded even when the final path is lexically in-repo.
 */
function symlinkTargetStaysInsideRepo(repoRoot: string, linkAbsPath: string, target: string): boolean {
	try {
		const realParent = realpathSync(dirname(linkAbsPath));
		const resolved = resolve(realParent, target);
		return isInsideRepo(resolved, repoRoot);
	} catch {
		return false;
	}
}

function limitError(message: string): WorkspaceSnapshotError {
	return new WorkspaceSnapshotError(message, "limit-exceeded");
}

function unstableCaptureError(message: string): WorkspaceSnapshotError {
	return new WorkspaceSnapshotError(message, "unstable-capture");
}

interface Candidate {
	path: string;
	tracked: boolean;
}

async function listCandidates(repoRoot: string, options: GitRunOptions): Promise<Candidate[]> {
	const trackedResult = await runGitChecked(["ls-files", "-z", "--cached"], repoRoot, options);
	if (trackedResult.code !== 0) {
		assertNotAborted(options.signal);
		throw new WorkspaceSnapshotError(
			`git ls-files --cached failed (exit ${trackedResult.code}): ${trackedResult.stderr.trim()}`,
			"git-command-failed",
		);
	}
	const untrackedResult = await runGitChecked(["ls-files", "-z", "--others", "--exclude-standard"], repoRoot, options);
	if (untrackedResult.code !== 0) {
		assertNotAborted(options.signal);
		throw new WorkspaceSnapshotError(
			`git ls-files --others failed (exit ${untrackedResult.code}): ${untrackedResult.stderr.trim()}`,
			"git-command-failed",
		);
	}

	const candidates = new Map<string, Candidate>();
	for (const path of trackedResult.stdout.toString("utf8").split("\0")) {
		if (path.length > 0 && !candidates.has(path)) {
			candidates.set(path, { path, tracked: true });
		}
	}
	for (const path of untrackedResult.stdout.toString("utf8").split("\0")) {
		if (path.length > 0 && !candidates.has(path)) {
			candidates.set(path, { path, tracked: false });
		}
	}
	return [...candidates.values()].sort((a, b) => compareStrings(a.path, b.path));
}

/**
 * Deletions (staged or unstaged) between HEAD and the working tree. Rename
 * detection is disabled: a rename must surface its old path as a deletion so a
 * reconstructed HEAD does not retain the pre-rename path.
 */
async function listHeadDeletions(repoRoot: string, options: GitRunOptions): Promise<string[]> {
	const result = await runGitChecked(
		["diff", "--name-only", "--diff-filter=D", "--no-renames", "-z", "HEAD"],
		repoRoot,
		options,
	);
	if (result.code !== 0) {
		// Unborn HEAD (no commits yet) has nothing to reconstruct.
		return [];
	}
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter((path) => path.length > 0);
}

function stagedPathFor(stagingDir: string, relPath: string): string {
	return join(stagingDir, WORKSPACE_DIR_NAME, ...relPath.split("/"));
}

/**
 * Resolve a staging root to a real path even when its final components do not
 * exist yet: realpath the deepest existing ancestor and reattach the rest, so
 * containment checks see through symlinked prefixes like /var vs /private/var.
 * Falls back to the lexical path when no ancestor exists.
 */
function resolveStagingRootPath(rawStagingRoot: string): string {
	const resolved = resolve(rawStagingRoot);
	if (existsSync(resolved)) {
		return realpathSync(resolved);
	}
	const tail: string[] = [];
	let current = dirname(resolved);
	while (current !== dirname(current)) {
		if (existsSync(current)) {
			return join(realpathSync(current), ...tail.reverse());
		}
		tail.push(basename(current));
		current = dirname(current);
	}
	return resolved;
}

/**
 * Create a deterministic snapshot of the Git repository or worktree containing
 * `cwd`.
 *
 * The staging directory receives the captured files under `workspace/`, the
 * in-repo symlinks, and a `workspace-manifest.json` with the manifest plus
 * baseline provenance beside the workspace directory. The staging directory
 * never contains `.git` data, host git config, credentials, or hooks. Call
 * `cleanup()` on the result (failures clean up automatically) to remove the
 * staging directory.
 */
export async function createWorkspaceSnapshot(
	cwd: string,
	options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
	if (options.signal?.aborted) {
		throw new WorkspaceSnapshotError("workspace snapshot aborted before it started", "aborted");
	}
	const limits: ResolvedLimits = {
		maxFileCount: requirePositiveInteger(
			options.limits?.maxFileCount ?? DEFAULT_MAX_FILE_COUNT,
			"limits.maxFileCount",
		),
		maxFileSizeBytes: requirePositiveInteger(
			options.limits?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
			"limits.maxFileSizeBytes",
		),
		maxTotalSizeBytes: requirePositiveInteger(
			options.limits?.maxTotalSizeBytes ?? DEFAULT_MAX_TOTAL_SIZE_BYTES,
			"limits.maxTotalSizeBytes",
		),
	};
	const gitTimeoutMs = requirePositiveInteger(options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, "gitTimeoutMs");
	const gitOutputCapBytes = requirePositiveInteger(
		options.gitOutputCapBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES,
		"gitOutputCapBytes",
	);

	const resolvedCwd = resolve(cwd);
	let cwdStats: Stats | null = null;
	try {
		cwdStats = statSync(resolvedCwd);
	} catch {
		cwdStats = null;
	}
	if (cwdStats === null || !cwdStats.isDirectory()) {
		throw new WorkspaceSnapshotError(`workspace path is not a directory: ${resolvedCwd}`, "invalid-cwd");
	}

	const gitOptions: GitRunOptions = {
		timeoutMs: gitTimeoutMs,
		signal: options.signal,
		maxOutputBytes: gitOutputCapBytes,
	};

	let toplevel: GitRunResult;
	try {
		toplevel = await runGit(["rev-parse", "--show-toplevel"], resolvedCwd, gitOptions);
	} catch (error) {
		throw new WorkspaceSnapshotError(`failed to run git in ${resolvedCwd}`, "git-command-failed", {
			cause: error,
		});
	}
	if (toplevel.code !== 0) {
		assertNotAborted(options.signal);
		throw new WorkspaceSnapshotError(
			`not a git repository (or worktree): ${resolvedCwd}: ${toplevel.stderr.trim()}`,
			"not-a-git-repository",
		);
	}
	const repoRoot = realpathSync(toplevel.stdout.toString("utf8").trim());

	const headResult = await runGitChecked(["rev-parse", "HEAD"], repoRoot, gitOptions);
	const headText = headResult.stdout.toString("utf8").trim();
	const headCommit = headResult.code === 0 && /^[0-9a-f]{40,64}$/.test(headText) ? headText : null;

	const excludedDirNames = new Set<string>([
		...DEFAULT_EXCLUDED_DIR_NAMES,
		...(options.additionalExcludedDirNames ?? []),
	]);
	const credentialPatterns = [
		...DEFAULT_CREDENTIAL_FILE_NAME_PATTERNS,
		...(options.additionalCredentialFileNamePatterns ?? []),
	].map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));

	const rawStagingRoot = options.stagingRoot ?? tmpdir();
	const stagingRoot = resolveStagingRootPath(rawStagingRoot);
	if (isInsideRepo(stagingRoot, repoRoot)) {
		throw new WorkspaceSnapshotError(
			`staging root must be outside the repository: ${rawStagingRoot}`,
			"staging-error",
		);
	}
	let stagingDir: string;
	try {
		stagingDir = mkdtempSync(join(stagingRoot, STAGING_DIR_PREFIX));
	} catch (error) {
		throw new WorkspaceSnapshotError(`failed to create staging directory in ${stagingRoot}`, "staging-error", {
			cause: error,
		});
	}
	let cleaned = false;
	const cleanup = () => {
		if (!cleaned) {
			cleaned = true;
			rmSync(stagingDir, { recursive: true, force: true });
		}
	};

	try {
		const candidates = await listCandidates(repoRoot, gitOptions);
		const headDeletions = await listHeadDeletions(repoRoot, gitOptions);
		const deletedPaths = new Set<string>();
		for (const relPath of headDeletions) {
			deletedPaths.add(relPath);
		}

		const entries: WorkspaceSnapshotEntry[] = [];
		const exclusions: WorkspaceExclusion[] = [];
		const excludedDirPaths = new Set<string>();
		let totalSize = 0;

		for (const candidate of candidates) {
			assertNotAborted(options.signal);
			// git lists untracked directories that look like nested repositories
			// (e.g. "nested/") as single trailing-slash entries; normalize them
			// so they classify as directories instead of invalid paths.
			const relPath = candidate.path.replace(/\/+$/, "");
			if (!isValidRepoRelativePath(relPath)) {
				exclusions.push({ path: relPath, reason: "invalid-path" });
				continue;
			}

			const excludedDir = findExcludedDir(relPath, excludedDirNames);
			if (excludedDir !== null) {
				if (!excludedDirPaths.has(excludedDir.dirPath)) {
					excludedDirPaths.add(excludedDir.dirPath);
					exclusions.push({
						path: excludedDir.dirPath,
						reason: "excluded-directory",
						detail: excludedDir.name,
					});
				}
				continue;
			}

			const credentialMatch = matchesCredentialPattern(relPath, credentialPatterns);
			if (credentialMatch !== null) {
				exclusions.push({
					path: relPath,
					reason: "credential-or-key-file",
					detail: credentialMatch.pattern,
				});
				continue;
			}

			// A working tree cannot represent a regular file beneath a
			// symlinked directory. Intermediate symlinks are never traversed,
			// regardless of where they point; the symlink itself is captured
			// separately when its target is safe.
			const symlinkedComponent = findSymlinkedParentComponent(repoRoot, relPath);
			if (symlinkedComponent !== null) {
				exclusions.push({
					path: relPath,
					reason: "symlinked-parent",
					detail: symlinkedComponent,
				});
				continue;
			}

			const absPath = join(repoRoot, ...relPath.split("/"));
			let stats: Stats;
			try {
				const lstat = safeLstat(absPath);
				if (lstat === null) {
					// Unstaged deletions of tracked files are recorded in
					// deletedPaths (via the HEAD diff); nothing to capture here.
					continue;
				}
				stats = lstat;
			} catch (error) {
				exclusions.push({
					path: relPath,
					reason: "invalid-path",
					detail: isErrnoError(error) ? error.code : "stat failed",
				});
				continue;
			}

			if (stats.isDirectory()) {
				// Submodule gitlinks and directory candidates carry no file bytes.
				exclusions.push({ path: relPath, reason: "directory" });
				continue;
			}

			if (stats.isSymbolicLink()) {
				const target = safeReadlink(absPath);
				if (target === null) {
					exclusions.push({ path: relPath, reason: "invalid-path", detail: "readlink failed" });
					continue;
				}
				// Absolute targets name host paths and would not survive in a
				// sandbox; they are never captured, even when they point inside
				// this repository.
				if (isAbsolute(target)) {
					exclusions.push({ path: relPath, reason: "symlink-absolute-target" });
					continue;
				}
				if (!symlinkTargetStaysInsideRepo(repoRoot, absPath, target)) {
					exclusions.push({ path: relPath, reason: "symlink-target-outside-repo" });
					continue;
				}
				if (entries.length + 1 > limits.maxFileCount) {
					throw limitError(
						`file count limit exceeded: ${entries.length + 1} > ${limits.maxFileCount} at ${relPath}`,
					);
				}
				const targetBytes = Buffer.byteLength(target, "utf8");
				if (targetBytes > limits.maxFileSizeBytes) {
					throw limitError(
						`file size limit exceeded: symlink target of ${relPath} is ${targetBytes} bytes > ${limits.maxFileSizeBytes}`,
					);
				}
				if (totalSize + targetBytes > limits.maxTotalSizeBytes) {
					throw limitError(
						`total size limit exceeded: ${totalSize + targetBytes} > ${limits.maxTotalSizeBytes} at ${relPath}`,
					);
				}
				const stagedAbsPath = stagedPathFor(stagingDir, relPath);
				mkdirSync(dirname(stagedAbsPath), { recursive: true });
				symlinkSync(target, stagedAbsPath, process.platform === "win32" ? "file" : undefined);
				const stagedLink = safeLstat(stagedAbsPath);
				if (stagedLink === null || !stagedLink.isSymbolicLink()) {
					throw unstableCaptureError(`staged symlink is not a symlink: ${relPath}`);
				}
				if (safeReadlink(stagedAbsPath) !== target) {
					throw unstableCaptureError(`staged symlink target mismatch: ${relPath}`);
				}
				const postLink = safeLstat(absPath);
				if (postLink === null || !postLink.isSymbolicLink() || safeReadlink(absPath) !== target) {
					throw unstableCaptureError(`symlink changed during capture: ${relPath}`);
				}
				entries.push({
					path: relPath,
					kind: "symlink",
					mode: "120000",
					executable: false,
					size: targetBytes,
					sha256: sha256Hex(target),
					target,
					tracked: candidate.tracked,
				});
				totalSize += targetBytes;
				continue;
			}

			if (!stats.isFile()) {
				// Sockets, devices, and FIFOs are never captured.
				exclusions.push({ path: relPath, reason: "irregular-file" });
				continue;
			}

			if (entries.length + 1 > limits.maxFileCount) {
				throw limitError(`file count limit exceeded: ${entries.length + 1} > ${limits.maxFileCount} at ${relPath}`);
			}
			if (stats.size > limits.maxFileSizeBytes) {
				throw limitError(
					`file size limit exceeded: ${relPath} is ${stats.size} bytes > ${limits.maxFileSizeBytes}`,
				);
			}
			if (totalSize + stats.size > limits.maxTotalSizeBytes) {
				throw limitError(
					`total size limit exceeded: ${totalSize + stats.size} > ${limits.maxTotalSizeBytes} at ${relPath}`,
				);
			}

			const manifestSha256 = await hashFile(absPath);
			const stagedAbsPath = stagedPathFor(stagingDir, relPath);
			mkdirSync(dirname(stagedAbsPath), { recursive: true });
			copyFileSync(absPath, stagedAbsPath);
			chmodSync(stagedAbsPath, stats.mode & 0o777);

			const postStats = safeLstat(absPath);
			if (
				postStats === null ||
				!postStats.isFile() ||
				postStats.size !== stats.size ||
				postStats.mtimeMs !== stats.mtimeMs ||
				(postStats.mode & 0o777) !== (stats.mode & 0o777)
			) {
				throw unstableCaptureError(`file changed during capture: ${relPath}`);
			}
			// Metadata alone can miss a same-size, mtime-preserved rewrite, so
			// the source is re-hashed after the copy.
			const postSourceSha256 = await hashFile(absPath);
			if (postSourceSha256 !== manifestSha256) {
				throw unstableCaptureError(`source hash changed during capture: ${relPath}`);
			}

			let stagedStats: Stats;
			try {
				stagedStats = statSync(stagedAbsPath);
			} catch {
				throw unstableCaptureError(`staged copy is unreadable: ${relPath}`);
			}
			if (!stagedStats.isFile()) {
				throw unstableCaptureError(`staged copy is not a regular file: ${relPath}`);
			}
			if (stagedStats.size !== stats.size) {
				throw unstableCaptureError(
					`staged copy size mismatch: ${relPath} staged ${stagedStats.size} != manifest ${stats.size}`,
				);
			}
			if (isExecutable(stagedStats) !== isExecutable(stats)) {
				throw unstableCaptureError(`staged copy mode mismatch: ${relPath}`);
			}
			const stagedSha256 = await hashFile(stagedAbsPath);
			if (stagedSha256 !== manifestSha256) {
				throw unstableCaptureError(`staged copy hash mismatch: ${relPath}`);
			}

			entries.push({
				path: relPath,
				kind: "file",
				mode: regularFileMode(stats),
				executable: isExecutable(stats),
				size: stats.size,
				sha256: manifestSha256,
				tracked: candidate.tracked,
			});
			totalSize += stats.size;
		}

		const filteredDeletedPaths = [...deletedPaths]
			.filter(
				(relPath) =>
					isValidRepoRelativePath(relPath) &&
					findExcludedDir(relPath, excludedDirNames) === null &&
					matchesCredentialPattern(relPath, credentialPatterns) === null,
			)
			.sort(compareStrings);

		entries.sort((a, b) => compareStrings(a.path, b.path));
		exclusions.sort(
			(a, b) =>
				compareStrings(a.path, b.path) ||
				compareStrings(a.reason, b.reason) ||
				compareStrings(a.detail ?? "", b.detail ?? ""),
		);

		const manifest: WorkspaceSnapshotManifest = {
			version: MANIFEST_VERSION,
			entries,
			deletedPaths: filteredDeletedPaths,
		};
		const manifestDigest = digestWorkspaceManifest(manifest);
		const provenance: WorkspaceSnapshotProvenance = { repoRoot, headCommit, manifestDigest };
		writeFileSync(
			join(stagingDir, MANIFEST_FILE_NAME),
			`${JSON.stringify({ manifest, provenance }, null, "\t")}\n`,
			"utf8",
		);

		return {
			repoRoot,
			headCommit,
			manifest,
			manifestDigest,
			stagingDir,
			fileCount: entries.length,
			totalSizeBytes: totalSize,
			exclusions,
			cleanup,
		};
	} catch (error) {
		cleanup();
		if (error instanceof WorkspaceSnapshotError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkspaceSnapshotError(`workspace snapshot failed: ${message}`, "staging-error", {
			cause: error,
		});
	}
}
