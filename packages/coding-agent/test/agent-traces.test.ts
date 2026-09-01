import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentTracesLogPath } from "../src/config.js";
import {
	catchUpAgentTraceUploads,
	findAgentTraceFiles,
	installAgentTraceUpload,
	previewAgentTraceFile,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID, PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

interface FetchCall {
	url: string;
	init: RequestInit;
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
	return {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	};
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

function writeSession(cwd: string, sessionDir: string, id: string, parentSession?: string): SessionManager {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession({ id, parentSession });
	sessionManager.appendMessage(createUserMessage(`user ${id}`));
	sessionManager.appendMessage(createAssistantMessage(`assistant ${id}`));
	return sessionManager;
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
): { sessionFile: string; size?: number; mtimeMs?: number } | undefined {
	if (!existsSync(outboxEntryPath(agentDir, sessionFile))) {
		return undefined;
	}
	return JSON.parse(readFileSync(outboxEntryPath(agentDir, sessionFile), "utf8")) as {
		sessionFile: string;
		size?: number;
		mtimeMs?: number;
	};
}

async function advanceTimersUntil(condition: () => boolean): Promise<void> {
	for (let step = 0; step < 200 && !condition(); step += 1) {
		await stat(new URL(import.meta.url));
		if (!condition() && vi.getTimerCount() > 0) {
			await vi.advanceTimersToNextTimerAsync();
		}
	}
	if (!condition()) {
		throw new Error("Timed out advancing fake timers to the expected condition");
	}
}

describe("agent trace upload", () => {
	let tempDir: string;
	let originalTraceApiKey: string | undefined;
	let originalPrimeApiKey: string | undefined;
	let originalTraceBaseUrl: string | undefined;
	let originalPrimeBaseUrl: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-traces-test-"));
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir;
		originalTraceApiKey = process.env.PRIME_AGENT_TRACES_API_KEY;
		originalPrimeApiKey = process.env.PRIME_API_KEY;
		originalTraceBaseUrl = process.env.PRIME_AGENT_TRACES_BASE_URL;
		originalPrimeBaseUrl = process.env.PRIME_API_BASE_URL;
		delete process.env.PRIME_AGENT_TRACES_API_KEY;
		delete process.env.PRIME_API_KEY;
		delete process.env.PRIME_AGENT_TRACES_BASE_URL;
		delete process.env.PRIME_API_BASE_URL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalTraceApiKey === undefined) {
			delete process.env.PRIME_AGENT_TRACES_API_KEY;
		} else {
			process.env.PRIME_AGENT_TRACES_API_KEY = originalTraceApiKey;
		}
		if (originalPrimeApiKey === undefined) {
			delete process.env.PRIME_API_KEY;
		} else {
			process.env.PRIME_API_KEY = originalPrimeApiKey;
		}
		if (originalTraceBaseUrl === undefined) {
			delete process.env.PRIME_AGENT_TRACES_BASE_URL;
		} else {
			process.env.PRIME_AGENT_TRACES_BASE_URL = originalTraceBaseUrl;
		}
		if (originalPrimeBaseUrl === undefined) {
			delete process.env.PRIME_API_BASE_URL;
		} else {
			process.env.PRIME_API_BASE_URL = originalPrimeBaseUrl;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not upload when trace sharing is disabled", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "disabled-session");
		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
	});

	it("allows an explicit one-shot upload without enabling automatic sharing", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "one-shot-session");
		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
	});

	it("stops before reading the session body when trace sharing is disabled after upload starts", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "disabled-before-read-session");
		const settingsManager = SettingsManager.inMemory({ agentTraces: { enabled: true } });
		const enabledSpy = vi.spyOn(settingsManager, "getAgentTracesEnabled");
		enabledSpy.mockReturnValueOnce(true).mockReturnValue(false);

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
		expect(enabledSpy).toHaveBeenCalledTimes(2);
	});

	it("rechecks trace sharing before sending the upload request", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "disabled-before-fetch-session");
		const settingsManager = SettingsManager.inMemory({ agentTraces: { enabled: true } });
		const enabledSpy = vi.spyOn(settingsManager, "getAgentTracesEnabled");
		enabledSpy.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
		expect(enabledSpy).toHaveBeenCalledTimes(3);
	});

	it("uploads raw session JSONL with trace headers", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "parent-session");
		const child = writeSession(cwd, sessionDir, "child-session", parent.getSessionFile());
		const childSessionFile = child.getSessionFile();
		expect(childSessionFile).toBeDefined();

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: childSessionFile,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
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
		expect(call.url).toBe("https://api.example.test/api/v1/agent-traces/sessions/child-session");
		expect(call.init.method).toBe("PUT");
		expect(call.init.body).toBe(readFileSync(childSessionFile!, "utf8"));

		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe("Bearer trace-key");
		expect(headers.get("content-type")).toBe("application/x-ndjson");
		expect(headers.get("x-trace-id")).toBe("parent-session");
		expect(headers.get("x-parent-session")).toBe("parent-session");
		expect(headers.get("x-cwd")).toBe(cwd);
		expect(headers.get("x-agent-version")).toBeTruthy();
		expect(headers.get("content-length")).toBeNull();
	});

	it("uses the production trace API unless a trace-specific base URL is configured", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "prod-session");
		const configPath = join(tempDir, "prime-config.json");
		writeFileSync(configPath, JSON.stringify({ base_url: "https://dev-api.example/api/v1" }));
		process.env.PRIME_API_BASE_URL = "https://wrong-api.example";

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			configPath,
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.primeintellect.ai/api/v1/agent-traces/sessions/prod-session");
	});

	it("uses PRIME_AGENT_TRACES_BASE_URL for trace API overrides", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "override-session");
		process.env.PRIME_AGENT_TRACES_BASE_URL = "https://trace-api.example/api/v1";

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://trace-api.example/api/v1/agent-traces/sessions/override-session");
	});

	it("runs a startup catch-up on the first trace-upload install", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const missed = writeSession(cwd, sessionDir, "missed-session");
		const missedFile = missed.getSessionFile();
		expect(missedFile).toBeDefined();
		writeOutboxEntry(tempDir, missedFile as string);

		const live = SessionManager.create(cwd, sessionDir);
		live.newSession({ id: "live-session" });
		const calls: FetchCall[] = [];
		installAgentTraceUpload(live, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].url).toBe("https://api.example.test/api/v1/agent-traces/sessions/missed-session");
		expect(calls[0].init.body).toBe(readFileSync(missedFile as string, "utf8"));
		const stats = await stat(missedFile as string);
		await vi.waitFor(() =>
			expect(readOutboxEntry(tempDir, missedFile as string)).toEqual({
				sessionFile: missedFile,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			}),
		);
	});

	it("schedules upload only after the session file is persisted", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "listener-session" });

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		expect(vi.getTimerCount()).toBe(0);

		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => calls.length === 1);
		expect(calls[0].url).toBe("https://api.example.test/api/v1/agent-traces/sessions/listener-session");
	});

	it("coalesces new content that persists during an in-flight upload into one follow-up upload", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "concurrent-upload-session" });

		let releaseFetch: () => void = () => {};
		const fetchReleased = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} });
			if (calls.length === 1) {
				await fetchReleased;
			}
			return new Response(JSON.stringify({ bytes_stored: 123 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => calls.length === 1);

		// New content lands while the first upload is still in flight.
		sessionManager.appendMessage(createUserMessage("more"));
		sessionManager.appendMessage(createAssistantMessage("content"));
		await advanceTimersUntil(() => vi.getTimerCount() > 0);
		await vi.advanceTimersToNextTimerAsync();
		expect(calls).toHaveLength(1);

		releaseFetch();
		await advanceTimersUntil(() => calls.length === 2);
		const finalBody = readFileSync(sessionManager.getSessionFile() as string, "utf8");
		expect(calls[1].init.body).toBe(finalBody);
		// Drain the follow-up upload's completion so its chain cannot leak into later fake-timer tests.
		await advanceTimersUntil(
			() =>
				readOutboxEntry(tempDir, sessionManager.getSessionFile() as string)?.size === Buffer.byteLength(finalBody),
		);
	});

	it("schedules automatic uploads at most once per minute and only after new entries persist", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "throttled-session" });

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(1_000);
		await advanceTimersUntil(() => calls.length === 1);

		setTimeoutSpy.mockClear();
		sessionManager.appendMessage(createUserMessage("next"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(60_000);
	});

	it("surfaces the underlying fetch cause and logs the failure", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "failing-session");
		const sessionFile = session.getSessionFile();

		const failingFetch: typeof fetch = async () => {
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: failingFetch,
			reloadConfig: false,
		});

		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("fetch failed (ENOTFOUND)");
		}

		const logContents = readFileSync(getAgentTracesLogPath(), "utf8");
		expect(logContents).toContain("upload failed");
		expect(logContents).toContain("fetch failed (ENOTFOUND)");
		expect(logContents).toContain(sessionFile ?? "");
	});

	it("retries once on a transient connection failure, then succeeds", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "retry-session");
		const calls: FetchCall[] = [];
		let attempts = 0;
		const flakyFetch: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				const error = new TypeError("fetch failed");
				(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
				throw error;
			}
			return createFetchRecorder(calls)(input, init);
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: flakyFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
	});

	it("uses bounded exponential backoff with jitter for transient failures", async () => {
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = writeSession(tempDir, join(tempDir, "sessions"), "bounded-retry-session");
		let attempts = 0;
		const failingFetch: typeof fetch = async () => {
			attempts += 1;
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: failingFetch,
			reloadConfig: false,
		});
		expect(attempts).toBe(4);
		expect(result.status).toBe("failed");
		const retryDelays = timeoutSpy.mock.calls.map((call) => Number(call[1])).filter((delay) => delay < 15_000);
		expect(retryDelays).toEqual([400, 800, 1_600]);
		randomSpy.mockRestore();
	});

	it("retries request timeouts within the retry bound", async () => {
		vi.useFakeTimers();
		const session = writeSession(tempDir, join(tempDir, "sessions"), "timeout-retry-session");
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const timeoutFetch: typeof fetch = async (_input, init) => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
			}
			return await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: timeoutFetch,
			requestTimeoutMs: 100,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(4);
		expect(result).toEqual({ status: "failed", message: "Trace upload timed out after 100ms" });
	});

	it("retries transient HTTP responses but not permanent HTTP responses", async () => {
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const session = writeSession(tempDir, join(tempDir, "sessions"), "http-retry-session");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts < 3) {
				return new Response(JSON.stringify({ detail: "temporarily unavailable" }), { status: 503 });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});
		expect(attempts).toBe(3);
		expect(result.status).toBe("uploaded");
		randomSpy.mockRestore();
	});

	it("returns a rate-limited upload immediately instead of sleeping in-request", async () => {
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = writeSession(tempDir, join(tempDir, "sessions"), "rate-limit-session");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			return new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429 });
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result).toMatchObject({ status: "failed", statusCode: 429 });
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).not.toContain(60_000);
	});

	it("reschedules a rate-limited automatic upload without blocking and retries on the next cycle", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "rate-limit-reschedule-session" });

		let attempts = 0;
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(JSON.stringify({ detail: "Too Many Requests" }), { status: 429 });
			}
			return createFetchRecorder(calls)(input, init);
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => attempts === 1);
		// The rate-limited cycle re-arms itself; the retry succeeds without any caller waiting.
		await advanceTimersUntil(() => calls.length === 1);
		expect(attempts).toBe(2);
	});

	it.each([503])("honors Retry-After when retrying HTTP %i", async (status) => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = writeSession(tempDir, join(tempDir, "sessions"), `retry-after-session-${status}`);
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
				return new Response(null, { status, headers: { "retry-after": "17" } });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).toContain(17_000);
	});

	it("caps Retry-After at the platform rate-limit window", async () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = writeSession(tempDir, join(tempDir, "sessions"), "bounded-retry-after-session");
		let markFirstAttemptStarted: () => void = () => {};
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) {
				markFirstAttemptStarted();
				return new Response(null, { status: 503, headers: { "retry-after": "3600" } });
			}
			return new Response(JSON.stringify({ bytes_stored: 42 }), { status: 200 });
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstAttemptStarted;
		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(2);
		expect(result.status).toBe("uploaded");
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).toContain(60_000);
		expect(timeoutSpy.mock.calls.map((call) => Number(call[1]))).not.toContain(3_600_000);
	});

	it("surfaces the cancellation reason when aborted during the retry backoff", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "aborted-retry-session");
		const controller = new AbortController();
		const abortReason = new Error("upload cancelled");
		let attempts = 0;
		const flakyFetch: typeof fetch = async () => {
			attempts += 1;
			controller.abort(abortReason);
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ECONNRESET" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: flakyFetch,
			signal: controller.signal,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("upload cancelled");
		}
	});

	it("does not back off when an HTTP response cleanup aborts the upload", async () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const session = writeSession(tempDir, join(tempDir, "sessions"), "aborted-http-retry-session");
		const controller = new AbortController();
		const abortReason = new Error("upload cancelled during cleanup");
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			return {
				status: 503,
				headers: new Headers(),
				body: {
					cancel: async () => {
						controller.abort(abortReason);
					},
				},
			} as unknown as Response;
		};

		const upload = uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
			signal: controller.signal,
			reloadConfig: false,
		});

		await vi.runAllTimersAsync();
		const result = await upload;
		expect(attempts).toBe(1);
		expect(result).toEqual({ status: "failed", message: "upload cancelled during cleanup" });
		const retryDelays = timeoutSpy.mock.calls.map((call) => Number(call[1])).filter((delay) => delay < 15_000);
		expect(retryDelays).toEqual([]);
	});

	it("does not retry a permanent DNS failure", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "dns-failure-session");
		let attempts = 0;
		const dnsFailFetch: typeof fetch = async () => {
			attempts += 1;
			const error = new TypeError("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" };
			throw error;
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: dnsFailFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toBe("fetch failed (ENOTFOUND)");
		}
	});

	it("does not retry on an HTTP error response", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "http-error-session");
		let attempts = 0;
		const erroringFetch: typeof fetch = async () => {
			attempts += 1;
			return new Response(JSON.stringify({ detail: "bad request" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		};

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: erroringFetch,
			reloadConfig: false,
		});

		expect(attempts).toBe(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.statusCode).toBe(400);
		}
	});

	it("previews the current trace without requiring sharing or credentials", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "preview-parent");
		const child = writeSession(cwd, sessionDir, "preview-child", parent.getSessionFile());

		const result = await previewAgentTraceFile({
			sessionFile: child.getSessionFile(),
			baseUrl: "https://api.example.test",
			maxContentChars: 256,
		});

		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result).toMatchObject({
				sessionId: "preview-child",
				traceId: "preview-parent",
				parentSessionId: "preview-parent",
				cwd,
				uploadable: true,
				endpoint: "https://api.example.test/api/v1/agent-traces/sessions/preview-child",
				truncated: true,
			});
			expect(result.contentPreview).toContain("middle of trace omitted");
			expect(result.contentPreview).toContain("preview-child");
		}
	});

	it("discovers and uploads saved parent and subagent traces", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "all-parent");
		const childDir = join(tempDir, "session-artifacts", "all-parent", "sub-12345678");
		const child = writeSession(cwd, childDir, "all-child", parent.getSessionFile());
		const grandchildDir = join(childDir, "sub-87654321");
		const grandchild = writeSession(cwd, grandchildDir, "all-grandchild", child.getSessionFile());
		writeFileSync(join(childDir, "not-a-session.jsonl"), '{"type":"diagnostic"}\n');

		const discovered = await findAgentTraceFiles(sessionDir);
		expect(discovered).toEqual([child.getSessionFile(), grandchild.getSessionFile(), parent.getSessionFile()].sort());

		vi.useFakeTimers();
		const calls: FetchCall[] = [];
		let resolveFirstCompletion: () => void = () => {};
		const firstCompletion = new Promise<void>((resolve) => {
			resolveFirstCompletion = resolve;
		});
		const progress: Array<{ completed: number; total: number }> = [];
		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
			concurrency: 0.5,
			onProgress: ({ completed, total }) => {
				progress.push({ completed, total });
				if (completed === 1) {
					resolveFirstCompletion();
				}
			},
		});
		await firstCompletion;
		await advanceTimersUntil(() => calls.length === 3);
		const result = await upload;

		expect(result).toMatchObject({ total: 3, uploaded: 3, failed: 0, skipped: 0, bytesStored: 369 });
		expect(calls.map((call) => call.url).sort()).toEqual(
			[
				"https://api.example.test/api/v1/agent-traces/sessions/all-child",
				"https://api.example.test/api/v1/agent-traces/sessions/all-grandchild",
				"https://api.example.test/api/v1/agent-traces/sessions/all-parent",
			].sort(),
		);
		const grandchildCall = calls.find((call) => call.url.endsWith("/all-grandchild"));
		const grandchildHeaders = new Headers(grandchildCall?.init.headers);
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
		let markFirstRequestStarted: () => void = () => {};
		const firstRequestStarted = new Promise<void>((resolve) => {
			markFirstRequestStarted = resolve;
		});
		const requestStarts: number[] = [];
		const fetchFn: typeof fetch = async () => {
			requestStarts.push(Date.now());
			if (requestStarts.length === 1) {
				markFirstRequestStarted();
			}
			return new Response(JSON.stringify({ bytes_stored: 1 }), { status: 200 });
		};

		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
		});

		await firstRequestStarted;
		await advanceTimersUntil(() => requestStarts.length === 6);
		const result = await upload;
		expect(result).toMatchObject({ total: 6, uploaded: 6, failed: 0, skipped: 0 });
		expect(requestStarts).toHaveLength(6);
		for (let index = 1; index < requestStarts.length; index += 1) {
			expect(requestStarts[index]! - requestStarts[index - 1]!).toBeGreaterThanOrEqual(12_000);
		}
		expect(requestStarts[5]! - requestStarts[0]!).toBeGreaterThanOrEqual(60_000);
	});

	it("stops scheduling batch uploads after cancellation", async () => {
		const sessionDir = join(tempDir, "sessions");
		writeSession(tempDir, sessionDir, "abort-all-a");
		writeSession(tempDir, sessionDir, "abort-all-b");
		writeSession(tempDir, sessionDir, "abort-all-c");
		const controller = new AbortController();
		const calls: FetchCall[] = [];

		const result = await uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
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
		const abortReason = new Error("cancel in-flight batch");
		vi.useFakeTimers();
		let markFirstRequestStarted: () => void = () => {};
		const firstRequestStarted = new Promise<void>((resolve) => {
			markFirstRequestStarted = resolve;
		});
		let attempts = 0;
		const fetchFn: typeof fetch = async (_input, init) => {
			attempts += 1;
			if (attempts === 1) {
				markFirstRequestStarted();
			}
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				if (attempts === 2) {
					queueMicrotask(() => controller.abort(abortReason));
				}
			});
		};

		const upload = uploadAllAgentTraces({
			sessionDir,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			requireEnabled: false,
			baseUrl: "https://api.example.test",
			fetchFn,
			reloadConfig: false,
			concurrency: 2,
			signal: controller.signal,
		});
		await firstRequestStarted;
		await advanceTimersUntil(() => attempts === 2);
		const result = await upload;

		expect(attempts).toBe(2);
		expect(result).toMatchObject({ total: 3, uploaded: 0, failed: 0, skipped: 3 });
		expect(result.results).toHaveLength(0);
	});

	it("durably records upload intent on disk before any upload happens", async () => {
		vi.useFakeTimers();
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "unflushed-session" });

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		// Synchronously durable: the intent marker is on disk the moment the persist returns.
		expect(readOutboxEntry(tempDir, sessionFile as string)).toEqual({ sessionFile });
		expect(calls).toHaveLength(0);
	});

	it("catch-up uploads exactly the content a previous process never uploaded, then goes quiet", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const missed = writeSession(cwd, sessionDir, "crash-lost-session");
		const missedFile = missed.getSessionFile() as string;
		writeOutboxEntry(tempDir, missedFile);

		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		};

		const first = await catchUpAgentTraceUploads(options);
		expect(first.results.map(({ result }) => result.status)).toEqual(["uploaded"]);
		expect(calls).toHaveLength(1);
		expect(calls[0].init.body).toBe(readFileSync(missedFile, "utf8"));
		const stats = await stat(missedFile);
		expect(readOutboxEntry(tempDir, missedFile)).toEqual({
			sessionFile: missedFile,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});

		// Unchanged content: subsequent cycles and restarts never re-POST.
		const second = await catchUpAgentTraceUploads(options);
		expect(second.results).toEqual([]);
		const automatic = await uploadAgentTraceFile({ ...options, sessionFile: missedFile });
		expect(automatic).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(1);
	});

	it("prunes cursor entries whose session file was deleted", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const kept = writeSession(cwd, sessionDir, "kept-session");
		const keptFile = kept.getSessionFile() as string;
		const keptStats = await stat(keptFile);
		const keptSignature = { size: keptStats.size, mtimeMs: keptStats.mtimeMs };
		const deletedFile = join(sessionDir, "deleted-session.jsonl");
		writeOutboxEntry(tempDir, deletedFile);
		writeOutboxEntry(tempDir, keptFile, keptSignature);

		const calls: FetchCall[] = [];
		const result = await catchUpAgentTraceUploads({
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ pruned: 1, results: [] });
		expect(calls).toHaveLength(0);
		expect(existsSync(outboxEntryPath(tempDir, deletedFile))).toBe(false);
		expect(readOutboxEntry(tempDir, keptFile)).toEqual({ sessionFile: keptFile, ...keptSignature });
	});

	it("arms upload timers that never hold the process open", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "unref-session" });

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
		expect(timer.hasRef()).toBe(false);
	});

	it("honors an advertised Retry-After on the next scheduled cycle without blocking", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "retry-after-reschedule-session" });

		let attempts = 0;
		const calls: FetchCall[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(null, { status: 429, headers: { "retry-after": "300" } });
			}
			return createFetchRecorder(calls)(input, init);
		};

		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn,
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		sessionManager.appendMessage(createAssistantMessage("hi"));
		await advanceTimersUntil(() => attempts === 1);
		await advanceTimersUntil(() => vi.getTimerCount() > 0);
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBe(300_000);

		// A fresh persist must not re-arm inside the advertised window.
		sessionManager.appendMessage(createUserMessage("more"));
		expect(Number(setTimeoutSpy.mock.calls.at(-1)?.[1])).toBeGreaterThanOrEqual(299_000);

		await advanceTimersUntil(() => calls.length === 1);
		expect(attempts).toBe(2);
	});

	it("returns a retryable failure when the upload cursor cannot be persisted", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "cursor-persist-failure");
		writeFileSync(join(tempDir, "agent-traces-outbox"), "not a directory");

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("cursor");
		}
	});

	it("a corrupt outbox entry costs only itself; other cursors survive", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const kept = writeSession(cwd, sessionDir, "kept-cursor-session");
		const keptFile = kept.getSessionFile() as string;
		const keptStats = await stat(keptFile);
		writeOutboxEntry(tempDir, keptFile, { size: keptStats.size, mtimeMs: keptStats.mtimeMs });
		writeFileSync(join(tempDir, "agent-traces-outbox", "deadbeef.json"), "not json");

		const calls: FetchCall[] = [];
		const options = {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		};

		const result = await catchUpAgentTraceUploads(options);
		expect(result).toEqual({ pruned: 1, results: [] });
		expect(calls).toHaveLength(0);
		expect(existsSync(join(tempDir, "agent-traces-outbox", "deadbeef.json"))).toBe(false);
		expect(await uploadAgentTraceFile({ ...options, sessionFile: keptFile })).toEqual({ status: "unchanged" });
		expect(calls).toHaveLength(0);
	});

	it("prefers the prime-inference credential over the prime-cli config key", async () => {
		const session = writeSession(tempDir, join(tempDir, "sessions"), "credential-order-session");
		const calls: FetchCall[] = [];
		const configPath = join(tempDir, "prime-config.json");
		writeFileSync(configPath, JSON.stringify({ api_key: "cli-fallback-key" }));

		const result = await uploadAgentTraceFile({
			sessionFile: session.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_INFERENCE_PROVIDER_ID]: { type: "api_key", key: "inference-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			configPath,
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result.status).toBe("uploaded");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer inference-key" });
	});
});
