/**
 * xAI Grok OAuth flow (SuperGrok subscription)
 *
 * Uses the shared Grok CLI OAuth client so an
 * existing SuperGrok subscription logs in directly, like Claude Pro/Max and
 * ChatGPT Plus/Pro do today.
 *
 * Primary flow: authorization code + PKCE with a local callback server on
 * 127.0.0.1:56121 (the redirect URI registered for that client). If the port
 * cannot be bound (another Grok client is running), falls back to the device
 * authorization grant, which also works headless / remote / VPS.
 *
 * NOTE: This module uses Node.js http for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const ALLOWED_BROWSER_ORIGINS = new Set(["https://accounts.x.ai", "https://auth.x.ai"]);
const DEFAULT_EXPIRES_IN = 3600;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEVICE_DEFAULT_INTERVAL_MS = 5000;
const DEVICE_MIN_INTERVAL_MS = 1000;
const DEVICE_SLOW_DOWN_STEP_MS = 5000;
const DEVICE_JITTER_MS = 3000;
const DEVICE_DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

type CallbackResult = { code: string } | { error: string } | null;

interface CallbackServer {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<CallbackResult>;
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAuthorizeUrl(challenge: string, state: string, nonce: string): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		nonce,
		plan: "generic",
		referrer: "prime-agent",
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

async function tokenRequest(body: Record<string, string>, label: string): Promise<Record<string, unknown>> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(body).toString(),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`xAI ${label} failed (${response.status})${text ? `: ${text}` : ""}`);
	}
	return (await response.json()) as Record<string, unknown>;
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenResponse> {
	const json = (await tokenRequest(
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		},
		"token exchange",
	)) as TokenResponse;
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error(`xAI token exchange response missing fields: ${JSON.stringify(json)}`);
	}
	return json;
}

type TokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
};

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
	const response = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`xAI device code request failed (${response.status})${text ? `: ${text}` : ""}`);
	}
	const json = (await response.json()) as DeviceCodeResponse;
	if (!json.device_code || !json.user_code || !json.verification_uri) {
		throw new Error("xAI device code response is missing device_code / user_code / verification_uri");
	}
	return json;
}

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
};

async function pollDeviceToken(
	device: DeviceCodeResponse,
	options: { signal?: AbortSignal } = {},
): Promise<TokenResponse> {
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const toMs = (value: unknown, fallback: number) => {
		const num = Number(value);
		return Number.isFinite(num) && num > 0 ? num * 1000 : fallback;
	};
	const deadline = Date.now() + toMs(device.expires_in, DEVICE_DEFAULT_EXPIRY_MS);
	let interval = Math.max(toMs(device.interval, DEVICE_DEFAULT_INTERVAL_MS), DEVICE_MIN_INTERVAL_MS);
	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				grant_type: DEVICE_GRANT_TYPE,
				client_id: CLIENT_ID,
				device_code: device.device_code,
			}).toString(),
		});
		if (response.ok) {
			return (await response.json()) as TokenResponse;
		}
		const json = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
		const remaining = Math.max(0, deadline - Date.now());
		if (json.error === "authorization_pending") {
			await sleep(Math.min(interval + DEVICE_JITTER_MS, remaining));
			continue;
		}
		if (json.error === "slow_down") {
			interval += DEVICE_SLOW_DOWN_STEP_MS;
			await sleep(Math.min(interval + DEVICE_JITTER_MS, remaining));
			continue;
		}
		if (json.error === "access_denied" || json.error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (json.error === "expired_token") {
			throw new Error("xAI device code expired - please re-run login");
		}
		const detail = json.error_description ?? json.error ?? "";
		throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	throw new Error("xAI device authorization timed out");
}

async function startCallbackServer(state: string): Promise<CallbackServer | null> {
	const http = await import("node:http");
	let settleWait: ((value: CallbackResult) => void) | undefined;
	const waitForCodePromise = new Promise<CallbackResult>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});
	const server = http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
			const origin = req.headers.origin;
			const allowOrigin = typeof origin === "string" && ALLOWED_BROWSER_ORIGINS.has(origin) ? origin : "";
			if (allowOrigin) {
				res.setHeader("Access-Control-Allow-Origin", allowOrigin);
				res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type");
				res.setHeader("Access-Control-Allow-Private-Network", "true");
				res.setHeader("Vary", "Origin");
			}
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
			if (url.pathname !== CALLBACK_PATH) {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const description = url.searchParams.get("error_description") || error;
				settleWait?.({ error: description });
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml(description));
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
		}
	});
	return new Promise<CallbackServer | null>((resolve) => {
		server
			.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null);
					},
					waitForCode: () => waitForCodePromise,
				});
			})
			.on("error", () => {
				// Port unavailable (e.g. another Grok client is running): caller
				// falls back to the device code flow. Waiters settle with null.
				settleWait?.(null);
				resolve(null);
			});
	});
}

function toCredentials(json: TokenResponse, fallbackRefresh: string): OAuthCredentials {
	return {
		access: json.access_token,
		refresh: json.refresh_token || fallbackRefresh,
		expires:
			Date.now() +
			(typeof json.expires_in === "number" ? json.expires_in : DEFAULT_EXPIRES_IN) * 1000 -
			EXPIRY_BUFFER_MS,
	};
}

/**
 * Login with xAI Grok OAuth (SuperGrok subscription)
 */
export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { onAuth, onPrompt, onProgress, onManualCodeInput, signal } = callbacks;
	const pkce = await generatePKCE();
	const state = randomToken();
	const nonce = randomToken();
	const url = buildAuthorizeUrl(pkce.challenge, state, nonce);
	const server = await startCallbackServer(state);
	if (!server) {
		onProgress?.(
			"Local callback port unavailable (another Grok client may be running). Using xAI device code flow instead.",
		);
		const device = await requestDeviceCode();
		const target = device.verification_uri_complete ?? device.verification_uri;
		onAuth({
			url: target,
			instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
		});
		const tokens = await pollDeviceToken(device, { signal });
		if (!tokens.access_token || !tokens.refresh_token || typeof tokens.expires_in !== "number") {
			throw new Error(`xAI device token response missing fields: ${JSON.stringify(tokens)}`);
		}
		return toCredentials(tokens, "");
	}
	onAuth({ url, instructions: "A browser window should open. Sign in with your xAI account to finish." });
	let code: string | undefined;
	try {
		if (onManualCodeInput) {
			// Race between browser callback and manual input (same as OpenAI Codex)
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = onManualCodeInput()
				.then((input) => {
					manualCode = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});
			const result = await server.waitForCode();
			if (manualError) {
				throw manualError;
			}
			if (result && "error" in result && result.error) {
				throw new Error(result.error);
			}
			if (result && "code" in result) {
				code = result.code;
			} else if (manualCode) {
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualCode) {
					const parsed = parseAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== state) {
						throw new Error("State mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result && "error" in result && result.error) {
				throw new Error(result.error);
			}
			if (result && "code" in result) {
				code = result.code;
			}
		}
		if (!code) {
			const input = await onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}
		if (!code) {
			throw new Error("Missing authorization code");
		}
		const tokens = await exchangeAuthorizationCode(code, pkce.verifier);
		return toCredentials(tokens, "");
	} finally {
		server.close();
	}
}

/**
 * Refresh xAI OAuth token.
 * xAI rotates refresh tokens; the new one is returned when present.
 */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const json = (await tokenRequest(
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		},
		"token refresh",
	)) as TokenResponse;
	if (!json.access_token) {
		throw new Error(`xAI token refresh response missing access_token: ${JSON.stringify(json)}`);
	}
	return toCredentials(json, refreshToken);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI Grok (SuperGrok Subscription)",
	usesCallbackServer: true,
	async login(callbacks) {
		return loginXai(callbacks);
	},
	async refreshToken(credentials) {
		return refreshXaiToken(credentials.refresh);
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};
