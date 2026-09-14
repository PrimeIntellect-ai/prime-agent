import type { Server } from "node:http";
import { extractWWWAuthenticateParams, selectClientAuthMethod } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	OAuthClientInformationFullSchema,
	OAuthErrorResponseSchema,
	OAuthMetadataSchema,
	OAuthProtectedResourceMetadataSchema,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { oauthErrorHtml, oauthSuccessHtml } from "../utils/oauth/oauth-page.js";
import { generatePKCE } from "../utils/oauth/pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "../utils/oauth/types.js";

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
// A range (not one port) so a leaked/concurrent login can't wedge all logins with EADDRINUSE.
// Distinct from the Anthropic callback port (53692). All candidates are registered as redirect URIs.
const CALLBACK_PORT_BASE = Number(process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700);
const CALLBACK_PORT_COUNT = 10;
const CALLBACK_PATH = "/callback";
const CALLBACK_PORTS = Array.from({ length: CALLBACK_PORT_COUNT }, (_, i) => CALLBACK_PORT_BASE + i);
const redirectUriFor = (port: number) => `http://localhost:${port}${CALLBACK_PATH}`;
const ALL_REDIRECT_URIS = CALLBACK_PORTS.map(redirectUriFor);
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Every hand-rolled request is bounded and cancellable: no fetch without a
// deadline, and login fetches additionally honor the host abort signal.
const DISCOVERY_TIMEOUT_MS = 10_000;
const REGISTRATION_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 256 * 1024;

type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";
type ClientRegistrationMode = "cimd" | "dcr" | "pre-registered";
type AudienceMode = "exact" | "origin";

/** RFC 8414 authorization server metadata, validated by the SDK schema. */
type AuthServerMetadata = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	response_types_supported: string[];
	code_challenge_methods_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
	client_id_metadata_document_supported?: boolean;
};

/** RFC 9728 protected resource metadata (schema-validated; servers must be non-empty by our policy). */
interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers: string[];
	scopes_supported?: string[];
}

interface Discovery {
	metadata: AuthServerMetadata;
	/** RFC 9728 metadata when present; the source of default scopes (SEP-835). */
	protectedResource?: ProtectedResourceMetadata;
	/** RFC 9728 resource audience declared by the protected resource, sent as the `resource` parameter. */
	resource?: string;
	/** RFC 8414/OIDC issuer selected by the protected-resource metadata. */
	issuer?: string;
	/** How the declared resource associates with the configured endpoint. */
	audienceMode?: AudienceMode;
}

export interface McpOAuthConfig {
	/** MCP server name; provider id becomes `mcp:<server>`. */
	server: string;
	/** Human-readable label shown in OAuth UI; defaults to `server`. */
	label?: string;
	/** MCP resource URL used for protected-resource and authorization-server discovery. */
	url: string;
	/** Pre-registered client id (servers without DCR, e.g. Slack). */
	clientId?: string;
	/** Requested OAuth scopes; defaults to the protected-resource metadata's advertised scopes. */
	scopes?: string;
	/** Advisory registration capability from the service catalog; shapes error guidance only. */
	clientRegistration?: "dynamic" | "pre-registered" | "unknown";
	/**
	 * Prime-controlled client metadata document URL (SEP-991 / client-initiated metadata).
	 * Used as the client id only when the authorization server advertises
	 * `client_id_metadata_document_supported`. Must be an HTTPS URL with a non-root path.
	 * No URL is invented: CIMD is only a supported configuration, never a default identity.
	 */
	clientMetadataUrl?: string;
	/**
	 * Confidential client secret. Supplied at runtime (host settings/consent flow), never embedded
	 * in source or the catalog. An explicit empty string fails the flow; only omitted means public.
	 */
	clientSecret?: string;
}

interface McpCredentials extends OAuthCredentials {
	tokenEndpoint?: string;
	clientId?: string;
	/** MCP endpoint the token was issued for; consumers refuse to send it elsewhere. */
	endpoint?: string;
	/** RFC 9728 resource audience the token was issued for. */
	resource?: string;
	/** RFC 8414/OIDC issuer selected by the protected-resource metadata. */
	issuer?: string;
	/** How `resource` associates with the configured endpoint; required whenever `resource` is set. */
	audienceMode?: AudienceMode;
	/** Server-issued (DCR) client secret. Config-supplied secrets are never persisted here. */
	clientSecret?: string;
	/** RFC 7591 epoch seconds when the DCR client secret expires; 0 means it does not expire. */
	clientSecretExpiresAt?: number;
	/** Auth method used to obtain the stored grant; renegotiated against current server metadata. */
	clientAuthMethod?: ClientAuthMethod;
	/** How the client identity was established for the stored grant. */
	clientRegistration?: ClientRegistrationMode;
}

/** Stored grant is no longer valid (invalid_grant); the user must re-run login. */
class McpOAuthGrantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthGrantError";
	}
}

/** Client authentication failed or the configured client identity is unusable. */
class McpOAuthClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthClientError";
	}
}

function validatedHttpsUrl(value: string, name: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new Error(`${name} must be an absolute HTTPS URL without credentials or a fragment`);
	}
	return url;
}

function canonicalResource(url: URL): string {
	if (url.pathname === "/" && !url.search) return url.origin;
	return `${url.origin}${url.pathname}${url.search}`;
}

function authorizationServerMetadataUrls(issuer: string): string[] {
	const url = validatedHttpsUrl(issuer, "Authorization server issuer");
	if (url.search) throw new Error("Authorization server issuer must not contain a query string");
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
	return [
		new URL(`/.well-known/oauth-authorization-server${path}`, url.origin).toString(),
		new URL(`${path}/.well-known/openid-configuration`, url.origin).toString(),
	];
}

function boundSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchResponse(
	url: string,
	init: RequestInit | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(url, { ...init, redirect: "error", signal: boundSignal(signal, timeoutMs) });
}

/** Read a response body with a hard size bound; never trust unbounded server payloads. */
async function readBodyBounded(response: Response, url: string, limitBytes = MAX_METADATA_BYTES): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return response.text();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limitBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`Response from ${url} exceeds the ${limitBytes} byte limit`);
		}
		chunks.push(value);
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

async function jsonMetadata(response: Response, url: string): Promise<unknown> {
	if (response.status !== 200) throw new Error(`GET ${url} failed: ${response.status}`);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") throw new Error(`GET ${url} did not return application/json`);
	try {
		return JSON.parse(await readBodyBounded(response, url));
	} catch (error) {
		if (error instanceof Error && error.message.includes("byte limit")) throw error;
		throw new Error(`GET ${url} returned invalid JSON`);
	}
}

function authorizationServerMetadata(value: unknown, issuer: string, requireExactIssuer: boolean): AuthServerMetadata {
	if (!value || typeof value !== "object") throw new Error(`Authorization server metadata for ${issuer} is invalid`);
	// SDK-standard structural validation (RFC 8414): required endpoints and types.
	let metadata: AuthServerMetadata;
	try {
		metadata = OAuthMetadataSchema.parse(value) as AuthServerMetadata;
	} catch {
		throw new Error(`Authorization server metadata for ${issuer} is invalid`);
	}
	if (requireExactIssuer) {
		if (metadata.issuer !== issuer) {
			throw new Error(`Authorization server metadata issuer does not exactly match ${issuer}`);
		}
	} else {
		const advertisedIssuer = validatedHttpsUrl(metadata.issuer, "Authorization server metadata issuer");
		if (advertisedIssuer.origin !== new URL(issuer).origin || advertisedIssuer.search) {
			throw new Error(`Origin authorization server metadata issuer must stay on ${new URL(issuer).origin}`);
		}
	}
	validatedHttpsUrl(metadata.authorization_endpoint, "Authorization endpoint");
	validatedHttpsUrl(metadata.token_endpoint, "Token endpoint");
	if (metadata.registration_endpoint) validatedHttpsUrl(metadata.registration_endpoint, "Registration endpoint");
	return metadata;
}

async function discoverAuthorizationServer(
	issuer: string,
	requireExactIssuer: boolean,
	signal?: AbortSignal,
): Promise<AuthServerMetadata> {
	const candidates = authorizationServerMetadataUrls(issuer);
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const response = await fetchResponse(candidate, undefined, DISCOVERY_TIMEOUT_MS, signal);
			if (response.status === 404) continue;
			return authorizationServerMetadata(await jsonMetadata(response, candidate), issuer, requireExactIssuer);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not discover OAuth metadata for ${issuer}. Tried ${candidates.join(", ")}. Last error: ${String(lastError)}`,
	);
}

/** Random, URL-safe CSRF `state` value, independent of the PKCE verifier. */
function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

/**
 * Narrow audience policy: the resource declared by protected-resource metadata must be
 * the exact canonical configured endpoint, or the endpoint's exact HTTPS origin —
 * component-compared, never a string prefix. Anything else fails closed.
 */
function resourceAudienceMode(endpoint: URL, declared: string): AudienceMode {
	const resource = validatedHttpsUrl(declared, "Protected-resource resource");
	const sameOrigin = resource.origin === endpoint.origin;
	const exact = sameOrigin && resource.pathname === endpoint.pathname && resource.search === endpoint.search;
	if (exact) return "exact";
	const originLevel = sameOrigin && (resource.pathname === "/" || resource.pathname === "") && !resource.search;
	if (originLevel) return "origin";
	throw new Error(
		`Protected-resource metadata resource does not match the configured endpoint ${canonicalResource(endpoint)} or its origin`,
	);
}

function resourceMetadata(value: unknown, endpoint: URL): ProtectedResourceMetadata {
	if (!value || typeof value !== "object") throw new Error("Protected-resource metadata is invalid");
	let parsed: ProtectedResourceMetadata & { authorization_servers?: unknown };
	try {
		parsed = OAuthProtectedResourceMetadataSchema.parse(value) as ProtectedResourceMetadata & {
			authorization_servers?: unknown;
		};
	} catch {
		throw new Error("Protected-resource metadata is invalid");
	}
	if (!Array.isArray(parsed.authorization_servers) || parsed.authorization_servers.length === 0) {
		throw new Error("Protected-resource metadata has no authorization_servers");
	}
	for (const issuer of parsed.authorization_servers) {
		if (typeof issuer !== "string")
			throw new Error("Protected-resource metadata has an invalid authorization server");
		validatedHttpsUrl(issuer, "Authorization server issuer");
	}
	resourceAudienceMode(endpoint, parsed.resource);
	return parsed as ProtectedResourceMetadata;
}

function resourceMetadataUrl(resource: URL): string {
	const path = resource.pathname === "/" ? "" : resource.pathname;
	return `${resource.origin}/.well-known/oauth-protected-resource${path}${resource.search}`;
}

function rootResourceMetadataUrl(resource: URL): string {
	return `${resource.origin}/.well-known/oauth-protected-resource${resource.search}`;
}

async function tryProtectedResourceMetadata(
	url: string,
	signal?: AbortSignal,
): Promise<ProtectedResourceMetadata | undefined> {
	const resource = validatedHttpsUrl(url, "MCP endpoint");
	let headerUrl: string | undefined;
	try {
		// This probe deliberately has no Authorization header. It must not leak an existing token.
		const response = await fetchResponse(resource.toString(), undefined, DISCOVERY_TIMEOUT_MS, signal);
		headerUrl = extractWWWAuthenticateParams(response).resourceMetadataUrl?.toString();
		await response.body?.cancel();
	} catch {
		// The server need not support a GET probe; use the RFC well-known locations below.
	}
	if (headerUrl) {
		// A server-supplied pointer must exist (fail closed on any non-200) and be absolute HTTPS.
		validatedHttpsUrl(headerUrl, "resource_metadata");
		const response = await fetchResponse(headerUrl, undefined, DISCOVERY_TIMEOUT_MS, signal);
		return resourceMetadata(await jsonMetadata(response, headerUrl), resource);
	}
	// RFC 9728 path-inserted location first, then the origin-level root location
	// (SDK parity: 4xx at one location is not proof the other is absent).
	const candidates =
		resource.pathname === "/" || resource.pathname === ""
			? [resourceMetadataUrl(resource)]
			: [resourceMetadataUrl(resource), rootResourceMetadataUrl(resource)];
	for (const candidate of candidates) {
		const response = await fetchResponse(candidate, undefined, DISCOVERY_TIMEOUT_MS, signal);
		if (response.status >= 400 && response.status < 500) continue;
		return resourceMetadata(await jsonMetadata(response, candidate), resource);
	}
	return undefined;
}

/** Discover RFC 9728 protected-resource metadata before the origin-level authorization server fallback. */
async function discover(url: string, signal?: AbortSignal): Promise<Discovery> {
	const endpoint = validatedHttpsUrl(url, "MCP endpoint");
	const protectedResource = await tryProtectedResourceMetadata(url, signal);
	if (protectedResource) {
		const issuer = protectedResource.authorization_servers[0];
		const audienceMode = resourceAudienceMode(endpoint, protectedResource.resource);
		return {
			metadata: await discoverAuthorizationServer(issuer, true, signal),
			protectedResource,
			resource: protectedResource.resource,
			issuer,
			audienceMode,
		};
	}
	const issuer = endpoint.origin;
	return { metadata: await discoverAuthorizationServer(issuer, false, signal) };
}

/** SEP-835 scope precedence: configured scopes, then protected-resource scopes, never a blind AS-wide join. */
function resolveScope(configured: string | undefined, protectedResource: ProtectedResourceMetadata | undefined) {
	return configured ?? protectedResource?.scopes_supported?.join(" ");
}

interface ResolvedClient {
	clientId: string;
	clientSecret?: string;
	clientRegistration: ClientRegistrationMode;
	/** Method hint from the registration response; negotiated against server metadata. */
	dcrAuthMethod?: string;
	/** RFC 7591 epoch seconds when a DCR-issued client secret expires; 0 means it does not expire. */
	secretExpiresAt?: number;
	/** Only DCR-issued secrets are persisted with credentials; config-supplied secrets are re-resolved. */
	persistSecret: boolean;
}

/** Config-supplied secrets: explicit empty fails; omitted means public/none. */
function configuredSecret(config: McpOAuthConfig, label: string): string | undefined {
	if (config.clientSecret === undefined) return undefined;
	if (config.clientSecret === "") {
		throw new McpOAuthClientError(
			`A client secret is configured for ${label} but it is empty; provide the secret or remove the configuration.`,
		);
	}
	return config.clientSecret;
}

/**
 * SDK-standard client auth method negotiation, plus a compatibility gate: we never
 * silently downgrade a server that only supports secret-based methods to a doomed
 * no-auth request — we fail early with setup guidance instead.
 */
function negotiateAuthMethod(
	clientInfo: { client_id: string; client_secret?: string; token_endpoint_auth_method?: string },
	supported: string[] | undefined,
	label: string,
): ClientAuthMethod {
	const method = selectClientAuthMethod(
		clientInfo,
		supported === undefined || supported.length === 0 ? [] : supported,
	) as ClientAuthMethod;
	if (supported && supported.length > 0 && !supported.includes(method)) {
		throw new McpOAuthClientError(
			`${label} does not support any compatible client authentication method (advertised: ${supported.join(", ")}); re-run /mcp login with an explicit client id or secret configured.`,
		);
	}
	if (method !== "none" && !clientInfo.client_secret) {
		throw new McpOAuthClientError(
			`${label} requires client authentication method ${method} but no client secret is available; configure the client secret and re-run /mcp login.`,
		);
	}
	return method;
}

/** RFC 6749/6750 error codes that are safe to surface; unknown server strings are omitted. */
const SAFE_OAUTH_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"invalid_scope",
	"unauthorized_client",
	"unsupported_grant_type",
	"unsupported_response_type",
	"unsupported_token_type",
	"server_error",
	"temporarily_unavailable",
	"access_denied",
]);

/** Only whitelisted, length-capped codes reach messages; everything else is dropped. */
function safeErrorCode(code: string | undefined): string | undefined {
	if (!code || code.length > 32 || !SAFE_OAUTH_ERROR_CODES.has(code)) return undefined;
	return code;
}

/** Sanitized OAuth error classification: fixed guidance, never raw server-controlled descriptions. */
async function oauthRequestError(response: Response, step: string, label: string, server: string): Promise<Error> {
	let code: string | undefined;
	try {
		const parsed = OAuthErrorResponseSchema.safeParse(JSON.parse(await readBodyBounded(response, response.url)));
		code = safeErrorCode(parsed.success ? parsed.data.error : undefined);
	} catch {
		// Not a valid OAuth error response; report status only.
	}
	if (code === "invalid_grant") {
		return new McpOAuthGrantError(`The stored ${label} login is no longer valid; re-run /mcp login ${server}.`);
	}
	if (code === "invalid_client") {
		return new McpOAuthClientError(
			`${label} client authentication failed (HTTP ${response.status}); re-check the configured client credentials or re-run /mcp login ${server}.`,
		);
	}
	return new Error(`${step} failed (HTTP ${response.status}${code ? `, error ${code}` : ""})`);
}

async function registerClient(
	registrationEndpoint: string,
	label: string,
	scope: string | undefined,
	signal?: AbortSignal,
): Promise<ResolvedClient> {
	validatedHttpsUrl(registrationEndpoint, "Registration endpoint");
	const body = {
		client_name: `Prime Agent (${label})`,
		redirect_uris: ALL_REDIRECT_URIS,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...(scope ? { scope } : {}),
	};
	const res = await fetchResponse(
		registrationEndpoint,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		REGISTRATION_TIMEOUT_MS,
		signal,
	);
	if (!res.ok) {
		let code: string | undefined;
		try {
			const parsed = OAuthErrorResponseSchema.safeParse(JSON.parse(await readBodyBounded(res, res.url)));
			code = safeErrorCode(parsed.success ? parsed.data.error : undefined);
		} catch {
			// Report status only.
		}
		throw new Error(
			`Dynamic client registration at ${registrationEndpoint} failed (HTTP ${res.status}${code ? `, error ${code}` : ""})`,
		);
	}
	let registered: ReturnType<typeof OAuthClientInformationFullSchema.parse>;
	try {
		registered = OAuthClientInformationFullSchema.parse(JSON.parse(await readBodyBounded(res, registrationEndpoint)));
	} catch {
		throw new Error(`Dynamic client registration at ${registrationEndpoint} returned an invalid registration`);
	}
	const authMethod = registered.token_endpoint_auth_method;
	if (authMethod && authMethod !== "none" && !registered.client_secret) {
		throw new Error(
			`Dynamic client registration at ${registrationEndpoint} selected client authentication method ${authMethod} without issuing a client secret`,
		);
	}
	return {
		clientId: registered.client_id,
		clientSecret: registered.client_secret,
		clientRegistration: "dcr",
		dcrAuthMethod: registered.token_endpoint_auth_method,
		secretExpiresAt: registered.client_secret_expires_at,
		persistSecret: true,
	};
}

type CallbackResult = { code: string; state: string } | null;

async function startCallbackServer(label: string): Promise<{
	server: Server;
	redirectUri: string;
	cancel: () => void;
	waitForCode: () => Promise<CallbackResult>;
}> {
	const { createServer } = await import("node:http");
	let settle: ((value: CallbackResult) => void) | undefined;
	const waitPromise = new Promise<CallbackResult>((resolve) => {
		let settled = false;
		settle = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
	});

	const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
		const url = new URL(req.url || "", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthErrorHtml("Callback route not found."));
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		res.writeHead(error || !code ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
		if (error) {
			res.end(oauthErrorHtml(`${label} authentication failed.`, `Error: ${error}`));
			settle?.(null);
			return;
		}
		if (!code || !state) {
			res.end(oauthErrorHtml("Missing code or state parameter."));
			settle?.(null);
			return;
		}
		res.end(oauthSuccessHtml(`${label} authentication completed. You can close this window.`));
		settle?.({ code, state });
	};

	// Try each candidate port with a FRESH server (a server that failed to listen
	// can't be reused), so a leaked/concurrent login can't block us with EADDRINUSE.
	let lastError: unknown;
	for (const port of CALLBACK_PORTS) {
		const server = createServer(handler);
		// Persistent handler so a post-bind 'error' is never an unhandled crash.
		let bindErr: ((err: unknown) => void) | undefined;
		server.on("error", (err) => bindErr?.(err));
		try {
			const bound = await new Promise<boolean>((resolve) => {
				bindErr = () => resolve(false);
				server.listen(port, CALLBACK_HOST, () => {
					bindErr = undefined;
					resolve(true);
				});
			});
			if (bound) {
				return {
					server,
					redirectUri: redirectUriFor(port),
					cancel: () => settle?.(null),
					waitForCode: () => waitPromise,
				};
			}
			lastError = `port ${port} in use`;
			server.close();
		} catch (err) {
			lastError = err;
			server.close();
		}
	}
	throw new Error(
		`Could not start the OAuth callback server: ports ${CALLBACK_PORT_BASE}-${
			CALLBACK_PORT_BASE + CALLBACK_PORT_COUNT - 1
		} are all in use. Close other login attempts and retry. (${String(lastError)})`,
	);
}

function parseRedirectInput(input: string, expectedState: string): { code: string; state: string } {
	const value = input.trim();
	let code: string | undefined;
	let state: string | undefined;
	try {
		const url = new URL(value);
		code = url.searchParams.get("code") ?? undefined;
		state = url.searchParams.get("state") ?? undefined;
	} catch {
		const params = new URLSearchParams(value);
		code = params.get("code") ?? value;
		state = params.get("state") ?? undefined;
	}
	if (state && state !== expectedState) {
		throw new Error("OAuth state mismatch");
	}
	if (!code) {
		throw new Error("Missing authorization code");
	}
	return { code, state: state ?? expectedState };
}

/** Apply the negotiated client authentication (RFC 6749 section 2.3.1) to a token request. */
function applyClientAuthentication(
	method: ClientAuthMethod,
	clientId: string,
	clientSecret: string | undefined,
	headers: Record<string, string>,
	params: URLSearchParams,
): void {
	switch (method) {
		case "client_secret_basic":
			if (!clientSecret)
				throw new McpOAuthClientError("client_secret_basic authentication requires a client_secret");
			headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
			return;
		case "client_secret_post":
			params.set("client_id", clientId);
			if (clientSecret) params.set("client_secret", clientSecret);
			return;
		case "none":
			params.set("client_id", clientId);
			return;
	}
}

async function exchangeToken(
	tokenEndpoint: string,
	params: URLSearchParams,
	method: ClientAuthMethod,
	clientId: string,
	clientSecret: string | undefined,
	step: string,
	label: string,
	server: string,
	signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
	validatedHttpsUrl(tokenEndpoint, "Token endpoint");
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	applyClientAuthentication(method, clientId, clientSecret, headers, params);
	const res = await fetchResponse(
		tokenEndpoint,
		{ method: "POST", headers, body: params.toString() },
		TOKEN_TIMEOUT_MS,
		signal,
	);
	if (!res.ok) throw await oauthRequestError(res, step, label, server);
	let token: ReturnType<typeof OAuthTokensSchema.parse>;
	try {
		token = OAuthTokensSchema.parse(JSON.parse(await readBodyBounded(res, tokenEndpoint)));
	} catch {
		throw new Error(`${step} returned an invalid token response`);
	}
	return { access_token: token.access_token, refresh_token: token.refresh_token, expires_in: token.expires_in };
}

function toCredentials(
	token: { access_token: string; refresh_token?: string; expires_in?: number },
	tokenEndpoint: string,
	identity: {
		clientId: string;
		clientSecret?: string;
		clientRegistration: ClientRegistrationMode;
		authMethod: ClientAuthMethod;
		secretExpiresAt?: number;
		persistSecret: boolean;
	},
	endpoint: string | undefined,
	resource: string | undefined,
	issuer: string | undefined,
	audienceMode: AudienceMode | undefined,
	previousRefresh?: string,
): McpCredentials {
	return {
		access: token.access_token,
		// Some servers omit refresh_token on refresh; keep the prior one.
		refresh: token.refresh_token ?? previousRefresh ?? "",
		expires: token.expires_in
			? Date.now() + token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS
			: Date.now() + 3600 * 1000 - TOKEN_EXPIRY_BUFFER_MS,
		tokenEndpoint,
		clientId: identity.clientId,
		endpoint,
		resource,
		issuer,
		audienceMode,
		clientRegistration: identity.clientRegistration,
		clientAuthMethod: identity.authMethod,
		...(identity.persistSecret && identity.clientSecret
			? { clientSecret: identity.clientSecret, clientSecretExpiresAt: identity.secretExpiresAt }
			: {}),
	};
}

export function createMcpOAuthProvider(config: McpOAuthConfig): OAuthProviderInterface {
	const label = config.label ?? config.server;

	async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");
		// Fail fast on a misconfigured secret before any network request.
		const configSecret = configuredSecret(config, label);
		const discovery = await discover(config.url, callbacks.signal);
		const { metadata: meta } = discovery;
		if (!meta.response_types_supported.includes("code")) {
			throw new Error(`${label} does not support the authorization code flow`);
		}
		if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes("S256")) {
			throw new Error(`${label} does not support PKCE S256`);
		}
		callbacks.onProgress?.(`Discovered ${discovery.issuer ?? meta.issuer}`);

		// SEP-835: configured scopes, then the protected-resource metadata's scopes; never a blind AS-wide join.
		// SEP-835: configured scopes, then protected-resource scopes; never a blind AS-wide join.
		const scope = resolveScope(config.scopes, discovery.protectedResource);

		const { verifier, challenge } = await generatePKCE();
		// `state` must be independent of the PKCE verifier — the verifier is the
		// secret used at token exchange, while `state` is echoed on the redirect URL.
		const state = randomState();
		const cb = await startCallbackServer(label);
		const abort = () => cb.cancel();
		callbacks.signal?.addEventListener("abort", abort, { once: true });
		try {
			// Client identity: pre-registered id, CIMD (when advertised and configured), then DCR.
			let clientId = config.clientId;
			let clientSecret = configSecret;
			let registration: ClientRegistrationMode = "pre-registered";
			let dcrMethod: string | undefined;
			let secretExpiresAt: number | undefined;
			let persistSecret = false;
			if (!clientId) {
				if (meta.client_id_metadata_document_supported === true && config.clientMetadataUrl) {
					const metadataUrl = validatedHttpsUrl(config.clientMetadataUrl, "Client metadata URL");
					if (metadataUrl.pathname === "/" || metadataUrl.pathname === "") {
						throw new Error("Client metadata URL must be an HTTPS URL with a non-root path");
					}
					callbacks.onProgress?.("Using client-initiated metadata…");
					clientId = config.clientMetadataUrl;
					registration = "cimd";
				} else if (meta.registration_endpoint) {
					callbacks.onProgress?.("Registering OAuth client…");
					const registered = await registerClient(meta.registration_endpoint, label, scope, callbacks.signal);
					clientId = registered.clientId;
					clientSecret = registered.clientSecret ?? clientSecret;
					secretExpiresAt = registered.secretExpiresAt;
					persistSecret = registered.persistSecret;
					dcrMethod = registered.dcrAuthMethod;
					registration = "dcr";
				} else {
					throw new Error(
						`${label} does not support dynamic client registration and no clientId was configured. ` +
							`Set a pre-registered client id for this server.`,
					);
				}
			}
			const authMethod = negotiateAuthMethod(
				{ client_id: clientId, client_secret: clientSecret, token_endpoint_auth_method: dcrMethod },
				meta.token_endpoint_auth_methods_supported,
				label,
			);

			const authParams = new URLSearchParams({
				client_id: clientId,
				response_type: "code",
				redirect_uri: cb.redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
			});
			if (scope) authParams.set("scope", scope);
			if (discovery.resource) authParams.set("resource", discovery.resource);

			const authorizationUrl = new URL(meta.authorization_endpoint);
			for (const [name, value] of authParams) authorizationUrl.searchParams.set(name, value);
			callbacks.onAuth({
				url: authorizationUrl.toString(),
				instructions:
					"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
			});

			// Race the local callback server against a manual paste (browser on
			// another machine). The login dialog supplies onManualCodeInput; when
			// absent we fall back to a blocking prompt after the callback resolves.
			let result: { code: string; state: string } | null;
			let manualCancelled = false;
			let manualError: Error | undefined;
			if (callbacks.onManualCodeInput) {
				// Manual paste races the browser callback. A real paste cancels the
				// callback waiter (we're done). On manual cancellation we still settle
				// the waiter to avoid hanging when no redirect arrives — but only after
				// a short grace period so an in-flight browser redirect can win first.
				const manual = callbacks
					.onManualCodeInput()
					.then((input) => {
						const parsed = parseRedirectInput(input, state); // may throw a validation error
						cb.cancel();
						return parsed;
					})
					.catch(async (err) => {
						// A validation error on a real paste (bad state / no code) is a genuine
						// failure to surface; a UI cancellation is not. .catch also prevents an
						// unhandled rejection when the callback wins the race.
						if (err instanceof Error && /state mismatch|authorization code/i.test(err.message)) {
							manualError = err;
						} else {
							manualCancelled = true;
						}
						await new Promise((r) => setTimeout(r, 500));
						cb.cancel();
						return null;
					});
				const fromCallback = await cb.waitForCode();
				result = fromCallback ?? (await manual);
				if (!result && manualError) throw manualError;
			} else {
				result = await cb.waitForCode();
				if (!result) {
					const input = await callbacks.onPrompt({
						message: "Paste the authorization code or full redirect URL:",
						placeholder: cb.redirectUri,
					});
					result = parseRedirectInput(input, state);
				}
			}
			if (!result) {
				throw new Error(manualCancelled ? "Login cancelled" : "Missing authorization code");
			}
			if (result.state !== state) {
				throw new Error("OAuth state mismatch");
			}

			callbacks.onProgress?.("Exchanging authorization code for tokens…");
			const tokenParams = new URLSearchParams({
				grant_type: "authorization_code",
				code: result.code,
				redirect_uri: cb.redirectUri,
				code_verifier: verifier,
			});
			if (discovery.resource) tokenParams.set("resource", discovery.resource);
			const token = await exchangeToken(
				meta.token_endpoint,
				tokenParams,
				authMethod,
				clientId,
				clientSecret,
				"Authorization code exchange",
				label,
				config.server,
				callbacks.signal,
			);
			return toCredentials(
				token,
				meta.token_endpoint,
				{
					clientId,
					clientSecret,
					clientRegistration: registration,
					authMethod,
					secretExpiresAt,
					persistSecret,
				},
				config.url,
				discovery.resource,
				discovery.issuer,
				discovery.audienceMode,
			);
		} finally {
			callbacks.signal?.removeEventListener("abort", abort);
			cb.cancel();
			cb.server.close();
			cb.server.closeAllConnections?.();
		}
	}

	async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as McpCredentials;
		if (creds.endpoint !== config.url) {
			throw new Error(`Stored OAuth credentials are not bound to ${config.url}; re-run /mcp login ${config.server}`);
		}
		const endpointUrl = validatedHttpsUrl(config.url, "MCP endpoint");
		const configuredResource = canonicalResource(endpointUrl);
		if (creds.resource !== undefined) {
			// Audience-aware binding: exact grants (and legacy grants, which were only
			// ever issued under exact matching) pin to the canonical endpoint; origin-mode
			// grants pin to the endpoint's exact origin. Anything else fails closed.
			const storedAudience = canonicalResource(validatedHttpsUrl(creds.resource, "Stored resource audience"));
			const allowedAudience = creds.audienceMode === "origin" ? endpointUrl.origin : configuredResource;
			if (storedAudience !== allowedAudience) {
				throw new Error(
					`Stored OAuth credentials are not bound to ${allowedAudience}; re-run /mcp login ${config.server}`,
				);
			}
		}
		if ((creds.resource === undefined) !== (creds.issuer === undefined)) {
			throw new Error(
				`Stored OAuth credentials for ${label} have incomplete resource binding; re-run /mcp login ${config.server}`,
			);
		}
		// Stored audience modes are JSON-sourced; unknown values require re-login.
		if (
			creds.resource !== undefined &&
			creds.audienceMode !== undefined &&
			creds.audienceMode !== "exact" &&
			creds.audienceMode !== "origin"
		) {
			throw new Error(
				`Stored OAuth credentials for ${label} have an unknown audience mode; re-run /mcp login ${config.server}`,
			);
		}
		// Legacy credentials predate audience modes: they were only ever issued under
		// exact resource matching, so only "exact" re-discovery may serve them.
		const legacyAudience = creds.resource !== undefined && creds.audienceMode === undefined;
		if (creds.issuer !== undefined) validatedHttpsUrl(creds.issuer, "Stored authorization server issuer");
		if (!creds.refresh) {
			throw new Error(`No refresh token stored for ${label}; re-run /mcp login ${config.server}`);
		}
		// Config identity changes must not silently reuse another client's grant.
		if (config.clientId !== undefined && creds.clientId !== undefined && creds.clientId !== config.clientId) {
			throw new McpOAuthClientError(
				`Stored OAuth credentials for ${label} belong to a different client id than the configured one; re-run /mcp login ${config.server}`,
			);
		}
		if (
			config.clientMetadataUrl !== undefined &&
			creds.clientRegistration === "cimd" &&
			creds.clientId !== config.clientMetadataUrl
		) {
			throw new McpOAuthClientError(
				`Stored OAuth credentials for ${label} were issued to a different client metadata URL; re-run /mcp login ${config.server}`,
			);
		}
		if (config.clientId !== undefined && creds.clientRegistration === "cimd") {
			throw new McpOAuthClientError(
				`Stored OAuth credentials for ${label} were issued via client metadata, not the configured client id; re-run /mcp login ${config.server}`,
			);
		}
		// Resolve the client secret before re-discovery: explicit config first (empty
		// fails), then the persisted DCR-issued secret — never a stale fallback for a
		// missing config secret. Expiry is checked without any network access.
		let clientSecret = configuredSecret(config, label);
		const usedStoredSecret = clientSecret === undefined && creds.clientSecret !== undefined;
		if (usedStoredSecret) {
			const expiresAt = creds.clientSecretExpiresAt;
			if (expiresAt !== undefined && expiresAt !== 0 && expiresAt * 1000 < Date.now()) {
				throw new McpOAuthClientError(
					`The registered client secret for ${label} has expired; re-run /mcp login ${config.server}`,
				);
			}
			clientSecret = creds.clientSecret;
		}
		// Refresh always runs bounded, even though the host refresh interface supplies no abort signal.
		const discovery = await discover(config.url);
		if ((creds.resource === undefined) !== (discovery.resource === undefined)) {
			throw new Error(`OAuth discovery mode changed for ${config.url}; re-run /mcp login ${config.server}`);
		}
		if (creds.resource) {
			if (discovery.resource !== creds.resource || discovery.issuer !== creds.issuer) {
				throw new Error(
					`Stored OAuth credentials do not match current protected-resource metadata for ${config.url}`,
				);
			}
			if (legacyAudience && discovery.audienceMode !== "exact") {
				throw new Error(
					`Stored OAuth credentials for ${label} predate origin-level resource audiences and may not be refreshed against them; re-run /mcp login ${config.server}`,
				);
			}
			if (!legacyAudience && discovery.audienceMode !== creds.audienceMode) {
				throw new Error(
					`Stored OAuth credentials do not match current resource audience for ${config.url}; re-run /mcp login ${config.server}`,
				);
			}
		}
		const tokenEndpoint = creds.tokenEndpoint ?? discovery.metadata.token_endpoint;
		if (creds.tokenEndpoint && discovery.metadata.token_endpoint !== creds.tokenEndpoint) {
			throw new Error(
				`Stored OAuth token endpoint does not match current authorization-server metadata for ${config.url}`,
			);
		}
		if (!tokenEndpoint) throw new Error(`No token endpoint stored for ${label}; re-run /mcp login ${config.server}`);
		const clientId = creds.clientId ?? config.clientId;
		if (!clientId) throw new Error(`No client id stored for ${label}; re-run /mcp login ${config.server}`);
		const authMethod = negotiateAuthMethod(
			{ client_id: clientId, client_secret: clientSecret, token_endpoint_auth_method: creds.clientAuthMethod },
			discovery.metadata.token_endpoint_auth_methods_supported,
			label,
		);
		const tokenParams = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: creds.refresh,
		});
		if (creds.resource) tokenParams.set("resource", creds.resource);
		const token = await exchangeToken(
			tokenEndpoint,
			tokenParams,
			authMethod,
			clientId,
			clientSecret,
			"Token refresh",
			label,
			config.server,
		);
		return toCredentials(
			token,
			tokenEndpoint,
			{
				clientId,
				clientSecret: clientSecret ?? creds.clientSecret,
				clientRegistration: creds.clientRegistration ?? (config.clientId ? "pre-registered" : "dcr"),
				authMethod,
				secretExpiresAt: creds.clientSecretExpiresAt,
				// Config-supplied secrets are never persisted; stored DCR secrets are.
				persistSecret: usedStoredSecret,
			},
			creds.endpoint,
			creds.resource,
			creds.issuer,
			creds.audienceMode,
			creds.refresh,
		);
	}

	return {
		id: `mcp:${config.server}`,
		name: label,
		usesCallbackServer: true,
		login,
		refreshToken,
		getApiKey: (credentials) => credentials.access,
	};
}
