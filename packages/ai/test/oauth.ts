import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { getOAuthApiKey } from "../src/utils/oauth/index.js";
import type { OAuthCredentials, OAuthProvider } from "../src/utils/oauth/types.js";

/**
 * Credential helper for the live provider tests in this package.
 *
 * Live tests are opt-in. Without `PI_LIVE_TESTS=1` this helper returns `undefined`
 * without touching the filesystem or the network, so every `describe.skipIf(!token)`
 * gate skips. With the opt-in, credentials are read from the file named by
 * `PI_TEST_AUTH_FILE` (same JSON shape as the agent's `auth.json`), never from the
 * developer's real credential stores under `~/.prime/agent` or `~/.pi/agent`.
 * Refreshed OAuth tokens are written back to the test file only.
 */

export const LIVE_TESTS_ENV = "PI_LIVE_TESTS";
export const TEST_AUTH_FILE_ENV = "PI_TEST_AUTH_FILE";

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

export function liveTestsEnabled(): boolean {
	return process.env[LIVE_TESTS_ENV] === "1";
}

function realCredentialStores(): string[] {
	const home = homedir();
	return [join(home, ".prime", "agent", "auth.json"), join(home, ".pi", "agent", "auth.json")].map((p) => resolve(p));
}

/**
 * Path of the test-designated credential file, or `undefined` when live tests are
 * not enabled or no file is configured. Throws if the configured file is one of the
 * real credential stores, so a misconfiguration fails loudly instead of rewriting
 * the developer's credentials.
 */
export function getTestAuthFile(): string | undefined {
	if (!liveTestsEnabled()) return undefined;
	const configured = process.env[TEST_AUTH_FILE_ENV]?.trim();
	if (!configured) return undefined;
	const path = resolve(configured);
	if (realCredentialStores().includes(path)) {
		throw new Error(
			`${TEST_AUTH_FILE_ENV} must point at a dedicated test credential file, not the real credential store at ${path}. ` +
				`Copy the entries you want to test into a separate file.`,
		);
	}
	return path;
}

function loadAuthStorage(path: string): AuthStorage {
	if (!existsSync(path)) {
		return {};
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(path: string, storage: AuthStorage): void {
	const configDir = dirname(path);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(path, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(path, 0o600);
}

export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const path = getTestAuthFile();
	if (!path) return undefined;

	const storage = loadAuthStorage(path);
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		const result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		if (!result) return undefined;

		storage[provider] = { type: "oauth", ...result.newCredentials };
		saveAuthStorage(path, storage);

		return result.apiKey;
	}

	return undefined;
}
