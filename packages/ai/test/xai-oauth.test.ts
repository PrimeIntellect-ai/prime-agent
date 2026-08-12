import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.js";
import { loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function requestBody(init?: RequestInit): URLSearchParams {
	if (!(init?.body instanceof URLSearchParams)) {
		throw new Error("Expected form-encoded request body");
	}
	return init.body;
}

describe.sequential("xAI OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("completes the device flow after the server polling interval", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-08-12T00:00:00Z");
		vi.setSystemTime(start);
		const pollTimes: number[] = [];
		const authCalls: { url: string; instructions?: string }[] = [];
		let tokenPolls = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = requestUrl(input);
				if (url.endsWith("/.well-known/openid-configuration")) {
					return jsonResponse({
						authorization_endpoint: "https://auth.x.ai/oauth2/auth",
						token_endpoint: "https://auth.x.ai/oauth2/token",
					});
				}
				if (url.endsWith("/oauth2/device/code")) {
					expect(requestBody(init).get("client_id")).toBeTruthy();
					expect(requestBody(init).get("scope")).toContain("grok-cli:access");
					return jsonResponse({
						device_code: "device-code",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.x.ai/activate",
						verification_uri_complete: "https://auth.x.ai/activate?code=ABCD-EFGH",
						expires_in: 900,
						interval: 5,
					});
				}
				if (url.endsWith("/oauth2/token")) {
					pollTimes.push(Date.now());
					expect(requestBody(init).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
					expect(requestBody(init).get("device_code")).toBe("device-code");
					tokenPolls += 1;
					return tokenPolls === 1
						? jsonResponse({ error: "authorization_pending" }, 400)
						: jsonResponse({
								access_token: "access-token",
								refresh_token: "refresh-token",
								expires_in: 21600,
							});
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);

		const login = loginXai({
			onAuth: (info) => authCalls.push(info),
			onPrompt: async () => "",
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toEqual([start.getTime() + 5000]);
		await vi.advanceTimersByTimeAsync(5000);
		const credentials = await login;

		expect(authCalls).toEqual([
			{ url: "https://auth.x.ai/activate?code=ABCD-EFGH", instructions: "Enter code: ABCD-EFGH" },
		]);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			tokenEndpoint: "https://auth.x.ai/oauth2/token",
		});
		expect(credentials.expires).toBe(start.getTime() + 5 * 60 * 60 * 1000 + 10000);
	});

	it("keeps short-lived access tokens usable before proactive refresh", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-08-12T00:00:00Z");
		vi.setSystemTime(start);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 })),
		);

		const refreshed = await refreshXaiToken({
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			tokenEndpoint: "https://auth.x.ai/oauth2/token",
		});
		expect(refreshed.expires).toBe(start.getTime() + 13 * 60 * 1000);
	});

	it("retains or rotates the refresh token and rejects untrusted token endpoints", async () => {
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(requestBody(init).get("grant_type")).toBe("refresh_token");
			expect(requestBody(init).get("refresh_token")).toBe("old-refresh");
			return jsonResponse({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 21600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await refreshXaiToken({
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			tokenEndpoint: "https://auth.x.ai/oauth2/token",
		});
		expect(refreshed.refresh).toBe("new-refresh");
		expect(fetchMock).toHaveBeenCalledOnce();

		await expect(
			refreshXaiToken({
				access: "old-access",
				refresh: "secret-refresh",
				expires: 0,
				tokenEndpoint: "https://attacker.example/token",
			}),
		).rejects.toThrow("untrusted token_endpoint");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("uses the Responses API for xAI models only while OAuth is active", () => {
		const xai = {
			id: "grok-4.20",
			name: "Grok 4.20",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 30000,
		} satisfies Model<"openai-completions">;
		const other = { ...xai, provider: "openai", id: "gpt-test" } satisfies Model<"openai-completions">;

		const modified = xaiOAuthProvider.modifyModels?.([xai, other], {
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 1000,
		});
		expect(modified?.[0]).toMatchObject({
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
		});
		expect(modified?.[1]).toBe(other);
	});

	it("cancels while waiting for device approval", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url.endsWith("/.well-known/openid-configuration")) {
					return jsonResponse({
						authorization_endpoint: "https://auth.x.ai/oauth2/auth",
						token_endpoint: "https://auth.x.ai/oauth2/token",
					});
				}
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/activate",
					expires_in: 900,
					interval: 5,
				});
			}),
		);
		const controller = new AbortController();
		const login = loginXai({ onAuth: () => {}, onPrompt: async () => "", signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await expect(login).rejects.toThrow("Login cancelled");
	});
});
