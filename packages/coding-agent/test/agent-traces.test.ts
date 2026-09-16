import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	type AgentTraceUploadCycleOutcome,
	type AgentTraceUploadDelay,
	type AgentTraceUploadInstallation,
	type AgentTraceUploadInstallOptions,
	type AgentTraceUploadResult,
	type AgentTraceUploadSchedule,
	catchUpAgentTraceUploads,
	findAgentTraceFiles,
	installAgentTraceUpload,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../src/core/agent-traces.js";
import { AuthStorage, type AuthStorageOptions } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID, PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const TRACE_BASE_URL = "https://api.example.test";
const UPLOAD_DEBOUNCE_MS = 1_000;
const UPLOAD_MIN_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const BATCH_REQUEST_INTERVAL_MS = 12_100;
const MANAGED_ENV_VARS = [
	ENV_AGENT_DIR,
	"PRIME_AGENT_TRACES_API_KEY",
	"PRIME_API_KEY",
	"PRIME_AGENT_TRACES_BASE_URL",
	"PRIME_API_BASE_URL",
];

interface FetchCall {
	url: string;
	init: RequestInit;
}

/** Hands each value to whoever awaits it next, so tests await source events instead of pumping timers. */
interface SignalQueue<T> {
	push: (value: T) => void;
	next: () => Promise<T>;
	buffered: () => number;
}

function createSignalQueue<T>(): SignalQueue<T> {
	const values: T[] = [];
	const waiters: Array<(value: T) => void> = [];
	return {
		push: (value: T) => {
			const waiter = waiters.shift();
			if (waiter) {
				waiter(value);
				return;
			}
			values.push(value);
		},
		next: () => {
			if (values.length > 0) {
				return Promise.resolve(values.shift() as T);
			}
			return new Promise<T>((resolve) => {
				waiters.push(resolve);
			});
		},
		buffered: () => values.length,
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function createFetchRecorder(calls: FetchCall[]): typeof fetch {
	return async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(
			JSON.stringify({
				session_id: "uploaded-session",
				trace_id: "uploaded-trace",
				bytes_stored: 123,
				key: "trace/key.jsonl",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
}

function traceAuthStorage(options?: AuthStorageOptions): AuthStorage {
	return AuthStorage.inMemory({ [PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" } }, options);
}

/** The option bag every direct upload, batch upload and catch-up in this file shares. */
function traceOptions(fetchFn: typeof fetch, enabled = true) {
	return {
		authStorage: traceAuthStorage(),
		settingsManager: SettingsManager.inMemory({ agentTraces: { enabled } }),
		baseUrl: TRACE_BASE_URL,
		fetchFn,
		reloadConfig: false,
	};
}

function installOptions(fetchFn: typeof fetch, enabled = true): AgentTraceUploadInstallOptions {
	const { authStorage, settingsManager, baseUrl } = traceOptions(fetchFn, enabled);
	return { authStorage, settingsManager, baseUrl, fetchFn };
}

function writeSession(cwd: string, sessionDir: string, id: string, parentSession?: string): SessionManager {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession({ id, parentSession });
	sessionManager.appendMessage(createUserMessage(`user ${id}`));
	sessionManager.appendMessage(createAssistantMessage(`assistant ${id}`));
	return sessionManager;
}

function sessionFileOf(sessionManager: SessionManager): string {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("session manager has no session file");
	}
	return sessionFile;
}

/** Mirrors the outbox on-disk format: one JSON entry per session file, named by path hash. */
function outboxEntryPath(agentDir: string, sessionFile: string): string {
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
	return join(agentDir, "agent-traces-outbox", `${key}.json`);
}

function writeOutboxEntry(agentDir: string, sessionFile: string, signature?: { size: number; mtimeMs: number }): void {
	mkdirSync(join(agentDir, "agent-traces-outbox"), { recursive: true });
	writeFileSync(outboxEntryPath(agentDir, sessionFile), JSON.stringify({ sessionFile, ...signature }));
}

function readOutboxEntry(
	agentDir: string,
	sessionFile: string,
): { sessionFile: string; kind?: string; size?: number; mtimeMs?: number; uploadedBytes?: number } | undefined {
	if (!existsSync(outboxEntryPath(agentDir, sessionFile))) {
		return undefined;
	}
	return JSON.parse(readFileSync(outboxEntryPath(agentDir, sessionFile), "utf8")) as {
		sessionFile: string;
		kind?: string;
		size?: number;
		mtimeMs?: number;
		uploadedBytes?: number;
	};
}

function writeLedgerOutboxEntry(agentDir: string, ledgerFile: string, uploadedBytes?: number): void {
	mkdirSync(join(agentDir, "agent-traces-outbox"), { recursive: true });
	writeFileSync(
		outboxEntryPath(agentDir, ledgerFile),
		JSON.stringify({
			sessionFile: ledgerFile,
			kind: "semantic-edges",
			...(uploadedBytes === undefined ? {} : { uploadedBytes }),
		}),
	);
}

type TransportStep =
	| { kind: "network-error"; code: string }
	| { kind: "response"; status: number; retryAfterSeconds?: number };

function netError(code: string): TransportStep {
	return { kind: "network-error", code };
}

function httpResponse(status: number, retryAfterSeconds?: number): TransportStep {
	return { kind: "response", status, retryAfterSeconds };
}

/** Replays one step per attempt; the last step repeats for every further attempt. */
function createStepTransport(steps: TransportStep[]): { fetchFn: typeof fetch; startTimes: number[] } {
	const startTimes: number[] = [];
	let attempts = 0;
	const fetchFn: typeof fetch = async () => {
		attempts += 1;
		startTimes.push(Date.now());
		const step = steps[Math.min(attempts, steps.length) - 1];
		if (!step) {
			throw new Error("transport has no steps");
		}
		if (step.kind === "network-error") {
			throw new TypeError("fetch failed", { cause: { code: step.code } });
		}
		const headers: Record<string, string> =
			step.retryAfterSeconds === undefined ? {} : { "retry-after": String(step.retryAfterSeconds) };
		const body = step.status === 200 ? { bytes_stored: 42 } : { detail: "unavailable" };
		return new Response(JSON.stringify(body), { status: step.status, headers });
	};
	return { fetchFn, startTimes };
}

/** The fake-clock instant each attempt must start at, given the backoff waits between them. */
function cumulativeStarts(delaysMs: number[]): number[] {
	const starts = [0];
	for (const delayMs of delaysMs) {
		starts.push(starts[starts.length - 1] + delayMs);
	}
	return starts;
}

interface RetryCase {
	name: string;
	steps: TransportStep[];
	expectedAttempts: number;
	/** Backoff waits the upload arms between attempts, with jitter pinned to its floor. */
	expectedDelaysMs: number[];
	expectedResult: AgentTraceUploadResult;
}

const retryCases: RetryCase[] = [
	{
		name: "retries a transient connection failure, then succeeds",
		steps: [netError("ECONNRESET"), httpResponse(200)],
		expectedAttempts: 2,
		expectedDelaysMs: [400],
		expectedResult: {
			status: "uploaded",
			sessionId: "retry-session",
			traceId: "retry-session",
			bytesStored: 42,
			key: undefined,
		},
	},
	{
		name: "stops retrying connection failures at the retry bound",
		steps: [netError("ECONNRESET")],
		expectedAttempts: 4,
		expectedDelaysMs: [400, 800, 1_600],
		expectedResult: { status: "failed", message: "fetch failed (ECONNRESET)" },
	},
	{
		name: "does not retry a permanent DNS failure",
		steps: [netError("ENOTFOUND")],
		expectedAttempts: 1,
		expectedDelaysMs: [],
		expectedResult: { status: "failed", message: "fetch failed (ENOTFOUND)" },
	},
	{
		name: "retries transient HTTP responses, then succeeds",
		steps: [httpResponse(503), httpResponse(503), httpResponse(200)],
		expectedAttempts: 3,
		expectedDelaysMs: [400, 800],
		expectedResult: {
			status: "uploaded",
			sessionId: "retry-session",
			traceId: "retry-session",
			bytesStored: 42,
			key: undefined,
		},
	},
	{
		name: "does not retry a permanent HTTP response",
		steps: [httpResponse(400)],
		expectedAttempts: 1,
		expectedDelaysMs: [],
		expectedResult: { status: "failed", statusCode: 400, message: "unavailable", retryAfterMs: undefined },
	},
	{
		name: "returns a rate-limited response instead of sleeping in-request",
		steps: [httpResponse(429)],
		expectedAttempts: 1,
		expectedDelaysMs: [],
		expectedResult: { status: "failed", statusCode: 429, message: "unavailable", retryAfterMs: undefined },
	},
	{
		name: "honors Retry-After on a retried 503",
		steps: [httpResponse(503, 17), httpResponse(200)],
		expectedAttempts: 2,
		expectedDelaysMs: [17_000],
		expectedResult: {
			status: "uploaded",
			sessionId: "retry-session",
			traceId: "retry-session",
			bytesStored: 42,
			key: undefined,
		},
	},
	{
		name: "caps Retry-After at the platform rate-limit window",
		steps: [httpResponse(503, 3_600), httpResponse(200)],
		expectedAttempts: 2,
		expectedDelaysMs: [60_000],
		expectedResult: {
			status: "uploaded",
			sessionId: "retry-session",
			traceId: "retry-session",
			bytesStored: 42,
			key: undefined,
		},
	},
];

describe("agent trace upload", () => {
	let tempDir: string;
	let installations: AgentTraceUploadInstallation[];
	let savedEnv: Array<[string, string | undefined]>;

	function install(sessionManager: SessionManager, options: AgentTraceUploadInstallOptions): void {
		installations.push(installAgentTraceUpload(sessionManager, options));
	}

	function liveSession(id: string): SessionManager {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
		sessionManager.newSession({ id });
		return sessionManager;
	}

	function installWithSignals(
		sessionManager: SessionManager,
		fetchFn: typeof fetch,
	): { scheduled: SignalQueue<AgentTraceUploadSchedule>; settled: SignalQueue<AgentTraceUploadCycleOutcome> } {
		const scheduled = createSignalQueue<AgentTraceUploadSchedule>();
		const settled = createSignalQueue<AgentTraceUploadCycleOutcome>();
		install(sessionManager, {
			...installOptions(fetchFn),
			onUploadScheduled: scheduled.push,
			onUploadSettled: settled.push,
		});
		return { scheduled, settled };
	}

	beforeEach(() => {
		savedEnv = MANAGED_ENV_VARS.map((name) => [name, process.env[name]]);
		for (const name of MANAGED_ENV_VARS) {
			delete process.env[name];
		}
		tempDir = mkdtempSync(join(tmpdir(), "agent-traces-test-"));
		installations = [];
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		for (const [name, value] of savedEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		// Every writer this test started must finish before the directory it writes into disappears.
		await Promise.all(installations.map((installation) => installation.whenIdle()));
		await rm(tempDir, { recursive: true, force: true });
	});

	it("uploads raw session JSONL with trace headers", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "parent-session");
		const child = writeSession(cwd, sessionDir, "child-session", sessionFileOf(parent));
		const childSessionFile = sessionFileOf(child);

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			...traceOptions(createFetchRecorder(calls)),
			sessionFile: childSessionFile,
		});

		expect(result).toEqual({
			status: "uploaded",
			sessionId: "uploaded-session",
			traceId: "uploaded-trace",
			bytesStored: 123,
			key: "trace/key.jsonl",
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.url).toBe(`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/child-session`);
		expect(call.init.method).toBe("PUT");
		expect(call.init.body).toBe(readFileSync(childSessionFile, "utf8"));

		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe("Bearer trace-key");
		expect(headers.get("content-type")).toBe("application/x-ndjson");
		expect(headers.get("x-trace-id")).toBe("parent-session");
		expect(headers.get("x-parent-session")).toBe("parent-session");
		expect(headers.get("x-cwd")).toBe(cwd);
		expect(headers.get("x-agent-version")).toBeTruthy();
		expect(headers.get("content-length")).toBeNull();
	});

	it("uploads with the agent credential and never falls back to the prime-cli one", async () => {
		const configPath = join(tempDir, "prime-config.json");
		writeFileSync(configPath, JSON.stringify({ api_key: "cli-key", base_url: "http://localhost:8000" }));
		process.env.PRIME_API_BASE_URL = "https://wrong-api.example";
		const calls: FetchCall[] = [];
		const { baseUrl: _ignoredBaseUrl, ...options } = traceOptions(createFetchRecorder(calls));

		// No agent credential: the prime-cli key on disk must not stand in for one.
		const withoutAgentAuth = await uploadAgentTraceFile({
			...options,
			authStorage: AuthStorage.inMemory({}, { primeCliConfigPath: configPath }),
			sessionFile: sessionFileOf(writeSession(tempDir, join(tempDir, "sessions"), "cli-fallback-session")),
		});
		expect(withoutAgentAuth).toEqual({ status: "missing_credentials" });
		expect(calls).toHaveLength(0);

		// With the agent inference credential: production endpoint, that bearer token.
		const result = await uploadAgentTraceFile({
			...options,
			authStorage: AuthStorage.inMemory(
				{ [PRIME_INFERENCE_PROVIDER_ID]: { type: "api_key", key: "inference-key" } },
				{ primeCliConfigPath: configPath, usePrimeCliConfig: true },
			),
			sessionFile: sessionFileOf(writeSession(tempDir, join(tempDir, "sessions"), "credential-order-session")),
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.primeintellect.ai/api/v1/agent-traces/sessions/credential-order-session");
		expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer inference-key" });
	});

	it.each(retryCases)("$name", async ({ steps, expectedAttempts, expectedDelaysMs, expectedResult }) => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		const session = writeSession(tempDir, join(tempDir, "sessions"), "retry-session");
		const transport = createStepTransport(steps);
		const delays = createSignalQueue<AgentTraceUploadDelay>();

		const upload = uploadAgentTraceFile({
			...traceOptions(transport.fetchFn),
			sessionFile: sessionFileOf(session),
			onUploadDelay: delays.push,
		});

		const observedDelaysMs: number[] = [];
		for (let retry = 0; retry < expectedDelaysMs.length; retry += 1) {
			const armed = await delays.next();
			expect(armed.reason).toBe("retry-backoff");
			observedDelaysMs.push(armed.delayMs);
			await vi.advanceTimersByTimeAsync(armed.delayMs);
		}
		const result = await upload;

		expect(observedDelaysMs).toEqual(expectedDelaysMs);
		expect(delays.buffered()).toBe(0);
		// Every attempt starts only after its whole backoff has elapsed on the controlled clock.
		const [firstStart = 0] = transport.startTimes;
		expect(transport.startTimes.map((start) => start - firstStart)).toEqual(cumulativeStarts(expectedDelaysMs));
		expect(transport.startTimes).toHaveLength(expectedAttempts);
		expect(result).toEqual(expectedResult);
	});

	it.each([
		{
			name: "the caller aborts during a retry",
			message: "upload cancelled",
			createFetch: (controller: AbortController): typeof fetch => {
				return async () => {
					controller.abort(new Error("upload cancelled"));
					throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
				};
			},
		},
		{
			name: "draining an HTTP response aborts the upload",
			message: "upload cancelled during cleanup",
			createFetch: (controller: AbortController): typeof fetch => {
				return async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							cancel: () => controller.abort(new Error("upload cancelled during cleanup")),
						}),
						{ status: 503 },
					);
			},
		},
	])("arms no backoff and surfaces the reason when $name", async ({ message, createFetch }) => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "aborted-retry-session");
		const controller = new AbortController();
		const delays = createSignalQueue<AgentTraceUploadDelay>();
		let attempts = 0;
		const countingFetch: typeof fetch = async (input, init) => {
			attempts += 1;
			return await createFetch(controller)(input, init);
		};

		const result = await uploadAgentTraceFile({
			...traceOptions(countingFetch),
			sessionFile: sessionFileOf(session),
			signal: controller.signal,
			onUploadDelay: delays.push,
		});

		expect(attempts).toBe(1);
		expect(result).toEqual({ status: "failed", message });
		expect(delays.buffered()).toBe(0);
	});

	it("discovers and uploads saved parent and subagent traces", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "all-parent");
		const childDir = join(tempDir, "session-artifacts", "all-parent", "sub-12345678");
		const child = writeSession(cwd, childDir, "all-child", sessionFileOf(parent));
		const grandchild = writeSession(cwd, join(childDir, "sub-87654321"), "all-grandchild", sessionFileOf(child));
		writeFileSync(join(childDir, "not-a-session.jsonl"), '{"type":"diagnostic"}\n');

		const discovered = await findAgentTraceFiles(sessionDir);
		expect(discovered).toEqual([sessionFileOf(child), sessionFileOf(grandchild), sessionFileOf(parent)].sort());

		vi.useFakeTimers();
		const calls: FetchCall[] = [];
		const delays = createSignalQueue<AgentTraceUploadDelay>();
		const progress: Array<{ completed: number; total: number }> = [];
		const upload = uploadAllAgentTraces({
			...traceOptions(createFetchRecorder(calls), false),
			sessionDir,
			requireEnabled: false,
			concurrency: 1,
			onUploadDelay: delays.push,
			onProgress: ({ completed, total }) => {
				progress.push({ completed, total });
			},
		});
		for (let request = 1; request < 3; request += 1) {
			const gate = await delays.next();
			expect(gate.reason).toBe("rate-limit");
			await vi.advanceTimersByTimeAsync(gate.delayMs);
		}
		const result = await upload;

		expect(result).toMatchObject({ total: 3, uploaded: 3, failed: 0, skipped: 0, bytesStored: 369 });
		expect(calls.map((call) => call.url).sort()).toEqual(
			[
				`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/all-child`,
				`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/all-grandchild`,
				`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/all-parent`,
			].sort(),
		);
		const grandchildHeaders = new Headers(calls.find((call) => call.url.endsWith("/all-grandchild"))?.init.headers);
		expect(grandchildHeaders.get("x-trace-id")).toBe("all-parent");
		expect(grandchildHeaders.get("x-parent-session")).toBe("all-child");
		expect(progress[0]).toEqual({ completed: 0, total: 3 });
		expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
	});

	it("paces batch request starts within the platform rate limit", async () => {
		const sessionDir = join(tempDir, "sessions");
		for (let index = 0; index < 6; index += 1) {
			writeSession(tempDir, sessionDir, `rate-limited-all-${index}`);
		}

		vi.useFakeTimers();
		const delays = createSignalQueue<AgentTraceUploadDelay>();
		const requestStarts: number[] = [];
		const pacedFetch: typeof fetch = async () => {
			requestStarts.push(Date.now());
			return new Response(JSON.stringify({ bytes_stored: 1 }), { status: 200 });
		};

		const upload = uploadAllAgentTraces({
			...traceOptions(pacedFetch, false),
			sessionDir,
			requireEnabled: false,
			onUploadDelay: delays.push,
		});

		for (let request = 1; request < 6; request += 1) {
			const gate = await delays.next();
			expect(gate.delayMs).toBe(BATCH_REQUEST_INTERVAL_MS);
			await vi.advanceTimersByTimeAsync(gate.delayMs);
		}
		const result = await upload;

		expect(result).toMatchObject({ total: 6, uploaded: 6, failed: 0, skipped: 0 });
		expect(requestStarts).toHaveLength(6);
		for (let index = 1; index < requestStarts.length; index += 1) {
			expect(requestStarts[index] - requestStarts[index - 1]).toBeGreaterThanOrEqual(12_000);
		}
		expect(requestStarts[5] - requestStarts[0]).toBeGreaterThanOrEqual(60_000);
	});

	it("stops scheduling batch uploads after cancellation", async () => {
		const sessionDir = join(tempDir, "sessions");
		writeSession(tempDir, sessionDir, "abort-all-a");
		writeSession(tempDir, sessionDir, "abort-all-b");
		writeSession(tempDir, sessionDir, "abort-all-c");
		const controller = new AbortController();
		const calls: FetchCall[] = [];

		const result = await uploadAllAgentTraces({
			...traceOptions(createFetchRecorder(calls), false),
			sessionDir,
			requireEnabled: false,
			concurrency: 1,
			signal: controller.signal,
			onProgress: ({ completed }) => {
				if (completed === 1) {
					controller.abort(new Error("cancel batch"));
				}
			},
		});

		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ total: 3, uploaded: 1, failed: 0, skipped: 2 });
		expect(result.results).toHaveLength(1);
	});

	it("counts in-flight batch cancellations as skipped", async () => {
		const sessionDir = join(tempDir, "sessions");
		writeSession(tempDir, sessionDir, "abort-in-flight-a");
		writeSession(tempDir, sessionDir, "abort-in-flight-b");
		writeSession(tempDir, sessionDir, "abort-in-flight-c");
		const controller = new AbortController();
		vi.useFakeTimers();
		const delays = createSignalQueue<AgentTraceUploadDelay>();
		let attempts = 0;
		const stalledFetch: typeof fetch = async (_input, init) => {
			attempts += 1;
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				if (attempts === 2) {
					queueMicrotask(() => controller.abort(new Error("cancel in-flight batch")));
				}
			});
		};

		const upload = uploadAllAgentTraces({
			...traceOptions(stalledFetch, false),
			sessionDir,
			requireEnabled: false,
			concurrency: 2,
			signal: controller.signal,
			onUploadDelay: delays.push,
		});
		await vi.advanceTimersByTimeAsync((await delays.next()).delayMs);
		const result = await upload;

		expect(attempts).toBe(2);
		expect(result).toMatchObject({ total: 3, uploaded: 0, failed: 0, skipped: 3 });
		expect(result.results).toHaveLength(0);
	});

	it("catches up on install with exactly what a previous process never uploaded, then goes quiet", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const missedFile = sessionFileOf(writeSession(cwd, sessionDir, "missed-session"));
		writeOutboxEntry(tempDir, missedFile);

		// startupCatchUp is process-scoped. A fresh module makes this test independent
		// of which install test Vitest executes first.
		vi.resetModules();
		const { installAgentTraceUpload: installFreshAgentTraceUpload } = await import("../src/core/agent-traces.js");
		const calls: FetchCall[] = [];
		const options = traceOptions(createFetchRecorder(calls));
		const installation = installFreshAgentTraceUpload(
			liveSession("live-session"),
			installOptions(createFetchRecorder(calls)),
		);
		installations.push(installation);
		await installation.whenIdle();

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/missed-session`);
		expect(calls[0].init.body).toBe(readFileSync(missedFile, "utf8"));
		const stats = await stat(missedFile);
		expect(readOutboxEntry(tempDir, missedFile)).toEqual({
			sessionFile: missedFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});

		// Unchanged content: later cycles and restarts never re-POST.
		expect((await catchUpAgentTraceUploads(options)).results).toEqual([]);
		expect(await uploadAgentTraceFile({ ...options, sessionFile: missedFile })).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(1);
	});

	it("durably records upload intent on disk before any upload happens", async () => {
		vi.useFakeTimers();
		const sessionManager = liveSession("unflushed-session");
		const calls: FetchCall[] = [];
		install(sessionManager, installOptions(createFetchRecorder(calls)));

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));

		// Synchronously durable: the intent marker is on disk the moment the persist returns.
		const sessionFile = sessionFileOf(sessionManager);
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({ sessionFile });
		expect(calls).toHaveLength(0);
	});

	it("prunes cursors for deleted files and corrupt entries without touching the others", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const keptFile = sessionFileOf(writeSession(cwd, sessionDir, "kept-session"));
		const keptStats = await stat(keptFile);
		const keptSignature = { size: keptStats.size, mtimeMs: keptStats.mtimeMs };
		const deletedFile = join(sessionDir, "deleted-session.jsonl");
		writeOutboxEntry(tempDir, deletedFile);
		writeOutboxEntry(tempDir, keptFile, keptSignature);
		writeFileSync(join(tempDir, "agent-traces-outbox", "deadbeef.json"), "not json");

		const calls: FetchCall[] = [];
		const options = traceOptions(createFetchRecorder(calls));
		const result = await catchUpAgentTraceUploads(options);

		expect(result).toEqual({ pruned: 2, semanticEdgeLedgersPending: 0, results: [] });
		expect(existsSync(outboxEntryPath(tempDir, deletedFile))).toBe(false);
		expect(existsSync(join(tempDir, "agent-traces-outbox", "deadbeef.json"))).toBe(false);
		expect(readOutboxEntry(tempDir, keptFile)).toEqual({ sessionFile: keptFile, ...keptSignature });
		expect(await uploadAgentTraceFile({ ...options, sessionFile: keptFile })).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(0);
	});

	it("keeps the cursor retryable when the outbox cannot be written", async () => {
		const blocker = join(tempDir, "agent-traces-outbox");
		writeFileSync(blocker, "not a directory");
		const session = writeSession(tempDir, join(tempDir, "sessions"), "cursor-persist-failure");

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			...traceOptions(createFetchRecorder(calls)),
			sessionFile: sessionFileOf(session),
		});

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("cursor");
		}

		// The next persist after the blocker is gone writes the intent marker that the failed write lost.
		vi.useFakeTimers();
		const sessionManager = liveSession("marker-retry-session");
		install(sessionManager, installOptions(createFetchRecorder([])));
		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		const sessionFile = sessionFileOf(sessionManager);
		expect(readOutboxEntry(tempDir, sessionFile)).toBeUndefined();

		rmSync(blocker);
		sessionManager.appendMessage(createUserMessage("again"));
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({ sessionFile });
	});

	it("registers the semantic-edge ledger with a kind-tagged durable intent at persist", async () => {
		vi.useFakeTimers();
		const sessionManager = liveSession("ledger-intent-session");
		const ledgerPath = join(tempDir, "artifacts", "semantic-edges.jsonl");
		const calls: FetchCall[] = [];
		install(sessionManager, {
			...installOptions(createFetchRecorder(calls)),
			semanticEdgesLedgerPath: ledgerPath,
		});
		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));

		// Synchronously durable, tagged with its own delivery kind, before any wire call.
		expect(readOutboxEntry(tempDir, ledgerPath)).toEqual({ sessionFile: ledgerPath, kind: "semantic-edges" });
		expect(calls).toHaveLength(0);

		// A re-install with a DIFFERENT ledger path registers the new ledger at the next persist.
		const movedLedgerPath = join(tempDir, "artifacts-moved", "semantic-edges.jsonl");
		install(sessionManager, {
			...installOptions(createFetchRecorder(calls)),
			semanticEdgesLedgerPath: movedLedgerPath,
		});
		sessionManager.appendMessage(createAssistantMessage("after re-install"));
		expect(readOutboxEntry(tempDir, movedLedgerPath)).toEqual({
			sessionFile: movedLedgerPath,
			kind: "semantic-edges",
		});

		// A concurrent catch-up pruned the entry (missing ledger file at scan time).
		rmSync(outboxEntryPath(tempDir, movedLedgerPath));
		sessionManager.appendMessage(createUserMessage("still here"));
		expect(readOutboxEntry(tempDir, movedLedgerPath)).toEqual({
			sessionFile: movedLedgerPath,
			kind: "semantic-edges",
		});
		expect(calls).toHaveLength(0);
	});

	it("creates no outbox intent or retroactive wire upload while trace sharing is disabled", async () => {
		vi.useFakeTimers();
		const sessionManager = liveSession("opted-out-session");
		const ledgerPath = join(tempDir, "artifacts", "semantic-edges.jsonl");
		const calls: FetchCall[] = [];
		const settingsManager = SettingsManager.inMemory({ agentTraces: { enabled: false } });
		const scheduled = createSignalQueue<AgentTraceUploadSchedule>();
		const settled = createSignalQueue<AgentTraceUploadCycleOutcome>();
		install(sessionManager, {
			...installOptions(createFetchRecorder(calls), false),
			settingsManager,
			semanticEdgesLedgerPath: ledgerPath,
			onUploadScheduled: scheduled.push,
			onUploadSettled: settled.push,
		});
		sessionManager.appendMessage(createUserMessage("private"));
		sessionManager.appendMessage(createAssistantMessage("also private"));

		await vi.advanceTimersByTimeAsync((await scheduled.next()).delayMs);
		expect(await settled.next()).toEqual({ status: "disabled" });
		expect(readOutboxEntry(tempDir, sessionFileOf(sessionManager))).toBeUndefined();
		expect(readOutboxEntry(tempDir, ledgerPath)).toBeUndefined();
		expect(calls).toHaveLength(0);

		// Enabling later cannot discover or upload the opted-out content because
		// the disabled persists left no durable intent for startup catch-up.
		settingsManager.setAgentTracesEnabled(true);
		expect(await catchUpAgentTraceUploads({ ...traceOptions(createFetchRecorder(calls)), settingsManager })).toEqual({
			pruned: 0,
			semanticEdgeLedgersPending: 0,
			results: [],
		});
		expect(calls).toHaveLength(0);
	});

	it("counts appended ledger bytes as pending, stays quiet at the cursor, and prunes deleted ledgers", async () => {
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const ledgerFile = join(sessionDir, "semantic-edges.jsonl");
		writeFileSync(ledgerFile, `${JSON.stringify({ type: "session_registered", session_id: "s" })}\n`);
		writeLedgerOutboxEntry(tempDir, ledgerFile);
		const deletedLedger = join(sessionDir, "gone", "semantic-edges.jsonl");
		writeLedgerOutboxEntry(tempDir, deletedLedger);

		const calls: FetchCall[] = [];
		const options = traceOptions(createFetchRecorder(calls));

		// Catch-up after a kill: the never-delivered ledger is pending; the deleted one is pruned.
		expect(await catchUpAgentTraceUploads(options)).toEqual({
			pruned: 1,
			semanticEdgeLedgersPending: 1,
			results: [],
		});
		expect(existsSync(outboxEntryPath(tempDir, deletedLedger))).toBe(false);
		// The cursor stays untouched: the first real sender must deliver the whole backlog.
		expect(readOutboxEntry(tempDir, ledgerFile)).toEqual({ sessionFile: ledgerFile, kind: "semantic-edges" });

		// A cursor at the file size means unchanged: never re-counted, never resent.
		const { size } = await stat(ledgerFile);
		writeLedgerOutboxEntry(tempDir, ledgerFile, size);
		expect(await catchUpAgentTraceUploads(options)).toEqual({
			pruned: 0,
			semanticEdgeLedgersPending: 0,
			results: [],
		});

		// Appended bytes beyond the cursor become pending again.
		writeFileSync(ledgerFile, `${JSON.stringify({ type: "request_started", request_id: "r", session_id: "s" })}\n`, {
			flag: "a",
		});
		expect(await catchUpAgentTraceUploads(options)).toEqual({
			pruned: 0,
			semanticEdgeLedgersPending: 1,
			results: [],
		});
		expect(calls).toHaveLength(0);
	});

	it("arms a debounced upload on persist, then throttles later uploads to one per minute", async () => {
		vi.useFakeTimers();
		const sessionManager = liveSession("listener-session");
		const calls: FetchCall[] = [];
		const { scheduled, settled } = installWithSignals(sessionManager, createFetchRecorder(calls));

		sessionManager.appendMessage(createUserMessage("hello"));
		expect(scheduled.buffered()).toBe(0);

		sessionManager.appendMessage(createAssistantMessage("hi"));
		const armed = await scheduled.next();
		expect(armed).toEqual({ delayMs: UPLOAD_DEBOUNCE_MS });

		await vi.advanceTimersByTimeAsync(armed.delayMs);
		expect((await settled.next()).status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${TRACE_BASE_URL}/api/v1/agent-traces/sessions/listener-session`);

		// Sending the request is not completion: the cursor lands before the cycle settles.
		const sessionFile = sessionFileOf(sessionManager);
		const { size, mtimeMs } = await stat(sessionFile);
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({ sessionFile, size, mtimeMs });

		// The next persist lands inside the minute window. It cannot upload even
		// one millisecond early, and starts exactly when the window closes.
		sessionManager.appendMessage(createUserMessage("next"));
		const throttled = await scheduled.next();
		expect(throttled).toEqual({ delayMs: UPLOAD_MIN_INTERVAL_MS });
		await vi.advanceTimersByTimeAsync(throttled.delayMs - 1);
		expect(calls).toHaveLength(1);
		expect(settled.buffered()).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect((await settled.next()).status).toBe("uploaded");
		expect(calls).toHaveLength(2);
		expect(calls[1].init.body).toBe(readFileSync(sessionFile, "utf8"));
	});

	it.each([
		{ name: "the advertised Retry-After window", retryAfterSeconds: 300, expectedDelayMs: 300_000 },
		{ name: "the maximum timer delay", retryAfterSeconds: 2_592_000, expectedDelayMs: MAX_TIMER_DELAY_MS },
	])("reschedules a rate-limited automatic upload at $name", async ({ retryAfterSeconds, expectedDelayMs }) => {
		vi.useFakeTimers();
		const sessionManager = liveSession("rate-limited-session");
		const calls: FetchCall[] = [];
		let attempts = 0;
		const rateLimitedFetch: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(null, { status: 429, headers: { "retry-after": String(retryAfterSeconds) } });
			}
			return createFetchRecorder(calls)(input, init);
		};
		const { scheduled, settled } = installWithSignals(sessionManager, rateLimitedFetch);

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await vi.advanceTimersByTimeAsync((await scheduled.next()).delayMs);
		expect(await settled.next()).toMatchObject({ status: "failed", statusCode: 429 });
		expect((await scheduled.next()).delayMs).toBe(expectedDelayMs);

		// A fresh persist must not re-arm inside the advertised window.
		sessionManager.appendMessage(createUserMessage("more"));
		expect((await scheduled.next()).delayMs).toBe(expectedDelayMs);
		expect(calls).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(expectedDelayMs);
		expect((await settled.next()).status).toBe("uploaded");
		expect(attempts).toBe(2);
		expect(calls).toHaveLength(1);
		const sessionFile = sessionFileOf(sessionManager);
		const { size, mtimeMs } = await stat(sessionFile);
		expect(readOutboxEntry(tempDir, sessionFile)).toEqual({ sessionFile, size, mtimeMs });
	});

	it("coalesces new content that persists during an in-flight upload into one follow-up upload", async () => {
		vi.useFakeTimers();
		const sessionManager = liveSession("concurrent-upload-session");
		let releaseFirstUpload: () => void = () => {};
		const firstUploadReleased = new Promise<void>((resolve) => {
			releaseFirstUpload = resolve;
		});
		const requestStarted = createSignalQueue<void>();
		const calls: FetchCall[] = [];
		const blockingFetch: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			requestStarted.push(undefined);
			if (calls.length === 1) {
				await firstUploadReleased;
			}
			return new Response(JSON.stringify({ bytes_stored: 123 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { scheduled, settled } = installWithSignals(sessionManager, blockingFetch);

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await vi.advanceTimersByTimeAsync((await scheduled.next()).delayMs);
		await requestStarted.next();

		// New content lands while the first upload is still in flight.
		sessionManager.appendMessage(createUserMessage("more"));
		sessionManager.appendMessage(createAssistantMessage("content"));
		await vi.advanceTimersByTimeAsync((await scheduled.next()).delayMs);
		// The cycle that fires mid-flight folds into the running upload instead of sending again.
		expect((await settled.next()).status).toBe("coalesced");
		expect(calls).toHaveLength(1);

		releaseFirstUpload();
		expect((await settled.next()).status).toBe("uploaded");

		// The coalesced follow-up sends the whole file exactly once.
		await vi.advanceTimersByTimeAsync((await scheduled.next()).delayMs);
		await requestStarted.next();
		expect((await settled.next()).status).toBe("uploaded");
		expect(calls).toHaveLength(2);
		const finalBody = readFileSync(sessionFileOf(sessionManager), "utf8");
		expect(calls[1].init.body).toBe(finalBody);
		expect(readOutboxEntry(tempDir, sessionFileOf(sessionManager))?.size).toBe(Buffer.byteLength(finalBody));
	});
});
