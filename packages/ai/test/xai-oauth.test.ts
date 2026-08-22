import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import {
	getOAuthProvider,
	loginXAIOAuth,
	refreshXAIOAuthToken,
	validateXAIEndpoint,
	XAI_API_BASE_URL,
	XAI_OAUTH_API_HEADERS,
	xaiOAuthProvider,
} from "../src/utils/oauth/index.js";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.js";

const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function textResponse(body: string, status: number): Response {
	return new Response(body, { status });
}

function loginCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: vi.fn(),
		onPrompt: vi.fn(async () => ""),
		onProgress: vi.fn(),
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("validateXAIEndpoint", () => {
	it("accepts https x.ai hosts", () => {
		expect(validateXAIEndpoint("https://auth.x.ai/oauth2/token", "token_endpoint")).toBe(
			"https://auth.x.ai/oauth2/token",
		);
		expect(validateXAIEndpoint("https://accounts.x.ai/verify", "verification_uri")).toBe(
			"https://accounts.x.ai/verify",
		);
	});

	it("rejects non-https and non-x.ai hosts", () => {
		expect(() => validateXAIEndpoint("http://auth.x.ai/oauth2/token", "token_endpoint")).toThrow(
			"Invalid xAI token_endpoint",
		);
		expect(() => validateXAIEndpoint("https://evil.example/oauth2/token", "token_endpoint")).toThrow(
			"Invalid xAI token_endpoint",
		);
	});
});

describe("loginXAIOAuth", () => {
	it("completes the device-code flow and returns credentials", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === DISCOVERY_URL) {
				return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			}
			if (url === DEVICE_CODE_URL) {
				return jsonResponse({
					device_code: "dev-1",
					user_code: "ABCD-1234",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-1234",
					expires_in: 60,
					interval: 0.001,
				});
			}
			if (url === TOKEN_ENDPOINT) {
				const body = String(init?.body ?? "");
				expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				expect(body).toContain("device_code=dev-1");
				return jsonResponse({
					access_token: "access-1",
					refresh_token: "refresh-1",
					expires_in: 3600,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const callbacks = loginCallbacks();
		const credentials = await loginXAIOAuth(callbacks);

		expect(callbacks.onAuth).toHaveBeenCalledWith({
			url: "https://auth.x.ai/device?user_code=ABCD-1234",
			instructions: "Enter code: ABCD-1234",
		});
		expect(credentials.access).toBe("access-1");
		expect(credentials.refresh).toBe("refresh-1");
		expect(credentials.expires).toBeLessThan(Date.now() + 3600 * 1000);
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("retries authorization_pending and slow_down before completing", async () => {
		let tokenPolls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === DISCOVERY_URL) {
				return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			}
			if (url === DEVICE_CODE_URL) {
				return jsonResponse({
					device_code: "dev-2",
					user_code: "WXYZ-9999",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?user_code=WXYZ-9999",
					expires_in: 60,
					interval: 0.001,
				});
			}
			if (url === TOKEN_ENDPOINT) {
				tokenPolls += 1;
				if (tokenPolls === 1) {
					return jsonResponse({ error: "authorization_pending" }, 400);
				}
				if (tokenPolls === 2) {
					return jsonResponse({ error: "slow_down" }, 400);
				}
				return jsonResponse({
					access_token: "access-2",
					refresh_token: "refresh-2",
					expires_in: 1800,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginXAIOAuth(loginCallbacks());
		expect(tokenPolls).toBe(3);
		expect(credentials.access).toBe("access-2");
	});

	it("rejects a discovered token endpoint off the x.ai host", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (String(input) === DISCOVERY_URL) {
					return jsonResponse({ token_endpoint: "https://evil.example/token" });
				}
				throw new Error(`unexpected fetch: ${String(input)}`);
			}),
		);

		await expect(loginXAIOAuth(loginCallbacks())).rejects.toThrow("Invalid xAI token_endpoint");
	});

	it("cancels while waiting for the user", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url === DISCOVERY_URL) {
					return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
				}
				if (url === DEVICE_CODE_URL) {
					controller.abort();
					return jsonResponse({
						device_code: "dev-3",
						user_code: "CANCEL",
						verification_uri: "https://auth.x.ai/device",
						verification_uri_complete: "https://auth.x.ai/device?user_code=CANCEL",
						expires_in: 60,
						interval: 1,
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		await expect(loginXAIOAuth(loginCallbacks({ signal: controller.signal }))).rejects.toThrow("Login cancelled");
	});
});

describe("refreshXAIOAuthToken", () => {
	it("refreshes via the discovered token endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === DISCOVERY_URL) {
				return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
			}
			if (url === TOKEN_ENDPOINT) {
				expect(String(init?.body ?? "")).toContain("grant_type=refresh_token");
				expect(String(init?.body ?? "")).toContain("refresh_token=old-refresh");
				return jsonResponse({
					access_token: "new-access",
					expires_in: 1200,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXAIOAuthToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("old-refresh");
	});

	it("surfaces refresh failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (String(input) === DISCOVERY_URL) {
					return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
				}
				return textResponse("invalid_grant", 400);
			}),
		);

		await expect(refreshXAIOAuthToken("dead")).rejects.toThrow("xAI token refresh failed: 400 invalid_grant");
	});
});

describe("xaiOAuthProvider", () => {
	it("is registered as a built-in OAuth provider", () => {
		expect(getOAuthProvider("xai-oauth")).toBe(xaiOAuthProvider);
		expect(xaiOAuthProvider.id).toBe("xai-oauth");
	});

	it("returns the access token as the API key", () => {
		expect(xaiOAuthProvider.getApiKey({ access: "tok", refresh: "ref", expires: 1 })).toBe("tok");
	});

	it("pins SuperGrok models to the OpenAI-compatible xAI endpoint", () => {
		const models = xaiOAuthProvider.modifyModels!(
			[
				{
					id: "grok-4.3",
					name: "Grok 4.3",
					api: "openai-completions",
					provider: "xai-oauth",
					baseUrl: "",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				},
				getModel("xai", "grok-4.3"),
			],
			{ access: "tok", refresh: "ref", expires: 1 },
		);

		expect(models[0]?.baseUrl).toBe(XAI_API_BASE_URL);
		expect(models[0]?.headers).toMatchObject(XAI_OAUTH_API_HEADERS);
		expect(models[1]?.provider).toBe("xai");
		expect(models[1]?.headers?.["X-XAI-Token-Auth"]).toBeUndefined();
	});
});

describe("xai-oauth catalog", () => {
	it("exposes Grok models on the OpenAI completions API", () => {
		const model = getModel("xai-oauth", "grok-4.6");
		expect(model.id).toBe("grok-4.6");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("xai-oauth");
		expect(model.baseUrl).toBe(XAI_API_BASE_URL);
		expect(model.headers).toMatchObject(XAI_OAUTH_API_HEADERS);
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(500000);
	});
});
