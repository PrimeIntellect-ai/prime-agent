import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, linkSync, mkdirSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { appendRotatingLog, getAgentDir, getSessionsDir, VERSION } from "../config.js";
import { readFirstLineSync } from "../utils/file-lines.js";
import {
	MAX_TRACE_BYTES,
	prepareTracePayload,
	resolveTraceKey,
	type TraceFileSignature,
	type TracePayload,
} from "./agent-trace-payload.js";
import type { AuthStorage } from "./auth-storage.js";
import {
	getPrimeCliConfigPath,
	PRIME_AGENT_TRACES_PROVIDER_ID,
	PRIME_INFERENCE_PROVIDER_ID,
	resolvePrimeAgentTracesBaseUrl,
} from "./prime-inference-auth.js";
import { getSessionArtifactsRoot, type SessionHeader, type SessionManager } from "./session-manager.js";
import type { AgentTraceConsent, SettingsManager } from "./settings-manager.js";

const TRACE_PREVIEW_MAX_CHARS = 8_000;
const REQUEST_INTERVAL_MS = 12_100;
const SESSION_INTERVAL_MS = 60_000;
const LEASE_STALE_MS = 30_000;
const RETRY_MAX_MS = 300_000;
const RETRIABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const SEMANTIC_EDGES_OUTBOX_KIND = "semantic-edges";

export type AgentTraceCredentialSource = "environment" | "stored" | "prime-inference" | "prime-cli";
export interface AgentTraceCredential {
	apiKey: string;
	source: AgentTraceCredentialSource;
	label: string;
}

export type AgentTraceUploadResult =
	| { status: "queued"; requestId: string }
	| { status: "disabled" | "no_session_file" | "empty_session" }
	| { status: "failed"; message: string };
export type AgentTraceUploadAllResult = AgentTraceUploadResult;

export interface AgentTraceUploadInstallOptions {
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	agentDir?: string;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
	semanticEdgesLedgerPath?: string;
}
export interface AgentTraceUploadOptions extends AgentTraceUploadInstallOptions {
	sessionFile: string | undefined;
	/** False is reserved for explicit one-shot requests, bound to the accepted file version. */
	requireEnabled?: boolean;
	signal?: AbortSignal;
}
export interface AgentTraceSessionUploadOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionManager: SessionManager;
}
export interface AgentTraceUploadAllOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionDir?: string;
}

function stringEnv(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		if (entry.isFile() && entry.name.endsWith(".jsonl") && (await readSessionHeaderAsync(entryPath))) {
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

export async function getPrimeAgentTraceCredential(
	authStorage: AuthStorage,
	options: { configPath?: string; signal?: AbortSignal } = {},
): Promise<AgentTraceCredential | undefined> {
	const signal = options.signal ?? new AbortController().signal;
	const traceEnv = stringEnv("PRIME_AGENT_TRACES_API_KEY");
	if (traceEnv) return { apiKey: traceEnv, source: "environment", label: "PRIME_AGENT_TRACES_API_KEY" };
	const traceKey = await resolveTraceKey(await authStorage.readApiKeyConfig(PRIME_AGENT_TRACES_PROVIDER_ID), signal);
	if (traceKey) return { apiKey: traceKey, source: "stored", label: "Prime Agent Traces credential" };
	const primeEnv = stringEnv("PRIME_API_KEY");
	if (primeEnv) return { apiKey: primeEnv, source: "environment", label: "PRIME_API_KEY" };
	const primeKey = await resolveTraceKey(await authStorage.readApiKeyConfig(PRIME_INFERENCE_PROVIDER_ID), signal);
	if (primeKey) return { apiKey: primeKey, source: "prime-inference", label: "Prime Inference credential" };
	const config = await readJson<{ api_key?: string }>(
		getPrimeCliConfigPath(options.configPath ?? authStorage.getPrimeCliConfigPath()),
	);
	if (typeof config?.api_key === "string" && config.api_key.trim())
		return { apiKey: config.api_key.trim(), source: "prime-cli", label: "Prime CLI credential" };
	return undefined;
}

type DeliveryState =
	| "queued"
	| "uploading"
	| "retrying"
	| "paused"
	| "failed"
	| "delivered"
	| "cancelled"
	| "superseded";
export type TraceFailure =
	| "network"
	| "timeout"
	| "credentials"
	| "missing_credentials"
	| "http"
	| "snapshot_changed"
	| "invalid_session"
	| "too_large"
	| "empty_session"
	| "no_session_file"
	| "preparation_failed"
	| "settings_unavailable"
	| "invalid_endpoint";
interface DeliveryFailure {
	reason: TraceFailure;
	at: number;
	statusCode?: number;
}
interface TraceJob {
	sessionFile: string;
	kind?: string;
	// The original flat size/mtime cursor remains readable for existing outboxes.
	size?: number;
	mtimeMs?: number;
	state?: DeliveryState;
	requestedAt?: number;
	manual?: { requestId: string; expected: TraceFileSignature; snapshotReady?: boolean };
	uploaded?: TraceFileSignature;
	attempted?: TraceFileSignature;
	attempts?: number;
	nextAttemptAt?: number;
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	failure?: DeliveryFailure;
	lastFailure?: DeliveryFailure;
	pauseReason?: AgentTraceConsent["reason"] | "missing_credentials" | "credentials";
	endpointFingerprint?: string;
	credentialFingerprint?: string;
}
interface TraceBatch {
	kind: "trace-batch";
	requestId: string;
	sessionDir: string;
	requestedAt: number;
	manual: boolean;
	state: "queued" | "delivered" | "cancelled";
}
interface DeliveryCoordinator {
	activeJob?: string;
	nextRequestAt?: number;
	invalidCredential?: string;
	endpointFingerprint?: string;
}
interface DeliveryReceipt {
	signature: TraceFileSignature;
	requestedAt: number;
	deliveredAt: number;
}

function validSignature(value: unknown): value is TraceFileSignature {
	return (
		isRecord(value) &&
		["size", "mtimeMs", "ino", "dev"].every(
			(key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
		)
	);
}
function validEntry(value: TraceJob | TraceBatch): boolean {
	if (value.kind === "trace-batch") {
		const batch = value as TraceBatch;
		return (
			typeof batch.requestId === "string" &&
			!!batch.requestId &&
			typeof batch.sessionDir === "string" &&
			typeof batch.requestedAt === "number" &&
			Number.isFinite(batch.requestedAt) &&
			typeof batch.manual === "boolean"
		);
	}
	if (value.kind !== undefined) return true;
	const job = value as TraceJob;
	if (typeof job.sessionFile !== "string" || !job.sessionFile) return false;
	if (
		job.manual !== undefined &&
		(!isRecord(job.manual) ||
			typeof job.manual.requestId !== "string" ||
			!job.manual.requestId ||
			!validSignature(job.manual.expected) ||
			typeof job.requestedAt !== "number" ||
			!Number.isFinite(job.requestedAt) ||
			(job.manual.snapshotReady !== undefined && typeof job.manual.snapshotReady !== "boolean"))
	)
		return false;
	if (job.uploaded !== undefined && !validSignature(job.uploaded)) return false;
	if (
		job.state !== undefined &&
		!["queued", "uploading", "retrying", "paused", "failed", "delivered", "cancelled", "superseded"].includes(
			job.state,
		)
	)
		return false;
	for (const failure of [job.failure, job.lastFailure]) {
		if (
			failure !== undefined &&
			(!isRecord(failure) ||
				typeof failure.reason !== "string" ||
				!Object.hasOwn(FAILURE_MESSAGES, failure.reason) ||
				typeof failure.at !== "number" ||
				!Number.isFinite(failure.at) ||
				Math.abs(failure.at) > 8.64e15 ||
				(failure.statusCode !== undefined &&
					(typeof failure.statusCode !== "number" || !Number.isInteger(failure.statusCode))))
		)
			return false;
	}
	return [job.nextAttemptAt, job.lastAttemptAt, job.lastSuccessAt, job.requestedAt, job.attempts].every(
		(value) =>
			value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15),
	);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function outboxDir(agentDir = getAgentDir()): string {
	return join(agentDir, "agent-traces-outbox");
}
function jobPath(dir: string, sessionFile: string): string {
	return join(dir, `${digest(sessionFile).slice(0, 32)}.json`);
}
function receiptPath(dir: string, sessionFile: string): string {
	return join(dir, `.delivered-${digest(sessionFile).slice(0, 32)}`);
}
function cancelPath(dir: string, requestId: string): string {
	return join(dir, `.cancel-${digest(requestId)}`);
}
function signature(stats: Stats): TraceFileSignature {
	return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev };
}
function sameSignature(a: TraceFileSignature | undefined, b: TraceFileSignature): boolean {
	return !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}
async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(value) ? (value as T) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}
function ownershipLost(signal?: AbortSignal): boolean {
	return signal?.reason instanceof Error && signal.reason.message === "ownership_lost";
}
async function writeJson(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		if (ownershipLost(signal)) throw signal?.reason;
		await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		if (ownershipLost(signal)) throw signal?.reason;
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

/** Only the tiny registration is synchronous, so a successful transcript persist has durable intent. */
function registerTrace(dir: string, sessionFile: string, kind?: string): boolean {
	const path = jobPath(dir, sessionFile);
	if (existsSync(path)) return true;
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(temp, JSON.stringify({ sessionFile, kind, requestedAt: Date.now(), state: "queued" }), {
			mode: 0o600,
		});
		// An exclusive link cannot overwrite a cursor written by another process.
		try {
			linkSync(temp, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return true;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			/* Best effort registration must not interrupt a session. */
		}
	}
}

function registerCancellation(dir: string, requestId: string, signal?: AbortSignal): void {
	const cancel = () => {
		try {
			writeFileSync(cancelPath(dir, requestId), "cancelled\n", { mode: 0o600 });
		} catch {
			appendRotatingLog(
				join(dirname(dir), "logs", "agent-traces.log"),
				"Trace cancellation could not be recorded. Check agent directory access and retry /traces cancel-all.",
			);
		}
	};
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
}

/** Cancellation is separate from job updates, so an owner cannot overwrite another process's cancellation. */
export async function cancelAgentTraceRequest(requestId: string, agentDir = getAgentDir()): Promise<void> {
	const dir = outboxDir(agentDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(cancelPath(dir, requestId), "cancelled\n", { mode: 0o600 });
}

/** Explicitly cancel every pending one-shot request in this shared agent directory. */
export async function cancelPendingAgentTraceRequests(
	agentDir = getAgentDir(),
): Promise<{ cancelled: number; failed: number }> {
	const dir = outboxDir(agentDir);
	const ids = new Set<string>();
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		if (!name.endsWith(".json")) continue;
		const raw = await readJson<TraceJob | TraceBatch>(join(dir, name)).catch(() => undefined);
		if (!raw || !validEntry(raw)) continue;
		if (raw.kind === "trace-batch") {
			const batch = raw as TraceBatch;
			if (batch.state === "queued") ids.add(batch.requestId);
		} else if (raw.kind === undefined) {
			const job = raw as TraceJob;
			if (job.manual && !["delivered", "cancelled", "superseded", "failed"].includes(job.state ?? ""))
				ids.add(job.manual.requestId);
		}
	}
	let cancelled = 0,
		failed = 0;
	for (const id of ids) {
		try {
			await cancelAgentTraceRequest(id, agentDir);
			cancelled++;
		} catch {
			failed++;
		}
	}
	return { cancelled, failed };
}

export async function uploadAgentTraceFile(options: AgentTraceUploadOptions): Promise<AgentTraceUploadResult> {
	if (!options.sessionFile) return { status: "no_session_file" };
	const dir = outboxDir(options.agentDir);
	try {
		const sessionFile = resolve(options.sessionFile);
		const stats = await stat(sessionFile);
		if (!stats.isFile()) return { status: "no_session_file" };
		if (!stats.size) return { status: "empty_session" };
		const manual = options.requireEnabled === false;
		if (!manual) {
			const header = await readSessionHeaderAsync(sessionFile);
			if (!header || !(await options.settingsManager.readAgentTracesConsent(header.cwd)).enabled)
				return { status: "disabled" };
			if (!registerTrace(dir, sessionFile)) throw new Error("queue_unavailable");
		}
		const requestId = randomUUID();
		if (manual) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			registerCancellation(dir, requestId, options.signal);
			await writeJson(join(dir, `manual-${requestId}.json`), {
				sessionFile,
				state: "queued",
				requestedAt: Date.now(),
				manual: { requestId, expected: signature(stats) },
			} satisfies TraceJob);
		}
		getDeliveryQueue(options).start();
		return { status: "queued", requestId };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "no_session_file" };
		return { status: "failed", message: "Could not save the trace request. Check access to the agent directory." };
	}
}

export function uploadAgentTraceSession(options: AgentTraceSessionUploadOptions): Promise<AgentTraceUploadResult> {
	return uploadAgentTraceFile({ ...options, sessionFile: options.sessionManager.getSessionFile() });
}

/** Persist the request before discovery; neither scanning nor delivery runs on the command's critical path. */
export async function uploadAllAgentTraces(options: AgentTraceUploadAllOptions): Promise<AgentTraceUploadAllResult> {
	const dir = outboxDir(options.agentDir);
	const requestId = randomUUID();
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		registerCancellation(dir, requestId, options.signal);
		await writeJson(join(dir, `batch-${requestId}.json`), {
			kind: "trace-batch",
			requestId,
			sessionDir: resolve(options.sessionDir ?? getSessionsDir()),
			requestedAt: Date.now(),
			manual: options.requireEnabled === false,
			state: "queued",
		} satisfies TraceBatch);
		getDeliveryQueue(options).start();
		return { status: "queued", requestId };
	} catch {
		return { status: "failed", message: "Could not save the trace request. Check access to the agent directory." };
	}
}

async function readSessionHeaderAsync(path: string): Promise<SessionHeader | undefined> {
	try {
		const file = await open(path, "r");
		try {
			const bytes = Buffer.alloc(65_536);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const firstLine = bytes.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
			const parsed: unknown = JSON.parse(firstLine ?? "");
			return isSessionHeader(parsed) ? parsed : undefined;
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
}

function retryAt(attempt: number, response?: Response): number {
	const exponential = Math.min(RETRY_MAX_MS, 1_000 * 2 ** Math.min(attempt - 1, 20));
	const backoff = Math.min(RETRY_MAX_MS, Math.round(exponential * (0.8 + Math.random() * 0.4)));
	const value = response?.headers.get("retry-after");
	const seconds = value?.trim() ? Number(value) : Number.NaN;
	const serverAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1_000 : Date.parse(value ?? "");
	return Math.min(8.64e15, Math.max(Date.now() + backoff, Number.isFinite(serverAt) ? serverAt : 0));
}

function logFailure(job: TraceJob, previous: DeliveryFailure | undefined, agentDir: string): void {
	if (!job.failure || (previous?.reason === job.failure.reason && previous?.statusCode === job.failure.statusCode))
		return;
	// Do not persist arbitrary server/exception messages: either can contain credentials or payload fragments.
	appendRotatingLog(
		join(agentDir, "logs", "agent-traces.log"),
		`[${new Date().toISOString()}] Trace delivery: ${job.failure.reason}${job.failure.statusCode ? ` (HTTP ${job.failure.statusCode})` : ""}. Run /traces status.\n`,
	);
}

export class AgentTraceDeliveryQueue {
	private timer?: NodeJS.Timeout;
	private running?: Promise<void>;
	private controller?: AbortController;
	private stopped = false;
	readonly agentDir: string;
	private readonly dir: string;
	constructor(private options: AgentTraceUploadInstallOptions) {
		this.agentDir = resolve(options.agentDir ?? getAgentDir());
		this.dir = outboxDir(this.agentDir);
	}
	private writeJson(path: string, value: unknown): Promise<void> {
		return writeJson(path, value, this.controller?.signal);
	}
	update(options: AgentTraceUploadInstallOptions): void {
		this.options = options;
	}
	start(): void {
		if (this.timer || this.running) return;
		this.stopped = false;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.runOnce()
				.catch(() => undefined)
				.finally(() => {
					if (!this.stopped) this.start();
				});
		}, 1_000);
		this.timer.unref();
	}
	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.controller?.abort(new Error("stopped"));
	}
	runOnce(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.drainOne().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
	private async drainOne(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const controller = new AbortController();
		this.controller = controller;
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(join(this.dir, ".delivery"), {
				realpath: false,
				retries: 0,
				stale: LEASE_STALE_MS,
				update: 5_000,
				onCompromised: () => controller.abort(new Error("ownership_lost")),
			});
		} catch {
			return;
		}
		try {
			const coordinatorPath = join(this.dir, ".delivery-state");
			const coordinator = (await readJson<DeliveryCoordinator>(coordinatorPath)) ?? {};
			const entries: { path: string; raw: TraceJob | TraceBatch }[] = [];
			for (const name of await readdir(this.dir)) {
				if (!name.endsWith(".json")) continue;
				const path = join(this.dir, name);
				try {
					const raw = await readJson<TraceJob | TraceBatch>(path);
					if (raw && validEntry(raw)) entries.push({ path, raw });
					else await unlink(path).catch(() => undefined);
				} catch {
					/* A broken entry does not block the rest of the queue. */
				}
			}
			const age = (raw: TraceJob | TraceBatch) =>
				("lastAttemptAt" in raw ? raw.lastAttemptAt : undefined) ?? raw.requestedAt ?? 0;
			entries.sort(
				(a, b) => age(a.raw) - age(b.raw) || Number("lastAttemptAt" in a.raw) - Number("lastAttemptAt" in b.raw),
			);
			for (const { path, raw } of entries) {
				if (controller.signal.aborted) return;
				if (raw.kind === "trace-batch") {
					try {
						await this.expandBatch(path, raw as TraceBatch, controller.signal);
					} catch {
						/* Retry this batch without blocking other entries. */
					}
					continue;
				}
				const job = raw as TraceJob;
				if (typeof job.sessionFile !== "string") continue;
				if (job.kind !== undefined) {
					// Semantic-edge and future delivery kinds have separate protocols; preserve their data and cursors.
					if (job.kind === SEMANTIC_EDGES_OUTBOX_KIND) {
						try {
							if (!(await stat(job.sessionFile)).isFile()) await unlink(path);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") await unlink(path).catch(() => undefined);
						}
					}
					continue;
				}
				try {
					if (await this.deliver(path, job, coordinator, controller)) {
						coordinator.activeJob = undefined;
						await this.writeJson(coordinatorPath, coordinator);
						return;
					}
				} catch {
					/* A corrupt/unwritable entry must not starve healthy sessions. */
				}
			}
		} finally {
			this.controller = undefined;
			await release().catch(() => undefined);
		}
	}
	private async expandBatch(path: string, batch: TraceBatch, signal: AbortSignal): Promise<void> {
		if (batch.state !== "queued") return;
		if (existsSync(cancelPath(this.dir, batch.requestId))) {
			batch.state = "cancelled";
			await this.writeJson(path, batch);
			return;
		}
		const files = await findAgentTraceFiles(batch.sessionDir);
		for (const sessionFile of files) {
			if (signal.aborted || existsSync(cancelPath(this.dir, batch.requestId))) return;
			const stats = await stat(sessionFile).catch(() => undefined);
			// A bulk request authorizes only files/versions already present when requested, including after restart.
			if (!stats || Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs) > batch.requestedAt) continue;
			if (!batch.manual) {
				const header = await readSessionHeaderAsync(sessionFile);
				if (header && (await this.options.settingsManager.readAgentTracesConsent(header.cwd)).enabled)
					registerTrace(this.dir, sessionFile);
				continue;
			}
			const childPath = join(this.dir, `manual-${batch.requestId}-${digest(sessionFile).slice(0, 32)}.json`);
			if (existsSync(childPath)) continue;
			await this.writeJson(childPath, {
				sessionFile,
				state: "queued",
				requestedAt: batch.requestedAt,
				manual: { requestId: batch.requestId, expected: signature(stats) },
			} satisfies TraceJob);
		}
		batch.state = "delivered"; // Discovery complete; child entries retain their individual delivery states.
		await this.writeJson(path, batch);
	}
	private async deliver(
		path: string,
		job: TraceJob,
		coordinator: DeliveryCoordinator,
		controller: AbortController,
	): Promise<boolean> {
		if (job.manual && ["delivered", "cancelled", "superseded", "failed"].includes(job.state ?? "")) return false;
		if (job.manual && existsSync(cancelPath(this.dir, job.manual.requestId))) {
			job.state = "cancelled";
			await this.writeJson(path, job);
			await unlink(`${path}.payload`).catch(() => undefined);
			return false;
		}
		let current: TraceFileSignature;
		if (job.manual?.snapshotReady) current = job.manual.expected;
		else {
			const stats = await stat(job.sessionFile).catch(() => undefined);
			if (!stats?.isFile()) {
				if (!job.manual) {
					await unlink(path).catch(() => undefined);
					return false;
				}
				job.state = "failed";
				job.failure = { reason: "no_session_file", at: Date.now() };
				await this.writeJson(path, job);
				return false;
			}
			current = signature(stats);
		}
		if (
			!job.manual &&
			(job.uploaded
				? sameSignature(job.uploaded, current)
				: job.size === current.size && job.mtimeMs === current.mtimeMs)
		)
			return false;
		if (!job.manual && job.attempted && !sameSignature(job.attempted, current) && job.state === "failed") {
			job.state = "queued";
			job.attempts = 0;
			job.nextAttemptAt = undefined;
		}
		const header = job.manual?.snapshotReady ? undefined : await readSessionHeaderAsync(job.sessionFile);
		if (!job.manual) {
			const consent = header ? await this.options.settingsManager.readAgentTracesConsent(header.cwd) : undefined;
			if (!consent?.enabled) {
				const reason = consent?.reason ?? "settings_unavailable";
				if (job.state !== "paused" || job.pauseReason !== reason) {
					job.state = "paused";
					job.pauseReason = reason;
					await this.writeJson(path, job);
				}
				return false;
			}
		}
		if ((job.nextAttemptAt ?? 0) > Date.now() || (coordinator.nextRequestAt ?? 0) > Date.now()) return false;
		if (!job.manual && (job.lastAttemptAt ?? 0) + SESSION_INTERVAL_MS > Date.now()) return false;
		const endpoint = resolvePrimeAgentTracesBaseUrl(this.options.baseUrl);
		const endpointFingerprint = digest(endpoint);
		try {
			const url = new URL(endpoint);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error("invalid_endpoint");
		} catch {
			if (job.failure?.reason !== "invalid_endpoint" || job.endpointFingerprint !== endpointFingerprint) {
				job.state = "failed";
				job.endpointFingerprint = endpointFingerprint;
				job.failure = { reason: "invalid_endpoint", at: Date.now() };
				await this.writeJson(path, job);
			}
			return false;
		}
		if (job.state === "failed" && job.endpointFingerprint === endpointFingerprint) return false;
		job.attempted = current;
		const previousFailure = job.failure;
		const credential = await getPrimeAgentTraceCredential(this.options.authStorage, {
			configPath: this.options.configPath,
			signal: controller.signal,
		}).catch(() => undefined);
		if (controller.signal.aborted) return false;
		const fingerprint = credential ? digest(credential.apiKey) : undefined;
		if (
			!credential ||
			(coordinator.invalidCredential === fingerprint && coordinator.endpointFingerprint === endpointFingerprint)
		) {
			const reason = credential ? "credentials" : "missing_credentials";
			if (job.state !== "paused" || job.pauseReason !== reason) {
				job.state = "paused";
				job.pauseReason = reason;
				job.failure = { reason, at: Date.now() };
				await this.writeJson(path, job);
				logFailure(job, previousFailure, this.agentDir);
			}
			return false;
		}
		job.endpointFingerprint = endpointFingerprint;
		job.credentialFingerprint = fingerprint;
		let authorizationCwd = header?.cwd;
		let revoked = false;
		let cancelled = false;
		const checkAuthorization = async () => {
			if (job.manual) {
				cancelled = existsSync(cancelPath(this.dir, job.manual.requestId));
				if (cancelled) controller.abort(new Error("cancelled"));
			} else {
				const consent = authorizationCwd
					? await this.options.settingsManager.readAgentTracesConsent(authorizationCwd)
					: undefined;
				if (!consent?.enabled) {
					revoked = true;
					job.pauseReason = consent?.reason ?? "settings_unavailable";
					controller.abort(new Error("revoked"));
				}
			}
		};
		await checkAuthorization();
		if (controller.signal.aborted) return false;
		let checking = false;
		const monitor = setInterval(() => {
			if (checking) return;
			checking = true;
			void checkAuthorization()
				.catch(() => {
					revoked = true;
					controller.abort(new Error("consent_unavailable"));
				})
				.finally(() => {
					checking = false;
				});
		}, 250);
		monitor.unref();
		let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		let sent = false;
		try {
			job.attempts = (job.attempts ?? 0) + 1;
			job.lastAttemptAt = Date.now();
			await this.writeJson(path, job);
			const payload = await prepareTracePayload({
				sessionFile: job.sessionFile,
				expected: job.manual?.expected,
				snapshotPath: job.manual ? `${path}.payload` : undefined,
				snapshotReady: job.manual?.snapshotReady,
				signal: controller.signal,
			});
			if (job.manual) job.manual.snapshotReady = true;
			job.attempted = payload.signature;
			const receipt = await readJson<DeliveryReceipt>(receiptPath(this.dir, job.sessionFile));
			if (
				job.manual &&
				receipt &&
				receipt.requestedAt >= (job.requestedAt ?? 0) &&
				!sameSignature(receipt.signature, payload.signature)
			) {
				job.state = "superseded";
				await this.writeJson(path, job);
				await unlink(`${path}.payload`).catch(() => undefined);
				return false;
			}
			// Use the prepared project's consent for all later checks, including the in-flight monitor.
			authorizationCwd = payload.cwd;
			await checkAuthorization();
			controller.signal.throwIfAborted();
			job.state = "uploading";
			job.pauseReason = undefined;
			coordinator.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
			coordinator.activeJob = basename(path);
			// Reserve the shared rate slot durably before dispatch, including when the process crashes.
			await this.writeJson(join(this.dir, ".delivery-state"), coordinator);
			await this.writeJson(path, job);
			await checkAuthorization();
			controller.signal.throwIfAborted();
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort(new Error("timeout"));
			}, this.options.requestTimeoutMs ?? 15_000);
			timeout.unref();
			sent = true;
			const response = await (this.options.fetchFn ?? fetch)(
				`${endpoint}/api/v1/agent-traces/sessions/${encodeURIComponent(payload.sessionId)}`,
				{
					method: "PUT",
					headers: payloadHeaders(payload, credential.apiKey),
					body: payload.body,
					signal: controller.signal,
				},
			);
			controller.signal.throwIfAborted();
			// Delivery requires a successful response, not arbitrary server response content. Never log its body.
			void response.body?.cancel().catch(() => undefined);
			if (response.ok) {
				const deliveredAt = Date.now();
				await this.writeJson(receiptPath(this.dir, job.sessionFile), {
					signature: payload.signature,
					requestedAt: job.manual ? (job.requestedAt ?? deliveredAt) : deliveredAt,
					deliveredAt,
				} satisfies DeliveryReceipt);
				job.uploaded = payload.signature;
				job.size = payload.signature.size;
				job.mtimeMs = payload.signature.mtimeMs;
				job.state = "delivered";
				job.lastSuccessAt = deliveredAt;
				job.failure = undefined;
				job.attempts = 0;
				job.nextAttemptAt = undefined;
				coordinator.invalidCredential = undefined;
			} else {
				const invalid = response.status === 401 || response.status === 403;
				job.failure = { reason: invalid ? "credentials" : "http", at: Date.now(), statusCode: response.status };
				if (invalid) {
					coordinator.invalidCredential = fingerprint;
					coordinator.endpointFingerprint = endpointFingerprint;
					job.state = "paused";
					job.pauseReason = "credentials";
				} else if (RETRIABLE_HTTP_STATUSES.has(response.status)) {
					job.state = "retrying";
					job.nextAttemptAt = retryAt(job.attempts, response);
					// Server-wide overload/rate limits apply to every producer, not just this session.
					coordinator.nextRequestAt = Math.max(coordinator.nextRequestAt ?? 0, job.nextAttemptAt);
				} else {
					job.state = "failed";
				}
			}
		} catch (error) {
			if (cancelled) job.state = "cancelled";
			else if (revoked) job.state = "paused";
			else if (controller.signal.aborted && !timedOut) job.state = "queued";
			else {
				const code = error instanceof Error ? error.message : "preparation_failed";
				const permanent = [
					"snapshot_changed",
					"invalid_session",
					"too_large",
					"empty_session",
					"no_session_file",
				].includes(code);
				job.failure = {
					reason: timedOut
						? "timeout"
						: sent
							? "network"
							: permanent
								? (code as TraceFailure)
								: "preparation_failed",
					at: Date.now(),
				};
				job.state =
					permanent && job.manual ? "failed" : permanent && code !== "snapshot_changed" ? "failed" : "retrying";
				job.nextAttemptAt = retryAt(Math.max(1, job.attempts ?? 1));
			}
		} finally {
			clearInterval(monitor);
			clearTimeout(timeout);
		}
		// A compromised owner must not clobber the replacement owner's progress.
		if (controller.signal.reason instanceof Error && controller.signal.reason.message === "ownership_lost")
			return false;
		if (job.failure) job.lastFailure = job.failure;
		await this.writeJson(path, job);
		logFailure(job, previousFailure, this.agentDir);
		if (job.manual && ["delivered", "cancelled", "superseded", "failed"].includes(job.state ?? ""))
			await unlink(`${path}.payload`).catch(() => undefined);
		return sent;
	}
}

function payloadHeaders(payload: TracePayload, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/x-ndjson",
		Accept: "application/json",
		"X-Trace-Id": payload.traceId,
		"X-Cwd": payload.cwd,
		"X-Agent-Version": VERSION,
	};
	if (payload.parentSessionId) headers["X-Parent-Session"] = payload.parentSessionId;
	if (payload.gitRepo) headers["X-Git-Repo"] = payload.gitRepo;
	if (payload.gitCommit) headers["X-Git-Commit"] = payload.gitCommit;
	return headers;
}

const deliveryQueues = new Map<string, AgentTraceDeliveryQueue>();
function getDeliveryQueue(options: AgentTraceUploadInstallOptions): AgentTraceDeliveryQueue {
	const key = resolve(options.agentDir ?? getAgentDir());
	let queue = deliveryQueues.get(key);
	if (!queue) {
		queue = new AgentTraceDeliveryQueue(options);
		deliveryQueues.set(key, queue);
	} else queue.update(options);
	return queue;
}

/** Stops local timers and requests immediately; pending work remains durable for another process. */
export function stopAgentTraceUploads(agentDir = getAgentDir()): void {
	const key = resolve(agentDir);
	deliveryQueues.get(key)?.stop();
	deliveryQueues.delete(key);
}

export function catchUpAgentTraceUploads(options: AgentTraceUploadInstallOptions): void {
	getDeliveryQueue(options).start();
}
const controllers = new WeakMap<SessionManager, { options: AgentTraceUploadInstallOptions }>();
export function installAgentTraceUpload(sessionManager: SessionManager, options: AgentTraceUploadInstallOptions): void {
	catchUpAgentTraceUploads(options);
	const existing = controllers.get(sessionManager);
	if (existing) {
		existing.options = options;
		return;
	}
	const controller = { options };
	controllers.set(sessionManager, controller);
	sessionManager.onPersist(() => {
		const current = controller.options;
		if (!current.settingsManager.readAgentTracesConsentSync(sessionManager.getCwd()).enabled) return;
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) return;
		const dir = outboxDir(current.agentDir);
		registerTrace(dir, sessionFile);
		if (current.semanticEdgesLedgerPath)
			registerTrace(dir, current.semanticEdgesLedgerPath, SEMANTIC_EDGES_OUTBOX_KIND);
		getDeliveryQueue(current).start();
	});
}

export interface AgentTraceStatus {
	sessionFile: string;
	credentialSource: string;
	consent: AgentTraceConsent;
	endpoint: string;
	pending: number;
	inProgress: number;
	paused: number;
	failed: number;
	discovering: number;
	currentSession: string;
	lastSuccessAt?: number;
	lastFailure?: DeliveryFailure;
	nextAttemptAt?: number;
	pauseReasons: string[];
}

function safeEndpoint(baseUrl?: string): string {
	try {
		const url = new URL(resolvePrimeAgentTracesBaseUrl(baseUrl));
		return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return "Invalid endpoint; check PRIME_AGENT_TRACES_BASE_URL";
	}
}

async function inspectTraceCredential(authStorage: AuthStorage | undefined, configPath?: string): Promise<string> {
	if (stringEnv("PRIME_AGENT_TRACES_API_KEY")) return "PRIME_AGENT_TRACES_API_KEY";
	if (authStorage && (await authStorage.readApiKeyConfig(PRIME_AGENT_TRACES_PROVIDER_ID)))
		return "Prime Agent Traces credential";
	if (stringEnv("PRIME_API_KEY")) return "PRIME_API_KEY";
	if (authStorage && (await authStorage.readApiKeyConfig(PRIME_INFERENCE_PROVIDER_ID)))
		return "Prime Inference credential";
	const config = await readJson<{ api_key?: string }>(
		getPrimeCliConfigPath(configPath ?? authStorage?.getPrimeCliConfigPath()),
	);
	return typeof config?.api_key === "string" && config.api_key.trim() ? "Prime CLI credential" : "Not configured";
}

/** Read-only: never starts delivery, takes a write lock, resolves a credential, or makes a request. */
export async function readAgentTraceStatus(options: {
	settingsManager: SettingsManager;
	authStorage?: AuthStorage;
	configPath?: string;
	sessionFile?: string;
	cwd?: string;
	agentDir?: string;
	baseUrl?: string;
}): Promise<AgentTraceStatus> {
	const dir = outboxDir(options.agentDir);
	const header = options.sessionFile ? await readSessionHeaderAsync(options.sessionFile) : undefined;
	const consent = await options.settingsManager.readAgentTracesConsent(header?.cwd ?? options.cwd ?? process.cwd());
	const result: AgentTraceStatus = {
		sessionFile: options.sessionFile ?? "In-memory",
		credentialSource: await inspectTraceCredential(options.authStorage, options.configPath).catch(
			() => "Unavailable",
		),
		consent,
		endpoint: safeEndpoint(options.baseUrl),
		pending: 0,
		inProgress: 0,
		paused: 0,
		failed: 0,
		discovering: 0,
		currentSession: options.sessionFile ? "Not queued" : "No persisted trace",
		pauseReasons: [],
	};
	const names = await readdir(dir).catch(() => [] as string[]);
	const coordinator = await readJson<DeliveryCoordinator>(join(dir, ".delivery-state")).catch(() => undefined);
	const owned = await lockfile
		.check(join(dir, ".delivery"), { realpath: false, stale: LEASE_STALE_MS })
		.catch(() => false);
	const currentStates: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const raw = await readJson<TraceJob | TraceBatch>(path).catch(() => undefined);
		if (!raw || !validEntry(raw)) continue;
		if (raw.kind === "trace-batch") {
			if (raw.state === "queued") result.discovering += 1;
			continue;
		}
		const job = raw as TraceJob;
		if (job.kind !== undefined || typeof job.sessionFile !== "string") continue;
		const stats = await stat(job.sessionFile).catch(() => undefined);
		if (!stats && !job.manual) continue;
		let state = job.state ?? "queued";
		if (job.manual && existsSync(cancelPath(dir, job.manual.requestId)) && state !== "delivered") state = "cancelled";
		if (!job.manual && stats) {
			if (
				job.uploaded
					? sameSignature(job.uploaded, signature(stats))
					: job.size === stats.size && job.mtimeMs === stats.mtimeMs
			)
				state = "delivered";
			else {
				const ownHeader = await readSessionHeaderAsync(job.sessionFile);
				const ownConsent = ownHeader
					? await options.settingsManager.readAgentTracesConsent(ownHeader.cwd)
					: undefined;
				if (!ownConsent?.enabled) {
					state = "paused";
					job.pauseReason = ownConsent?.reason ?? "settings_unavailable";
				} else if (state === "delivered") state = "queued";
				else if (
					state === "paused" &&
					job.pauseReason &&
					!["credentials", "missing_credentials"].includes(job.pauseReason)
				)
					state = "queued";
			}
		}
		if (state === "uploading" && (!owned || coordinator?.activeJob !== name)) state = "queued";
		if (state === "uploading") result.inProgress += 1;
		if (state === "queued" || state === "retrying") result.pending += 1;
		if (state === "paused") result.paused += 1;
		if (state === "failed") result.failed += 1;
		if (state === "paused" && job.pauseReason && !result.pauseReasons.includes(job.pauseReason))
			result.pauseReasons.push(job.pauseReason);
		if (job.lastSuccessAt && job.lastSuccessAt > (result.lastSuccessAt ?? 0))
			result.lastSuccessAt = job.lastSuccessAt;
		const failure = job.failure ?? job.lastFailure;
		if (failure && failure.at > (result.lastFailure?.at ?? 0)) result.lastFailure = failure;
		if (state === "queued" || state === "retrying") {
			const next = Math.max(
				job.nextAttemptAt ?? 0,
				coordinator?.nextRequestAt ?? 0,
				job.manual ? 0 : (job.lastAttemptAt ?? 0) + SESSION_INTERVAL_MS,
			);
			if (next > Date.now()) result.nextAttemptAt = Math.min(result.nextAttemptAt ?? Number.POSITIVE_INFINITY, next);
		}
		if (options.sessionFile && resolve(job.sessionFile) === resolve(options.sessionFile)) {
			const newer = job.manual && stats && !sameSignature(job.manual.expected, signature(stats));
			currentStates.push(
				`${state}${job.manual ? ` (one-shot${newer ? "; current file has newer or changed content" : ""})` : ""}`,
			);
		}
	}
	if (currentStates.length) result.currentSession = [...new Set(currentStates)].join(", ");
	return result;
}

const CONSENT_MESSAGES: Record<AgentTraceConsent["reason"], string> = {
	enabled: "Enabled",
	global_off: "Disabled by global setting (default off)",
	project_off: "Disabled by this project's setting",
	runtime_off: "Disabled by the runtime setting",
	settings_unavailable: "Paused: settings unavailable or invalid",
};
const FAILURE_MESSAGES: Record<TraceFailure, string> = {
	invalid_endpoint: "Invalid endpoint; check PRIME_AGENT_TRACES_BASE_URL",
	network: "Network request failed",
	timeout: "Request timed out",
	credentials: "Credential rejected; run /traces login",
	missing_credentials: "No credential configured; run /traces login",
	http: "Server rejected the request; check endpoint and permissions",
	snapshot_changed:
		"Requested file changed before capture; run /traces upload-current again to authorize its current content",
	invalid_session: "Invalid session header",
	too_large: "Trace exceeds the 20 MiB limit",
	empty_session: "Empty trace",
	no_session_file: "Requested file is no longer available",
	preparation_failed: "Could not prepare trace",
	settings_unavailable: "Settings unavailable; delivery paused",
};
export function formatAgentTraceStatus(status: AgentTraceStatus): string {
	const date = (value?: number) => (value === undefined ? "None" : new Date(value).toISOString());
	return [
		"Trace Sharing",
		"",
		`Automatic uploads: ${CONSENT_MESSAGES[status.consent.reason]}`,
		`Queue: ${status.pending} pending, ${status.inProgress} in progress, ${status.paused} paused, ${status.failed} failed`,
		`Bulk requests awaiting discovery: ${status.discovering}`,
		`Current session: ${status.currentSession}`,
		`Last successful delivery: ${date(status.lastSuccessAt)}`,
		`Last failure: ${status.lastFailure ? `${FAILURE_MESSAGES[status.lastFailure.reason] ?? "Delivery failed"}${status.lastFailure.statusCode ? ` (HTTP ${status.lastFailure.statusCode})` : ""} at ${date(status.lastFailure.at)}` : "None"}`,
		`Next eligible retry: ${date(status.nextAttemptAt)}`,
		`Paused: ${status.pauseReasons.map((reason) => CONSENT_MESSAGES[reason as AgentTraceConsent["reason"]] ?? FAILURE_MESSAGES[reason as TraceFailure] ?? "Delivery paused").join("; ") || "No"}`,
		`Credential: ${status.credentialSource}`,
		`Endpoint: ${status.endpoint}`,
		`Session file: ${status.sessionFile}`,
		"",
		"Commands: /traces on, /traces off, /traces preview, /traces upload-current, /traces upload-all, /traces cancel, /traces cancel-all, /traces login",
	].join("\n");
}
