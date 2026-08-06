/**
 * OpenRouter OAuth PKCE flow.
 *
 * OpenRouter's authorize endpoint has no `client_id`, `scope`, or `state`
 * parameter — the exchange returns an API key rather than an access/refresh
 * token pair, and there is no refresh endpoint. CSRF protection comes from a
 * randomly-generated callback path instead of a `state` value: only a request
 * to that exact path is accepted.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback
 * server. It is only intended for CLI use, not browser environments.
 */

import type { Server, ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

// OpenRouter's authorize page hangs on a `127.0.0.1` callback_url and only
// proceeds for `localhost`, which is also the host its own docs use. The other
// providers here default to the loopback IP; this one must not.
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "localhost";
const AUTHORIZE_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";

type JsonObject = Record<string, unknown>;

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("OpenRouter OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
	response.statusCode = status;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(html);
}

function parseAuthorizationInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;

	try {
		return new URL(value).searchParams.get("code") ?? undefined;
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		return new URLSearchParams(value).get("code") ?? undefined;
	}

	return value;
}

function errorDetail(body: JsonObject): string | undefined {
	if (typeof body.error_description === "string") return body.error_description;
	if (typeof body.message === "string") return body.message;
	if (typeof body.error === "string") return body.error;
	if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
		const message = (body.error as JsonObject).message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}

	let body: JsonObject = {};
	try {
		const parsed = (await response.json()) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
	} catch {
		if (response.ok) throw new Error("OpenRouter OAuth returned invalid JSON");
	}

	if (!response.ok) {
		const detail = errorDetail(body);
		throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
	}

	if (typeof body.key !== "string" || body.key.length === 0) {
		throw new Error('OpenRouter OAuth response carries no "key"');
	}

	return {
		access: body.key,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	};
}

type CallbackResult = { code: string } | null;

type OpenRouterCallbackServer = {
	callbackUrl: string;
	close: () => void;
	/** Hand the login over to manual code entry unless the callback already claimed it. */
	cancelWait: () => void;
	/** Resolves with the code once the browser redirect hits the callback, or null once cancelled. */
	waitForCode: () => Promise<CallbackResult>;
};

async function startCallbackServer(callbackPath: string, signal?: AbortSignal): Promise<OpenRouterCallbackServer> {
	if (signal?.aborted) throw new Error("Login cancelled");
	const { createServer } = await getNodeApis();

	let settled = false;
	let resolveWait: (value: CallbackResult) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitForCodePromise = new Promise<CallbackResult>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// An abort landing before anyone awaits waitForCode() must not surface as an
	// unhandled rejection; the real await further down still observes it.
	waitForCodePromise.catch(() => {});

	const finishResolve = (value: CallbackResult): void => {
		if (settled) return;
		settled = true;
		resolveWait(value);
	};
	const finishReject = (error: Error): void => {
		if (settled) return;
		settled = true;
		rejectWait(error);
	};

	const server: Server = createServer((request, response) => {
		try {
			const requestUrl = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`);
			if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
				sendHtml(response, 404, oauthErrorHtml("OAuth callback route not found."));
				return;
			}

			const oauthError = requestUrl.searchParams.get("error");
			if (oauthError) {
				const description = requestUrl.searchParams.get("error_description") ?? oauthError;
				sendHtml(response, 400, oauthErrorHtml("OpenRouter authorization was denied.", description));
				finishResolve(null);
				return;
			}

			const code = requestUrl.searchParams.get("code");
			if (!code) {
				sendHtml(response, 400, oauthErrorHtml("OpenRouter returned no authorization code."));
				return;
			}

			sendHtml(response, 200, oauthSuccessHtml("Signed in to OpenRouter. You may now close this page."));
			finishResolve({ code });
		} catch {
			sendHtml(response, 500, oauthErrorHtml("Internal error while processing the OAuth callback."));
		}
	});

	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = () => finishReject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	}

	const close = (): void => {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		server.close();
	};

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, CALLBACK_HOST, () => {
			server.removeListener("error", reject);
			server.on("error", (error) => finishReject(error));

			const address = server.address();
			if (!address || typeof address === "string") {
				close();
				reject(new Error("Could not determine the OpenRouter OAuth callback port"));
				return;
			}

			resolve({
				callbackUrl: `http://${CALLBACK_HOST}:${address.port}${callbackPath}`,
				close,
				cancelWait: () => finishResolve(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

/**
 * Login with OpenRouter OAuth (PKCE, loopback callback server).
 */
export async function loginOpenRouter(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const callbackPath = `/oauth/callback/${crypto.randomUUID()}`;
	const server = await startCallbackServer(callbackPath, callbacks.signal);

	try {
		const authorizeUrl = new URL(AUTHORIZE_URL);
		authorizeUrl.search = new URLSearchParams({
			callback_url: server.callbackUrl,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();

		callbacks.onAuth({
			url: authorizeUrl.toString(),
			instructions:
				"Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		let code: string | undefined;

		if (callbacks.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = callbacks
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((error) => {
					manualError = error instanceof Error ? error : new Error(String(error));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) throw manualError;

			if (result?.code) {
				code = result.code;
			} else if (manualInput) {
				code = parseAuthorizationInput(manualInput);
			}

			if (!code) {
				await manualPromise;
				if (manualError) throw manualError;
				if (manualInput) code = parseAuthorizationInput(manualInput);
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) code = result.code;
		}

		if (!code) {
			const input = await callbacks.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
				placeholder: server.callbackUrl,
			});
			code = parseAuthorizationInput(input);
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		callbacks.onProgress?.("Exchanging authorization code for an API key...");
		return await exchangeAuthorizationCode(code, verifier, callbacks.signal);
	} finally {
		server.close();
	}
}

/**
 * OpenRouter's issued key has no refresh token or refresh endpoint. This is
 * dead code in practice because `expires` is set far in the future at login
 * time, but exists to fail loudly (rather than silently) if it is ever
 * invoked against a corrupted or hand-edited credential.
 */
export async function refreshOpenRouterToken(_credentials: OAuthCredentials): Promise<OAuthCredentials> {
	throw new Error("OpenRouter OAuth credentials don't support refresh. Run /login again.");
}

export const openrouterOAuthProvider: OAuthProviderInterface = {
	id: "openrouter",
	name: "OpenRouter",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenRouter(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenRouterToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
