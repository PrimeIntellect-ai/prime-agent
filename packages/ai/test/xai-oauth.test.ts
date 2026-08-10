import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.js";
import { applyXaiOAuthModels, loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		device_code: "device-code",
		user_code: "ZZFP-2324",
		verification_uri: "https://accounts.x.ai/oauth2/device",
		verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ZZFP-2324",
		expires_in: 1800,
		interval: 5,
		...overrides,
	});
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		token_type: "Bearer",
		...overrides,
	});
}

function stubFetchRouter(tokenResponses: Response[], deviceResponse: Response = deviceCodeResponse()) {
	const tokenPollTimes: number[] = [];
	const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = getUrl(input);
		if (url === DEVICE_CODE_URL) {
			expect(init?.method).toBe("POST");
			expect(String(init?.body)).toContain("client_id=");
			expect(String(init?.body)).toContain("scope=");
			return deviceResponse;
		}
		if (url === TOKEN_URL) {
			tokenPollTimes.push(Date.now());
			expect(String(init?.body)).toContain("device_code=device-code");
			expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
			const response = tokenResponses.shift();
			if (!response) throw new Error("Unexpected extra token poll");
			return response;
		}
		throw new Error(`Unexpected fetch URL: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, tokenPollTimes };
}

describe("xAI OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("completes the device flow and surfaces the prefilled verification URL", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		stubFetchRouter([tokenResponse()]);

		const authInfos: { url: string; instructions?: string }[] = [];
		const loginPromise = loginXai({
			onAuth: (info) => authInfos.push(info),
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(5000);
		const credentials = await loginPromise;

		expect(authInfos).toHaveLength(1);
		expect(authInfos[0].url).toBe("https://accounts.x.ai/oauth2/device?user_code=ZZFP-2324");
		expect(authInfos[0].instructions).toContain("ZZFP-2324");
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBe(Date.now() + 3600 * 1000 - 5 * 60 * 1000);
	});

	it("falls back to the plain verification URL when the prefilled one is missing", async () => {
		vi.useFakeTimers();
		stubFetchRouter([tokenResponse()], deviceCodeResponse({ verification_uri_complete: undefined }));

		const authInfos: { url: string }[] = [];
		const loginPromise = loginXai({
			onAuth: (info) => authInfos.push(info),
			onPrompt: async () => "",
		});
		await vi.advanceTimersByTimeAsync(5000);
		await loginPromise;

		expect(authInfos[0].url).toBe("https://accounts.x.ai/oauth2/device");
	});

	it("waits before the first poll, keeps polling through authorization_pending, and bumps the interval on slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);
		const { tokenPollTimes } = stubFetchRouter([
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse({ error: "authorization_pending" }, 400),
			tokenResponse(),
		]);

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });

		await vi.advanceTimersByTimeAsync(4999);
		expect(tokenPollTimes).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(tokenPollTimes).toHaveLength(1);

		// pending: keep the 5s cadence
		await vi.advanceTimersByTimeAsync(5000);
		expect(tokenPollTimes).toHaveLength(2);

		// slow_down with interval=10: next wait is max(10, 5 + 5) = 10s
		await vi.advanceTimersByTimeAsync(9999);
		expect(tokenPollTimes).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(tokenPollTimes).toHaveLength(3);

		await vi.advanceTimersByTimeAsync(10000);
		await loginPromise;

		expect(tokenPollTimes).toEqual([
			startTime.getTime() + 5000,
			startTime.getTime() + 10000,
			startTime.getTime() + 20000,
			startTime.getTime() + 30000,
		]);
	});

	it("increases the interval by at least five seconds when slow_down has no interval", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);
		const { tokenPollTimes } = stubFetchRouter([jsonResponse({ error: "slow_down" }, 400), tokenResponse()]);

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });

		await vi.advanceTimersByTimeAsync(5000);
		expect(tokenPollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(9999);
		expect(tokenPollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;

		expect(tokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);
	});

	it("fails when the user denies the authorization", async () => {
		vi.useFakeTimers();
		stubFetchRouter([jsonResponse({ error: "access_denied" }, 400)]);

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });
		const assertion = expect(loginPromise).rejects.toThrow("xAI device authorization was denied");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("fails when the device code expires", async () => {
		vi.useFakeTimers();
		stubFetchRouter([jsonResponse({ error: "expired_token" }, 400)]);

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });
		const assertion = expect(loginPromise).rejects.toThrow("xAI device code expired");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("stops polling at the device code deadline", async () => {
		vi.useFakeTimers();
		const { tokenPollTimes } = stubFetchRouter(
			[jsonResponse({ error: "authorization_pending" }, 400)],
			deviceCodeResponse({ expires_in: 8 }),
		);

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });
		const assertion = expect(loginPromise).rejects.toThrow("xAI device code expired");
		await vi.advanceTimersByTimeAsync(8000);
		await assertion;
		expect(tokenPollTimes).toHaveLength(1);
	});

	it("cancels polling when the abort signal fires", async () => {
		vi.useFakeTimers();
		stubFetchRouter([]);
		const controller = new AbortController();

		const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "", signal: controller.signal });
		const assertion = expect(loginPromise).rejects.toThrow("Login cancelled");
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		await assertion;
	});

	it("surfaces device authorization errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_client", error_description: "unknown client" }, 401)),
		);

		await expect(loginXai({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"xAI OAuth device authorization failed (HTTP 401): invalid_client: unknown client",
		);
	});

	it("rejects non-HTTPS verification URLs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					device_code: "device-code",
					user_code: "ZZFP-2324",
					verification_uri: "http://accounts.x.ai/oauth2/device",
					expires_in: 1800,
					interval: 5,
				}),
			),
		);

		await expect(loginXai({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"non-HTTPS verification_uri",
		);
	});
});

describe("xAI OAuth token refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("refreshes and keeps a rotated refresh token", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			expect(String(init?.body)).toContain("grant_type=refresh_token");
			expect(String(init?.body)).toContain("refresh_token=old-refresh");
			return tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXaiToken("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("new-refresh");
		expect(credentials.expires).toBe(Date.now() + 3600 * 1000 - 5 * 60 * 1000);
	});

	it("keeps the previous refresh token when the response does not rotate it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => tokenResponse({ access_token: "new-access", refresh_token: undefined })),
		);

		const credentials = await refreshXaiToken("old-refresh");
		expect(credentials.refresh).toBe("old-refresh");
	});

	it("tells the user to log in again when the refresh token is revoked", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "revoked" }, 400)),
		);

		await expect(refreshXaiToken("revoked-refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): invalid_grant: revoked. Run /login and sign in to xAI again.",
		);
	});

	it("keeps upstream details for other refresh failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "server_error" }, 500)),
		);

		await expect(refreshXaiToken("refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 500): server_error",
		);
	});
});

describe("xAI OAuth model modification", () => {
	function xaiModel(overrides: Partial<Model<"openai-completions">> = {}): Model<Api> {
		return {
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 500000,
			...overrides,
		} as Model<Api>;
	}

	it("moves xAI chat-completions models to the Responses API", () => {
		const [model] = applyXaiOAuthModels([xaiModel()]);
		expect(model.api).toBe("openai-responses");
		expect(model.provider).toBe("xai");
		expect(model.baseUrl).toBe("https://api.x.ai/v1");
		expect(model.compat).toEqual({ supportsLongCacheRetention: false });
	});

	it("disables the off and minimal thinking levels for reasoning models", () => {
		const [model] = applyXaiOAuthModels([xaiModel()]);
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null });
	});

	it("leaves non-reasoning models without a thinking level map", () => {
		const [model] = applyXaiOAuthModels([xaiModel({ id: "grok-code-fast-1", reasoning: false })]);
		expect(model.api).toBe("openai-responses");
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("does not touch other providers or non-completions models", () => {
		const other: Model<Api> = xaiModel({ provider: "openai" } as Partial<Model<"openai-completions">>);
		const custom: Model<Api> = { ...xaiModel(), api: "openai-responses" } as Model<Api>;
		const [unchangedOther, unchangedCustom] = applyXaiOAuthModels([other, custom]);
		expect(unchangedOther).toBe(other);
		expect(unchangedCustom).toBe(custom);
	});

	it("registers the provider with the shared xai id and access-token API key", () => {
		expect(xaiOAuthProvider.id).toBe("xai");
		expect(xaiOAuthProvider.getApiKey({ access: "token", refresh: "r", expires: 0 })).toBe("token");
	});
});
