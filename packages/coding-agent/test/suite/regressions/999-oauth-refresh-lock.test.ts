import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";

describe("regression: oauth refresh runs outside the auth.json lock", () => {
	let tempDir: string;
	let authJsonPath: string;
	const providerIds: string[] = [];

	function registerTestProvider(refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>): string {
		const providerId = `test-oauth-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		providerIds.push(providerId);
		registerOAuthProvider({
			id: providerId,
			name: "Test OAuth Provider",
			async login() {
				throw new Error("Not used in this test");
			},
			refreshToken,
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});
		return providerId;
	}

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function expiredCredential(overrides: Record<string, unknown> = {}) {
		return {
			type: "oauth",
			refresh: "old-refresh",
			access: "old-access",
			expires: Date.now() - 10_000,
			...overrides,
		};
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-oauth-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		for (const providerId of providerIds.splice(0)) {
			unregisterOAuthProvider(providerId);
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not hold the auth.json lock while the token refresh is in flight", async () => {
		let lockFreeDuringRefresh = false;
		const providerId = registerTestProvider(async (credentials) => {
			try {
				const release = lockfile.lockSync(authJsonPath, { realpath: false });
				release();
				lockFreeDuringRefresh = true;
			} catch {
				// Lock was still held while refreshing.
			}
			return {
				...credentials,
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60_000,
			};
		});

		writeAuthJson({ [providerId]: expiredCredential() });

		const authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey(providerId);

		expect(apiKey).toBe("Bearer new-access");
		expect(lockFreeDuringRefresh).toBe(true);

		const stored = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<
			string,
			{ access: string; refresh: string }
		>;
		expect(stored[providerId].access).toBe("new-access");
		expect(stored[providerId].refresh).toBe("new-refresh");
	});

	it("does not overwrite a fresher credential written during the refresh", async () => {
		const providerId = registerTestProvider(async (credentials) => {
			// Simulate another process refreshing first while our refresh is in flight.
			writeAuthJson({
				[providerId]: expiredCredential({
					refresh: "fresher-refresh",
					access: "fresher-access",
					expires: Date.now() + 60_000,
				}),
			});
			return {
				...credentials,
				access: "stale-access",
				refresh: "stale-rotated-refresh",
				expires: Date.now() + 60_000,
			};
		});

		writeAuthJson({ [providerId]: expiredCredential() });

		const authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey(providerId);

		expect(apiKey).toBe("Bearer fresher-access");

		const stored = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<
			string,
			{ access: string; refresh: string }
		>;
		expect(stored[providerId].access).toBe("fresher-access");
		expect(stored[providerId].refresh).toBe("fresher-refresh");
	});
});
