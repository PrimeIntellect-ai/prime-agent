/**
 * B07 — Portable Git-aware workspace manifest/snapshot with safe hash-based sync-back.
 *
 * All file content is base64-encoded in wire formats. Hashes are computed from
 * decoded (raw) bytes — never from the base64 string.
 *
 * Credential paths always excluded at capture AND at apply.
 * change/delete require path in base manifest with matching hash.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globSync } from "glob";
import ignore from "ignore";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 500 * 1024 * 1024;
export const MAX_FILE_COUNT = 100_000;
/** Maximum decoded bytes that a single base64 string can produce. */
const MAX_BASE64_DECODED_BYTES = MAX_FILE_SIZE_BYTES;
/** Maximum length of the base64-encoded string itself (50 MiB + padding overhead). */
export const MAX_BASE64_STRING_LENGTH = Math.ceil((MAX_BASE64_DECODED_BYTES * 4) / 3) + 4;

// ---------------------------------------------------------------------------
// Types — wire-safe: arrays replace mutable dict-like maps
// ---------------------------------------------------------------------------

export interface WorkspaceEntry {
	/** Relative path (forward-slash, posix). */
	path: string;
	/** Hex-encoded SHA-256 digest of the raw file content. */
	hash: string;
	/** Unix file mode (e.g. "100644" or "100755"), safe bits only (0o777 mask). */
	mode: string;
}

/** Entry in a snapshot-payload file list. */
export interface SnapshotFileEntry {
	path: string;
	/** Base64-encoded raw file content. */
	contentBase64: string;
}

export interface WorkspaceManifest {
	entries: WorkspaceEntry[];
	generatedAt: string;
	gitCommit?: string;
	gitBranch?: string;
}

export interface SnapshotPayload {
	manifest: WorkspaceManifest;
	/** Ordered array of file entries (avoids prototype pollution of Record). */
	files: SnapshotFileEntry[];
}

export interface SyncChange {
	type: "add" | "change" | "delete";
	path: string;
	/** baseHash REQUIRED for change and delete; forbidden on add. */
	baseHash?: string;
	/** Base64-encoded raw content. Required for add & change. Empty = valid (empty file). */
	contentBase64?: string;
}

export interface SyncConflict {
	path: string;
	baseHash: string;
	localHash: string;
	remoteHash: string;
}

export interface SyncResult {
	applied: Array<{ path: string; type: string }>;
	conflicts: SyncConflict[];
	errors: Array<{ path: string; message: string }>;
}

/** Full changeset for wire transmission. */
export interface ChangesetPayload {
	changes: SyncChange[];
	snapshot: WorkspaceManifest;
}

// ---------------------------------------------------------------------------
// Credential patterns
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: readonly string[] = [
	".env",
	".env.*",
	"**/.env",
	"**/.env.*",
	".envrc",
	".envrc.*",
	"**/.envrc",
	"*.pem",
	"**/*.pem",
	"*.cert",
	"**/*.cert",
	"*.key",
	"**/*.key",
	"credentials",
	"**/credentials",
	".credentials",
	"**/.credentials",
	"credentials.json",
	"**/credentials.json",
	"service-account.json",
	"**/service-account.json",
	"service-account-key.json",
	"**/service-account-key.json",
	"*.service-account.json",
	"**/*.service-account.json",
	"secrets",
	"**/secrets",
	".secrets",
	"**/.secrets",
	".ssh/**",
	"**/.ssh/**",
	".aws/**",
	"**/.aws/**",
	".gnupg/**",
	"**/.gnupg/**",
	".config/gcloud/**",
	"**/.config/gcloud/**",
	".config/**/credentials",
	".config/**/credential",
	".config/**/token",
	".prime/**",
	"**/.prime/**",
	"*.token",
	"**/*.token",
	".npmrc",
	"**/.npmrc",
	".pypirc",
	"**/.pypirc",
	".netrc",
	"**/.netrc",
	".docker/config.json",
	"**/.docker/config.json",
	".docker/**/config.json",
];

function buildCredentialFilter(): ReturnType<typeof ignore> {
	return ignore().add([...CREDENTIAL_PATTERNS]);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const PATH_CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F]/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SAFE_MODE_RE = /^100(?:644|755)$/; // only 100644 or 100755 are valid

/** Maximum safe mode: strip setuid/setgid/sticky and other special bits. */
const MODE_FILE_MASK = 0o777;

function rejectDangerousPath(relPath: string): void {
	if (isAbsolute(relPath)) {
		throw new Error(`Absolute path rejected: ${relPath}`);
	}
	if (PATH_CONTROL_RE.test(relPath)) {
		throw new Error(`Control characters in path rejected: ${JSON.stringify(relPath)}`);
	}
	// Reject backslashes — portable paths use forward slashes only.
	if (relPath.includes("\\")) {
		throw new Error(`Backslash in path rejected: ${JSON.stringify(relPath)}`);
	}
	const parts = relPath.split("/");
	for (const part of parts) {
		if (part === "..") {
			throw new Error(`Path traversal rejected: ${relPath}`);
		}
	}
}

function assertNoTraversal(parentPath: string, childPath: string): void {
	const rel = relative(parentPath, childPath);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path traversal blocked: ${childPath} is not under ${parentPath}`);
	}
}

function assertNoSymlinkOnPath(root: string, relPath: string): void {
	const parts = relPath.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const candidate = join(root, ...parts.slice(0, i));
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(candidate);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) {
			throw new Error(`Symlink on path (component or leaf): ${candidate}`);
		}
	}
}

function validateManifestEntries(entries: WorkspaceEntry[]): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.path)) {
			throw new Error(`Duplicate manifest path: ${entry.path}`);
		}
		seen.add(entry.path);
		rejectDangerousPath(entry.path);
		if (!SHA256_HEX_RE.test(entry.hash)) {
			throw new Error(`Invalid SHA-256 hash for ${entry.path}: ${entry.hash}`);
		}
		// Validate mode: must be a regular-file mode with safe bits only
		if (!SAFE_MODE_RE.test(entry.mode)) {
			throw new Error(`Invalid mode for ${entry.path}: ${entry.mode}. Only 100644 and 100755 are allowed.`);
		}
	}
}

/** Bound base64 string length before decoding to limit memory. */
function validateContentBase64(contentBase64: string, label: string): Buffer {
	if (contentBase64.length > MAX_BASE64_STRING_LENGTH) {
		throw new Error(
			`Base64 content exceeds maximum encoded length (${MAX_BASE64_STRING_LENGTH} chars) for ${label}: ` +
				`${contentBase64.length} chars received`,
		);
	}
	let buf: Buffer;
	try {
		buf = Buffer.from(contentBase64, "base64");
	} catch {
		throw new Error(`Invalid base64 encoding for ${label}`);
	}
	// Verify canonical encoding (no non-canonical padding or whitespace)
	if (buf.toString("base64") !== contentBase64) {
		throw new Error(`Non-canonical base64 for ${label}`);
	}
	return buf;
}

/** Safe mode: strip all special bits (setuid, setgid, sticky). */
function safeModeBits(mode: number): number {
	return mode & MODE_FILE_MASK;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function hashFile(filePath: string): string {
	return sha256(readFileSync(filePath));
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Compute SHA-256 of base64-decoded (raw) content. */
function hashContentBase64(contentBase64: string): string {
	const buf = Buffer.from(contentBase64, "base64");
	return sha256(buf);
}

/** Check if any executable bit is set. */
function isExecutable(mode: number): boolean {
	return (mode & 0o111) !== 0;
}

/**
 * Base64-decode `contentBase64` and write atomically (temp+rename).
 * `mode` must already be `safeModeBits`-sanitised.
 */
function atomicWriteBase64(targetPath: string, contentBase64: string, mode: number): void {
	const buf = validateContentBase64(contentBase64, targetPath);
	if (buf.length > MAX_FILE_SIZE_BYTES) {
		throw new Error(`Content exceeds max size (${MAX_FILE_SIZE_BYTES} bytes): ${buf.length} bytes`);
	}
	const dir = dirname(targetPath);
	const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
	try {
		writeFileSync(tmp, buf, { mode: safeModeBits(mode) });
		renameSync(tmp, targetPath);
	} catch (err) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			/* best effort */
		}
		throw err;
	}
	// Ensure mode sticks after rename (tmp+rename may reset on some filesystems)
	try {
		chmodSync(targetPath, safeModeBits(mode));
	} catch {
		/* best effort */
	}
}

// ---------------------------------------------------------------------------
// Workspace file discovery
// ---------------------------------------------------------------------------

export interface CaptureManifestOptions {
	extraIgnorePatterns?: string[];
}

function listWorkspaceFiles(gitRoot: string): string[] {
	try {
		const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: gitRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (r.status === 0) {
			const files = r.stdout.split("\0").filter(Boolean);
			if (files.length > MAX_FILE_COUNT) {
				throw new Error(`Workspace has ${files.length} tracked files; max ${MAX_FILE_COUNT}. Exclude more paths.`);
			}
			return files;
		}
	} catch {
		/* fall through */
	}
	return listWorkspaceFilesFallback(gitRoot);
}

function listWorkspaceFilesFallback(root: string): string[] {
	const ig = ignore();
	const gitignorePath = join(root, ".gitignore");
	if (existsSync(gitignorePath)) {
		ig.add(readFileSync(gitignorePath, "utf-8"));
	}
	ig.add(".git");

	const allFiles = globSync("**/*", { cwd: root, nodir: true, dot: true });
	const credentialFilter = buildCredentialFilter();
	const result: string[] = [];

	for (const rawPath of allFiles) {
		const posixPath = toPosix(rawPath);
		if (ig.ignores(posixPath) || credentialFilter.ignores(posixPath)) {
			continue;
		}
		result.push(posixPath);
	}
	if (result.length > MAX_FILE_COUNT) {
		throw new Error(`Workspace has ${result.length} files; max ${MAX_FILE_COUNT}. Exclude more paths.`);
	}
	return result.sort();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function captureWorkspaceManifest(
	workspaceRoot: string,
	options: CaptureManifestOptions = {},
): WorkspaceManifest {
	const absRoot = resolve(workspaceRoot);
	if (!existsSync(absRoot)) {
		throw new Error(`Workspace root does not exist: ${absRoot}`);
	}
	// Reject non-directory or symlink workspaceRoot
	const rootStat = lstatSync(absRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Workspace root is not a regular directory: ${absRoot}`);
	}

	const rawFiles = listWorkspaceFiles(absRoot);
	const extraFilter: ReturnType<typeof ignore> | undefined = options.extraIgnorePatterns?.length
		? ignore().add(options.extraIgnorePatterns)
		: undefined;
	const credentialFilter = buildCredentialFilter();
	const entries: WorkspaceEntry[] = [];
	let totalBytes = 0;

	for (const rawPath of rawFiles) {
		const posixPath = toPosix(rawPath);
		const fullPath = join(absRoot, rawPath);
		assertNoTraversal(absRoot, fullPath);
		if (extraFilter?.ignores(posixPath)) continue;
		if (credentialFilter.ignores(posixPath)) continue;

		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(fullPath);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;

		if (st.size > MAX_FILE_SIZE_BYTES) {
			throw new Error(`File exceeds max size (${MAX_FILE_SIZE_BYTES} bytes): ${posixPath} (${st.size} bytes)`);
		}
		totalBytes += st.size;
		if (totalBytes > MAX_SNAPSHOT_BYTES) {
			throw new Error(`Total snapshot content exceeds max (${MAX_SNAPSHOT_BYTES} bytes) at: ${posixPath}`);
		}

		let content: Buffer;
		try {
			content = readFileSync(fullPath);
		} catch {
			continue;
		}

		const fileHash = sha256(content);
		// Strip special bits from mode
		// Normalize to Git-compatible regular-file modes
		const mode = isExecutable(st.mode) ? "100755" : "100644";

		entries.push({ path: posixPath, hash: fileHash, mode });
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));
	validateManifestEntries(entries);

	let gitCommit: string | undefined;
	let gitBranch: string | undefined;
	try {
		const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: absRoot, encoding: "utf-8" });
		if (r.status === 0) gitCommit = r.stdout.trim();
	} catch {
		/* no git */
	}
	try {
		const r = spawnSync("git", ["branch", "--show-current"], { cwd: absRoot, encoding: "utf-8" });
		if (r.status === 0) {
			const o = r.stdout.trim();
			if (o) gitBranch = o;
		}
	} catch {
		/* no git */
	}

	return { entries, generatedAt: new Date().toISOString(), gitCommit, gitBranch };
}

// ---------------------------------------------------------------------------
// Snapshot payload
// ---------------------------------------------------------------------------

export function buildSnapshotPayload(manifest: WorkspaceManifest, workspaceRoot: string): SnapshotPayload {
	validateManifestEntries(manifest.entries);
	const absRoot = resolve(workspaceRoot);
	if (!existsSync(absRoot)) {
		throw new Error(`Workspace root does not exist: ${absRoot}`);
	}
	const rootStat = lstatSync(absRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Workspace root is not a regular directory: ${absRoot}`);
	}
	const files: SnapshotFileEntry[] = [];
	let totalBytes = 0;

	for (const entry of manifest.entries) {
		const fullPath = join(absRoot, entry.path);
		assertNoTraversal(absRoot, fullPath);
		// Reject symlink targets and any symlink parent component
		assertNoSymlinkOnPath(absRoot, entry.path);

		// lstat before read to enforce size/type limits (forged manifest guard)
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(fullPath);
		} catch {
			throw new Error(
				`Cannot stat file for snapshot payload: ${entry.path}. ` +
					"Workspace may have changed since manifest capture.",
			);
		}
		if (!st.isFile()) {
			throw new Error(`Snapshot path is not a regular file: ${entry.path}`);
		}
		if (st.size > MAX_FILE_SIZE_BYTES) {
			throw new Error(
				`Snapshot file exceeds max size (${MAX_FILE_SIZE_BYTES} bytes): ${entry.path} (${st.size} bytes)`,
			);
		}

		let content: Buffer;
		try {
			content = readFileSync(fullPath);
		} catch {
			throw new Error(
				`Cannot read file for snapshot payload: ${entry.path}. ` +
					"Workspace may have changed since manifest capture.",
			);
		}

		// Verify content hash still matches the manifest entry:
		// a file changed between capture and build must be flagged.
		const currentHash = sha256(content);
		if (currentHash !== entry.hash) {
			throw new Error(
				`File hash mismatch for ${entry.path}: manifest hash ${entry.hash} ` +
					`but current content hash is ${currentHash}. File was modified since capture.`,
			);
		}

		totalBytes += content.length;
		if (totalBytes > MAX_SNAPSHOT_BYTES) {
			throw new Error(`Total snapshot content exceeds max (${MAX_SNAPSHOT_BYTES} bytes) at: ${entry.path}`);
		}

		files.push({ path: entry.path, contentBase64: content.toString("base64") });
	}

	return { manifest, files };
}

// ---------------------------------------------------------------------------
// Changeset application
// ---------------------------------------------------------------------------

export interface ApplyChangesetOptions {
	createDirectories?: boolean;
}

export function applyChangeset(
	manifest: WorkspaceManifest,
	changes: SyncChange[],
	workspaceRoot: string,
	options: ApplyChangesetOptions = {},
): SyncResult {
	validateManifestEntries(manifest.entries);

	const absRoot = resolve(workspaceRoot);
	const applied: Array<{ path: string; type: string }> = [];
	const conflicts: SyncConflict[] = [];
	const errors: Array<{ path: string; message: string }> = [];

	if (!existsSync(absRoot)) {
		errors.push({ path: "(workspaceRoot)", message: `Workspace root does not exist: ${absRoot}` });
		return { applied, conflicts, errors };
	}
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(absRoot);
	} catch {
		errors.push({ path: "(workspaceRoot)", message: `Cannot stat workspace root: ${absRoot}` });
		return { applied, conflicts, errors };
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		errors.push({ path: "(workspaceRoot)", message: `Workspace root is not a regular directory: ${absRoot}` });
		return { applied, conflicts, errors };
	}

	// Build lookups from manifest
	const manifestPathToHash = new Map<string, string>();
	const manifestPathToMode = new Map<string, number>();
	const manifestPaths = new Set<string>();
	for (const entry of manifest.entries) {
		manifestPathToHash.set(entry.path, entry.hash);
		manifestPathToMode.set(entry.path, parseInt(entry.mode, 8));
		manifestPaths.add(entry.path);
	}

	const credentialFilter = buildCredentialFilter();

	// Reject duplicate paths in the changeset
	const seenChangePaths = new Set<string>();
	for (const change of changes) {
		if (seenChangePaths.has(change.path)) {
			return {
				applied: [],
				conflicts: [],
				errors: [{ path: change.path, message: `Duplicate change path: ${change.path}` }],
			};
		}
		seenChangePaths.add(change.path);
	}

	let totalAppliedBytes = 0;

	for (const change of changes) {
		try {
			rejectDangerousPath(change.path);

			// Credential exclusion at apply time
			if (credentialFilter.ignores(change.path)) {
				errors.push({ path: change.path, message: `Credential path rejected: ${change.path}` });
				continue;
			}

			const fullPath = join(absRoot, change.path);
			assertNoTraversal(absRoot, fullPath);
			assertNoSymlinkOnPath(absRoot, change.path);

			// Compute current local hash
			let localHash: string | undefined;
			let localMode: number | undefined;
			let fileExists = false;
			try {
				const st = lstatSync(fullPath);
				if (st.isFile()) {
					fileExists = true;
					localHash = hashFile(fullPath);
					localMode = st.mode;
				}
			} catch {
				/* doesn't exist */
			}

			switch (change.type) {
				case "add": {
					if (change.contentBase64 === undefined) {
						errors.push({ path: change.path, message: "add missing contentBase64" });
						continue;
					}
					if (manifestPaths.has(change.path)) {
						errors.push({
							path: change.path,
							message: "add target already in base manifest; use change instead",
						});
						continue;
					}
					if (fileExists) {
						conflicts.push({
							path: change.path,
							baseHash: "",
							localHash: localHash ?? "",
							remoteHash: hashContentBase64(change.contentBase64),
						});
						continue;
					}

					const addBuf = validateContentBase64(change.contentBase64, change.path);
					totalAppliedBytes += addBuf.length;
					if (totalAppliedBytes > MAX_SNAPSHOT_BYTES) {
						errors.push({
							path: change.path,
							message: `Total applied content exceeds max (${MAX_SNAPSHOT_BYTES} bytes)`,
						});
						continue;
					}

					if (options.createDirectories) {
						mkdirSync(dirname(fullPath), { recursive: true });
					}
					atomicWriteBase64(fullPath, change.contentBase64, 0o644);
					applied.push({ path: change.path, type: "add" });
					break;
				}

				case "change": {
					if (change.contentBase64 === undefined) {
						errors.push({ path: change.path, message: "change missing contentBase64" });
						continue;
					}
					if (!manifestPaths.has(change.path)) {
						errors.push({ path: change.path, message: "change target not in base manifest; use add instead" });
						continue;
					}
					if (change.baseHash === undefined) {
						errors.push({ path: change.path, message: "change requires baseHash" });
						continue;
					}
					const mHash = manifestPathToHash.get(change.path);
					if (change.baseHash !== mHash) {
						errors.push({
							path: change.path,
							message: `baseHash ${change.baseHash} does not match manifest hash ${mHash ?? "(none)"}`,
						});
						continue;
					}
					if (!fileExists) {
						errors.push({ path: change.path, message: "File to change does not exist locally" });
						continue;
					}

					const remoteHash = hashContentBase64(change.contentBase64);
					if (localHash !== change.baseHash) {
						conflicts.push({
							path: change.path,
							baseHash: change.baseHash,
							localHash: localHash ?? "",
							remoteHash,
						});
						continue;
					}

					const changeBuf = validateContentBase64(change.contentBase64, change.path);
					totalAppliedBytes += changeBuf.length;
					if (totalAppliedBytes > MAX_SNAPSHOT_BYTES) {
						errors.push({
							path: change.path,
							message: `Total applied content exceeds max (${MAX_SNAPSHOT_BYTES} bytes)`,
						});
						continue;
					}

					const effectiveMode = manifestPathToMode.get(change.path) ?? localMode ?? 0o644;
					if (options.createDirectories) {
						mkdirSync(dirname(fullPath), { recursive: true });
					}
					atomicWriteBase64(fullPath, change.contentBase64, effectiveMode);
					applied.push({ path: change.path, type: "change" });
					break;
				}

				case "delete": {
					if (!manifestPaths.has(change.path)) {
						errors.push({ path: change.path, message: "delete target not in base manifest" });
						continue;
					}
					if (change.baseHash === undefined) {
						errors.push({ path: change.path, message: "delete requires baseHash" });
						continue;
					}
					const mHash = manifestPathToHash.get(change.path);
					if (change.baseHash !== mHash) {
						errors.push({
							path: change.path,
							message: `baseHash ${change.baseHash} does not match manifest hash ${mHash ?? "(none)"}`,
						});
						continue;
					}
					if (!fileExists) {
						applied.push({ path: change.path, type: "delete" });
						continue;
					}
					if (localHash !== change.baseHash) {
						conflicts.push({
							path: change.path,
							baseHash: change.baseHash,
							localHash: localHash ?? "",
							remoteHash: "",
						});
						continue;
					}
					unlinkSync(fullPath);
					applied.push({ path: change.path, type: "delete" });
					break;
				}

				default: {
					// Unknown change type at the untrusted boundary
					throw new Error(`Unknown change type: ${(change as SyncChange).type}`);
				}
			}
		} catch (err) {
			errors.push({
				path: change.path,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { applied, conflicts, errors };
}
