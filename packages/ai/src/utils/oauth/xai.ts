import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_OAUTH_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_INFERENCE_BASE_URL = "https://api.x.ai/v1";
const XAI_REFRESH_SKEW_MS = 60 * 60 * 1000;
const XAI_SHORT_TOKEN_SKEW_MS = 2 * 60 * 1000;
const XAI_SHORT_TOKEN_THRESHOLD_MS = 45 * 60 * 1000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface XaiOAuthCredentials extends OAuthCredentials {
	tokenEndpoint: string;
}

interface XaiDiscovery {
	authorization_endpoint?: unknown;
	token_endpoint?: unknown;
}

interface XaiDeviceCode {
	device_code?: unknown;
	user_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface XaiTokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
	error_description?: unknown;
}

function validateXaiEndpoint(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) {
		throw new Error(`xAI OAuth discovery is missing ${field}`);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`xAI OAuth discovery returned an invalid ${field}`);
	}
	if (url.protocol !== "https:" || (url.hostname !== "x.ai" && !url.hostname.endsWith(".x.ai"))) {
		throw new Error(`xAI OAuth discovery returned an untrusted ${field}`);
	}
	return url.toString();
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
	if (!response.ok) {
		throw new Error(`${operation} failed with HTTP ${response.status}`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`${operation} returned invalid JSON`);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error(`${operation} returned an invalid response`);
	}
	return payload as Record<string, unknown>;
}

async function discoverXaiOAuth(signal?: AbortSignal): Promise<string> {
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal,
	});
	const discovery = (await readJson(response, "xAI OAuth discovery")) as XaiDiscovery;
	validateXaiEndpoint(discovery.authorization_endpoint, "authorization_endpoint");
	return validateXaiEndpoint(discovery.token_endpoint, "token_endpoint");
}

function formBody(values: Record<string, string>): URLSearchParams {
	return new URLSearchParams(values);
}

function requireString(value: unknown, field: string, operation: string): string {
	if (typeof value !== "string" || !value) {
		throw new Error(`${operation} response is missing ${field}`);
	}
	return value;
}

function requirePositiveNumber(value: unknown, field: string, operation: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${operation} response has invalid ${field}`);
	}
	return value;
}

function credentialsFromToken(
	payload: XaiTokenResponse,
	tokenEndpoint: string,
	previousRefresh?: string,
): XaiOAuthCredentials {
	const access = requireString(payload.access_token, "access_token", "xAI OAuth token");
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : previousRefresh;
	if (!refresh) {
		throw new Error("xAI OAuth token response is missing refresh_token");
	}
	const expiresIn = requirePositiveNumber(payload.expires_in, "expires_in", "xAI OAuth token");
	const lifetimeMs = expiresIn * 1000;
	const refreshSkewMs = lifetimeMs <= XAI_SHORT_TOKEN_THRESHOLD_MS ? XAI_SHORT_TOKEN_SKEW_MS : XAI_REFRESH_SKEW_MS;
	return {
		access,
		refresh,
		expires: Date.now() + Math.max(0, lifetimeMs - refreshSkewMs),
		tokenEndpoint,
	};
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new Error("Login cancelled"));
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: formBody({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
		signal,
	});
	return (await readJson(response, "xAI device authorization")) as XaiDeviceCode;
}

async function pollForToken(
	tokenEndpoint: string,
	deviceCode: string,
	expiresInSeconds: number,
	intervalSeconds: number,
	signal?: AbortSignal,
): Promise<XaiOAuthCredentials> {
	const deadline = Date.now() + expiresInSeconds * 1000;
	let intervalMs = Math.max(1000, intervalSeconds * 1000);

	while (Date.now() < deadline) {
		await abortableDelay(Math.min(intervalMs, deadline - Date.now()), signal);
		if (Date.now() > deadline) break;

		const response = await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: formBody({
				grant_type: DEVICE_CODE_GRANT,
				client_id: XAI_OAUTH_CLIENT_ID,
				device_code: deviceCode,
			}),
			signal,
		});
		let payload: XaiTokenResponse;
		try {
			payload = (await response.json()) as XaiTokenResponse;
		} catch {
			throw new Error(`xAI device token request failed with HTTP ${response.status}`);
		}
		if (response.ok) {
			return credentialsFromToken(payload, tokenEndpoint);
		}
		if (payload.error === "authorization_pending") continue;
		if (payload.error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		const code = typeof payload.error === "string" ? ` (${payload.error})` : "";
		throw new Error(`xAI device token request failed with HTTP ${response.status}${code}`);
	}
	throw new Error("Timed out waiting for xAI device authorization");
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const tokenEndpoint = await discoverXaiOAuth(callbacks.signal);
	const device = await requestDeviceCode(callbacks.signal);
	const deviceCode = requireString(device.device_code, "device_code", "xAI device authorization");
	const userCode = requireString(device.user_code, "user_code", "xAI device authorization");
	const verificationUri = requireString(device.verification_uri, "verification_uri", "xAI device authorization");
	const verificationUriComplete =
		typeof device.verification_uri_complete === "string" && device.verification_uri_complete
			? device.verification_uri_complete
			: verificationUri;
	const expiresIn = requirePositiveNumber(device.expires_in, "expires_in", "xAI device authorization");
	const interval = requirePositiveNumber(device.interval, "interval", "xAI device authorization");

	callbacks.onAuth({ url: verificationUriComplete, instructions: `Enter code: ${userCode}` });
	callbacks.onProgress?.("Waiting for xAI authorization...");
	return pollForToken(tokenEndpoint, deviceCode, expiresIn, interval, callbacks.signal);
}

export async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const storedEndpoint = (credentials as Partial<XaiOAuthCredentials>).tokenEndpoint;
	const tokenEndpoint = storedEndpoint
		? validateXaiEndpoint(storedEndpoint, "token_endpoint")
		: await discoverXaiOAuth();
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: formBody({
			grant_type: "refresh_token",
			client_id: XAI_OAUTH_CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
	});
	const payload = (await readJson(response, "xAI token refresh")) as XaiTokenResponse;
	return credentialsFromToken(payload, tokenEndpoint, credentials.refresh);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI Grok (SuperGrok / X Premium+)",
	login: loginXai,
	refreshToken: refreshXaiToken,
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
	modifyModels(models: Model<Api>[]): Model<Api>[] {
		return models.map((model) => {
			if (model.provider !== "xai") return model;
			const { compat: _compat, ...rest } = model;
			return { ...rest, api: "openai-responses", baseUrl: XAI_INFERENCE_BASE_URL } as Model<Api>;
		});
	},
};
