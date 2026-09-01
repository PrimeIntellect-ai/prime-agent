/**
 * xAI (Grok) OAuth device flow — SuperGrok / Premium+ subscriptions.
 *
 * Uses xAI's OAuth 2.0 device authorization grant (RFC 8628) against
 * auth.x.ai: request a device code, have the user approve at
 * verification_uri_complete, then poll the token endpoint. The returned
 * access token is used as the API key against https://api.x.ai/v1.
 *
 * Notes:
 * - The client id is the public grok-cli client (same one other community
 *   clients use); xAI does not offer per-app OAuth registration for CLI tools.
 * - Access tokens are short-lived (about 6h in SuperGrok flows; device logins
 *   can return ~15-minute JWTs). Stored expiry is skewed so the runtime
 *   refresh happens well before the real expiry; the skew scales down for
 *   short-lived tokens so they do not refresh on every call.
 * - xAI rotates the refresh token on every refresh; the response may carry a
 *   new refresh_token which replaces the stored one.
 * - A 403 from the token endpoint is a subscription-tier gate (the OAuth
 *   grant exists but the account is not entitled to API access). Re-login
 *   does not fix it; the XAI_API_KEY provider is the fallback.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

/** How far before real expiry a long-lived token should be refreshed. */
const REFRESH_SKEW_MS = 60 * 60 * 1000;

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval: number;
	expires_in: number;
}

interface TokenPayload {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in: number;
	token_type?: string;
}

interface DeviceTokenErrorResponse {
	error: string;
	error_description?: string;
	interval?: number;
}

/**
 * Compute the stored expiry (ms epoch) for a token issued at `nowMs`.
 *
 * Long-lived tokens are refreshed REFRESH_SKEW_MS early (matches daemon-style
 * workloads that may touch the provider only every 30+ minutes). Short-lived
 * tokens scale the skew down to a quarter of their lifetime so a 15-minute
 * JWT is not refreshed on every call.
 */
export function computeStoredExpiry(nowMs: number, expiresInSeconds: number): number {
	const lifeMs = expiresInSeconds * 1000;
	const skewMs = Math.min(REFRESH_SKEW_MS, Math.floor(lifeMs / 4));
	return nowMs + lifeMs - skewMs;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

function formBody(params: Record<string, string>): URLSearchParams {
	return new URLSearchParams(params);
}

function jsonHeaders(): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	};
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const data = await fetchJson(DEVICE_CODE_URL, {
		method: "POST",
		headers: jsonHeaders(),
		body: formBody({
			client_id: CLIENT_ID,
			scope: SCOPE,
		}),
		signal,
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid xAI device code response");
	}

	const device = data as Record<string, unknown>;
	const deviceCode = device.device_code;
	const userCode = device.user_code;
	const verificationUri = device.verification_uri;
	const interval = device.interval;
	const expiresIn = device.expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid xAI device code response fields");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		verification_uri_complete:
			typeof device.verification_uri_complete === "string" ? device.verification_uri_complete : undefined,
		interval,
		expires_in: expiresIn,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenPayload> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		// Never sleep past the deadline (mirrors the copilot poll loop).
		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal);

		let response: Response;
		try {
			response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: jsonHeaders(),
				body: formBody({
					client_id: CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			});
		} catch {
			// Network-level failures are transient; poll again until the deadline.
			if (signal?.aborted) {
				throw new Error("Login cancelled");
			}
			continue;
		}

		let data: unknown = null;
		try {
			data = await response.json();
		} catch {
			// Non-JSON body (e.g. an HTML error page from a proxy): transient.
			if (!response.ok) {
				continue;
			}
		}

		if (data && typeof data === "object" && typeof (data as TokenPayload).access_token === "string") {
			const payload = data as TokenPayload;
			if (!payload.access_token) {
				throw new Error("xAI device flow returned an empty access token");
			}
			return payload;
		}

		if (data && typeof data === "object" && typeof (data as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = data as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}
			if (error === "slow_down") {
				// RFC 8628: increase the interval by at least 5 seconds; a server
				// hint can widen it further but must never shrink it.
				const serverIntervalMs = typeof interval === "number" && interval > 0 ? interval * 1000 : 0;
				intervalMs = Math.max(intervalMs + 5000, serverIntervalMs);
				continue;
			}
			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`xAI device flow failed: ${error}${descriptionSuffix}`);
		}
	}

	throw new Error("xAI device flow timed out");
}

function tokenPayloadToCredentials(payload: TokenPayload, nowMs: number): OAuthCredentials {
	return {
		access: payload.access_token,
		refresh: payload.refresh_token ?? "",
		expires: computeStoredExpiry(nowMs, payload.expires_in),
		...(payload.id_token ? { id_token: payload.id_token } : {}),
	};
}

/**
 * Login with xAI (Grok) OAuth via the device code flow.
 */
export async function loginXai(options: {
	onAuth: (url: string, instructions?: string) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(options.signal);

	const verificationUrl = device.verification_uri_complete || device.verification_uri;
	// The verification URL is opened in the user's browser; only accept xAI's
	// own origin (RFC 8628 recommends clients verify the verification URI).
	try {
		if (new URL(verificationUrl).origin !== ISSUER) {
			throw new Error("unexpected origin");
		}
	} catch {
		throw new Error(`xAI returned an unexpected verification URL: ${verificationUrl}`);
	}
	options.onAuth(verificationUrl, `Enter code: ${device.user_code}`);

	let payload: TokenPayload;
	try {
		payload = await pollForToken(device.device_code, device.interval, device.expires_in, options.signal);
	} catch (error) {
		// Cancellation must surface as a clean "Login cancelled", not a raw AbortError.
		if (options.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
	if (!payload.refresh_token) {
		throw new Error("xAI login response did not include a refresh token");
	}

	return tokenPayloadToCredentials(payload, Date.now());
}

/**
 * Refresh an xAI access token. xAI rotates refresh tokens; when the response
 * carries a new refresh_token it replaces the previous one, otherwise the
 * previous token is kept.
 */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	if (!refreshToken.trim()) {
		throw new Error("xAI OAuth is missing a refresh token. Log in again with /login.");
	}

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: jsonHeaders(),
		body: formBody({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	if (response.status === 403) {
		const detail = (await response.text()).trim();
		throw new Error(
			"xAI token refresh was denied (HTTP 403)." +
				(detail ? ` Response: ${detail}.` : "") +
				" This account is not entitled to xAI API access — xAI may restrict API/OAuth use to specific" +
				" SuperGrok tiers even when the subscription is active. Logging in again will not fix this." +
				" Run /logout to remove the xAI credentials, set XAI_API_KEY to use the API-key provider instead," +
				" or review your subscription at https://x.ai/grok.",
		);
	}

	if (!response.ok) {
		const detail = (await response.text()).trim();
		const reloginHint = response.status === 400 || response.status === 401 ? " Log in again with /login." : "";
		throw new Error(
			`xAI token refresh failed (${response.status} ${response.statusText}).${detail ? ` Response: ${detail}.` : ""}${reloginHint}`,
		);
	}

	const payload = (await response.json()) as TokenPayload;
	if (typeof payload.access_token !== "string" || !payload.access_token) {
		throw new Error("xAI token refresh response did not include an access token. Log in again with /login.");
	}
	if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
		throw new Error("xAI token refresh response did not include a valid expires_in. Log in again with /login.");
	}

	const credentials = tokenPayloadToCredentials(payload, Date.now());
	// Rotation: keep the previous refresh token when the response omits one.
	if (!payload.refresh_token) {
		credentials.refresh = refreshToken;
	}
	return credentials;
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok SuperGrok / Premium+)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXai({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
