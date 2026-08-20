import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider } from "../src/mcp/oauth.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

const META = {
	issuer: "https://srv.test",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
};

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a namespaced id and label", () => {
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: "https://srv.test/mcp" });
		expect(provider.id).toBe("mcp:linear");
		expect(provider.name).toBe("Linear");
		expect(provider.usesCallbackServer).toBe(true);
	});

	it("discovers, registers a client, and exchanges the code for tokens", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
			if (url === META.registration_endpoint) return jsonResponse({ client_id: "client-xyz" });
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("client-xyz");
				expect(params.get("code")).toBe("the-code");
				expect(params.get("code_verifier")).toBeTruthy();
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const creds = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=the-code&state=${state}`;
			},
		});

		expect(creds.access).toBe("access-1");
		expect(creds.refresh).toBe("refresh-1");
		expect(creds.expires).toBeGreaterThan(Date.now());
		expect((creds as { endpoint?: string }).endpoint).toBe("https://srv.test/mcp");
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("client-xyz");
		expect(authParams.get("code_challenge")).toBeTruthy();
		expect(authParams.get("scope")).toBe("read write");
	});

	it("falls back to the next port when the base callback port is in use", async () => {
		const http = await import("node:http");
		const blocker = http.createServer();
		const blockerBound = await new Promise<boolean>((resolve) => {
			blocker.once("error", () => resolve(false));
			blocker.listen(53700, "127.0.0.1", () => resolve(true));
		});
		try {
			let authUrl = "";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = urlOf(input);
					if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
					if (url === META.registration_endpoint) return jsonResponse({ client_id: "c" });
					if (url === META.token_endpoint) return jsonResponse({ access_token: "a", expires_in: 60 });
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
			const creds = await provider.login({
				onAuth: (info) => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => {
					const p = new URL(authUrl).searchParams;
					return `${p.get("redirect_uri")}?code=x&state=${p.get("state")}`;
				},
			});
			expect(creds.access).toBe("a");
			const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
			expect(redirect).not.toContain(":53700/");
			expect(redirect).toContain(":5370");
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("refreshes tokens, keeping the prior refresh token when omitted", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				return jsonResponse({ access_token: "access-2", expires_in: 1800 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const refreshed = await provider.refreshToken({
			access: "access-1",
			refresh: "old-refresh",
			expires: Date.now() - 1000,
			tokenEndpoint: META.token_endpoint,
			clientId: "client-xyz",
			endpoint: "https://old.test/mcp",
		} as never);

		expect(refreshed.access).toBe("access-2");
		expect(refreshed.refresh).toBe("old-refresh");
		expect((refreshed as { endpoint?: string }).endpoint).toBe("https://old.test/mcp");

		const unbound = await provider.refreshToken({
			access: "access-1",
			refresh: "old-refresh",
			expires: Date.now() - 1000,
			tokenEndpoint: META.token_endpoint,
			clientId: "client-xyz",
		} as never);
		// An unbound credential stays unbound, so consumers keep requiring re-login.
		expect((unbound as { endpoint?: string }).endpoint).toBeUndefined();
	});

	it("fails clearly when DCR is unavailable and no clientId is set", async () => {
		const noReg = { ...META, registration_endpoint: undefined };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(noReg);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "slackish", url: "https://srv.test/mcp" });
		await expect(provider.login({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"dynamic client registration",
		);
	});
});

const REDIRECT = `http://localhost:${process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700}/callback`;
