/**
 * xAI OAuth flow (SuperGrok / X Premium subscriptions)
 *
 * RFC 8628 device authorization grant against the xAI OIDC issuer, using the
 * public client that xAI ships in its own Grok CLI. The device flow needs no
 * loopback callback server, so it works over SSH and in containers.
 *
 * Subscription access tokens authorize the Responses API rail the Grok CLI
 * itself uses, so `modifyModels` moves xAI models there while OAuth
 * credentials are active. API-key users keep the untouched Chat Completions
 * models.
 */

import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh five minutes before the token actually expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const RELOGIN_HINT = "Run /login and sign in to xAI again.";

type JsonObject = Record<string, unknown>;

type TokenEndpointResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds: number;
	expiresInSeconds: number;
};

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`xAI OAuth response is missing ${field}`);
	}
	return value;
}

function optionalPositiveNumber(body: JsonObject, field: string): number | undefined {
	const value = body[field];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function httpsUrl(raw: string, field: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`xAI OAuth response has an invalid ${field}: ${raw}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`xAI OAuth response has a non-HTTPS ${field}: ${raw}`);
	}
	return url.href;
}

async function postForm(
	fields: Record<string, string>,
	url: string,
	signal?: AbortSignal,
): Promise<TokenEndpointResponse> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}

	let body: JsonObject = {};
	try {
		const parsed = (await response.json()) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = parsed as JsonObject;
		}
	} catch {
		throw new Error(`xAI OAuth endpoint returned invalid JSON (HTTP ${response.status})`);
	}
	return { ok: response.ok, status: response.status, body };
}

function oauthError(action: string, response: TokenEndpointResponse, hint?: string): Error {
	const code = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [code, description].filter(Boolean).join(": ");
	return new Error(
		`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}${hint ? `. ${hint}` : ""}`,
	);
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredentials {
	const rotatedRefresh = typeof body.refresh_token === "string" && body.refresh_token.length > 0;
	if (!rotatedRefresh && !previousRefreshToken) {
		throw new Error("xAI OAuth response is missing refresh_token");
	}
	const expiresInSeconds = optionalPositiveNumber(body, "expires_in") ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
	return {
		access: requiredString(body, "access_token"),
		refresh: rotatedRefresh ? (body.refresh_token as string) : (previousRefreshToken as string),
		expires: Date.now() + expiresInSeconds * 1000 - EXPIRY_SKEW_MS,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await postForm({ client_id: CLIENT_ID, scope: SCOPE }, DEVICE_CODE_URL, signal);
	if (!response.ok) throw oauthError("device authorization", response);

	const body = response.body;
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? httpsUrl(body.verification_uri_complete, "verification_uri_complete")
			: undefined;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: httpsUrl(requiredString(body, "verification_uri"), "verification_uri"),
		verificationUriComplete,
		intervalSeconds: optionalPositiveNumber(body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds: optionalPositiveNumber(body, "expires_in") ?? 900,
	};
}

async function pollForTokens(device: DeviceAuthorization, signal?: AbortSignal): Promise<OAuthCredentials> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalSeconds = device.intervalSeconds;

	while (true) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalSeconds * 1000, remainingMs), signal);
		if (Date.now() >= deadline) break;

		const response = await postForm(
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: device.deviceCode,
			},
			TOKEN_URL,
			signal,
		);
		if (response.ok) return credentialsFromTokenResponse(response.body);

		const error = response.body.error;
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			// RFC 8628 section 3.5: increase the interval by at least 5 seconds,
			// honoring a larger server-provided interval when present.
			const serverInterval = optionalPositiveNumber(response.body, "interval");
			intervalSeconds = Math.max(serverInterval ?? 0, intervalSeconds + 5);
			continue;
		}
		if (error === "access_denied") throw new Error("xAI device authorization was denied");
		if (error === "expired_token") break;
		throw oauthError("device token polling", response);
	}
	throw new Error("xAI device code expired before the login was approved. Run /login to try again.");
}

/**
 * Login with the xAI device authorization flow (RFC 8628).
 */
export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization(callbacks.signal);
	callbacks.onAuth({
		url: device.verificationUriComplete ?? device.verificationUri,
		instructions: `Confirm code ${device.userCode} in your browser and approve the login.`,
	});
	callbacks.onProgress?.("Waiting for approval...");
	return pollForTokens(device, callbacks.signal);
}

/**
 * Refresh an xAI OAuth access token.
 */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await postForm(
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		},
		TOKEN_URL,
	);
	if (!response.ok) {
		const code = typeof response.body.error === "string" ? response.body.error : undefined;
		const revoked =
			code === "invalid_grant" || code === "invalid_token" || response.status === 401 || response.status === 403;
		throw oauthError("token refresh", response, revoked ? RELOGIN_HINT : undefined);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

/**
 * Move xAI models to the Responses API rail used by subscription tokens.
 * Exported for the provider's `modifyModels` hook and tests.
 */
export function applyXaiOAuthModels(models: Model<Api>[]): Model<Api>[] {
	return models.map((model) => {
		if (model.provider !== "xai" || model.api !== "openai-completions") return model;
		const { compat: _compat, ...rest } = model as Model<"openai-completions">;
		const responsesModel: Model<"openai-responses"> = {
			...rest,
			api: "openai-responses",
			compat: { supportsLongCacheRetention: false },
		};
		if (model.reasoning) {
			// Subscription Grok reasoning models always think; efforts are low/medium/high.
			responsesModel.thinkingLevelMap = { ...model.thinkingLevelMap, off: null, minimal: null };
		}
		return responsesModel;
	});
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (SuperGrok/X Premium)",
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
	modifyModels: (models) => applyXaiOAuthModels(models),
};
