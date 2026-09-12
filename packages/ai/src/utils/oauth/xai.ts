import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type OAuthResponse = { ok: boolean; status: number; body: JsonObject };

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid xAI OAuth response field: ${field}`);
	return value;
}

function positiveSeconds(value: unknown, field: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value * 1000 > Number.MAX_SAFE_INTEGER - Date.now()
	) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function verificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	if (url.protocol !== "https:" || url.username || url.password || /[\u0000-\u0020\u007f-\u009f]/.test(raw)) {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	return url.href;
}

function checkCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Login cancelled");
}

async function postForm(
	url: string,
	fields: Record<string, string>,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<OAuthResponse> {
	checkCancelled(signal);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, REQUEST_TIMEOUT_MS));
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
			signal: controller.signal,
			redirect: "error",
		});
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			if (controller.signal.aborted) throw new Error("Request aborted");
			throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
		}
		checkCancelled(signal);
		if (controller.signal.aborted) throw new Error("Request aborted");
		return {
			ok: response.ok,
			status: response.status,
			body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {},
		};
	} catch (error) {
		checkCancelled(signal);
		if (controller.signal.aborted) throw new Error("xAI OAuth request timed out. Try signing in again.");
		if (error instanceof Error && error.message.startsWith("xAI OAuth returned invalid JSON")) throw error;
		throw new Error("xAI OAuth request failed. Check your connection and try again.");
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestFailure(action: string, response: OAuthResponse): Error {
	// Do not print arbitrary provider response bodies: they may echo credentials.
	const code = response.body.error === "invalid_grant" ? ": authorization expired or revoked; sign in again" : "";
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${code}`);
}

function credentialsFromResponse(body: JsonObject, previousRefresh?: string): OAuthCredentials {
	const access = requiredString(body, "access_token");
	const refresh =
		body.refresh_token === undefined && previousRefresh ? previousRefresh : requiredString(body, "refresh_token");
	const lifetimeMs = positiveSeconds(body.expires_in === undefined ? 3600 : body.expires_in, "expires_in") * 1000;
	return { access, refresh, expires: Date.now() + lifetimeMs - Math.min(REFRESH_SKEW_MS, lifetimeMs / 2) };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const response = await postForm(
		DEVICE_CODE_URL,
		{ client_id: CLIENT_ID, scope: SCOPE, referrer: "pi" },
		callbacks.signal,
	);
	if (!response.ok) throw requestFailure("device authorization", response);
	const deviceCode = requiredString(response.body, "device_code");
	const userCode = requiredString(response.body, "user_code");
	if (!/^[A-Za-z0-9-]+$/.test(userCode)) throw new Error("Invalid xAI OAuth response field: user_code");
	const url = verificationUri(requiredString(response.body, "verification_uri"));
	const deadline = Date.now() + positiveSeconds(response.body.expires_in, "expires_in") * 1000;
	const interval = response.body.interval;
	let intervalMs =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0
			? Math.max(1000, interval * 1000)
			: 5000;
	callbacks.onAuth({ url, instructions: `Enter code: ${userCode}` });
	while (Date.now() < deadline) {
		await wait(Math.min(intervalMs, deadline - Date.now(), 2_147_483_647), callbacks.signal);
		checkCancelled(callbacks.signal);
		if (Date.now() >= deadline) break;
		const token = await postForm(
			TOKEN_URL,
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: deviceCode,
			},
			callbacks.signal,
			deadline - Date.now(),
		);
		if (token.ok) return credentialsFromResponse(token.body);
		if (token.body.error === "authorization_pending") continue;
		if (token.body.error === "slow_down") {
			const next = token.body.interval;
			intervalMs =
				typeof next === "number" && Number.isFinite(next) && next > 0
					? Math.max(intervalMs + 5000, next * 1000)
					: intervalMs + 5000;
			continue;
		}
		if (token.body.error === "access_denied" || token.body.error === "authorization_denied")
			throw new Error("xAI device authorization was denied");
		if (token.body.error === "expired_token") throw new Error("xAI device code expired; sign in again");
		throw requestFailure("device token polling", token);
	}
	throw new Error("xAI device code expired; sign in again");
}

export async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const response = await postForm(
		TOKEN_URL,
		{ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken },
		signal,
	);
	if (!response.ok) throw requestFailure("token refresh", response);
	return credentialsFromResponse(response.body, refreshToken);
}

export function getXaiSubscriptionModel(model: Model<Api>): Model<"openai-responses"> | undefined {
	if (model.provider !== "xai" || model.id !== "grok-4.5") return undefined;
	return {
		...model,
		api: "openai-responses",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null },
		compat: { supportsLongCacheRetention: false },
	};
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI",
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
