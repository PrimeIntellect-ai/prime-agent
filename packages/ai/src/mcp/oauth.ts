import type { Server } from "node:http";
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

interface AuthServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
}

interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers: string[];
}

interface Discovery {
	metadata: AuthServerMetadata;
	resource?: string;
	issuer?: string;
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
	/** Requested OAuth scopes; defaults to the server's advertised scopes. */
	scopes?: string;
}

interface McpCredentials extends OAuthCredentials {
	tokenEndpoint?: string;
	clientId?: string;
	/** MCP endpoint the token was issued for; consumers refuse to send it elsewhere. */
	endpoint?: string;
	/** RFC 9728 resource indicator. Its presence marks a PRM-based login. */
	resource?: string;
	/** RFC 8414/OIDC issuer selected by the protected-resource metadata. */
	issuer?: string;
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

async function fetchResponse(url: string, init?: RequestInit): Promise<Response> {
	return fetch(url, { ...init, redirect: "error" });
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetchResponse(url, init);
	if (!res.ok) {
		throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status}`);
	}
	return res.json();
}

function authorizationServerMetadata(value: unknown, issuer: string, requireExactIssuer: boolean): AuthServerMetadata {
	if (!value || typeof value !== "object") throw new Error(`Authorization server metadata for ${issuer} is invalid`);
	const metadata = value as Partial<AuthServerMetadata>;
	if (typeof metadata.issuer !== "string") {
		throw new Error(`Authorization server metadata for ${issuer} is missing its issuer`);
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
	if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
		throw new Error(`Authorization server metadata for ${issuer} is missing required endpoints`);
	}
	validatedHttpsUrl(metadata.authorization_endpoint, "Authorization endpoint");
	validatedHttpsUrl(metadata.token_endpoint, "Token endpoint");
	if (metadata.registration_endpoint) validatedHttpsUrl(metadata.registration_endpoint, "Registration endpoint");
	return metadata as AuthServerMetadata;
}

async function jsonMetadata(response: Response, url: string): Promise<unknown> {
	if (response.status !== 200) throw new Error(`GET ${url} failed: ${response.status}`);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") throw new Error(`GET ${url} did not return application/json`);
	return response.json();
}

async function discoverAuthorizationServer(issuer: string, requireExactIssuer: boolean): Promise<AuthServerMetadata> {
	const candidates = authorizationServerMetadataUrls(issuer);
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const response = await fetchResponse(candidate);
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

function resourceMetadata(value: unknown, resource: string): ProtectedResourceMetadata {
	if (!value || typeof value !== "object") throw new Error("Protected-resource metadata is invalid");
	const metadata = value as Partial<ProtectedResourceMetadata>;
	if (metadata.resource !== resource)
		throw new Error(`Protected-resource metadata resource does not exactly match ${resource}`);
	if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0) {
		throw new Error("Protected-resource metadata has no authorization_servers");
	}
	for (const issuer of metadata.authorization_servers) {
		if (typeof issuer !== "string")
			throw new Error("Protected-resource metadata has an invalid authorization server");
		validatedHttpsUrl(issuer, "Authorization server issuer");
	}
	return metadata as ProtectedResourceMetadata;
}

function resourceMetadataUrl(resource: URL): string {
	const path = resource.pathname === "/" ? "" : resource.pathname;
	return `${resource.origin}/.well-known/oauth-protected-resource${path}${resource.search}`;
}

function headerResourceMetadata(value: string | null): string | undefined {
	const match = value?.match(/(?:^|[,\s])resource_metadata\s*=\s*"((?:[^"\\]|\\.)*)"/i);
	if (!match) return undefined;
	return match[1].replace(/\\(.)/g, "$1");
}

async function tryProtectedResourceMetadata(url: string): Promise<ProtectedResourceMetadata | undefined> {
	const resource = validatedHttpsUrl(url, "MCP endpoint");
	let headerUrl: string | undefined;
	try {
		// This probe deliberately has no Authorization header. It must not leak an existing token.
		const response = await fetchResponse(resource.toString());
		headerUrl = headerResourceMetadata(response.headers.get("www-authenticate"));
		await response.body?.cancel();
	} catch {
		// The server need not support a GET probe; use the RFC well-known locations below.
	}

	const candidate = headerUrl
		? validatedHttpsUrl(headerUrl, "resource_metadata").toString()
		: resourceMetadataUrl(resource);
	const response = await fetchResponse(candidate);
	if (response.status === 404 && !headerUrl) return undefined;
	return resourceMetadata(await jsonMetadata(response, candidate), canonicalResource(resource));
}

/** Discover RFC 9728 protected-resource metadata before the origin-level authorization server fallback. */
async function discover(url: string): Promise<Discovery> {
	const protectedResource = await tryProtectedResourceMetadata(url);
	if (protectedResource) {
		const issuer = protectedResource.authorization_servers[0];
		return {
			metadata: await discoverAuthorizationServer(issuer, true),
			resource: protectedResource.resource,
			issuer,
		};
	}
	const issuer = validatedHttpsUrl(url, "MCP endpoint").origin;
	return { metadata: await discoverAuthorizationServer(issuer, false) };
}

async function registerClient(registrationEndpoint: string, label: string): Promise<string> {
	validatedHttpsUrl(registrationEndpoint, "Registration endpoint");
	const body = {
		client_name: label,
		redirect_uris: ALL_REDIRECT_URIS,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	const data = (await fetchJson(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})) as { client_id?: unknown };
	if (typeof data.client_id !== "string" || !data.client_id) {
		throw new Error(`Dynamic client registration at ${registrationEndpoint} returned no client_id`);
	}
	return data.client_id;
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

async function exchangeToken(
	tokenEndpoint: string,
	params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
	validatedHttpsUrl(tokenEndpoint, "Token endpoint");
	const res = await fetchResponse(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Token request to ${tokenEndpoint} failed: ${res.status}`);
	}
	let token: unknown;
	try {
		token = JSON.parse(text);
	} catch {
		throw new Error(`Token request to ${tokenEndpoint} returned invalid JSON`);
	}
	if (!token || typeof token !== "object" || typeof (token as { access_token?: unknown }).access_token !== "string") {
		throw new Error(`Token request to ${tokenEndpoint} returned no access_token`);
	}
	const result = token as { access_token: string; refresh_token?: unknown; expires_in?: unknown };
	if (!result.access_token) throw new Error(`Token request to ${tokenEndpoint} returned no access_token`);
	if (result.refresh_token !== undefined && typeof result.refresh_token !== "string") {
		throw new Error(`Token request to ${tokenEndpoint} returned an invalid refresh_token`);
	}
	if (
		result.expires_in !== undefined &&
		(typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in))
	) {
		throw new Error(`Token request to ${tokenEndpoint} returned an invalid expires_in`);
	}
	return result as { access_token: string; refresh_token?: string; expires_in?: number };
}

function toCredentials(
	token: { access_token: string; refresh_token?: string; expires_in?: number },
	tokenEndpoint: string,
	clientId: string,
	endpoint: string | undefined,
	resource: string | undefined,
	issuer: string | undefined,
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
		clientId,
		endpoint,
		resource,
		issuer,
	};
}

export function createMcpOAuthProvider(config: McpOAuthConfig): OAuthProviderInterface {
	const label = config.label ?? config.server;

	async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const discovery = await discover(config.url);
		const { metadata: meta } = discovery;
		callbacks.onProgress?.(`Discovered ${discovery.issuer ?? meta.issuer}`);

		let clientId = config.clientId;
		if (!clientId) {
			if (!meta.registration_endpoint) {
				throw new Error(
					`${label} does not support dynamic client registration and no clientId was configured. ` +
						`Set a pre-registered client id for this server.`,
				);
			}
			callbacks.onProgress?.("Registering OAuth client…");
			clientId = await registerClient(meta.registration_endpoint, `Prime Agent (${label})`);
		}

		const { verifier, challenge } = await generatePKCE();
		// `state` must be independent of the PKCE verifier — the verifier is the
		// secret used at token exchange, while `state` is echoed on the redirect URL.
		const state = randomState();
		const scope = config.scopes ?? meta.scopes_supported?.join(" ");
		const cb = await startCallbackServer(label);
		try {
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
			const token = await exchangeToken(meta.token_endpoint, {
				grant_type: "authorization_code",
				code: result.code,
				redirect_uri: cb.redirectUri,
				client_id: clientId,
				code_verifier: verifier,
				...(discovery.resource ? { resource: discovery.resource } : {}),
			});
			return toCredentials(token, meta.token_endpoint, clientId, config.url, discovery.resource, discovery.issuer);
		} finally {
			cb.server.close();
		}
	}

	async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as McpCredentials;
		if (creds.endpoint !== config.url) {
			throw new Error(`Stored OAuth credentials are not bound to ${config.url}; re-run /mcp login ${config.server}`);
		}
		const configuredResource = canonicalResource(validatedHttpsUrl(config.url, "MCP endpoint"));
		if (creds.resource !== undefined && creds.resource !== configuredResource) {
			throw new Error(
				`Stored OAuth credentials are not bound to ${configuredResource}; re-run /mcp login ${config.server}`,
			);
		}
		if ((creds.resource === undefined) !== (creds.issuer === undefined)) {
			throw new Error(
				`Stored OAuth credentials for ${label} have incomplete resource binding; re-run /mcp login ${config.server}`,
			);
		}
		if (creds.issuer !== undefined) validatedHttpsUrl(creds.issuer, "Stored authorization server issuer");
		if (!creds.refresh) {
			throw new Error(`No refresh token stored for ${label}; re-run /mcp login ${config.server}`);
		}
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
		}
		const tokenEndpoint = creds.tokenEndpoint ?? discovery.metadata.token_endpoint;
		if (creds.tokenEndpoint && discovery.metadata.token_endpoint !== creds.tokenEndpoint) {
			throw new Error(
				`Stored OAuth token endpoint does not match current authorization-server metadata for ${config.url}`,
			);
		}
		const clientId = creds.clientId ?? config.clientId;
		if (!tokenEndpoint) throw new Error(`No token endpoint stored for ${label}; re-run /mcp login ${config.server}`);
		const token = await exchangeToken(tokenEndpoint, {
			grant_type: "refresh_token",
			refresh_token: creds.refresh,
			...(clientId ? { client_id: clientId } : {}),
			...(creds.resource ? { resource: creds.resource } : {}),
		});
		return toCredentials(
			token,
			tokenEndpoint,
			clientId ?? "",
			creds.endpoint,
			creds.resource,
			creds.issuer,
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
