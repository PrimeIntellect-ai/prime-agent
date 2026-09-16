import { Buffer } from "node:buffer";
import { constants, publicEncrypt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPrimeAgentTracesAccess,
	checkPrimeInferenceAccess,
	loginPrimeAgentTraces,
	loginPrimeInference,
	resolvePrimeInferenceAuthConfig,
} from "../src/core/prime-inference-auth.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function getJsonBody(init?: RequestInit): Record<string, unknown> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, unknown>;
}

function getAuthorization(init?: RequestInit): string | undefined {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers)) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get("Authorization") ?? undefined;
	}
	const headerRecord = headers as Record<string, string | undefined>;
	return headerRecord.Authorization ?? headerRecord.authorization;
}

/** One browser-challenge login flow: which endpoints answer, and with what key. */
type BrowserChallengeCase = {
	config: Record<string, string>;
	apiBase: string;
	key: string;
	scope: Record<string, { read: boolean; write: boolean }>;
	authUrl: string;
	/** An already-present CLI key that lacks the required permission. */
	staleKey?: string;
	traceBaseUrl?: string;
};

function encryptChallengeResult(publicKey: string, value: string): string {
	return publicEncrypt(
		{
			key: publicKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(value, "utf-8"),
	).toString("base64");
}

describe("Prime Inference auth", () => {
	let tempDir: string;
	let configPath: string;
	let originalTraceBaseUrl: string | undefined;

	beforeEach(() => {
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "");
		tempDir = join(tmpdir(), `pi-prime-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		configPath = join(tempDir, "config.json");
		originalTraceBaseUrl = process.env.PRIME_AGENT_TRACES_BASE_URL;
		delete process.env.PRIME_AGENT_TRACES_BASE_URL;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (originalTraceBaseUrl === undefined) {
			delete process.env.PRIME_AGENT_TRACES_BASE_URL;
		} else {
			process.env.PRIME_AGENT_TRACES_BASE_URL = originalTraceBaseUrl;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	it("imports the production CLI file team without changing it or applying PRIME_TEAM_ID", async () => {
		vi.stubEnv("PRIME_TEAM_ID", "env-team");
		const original = JSON.stringify({
			api_key: "prime-key",
			base_url: "https://api.primeintellect.ai/api/v1/",
			frontend_url: "https://app.primeintellect.ai/",
			inference_url: "https://api.pinference.ai/api/v1/",
			team_id: "file-team",
			team_name: "Research",
			team_role: "admin",
		});
		writeFileSync(configPath, original);
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { inference: { write: true } } } });
		});
		const onAuth = vi.fn();

		await expect(loginPrimeInference({ onAuth }, { configPath, fetchFn: fetchMock })).resolves.toEqual({
			apiKey: "prime-key",
			source: "prime-cli",
			primeTeam: { teamId: "file-team", name: "Research", role: "admin" },
		});
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	it.each([
		[
			"inference",
			loginPrimeInference,
			{ inference: { write: true } },
			{ apiKey: "prime-cli-key", source: "prime-cli", primeTeam: null },
		],
		[
			"agent traces",
			loginPrimeAgentTraces,
			{ agent_traces: { write: true } },
			{ apiKey: "prime-cli-key", source: "prime-cli" },
		],
	] as const)(
		"imports a valid Prime CLI key for %s against the production API",
		async (_label, login, scope, expected) => {
			writeFileSync(
				configPath,
				JSON.stringify({ api_key: "prime-cli-key", base_url: "https://api.primeintellect.ai/api/v1" }),
			);
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
				expect(getAuthorization(init)).toBe("Bearer prime-cli-key");
				return jsonResponse({ data: { scope } });
			});
			const onAuth = vi.fn();

			await expect(login({ onAuth }, { configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 })).resolves.toEqual(
				expected,
			);
			expect(onAuth).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["inference", checkPrimeInferenceAccess, { inference: { read: true, write: true } }],
		["agent traces", checkPrimeAgentTracesAccess, { agent_traces: { read: true, write: true } }],
	] as const)("checks %s access with Prime whoami permissions", async (_label, check, scope) => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://prime-api.example/api/v1/user/whoami");
			expect(init?.method).toBe("GET");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope } });
		});

		await expect(check("prime-key", "https://prime-api.example", { fetchFn: fetchMock })).resolves.toEqual({
			ok: true,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"PRIME_AGENT_INFERENCE_API_BASE_URL",
			"https://custom.example/api/v1/",
			loginPrimeInference,
			"https://custom.example",
		],
		[
			"PRIME_AGENT_INFERENCE_FRONTEND_URL",
			"https://custom.example/",
			loginPrimeInference,
			"https://api.primeintellect.ai",
		],
		[
			"PRIME_AGENT_TRACES_BASE_URL",
			"https://custom.example/api/v1/",
			loginPrimeAgentTraces,
			"https://custom.example",
		],
	] as const)("does not import CLI credentials with %s", async (env, value, login, baseUrl) => {
		vi.stubEnv(env, value);
		writeFileSync(configPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(`${baseUrl}/api/v1/auth_challenge/generate`);
			expect(getAuthorization(init)).toBeUndefined();
			throw new Error("stop before browser");
		});
		await expect(login({ onAuth: vi.fn() }, { configPath, fetchFn: fetchMock })).rejects.toThrow(
			"stop before browser",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		{ base_url: "https://dev.example" },
		{ frontend_url: "https://dev.example" },
		{ inference_url: "https://dev.example" },
		{ base_url: null },
	])("rejects ineligible CLI URLs %j without sending its key", async (urls) => {
		const original = JSON.stringify({ api_key: "dev-key", ...urls });
		writeFileSync(configPath, original);
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/auth_challenge/generate");
			expect(getAuthorization(init)).toBeUndefined();
			throw new Error("stop before browser");
		});
		await expect(loginPrimeInference({ onAuth: vi.fn() }, { configPath, fetchFn: fetchMock })).rejects.toThrow(
			"stop before browser",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	it("normalizes Agent-only auth endpoints independently of unrelated settings", () => {
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "  ");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "  ");
		vi.stubEnv("PRIME_API_BASE_URL", "https://unrelated.example");
		vi.stubEnv("PRIME_AGENT_TRACES_BASE_URL", "https://traces.example");
		expect(resolvePrimeInferenceAuthConfig()).toEqual({
			baseUrl: "https://api.primeintellect.ai",
			frontendUrl: "https://app.primeintellect.ai",
		});
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", " https://custom.example/api/v1/ ");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", " https://app.example/ ");
		expect(resolvePrimeInferenceAuthConfig()).toEqual({
			baseUrl: "https://custom.example",
			frontendUrl: "https://app.example",
		});
	});

	it("honors cancellation before returning an imported Prime CLI key", async () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const controller = new AbortController();
		const fetchMock = vi.fn(async (): Promise<Response> => {
			const response = jsonResponse({ data: { scope: { inference: { write: true } } } });
			vi.spyOn(response, "json").mockImplementation(async () => {
				controller.abort();
				return { data: { scope: { inference: { write: true } } } };
			});
			return response;
		});

		await expect(
			loginPrimeInference(
				{ onAuth: () => {}, signal: controller.signal },
				{ configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 },
			),
		).rejects.toThrow("Login cancelled");
	});

	it.each<[string, typeof loginPrimeInference | typeof loginPrimeAgentTraces, BrowserChallengeCase]>([
		[
			"inference",
			loginPrimeInference,
			{
				config: {
					api_key: "old-key",
					base_url: "https://api.primeintellect.ai",
					frontend_url: "https://app.primeintellect.ai",
					inference_url: "https://api.pinference.ai/api/v1",
				},
				apiBase: "https://api.primeintellect.ai",
				staleKey: "old-key",
				key: "browser-key",
				scope: { inference: { read: true, write: true } },
				authUrl: "https://app.primeintellect.ai/dashboard/tokens/challenge?code=challenge-code",
			},
		],
		[
			"agent traces",
			loginPrimeAgentTraces,
			{
				config: { base_url: "https://prime-api.example", frontend_url: "https://prime-app.example" },
				apiBase: "https://prime-api.example",
				traceBaseUrl: "https://prime-api.example/api/v1",
				key: "trace-key",
				scope: { agent_traces: { read: true, write: true } },
				authUrl: "https://app.primeintellect.ai/dashboard/tokens/challenge?code=challenge-code&scope=agent_traces",
			},
		],
	])("runs the %s browser challenge when the CLI key cannot be used", async (_label, login, options) => {
		if (options.traceBaseUrl) {
			process.env.PRIME_AGENT_TRACES_BASE_URL = options.traceBaseUrl;
		}
		writeFileSync(configPath, JSON.stringify(options.config));
		let challengePublicKey = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === `${options.apiBase}/api/v1/user/whoami`) {
				const auth = getAuthorization(init);
				// A stale CLI key without inference write must not short-circuit the challenge.
				if (options.staleKey && auth === `Bearer ${options.staleKey}`) {
					return jsonResponse({ data: { scope: { inference: { read: true, write: false } } } });
				}
				expect(auth).toBe(`Bearer ${options.key}`);
				return jsonResponse({ data: { scope: options.scope } });
			}
			if (url === `${options.apiBase}/api/v1/auth_challenge/generate`) {
				challengePublicKey = String(getJsonBody(init).encryptionPublicKey);
				return jsonResponse({ challenge: "challenge-code", status_auth_token: "status-token" });
			}
			if (url.startsWith(`${options.apiBase}/api/v1/auth_challenge/status`)) {
				expect(getAuthorization(init)).toBe("Bearer status-token");
				return jsonResponse({ result: encryptChallengeResult(challengePublicKey, options.key) });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		const onAuth = vi.fn();

		const result = await login(
			{ onAuth },
			{ configPath, fetchFn: fetchMock, pollIntervalMs: 0, requestTimeoutMs: 1000 },
		);

		expect(result).toEqual({ apiKey: options.key, source: "browser" });
		expect(onAuth).toHaveBeenCalledWith({ url: options.authUrl, instructions: "Code: challenge-code" });
	});

	it("rejects an expired browser challenge", async () => {
		writeFileSync(configPath, JSON.stringify({ base_url: "https://api.primeintellect.ai" }));
		const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.primeintellect.ai/api/v1/auth_challenge/generate") {
				return jsonResponse({ challenge: "challenge-code", status_auth_token: "status-token" });
			}
			if (url.startsWith("https://api.primeintellect.ai/api/v1/auth_challenge/status")) {
				return new Response("expired", { status: 404 });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		await expect(
			loginPrimeInference({ onAuth: () => {} }, { configPath, fetchFn: fetchMock, pollIntervalMs: 0 }),
		).rejects.toThrow("Prime login challenge expired");
	});
});
