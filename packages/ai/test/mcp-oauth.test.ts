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
	response_types_supported: ["code"],
};
const ORIGIN_URL = "https://srv.test/mcp";
const ORIGIN_META = {
	issuer: "https://srv.test/tenant",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
	response_types_supported: ["code"],
};

// Official Notion/Slack shape: pathful endpoint, origin-level PRM resource (captured metadata).
const NOTION_URL = "https://mcp.notion.test/mcp";
const NOTION_ORIGIN = "https://mcp.notion.test";
const NOTION_PRM_PATH = "https://mcp.notion.test/.well-known/oauth-protected-resource/mcp";
const NOTION_PRM_ROOT = "https://mcp.notion.test/.well-known/oauth-protected-resource";
const NOTION_AS = "https://mcp.notion.test/.well-known/oauth-authorization-server";
const NOTION_META = {
	issuer: NOTION_ORIGIN,
	authorization_endpoint: "https://mcp.notion.test/authorize",
	token_endpoint: "https://mcp.notion.test/token",
	registration_endpoint: "https://mcp.notion.test/register",
	scopes_supported: ["default"],
	response_types_supported: ["code"],
	token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
};
const NOTION_PRM = {
	resource: NOTION_ORIGIN,
	authorization_servers: [NOTION_ORIGIN],
	scopes_supported: ["default"],
};

/** RFC 7591 full registration echo (OAuthClientInformationFullSchema shape). */
function dcrEcho(clientId: string, extra: Record<string, unknown> = {}): unknown {
	return {
		client_id: clientId,
		redirect_uris: ["http://localhost:53700/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...extra,
	};
}

function tokenResponse(access: string, extra: Record<string, unknown> = {}): unknown {
	return { access_token: access, token_type: "Bearer", expires_in: 3600, ...extra };
}

function absentPrm(input: unknown): Response | undefined {
	const url = urlOf(input);
	if (url === ORIGIN_URL) return new Response("", { status: 404 });
	if (url === "https://srv.test/.well-known/oauth-protected-resource/mcp") return new Response("", { status: 404 });
	if (url === "https://srv.test/.well-known/oauth-protected-resource") return new Response("", { status: 404 });
	return undefined;
}

async function loginWithManualCode(
	provider: ReturnType<typeof createMcpOAuthProvider>,
	signal?: AbortSignal,
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
		signal,
	});
	return { creds, authUrl };
}

/** Notion-shaped offline server: pathful endpoint, PRM at root well-known, DCR, public client. */
function notionFetchMock(overrides?: Record<string, (url: string, init?: RequestInit) => Response>) {
	return vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = urlOf(input);
		const override = overrides?.[url];
		if (override) return override(url, init);
		if (url === NOTION_URL) return new Response("", { status: 401 });
		if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
		if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
		if (url === NOTION_AS) return jsonResponse(NOTION_META);
		if (url === NOTION_META.registration_endpoint) return jsonResponse(dcrEcho("notion-client"));
		if (url === NOTION_META.token_endpoint) {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("resource")).toBe(NOTION_ORIGIN);
			return jsonResponse(tokenResponse("notion-access"));
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
}

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a namespaced id and label", () => {
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: ORIGIN_URL });
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
			if (url === PLANE_PRM_URL)
				return jsonResponse({
					resource: RESOURCE,
					authorization_servers: [PLANE_ISSUER],
					scopes_supported: ["read", "write"],
				});
			if (url === PLANE_META_URL) return jsonResponse(PLANE_META);
			if (url === PLANE_META.registration_endpoint) {
				expect(init?.redirect).toBe("error");
				const body = JSON.parse(String(init?.body)) as { scope?: string };
				expect(body.scope).toBe("read write");
				return jsonResponse(dcrEcho("plane-client"));
			}
			if (url === PLANE_META.token_endpoint) {
				expect(init?.redirect).toBe("error");
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("resource")).toBe(RESOURCE);
				return jsonResponse(tokenResponse("access-1", { refresh_token: "refresh-1" }));
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
			audienceMode: "exact",
			clientRegistration: "dcr",
			clientId: "plane-client",
			tokenEndpoint: PLANE_META.token_endpoint,
		});
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("plane-client");
		expect(authParams.get("resource")).toBe(RESOURCE);
		expect(authParams.get("scope")).toBe("read write");
		expect(fetchMock).toHaveBeenCalledWith(RESOURCE, expect.objectContaining({ redirect: "error" }));
	});

	it("uses pathful OIDC metadata when RFC 8414 returns a non-metadata document", async () => {
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
					return new Response("<html>not metadata</html>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				if (url === oidcMeta) return jsonResponse(metadata);
				if (url === metadata.registration_endpoint) return jsonResponse(dcrEcho("c"));
				if (url === metadata.token_endpoint) return jsonResponse(tokenResponse("a", { expires_in: 60 }));
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

	it("accepts a same-origin pathful issuer from origin-level metadata when protected-resource metadata is absent", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
			if (url === ORIGIN_META.registration_endpoint) return jsonResponse(dcrEcho("origin-client"));
			if (url === ORIGIN_META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("resource")).toBeNull();
				return jsonResponse(tokenResponse("origin-access", { refresh_token: "origin-refresh" }));
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds, authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "origin", url: ORIGIN_URL }),
		);
		expect(creds).toMatchObject({
			access: "origin-access",
			endpoint: ORIGIN_URL,
			resource: undefined,
			issuer: undefined,
		});
		expect(new URL(authUrl).searchParams.get("resource")).toBeNull();
		// SDK-parity root fallback: the path-inserted well-known is tried before the origin-level root.
		const calls = fetchMock.mock.calls.map(([input]) => urlOf(input));
		const pathInserted = calls.indexOf("https://srv.test/.well-known/oauth-protected-resource/mcp");
		const root = calls.indexOf("https://srv.test/.well-known/oauth-protected-resource");
		expect(pathInserted).toBeGreaterThanOrEqual(0);
		expect(root).toBeGreaterThan(pathInserted);
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
				return jsonResponse(tokenResponse("access-2", { expires_in: 1800, refresh_token: "rotated-refresh" }));
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
			audienceMode: "exact",
			tokenEndpoint: PLANE_META.token_endpoint,
			clientId: "client-xyz",
		} as never);
		expect(refreshed).toMatchObject({
			access: "access-2",
			refresh: "rotated-refresh",
			endpoint: RESOURCE,
			resource: RESOURCE,
			issuer: PLANE_ISSUER,
			audienceMode: "exact",
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
				audienceMode: "exact",
				tokenEndpoint: "https://attacker.example/token",
				clientId: "client-xyz",
			} as never),
		).rejects.toThrow("token endpoint does not match");
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain("https://attacker.example/token");
	});

	it("keeps an origin-level resource identifier free of a synthetic trailing slash", async () => {
		const resource = "https://root.example";
		const prm = "https://root.example/.well-known/oauth-protected-resource";
		const issuer = "https://root.example";
		const asMetadata = "https://root.example/.well-known/oauth-authorization-server";
		const metadata = {
			issuer,
			authorization_endpoint: "https://root.example/authorize",
			token_endpoint: "https://root.example/token",
			response_types_supported: ["code"],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === "https://root.example/") return new Response("", { status: 401 });
				if (url === prm) return jsonResponse({ resource, authorization_servers: [issuer] });
				if (url === asMetadata) return jsonResponse(metadata);
				if (url === metadata.token_endpoint) return jsonResponse(tokenResponse("root-access"));
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const { creds, authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "root", url: resource, clientId: "root-client" }),
		);
		expect(creds).toMatchObject({ endpoint: resource, resource, issuer, audienceMode: "exact" });
		expect(new URL(authUrl).searchParams.get("resource")).toBe(resource);
	});

	it("preserves the resource query in RFC 9728 discovery locations", async () => {
		const resource = "https://mcp.example/mcp?tenant=a";
		const prm = "https://mcp.example/.well-known/oauth-protected-resource/mcp?tenant=a";
		const issuer = "https://login.example/tenant";
		const asMetadata = "https://login.example/.well-known/oauth-authorization-server/tenant";
		const metadata = {
			issuer,
			authorization_endpoint: "https://login.example/tenant/authorize",
			token_endpoint: "https://login.example/tenant/token",
			response_types_supported: ["code"],
		};
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === resource) return new Response("", { status: 401 });
			if (url === prm) return jsonResponse({ resource, authorization_servers: [issuer] });
			if (url === asMetadata) return jsonResponse(metadata);
			if (url === metadata.token_endpoint) return jsonResponse(tokenResponse("query-access"));
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

	it("requires re-login when refresh discovery changes from origin-only to resource-bound", async () => {
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
				access: "origin-access",
				refresh: "origin-refresh",
				expires: 0,
				endpoint: RESOURCE,
				tokenEndpoint: PLANE_META.token_endpoint,
				clientId: "origin-client",
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
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
				if (url === ORIGIN_META.token_endpoint) {
					expect(init?.redirect).toBe("error");
					return new Response("redirect", { status: 302, headers: { Location: "https://evil.test/token" } });
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "origin", url: ORIGIN_URL, clientId: "c" });
		await expect(
			provider.refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: ORIGIN_URL,
				tokenEndpoint: ORIGIN_META.token_endpoint,
			} as never),
		).rejects.toThrow("HTTP 302");
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
			if (url === PLANE_META.registration_endpoint) return jsonResponse(dcrEcho("pointer-client"));
			if (url === PLANE_META.token_endpoint) return jsonResponse(tokenResponse("pointer-access"));
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
		).rejects.toThrow("does not match the configured endpoint");
	});

	it("rejects a same-origin protected resource with a different path", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === NOTION_URL) return new Response("", { status: 401 });
				if (url === NOTION_PRM_PATH)
					return jsonResponse({
						resource: "https://mcp.notion.test/other",
						authorization_servers: [NOTION_ORIGIN],
					});
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "notion", url: NOTION_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("does not match the configured endpoint");
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
					if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
					if (url === ORIGIN_META.registration_endpoint) return jsonResponse(dcrEcho("c"));
					if (url === ORIGIN_META.token_endpoint) return jsonResponse(tokenResponse("a", { expires_in: 60 }));
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			const { authUrl } = await loginWithManualCode(createMcpOAuthProvider({ server: "demo", url: ORIGIN_URL }));
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
					return jsonResponse({ ...ORIGIN_META, registration_endpoint: undefined });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "slackish", url: ORIGIN_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("dynamic client registration");
	});

	// ---- Audience policy: official Notion/Slack origin-level resource shapes ----

	it("accepts an origin-level PRM resource for a pathful endpoint via the root well-known", async () => {
		vi.stubGlobal("fetch", notionFetchMock());
		const { creds, authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "notion", url: NOTION_URL }),
		);
		expect(creds).toMatchObject({
			access: "notion-access",
			endpoint: NOTION_URL,
			resource: NOTION_ORIGIN,
			issuer: NOTION_ORIGIN,
			audienceMode: "origin",
			clientRegistration: "dcr",
		});
		expect(new URL(authUrl).searchParams.get("resource")).toBe(NOTION_ORIGIN);
	});

	it("accepts an origin-level PRM resource via a WWW-Authenticate pointer", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL)
				return new Response("", {
					status: 401,
					headers: { "WWW-Authenticate": `Bearer resource_metadata="${NOTION_PRM_ROOT}"` },
				});
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			if (url === NOTION_META.registration_endpoint) return jsonResponse(dcrEcho("notion-client"));
			if (url === NOTION_META.token_endpoint) return jsonResponse(tokenResponse("notion-access"));
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds } = await loginWithManualCode(createMcpOAuthProvider({ server: "notion", url: NOTION_URL }));
		expect(creds).toMatchObject({ resource: NOTION_ORIGIN, audienceMode: "origin" });
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(NOTION_PRM_PATH);
	});

	it("refreshes an origin-audience grant against the declared origin resource", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			if (url === NOTION_META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("resource")).toBe(NOTION_ORIGIN);
				return jsonResponse(tokenResponse("notion-refreshed", { refresh_token: "rotated" }));
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const refreshed = await createMcpOAuthProvider({ server: "notion", url: NOTION_URL }).refreshToken({
			access: "notion-access",
			refresh: "notion-refresh",
			expires: 0,
			endpoint: NOTION_URL,
			resource: NOTION_ORIGIN,
			issuer: NOTION_ORIGIN,
			audienceMode: "origin",
			clientId: "notion-client",
			clientRegistration: "dcr",
			tokenEndpoint: NOTION_META.token_endpoint,
		} as never);
		expect(refreshed).toMatchObject({
			access: "notion-refreshed",
			refresh: "rotated",
			resource: NOTION_ORIGIN,
			audienceMode: "origin",
			clientId: "notion-client",
		});
	});

	it("rejects a legacy exact grant when discovery moves to an origin audience", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "notion", url: NOTION_URL }).refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: NOTION_URL,
				resource: NOTION_URL,
				issuer: NOTION_ORIGIN,
				tokenEndpoint: NOTION_META.token_endpoint,
				clientId: "notion-client",
			} as never),
		).rejects.toThrow("do not match current protected-resource metadata");
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(NOTION_META.token_endpoint);
	});

	// ---- Client auth-method negotiation (SDK 1.30 semantics) ----

	it("negotiates client_secret_basic when the server supports it and a secret is configured", async () => {
		const meta = {
			...ORIGIN_META,
			token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(meta);
				if (url === meta.token_endpoint) {
					expect((init?.headers as Record<string, string>).Authorization).toBe(
						`Basic ${btoa("conf-client:conf-secret")}`,
					);
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("client_id")).toBeNull();
					return jsonResponse(tokenResponse("basic-access"));
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const { creds } = await loginWithManualCode(
			createMcpOAuthProvider({
				server: "basic",
				url: ORIGIN_URL,
				clientId: "conf-client",
				clientSecret: "conf-secret",
			}),
		);
		expect(creds).toMatchObject({ access: "basic-access", clientAuthMethod: "client_secret_basic" });
	});

	it("negotiates client_secret_post for a post-only server (official Slack shape)", async () => {
		const meta = {
			...ORIGIN_META,
			registration_endpoint: undefined,
			token_endpoint_auth_methods_supported: ["client_secret_post"],
		};
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(meta);
			if (url === meta.token_endpoint) {
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBeUndefined();
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("client_id")).toBe("slack-client");
				expect(params.get("client_secret")).toBe("slack-secret");
				return jsonResponse(tokenResponse("slack-access", { refresh_token: "slack-refresh" }));
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const provider = createMcpOAuthProvider({
			server: "slack",
			url: ORIGIN_URL,
			clientId: "slack-client",
			clientSecret: "slack-secret",
		});
		const { creds } = await loginWithManualCode(provider);
		expect(creds).toMatchObject({ access: "slack-access", clientAuthMethod: "client_secret_post" });
		// Config-supplied secrets are never persisted; refresh re-reads them from config.
		expect(creds).not.toHaveProperty("clientSecret");
		const refreshed = await provider.refreshToken(creds as never);
		expect(refreshed).toMatchObject({ access: "slack-access", clientAuthMethod: "client_secret_post" });
	});

	it("negotiates public (none) auth for a pre-registered client without a secret", async () => {
		const meta = { ...ORIGIN_META, token_endpoint_auth_methods_supported: ["none"] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(meta);
				if (url === meta.token_endpoint) {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("client_id")).toBe("public-client");
					expect(params.get("client_secret")).toBeNull();
					return jsonResponse(tokenResponse("public-access"));
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const { creds } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "public", url: ORIGIN_URL, clientId: "public-client" }),
		);
		expect(creds).toMatchObject({ access: "public-access", clientAuthMethod: "none" });
	});

	it("fails early with setup guidance when a secret-only server has no secret", async () => {
		const meta = {
			...ORIGIN_META,
			registration_endpoint: undefined,
			token_endpoint_auth_methods_supported: ["client_secret_post"],
		};
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(meta);
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "slack", url: ORIGIN_URL, clientId: "slack-client" }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("does not support any compatible client authentication method");
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(meta.token_endpoint);
	});

	it("fails early when an explicitly configured secret is empty", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("unexpected fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "empty", url: ORIGIN_URL, clientId: "c", clientSecret: "" }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("is empty");
	});

	// ---- DCR full-response handling ----

	it("persists a DCR-issued secret and auth method and reuses them on refresh", async () => {
		const meta = {
			...ORIGIN_META,
			token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
		};
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(meta);
			if (url === meta.registration_endpoint) {
				return jsonResponse(
					dcrEcho("dcr-client", { client_secret: "dcr-secret", token_endpoint_auth_method: "client_secret_post" }),
				);
			}
			if (url === meta.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("client_secret")).toBe("dcr-secret");
				return jsonResponse(tokenResponse("dcr-access", { refresh_token: "dcr-refresh" }));
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const provider = createMcpOAuthProvider({ server: "dcr", url: ORIGIN_URL });
		const { creds } = await loginWithManualCode(provider);
		expect(creds).toMatchObject({
			access: "dcr-access",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			clientAuthMethod: "client_secret_post",
			clientRegistration: "dcr",
		});
		const refreshed = await provider.refreshToken(creds as never);
		expect(refreshed).toMatchObject({
			access: "dcr-access",
			clientSecret: "dcr-secret",
			clientAuthMethod: "client_secret_post",
			clientRegistration: "dcr",
		});
	});

	it("rejects a DCR response that omits required registration fields", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
			if (url === ORIGIN_META.registration_endpoint) return jsonResponse({ client_id: "x" });
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "minimal", url: ORIGIN_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("invalid registration");
	});

	it("rejects a DCR registration that selects a secret method without issuing a secret", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const missing = absentPrm(input);
			if (missing) return missing;
			const url = urlOf(input);
			if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
			if (url === ORIGIN_META.registration_endpoint)
				return jsonResponse(dcrEcho("c", { token_endpoint_auth_method: "client_secret_post" }));
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "contradiction", url: ORIGIN_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("without issuing a client secret");
	});

	it("rejects refresh when the stored DCR client secret has expired", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("unexpected fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "expired", url: ORIGIN_URL }).refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: ORIGIN_URL,
				clientId: "c",
				clientSecret: "s",
				clientSecretExpiresAt: 1000,
				clientAuthMethod: "client_secret_post",
				clientRegistration: "dcr",
			} as never),
		).rejects.toThrow("has expired");
	});

	// ---- CIMD (SEP-991) ----

	it("uses the configured client metadata URL as client id when the server advertises CIMD", async () => {
		const meta = { ...NOTION_META, client_id_metadata_document_supported: true };
		const clientMetadataUrl = "https://clients.prime.example/mcp/client-metadata.json";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(meta);
			if (url === meta.registration_endpoint) throw new Error(`unexpected fetch: ${url}`);
			if (url === meta.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("client_id")).toBe(clientMetadataUrl);
				return jsonResponse(tokenResponse("cimd-access"));
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds, authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "cimd", url: NOTION_URL, clientMetadataUrl }),
		);
		expect(creds).toMatchObject({ access: "cimd-access", clientId: clientMetadataUrl, clientRegistration: "cimd" });
		expect(new URL(authUrl).searchParams.get("client_id")).toBe(clientMetadataUrl);
		expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(meta.registration_endpoint);
	});

	it("falls back to DCR when CIMD is configured but the server does not advertise it", async () => {
		const clientMetadataUrl = "https://clients.prime.example/mcp/client-metadata.json";
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			if (url === NOTION_META.registration_endpoint) return jsonResponse(dcrEcho("dcr-client"));
			if (url === NOTION_META.token_endpoint) return jsonResponse(tokenResponse("dcr-access"));
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { creds } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "cimd-fallback", url: NOTION_URL, clientMetadataUrl }),
		);
		expect(creds).toMatchObject({ clientId: "dcr-client", clientRegistration: "dcr" });
	});

	it("rejects an invalid client metadata URL when CIMD is advertised", async () => {
		for (const clientMetadataUrl of ["https://clients.prime.example/", "http://clients.prime.example/meta.json"]) {
			const meta = { ...NOTION_META, client_id_metadata_document_supported: true };
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = urlOf(input);
					if (url === NOTION_URL) return new Response("", { status: 401 });
					if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
					if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
					if (url === NOTION_AS) return jsonResponse(meta);
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			await expect(
				createMcpOAuthProvider({ server: "cimd", url: NOTION_URL, clientMetadataUrl }).login({
					onAuth: () => {},
					onPrompt: async () => "",
				}),
			).rejects.toThrow(/non-root path|absolute HTTPS URL/);
			vi.unstubAllGlobals();
		}
	});

	it("requires re-login when the configured client id changes for a stored grant", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("unexpected fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "plane", url: RESOURCE, clientId: "new-client" }).refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: RESOURCE,
				resource: RESOURCE,
				issuer: PLANE_ISSUER,
				audienceMode: "exact",
				clientId: "old-client",
				tokenEndpoint: PLANE_META.token_endpoint,
			} as never),
		).rejects.toThrow("different client id");
	});

	// ---- Scope precedence (SEP-835; never join the AS-wide scope universe) ----

	it("prefers configured scopes over protected-resource scopes", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT) return jsonResponse(NOTION_PRM);
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			if (url === NOTION_META.registration_endpoint) {
				const body = JSON.parse(String(init?.body)) as { scope?: string };
				expect(body.scope).toBe("custom:read");
				return jsonResponse(dcrEcho("scoped"));
			}
			if (url === NOTION_META.token_endpoint) return jsonResponse(tokenResponse("scoped-access"));
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { authUrl } = await loginWithManualCode(
			createMcpOAuthProvider({ server: "scoped", url: NOTION_URL, scopes: "custom:read" }),
		);
		expect(new URL(authUrl).searchParams.get("scope")).toBe("custom:read");
	});

	it("never requests AS-advertised scopes when the protected resource has none", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			if (url === NOTION_URL) return new Response("", { status: 401 });
			if (url === NOTION_PRM_PATH) return new Response("", { status: 404 });
			if (url === NOTION_PRM_ROOT)
				return jsonResponse({ resource: NOTION_ORIGIN, authorization_servers: [NOTION_ORIGIN] });
			if (url === NOTION_AS) return jsonResponse(NOTION_META);
			if (url === NOTION_META.registration_endpoint) return jsonResponse(dcrEcho("unscoped"));
			if (url === NOTION_META.token_endpoint) return jsonResponse(tokenResponse("unscoped-access"));
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const { authUrl } = await loginWithManualCode(createMcpOAuthProvider({ server: "unscoped", url: NOTION_URL }));
		expect(new URL(authUrl).searchParams.get("scope")).toBeNull();
	});

	// ---- Sanitized, typed token errors ----

	it("classifies invalid_grant as a re-login error without echoing server descriptions", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
				if (url === ORIGIN_META.token_endpoint)
					return jsonResponse({ error: "invalid_grant", error_description: "leak<script>" }, 400);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "srv", url: ORIGIN_URL, clientId: "c" }).refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: ORIGIN_URL,
				tokenEndpoint: ORIGIN_META.token_endpoint,
			} as never),
		).rejects.toThrow(/no longer valid; re-run \/mcp login srv/);
	});

	it("classifies invalid_client as a client identity error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
				if (url === ORIGIN_META.token_endpoint)
					return jsonResponse({ error: "invalid_client", error_description: "secret is hunter2" }, 401);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			createMcpOAuthProvider({ server: "srv", url: ORIGIN_URL, clientId: "c" }).refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: ORIGIN_URL,
				tokenEndpoint: ORIGIN_META.token_endpoint,
			} as never),
		).rejects.toThrow("client authentication failed");
	});

	it("omits unknown server error strings from sanitized error messages", async () => {
		const malicious = `x<script>${"y".repeat(80)}</script>`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const missing = absentPrm(input);
				if (missing) return missing;
				const url = urlOf(input);
				if (url === "https://srv.test/.well-known/oauth-authorization-server") return jsonResponse(ORIGIN_META);
				if (url === ORIGIN_META.token_endpoint)
					return jsonResponse({ error: malicious, error_description: "not-echoed" }, 400);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "srv", url: ORIGIN_URL, clientId: "c" });
		const error = await provider
			.refreshToken({
				access: "a",
				refresh: "r",
				expires: 0,
				endpoint: ORIGIN_URL,
				tokenEndpoint: ORIGIN_META.token_endpoint,
			} as never)
			.catch((e: Error) => e);
		expect(error.message).toContain("HTTP 400");
		expect(error.message).not.toContain("<script>");
		expect(error.message).not.toContain("not-echoed");
	});

	// ---- Bounding and cancellation ----

	it("rejects a login immediately when the abort signal is already aborted", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("unexpected fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createMcpOAuthProvider({ server: "abort", url: ORIGIN_URL }).login({
				onAuth: () => {},
				onPrompt: async () => "",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow("Login cancelled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("threads the abort signal into every request and cancels a hanging discovery", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn((input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === ORIGIN_URL) return Promise.resolve(new Response("", { status: 404 }));
			if (url === "https://srv.test/.well-known/oauth-protected-resource/mcp") {
				return new Promise<Response>((_, reject) => {
					expect(init?.signal).toBeInstanceOf(AbortSignal);
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted fetch")));
				});
			}
			return Promise.reject(new Error(`unexpected fetch: ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);
		const promise = createMcpOAuthProvider({ server: "hang", url: ORIGIN_URL }).login({
			onAuth: () => {},
			onPrompt: async () => "",
			signal: controller.signal,
		});
		// Let discovery reach the hanging well-known fetch, then abort.
		await new Promise((r) => setTimeout(r, 50));
		controller.abort();
		await expect(promise).rejects.toThrow();
	});
});
