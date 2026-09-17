import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { Semaphore } from "../../utils/semaphore.js";
import {
	canonicalizeWorkspaceManifest,
	digestWorkspaceManifest,
	type WorkspaceSnapshotEntry,
	type WorkspaceSnapshotManifest,
} from "./workspace-snapshot.js";

/**
 * Upload of a captured workspace snapshot into a remote sandbox.
 *
 * This module moves the staged bytes produced by `createWorkspaceSnapshot`
 * (staging layout: `workspace/<repo-relative-path>` plus a
 * `workspace-manifest.json` beside it) into a sandbox directory over two
 * injected seams:
 *
 * - `CloudRemoteUpload`: writes file bytes at an absolute sandbox path.
 * - `CloudRemoteCommand`: runs one argv array in the sandbox, no shell.
 *
 * Nothing platform-specific lives here. The caller adapts the seams to the
 * real transport (Prime Sandbox gateway upload + exec/command-session), so
 * the transfer logic is testable with fakes and transport-independent.
 *
 * Safety contract:
 *
 * - Every manifest entry path, symlink target, and remote path is validated
 *   before any byte leaves the machine: relative POSIX paths only, no
 *   absolute paths, no `.`/`..` components, no NUL bytes, no duplicates.
 * - Symlinks are reconstructed from the recorded relative target only, and
 *   only when the target resolves inside the transferred workspace root.
 * - Staged bytes are re-hashed (SHA-256) against the manifest right before
 *   upload, so staging corruption cannot reach the sandbox.
 * - The staged `workspace-manifest.json` is validated against the caller's
 *   manifest digest and uploaded last, marking the transfer complete.
 * - All remote operations are idempotent (mkdir -p, overwrite with identical
 *   verified bytes, ln -sfn, chmod) and retried a bounded number of times.
 * - Cancellation is cooperative: no new operation starts after an abort and
 *   queued work stops immediately; calls already in flight are not torn down.
 * - The first failure aborts the remaining work (fail fast) and the transfer
 *   reports the original failure, never a cascade of secondary aborts.
 */

export const DEFAULT_TRANSFER_CONCURRENCY = 8;
export const DEFAULT_TRANSFER_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;
export const DEFAULT_EXEC_TIMEOUT_SECONDS = 120;
/** Per-file upload cap, matching the sandbox gateway's per-request cap. */
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_MANIFEST_UPLOAD_BYTES = 64 * 1024 * 1024;

const MAX_MANIFEST_ENTRIES = 1_000_000;
const MAX_ARGV_ENTRIES = 128;
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_REMOTE_PATH_CHARS = 4096;
const MAX_CONCURRENCY = 256;
const MAX_ATTEMPTS = 16;
const MAX_STDERR_PREVIEW_CHARS = 2048;
const WORKSPACE_DIR_NAME = "workspace";
const MANIFEST_FILE_NAME = "workspace-manifest.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** File bytes written into the sandbox at an absolute path. */
export interface CloudRemoteUploadRequest {
	/** Absolute destination path inside the sandbox. */
	readonly path: string;
	/** File name for the transfer (single path segment, never used as a location). */
	readonly filename: string;
	/** File bytes; bounded to `MAX_UPLOAD_FILE_BYTES`. */
	readonly content: Uint8Array;
}

/** Upload outcome reported by the sandbox transport. */
export interface CloudRemoteUploadResult {
	/** Absolute path that was written. */
	readonly path: string;
	/** Number of bytes written; must equal the request size. */
	readonly size: number;
}

/** Injected seam: transport that writes file bytes into the sandbox. */
export interface CloudRemoteUpload {
	uploadFile(request: CloudRemoteUploadRequest): Promise<CloudRemoteUploadResult>;
}

/** One argv command executed in the sandbox without a shell. */
export interface CloudRemoteCommandRequest {
	/** argv[0] is the executable; no shell interpolation happens anywhere. */
	readonly argv: readonly string[];
	/** Optional absolute sandbox working directory. */
	readonly cwd?: string;
	/** Per-command timeout in seconds; 1..900. */
	readonly timeoutSeconds?: number;
}

/** Command outcome reported by the sandbox transport. */
export interface CloudRemoteCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Injected seam: transport that runs argv commands in the sandbox. */
export interface CloudRemoteCommand {
	exec(request: CloudRemoteCommandRequest): Promise<CloudRemoteCommandResult>;
}

/** A snapshot to transfer: the staging directory plus its verified manifest. */
export interface WorkspaceTransferSource {
	/** Staging directory produced by `createWorkspaceSnapshot`. */
	readonly stagingDir: string;
	/** The captured manifest; must equal the staged manifest file. */
	readonly manifest: WorkspaceSnapshotManifest;
	/** SHA-256 of the canonical manifest JSON; the staged file must match it. */
	readonly manifestDigest: string;
}

export interface WorkspaceTransferOptions {
	/** Transport that uploads file bytes into the sandbox. */
	readonly upload: CloudRemoteUpload;
	/** Transport that runs argv commands in the sandbox. */
	readonly command: CloudRemoteCommand;
	/**
	 * Absolute POSIX directory inside the sandbox that mirrors the staging
	 * layout: files land in `<remoteDir>/workspace/...`, the manifest in
	 * `<remoteDir>/workspace-manifest.json`.
	 */
	readonly remoteDir: string;
	/** Concurrent remote operations. Default 8, at most 256. */
	readonly concurrency?: number;
	/** Attempts per remote operation (uploads and argv commands). Default 3. */
	readonly attempts?: number;
	/** Delay between attempts in milliseconds. Default 250. */
	readonly retryDelayMs?: number;
	/** Timeout for each argv command in seconds. Default 120, at most 900. */
	readonly execTimeoutSeconds?: number;
	/**
	 * Retry predicate over transport errors. Defaults to retrying every
	 * thrown error; callers narrow it to transient transport failures.
	 */
	readonly isRetryable?: (error: unknown) => boolean;
	/** Injectable sleep between attempts (tests). */
	readonly sleepFn?: (ms: number) => Promise<void>;
	/** Cooperative cancellation; checked before and between operations. */
	readonly signal?: AbortSignal;
	/** Progress events, in completion order. */
	readonly onProgress?: (event: WorkspaceTransferProgress) => void;
}

export type WorkspaceTransferProgress =
	| { kind: "mkdir"; dirs: number }
	| { kind: "file"; path: string; bytes: number }
	| { kind: "symlink"; path: string; target: string }
	| { kind: "manifest"; path: string; bytes: number };

export interface WorkspaceTransferResult {
	/** Absolute sandbox directory that mirrors the staging layout. */
	readonly remoteDir: string;
	/** `<remoteDir>/workspace`. */
	readonly remoteWorkspaceDir: string;
	/** `<remoteDir>/workspace-manifest.json`. */
	readonly remoteManifestPath: string;
	/** SHA-256 of the canonical manifest JSON that was transferred. */
	readonly manifestDigest: string;
	/** Number of regular files uploaded. */
	readonly uploadedFiles: number;
	/** Number of symlinks reconstructed. */
	readonly uploadedSymlinks: number;
	/** File bytes uploaded, including the manifest. */
	readonly uploadedBytes: number;
}

export type WorkspaceTransferErrorCode =
	| "invalid-options"
	| "invalid-manifest"
	| "staging-error"
	| "remote-command-failed"
	| "upload-failed"
	| "aborted";

/** Error thrown by `transferWorkspaceSnapshot`. */
export class WorkspaceTransferError extends Error {
	readonly code: WorkspaceTransferErrorCode;

	constructor(message: string, code: WorkspaceTransferErrorCode, options?: { cause?: unknown }) {
		super(message, options && options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "WorkspaceTransferError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(content: Uint8Array | string): string {
	return createHash("sha256").update(content).digest("hex");
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedError(): WorkspaceTransferError {
	return new WorkspaceTransferError("workspace transfer aborted", "aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortedError();
	}
}

function bound(text: string): string {
	return text.length <= MAX_STDERR_PREVIEW_CHARS ? text : `${text.slice(0, MAX_STDERR_PREVIEW_CHARS)}…`;
}

/** Repo-relative POSIX path validation shared by manifests and baselines. */
function relativePathProblem(path: string, label: string): string | undefined {
	if (path.length === 0 || path.length > MAX_REMOTE_PATH_CHARS || path.includes("\0")) {
		return `${label} must be a NUL-free string of at most ${MAX_REMOTE_PATH_CHARS} characters`;
	}
	if (path.startsWith("/")) {
		return `${label} must be relative, not absolute`;
	}
	for (const component of path.split("/")) {
		if (component === "" || component === "." || component === "..") {
			return `${label} must have non-empty normal components only`;
		}
	}
	return undefined;
}

/**
 * Lexically resolve a recorded symlink target from the link's parent
 * directory and require that it stays inside the workspace root. This mirrors
 * the capture-side check: absolute targets and targets that escape the root
 * were never captured, so a manifest claiming one is invalid or hostile.
 */
function symlinkTargetProblem(linkRelPath: string, target: string): string | undefined {
	if (target === "") {
		return "symlink target must not be empty";
	}
	if (target.includes("\0")) {
		return "symlink target must be NUL-free";
	}
	if (target.startsWith("/")) {
		return "symlink target must be relative";
	}
	let depth = linkRelPath.split("/").length - 1;
	for (const component of target.split("/")) {
		if (component === "") {
			return "symlink target must not have empty components";
		}
		if (component === ".") {
			continue;
		}
		if (component === "..") {
			depth -= 1;
			if (depth < 0) {
				return "symlink target escapes the workspace root";
			}
			continue;
		}
		depth += 1;
	}
	return undefined;
}

function entryProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	const path = value.path;
	if (typeof path !== "string") {
		return `${label}.path must be a string`;
	}
	const pathProblem = relativePathProblem(path, `${label}.path`);
	if (pathProblem !== undefined) {
		return pathProblem;
	}
	const kind = value.kind;
	if (kind !== "file" && kind !== "symlink") {
		return `${label}.kind must be "file" or "symlink"`;
	}
	if (typeof value.tracked !== "boolean") {
		return `${label}.tracked must be a boolean`;
	}
	const mode = value.mode;
	if (typeof mode !== "string" || !["100644", "100755", "120000"].includes(mode)) {
		return `${label}.mode must be 100644, 100755, or 120000`;
	}
	if (typeof value.executable !== "boolean") {
		return `${label}.executable must be a boolean`;
	}
	const size = value.size;
	if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
		return `${label}.size must be a non-negative integer`;
	}
	const sha256 = value.sha256;
	if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
		return `${label}.sha256 must be 64 lowercase hex characters`;
	}
	if (kind === "file") {
		if (mode !== "100644" && mode !== "100755") {
			return `${label}.mode must be 100644 or 100755 for files`;
		}
		if (value.executable !== (mode === "100755")) {
			return `${label}.executable must match the recorded mode`;
		}
		if (value.target !== undefined) {
			return `${label}.target is only valid for symlinks`;
		}
		return undefined;
	}
	if (mode !== "120000") {
		return `${label}.mode must be 120000 for symlinks`;
	}
	if (value.executable) {
		return `${label}.executable must be false for symlinks`;
	}
	const target = value.target;
	if (typeof target !== "string") {
		return `${label}.target is required for symlinks`;
	}
	if (Buffer.byteLength(target, "utf8") !== size) {
		return `${label}.size must equal the target byte length`;
	}
	if (sha256Hex(target) !== sha256) {
		return `${label}.sha256 must equal the target digest`;
	}
	const targetProblem = symlinkTargetProblem(path, target);
	if (targetProblem !== undefined) {
		return `${label}: ${targetProblem}`;
	}
	return undefined;
}

/**
 * Runtime validation for a `WorkspaceSnapshotManifest`. A manifest is
 * untrusted input the moment it crosses a process boundary or disk, so every
 * field, path, and recorded symlink target is checked before use. Exported
 * because the result importer validates baseline manifests with the same rules.
 */
export function workspaceManifestProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "manifest must be an object";
	}
	if (value.version !== 1) {
		return "manifest.version must be 1";
	}
	if (!Array.isArray(value.entries)) {
		return "manifest.entries must be an array";
	}
	if (value.entries.length > MAX_MANIFEST_ENTRIES) {
		return `manifest.entries must hold at most ${MAX_MANIFEST_ENTRIES} entries`;
	}
	const seenPaths = new Set<string>();
	for (let index = 0; index < value.entries.length; index++) {
		const problem = entryProblem(value.entries[index], `manifest.entries[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
		const entry = value.entries[index] as WorkspaceSnapshotEntry;
		if (seenPaths.has(entry.path)) {
			return `manifest has a duplicate entry path: ${entry.path}`;
		}
		seenPaths.add(entry.path);
	}
	if (!Array.isArray(value.deletedPaths)) {
		return "manifest.deletedPaths must be an array";
	}
	const seenDeleted = new Set<string>();
	for (let index = 0; index < value.deletedPaths.length; index++) {
		const path = value.deletedPaths[index];
		if (typeof path !== "string") {
			return `manifest.deletedPaths[${index}] must be a string`;
		}
		const problem = relativePathProblem(path, `manifest.deletedPaths[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
		if (seenDeleted.has(path)) {
			return `manifest has a duplicate deleted path: ${path}`;
		}
		seenDeleted.add(path);
	}
	return undefined;
}

function remoteDirProblem(dir: string): string | undefined {
	if (typeof dir !== "string" || dir.length === 0 || dir.length > MAX_REMOTE_PATH_CHARS || dir.includes("\0")) {
		return "remoteDir must be a NUL-free string of at most 4096 characters";
	}
	if (!dir.startsWith("/")) {
		return "remoteDir must be an absolute POSIX path";
	}
	if (dir.endsWith("/")) {
		return "remoteDir must not end with a slash";
	}
	for (const component of dir.slice(1).split("/")) {
		if (component === "" || component === "." || component === "..") {
			return "remoteDir must have non-empty normal components only";
		}
	}
	return undefined;
}

function requirePositiveInteger(value: number | undefined, fallback: number, max: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
		throw new WorkspaceTransferError(`${name} must be an integer from 1 to ${max}`, "invalid-options");
	}
	return resolved;
}

interface TransferSettings {
	upload: CloudRemoteUpload;
	command: CloudRemoteCommand;
	remoteDir: string;
	remoteWorkspaceDir: string;
	remoteManifestPath: string;
	concurrency: number;
	attempts: number;
	retryDelayMs: number;
	execTimeoutSeconds: number;
	isRetryable: (error: unknown) => boolean;
	sleepFn: (ms: number) => Promise<void>;
	signal: AbortSignal | undefined;
	onProgress: ((event: WorkspaceTransferProgress) => void) | undefined;
}

function validateOptions(options: WorkspaceTransferOptions): TransferSettings {
	if (!isRecord(options)) {
		throw new WorkspaceTransferError("options must be an object", "invalid-options");
	}
	if (!isRecord(options.upload) || typeof options.upload.uploadFile !== "function") {
		throw new WorkspaceTransferError("options.upload must provide uploadFile()", "invalid-options");
	}
	if (!isRecord(options.command) || typeof options.command.exec !== "function") {
		throw new WorkspaceTransferError("options.command must provide exec()", "invalid-options");
	}
	if (typeof options.remoteDir !== "string") {
		throw new WorkspaceTransferError("options.remoteDir must be a string", "invalid-options");
	}
	const dirProblem = remoteDirProblem(options.remoteDir);
	if (dirProblem !== undefined) {
		throw new WorkspaceTransferError(dirProblem, "invalid-options");
	}
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
		throw new WorkspaceTransferError("retryDelayMs must be an integer from 0 to 60000", "invalid-options");
	}
	for (const [name, value] of [
		["isRetryable", options.isRetryable],
		["sleepFn", options.sleepFn],
		["onProgress", options.onProgress],
	] as const) {
		if (value !== undefined && typeof value !== "function") {
			throw new WorkspaceTransferError(`${name} must be a function`, "invalid-options");
		}
	}
	return {
		upload: options.upload,
		command: options.command,
		remoteDir: options.remoteDir,
		remoteWorkspaceDir: `${options.remoteDir}/${WORKSPACE_DIR_NAME}`,
		remoteManifestPath: `${options.remoteDir}/${MANIFEST_FILE_NAME}`,
		concurrency: requirePositiveInteger(
			options.concurrency,
			DEFAULT_TRANSFER_CONCURRENCY,
			MAX_CONCURRENCY,
			"concurrency",
		),
		attempts: requirePositiveInteger(options.attempts, DEFAULT_TRANSFER_ATTEMPTS, MAX_ATTEMPTS, "attempts"),
		retryDelayMs,
		execTimeoutSeconds: requirePositiveInteger(
			options.execTimeoutSeconds,
			DEFAULT_EXEC_TIMEOUT_SECONDS,
			900,
			"execTimeoutSeconds",
		),
		isRetryable: options.isRetryable ?? (() => true),
		sleepFn: options.sleepFn ?? defaultSleep,
		signal: options.signal,
		onProgress: options.onProgress,
	};
}

/**
 * Read and re-verify the staged manifest file against the caller's manifest
 * and digest. The staged file is authoritative for the uploaded bytes; the
 * caller's digest is authoritative for what those bytes must contain.
 */
function readStagedManifest(
	stagingDir: string,
	manifest: WorkspaceSnapshotManifest,
	manifestDigest: string,
): Uint8Array {
	const manifestPath = join(stagingDir, MANIFEST_FILE_NAME);
	let stats: Stats;
	try {
		stats = statSync(manifestPath);
	} catch {
		throw new WorkspaceTransferError(`staged manifest file is missing: ${manifestPath}`, "staging-error");
	}
	if (!stats.isFile()) {
		throw new WorkspaceTransferError(`staged manifest is not a regular file: ${manifestPath}`, "staging-error");
	}
	if (stats.size > MAX_MANIFEST_UPLOAD_BYTES) {
		throw new WorkspaceTransferError(
			`staged manifest exceeds the ${MAX_MANIFEST_UPLOAD_BYTES} byte upload cap`,
			"staging-error",
		);
	}
	let text: string;
	try {
		text = readFileSync(manifestPath, "utf8");
	} catch (error) {
		throw new WorkspaceTransferError(`failed to read the staged manifest: ${manifestPath}`, "staging-error", {
			cause: error,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new WorkspaceTransferError("staged manifest file is not valid JSON", "invalid-manifest", { cause: error });
	}
	if (!isRecord(parsed) || !isRecord(parsed.manifest) || !isRecord(parsed.provenance)) {
		throw new WorkspaceTransferError("staged manifest file must hold a manifest and provenance", "invalid-manifest");
	}
	const manifestFileProblem = workspaceManifestProblem(parsed.manifest);
	if (manifestFileProblem !== undefined) {
		throw new WorkspaceTransferError(`staged manifest is invalid: ${manifestFileProblem}`, "invalid-manifest");
	}
	const stagedManifest = parsed.manifest as unknown as WorkspaceSnapshotManifest;
	if (digestWorkspaceManifest(stagedManifest) !== manifestDigest) {
		throw new WorkspaceTransferError(
			"staged manifest digest does not match the snapshot digest; the staging directory is not the captured snapshot",
			"invalid-manifest",
		);
	}
	if (canonicalizeWorkspaceManifest(stagedManifest) !== canonicalizeWorkspaceManifest(manifest)) {
		throw new WorkspaceTransferError(
			"staged manifest does not match the caller-provided manifest",
			"invalid-manifest",
		);
	}
	if (parsed.provenance.manifestDigest !== manifestDigest) {
		throw new WorkspaceTransferError("staged manifest provenance digest mismatch", "invalid-manifest");
	}
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength > MAX_MANIFEST_UPLOAD_BYTES) {
		throw new WorkspaceTransferError("staged manifest exceeds the upload cap", "staging-error");
	}
	return bytes;
}

/** Read one staged file, re-verifying type, size, and content hash. */
function readStagedFile(stagingDir: string, entry: WorkspaceSnapshotEntry): Uint8Array {
	const stagedPath = join(stagingDir, WORKSPACE_DIR_NAME, ...entry.path.split("/"));
	let stats: Stats;
	try {
		stats = statSync(stagedPath);
	} catch (error) {
		throw new WorkspaceTransferError(`staged file is unreadable: ${entry.path}`, "staging-error", { cause: error });
	}
	if (!stats.isFile()) {
		throw new WorkspaceTransferError(`staged entry is not a regular file: ${entry.path}`, "staging-error");
	}
	if (stats.size !== entry.size) {
		throw new WorkspaceTransferError(
			`staged file size mismatch: ${entry.path} staged ${stats.size} != manifest ${entry.size}`,
			"staging-error",
		);
	}
	if (stats.size > MAX_UPLOAD_FILE_BYTES) {
		throw new WorkspaceTransferError(
			`staged file exceeds the ${MAX_UPLOAD_FILE_BYTES} byte upload cap: ${entry.path}`,
			"staging-error",
		);
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(stagedPath);
	} catch (error) {
		throw new WorkspaceTransferError(`failed to read staged file: ${entry.path}`, "staging-error", { cause: error });
	}
	if (bytes.byteLength !== entry.size) {
		throw new WorkspaceTransferError(`staged file size mismatch: ${entry.path}`, "staging-error");
	}
	if (sha256Hex(bytes) !== entry.sha256) {
		throw new WorkspaceTransferError(`staged file hash mismatch: ${entry.path}`, "staging-error");
	}
	return bytes;
}

/** Verify one staged symlink still records the manifest's target. */
function verifyStagedSymlink(stagingDir: string, entry: WorkspaceSnapshotEntry): void {
	const stagedPath = join(stagingDir, WORKSPACE_DIR_NAME, ...entry.path.split("/"));
	let stats: Stats;
	try {
		stats = lstatSync(stagedPath);
	} catch (error) {
		throw new WorkspaceTransferError(`staged symlink is unreadable: ${entry.path}`, "staging-error", {
			cause: error,
		});
	}
	if (!stats.isSymbolicLink()) {
		throw new WorkspaceTransferError(`staged entry is not a symlink: ${entry.path}`, "staging-error");
	}
	let target: string;
	try {
		target = readlinkSync(stagedPath);
	} catch (error) {
		throw new WorkspaceTransferError(`failed to read staged symlink: ${entry.path}`, "staging-error", {
			cause: error,
		});
	}
	if (target !== entry.target) {
		throw new WorkspaceTransferError(`staged symlink target mismatch: ${entry.path}`, "staging-error");
	}
}

/** Parent directory of a repo-relative path, or "" for the workspace root. */
function parentOf(relPath: string): string {
	const components = relPath.split("/");
	components.pop();
	return components.join("/");
}

/**
 * Upload a captured workspace snapshot into a remote sandbox directory.
 *
 * The staged manifest is validated first, every remote directory is created
 * with `mkdir -p` through the argv seam, files are uploaded with bounded
 * concurrency and per-operation retries (re-hashed against the manifest right
 * before each upload), symlinks are reconstructed from their recorded
 * relative targets with `ln -sfn`, executable files get `chmod 755`, and the
 * manifest is uploaded last so its presence marks a complete transfer.
 */
export async function transferWorkspaceSnapshot(
	source: WorkspaceTransferSource,
	options: WorkspaceTransferOptions,
): Promise<WorkspaceTransferResult> {
	if (!isRecord(source) || typeof source.stagingDir !== "string" || source.stagingDir === "") {
		throw new WorkspaceTransferError("source.stagingDir must be a non-empty string", "invalid-options");
	}
	if (typeof source.manifestDigest !== "string" || !SHA256_PATTERN.test(source.manifestDigest)) {
		throw new WorkspaceTransferError("source.manifestDigest must be 64 lowercase hex characters", "invalid-options");
	}
	const manifestProblem = workspaceManifestProblem(source.manifest);
	if (manifestProblem !== undefined) {
		throw new WorkspaceTransferError(`snapshot manifest is invalid: ${manifestProblem}`, "invalid-manifest");
	}
	const settings = validateOptions(options);
	throwIfAborted(settings.signal);

	const controller = new AbortController();
	const onExternalAbort = (): void => controller.abort();
	settings.signal?.addEventListener("abort", onExternalAbort, { once: true });

	let firstFailure: unknown;
	let failed = false;
	const fail = (error: unknown): void => {
		if (!failed) {
			failed = true;
			firstFailure = error;
			controller.abort();
		}
	};

	const progress = (event: WorkspaceTransferProgress): void => {
		settings.onProgress?.(event);
	};

	const withAttempts = async <T>(code: WorkspaceTransferErrorCode, op: () => Promise<T>): Promise<T> => {
		for (let attempt = 1; ; attempt++) {
			throwIfAborted(controller.signal);
			try {
				return await op();
			} catch (error) {
				if (error instanceof WorkspaceTransferError) {
					throw error;
				}
				if (attempt >= settings.attempts || !settings.isRetryable(error)) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new WorkspaceTransferError(`${code}: ${reason}`, code, { cause: error });
				}
			}
			throwIfAborted(controller.signal);
			await settings.sleepFn(settings.retryDelayMs);
		}
	};

	const remoteExec = async (argv: readonly string[], label: string): Promise<void> => {
		for (const arg of argv) {
			if (typeof arg !== "string" || arg === "" || arg.includes("\0")) {
				throw new WorkspaceTransferError(`invalid ${label} argv entry`, "invalid-options");
			}
		}
		await withAttempts("remote-command-failed", async () => {
			const result: unknown = await settings.command.exec({
				argv,
				timeoutSeconds: settings.execTimeoutSeconds,
			});
			if (!isRecord(result)) {
				throw new Error(`${label} returned no result object`);
			}
			if (typeof result.exitCode !== "number" || !Number.isInteger(result.exitCode)) {
				throw new Error(`${label} returned a non-integer exit code`);
			}
			if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
				throw new Error(`${label} returned non-string output`);
			}
			if (result.exitCode !== 0) {
				throw new Error(`${label} exited with code ${result.exitCode}: ${bound(result.stderr)}`);
			}
		});
	};

	try {
		const manifestBytes = readStagedManifest(source.stagingDir, source.manifest, source.manifestDigest);
		const entries = source.manifest.entries;

		// Validate every staged entry before the first remote side effect. Files
		// are verified again immediately before upload so a later mutation still
		// fails without publishing the completion manifest.
		for (const entry of entries) {
			if (entry.kind === "file") {
				readStagedFile(source.stagingDir, entry);
			} else {
				verifyStagedSymlink(source.stagingDir, entry);
			}
		}

		// Directories: the mirrored staging roots plus every parent of every
		// entry, pruned to the deepest unique chains (mkdir -p covers the rest).
		const dirSet = new Set<string>([settings.remoteDir, settings.remoteWorkspaceDir]);
		for (const entry of entries) {
			const parent = parentOf(entry.path);
			if (parent !== "") {
				dirSet.add(`${settings.remoteWorkspaceDir}/${parent}`);
			}
		}
		const sortedDirs = [...dirSet].sort(compareStrings);
		const minimalDirs: string[] = [];
		for (let index = 0; index < sortedDirs.length; index++) {
			const dir = sortedDirs[index] as string;
			const next = sortedDirs[index + 1];
			if (next === undefined || !next.startsWith(`${dir}/`)) {
				minimalDirs.push(dir);
			}
		}
		const chunks: string[][] = [];
		let current: string[] = [];
		let chunkBytes = 0;
		for (const dir of minimalDirs) {
			const cost = dir.length + 1;
			if (current.length > 0 && (current.length >= MAX_ARGV_ENTRIES || chunkBytes + cost > MAX_ARGV_BYTES)) {
				chunks.push(current);
				current = [];
				chunkBytes = 0;
			}
			current.push(dir);
			chunkBytes += cost;
		}
		if (current.length > 0) {
			chunks.push(current);
		}
		for (const chunk of chunks) {
			await remoteExec(["mkdir", "-p", ...chunk], "mkdir");
			throwIfAborted(controller.signal);
		}
		progress({ kind: "mkdir", dirs: minimalDirs.length });

		const semaphore = new Semaphore(settings.concurrency);
		const runTask = (work: () => Promise<void>): Promise<void> =>
			(async () => {
				try {
					throwIfAborted(controller.signal);
					await semaphore.run(work, controller.signal);
				} catch (error) {
					fail(error);
				}
			})();

		let uploadedFiles = 0;
		let uploadedSymlinks = 0;
		let uploadedBytes = 0;

		const tasks: Array<Promise<void>> = [];
		for (const entry of entries) {
			const remotePath = `${settings.remoteWorkspaceDir}/${entry.path}`;
			tasks.push(
				runTask(async () => {
					if (entry.kind === "file") {
						const bytes = readStagedFile(source.stagingDir, entry);
						const filename = entry.path.split("/").pop() as string;
						await withAttempts("upload-failed", async () => {
							const result: unknown = await settings.upload.uploadFile({
								path: remotePath,
								filename,
								content: bytes,
							});
							if (!isRecord(result) || typeof result.path !== "string" || typeof result.size !== "number") {
								throw new Error(`upload of ${entry.path} returned a malformed result`);
							}
							if (result.path !== remotePath) {
								throw new Error(`upload of ${entry.path} reported path ${result.path}`);
							}
							if (result.size !== bytes.byteLength) {
								throw new Error(
									`upload of ${entry.path} reported ${result.size} bytes, expected ${bytes.byteLength}`,
								);
							}
						});
						if (entry.executable) {
							await remoteExec(["chmod", "755", remotePath], "chmod");
						}
						uploadedFiles += 1;
						uploadedBytes += bytes.byteLength;
						progress({ kind: "file", path: entry.path, bytes: bytes.byteLength });
						return;
					}
					verifyStagedSymlink(source.stagingDir, entry);
					await remoteExec(["ln", "-sfn", entry.target as string, remotePath], "ln");
					uploadedSymlinks += 1;
					progress({ kind: "symlink", path: entry.path, target: entry.target as string });
				}),
			);
		}
		await Promise.all(tasks);

		if (failed) {
			if (settings.signal?.aborted) {
				throw abortedError();
			}
			throw firstFailure instanceof Error
				? firstFailure
				: new WorkspaceTransferError(String(firstFailure), "upload-failed");
		}

		// The manifest lands last: its presence in the sandbox marks a
		// complete transfer, so a partial upload is always detectable.
		await withAttempts("upload-failed", async () => {
			const result: unknown = await settings.upload.uploadFile({
				path: settings.remoteManifestPath,
				filename: MANIFEST_FILE_NAME,
				content: manifestBytes,
			});
			if (!isRecord(result) || typeof result.path !== "string" || typeof result.size !== "number") {
				throw new Error("manifest upload returned a malformed result");
			}
			if (result.path !== settings.remoteManifestPath) {
				throw new Error(`manifest upload reported path ${result.path}`);
			}
			if (result.size !== manifestBytes.byteLength) {
				throw new Error(`manifest upload reported ${result.size} bytes`);
			}
		});
		uploadedBytes += manifestBytes.byteLength;
		progress({ kind: "manifest", path: MANIFEST_FILE_NAME, bytes: manifestBytes.byteLength });

		return {
			remoteDir: settings.remoteDir,
			remoteWorkspaceDir: settings.remoteWorkspaceDir,
			remoteManifestPath: settings.remoteManifestPath,
			manifestDigest: source.manifestDigest,
			uploadedFiles,
			uploadedSymlinks,
			uploadedBytes,
		};
	} catch (error) {
		if (error instanceof WorkspaceTransferError) {
			throw error;
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkspaceTransferError(`workspace transfer failed: ${reason}`, "upload-failed", { cause: error });
	} finally {
		settings.signal?.removeEventListener("abort", onExternalAbort);
	}
}
