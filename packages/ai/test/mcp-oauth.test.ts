import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider } from "../src/mcp/oauth.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

const RESOURCE = "https://mcp.plane.so/http/mcp";
const PLANE_ISSUER = "https://mcp.plane.so/http";
const PLANE_PRM_URL = "https://mcp.plane.so/.well-known/oauth-protected-resource/http/mcp";
const PLANE_META_URL = "https://mcp.plane.so/.well-known/oauth-authorization-server/http";
const PLANE_META = {
	issuer: PLANE_ISSUER,
	authorization_endpoint: "https://mcp.plane.so/http/authorize",
	token_endpoint: "https://mcp.plane.so/http/token",
	registration_endpoint: "https://mcp.plane.so/http/register",
	scopes_supported: ["read", "write"],
};
const LEGACY_URL = "https://srv.test/mcp";
const LEGACY_META = {
	issuer: "https://srv.test",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
};

function absentPrm(input: unknown): Response | undefined {
	const url = urlOf(input);
	if (url === LEGACY_URL) return new Response("", { status: 404 });
	if (url === "https://srv.test/.well-known/oauth-protected-resource/mcp") return new Response("", { status: 404 });
	if (url === "https://srv.test/.well-known/oauth-protected-resource") return new Response("", { status: 404 });
	return undefined;
}

async function loginWithManualCode(
	provider: ReturnType<typeof createMcpOAuthProvider>,
): Promise<{ creds: object; authUrl: string }> {
	let authUrl = "";
	const creds = await provider.login({
		onAuth: (info) => {
			authUrl = info.url;
		},
		onPrompt: async () => "",
		onManualCodeInput: async () => {
			const params = new URL(authUrl).searchParams;
			return `${params.get("redirect_uri")}?code=the-code&state=${params.get("state")}`;
		},
	});
	return { creds, authUrl };
}

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a namespaced id and label", () => {
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: LEGACY_URL });
		expect(provider.id).toBe("mcp:linear");
		expect(provider.name).toBe("Linear");
		expect(provider.usesCallbackServer).toBe(true);
	});

	it("discovers Plane protected-resource metadata and its external pathful issuer", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === RESOURCE) {
				expect(init?.headers).toBeUndefined();
				return new Response("", { status: 401 });
			}
			if (url === PLANE_PRM_URL) return jsonResponse({ resource: RESOURCE, authorization_servers: [PLANE_ISSUER] });
			if (url === PLANE_META_URL) return jsonResponse(PLANE_META);
			if (url === PLANE_META.registration_endpoint) {
				expect(init?.redirect).toBe("error");
				return jsonResponse({ client_id: "plane-client" });
			}
			if (url === PLANE_META.token_endpoint) {
				expect(init?.redirect).toBe("error");
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("resource")).toBe(RESOURCE);
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { creds, authUrl } = await loginWithManualCode(createMcpOAuthProvider({ server: "plane", url: RESOURCE }));
		expect(creds).toMatchObject({
			access: "access-1",
			endpoint: RESOURCE,
			resource: RESOURCE,
			issuer: PLANE_ISSUER,
			tokenEndpoint: PLANE_META.token_endpoint,
		});
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("plane-client");
		expect(authParams.get("resource")).toBe(RESOURCE);
		expect(authParams.get("scope")).toBe("read write");
		expect(fetchMock).toHaveBeenCalledWith(RESOURCE, expect.objectContaining({ redirect: "error" }));
	});

	it("uses derived protected-resource metadata with an external pathful OIDC issuer", async () => {
		const issuer = "https://login.example/tenant";
		const oidcMeta = "https://login.example/tenant/.well-known/openid-configuration";
		const metadata = {
			...PLANE_META,
			issuer,
			authorization_endpoint: "https://login.example/tenant/authorize",
			token_endpoint: "https://login.example/tenant/token",
			registration_endpoint: "https://login.example/tenant/register",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === RESOURCE) return new Response("", { status: 404 });
				if (url === PLANE_PRM_URL) return jsonResponse({ resource: RESOURCE, authorization_servers: [issuer] });
				if (url === "https://login.example/.well-known/oauth-authorization-server/tenant")
					return new Response("", { status: 404 });
				if (url === oidcMeta) return jsonResponse(metadata);
				if (url === metadata.registration_endpoint) return jsonResponse({ client_id: "c" });
				if (url === metadata.token_endpoint) return jsonResponse({ access_token: "a", expires_in: 60 });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const { creds } = await loginWithManualCode(createMcpOAuthProvider({ server: "plane", url: RESOURCE }));
		expect(creds).toMatchObject({ resource: RESOURCE, issuer });
	});

	it("fails closed after protected-resource metadata selects an issuer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === RESOURCE)
					return new Response("", {
						status: 401,
						headers: { "WWW-Authenticate": `Bearer resource_metadata="${PLANE_PRM_URL}"` },
					});
				if (url === PLANE_PRM_URL)
					return jsonResponse({ resource: RESOURCE, authorization_servers: [PLANE_ISSUER] });
				if (url === PLANE_META_URL) return jsonResponse({ ...PLANE_META, issuer: "https://wrong.example" });
				if (url === "https://mcp.plane.so/http/.well-known/openid-configuration")
					return new Response("", { status: 404 });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "plane", url: RESOURCE }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("issuer does not exactly match");
	});

	it("uses legacy root authorization-server metadata only when protected-resource metadata is absent", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(LEGACY_META);
			if (url === LEGACY_META.registration_endpoint) return jsonResponse({ client_id: "legacy-client" });
			if (url === LEGACY_META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("resource")).toBeNull();
				return jsonResponse({ access_token: "legacy-access", refresh_token: "legacy-refresh", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds, authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "legacy", url: LEGACY_URL }),
		);
		expect(creds).toMatchObject({
			access: "legacy-access",
			endpoint: LEGACY_URL,
			resource: undefined,
			issuer: undefined,
		});
		expect(new URL(authUrl).searchParams.get("resource")).toBeNull();
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(
			"https://srv.test/.well-known/oauth-protected-resource",
		);
	});

	it("validates refresh binding and retains the protected-resource resource indicator", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === RESOURCE)
				return new Response("", {
					status: 401,
					headers: { "WWW-Authenticate": `Bearer resource_metadata="${PLANE_PRM_URL}"` },
				});
			if (url === PLANE_PRM_URL) return jsonResponse({ resource: RESOURCE, authorization_servers: [PLANE_ISSUER] });
			if (url === PLANE_META_URL) return jsonResponse(PLANE_META);
			if (url === PLANE_META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("resource")).toBe(RESOURCE);
				return jsonResponse({ access_token: "access-2", expires_in: 1800 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const provider = createMcpOAuthProvider({ server: "plane", url: RESOURCE });
		const refreshed = await provider.refreshToken({
			access: "access-1",
			refresh: "old-refresh",
			expires: 0,
			endpoint: RESOURCE,
			resource: RESOURCE,
			issuer: PLANE_ISSUER,
			tokenEndpoint: PLANE_META.token_endpoint,
			clientId: "client-xyz",
		} as never);
		expect(refreshed).toMatchObject({
			access: "access-2",
			refresh: "old-refresh",
			endpoint: RESOURCE,
			resource: RESOURCE,
			issuer: PLANE_ISSUER,
		});
		await expect(
			provider.refreshToken({ access: "a", refresh: "r", expires: 0, endpoint: "https://other.test/mcp" } as never),
		).rejects.toThrow("not bound");
		await expect(
			provider.refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: RESOURCE,
				resource: RESOURCE,
				issuer: PLANE_ISSUER,
				tokenEndpoint: "https://attacker.example/token",
				clientId: "client-xyz",
			} as never),
		).rejects.toThrow("token endpoint does not match");
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain("https://attacker.example/token");
	});

	it("preserves the resource query in RFC 9728 discovery and never probes root metadata", async () => {
		const resource = "https://mcp.example/mcp?tenant=a";
		const prm = "https://mcp.example/.well-known/oauth-protected-resource/mcp?tenant=a";
		const issuer = "https://login.example/tenant";
		const asMetadata = "https://login.example/.well-known/oauth-authorization-server/tenant";
		const metadata = {
			issuer,
			authorization_endpoint: "https://login.example/tenant/authorize",
			token_endpoint: "https://login.example/tenant/token",
		};
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === resource) return new Response("", { status: 401 });
			if (url === prm) return jsonResponse({ resource, authorization_servers: [issuer] });
			if (url === asMetadata) return jsonResponse(metadata);
			if (url === metadata.token_endpoint) return jsonResponse({ access_token: "query-access" });
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "query", url: resource, clientId: "query-client" }),
		);
		expect(creds).toMatchObject({ resource, issuer });
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(
			"https://mcp.example/.well-known/oauth-protected-resource",
		);
	});

	it("requires re-login when refresh discovery changes from legacy to resource-bound", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === RESOURCE) return new Response("", { status: 401 });
			if (url === PLANE_PRM_URL) return jsonResponse({ resource: RESOURCE, authorization_servers: [PLANE_ISSUER] });
			if (url === PLANE_META_URL) return jsonResponse(PLANE_META);
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "plane", url: RESOURCE }).refreshToken({
				access: "legacy-access",
				refresh: "legacy-refresh",
				expires: 0,
				endpoint: RESOURCE,
				tokenEndpoint: PLANE_META.token_endpoint,
				clientId: "legacy-client",
			} as never),
		).rejects.toThrow("discovery mode changed");
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(PLANE_META.token_endpoint);
	});

	it("rejects a redirected token POST", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(LEGACY_META);
				if (url === LEGACY_META.token_endpoint) {
					expect(init?.redirect).toBe("error");
					return new Response("redirect", { status: 302, headers: { Location: "https://evil.test/token" } });
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "legacy", url: LEGACY_URL, clientId: "c" });
		await expect(
			provider.refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: LEGACY_URL,
				tokenEndpoint: LEGACY_META.token_endpoint,
			} as never),
		).rejects.toThrow("Token request");
	});

	it("uses a WWW-Authenticate resource_metadata pointer before derived locations", async () => {
		const pointer = "https://metadata.example/resources/plane";
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === RESOURCE)
				return new Response("", {
					status: 401,
					headers: { "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${pointer}"` },
				});
			if (url === pointer) return jsonResponse({ resource: RESOURCE, authorization_servers: [PLANE_ISSUER] });
			if (url === PLANE_META_URL) return jsonResponse(PLANE_META);
			if (url === PLANE_META.registration_endpoint) return jsonResponse({ client_id: "pointer-client" });
			if (url === PLANE_META.token_endpoint) return jsonResponse({ access_token: "pointer-access" });
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { creds } = await loginWithManualCode(createMcpOAuthProvider({ server: "plane", url: RESOURCE }));
		expect(creds).toMatchObject({ access: "pointer-access", resource: RESOURCE, issuer: PLANE_ISSUER });
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(PLANE_PRM_URL);
	});

	it("rejects protected-resource metadata for a different resource", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === RESOURCE) return new Response("", { status: 401 });
				if (url === PLANE_PRM_URL)
					return jsonResponse({ resource: "https://attacker.example/mcp", authorization_servers: [PLANE_ISSUER] });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		await expect(
			createMcpOAuthProvider({ server: "plane", url: RESOURCE }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("resource does not exactly match");
	});

	it("falls back to the next callback port when the base port is occupied", async () => {
		const blocker = createServer();
		const blockerBound = await new Promise<boolean>((resolve) => {
			blocker.once("error", () => resolve(false));
			blocker.listen(53700, "127.0.0.1", () => resolve(true));
		});
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const missing = absentPrm(input);
					if (missing) return missing;
					const url = urlOf(input);
					if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(LEGACY_META);
					if (url === LEGACY_META.registration_endpoint) return jsonResponse({ client_id: "c" });
					if (url === LEGACY_META.token_endpoint) return jsonResponse({ access_token: "a", expires_in: 60 });
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			const { authUrl } = await loginWithManualCode(createMcpOAuthProvider({ server: "demo", url: LEGACY_URL }));
			const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
			expect(redirect).not.toContain(":53700/");
			expect(redirect).toContain(":5370");
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("fails clearly when dynamic client registration is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server")
					return jsonResponse({ ...LEGACY_META, registration_endpoint: undefined });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "slackish", url: LEGACY_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("dynamic client registration");
	});
});
