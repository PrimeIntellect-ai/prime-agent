/**
 * Reviewed import of cloud-sandbox results into a local Git working tree.
 *
 * The cloud daemon publishes a result as a baseline-relative unified diff
 * (what the delegated work changed against the submitted snapshot, including
 * pre-existing dirty changes). The local daemon downloads it, persists the
 * patch bytes plus strict metadata in a private result store, and only an
 * explicit apply writes into a repository working tree. Import is always a
 * review flow: list/get/inspect never touch the working tree.
 *
 * Security posture:
 * - The result store is a private directory tree: 0700 directories and 0600
 *   files, and it must live outside the repository an apply targets.
 * - Every record field is validated before it is written and again when it is
 *   read; a malformed record or a patch that does not match its recorded
 *   SHA-256 digest fails closed with its bytes left in place for review.
 * - Metadata carries ids, repo-relative paths, sizes, and digests only - no
 *   credentials, no guest paths, no environment.
 * - Git patches are byte-safe, not UTF-8-safe: raw file bytes in text hunks
 *   round-trip through a latin-1 mapping, so a delegation that touches
 *   non-UTF-8 files still imports and applies its exact patch bytes.
 * - Apply runs git through `spawn` with an args array and `shell: false`;
 *   patch paths are lexically validated to stay inside the repository before
 *   any git process is started, so a patch cannot write outside the repo.
 * - Apply always runs `git apply --check` first; a failed check leaves the
 *   working tree untouched and the result available for re-review. Only
 *   after a clean check does `git apply` run, and a conflicted apply is a
 *   returned outcome, never a thrown crash that hides the attempt.
 * - The apply outcome is recorded durably and atomically in the result
 *   record, so a restart can tell applied results from untouched ones.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, type Dirent, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import { spawnHidden } from "../../utils/child-process.js";
import {
	CLOUD_MAX_ERROR_CHARS,
	CLOUD_MAX_PATH_CHARS,
	CLOUD_MAX_TIMESTAMP_CHARS,
	type CloudSessionId,
	isCloudDigest,
} from "./protocol.js";

/** Version of the result-record format produced by this module. */
export const CLOUD_RESULT_RECORD_VERSION = 1;

export const CLOUD_RESULT_METADATA_FILE_NAME = "metadata.json";
export const CLOUD_RESULT_PATCH_FILE_NAME = "patch.diff";

export const CLOUD_RESULT_MAX_METADATA_BYTES = 1_048_576;
export const CLOUD_RESULT_MAX_PATCH_BYTES = 64 * 1024 * 1024;
export const CLOUD_RESULT_MAX_PATHS = 10_000;

export const CLOUD_RESULT_DIR_MODE = 0o700;
export const CLOUD_RESULT_FILE_MODE = 0o600;

const DEFAULT_GIT_TIMEOUT_MS = 20_000;
const APPLY_INTENT_ERROR = "apply started; recovery must reconcile the working tree";
const MAX_GIT_STDERR_CHARS = 64 * 1024;
const MAX_GIT_STDOUT_BYTES = 1_048_576;

/** Preallocated cloud-session identity (same shape as the session store). */
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Result identity: `res_` plus a URL/filename-safe body. */
const RESULT_ID_PATTERN = /^res_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CLOUD_RESULT_STATES = ["available", "applied"] as const;
export type CloudResultState = (typeof CLOUD_RESULT_STATES)[number];

export function newCloudResultId(): string {
	return `res_${randomUUID()}`;
}

/** One explicit apply attempt, recorded durably in the result record. */
export interface CloudResultApplyAttempt {
	/** When the attempt ran. */
	at: string;
	/** Whether the patch was applied to the working tree. */
	applied: boolean;
	/** Real repository root the apply targeted. */
	repoRoot: string;
	/** Bounded failure detail from the git apply step, present only on failure. */
	error?: string;
}

/** Versioned result record persisted beside the patch at `<sessionId>/<resultId>/metadata.json`. */
export interface CloudResultRecord {
	version: 1;
	/** Cloud session the result belongs to. Immutable. */
	sessionId: CloudSessionId;
	/** Preallocated result identity. Immutable. */
	resultId: string;
	/** SHA-256 digest of the submitted workspace-snapshot manifest (baseline provenance). */
	baselineManifestDigest: string;
	/** SHA-256 digest of the persisted patch bytes. */
	patchDigest: string;
	/** Patch length in bytes. */
	patchSizeBytes: number;
	/** Repo-relative POSIX paths the result manifest lists as changed; sorted, unique. */
	changedPaths: string[];
	/** Repo-relative POSIX paths the result manifest lists as deleted; sorted, unique. */
	deletedPaths: string[];
	/** `available` until an apply succeeds; `applied` is terminal. */
	state: CloudResultState;
	createdAt: string;
	updatedAt: string;
	/** When the patch was applied. Present only after a successful apply. */
	appliedAt?: string;
	/** Latest explicit apply attempt. */
	lastApply?: CloudResultApplyAttempt;
}

/** Input for persisting a downloaded result; ids, paths, and digests are strictly validated. */
export interface CloudResultSaveInput {
	/** Cloud session the result belongs to. */
	sessionId: CloudSessionId;
	/** Preallocated result identity; generated when omitted. */
	resultId?: string;
	/** Baseline-relative unified diff (`git diff` output from the cloud daemon). */
	patch: string;
	/** sha256:<64 hex> digest of the submitted workspace-snapshot manifest. */
	baselineManifestDigest: string;
	/** Repo-relative changed paths listed by the result manifest. */
	changedPaths?: readonly string[];
	/** Repo-relative deleted paths listed by the result manifest. */
	deletedPaths?: readonly string[];
}

export interface CloudResultApplyOptions {
	/** Repository or any directory inside it to apply into. */
	cwd: string;
	/** Timeout for each git command in milliseconds. Default 20000. */
	gitTimeoutMs?: number;
	/** Cooperative cancellation; checked before each git command. */
	signal?: AbortSignal;
}

export type CloudResultApplyResult =
	| { applied: true; record: CloudResultRecord }
	| { applied: false; record: CloudResultRecord; error: string };

export type CloudResultStoreErrorCode = "invalid" | "not_found" | "conflict" | "corrupt" | "git-failed";

export class CloudResultStoreError extends Error {
	readonly code: CloudResultStoreErrorCode;

	constructor(code: CloudResultStoreErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options && options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "CloudResultStoreError";
		this.code = code;
	}
}

const RECORD_FIELDS = [
	"version",
	"sessionId",
	"resultId",
	"baselineManifestDigest",
	"patchDigest",
	"patchSizeBytes",
	"changedPaths",
	"deletedPaths",
	"state",
	"createdAt",
	"updatedAt",
	"appliedAt",
	"lastApply",
] as const;

const ATTEMPT_FIELDS = ["at", "applied", "repoRoot", "error"] as const;

/**
 * Patch-byte codec. `git diff` output is not guaranteed UTF-8: text hunks
 * carry raw file bytes, so a delegation that touches any non-UTF-8 text file
 * produces a patch a strict UTF-8 decode rejects. Patch strings in this
 * module are latin-1-mapped (one code unit per byte) so bytes round-trip
 * losslessly through persistence, validation, and `git apply` stdin.
 */
const PATCH_BYTE_ENCODING = "latin1";

/** Exact patch bytes behind a store-held patch string. */
export function encodeCloudResultPatch(patch: string): Buffer {
	return Buffer.from(patch, PATCH_BYTE_ENCODING);
}

/** Decode retrieved guest patch bytes into the lossless store string form. */
export function decodeCloudResultPatch(bytes: Uint8Array): string {
	if (bytes.byteLength > CLOUD_RESULT_MAX_PATCH_BYTES) {
		throw new Error(`cloud patch exceeds ${CLOUD_RESULT_MAX_PATCH_BYTES} bytes`);
	}
	return Buffer.from(bytes).toString(PATCH_BYTE_ENCODING);
}

/** SHA-256 digest of the exact patch bytes; recomputed by the store, never taken from the caller. */
export function cloudResultPatchDigest(patch: string): string {
	return `sha256:${createHash("sha256").update(encodeCloudResultPatch(patch)).digest("hex")}`;
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Problem = string | undefined;

function firstProblem(...problems: Problem[]): Problem {
	return problems.find((problem) => problem !== undefined);
}

function expectFields(record: Record<string, unknown>, fields: readonly string[]): Problem {
	for (const key of Object.keys(record)) {
		if (!fields.includes(key)) {
			return `unexpected field: ${key}`;
		}
	}
	return undefined;
}

function expectString(value: unknown, label: string, maxLength: number, minLength = 1): Problem {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		return `${label} must be a string of ${minLength}-${maxLength} characters`;
	}
	return undefined;
}

function expectInteger(value: unknown, label: string, minimum: number, maximum?: number): Problem {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < minimum ||
		value > (maximum ?? Number.MAX_SAFE_INTEGER)
	) {
		return `${label} must be an integer of at least ${minimum}`;
	}
	return undefined;
}

function expectOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): Problem {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		return `${label} must be one of ${allowed.join(", ")}`;
	}
	return undefined;
}

function expectTimestamp(value: unknown, label: string): Problem {
	const base = expectString(value, label, CLOUD_MAX_TIMESTAMP_CHARS);
	if (base !== undefined) {
		return base;
	}
	if (Number.isNaN(Date.parse(value as string))) {
		return `${label} must be an ISO-8601 timestamp`;
	}
	return undefined;
}

function expectSessionId(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
		return `${label} must match ${SESSION_ID_PATTERN.source}`;
	}
	return undefined;
}

function expectResultId(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !RESULT_ID_PATTERN.test(value)) {
		return `${label} must match ${RESULT_ID_PATTERN.source}`;
	}
	return undefined;
}

function expectDigest(value: unknown, label: string): Problem {
	return typeof value === "string" && isCloudDigest(value) ? undefined : `${label} must be a sha256:<64 hex> digest`;
}

/**
 * Repo-relative POSIX path: "/"-separated, never absolute, no "." or ".."
 * components, no NUL, no backslash. Git patch paths are always this shape.
 */
export function isRepoRelativePath(relPath: string): boolean {
	if (relPath.length === 0 || relPath.length > CLOUD_MAX_PATH_CHARS) {
		return false;
	}
	if (isAbsolute(relPath) || relPath.includes("\0") || relPath.includes("\\")) {
		return false;
	}
	const components = relPath.split("/");
	return components.every((component) => component.length > 0 && component !== "." && component !== "..");
}

function repoRelativePathProblem(value: unknown, label: string): Problem {
	if (typeof value !== "string" || !isRepoRelativePath(value)) {
		return `${label} must be a repo-relative POSIX path (no absolute path, ".", "..", NUL, or backslash)`;
	}
	return undefined;
}

function pathsProblem(value: unknown, label: string, requireSorted: boolean): Problem {
	if (!Array.isArray(value)) {
		return `${label} must be an array`;
	}
	if (value.length > CLOUD_RESULT_MAX_PATHS) {
		return `${label} must hold at most ${CLOUD_RESULT_MAX_PATHS} entries`;
	}
	let previous = "";
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		const problem = repoRelativePathProblem(entry, `${label}[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
		const path = entry as string;
		if (requireSorted && index > 0 && compareStrings(previous, path) >= 0) {
			return `${label} must be sorted with no duplicates`;
		}
		previous = path;
	}
	return undefined;
}

function attemptProblem(value: unknown, label: string): Problem {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ATTEMPT_FIELDS),
		expectTimestamp(value.at, `${label}.at`),
		typeof value.applied === "boolean" ? undefined : `${label}.applied must be a boolean`,
		expectString(value.repoRoot, `${label}.repoRoot`, CLOUD_MAX_PATH_CHARS),
		value.error === undefined ? undefined : expectString(value.error, `${label}.error`, CLOUD_MAX_ERROR_CHARS),
	);
}

/** Runtime validation for a persisted result record; undefined means the value is a valid CloudResultRecord. */
export function cloudResultRecordProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "cloud result record must be a JSON object";
	}
	const base = firstProblem(
		expectFields(value, RECORD_FIELDS),
		value.version === CLOUD_RESULT_RECORD_VERSION
			? undefined
			: `record.version must be ${CLOUD_RESULT_RECORD_VERSION}`,
		expectSessionId(value.sessionId, "record.sessionId"),
		expectResultId(value.resultId, "record.resultId"),
		expectDigest(value.baselineManifestDigest, "record.baselineManifestDigest"),
		expectDigest(value.patchDigest, "record.patchDigest"),
		expectInteger(value.patchSizeBytes, "record.patchSizeBytes", 1, CLOUD_RESULT_MAX_PATCH_BYTES),
		pathsProblem(value.changedPaths, "record.changedPaths", true),
		pathsProblem(value.deletedPaths, "record.deletedPaths", true),
		expectOneOf(value.state, "record.state", CLOUD_RESULT_STATES),
		expectTimestamp(value.createdAt, "record.createdAt"),
		expectTimestamp(value.updatedAt, "record.updatedAt"),
		value.appliedAt === undefined ? undefined : expectTimestamp(value.appliedAt, "record.appliedAt"),
		value.lastApply === undefined ? undefined : attemptProblem(value.lastApply, "record.lastApply"),
	);
	if (base !== undefined) {
		return base;
	}
	if (Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string)) {
		return "record.updatedAt must not predate record.createdAt";
	}
	if ((value.state as CloudResultState) === "applied" && value.appliedAt === undefined) {
		return "record.appliedAt must be set once the state is applied";
	}
	if (value.appliedAt !== undefined && (value.state as CloudResultState) !== "applied") {
		return "record.appliedAt is set but the state is not applied";
	}
	if (
		(value.lastApply as CloudResultApplyAttempt | undefined)?.applied === true &&
		(value.state as CloudResultState) !== "applied"
	) {
		return "record.lastApply.applied must not be true while the state is not applied";
	}
	for (const path of value.deletedPaths as string[]) {
		if ((value.changedPaths as string[]).includes(path)) {
			return `record paths must not be both changed and deleted: ${path}`;
		}
	}
	return undefined;
}

/** Runtime validation for a save input; undefined means the input is valid. */
export function cloudResultSaveInputProblem(input: unknown): string | undefined {
	if (!isRecord(input)) {
		return "result input must be an object";
	}
	return firstProblem(
		expectFields(input, ["sessionId", "resultId", "patch", "baselineManifestDigest", "changedPaths", "deletedPaths"]),
		expectSessionId(input.sessionId, "result.sessionId"),
		input.resultId === undefined ? undefined : expectResultId(input.resultId, "result.resultId"),
		typeof input.patch !== "string" || input.patch.length < 1
			? "result.patch must be a non-empty string"
			: encodeCloudResultPatch(input.patch).byteLength > CLOUD_RESULT_MAX_PATCH_BYTES
				? `result.patch must hold at most ${CLOUD_RESULT_MAX_PATCH_BYTES} bytes`
				: undefined,
		expectDigest(input.baselineManifestDigest, "result.baselineManifestDigest"),
		input.changedPaths === undefined ? undefined : pathsProblem(input.changedPaths, "result.changedPaths", false),
		input.deletedPaths === undefined ? undefined : pathsProblem(input.deletedPaths, "result.deletedPaths", false),
	);
}

/**
 * Extract every repository path a baseline-relative `git diff` touches and
 * validate each stays inside the repository. Only `diff --git a/x b/x`
 * headers are trusted for path extraction; quoted paths and headers without
 * matching a/b sides are rejected rather than guessed at.
 */
export function cloudResultPatchPaths(patch: string): string[] {
	const paths = new Set<string>();
	let sawHeader = false;
	for (const rawLine of patch.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.startsWith("diff --git ")) {
			continue;
		}
		sawHeader = true;
		const body = line.slice("diff --git ".length);
		if (body.startsWith('"')) {
			throw new CloudResultStoreError("invalid", "patch uses quoted paths, which are not supported");
		}
		if (!body.startsWith("a/")) {
			throw new CloudResultStoreError("invalid", `malformed diff --git header: ${line}`);
		}
		const rest = body.slice(2);
		let split = rest.indexOf(" b/");
		let path: string | undefined;
		while (split !== -1) {
			const aSide = rest.slice(0, split);
			const bSide = rest.slice(split + 3);
			if (aSide === bSide) {
				path = aSide;
				break;
			}
			split = rest.indexOf(" b/", split + 1);
		}
		if (path === undefined) {
			throw new CloudResultStoreError("invalid", `diff --git header sides disagree: ${line}`);
		}
		if (!isRepoRelativePath(path)) {
			throw new CloudResultStoreError("invalid", `patch path escapes the repository: ${path}`);
		}
		paths.add(path);
	}
	if (!sawHeader) {
		throw new CloudResultStoreError("invalid", "patch contains no diff --git header");
	}
	return [...paths].sort(compareStrings);
}

/**
 * Environment for git child processes. Ambient `GIT_*` variables that could
 * redirect which repository git operates on are removed so apply always
 * reads the repository at the resolved repo root.
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

interface GitRunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Patch bytes piped to git's stdin; omitted means stdin is ignored. */
	stdin?: Uint8Array;
}

interface GitRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run one git command with `shell: false`, an args array, bounded output, and a timeout. */
function runGit(args: readonly string[], cwd: string, options: GitRunOptions): Promise<GitRunResult> {
	return new Promise((resolve, reject) => {
		const proc = spawnHidden("git", ["--no-optional-locks", ...args], {
			cwd,
			shell: false,
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: gitEnv(),
		});

		let stdoutText = "";
		let stderrText = "";
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		let killed = false;

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
			options.signal?.removeEventListener("abort", kill);
		};

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ code, stdout: stdoutText, stderr: stderrText });
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutText.length < MAX_GIT_STDOUT_BYTES) {
				stdoutText += chunk.toString("utf8").slice(0, MAX_GIT_STDOUT_BYTES - stdoutText.length);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrText.length < MAX_GIT_STDERR_CHARS) {
				stderrText += chunk.toString("utf8").slice(0, MAX_GIT_STDERR_CHARS - stderrText.length);
			}
		});
		proc.once("error", fail);
		proc.once("close", (code) => settle(code ?? -1));

		if (options.stdin !== undefined) {
			proc.stdin?.on("error", () => {
				// git exits before reading all stdin when the patch is unusable.
			});
			proc.stdin?.end(options.stdin);
		}

		const onAbort = () => kill();
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

function isInsideDirectory(path: string, directory: string): boolean {
	return path === directory || path.startsWith(directory + sep);
}

function boundedError(prefix: string, stderr: string): string {
	const detail = stderr.trim().slice(0, CLOUD_MAX_ERROR_CHARS);
	return detail.length > 0 ? `${prefix}: ${detail}` : prefix;
}

function requireSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
		throw new CloudResultStoreError(
			"invalid",
			`sessionId must match ${SESSION_ID_PATTERN.source}: ${JSON.stringify(String(sessionId))}`,
		);
	}
}

function requireResultId(resultId: string): void {
	if (typeof resultId !== "string" || !RESULT_ID_PATTERN.test(resultId)) {
		throw new CloudResultStoreError(
			"invalid",
			`resultId must match ${RESULT_ID_PATTERN.source}: ${JSON.stringify(String(resultId))}`,
		);
	}
}

/**
 * Private, durable store of downloaded cloud results.
 *
 * Layout: `<root>/<sessionId>/<resultId>/{patch.diff,metadata.json}` with
 * 0700 directories and 0600 files. One daemon process owns a root; a root
 * that lives inside a repository an apply targets is rejected.
 */
export class CloudResultStore {
	private readonly root: string;
	private readonly applyLocks = new Map<string, Promise<void>>();

	constructor(rootDirectory: string) {
		const resolved = resolve(rootDirectory);
		try {
			mkdirSync(resolved, { recursive: true, mode: CLOUD_RESULT_DIR_MODE });
			chmodSync(resolved, CLOUD_RESULT_DIR_MODE);
			this.root = realpathSync(resolved);
		} catch (error) {
			throw new CloudResultStoreError("invalid", `failed to create the result store at ${resolved}`, {
				cause: error,
			});
		}
	}

	/** Directory the store persists results under (real path, mode 0700). */
	get directory(): string {
		return this.root;
	}

	/**
	 * Persist a downloaded result: patch bytes plus strict metadata, written
	 * atomically (temp file + rename, fsynced) with mode 0600. The patch
	 * digest is recomputed from the bytes, never taken from the caller, and
	 * every manifest path must be a repo-relative path the patch touches.
	 */
	save(input: CloudResultSaveInput): CloudResultRecord {
		const problem = cloudResultSaveInputProblem(input);
		if (problem !== undefined) {
			throw new CloudResultStoreError("invalid", problem);
		}
		const sessionId = input.sessionId;
		const resultId = input.resultId ?? newCloudResultId();
		const resultIdProblem = expectResultId(resultId, "resultId");
		if (resultIdProblem !== undefined) {
			throw new CloudResultStoreError("invalid", resultIdProblem);
		}
		const patch = input.patch;
		const patchPaths = cloudResultPatchPaths(patch);
		const changedPaths = [...new Set(input.changedPaths ?? patchPaths)].sort(compareStrings);
		const deletedPaths = [...new Set(input.deletedPaths ?? [])].sort(compareStrings);
		for (const path of changedPaths) {
			if (!patchPaths.includes(path)) {
				throw new CloudResultStoreError("invalid", `changed path is not touched by the patch: ${path}`);
			}
		}
		for (const path of deletedPaths) {
			if (changedPaths.includes(path)) {
				throw new CloudResultStoreError("invalid", `path is both changed and deleted: ${path}`);
			}
			if (!patchPaths.includes(path)) {
				throw new CloudResultStoreError("invalid", `deleted path is not touched by the patch: ${path}`);
			}
		}
		const now = new Date().toISOString();
		const record: CloudResultRecord = {
			version: CLOUD_RESULT_RECORD_VERSION,
			sessionId,
			resultId,
			baselineManifestDigest: input.baselineManifestDigest,
			patchDigest: cloudResultPatchDigest(patch),
			patchSizeBytes: encodeCloudResultPatch(patch).byteLength,
			changedPaths,
			deletedPaths,
			state: "available",
			createdAt: now,
			updatedAt: now,
		};
		const resultDirectory = this.resultDirectory(sessionId, resultId);
		mkdirSync(resultDirectory, { recursive: true, mode: CLOUD_RESULT_DIR_MODE });
		chmodSync(resultDirectory, CLOUD_RESULT_DIR_MODE);
		const metadataPath = join(resultDirectory, CLOUD_RESULT_METADATA_FILE_NAME);
		if (fileExists(metadataPath)) {
			throw new CloudResultStoreError("conflict", `cloud result already exists: ${sessionId}/${resultId}`);
		}
		writeFileAtomicSync(join(resultDirectory, CLOUD_RESULT_PATCH_FILE_NAME), encodeCloudResultPatch(patch), {
			mode: CLOUD_RESULT_FILE_MODE,
			fsync: true,
		});
		this.persist(record);
		return cloneRecord(record);
	}

	/** Read one record. Unknown results are undefined; malformed results fail closed. */
	get(sessionId: string, resultId: string): CloudResultRecord | undefined {
		requireSessionId(sessionId);
		requireResultId(resultId);
		return this.readRecord(sessionId, resultId);
	}

	/**
	 * Read every record, ordered by creation then ids. An optional sessionId
	 * filters to one session. Malformed results fail closed.
	 */
	list(sessionId?: string): CloudResultRecord[] {
		if (sessionId !== undefined) {
			requireSessionId(sessionId);
		}
		const records: CloudResultRecord[] = [];
		for (const sessionDirectory of this.listStoreDirectories(this.root, SESSION_ID_PATTERN)) {
			if (sessionId !== undefined && sessionDirectory.name !== sessionId) {
				continue;
			}
			for (const resultDirectory of this.listStoreDirectories(sessionDirectory.path, RESULT_ID_PATTERN)) {
				const record = this.readRecord(sessionDirectory.name, resultDirectory.name);
				if (record !== undefined) {
					records.push(record);
				}
			}
		}
		records.sort(
			(a, b) =>
				compareStrings(a.createdAt, b.createdAt) ||
				compareStrings(a.sessionId, b.sessionId) ||
				compareStrings(a.resultId, b.resultId),
		);
		return records;
	}

	/** Full review view: the record plus the persisted patch bytes. */
	inspect(sessionId: string, resultId: string): { record: CloudResultRecord; patch: string } {
		const record = this.get(sessionId, resultId);
		if (record === undefined) {
			throw new CloudResultStoreError("not_found", `unknown cloud result: ${sessionId}/${resultId}`);
		}
		return { record, patch: decodeCloudResultPatch(readFileSync(this.patchPath(sessionId, resultId))) };
	}

	/**
	 * Explicitly apply a result to the Git repository containing `cwd`.
	 *
	 * The repository is resolved with `git rev-parse --show-toplevel`; a
	 * non-git cwd is rejected. The patch paths are validated to stay inside
	 * the repository before any apply attempt. `git apply --check` runs
	 * first; a failed check leaves the working tree untouched, records the
	 * attempt, and returns `applied: false` with the bounded git error.
	 * Only after a clean check does `git apply` write the working tree, and
	 * the outcome is recorded durably and atomically in the record.
	 */
	async apply(sessionId: string, resultId: string, options: CloudResultApplyOptions): Promise<CloudResultApplyResult> {
		const key = `${sessionId}/${resultId}`;
		const previous = this.applyLocks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveLock) => {
			release = resolveLock;
		});
		const queued = previous.then(() => current);
		this.applyLocks.set(key, queued);
		await previous;
		try {
			return await this.applyUnlocked(sessionId, resultId, options);
		} finally {
			release();
			if (this.applyLocks.get(key) === queued) this.applyLocks.delete(key);
		}
	}

	private async applyUnlocked(
		sessionId: string,
		resultId: string,
		options: CloudResultApplyOptions,
	): Promise<CloudResultApplyResult> {
		requireSessionId(sessionId);
		requireResultId(resultId);
		if (typeof options?.cwd !== "string" || options.cwd.length === 0 || options.cwd.length > CLOUD_MAX_PATH_CHARS) {
			throw new CloudResultStoreError("invalid", "apply options must carry a cwd path");
		}
		const gitTimeoutMs =
			options.gitTimeoutMs !== undefined && Number.isInteger(options.gitTimeoutMs) && options.gitTimeoutMs > 0
				? options.gitTimeoutMs
				: DEFAULT_GIT_TIMEOUT_MS;
		const gitOptions: GitRunOptions = { timeoutMs: gitTimeoutMs, signal: options.signal };

		const { record, patch } = this.inspect(sessionId, resultId);
		if (record.state === "applied") {
			throw new CloudResultStoreError(
				"conflict",
				`cloud result ${sessionId}/${resultId} was already applied at ${record.appliedAt}`,
			);
		}
		cloudResultPatchPaths(patch);

		const cwd = resolve(options.cwd);
		if (!isDirectory(cwd)) {
			throw new CloudResultStoreError("invalid", `apply cwd is not a directory: ${cwd}`);
		}
		let toplevel: GitRunResult;
		try {
			toplevel = await runGit(["rev-parse", "--show-toplevel"], cwd, gitOptions);
		} catch (error) {
			throw new CloudResultStoreError("git-failed", `failed to run git in ${cwd}`, { cause: error });
		}
		if (toplevel.code !== 0) {
			throw new CloudResultStoreError(
				"invalid",
				`apply cwd is not inside a Git repository: ${cwd}: ${toplevel.stderr.trim()}`,
			);
		}
		const repoRoot = realpathSync(toplevel.stdout.trim());
		if (isInsideDirectory(this.root, repoRoot)) {
			throw new CloudResultStoreError(
				"conflict",
				`the result store must live outside the repository it applies into: ${this.root}`,
			);
		}

		const recoveringInterruptedApply = record.lastApply?.error === APPLY_INTENT_ERROR;
		const checkResult = await this.runGitApplyStep(["--check"], repoRoot, patch, gitOptions, sessionId, resultId);
		if (!checkResult.ok) {
			if (recoveringInterruptedApply) {
				const reverse = await runGit(["apply", "--whitespace=nowarn", "--check", "--reverse"], repoRoot, {
					...gitOptions,
					stdin: encodeCloudResultPatch(patch),
				});
				if (reverse.code === 0) return { applied: true, record: this.markApplied(sessionId, resultId, repoRoot) };
			}
			// runGitApplyStep already recorded the failed attempt durably.
			return { applied: false, record: this.readRecordChecked(sessionId, resultId), error: checkResult.error };
		}
		this.mutate(sessionId, resultId, (current) => {
			current.lastApply = {
				at: new Date().toISOString(),
				applied: false,
				repoRoot,
				error: APPLY_INTENT_ERROR,
			};
			return true;
		});
		const applyResult = await this.runGitApplyStep([], repoRoot, patch, gitOptions, sessionId, resultId);
		if (!applyResult.ok) {
			const interrupted = this.mutate(sessionId, resultId, (current) => {
				current.lastApply = {
					at: new Date().toISOString(),
					applied: false,
					repoRoot,
					error: APPLY_INTENT_ERROR,
				};
				return true;
			});
			return { applied: false, record: interrupted, error: applyResult.error };
		}

		return { applied: true, record: this.markApplied(sessionId, resultId, repoRoot) };
	}

	private markApplied(sessionId: string, resultId: string, repoRoot: string): CloudResultRecord {
		return this.mutate(sessionId, resultId, (current) => {
			if (current.state === "applied") return false;
			const now = new Date().toISOString();
			current.state = "applied";
			current.appliedAt = now;
			current.lastApply = { at: now, applied: true, repoRoot };
			return true;
		});
	}

	/** One `git apply` step; a failure records the attempt durably and returns its bounded detail. */
	private async runGitApplyStep(
		extraArgs: readonly string[],
		repoRoot: string,
		patch: string,
		gitOptions: GitRunOptions,
		sessionId: string,
		resultId: string,
	): Promise<{ ok: true; result: GitRunResult } | { ok: false; error: string }> {
		let result: GitRunResult;
		try {
			result = await runGit(["apply", "--whitespace=nowarn", ...extraArgs], repoRoot, {
				...gitOptions,
				stdin: encodeCloudResultPatch(patch),
			});
		} catch (error) {
			const detail = `git apply failed to run: ${error instanceof Error ? error.message : String(error)}`;
			this.recordFailedAttempt(sessionId, resultId, repoRoot, detail);
			return { ok: false, error: detail.slice(0, CLOUD_MAX_ERROR_CHARS) };
		}
		if (result.code !== 0) {
			const step = extraArgs.includes("--check") ? "git apply --check failed" : "git apply failed";
			const detail = boundedError(`${step} (exit ${result.code})`, result.stderr);
			this.recordFailedAttempt(sessionId, resultId, repoRoot, detail);
			return { ok: false, error: detail };
		}
		return { ok: true, result };
	}

	private recordFailedAttempt(sessionId: string, resultId: string, repoRoot: string, error: string): void {
		this.mutate(sessionId, resultId, (record) => {
			if (record.state === "applied") {
				// Never erase a successful earlier apply with a later failure.
				return false;
			}
			record.lastApply = {
				at: new Date().toISOString(),
				applied: false,
				repoRoot,
				error: error.slice(0, CLOUD_MAX_ERROR_CHARS),
			};
			return true;
		});
	}

	private readRecordChecked(sessionId: string, resultId: string): CloudResultRecord {
		const record = this.readRecord(sessionId, resultId);
		if (record === undefined) {
			throw new CloudResultStoreError("not_found", `unknown cloud result: ${sessionId}/${resultId}`);
		}
		return record;
	}

	private resultDirectory(sessionId: string, resultId: string): string {
		return join(this.root, sessionId, resultId);
	}

	private patchPath(sessionId: string, resultId: string): string {
		return join(this.resultDirectory(sessionId, resultId), CLOUD_RESULT_PATCH_FILE_NAME);
	}

	private metadataPath(sessionId: string, resultId: string): string {
		return join(this.resultDirectory(sessionId, resultId), CLOUD_RESULT_METADATA_FILE_NAME);
	}

	private listStoreDirectories(directory: string, pattern: RegExp): { name: string; path: string }[] {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
		return entries
			.filter((entry) => entry.isDirectory() && pattern.test(entry.name))
			.map((entry) => ({ name: entry.name, path: join(directory, entry.name) }))
			.sort((a, b) => compareStrings(a.name, b.name));
	}

	/**
	 * Load, validate, and verify one result: the metadata must parse and
	 * validate, its ids must match the location it was found at, and the
	 * patch bytes must match the recorded size and SHA-256 digest. Malformed
	 * or tampered results fail closed with their bytes left in place.
	 */
	private readRecord(sessionId: string, resultId: string): CloudResultRecord | undefined {
		const metadataPath = this.metadataPath(sessionId, resultId);
		if (!fileExists(metadataPath)) {
			return undefined;
		}
		let raw: string;
		try {
			raw = readFileSync(metadataPath, "utf8");
		} catch (error) {
			throw new CloudResultStoreError("corrupt", `failed to read ${metadataPath}`, { cause: error });
		}
		if (Buffer.byteLength(raw) > CLOUD_RESULT_MAX_METADATA_BYTES) {
			throw new CloudResultStoreError(
				"corrupt",
				`cloud result metadata ${metadataPath} exceeds ${CLOUD_RESULT_MAX_METADATA_BYTES} bytes`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new CloudResultStoreError("corrupt", `cloud result metadata ${metadataPath} is not valid JSON`, {
				cause: error,
			});
		}
		const problem = cloudResultRecordProblem(parsed);
		if (problem !== undefined) {
			throw new CloudResultStoreError("corrupt", `cloud result metadata ${metadataPath} is malformed: ${problem}`);
		}
		const record = cloneRecord(parsed as CloudResultRecord);
		if (record.sessionId !== sessionId || record.resultId !== resultId) {
			throw new CloudResultStoreError(
				"corrupt",
				`cloud result metadata ${metadataPath} names session ${record.sessionId}/${record.resultId}, not ${sessionId}/${resultId}`,
			);
		}
		let patch: string;
		try {
			patch = decodeCloudResultPatch(readFileSync(this.patchPath(sessionId, resultId)));
		} catch (error) {
			throw new CloudResultStoreError("corrupt", `cloud result patch is unreadable: ${sessionId}/${resultId}`, {
				cause: error,
			});
		}
		if (encodeCloudResultPatch(patch).byteLength !== record.patchSizeBytes) {
			throw new CloudResultStoreError(
				"corrupt",
				`cloud result patch size does not match the record: ${sessionId}/${resultId}`,
			);
		}
		if (cloudResultPatchDigest(patch) !== record.patchDigest) {
			throw new CloudResultStoreError(
				"corrupt",
				`cloud result patch digest does not match the record: ${sessionId}/${resultId}`,
			);
		}
		return record;
	}

	/** Load, mutate, persist. `apply` returns true when the record changed. */
	private mutate(
		sessionId: string,
		resultId: string,
		apply: (record: CloudResultRecord) => boolean,
	): CloudResultRecord {
		const record = this.readRecordChecked(sessionId, resultId);
		if (apply(record)) {
			record.updatedAt = new Date().toISOString();
			this.persist(record);
		}
		return cloneRecord(record);
	}

	/** Validate and durably persist; metadata writes are atomic, fsynced, and mode 0600. */
	private persist(record: CloudResultRecord): void {
		const problem = cloudResultRecordProblem(record);
		if (problem !== undefined) {
			throw new CloudResultStoreError("invalid", `refusing to persist an invalid cloud result record: ${problem}`);
		}
		const serialized = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(serialized) > CLOUD_RESULT_MAX_METADATA_BYTES) {
			throw new CloudResultStoreError(
				"invalid",
				`serialized cloud result record exceeds ${CLOUD_RESULT_MAX_METADATA_BYTES} bytes`,
			);
		}
		writeFileAtomicSync(this.metadataPath(record.sessionId, record.resultId), serialized, {
			mode: CLOUD_RESULT_FILE_MODE,
			fsync: true,
			fsyncDir: true,
		});
	}
}

function fileExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function cloneRecord(record: CloudResultRecord): CloudResultRecord {
	return JSON.parse(JSON.stringify(record)) as CloudResultRecord;
}
