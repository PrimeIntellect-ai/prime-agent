import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type OAuthCredential } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const oauth = (): OAuthCredential => ({
	type: "oauth",
	access: "subscription-access",
	refresh: "subscription-refresh",
	expires: Date.now() + 60_000,
});

const grok45 = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-completions",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null },
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500000,
	maxTokens: 500000,
} satisfies Model<"openai-completions">;

const grok46 = {
	id: "grok-4.6",
	name: "Grok 4.6",
	api: "openai-completions",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" },
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 500000,
	maxTokens: 500000,
} satisfies Model<"openai-completions">;

describe("xAI credential source and request model", () => {
	let storage: AuthStorage;
	let registry: ModelRegistry;
	beforeEach(() => {
		vi.stubEnv("XAI_API_KEY", "environment-key");
		storage = AuthStorage.inMemory();
		registry = ModelRegistry.inMemory(storage);
		registry.registerProvider("xai", {
			api: "openai-completions",
			baseUrl: "https://api.x.ai/v1",
			apiKey: "XAI_API_KEY",
			models: [grok45, grok46],
		});
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
		expect(grok45.api).toBe("openai-completions");
	});

	test("validates final Authorization case-insensitively only for subscription credentials", async () => {
		storage.set("xai", oauth());
		const model = { ...grok45, headers: { Authorization: "custom-secret" } } as Model<Api>;
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

	test("keeps all configured xAI tool models selectable for subscription and API-key auth", async () => {
		const models = [grok45, grok46];
		const customModel = {
			...grok46,
			id: "custom-grok",
			baseUrl: "https://example.invalid/custom",
			input: ["text"] as ["text"],
			contextWindow: 1234,
			maxTokens: 512,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		} as Model<Api>;
		const ids = models.map((model) => model.id);
		for (const credential of [oauth(), { type: "api_key" as const, key: "api-key" }]) {
			storage.set("xai", credential);
			expect(
				registry
					.getAvailable()
					.filter((model) => model.provider === "xai")
					.map((model) => model.id),
			).toEqual(ids);
			expect(
				(await registry.refreshModelCatalog()).models
					.filter((model) => model.provider === "xai")
					.map((model) => model.id),
			).toEqual(ids);
			for (const model of [...models, customModel]) {
				await expect(registry.canUseModel(model)).resolves.toBe(true);
				expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
					ok: true,
					requestModel: {
						...model,
						api: credential.type === "oauth" ? "openai-responses" : model.api,
						baseUrl: credential.type === "oauth" ? "https://api.x.ai/v1" : model.baseUrl,
					},
				});
			}
		}
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
