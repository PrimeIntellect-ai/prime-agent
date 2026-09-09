import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModelCatalog, getModel, getModels, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS } from "../../../src/core/model-catalog-cache.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { findInitialModel, restoreModelFromSession } from "../../../src/core/model-resolver.js";
import { PROVIDER_MODEL_CATALOG_URL, parseProviderModelCatalog } from "../../../src/core/provider-model-catalog.js";
import { createHarness, type Harness } from "../harness.js";

const primeUrl = "https://api.pinference.ai/api/v1/models";
const newProviderModel = { ...getModel("openai", "gpt-5.5"), id: "catalog-new", name: "Catalog New" };
const providerPayload = createModelCatalog([newProviderModel]);
function primeEntry(id: string, model?: Model<"openai-completions">) {
	return {
		id,
		display_name: model?.name ?? id,
		pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
		specs: {
			context_window: model?.contextWindow ?? 200_000,
			max_output_tokens: model?.maxTokens ?? 20_000,
			supports_reasoning: model?.reasoning ?? false,
			modalities: { input: model?.input ?? ["text"], output: ["text"] },
		},
	};
}
const publicEntries = [
	...getModels("prime-inference").map((model) => primeEntry(model.id, model)),
	primeEntry("test/new-public"),
];
const primePayload = { data: [...publicEntries, primeEntry("internal/new-private")] };
const json = (payload: unknown) => new Response(JSON.stringify(payload));

describe("ENG-5982 live model catalogs", () => {
	let harness: Harness;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let modelsPath: string;
	const fetchFn = vi.fn<typeof fetch>();

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		fetchFn.mockReset().mockImplementation(async (url, init) => {
			if (url === PROVIDER_MODEL_CATALOG_URL) return json(providerPayload);
			if (url === primeUrl)
				return json(new Headers(init?.headers).has("Authorization") ? primePayload : { data: publicEntries });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchFn);
		harness = await createHarness();
		auth = AuthStorage.inMemory({
			openai: { type: "api_key", key: "openai-test-key" },
			"prime-inference": { type: "api_key", key: "prime-test-key", primeTeam: { teamId: "team-a", name: "Team A" } },
		});
		modelsPath = join(harness.tempDir, "models.json");
		registry = ModelRegistry.create(auth, modelsPath);
		fetchFn.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	test("renders the local catalog before either network response, then publishes both catalogs", async () => {
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			(url) =>
				new Promise<Response>((resolve) =>
					complete.push(() => resolve(json(url === primeUrl ? primePayload : providerPayload))),
				),
		);
		const cached = await registry.refreshModelCatalog();
		expect(cached.models.some((model) => model.id === "catalog-new")).toBe(false);
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
		const refreshed = registry.refreshAvailableModels();
		await Promise.resolve();
		for (const finish of complete) finish();
		const models = await refreshed;
		expect(models.map((model) => model.id)).toEqual(
			expect.arrayContaining(["catalog-new", "test/new-public", "internal/new-private"]),
		);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const primeRequest = fetchFn.mock.calls.find(([url]) => url === primeUrl);
		expect(new Headers(primeRequest?.[1]?.headers).get("authorization")).toBe("Bearer prime-test-key");
		expect(
			new Headers(fetchFn.mock.calls.find(([url]) => url === PROVIDER_MODEL_CATALOG_URL)?.[1]?.headers).has(
				"authorization",
			),
		).toBe(false);
	});

	test("starts and resumes with a cached model while catalog requests are pending", async () => {
		await registry.refreshAvailableModels();
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			(url) =>
				new Promise<Response>((resolve) =>
					complete.push(() => resolve(json(url === primeUrl ? primePayload : providerPayload))),
				),
		);
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "openai",
			defaultModelId: "catalog-new",
			modelRegistry: registry,
		});
		expect(initial.model?.id).toBe("catalog-new");
		const restored = await restoreModelFromSession("openai", "catalog-new", undefined, false, registry);
		expect(restored.model?.id).toBe("catalog-new");
		for (const finish of complete) finish();
		await registry.refreshAvailableModels();
	});

	test("restores one full Prime snapshot and one provider snapshot offline", async () => {
		await registry.refreshAvailableModels();
		const files = readdirSync(harness.tempDir).filter((file) => file.endsWith("catalog.v1.json"));
		expect(files.sort()).toEqual(["prime-inference-catalog.v1.json", "provider-model-catalog.v1.json"]);
		const disk = readFileSync(join(harness.tempDir, "prime-inference-catalog.v1.json"), "utf8");
		expect(disk).toContain("test/new-public");
		expect(disk).toContain("internal/new-private");
		expect(disk).not.toContain("prime-test-key");
		vi.stubEnv("PI_OFFLINE", "1");
		fetchFn.mockClear();
		const restored = ModelRegistry.create(auth, modelsPath);
		expect((await restored.refreshModelCatalog()).models.map((model) => model.id)).toEqual(
			expect.arrayContaining(["catalog-new", "test/new-public", "internal/new-private"]),
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test.each(["team", "credentials", "logout"])(
		"invalidates private entries immediately after changing %s",
		async (change) => {
			await registry.refreshAvailableModels();
			if (change === "team") auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
			else if (change === "credentials")
				auth.set("prime-inference", {
					type: "api_key",
					key: "different-key",
					primeTeam: { teamId: "team-a", name: "Team A" },
				});
			else auth.remove("prime-inference");
			expect(registry.getAvailable().some((model) => model.id === "internal/new-private")).toBe(false);
			vi.stubEnv("PI_OFFLINE", "1");
			expect(
				(await ModelRegistry.create(auth, modelsPath).refreshModelCatalog()).models.some(
					(model) => model.id === "internal/new-private",
				),
			).toBe(false);
		},
	);

	test("keeps local overrides, custom models, extensions, and the active session model", async () => {
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					openai: {
						modelOverrides: { "catalog-new": { name: "Local Name", contextWindow: 123456 } },
						models: [{ id: "custom-local" }],
					},
				},
			}),
		);
		registry.registerProvider("test-extension", {
			apiKey: "test-key",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			models: [{ ...newProviderModel, id: "extension-model" }],
		});
		const active = harness.session.model;
		await registry.refreshAvailableModels();
		expect(registry.find("openai", "catalog-new")).toMatchObject({ name: "Local Name", contextWindow: 123456 });
		expect(registry.find("openai", "custom-local")).toBeDefined();
		expect(registry.find("test-extension", "extension-model")).toBeDefined();
		expect(harness.session.model).toBe(active);
	});

	test("refreshes both sources every six hours", async () => {
		vi.useFakeTimers();
		await registry.refreshAvailableModels();
		fetchFn.mockClear();
		await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_INTERVAL_MS);
		expect(fetchFn.mock.calls.filter(([url]) => url === primeUrl)).toHaveLength(1);
		expect(fetchFn.mock.calls.filter(([url]) => url === PROVIDER_MODEL_CATALOG_URL)).toHaveLength(1);
	});

	test("cannot redirect provider credentials or admit Prime models through GitHub", () => {
		const invalid = [
			{ ...newProviderModel, baseUrl: "https://untrusted.example/v1" },
			{ ...newProviderModel, api: "unknown-api" },
			{ ...newProviderModel, provider: "prime-inference" },
		];
		const payload = createModelCatalog([
			newProviderModel,
			...invalid.map((model, index) => ({ ...model, id: `bad-${index}` })),
		]);
		expect(parseProviderModelCatalog(payload, getModels("openai")).map((model) => model.id)).toEqual(["catalog-new"]);
	});
});
