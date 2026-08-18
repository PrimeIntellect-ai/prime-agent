import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appendRotatingLog, getAgentTracesLogPath, getSessionsDir, VERSION } from "../config.js";
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
	| { status: "missing_credentials" }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "too_large"; size: number; maxBytes: number }
	| { status: "failed"; statusCode?: number; message: string };

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

const RETRIABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function retryAfterDelay(response: Response): number | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(Math.ceil(seconds * 1_000), TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS);
	}
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt)
		? Math.min(Math.max(0, retryAt - Date.now()), TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS)
		: undefined;
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
			if (response.status === 429) {
				retryDelayMs = retryAfterDelay(response) ?? TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS;
			} else if (response.status === 503) {
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
	if (fileSize > MAX_TRACE_BYTES) {
		return { status: "too_large", size: fileSize, maxBytes: MAX_TRACE_BYTES };
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
		};
	}

	const responseText = await response.text().catch(() => "");
	const responseData = parseResponseObject(responseText);
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
	private inFlight: Promise<AgentTraceUploadResult> | undefined;
	private flushPromise: Promise<AgentTraceUploadResult | undefined> | undefined;
	private lastUploadStartedAt: number | undefined;
	private lastUploadedSignature: string | undefined;

	constructor(
		private readonly sessionManager: SessionManager,
		private options: AgentTraceUploadInstallOptions,
	) {}

	update(options: AgentTraceUploadInstallOptions): void {
		this.options = options;
	}

	schedule = (): void => {
		this.pending = true;
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		const elapsed = this.lastUploadStartedAt === undefined ? 0 : Date.now() - this.lastUploadStartedAt;
		const throttleDelay =
			this.lastUploadStartedAt === undefined ? 0 : Math.max(0, TRACE_UPLOAD_MIN_INTERVAL_MS - elapsed);
		this.timeout = setTimeout(
			() => {
				this.timeout = undefined;
				void this.flush().catch(() => undefined);
			},
			Math.max(TRACE_UPLOAD_DEBOUNCE_MS, throttleDelay),
		);
	};

	private async getCurrentFileSignature(): Promise<string | undefined> {
		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile) {
			return undefined;
		}
		try {
			const stats = await stat(sessionFile);
			return `${sessionFile}:${stats.size}:${stats.mtimeMs}`;
		} catch {
			return undefined;
		}
	}

	async flush(): Promise<AgentTraceUploadResult | undefined> {
		if (this.flushPromise) {
			const result = await this.flushPromise;
			if (!this.pending) {
				return result;
			}
			return (await this.flush()) ?? result;
		}

		this.flushPromise = this.runFlush();
		try {
			return await this.flushPromise;
		} finally {
			this.flushPromise = undefined;
		}
	}

	private async runFlush(): Promise<AgentTraceUploadResult | undefined> {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		if (this.inFlight) {
			await this.inFlight.catch(() => undefined);
		}
		if (!this.pending) {
			return undefined;
		}

		const signature = await this.getCurrentFileSignature();
		if (signature && signature === this.lastUploadedSignature) {
			this.pending = false;
			return undefined;
		}

		this.pending = false;
		this.lastUploadStartedAt = Date.now();
		this.inFlight = uploadAgentTraceSession({
			...this.options,
			sessionManager: this.sessionManager,
		});
		try {
			const result = await this.inFlight;
			if (result.status === "uploaded" && signature) {
				this.lastUploadedSignature = signature;
			}
			return result;
		} finally {
			this.inFlight = undefined;
		}
	}
}

const traceUploadControllers = new WeakMap<SessionManager, AgentTraceUploadController>();

export function installAgentTraceUpload(sessionManager: SessionManager, options: AgentTraceUploadInstallOptions): void {
	let controller = traceUploadControllers.get(sessionManager);
	if (controller) {
		controller.update(options);
		return;
	}

	controller = new AgentTraceUploadController(sessionManager, options);
	traceUploadControllers.set(sessionManager, controller);
	sessionManager.onPersist(controller.schedule);
}

export async function flushAgentTraceUpload(
	sessionManager: SessionManager,
): Promise<AgentTraceUploadResult | undefined> {
	return traceUploadControllers.get(sessionManager)?.flush();
}
