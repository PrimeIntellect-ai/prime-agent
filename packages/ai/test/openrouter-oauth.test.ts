import { get as httpGet } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.js";
import { loginOpenRouter, openrouterOAuthProvider, refreshOpenRouterToken } from "../src/utils/oauth/openrouter.js";
import type { OAuthCredentials } from "../src/utils/oauth/types.js";

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

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

/** Extracts callback_url from the authorize URL passed to onAuth. */
function callbackUrlFrom(authUrl: string): string {
	const url = new URL(authUrl);
	const callbackUrl = url.searchParams.get("callback_url");
	if (!callbackUrl) throw new Error("Missing callback_url in authorize URL");
	return callbackUrl;
}

/** Makes a real GET request against the loopback callback server and returns the status code. */
function fetchStatus(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		httpGet(url, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		}).on("error", reject);
	});
}

describe.sequential("OpenRouter OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is registered as a built-in OAuth provider", () => {
		expect(getOAuthProvider("openrouter")).toBe(openrouterOAuthProvider);
		expect(openrouterOAuthProvider.usesCallbackServer).toBe(true);
	});

	it("exchanges an authorization code for a bare, non-expiring credential", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://openrouter.ai/api/v1/auth/keys");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.code).toBe("manual-code");
			expect(body.code_challenge_method).toBe("S256");
			expect(typeof body.code_verifier).toBe("string");
			return jsonResponse({ key: "sk-or-v1-test-key" });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginOpenRouter({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => {
				throw new Error("onPrompt should not be reached when manual input resolves first");
			},
			onManualCodeInput: async () => {
				const callbackUrl = callbackUrlFrom(authUrl);
				return `${callbackUrl}?code=manual-code`;
			},
		});

		expect(credentials.access).toBe("sk-or-v1-test-key");
		expect(credentials.refresh).toBe("");
		expect(credentials.expires).toBe(Number.MAX_SAFE_INTEGER);
		expect("type" in credentials).toBe(false);
		expect(fetchMock).toHaveBeenCalledOnce();

		// expires must survive a JSON round trip as a finite number, not serialize to null.
		const roundTripped = JSON.parse(JSON.stringify(credentials)) as OAuthCredentials;
		expect(roundTripped.expires).toBe(Number.MAX_SAFE_INTEGER);
		expect(Number.isFinite(roundTripped.expires)).toBe(true);
	});

	it("rejects when the exchange responds with a non-2xx status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "Code expired" }, 403)),
		);

		await expect(
			loginOpenRouter({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "raw-code",
			}),
		).rejects.toThrow(/OpenRouter OAuth key exchange failed \(HTTP 403\).*Code expired/);
	});

	it("rejects when the response body has no key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({})),
		);

		await expect(
			loginOpenRouter({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "raw-code",
			}),
		).rejects.toThrow(/carries no "key"/);
	});

	it("rejects when the response key is an empty string", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ key: "" })),
		);

		await expect(
			loginOpenRouter({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "raw-code",
			}),
		).rejects.toThrow(/carries no "key"/);
	});

	it("only accepts a callback at the randomly generated path", async () => {
		let authUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ key: "sk-or-v1-real" })),
		);

		const loginPromise = loginOpenRouter({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => {
				throw new Error("onPrompt should not be reached");
			},
			onManualCodeInput: async () => {
				const callbackUrl = callbackUrlFrom(authUrl);
				const wrongPathUrl = callbackUrl.replace(/\/oauth\/callback\/[^?]+/, "/oauth/callback/wrong-path");
				const status = await fetchStatus(`${wrongPathUrl}?code=x`);
				expect(status).toBe(404);
				return `${callbackUrl}?code=manual-code`;
			},
		});

		const credentials = await loginPromise;
		expect(credentials.access).toBe("sk-or-v1-real");
	});

	it("refreshToken throws instead of returning a dead credential", async () => {
		await expect(
			refreshOpenRouterToken({ access: "sk-or-v1-old", refresh: "", expires: Number.MAX_SAFE_INTEGER }),
		).rejects.toThrow(/don't support refresh/);
	});

	it("getApiKey returns the access token", () => {
		const credentials: OAuthCredentials = { access: "sk-or-v1-abc", refresh: "", expires: Number.MAX_SAFE_INTEGER };
		expect(openrouterOAuthProvider.getApiKey(credentials)).toBe("sk-or-v1-abc");
	});
});
