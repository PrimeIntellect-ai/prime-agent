import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appendRotatingLog, getAgentDir, getAgentTracesLogPath, getSessionsDir, VERSION } from "../config.js";
import { readFirstLineSync } from "../utils/file-lines.js";
import type { AuthStorage } from "./auth-storage.js";
import {
	loadPrimeCliConfig,
	PRIME_AGENT_TRACES_PROVIDER_ID,
	PRIME_INFERENCE_PROVIDER_ID,
	resolvePrimeAgentTracesBaseUrl,
} from "./prime-inference-auth.js";
import { getSessionArtifactsRoot, type SessionHeader, type SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

const MAX_TRACE_BYTES = 20 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TRACE_UPLOAD_DEBOUNCE_MS = 1_000;
const TRACE_UPLOAD_MIN_INTERVAL_MS = 60_000;
const TRACE_UPLOAD_RETRY_BASE_DELAY_MS = 500;
const TRACE_UPLOAD_RETRY_MAX_DELAY_MS = 10_000;
const TRACE_UPLOAD_MAX_RETRIES = 3;
const TRACE_UPLOAD_RETRY_JITTER = 0.2;
const TRACE_PREVIEW_MAX_CHARS = 8_000;
const TRACE_UPLOAD_ALL_CONCURRENCY = 4;
const TRACE_UPLOAD_RATE_LIMIT_REQUESTS = 5;
const TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS = 60_000;
const TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS = 100;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS =
	Math.ceil(TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS / TRACE_UPLOAD_RATE_LIMIT_REQUESTS) + TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS;

export type AgentTraceCredentialSource = "environment" | "stored" | "prime-inference" | "prime-cli";

export interface AgentTraceCredential {
	apiKey: string;
	source: AgentTraceCredentialSource;
	label: string;
}

export type AgentTraceUploadResult =
	| {
			status: "uploaded";
			sessionId: string;
			traceId: string;
			bytesStored: number;
			key?: string;
	  }
	| { status: "disabled" }
	| { status: "unchanged" }
	| { status: "missing_credentials" }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "too_large"; size: number; maxBytes: number }
	| { status: "failed"; statusCode?: number; message: string; retryAfterMs?: number };

export interface AgentTraceUploadOptions {
	sessionFile: string | undefined;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	/** Require the global automatic-sharing opt-in. Set false only for an explicit one-shot upload command. */
	requireEnabled?: boolean;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	reloadConfig?: boolean;
	requestTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface AgentTraceSessionUploadOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionManager: SessionManager;
}

export interface AgentTraceUploadInstallOptions {
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
	/** The session's semantic-edge ledger; registered with the outbox as its own delivery kind. */
	semanticEdgesLedgerPath?: string;
}

export type AgentTracePreviewResult =
	| {
			status: "ready";
			sessionFile: string;
			sessionId: string;
			traceId: string;
			parentSessionId?: string;
			cwd: string;
			size: number;
			maxBytes: number;
			uploadable: boolean;
			endpoint: string;
			gitRepo?: string;
			gitCommit?: string;
			contentPreview: string;
			truncated: boolean;
	  }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "failed"; message: string };

export interface AgentTracePreviewOptions {
	sessionFile: string | undefined;
	baseUrl?: string;
	maxContentChars?: number;
}

export interface AgentTraceUploadAllProgress {
	completed: number;
	total: number;
	sessionFile?: string;
	result?: AgentTraceUploadResult;
}

export interface AgentTraceUploadAllOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionDir?: string;
	concurrency?: number;
	onProgress?: (progress: AgentTraceUploadAllProgress) => void;
}

export interface AgentTraceUploadAllResult {
	total: number;
	uploaded: number;
	failed: number;
	skipped: number;
	bytesStored: number;
	results: Array<{ sessionFile: string; result: AgentTraceUploadResult }>;
}

function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = (error as { cause?: unknown }).cause;
	if (isRecord(cause)) {
		const code = typeof cause.code === "string" ? cause.code : undefined;
		const causeMessage = typeof cause.message === "string" ? cause.message : undefined;
		const detail = code ?? causeMessage;
		if (detail && detail !== error.message) {
			return `${error.message} (${detail})`;
		}
	}
	return error.message;
}

class TraceUploadTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Trace upload timed out after ${timeoutMs}ms`);
		this.name = "TraceUploadTimeoutError";
	}
}

const RETRIABLE_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"ENETDOWN",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

// 429 is deliberately absent: a rate-limited upload is rescheduled by its caller instead of sleeping in-request.
const RETRIABLE_HTTP_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

function isRetriableNetworkError(error: unknown): boolean {
	if (error instanceof TraceUploadTimeoutError) {
		return true;
	}
	if (!(error instanceof Error) || error.name === "AbortError") {
		return false;
	}
	const cause = (error as { cause?: unknown }).cause;
	return isRecord(cause) && typeof cause.code === "string" && RETRIABLE_NETWORK_CODES.has(cause.code);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSessionHeader(value: unknown): value is SessionHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		typeof value.cwd === "string" &&
		(value.parentSession === undefined || typeof value.parentSession === "string")
	);
}

function readSessionHeader(sessionFile: string): SessionHeader | undefined {
	try {
		const firstLine = readFirstLineSync(sessionFile);
		if (!firstLine?.trim()) {
			return undefined;
		}
		const parsed = JSON.parse(firstLine) as unknown;
		return isSessionHeader(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Active-branch git for the indexing headers: walk leaf to root, not the last git_state in
 * file order (which may belong to a sibling branch). */
export function activeGitContext(
	body: string,
	header: SessionHeader,
): { repoUrl?: string; commit?: string } | undefined {
	const byId = new Map<string, { parentId: string | null; type: string; git?: unknown }>();
	let leafId: string | null = null;
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.type === "session" || typeof parsed.id !== "string") continue;
		byId.set(parsed.id, {
			parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
			type: typeof parsed.type === "string" ? parsed.type : "",
			git: parsed.git,
		});
		leafId = parsed.id;
	}

	let current = leafId ? byId.get(leafId) : undefined;
	for (let depth = 0; current && depth < byId.size + 1; depth += 1) {
		if (current.type === "git_state" && isRecord(current.git)) {
			return current.git as { repoUrl?: string; commit?: string };
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return header.git;
}

function resolveParentSessionPath(sessionFile: string, parentSession: string): string {
	return isAbsolute(parentSession) ? parentSession : resolve(dirname(sessionFile), parentSession);
}

function resolveTraceContext(
	sessionFile: string,
	header: SessionHeader,
): { traceId: string; parentSessionId?: string } {
	let traceId = header.id;
	let parentSessionId: string | undefined;
	let currentFile = sessionFile;
	let currentHeader = header;

	for (let depth = 0; depth < 32; depth += 1) {
		if (!currentHeader.parentSession) {
			break;
		}

		const parentPath = resolveParentSessionPath(currentFile, currentHeader.parentSession);
		const parentHeader = readSessionHeader(parentPath);
		if (!parentHeader) {
			break;
		}

		if (depth === 0) {
			parentSessionId = parentHeader.id;
		}
		traceId = parentHeader.id;
		currentFile = parentPath;
		currentHeader = parentHeader;
	}

	return { traceId, parentSessionId };
}

function parseResponseObject(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	const parsed = parseResponseObject(text);
	if (parsed) {
		const error = parsed.error;
		if (isRecord(error)) {
			const message = stringField(error, "message");
			if (message) return message;
		}
		const detail = stringField(parsed, "detail");
		if (detail) return detail;
		const message = stringField(parsed, "message");
		if (message) return message;
	}

	return text.trim();
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutError = new TraceUploadTimeoutError(timeoutMs);
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(timeoutError);
	}, timeoutMs);
	timeout.unref();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) {
			throw timeoutError;
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timeout = setTimeout(finish, ms);
		timeout.unref();
		const onAbort = () => finish();
		function finish() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function traceUploadRetryDelay(retryIndex: number): number {
	const exponentialDelay = Math.min(
		TRACE_UPLOAD_RETRY_MAX_DELAY_MS,
		TRACE_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** retryIndex,
	);
	const jitterMultiplier = 1 - TRACE_UPLOAD_RETRY_JITTER + Math.random() * TRACE_UPLOAD_RETRY_JITTER * 2;
	return Math.max(0, Math.round(exponentialDelay * jitterMultiplier));
}

function retryAfterDelay(response: Response, capMs: number = TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS): number | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(Math.ceil(seconds * 1_000), capMs);
	}
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt) ? Math.min(Math.max(0, retryAt - Date.now()), capMs) : undefined;
}

type BeforeTraceUploadRequest = () => Promise<void>;

async function fetchWithRetry(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
	beforeRequest?: BeforeTraceUploadRequest,
): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		let retryDelayMs: number | undefined;
		try {
			await beforeRequest?.();
			if (signal?.aborted) {
				throw signal.reason ?? new Error("Trace upload cancelled");
			}
			const response = await fetchWithTimeout(fetchFn, url, init, timeoutMs, signal);
			if (attempt >= TRACE_UPLOAD_MAX_RETRIES || !RETRIABLE_HTTP_STATUSES.has(response.status)) {
				return response;
			}
			if (response.status === 503) {
				retryDelayMs = retryAfterDelay(response);
			}
			await response.body?.cancel().catch(() => undefined);
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason ?? error;
			}
			if (attempt >= TRACE_UPLOAD_MAX_RETRIES || !isRetriableNetworkError(error)) {
				throw error;
			}
		}

		await delay(retryDelayMs ?? traceUploadRetryDelay(attempt), signal);
		if (signal?.aborted) {
			throw signal.reason ?? new Error("Trace upload cancelled");
		}
	}
}

function traceContentPreview(body: string, maxChars: number): { content: string; truncated: boolean } {
	if (body.length <= maxChars) {
		return { content: body.trimEnd(), truncated: false };
	}
	const marker = "\n... middle of trace omitted ...\n";
	const available = Math.max(0, maxChars - marker.length);
	const headChars = Math.ceil(available / 2);
	const tailChars = Math.floor(available / 2);
	return {
		content: `${body.slice(0, headChars).trimEnd()}${marker}${body.slice(body.length - tailChars).trimStart()}`,
		truncated: true,
	};
}

export async function previewAgentTraceFile(options: AgentTracePreviewOptions): Promise<AgentTracePreviewResult> {
	if (!options.sessionFile) {
		return { status: "no_session_file" };
	}

	let fileSize: number;
	try {
		const stats = await stat(options.sessionFile);
		if (!stats.isFile()) {
			return { status: "no_session_file" };
		}
		fileSize = stats.size;
	} catch {
		return { status: "no_session_file" };
	}
	if (fileSize === 0) {
		return { status: "empty_session" };
	}

	const header = readSessionHeader(options.sessionFile);
	if (!header) {
		return { status: "invalid_session", message: "Session file is missing a valid session header" };
	}

	let body = "";
	if (fileSize <= MAX_TRACE_BYTES) {
		try {
			body = await readFile(options.sessionFile, "utf8");
		} catch (error) {
			return { status: "failed", message: describeError(error) };
		}
		if (!body.trim()) {
			return { status: "empty_session" };
		}
	}

	const traceContext = resolveTraceContext(options.sessionFile, header);
	const baseUrl = resolvePrimeAgentTracesBaseUrl(options.baseUrl);
	const git = body ? activeGitContext(body, header) : header.git;
	const preview = body
		? traceContentPreview(body, Math.max(256, options.maxContentChars ?? TRACE_PREVIEW_MAX_CHARS))
		: { content: "", truncated: true };
	return {
		status: "ready",
		sessionFile: options.sessionFile,
		sessionId: header.id,
		traceId: traceContext.traceId,
		parentSessionId: traceContext.parentSessionId,
		cwd: header.cwd,
		size: fileSize,
		maxBytes: MAX_TRACE_BYTES,
		uploadable: fileSize <= MAX_TRACE_BYTES,
		endpoint: `${baseUrl}/api/v1/agent-traces/sessions/${encodeURIComponent(header.id)}`,
		gitRepo: git?.repoUrl,
		gitCommit: git?.commit,
		contentPreview: preview.content,
		truncated: preview.truncated,
	};
}

async function findSessionFilesUnder(root: string, files: Set<string>): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = join(root, entry.name);
		if (entry.isDirectory()) {
			await findSessionFilesUnder(entryPath, files);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl") && readSessionHeader(entryPath)) {
			files.add(entryPath);
		}
	}
}

export async function findAgentTraceFiles(sessionDir: string = getSessionsDir()): Promise<string[]> {
	const files = new Set<string>();
	const roots = new Set([resolve(sessionDir), resolve(getSessionArtifactsRoot(sessionDir))]);
	await Promise.all([...roots].map((root) => findSessionFilesUnder(root, files)));
	return [...files].sort();
}

function createTraceUploadAllRequestGate(signal?: AbortSignal): BeforeTraceUploadRequest {
	let nextRequestAt = 0;
	let queue = Promise.resolve();
	return () => {
		const slot = queue.then(async () => {
			const waitMs = Math.max(0, nextRequestAt - Date.now());
			if (waitMs > 0) {
				await delay(waitMs, signal);
			}
			if (!signal?.aborted) {
				nextRequestAt = Date.now() + TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS;
			}
		});
		queue = slot.catch(() => undefined);
		return slot;
	};
}

export async function uploadAllAgentTraces(options: AgentTraceUploadAllOptions): Promise<AgentTraceUploadAllResult> {
	const { sessionDir, concurrency, onProgress, ...uploadOptions } = options;
	const sessionFiles = await findAgentTraceFiles(sessionDir);
	type UploadResultItem = AgentTraceUploadAllResult["results"][number];
	const results: Array<UploadResultItem | undefined> = new Array(sessionFiles.length);
	let cursor = 0;
	let completed = 0;
	const beforeRequest = createTraceUploadAllRequestGate(uploadOptions.signal);
	onProgress?.({ completed, total: sessionFiles.length });

	const worker = async () => {
		while (true) {
			if (uploadOptions.signal?.aborted) {
				return;
			}
			const index = cursor;
			cursor += 1;
			const sessionFile = sessionFiles[index];
			if (!sessionFile) {
				return;
			}
			const result = await uploadAgentTraceFileWithRequestGate(
				{
					...uploadOptions,
					sessionFile,
					reloadConfig: false,
				},
				beforeRequest,
			);
			if (uploadOptions.signal?.aborted && result.status === "failed") {
				return;
			}
			results[index] = { sessionFile, result };
			completed += 1;
			onProgress?.({ completed, total: sessionFiles.length, sessionFile, result });
		}
	};

	const requestedConcurrency = concurrency ?? TRACE_UPLOAD_ALL_CONCURRENCY;
	const normalizedConcurrency =
		Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
			? Math.max(1, Math.floor(requestedConcurrency))
			: TRACE_UPLOAD_ALL_CONCURRENCY;
	const workerCount = Math.min(sessionFiles.length, normalizedConcurrency);
	await Promise.all(Array.from({ length: workerCount }, worker));

	const completedResults = results.filter((item): item is UploadResultItem => item !== undefined);
	let uploaded = 0;
	let failed = 0;
	let bytesStored = 0;
	for (const item of completedResults) {
		if (item.result.status === "uploaded") {
			uploaded += 1;
			bytesStored += item.result.bytesStored;
		} else if (item.result.status === "failed") {
			failed += 1;
		}
	}
	return {
		total: sessionFiles.length,
		uploaded,
		failed,
		skipped: sessionFiles.length - uploaded - failed,
		bytesStored,
		results: completedResults,
	};
}

interface AgentTraceUploadedSignature {
	size: number;
	mtimeMs: number;
}

export const SEMANTIC_EDGES_OUTBOX_KIND = "semantic-edges";

export interface AgentTraceCatchUpResult {
	pruned: number;
	/** Registered semantic-edge ledgers with bytes beyond their cursor; no delivery endpoint exists yet. */
	semanticEdgeLedgersPending: number;
	results: Array<{ sessionFile: string; result: AgentTraceUploadResult }>;
}

function getAgentTraceOutboxDir(): string {
	return join(getAgentDir(), "agent-traces-outbox");
}

// One entry file per session file (keyed by path hash): concurrent writers cannot lose each other's cursors, and a bad read costs only its own entry.
function agentTraceOutboxEntryPath(sessionFile: string): string {
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
	return join(getAgentTraceOutboxDir(), `${key}.json`);
}

function parseOutboxEntry(raw: string):
	| {
			sessionFile: string;
			kind?: string;
			uploaded: AgentTraceUploadedSignature | null;
			uploadedBytes?: number;
	  }
	| undefined {
	const parsed = parseResponseObject(raw);
	if (!parsed || typeof parsed.sessionFile !== "string") {
		return undefined;
	}
	const uploaded =
		typeof parsed.size === "number" && typeof parsed.mtimeMs === "number"
			? { size: parsed.size, mtimeMs: parsed.mtimeMs }
			: null;
	return {
		sessionFile: parsed.sessionFile,
		kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
		uploaded,
		uploadedBytes: typeof parsed.uploadedBytes === "number" ? parsed.uploadedBytes : undefined,
	};
}

/** `undefined` = no usable cursor; `null` = scheduled but never uploaded. */
async function readAgentTraceOutboxEntry(sessionFile: string): Promise<AgentTraceUploadedSignature | null | undefined> {
	let raw: string;
	try {
		raw = await readFile(agentTraceOutboxEntryPath(sessionFile), "utf8");
	} catch {
		return undefined;
	}
	const entry = parseOutboxEntry(raw);
	return entry && entry.sessionFile === sessionFile ? entry.uploaded : undefined;
}

function signatureEquals(a: AgentTraceUploadedSignature | null | undefined, b: AgentTraceUploadedSignature): boolean {
	return a != null && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Session files with a live upload controller in this process; catch-up leaves them to their controller. */
const locallyManagedSessionFiles = new Set<string>();

/** Best-effort and synchronous: upload intent must be on disk the moment the transcript persist returns. */
function markAgentTraceOutboxPendingSync(sessionFile: string, kind?: string): boolean {
	try {
		const entryPath = agentTraceOutboxEntryPath(sessionFile);
		if (existsSync(entryPath)) {
			return true;
		}
		mkdirSync(getAgentTraceOutboxDir(), { recursive: true });
		const tempPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(
			tempPath,
			`${JSON.stringify(kind === undefined ? { sessionFile } : { sessionFile, kind })}\n`,
			"utf8",
		);
		renameSync(tempPath, entryPath);
		return true;
	} catch {
		// A broken agent dir must not break session persists.
		return false;
	}
}

async function recordAgentTraceOutboxUpload(
	sessionFile: string,
	signature: AgentTraceUploadedSignature,
): Promise<void> {
	const entryPath = agentTraceOutboxEntryPath(sessionFile);
	await mkdir(getAgentTraceOutboxDir(), { recursive: true });
	const tempPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify({ sessionFile, ...signature })}\n`, "utf8");
	await rename(tempPath, entryPath);
}

/**
 * Startup catch-up: upload every outbox entry whose file content is ahead of its
 * cursor, and prune entries whose file no longer exists. Runs once per process,
 * in whichever process hosts sessions (the only place trace upload is installed).
 */
export async function catchUpAgentTraceUploads(
	options: Omit<AgentTraceUploadOptions, "sessionFile">,
): Promise<AgentTraceCatchUpResult> {
	const catchUp: AgentTraceCatchUpResult = { pruned: 0, semanticEdgeLedgersPending: 0, results: [] };
	if (options.requireEnabled !== false && !(await getAgentTracesEnabled(options))) {
		return catchUp;
	}
	let entryNames: string[];
	try {
		entryNames = await readdir(getAgentTraceOutboxDir());
	} catch {
		return catchUp;
	}
	const beforeRequest = createTraceUploadAllRequestGate(options.signal);
	for (const entryName of entryNames) {
		if (options.signal?.aborted) {
			break;
		}
		if (!entryName.endsWith(".json")) {
			continue;
		}
		const entryPath = join(getAgentTraceOutboxDir(), entryName);
		let raw: string;
		try {
			raw = await readFile(entryPath, "utf8");
		} catch {
			// Transient read error: keep the entry and retry at the next startup.
			continue;
		}
		const entry = parseOutboxEntry(raw);
		if (!entry) {
			await unlink(entryPath).catch(() => undefined);
			catchUp.pruned += 1;
			continue;
		}
		if (entry.kind === SEMANTIC_EDGES_OUTBOX_KIND) {
			let ledgerStats: Awaited<ReturnType<typeof stat>>;
			try {
				ledgerStats = await stat(entry.sessionFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await unlink(entryPath).catch(() => undefined);
					catchUp.pruned += 1;
				}
				continue;
			}
			if (!ledgerStats.isFile()) {
				await unlink(entryPath).catch(() => undefined);
				catchUp.pruned += 1;
				continue;
			}
			// Append-only byte cursor: a ledger whose size equals its delivered offset has nothing new.
			if (ledgerStats.size === entry.uploadedBytes) {
				continue;
			}
			// No delivery endpoint exists yet (verifiers#2449 consumes edges in-band over ACP
			// metadata; the trace server has no semantic-edges route). The delta and cursor stay
			// untouched so the first real sender delivers the whole backlog.
			catchUp.semanticEdgeLedgersPending += 1;
			continue;
		}
		if (entry.kind !== undefined) {
			// A newer build may register kinds this one cannot deliver; leave their cursors alone.
			continue;
		}
		if (locallyManagedSessionFiles.has(entry.sessionFile)) {
			continue;
		}
		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(entry.sessionFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await unlink(entryPath).catch(() => undefined);
				catchUp.pruned += 1;
			}
			continue;
		}
		if (!stats.isFile()) {
			await unlink(entryPath).catch(() => undefined);
			catchUp.pruned += 1;
			continue;
		}
		if (signatureEquals(entry.uploaded, { size: stats.size, mtimeMs: stats.mtimeMs })) {
			continue;
		}
		const result = await uploadAgentTraceFileWithRequestGate(
			{ ...options, sessionFile: entry.sessionFile, reloadConfig: false },
			beforeRequest,
		);
		catchUp.results.push({ sessionFile: entry.sessionFile, result });
	}
	return catchUp;
}

export async function getPrimeAgentTraceCredential(
	authStorage: AuthStorage,
	options: { reloadAuth?: boolean; configPath?: string } = {},
): Promise<AgentTraceCredential | undefined> {
	const traceEnvKey = stringEnv("PRIME_AGENT_TRACES_API_KEY");
	if (traceEnvKey) {
		return { apiKey: traceEnvKey, source: "environment", label: "PRIME_AGENT_TRACES_API_KEY" };
	}

	if (options.reloadAuth !== false) {
		authStorage.reload();
	}

	const traceKey = await authStorage.getApiKey(PRIME_AGENT_TRACES_PROVIDER_ID, { includeFallback: false });
	if (traceKey) {
		return { apiKey: traceKey, source: "stored", label: "Prime Agent Traces credential" };
	}

	const primeEnvKey = stringEnv("PRIME_API_KEY");
	if (primeEnvKey) {
		return { apiKey: primeEnvKey, source: "environment", label: "PRIME_API_KEY" };
	}

	const primeCredential = authStorage.get(PRIME_INFERENCE_PROVIDER_ID);
	if (primeCredential) {
		const primeKey = await authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID, { includeFallback: false });
		if (primeKey) {
			return { apiKey: primeKey, source: "prime-inference", label: "Prime Inference credential" };
		}
	}

	const primeCliKey = loadPrimeCliConfig(options.configPath).apiKey;
	if (primeCliKey) {
		return { apiKey: primeCliKey, source: "prime-cli", label: "Prime CLI credential" };
	}

	return undefined;
}

async function getAgentTracesEnabled(
	options: Pick<AgentTraceUploadOptions, "reloadConfig" | "settingsManager">,
): Promise<boolean> {
	if (options.reloadConfig !== false) {
		await options.settingsManager.reload().catch(() => undefined);
	}
	return options.settingsManager.getAgentTracesEnabled();
}

async function uploadAgentTraceFileWithRequestGate(
	options: AgentTraceUploadOptions,
	beforeRequest?: BeforeTraceUploadRequest,
): Promise<AgentTraceUploadResult> {
	const result = await performAgentTraceUpload(options, beforeRequest);
	logAgentTraceOutcome(options.sessionFile, result);
	return result;
}

export function uploadAgentTraceFile(options: AgentTraceUploadOptions): Promise<AgentTraceUploadResult> {
	return uploadAgentTraceFileWithRequestGate(options);
}

function logAgentTraceOutcome(sessionFile: string | undefined, result: AgentTraceUploadResult): void {
	let line: string | undefined;
	switch (result.status) {
		case "uploaded":
			line = `uploaded session ${result.sessionId} (${result.bytesStored} bytes)`;
			break;
		case "failed":
			line = `upload failed${result.statusCode ? ` (HTTP ${result.statusCode})` : ""}: ${result.message}`;
			break;
		case "too_large":
			line = `upload skipped: session is ${result.size} bytes (limit ${result.maxBytes})`;
			break;
		case "invalid_session":
			line = `upload skipped: ${result.message}`;
			break;
		case "missing_credentials":
			line = "upload skipped: no Prime credential configured (run /traces login)";
			break;
		default:
			return;
	}
	const suffix = sessionFile ? ` [${sessionFile}]` : "";
	appendRotatingLog(getAgentTracesLogPath(), `[${new Date().toISOString()}] ${line}${suffix}`);
}

async function performAgentTraceUpload(
	options: AgentTraceUploadOptions,
	beforeRequest?: BeforeTraceUploadRequest,
): Promise<AgentTraceUploadResult> {
	const requireEnabled = options.requireEnabled !== false;
	if (requireEnabled && !(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}
	if (!options.sessionFile) {
		return { status: "no_session_file" };
	}

	let signature: AgentTraceUploadedSignature;
	try {
		const stats = await stat(options.sessionFile);
		if (!stats.isFile()) {
			return { status: "no_session_file" };
		}
		signature = { size: stats.size, mtimeMs: stats.mtimeMs };
	} catch {
		return { status: "no_session_file" };
	}
	const fileSize = signature.size;
	if (fileSize === 0) {
		return { status: "empty_session" };
	}
	if (fileSize > MAX_TRACE_BYTES) {
		return { status: "too_large", size: fileSize, maxBytes: MAX_TRACE_BYTES };
	}
	// Cursor invariant: an automatic upload never re-sends a file whose content already matches its uploaded cursor.
	if (requireEnabled && signatureEquals(await readAgentTraceOutboxEntry(options.sessionFile), signature)) {
		return { status: "unchanged" };
	}

	const header = readSessionHeader(options.sessionFile);
	if (!header) {
		return { status: "invalid_session", message: "Session file is missing a valid session header" };
	}

	const credential = await getPrimeAgentTraceCredential(options.authStorage, {
		configPath: options.configPath,
		reloadAuth: options.reloadConfig !== false,
	});
	if (!credential) {
		return { status: "missing_credentials" };
	}

	if (requireEnabled && !(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}

	let body: string;
	try {
		body = await readFile(options.sessionFile, "utf8");
	} catch (error) {
		return { status: "failed", message: describeError(error) };
	}
	if (!body.trim()) {
		return { status: "empty_session" };
	}

	const traceContext = resolveTraceContext(options.sessionFile, header);
	const bodyBytes = Buffer.byteLength(body, "utf8");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.apiKey}`,
		"Content-Type": "application/x-ndjson",
		Accept: "application/json",
		"X-Trace-Id": traceContext.traceId,
		"X-Cwd": header.cwd,
		"X-Agent-Version": VERSION,
	};
	if (traceContext.parentSessionId) {
		headers["X-Parent-Session"] = traceContext.parentSessionId;
	}
	const git = activeGitContext(body, header);
	if (git?.repoUrl) {
		headers["X-Git-Repo"] = git.repoUrl;
	}
	if (git?.commit) {
		headers["X-Git-Commit"] = git.commit;
	}

	if (requireEnabled && !(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}

	const baseUrl = resolvePrimeAgentTracesBaseUrl(options.baseUrl);
	const url = `${baseUrl}/api/v1/agent-traces/sessions/${encodeURIComponent(header.id)}`;
	const fetchFn = options.fetchFn ?? fetch;

	let response: Response;
	try {
		response = await fetchWithRetry(
			fetchFn,
			url,
			{
				method: "PUT",
				headers,
				body,
			},
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			options.signal,
			beforeRequest,
		);
	} catch (error) {
		return { status: "failed", message: describeError(error) };
	}

	if (!response.ok) {
		return {
			status: "failed",
			statusCode: response.status,
			message: await readResponseMessage(response),
			retryAfterMs: retryAfterDelay(response, MAX_TIMER_DELAY_MS),
		};
	}

	const responseText = await response.text().catch(() => "");
	const responseData = parseResponseObject(responseText);
	try {
		await recordAgentTraceOutboxUpload(options.sessionFile, signature);
	} catch (error) {
		return { status: "failed", message: `stored, but recording the upload cursor failed: ${describeError(error)}` };
	}
	return {
		status: "uploaded",
		sessionId: responseData ? (stringField(responseData, "session_id") ?? header.id) : header.id,
		traceId: responseData ? (stringField(responseData, "trace_id") ?? traceContext.traceId) : traceContext.traceId,
		bytesStored: responseData ? (numberField(responseData, "bytes_stored") ?? bodyBytes) : bodyBytes,
		key: responseData ? stringField(responseData, "key") : undefined,
	};
}

export function uploadAgentTraceSession(options: AgentTraceSessionUploadOptions): Promise<AgentTraceUploadResult> {
	return uploadAgentTraceFile({
		...options,
		sessionFile: options.sessionManager.getSessionFile(),
	});
}

class AgentTraceUploadController {
	private timeout: NodeJS.Timeout | undefined;
	private pending = false;
	private inFlight: Promise<void> | undefined;
	private lastUploadStartedAt: number | undefined;
	private notBeforeAt = 0;

	constructor(
		private readonly sessionManager: SessionManager,
		private options: AgentTraceUploadInstallOptions,
	) {}

	update(options: AgentTraceUploadInstallOptions): void {
		this.options = options;
	}

	schedule = (): void => {
		this.pending = true;
		// Intent is consent-gated at persist time: an entry created while sharing
		// is off would turn a later enable into retroactive collection of
		// opted-out sessions. Marking re-runs every persist (existsSync-cheap),
		// so an entry pruned by a racing catch-up is re-registered.
		if (this.options.settingsManager.getAgentTracesEnabled()) {
			const sessionFile = this.sessionManager.getSessionFile();
			if (
				sessionFile &&
				!locallyManagedSessionFiles.has(sessionFile) &&
				markAgentTraceOutboxPendingSync(sessionFile)
			) {
				locallyManagedSessionFiles.add(sessionFile);
			}
			const ledgerPath = this.options.semanticEdgesLedgerPath;
			if (ledgerPath) {
				markAgentTraceOutboxPendingSync(ledgerPath, SEMANTIC_EDGES_OUTBOX_KIND);
			}
		}
		this.arm();
	};

	private arm(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		const elapsed = this.lastUploadStartedAt === undefined ? undefined : Date.now() - this.lastUploadStartedAt;
		const throttleDelay = elapsed === undefined ? 0 : Math.max(0, TRACE_UPLOAD_MIN_INTERVAL_MS - elapsed);
		const notBeforeDelay = Math.max(0, this.notBeforeAt - Date.now());
		this.timeout = setTimeout(
			() => {
				this.timeout = undefined;
				void this.runScheduledUpload();
			},
			Math.max(TRACE_UPLOAD_DEBOUNCE_MS, throttleDelay, notBeforeDelay),
		);
		this.timeout.unref();
	}

	private async runScheduledUpload(): Promise<void> {
		if (this.inFlight) {
			return;
		}
		this.pending = false;
		this.lastUploadStartedAt = Date.now();
		this.inFlight = uploadAgentTraceSession({
			...this.options,
			sessionManager: this.sessionManager,
		}).then(
			(result) => {
				if (result.status === "failed" && isRescheduledUploadFailure(result.statusCode)) {
					this.pending = true;
					if (result.retryAfterMs !== undefined) {
						this.notBeforeAt = Date.now() + result.retryAfterMs;
					}
				}
			},
			() => undefined,
		);
		await this.inFlight;
		this.inFlight = undefined;
		if (this.pending) {
			this.arm();
		}
	}
}

function isRescheduledUploadFailure(statusCode: number | undefined): boolean {
	return statusCode === undefined || statusCode === 429 || RETRIABLE_HTTP_STATUSES.has(statusCode);
}

const traceUploadControllers = new WeakMap<SessionManager, AgentTraceUploadController>();
let catchUpTriggered = false;

export function installAgentTraceUpload(sessionManager: SessionManager, options: AgentTraceUploadInstallOptions): void {
	if (!catchUpTriggered) {
		catchUpTriggered = true;
		void catchUpAgentTraceUploads(options).catch(() => undefined);
	}
	let controller = traceUploadControllers.get(sessionManager);
	if (controller) {
		controller.update(options);
		return;
	}

	controller = new AgentTraceUploadController(sessionManager, options);
	traceUploadControllers.set(sessionManager, controller);
	sessionManager.onPersist(controller.schedule);
}
