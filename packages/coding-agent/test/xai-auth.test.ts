import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type OAuthCredential } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const oauth = (): OAuthCredential => ({
	type: "oauth",
	access: "subscription-access",
	refresh: "subscription-refresh",
	expires: Date.now() + 60_000,
});

describe("xAI credential source and request model", () => {
	let storage: AuthStorage;
	let registry: ModelRegistry;
	beforeEach(() => {
		vi.stubEnv("XAI_API_KEY", "environment-key");
		storage = AuthStorage.inMemory();
		registry = ModelRegistry.inMemory(storage);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	test("routes the selected OAuth, runtime or stale-fallback credential without changing API-key models", async () => {
		registry.registerProvider("xai", { baseUrl: "https://example.invalid/custom", apiKey: "config-key" });
		const original = registry.find("xai", "grok-4.5")!;
		const snapshot = structuredClone(original);
		storage.set("xai", oauth());
		const cachedSubscription = registry.find("xai", "grok-4.5")!;
		const expectRoute = async (apiKey: string, api: string) => {
			expect(await registry.getApiKeyAndHeaders(cachedSubscription)).toMatchObject({
				ok: true,
				apiKey,
				requestModel: { api, baseUrl: api === "openai-responses" ? "https://api.x.ai/v1" : original.baseUrl },
			});
		};
		await expectRoute("subscription-access", "openai-responses");
		storage.setRuntimeApiKey("xai", "runtime-key");
		await expectRoute("runtime-key", "openai-completions");
		storage.removeRuntimeApiKey("xai");
		storage.markAuthStale("xai");
		await expectRoute("environment-key", "openai-completions");
		vi.stubEnv("XAI_API_KEY", "");
		await expectRoute("config-key", "openai-completions");
		expect(original).toEqual(snapshot);
		expect(getModel("xai", "grok-4.5").api).toBe("openai-completions");
	});

	test("validates final Authorization case-insensitively only for subscription credentials", async () => {
		storage.set("xai", oauth());
		const model = { ...getModel("xai", "grok-4.5"), headers: { Authorization: "custom-secret" } };
		const rejected = await registry.getApiKeyAndHeaders(model);
		expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("Remove the header") });
		expect(JSON.stringify(rejected)).not.toContain("custom-secret");
		expect(await registry.getApiKeyAndHeaders(model, { Authorization: "Bearer subscription-access" })).toMatchObject({
			ok: true,
		});
		expect(await registry.getApiKeyAndHeaders(model, { authorization: "Bearer subscription-access" })).toMatchObject({
			ok: false,
		});
		storage.setRuntimeApiKey("xai", "runtime-key");
		expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
			ok: true,
			apiKey: "runtime-key",
			headers: { Authorization: "custom-secret" },
		});
	});

	test("rejects unsupported subscription models with API-key login guidance", async () => {
		storage.set("xai", oauth());
		expect(
			registry
				.getAvailable()
				.filter((model) => model.provider === "xai")
				.map((model) => model.id),
		).toEqual(["grok-4.5"]);
		expect(await registry.getApiKeyAndHeaders(getModel("xai", "grok-4.6"))).toMatchObject({
			ok: false,
			error: expect.stringContaining("/login and select"),
		});
	});

	test("uses the credential type returned with the key even if storage changes before dispatch", async () => {
		storage.set("xai", oauth());
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
});
