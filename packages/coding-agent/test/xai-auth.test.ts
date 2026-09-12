import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { xaiOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type OAuthCredential } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const oauth = (expires = Date.now() + 60_000): OAuthCredential => ({
	type: "oauth",
	access: "subscription-access",
	refresh: "subscription-refresh",
	expires,
});

describe("xAI credential source and request model", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-xai-auth-"));
		vi.stubEnv("XAI_API_KEY", "");
		vi.stubEnv("PI_OFFLINE", "1");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	test("resolves subscription, runtime override, stale fallback and logout without mutating configured API models", async () => {
		vi.stubEnv("XAI_API_KEY", "environment-key");
		const storage = AuthStorage.inMemory();
		const config = join(dir, "models.json");
		writeFileSync(
			config,
			JSON.stringify({
				providers: {
					xai: {
						baseUrl: "https://example.invalid/custom",
						headers: { "X-Custom": "preserved" },
						apiKey: "config-key",
						modelOverrides: { "grok-4.5": { maxTokens: 1234 } },
					},
				},
			}),
		);
		const registry = ModelRegistry.create(storage, config);
		const original = registry.find("xai", "grok-4.5")!;
		const snapshot = structuredClone(original);
		const bundled = structuredClone(getModel("xai", "grok-4.5"));
		storage.set("xai", oauth());
		const subscription = await registry.getApiKeyAndHeaders(original);
		expect(subscription).toMatchObject({
			ok: true,
			apiKey: "subscription-access",
			requestModel: {
				api: "openai-responses",
				baseUrl: "https://api.x.ai/v1",
				maxTokens: 1234,
			},
		});
		expect(registry.find("xai", "grok-4.5")?.api).toBe("openai-responses");
		const cachedSubscription = registry.find("xai", "grok-4.5")!;
		storage.setRuntimeApiKey("xai", "runtime-key");
		expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
			ok: true,
			apiKey: "runtime-key",
			requestModel: snapshot,
			headers: { "X-Custom": "preserved" },
		});
		expect(registry.isUsingOAuth(cachedSubscription)).toBe(false);
		storage.removeRuntimeApiKey("xai");
		storage.markAuthStale("xai");
		expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
			ok: true,
			apiKey: "environment-key",
			requestModel: snapshot,
		});
		vi.stubEnv("XAI_API_KEY", "");
		expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
			ok: true,
			apiKey: "config-key",
			requestModel: snapshot,
		});
		storage.set("xai", { type: "api_key", key: "replacement-key" });
		expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
			ok: true,
			apiKey: "replacement-key",
			requestModel: snapshot,
		});
		storage.set("xai", oauth());
		storage.logout("xai");
		vi.stubEnv("XAI_API_KEY", "environment-key");
		expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
			ok: true,
			apiKey: "environment-key",
			requestModel: snapshot,
		});
		expect(original).toEqual(snapshot);
		expect(getModel("xai", "grok-4.5")).toEqual(bundled);
	});

	test("preserves caller-supplied API model identity and only unwraps subscription copies it created", async () => {
		const storage = AuthStorage.inMemory({ xai: { type: "api_key", key: "saved-key" } });
		const registry = ModelRegistry.inMemory(storage);
		const model = {
			...getModel("xai", "grok-4.5")!,
			api: "caller-api",
			baseUrl: "https://caller.invalid/v2",
			headers: { "X-Caller": "preserved" },
		};
		const keyAuth = await registry.getApiKeyAndHeaders(model);
		expect(keyAuth.ok && keyAuth.requestModel).toBe(model);
		storage.set("xai", oauth());
		const subscription = await registry.getApiKeyAndHeaders(model);
		expect(subscription).toMatchObject({ ok: true, requestModel: { api: "openai-responses" } });
		if (!subscription.ok || !subscription.requestModel) throw new Error("Missing subscription model");
		storage.set("xai", { type: "api_key", key: "restored-key" });
		const restored = await registry.getApiKeyAndHeaders(subscription.requestModel);
		expect(restored.ok && restored.requestModel).toBe(model);
		expect(restored).toMatchObject({ ok: true, headers: { "X-Caller": "preserved" } });
	});

	test.each(["model", "provider", "storage", "request"] as const)(
		"rejects conflicting %s Authorization only for effective subscription auth",
		async (source) => {
			const storage = AuthStorage.inMemory({ xai: oauth() });
			const registry = ModelRegistry.inMemory(storage);
			let model = getModel("xai", "grok-4.5")!;
			const headers = { aUtHoRiZaTiOn: "sensitive-custom-value" };
			if (source === "model") model = { ...model, headers };
			if (source === "provider") registry.registerProvider("xai", { headers });
			if (source === "storage") vi.spyOn(storage, "getProviderHeaders").mockReturnValue(headers);
			const requestHeaders = source === "request" ? headers : undefined;
			const rejected = await registry.getApiKeyAndHeaders(model, requestHeaders);
			expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("Remove the header") });
			expect(JSON.stringify(rejected)).not.toContain("sensitive-custom-value");
			expect(JSON.stringify(rejected)).not.toContain("subscription-access");
			storage.setRuntimeApiKey("xai", "runtime-key");
			expect(await registry.getApiKeyAndHeaders(model, requestHeaders)).toMatchObject({
				ok: true,
				apiKey: "runtime-key",
				headers,
			});
		},
	);

	test("validates the final header merge and accepts only the selected OAuth bearer", async () => {
		const storage = AuthStorage.inMemory({ xai: oauth() });
		const registry = ModelRegistry.inMemory(storage);
		const model = { ...getModel("xai", "grok-4.5")!, headers: { Authorization: "old-key", "X-Order": "model" } };
		registry.registerProvider("xai", { headers: { "X-Order": "provider" } });
		vi.spyOn(storage, "getProviderHeaders").mockReturnValue({ "X-Order": "storage" });
		expect(
			await registry.getApiKeyAndHeaders(model, {
				Authorization: "Bearer subscription-access",
				"X-Order": "request",
			}),
		).toMatchObject({
			ok: true,
			headers: { Authorization: "Bearer subscription-access", "X-Order": "request" },
		});
		expect(await registry.getApiKeyAndHeaders(model, { authorization: "Bearer subscription-access" })).toMatchObject({
			ok: false,
		});
	});

	test("filters unsupported subscription models and rejects explicit requests with login guidance", async () => {
		const storage = AuthStorage.inMemory({ xai: oauth() });
		const registry = ModelRegistry.inMemory(storage);
		const unsupported = registry.find("xai", "grok-4.6")!;
		expect(
			registry
				.getAvailable()
				.filter((model) => model.provider === "xai")
				.map((model) => model.id),
		).toEqual(["grok-4.5"]);
		expect(await registry.getApiKeyAndHeaders(unsupported)).toMatchObject({
			ok: false,
			error: expect.stringContaining("/login xai"),
		});
		await expect(registry.canUseModel(unsupported)).rejects.toThrow("Select xai/grok-4.5");
		storage.setRuntimeApiKey("xai", "runtime-key");
		expect(await registry.getApiKeyAndHeaders(unsupported)).toMatchObject({
			ok: true,
			apiKey: "runtime-key",
			requestModel: { api: "openai-completions" },
		});
	});

	test("uses the credential type returned with the key even if storage changes before dispatch", async () => {
		const storage = AuthStorage.inMemory({ xai: oauth() });
		const registry = ModelRegistry.inMemory(storage);
		const getAuth = storage.getApiKeyWithSourceToken.bind(storage);
		vi.spyOn(storage, "getApiKeyWithSourceToken").mockImplementation(async (...args) => {
			const result = await getAuth(...args);
			storage.set("xai", { type: "api_key", key: "later-key" });
			return result;
		});
		expect(await registry.getApiKeyAndHeaders(registry.find("xai", "grok-4.5")!)).toMatchObject({
			ok: true,
			apiKey: "subscription-access",
			requestModel: { api: "openai-responses" },
		});
	});

	test("refreshes once across file-backed instances, persists rotation and preserves unrelated credentials", async () => {
		const path = join(dir, "auth.json");
		const first = AuthStorage.create(path);
		first.set("xai", oauth(Date.now() - 1000));
		first.set("other", { type: "api_key", key: "keep-me" });
		const second = AuthStorage.create(path);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const refresh = vi.spyOn(xaiOAuthProvider, "refreshToken").mockImplementation(async () => {
			started();
			await gate;
			return { access: "rotated-access", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		});
		const pending = first.getApiKeyWithSourceToken("xai");
		await entered;
		const peer = second.getApiKeyWithSourceToken("xai");
		release();
		const results = await Promise.all([pending, peer]);
		expect(results).toEqual(
			expect.arrayContaining([expect.objectContaining({ apiKey: "rotated-access", credentialType: "oauth" })]),
		);
		expect(results.every((result) => result.apiKey === "rotated-access")).toBe(true);
		expect(refresh).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			xai: { type: "oauth", access: "rotated-access", refresh: "rotated-refresh" },
			other: { type: "api_key", key: "keep-me" },
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("never falls through to provider environment lookup after failed refresh or stale credentials", async () => {
		vi.stubEnv("XAI_API_KEY", "environment-key");
		const storage = AuthStorage.inMemory({ xai: oauth(Date.now() - 1000) });
		const registry = ModelRegistry.inMemory(storage);
		vi.spyOn(xaiOAuthProvider, "refreshToken").mockRejectedValue(new Error("revoked"));
		const model = registry.find("xai", "grok-4.5")!;
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: false,
			error: expect.stringContaining("/login xai"),
		});
		storage.markAuthStale("xai");
		storage.markAuthStale("xai");
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ ok: false });
	});

	test("preserves credentials after refresh failure and allows a later retry", async () => {
		const storage = AuthStorage.create(join(dir, "auth.json"));
		const expired = oauth(Date.now() - 1000);
		storage.set("xai", expired);
		const refresh = vi.spyOn(xaiOAuthProvider, "refreshToken").mockRejectedValueOnce(new Error("revoked"));
		expect(await storage.getApiKey("xai")).toBeUndefined();
		expect(storage.get("xai")).toEqual(expired);
		refresh.mockResolvedValue({ access: "retry-access", refresh: "retry-refresh", expires: Date.now() + 60_000 });
		expect(await storage.getApiKey("xai")).toBe("retry-access");
	});
});
