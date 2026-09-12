import { Buffer } from "node:buffer";
import { constants, publicEncrypt } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPrimeAgentTracesAccess,
	checkPrimeInferenceAccess,
	fetchPrimeTeams,
	loadPrimeCliConfig,
	loginPrimeAgentTraces,
	loginPrimeInference,
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
		if (originalTraceBaseUrl === undefined) {
			delete process.env.PRIME_AGENT_TRACES_BASE_URL;
		} else {
			process.env.PRIME_AGENT_TRACES_BASE_URL = originalTraceBaseUrl;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("loads Prime CLI config with defaults", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "prime-key",
				base_url: "https://prime-api.example/api/v1",
				frontend_url: "https://prime-app.example/",
			}),
		);

		expect(loadPrimeCliConfig(configPath)).toEqual({
			apiKey: "prime-key",
			baseUrl: "https://prime-api.example",
			frontendUrl: "https://prime-app.example",
			inferenceUrl: "https://api.pinference.ai/api/v1",
			path: configPath,
			teamIdFromEnv: false,
		});
	});

	it("loads Prime CLI team selection", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "prime-key",
				team_id: "team-1",
				team_name: "Research",
				team_role: "admin",
			}),
		);

		expect(loadPrimeCliConfig(configPath)).toMatchObject({
			apiKey: "prime-key",
			teamId: "team-1",
			teamName: "Research",
			teamRole: "admin",
			teamIdFromEnv: false,
		});
	});

	it("lets PRIME_TEAM_ID override Prime CLI team selection", () => {
		const originalTeamId = process.env.PRIME_TEAM_ID;
		process.env.PRIME_TEAM_ID = "env-team";
		writeFileSync(
			configPath,
			JSON.stringify({
				team_id: "file-team",
				team_name: "Research",
				team_role: "admin",
			}),
		);

		try {
			expect(loadPrimeCliConfig(configPath)).toMatchObject({
				teamId: "env-team",
				teamIdFromEnv: true,
			});
			expect(loadPrimeCliConfig(configPath).teamName).toBeUndefined();
		} finally {
			if (originalTeamId === undefined) {
				delete process.env.PRIME_TEAM_ID;
			} else {
				process.env.PRIME_TEAM_ID = originalTeamId;
			}
		}
	});

	it("fetches Prime teams across paginated responses", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestedUrls.push(getUrl(input));
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			if (requestedUrls.length === 1) {
				return jsonResponse({
					data: [{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
					total_count: 2,
				});
			}
			return jsonResponse({
				data: [{ teamId: "team-2", name: "Infra", slug: "infra", role: "member" }],
				total_count: 2,
			});
		});

		await expect(
			fetchPrimeTeams("prime-key", "https://prime-api.example/api/v1", { fetchFn: fetchMock }),
		).resolves.toEqual([
			{ teamId: "team-1", name: "Research", slug: "research", role: "admin" },
			{ teamId: "team-2", name: "Infra", slug: "infra", role: "member" },
		]);
		expect(requestedUrls).toEqual([
			"https://prime-api.example/api/v1/user/teams?offset=0&limit=100",
			"https://prime-api.example/api/v1/user/teams?offset=100&limit=100",
		]);
	});

	it("checks Prime Inference access with Prime whoami permissions", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://prime-api.example/api/v1/user/whoami");
			expect(init?.method).toBe("GET");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { inference: { read: true, write: true } } } });
		});

		await expect(
			checkPrimeInferenceAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("checks Prime Agent trace access with Prime whoami permissions", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://prime-api.example/api/v1/user/whoami");
			expect(init?.method).toBe("GET");
			expect(getAuthorization(init)).toBe("Bearer prime-key");
			return jsonResponse({ data: { scope: { agent_traces: { read: true, write: true } } } });
		});

		await expect(
			checkPrimeAgentTracesAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("validates imported Prime CLI trace credentials against the production trace API by default", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "prime-cli-key",
				base_url: "https://api.primeintellect.ai/api/v1",
			}),
		);
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
			expect(getAuthorization(init)).toBe("Bearer prime-cli-key");
			return jsonResponse({ data: { scope: { agent_traces: { write: true } } } });
		});
		const onAuth = vi.fn();

		const result = await loginPrimeAgentTraces(
			{ onAuth },
			{ configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 },
		);

		expect(result).toEqual({ apiKey: "prime-cli-key", source: "prime-cli" });
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("does not import production CLI credentials into an explicit trace target", async () => {
		process.env.PRIME_AGENT_TRACES_BASE_URL = "https://trace-api.example/api/v1";
		writeFileSync(configPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://trace-api.example/api/v1/auth_challenge/generate");
			expect(getAuthorization(init)).toBeUndefined();
			throw new Error("stop before browser");
		});
		await expect(loginPrimeAgentTraces({ onAuth: vi.fn() }, { configPath, fetchFn: fetchMock })).rejects.toThrow(
			"stop before browser",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("throws contextual errors for invalid Prime whoami JSON", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			return new Response("not json", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			checkPrimeInferenceAccess("prime-key", "https://prime-api.example", { fetchFn: fetchMock }),
		).rejects.toThrow("Prime whoami returned an invalid response");
	});

	it("imports a valid Prime CLI key", async () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
			expect(getAuthorization(init)).toBe("Bearer prime-cli-key");
			return jsonResponse({ data: { scope: { inference: { write: true } } } });
		});
		const onAuth = vi.fn();

		const result = await loginPrimeInference({ onAuth }, { configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 });

		expect(result).toEqual({ apiKey: "prime-cli-key", source: "prime-cli", primeTeam: null });
		expect(onAuth).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
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
				{
					onAuth: () => {},
					signal: controller.signal,
				},
				{ configPath, fetchFn: fetchMock, requestTimeoutMs: 1000 },
			),
		).rejects.toThrow("Login cancelled");
	});

	it("falls back to browser login when the Prime CLI key cannot access inference", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				api_key: "old-key",
				base_url: "https://api.primeintellect.ai",
				frontend_url: "https://app.primeintellect.ai",
				inference_url: "https://api.pinference.ai/api/v1",
			}),
		);
		let challengePublicKey = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.primeintellect.ai/api/v1/user/whoami") {
				const auth = getAuthorization(init);
				if (auth === "Bearer old-key") {
					return jsonResponse({ data: { scope: { inference: { read: true, write: false } } } });
				}
				if (auth === "Bearer browser-key") {
					return jsonResponse({ data: { scope: { inference: { read: true, write: true } } } });
				}
			}
			if (url === "https://api.primeintellect.ai/api/v1/auth_challenge/generate") {
				challengePublicKey = String(getJsonBody(init).encryptionPublicKey);
				return jsonResponse({ challenge: "challenge-code", status_auth_token: "status-token" });
			}
			if (url.startsWith("https://api.primeintellect.ai/api/v1/auth_challenge/status")) {
				expect(getAuthorization(init)).toBe("Bearer status-token");
				return jsonResponse({ result: encryptChallengeResult(challengePublicKey, "browser-key") });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		const onAuth = vi.fn();
		const progress: string[] = [];

		const result = await loginPrimeInference(
			{
				onAuth,
				onProgress: (message) => progress.push(message),
			},
			{ configPath, fetchFn: fetchMock, pollIntervalMs: 0, requestTimeoutMs: 1000 },
		);

		expect(result).toEqual({ apiKey: "browser-key", source: "browser" });
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://app.primeintellect.ai/dashboard/tokens/challenge?code=challenge-code",
			instructions: "Code: challenge-code",
		});
		expect(progress.join("\n")).toContain("Existing Prime CLI key cannot access Prime Inference");
	});

	it("requests agent trace scope during Prime Agent trace browser login", async () => {
		process.env.PRIME_AGENT_TRACES_BASE_URL = "https://prime-api.example/api/v1";
		writeFileSync(
			configPath,
			JSON.stringify({
				base_url: "https://prime-api.example",
				frontend_url: "https://prime-app.example",
			}),
		);
		let challengePublicKey = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://prime-api.example/api/v1/auth_challenge/generate") {
				challengePublicKey = String(getJsonBody(init).encryptionPublicKey);
				return jsonResponse({ challenge: "challenge-code", status_auth_token: "status-token" });
			}
			if (url.startsWith("https://prime-api.example/api/v1/auth_challenge/status")) {
				expect(getAuthorization(init)).toBe("Bearer status-token");
				return jsonResponse({ result: encryptChallengeResult(challengePublicKey, "trace-key") });
			}
			if (url === "https://prime-api.example/api/v1/user/whoami") {
				expect(getAuthorization(init)).toBe("Bearer trace-key");
				return jsonResponse({ data: { scope: { agent_traces: { read: true, write: true } } } });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		const onAuth = vi.fn();

		const result = await loginPrimeAgentTraces(
			{
				onAuth,
			},
			{ configPath, fetchFn: fetchMock, pollIntervalMs: 0, requestTimeoutMs: 1000 },
		);

		expect(result).toEqual({ apiKey: "trace-key", source: "browser" });
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://app.primeintellect.ai/dashboard/tokens/challenge?code=challenge-code&scope=agent_traces",
			instructions: "Code: challenge-code",
		});
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
