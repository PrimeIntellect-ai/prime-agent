/**
 * xAI Grok OAuth device authorization flow.
 *
 * RFC 8628 device code against auth.x.ai, then OpenAI-compatible inference
 * at https://api.x.ai/v1 (chat completions). Adapted from can1357/oh-my-pi
 * (MIT), which itself adapted device auth from NousResearch/hermes-agent.
 */

import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_OAUTH_API_HEADERS = {
	"X-XAI-Token-Auth": "xai-grok-cli",
} as const;

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isXaiAuthHostname(host: string): boolean {
	return host === "x.ai" || host.endsWith(".x.ai");
}

/** Pin discovered OIDC URLs to HTTPS `x.ai` / `*.x.ai`. */
export function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || !isXaiAuthHostname(host)) {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	return url;
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

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}
}

async function readJson(response: Response): Promise<unknown> {
	return response.json();
}

async function discoverTokenEndpoint(signal?: AbortSignal): Promise<string> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
		response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		throwIfAborted(signal);
		throw new Error(`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (response.status !== 200) {
		throw new Error(`xAI OIDC discovery returned status ${response.status}.`);
	}

	let payload: unknown;
	try {
		payload = await readJson(response);
	} catch (error) {
		throw new Error(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(payload)) {
		throw new Error("xAI OIDC discovery response was not a JSON object.");
	}

	const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
	if (!tokenEndpoint) {
		throw new Error("xAI OIDC discovery response was missing token_endpoint.");
	}
	return validateXAIEndpoint(tokenEndpoint, "token_endpoint");
}

function parseDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new Error("xAI device-code response was not a JSON object.");
	}

	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
	const verificationUriComplete =
		typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new Error("xAI device-code response missing or invalid required fields.");
	}

	validateXAIEndpoint(verificationUri, "verification_uri");
	validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
	return {
		deviceCode,
		userCode,
		verificationUriComplete,
		expiresInSeconds,
		intervalSeconds,
	};
}

function parseTokenResponse(payload: unknown, label: string, refreshTokenFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new Error(`${label} was not a JSON object`);
	}
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	const responseRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
	const refreshToken = responseRefreshToken || refreshTokenFallback || "";
	const expiresInSeconds = payload.expires_in;
	if (!accessToken) {
		throw new Error(`${label} missing access_token`);
	}
	if (!refreshToken) {
		throw new Error(`${label} missing refresh_token`);
	}
	if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
		throw new Error(`${label} missing expires_in`);
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<XAIDeviceAuthorization> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				client_id: XAI_OAUTH_CLIENT_ID,
				scope: XAI_OAUTH_SCOPE,
			}),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		throwIfAborted(signal);
		throw new Error(`xAI device-code request failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// status is enough
		}
		throw new Error(`xAI device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}

	let payload: unknown;
	try {
		payload = await readJson(response);
	} catch (error) {
		throw new Error(
			`xAI device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseDeviceAuthorization(payload);
}

async function pollDeviceToken(
	tokenEndpoint: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresInSeconds * 1000;
	let intervalMs = Math.max(1, Math.floor(intervalSeconds * 1000));

	while (Date.now() < deadline) {
		throwIfAborted(signal);

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(intervalMs, remainingMs);
		if (waitMs > 0) {
			await abortableSleep(waitMs, signal);
		}

		let response: Response;
		try {
			const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
			response = await fetch(tokenEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_OAUTH_CLIENT_ID,
					device_code: deviceCode,
				}),
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
		} catch (error) {
			throwIfAborted(signal);
			throw new Error(
				`xAI device-code token polling failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		let payload: unknown;
		try {
			payload = await readJson(response);
		} catch (error) {
			throw new Error(
				`xAI device-code token polling returned invalid JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		if (response.ok) {
			return parseTokenResponse(payload, "xAI device-code token response");
		}

		if (!isRecord(payload)) {
			throw new Error(`xAI device-code token polling failed: ${response.status}`);
		}

		const errorCode = typeof payload.error === "string" ? payload.error : "";
		if (errorCode === "authorization_pending") {
			continue;
		}
		if (errorCode === "slow_down") {
			intervalMs += 5000;
			continue;
		}

		const errorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
		throw new Error(`xAI device-code token polling failed: ${errorDescription || errorCode || response.status}`);
	}

	throw new Error("xAI device-code token polling timed out");
}

/** Log in to xAI Grok with the RFC 8628 device authorization grant. */
export async function loginXAIOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const tokenEndpoint = await discoverTokenEndpoint(callbacks.signal);
	const device = await requestDeviceAuthorization(callbacks.signal);
	callbacks.onAuth({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	callbacks.onProgress?.("Waiting for xAI device authorization...");

	return pollDeviceToken(
		tokenEndpoint,
		device.deviceCode,
		device.intervalSeconds,
		device.expiresInSeconds,
		callbacks.signal,
	);
}

/** Refresh an xAI OAuth access token using a stored refresh_token. */
export async function refreshXAIOAuthToken(refreshToken: string): Promise<OAuthCredentials> {
	if (typeof refreshToken !== "string" || !refreshToken.trim()) {
		throw new Error("missing refresh_token");
	}

	const tokenEndpoint = await discoverTokenEndpoint();

	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: XAI_OAUTH_CLIENT_ID,
			refresh_token: refreshToken,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// status is enough
		}
		throw new Error(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}

	let payload: unknown;
	try {
		payload = await readJson(response);
	} catch (error) {
		throw new Error(
			`xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseTokenResponse(payload, "xAI token refresh response", refreshToken);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok or X Premium+)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXAIOAuth(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXAIOAuthToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[]): Model<Api>[] {
		return models.map((model) =>
			model.provider === "xai-oauth"
				? {
						...model,
						baseUrl: model.baseUrl || XAI_API_BASE_URL,
						headers: { ...model.headers, ...XAI_OAUTH_API_HEADERS },
					}
				: model,
		);
	},
};
