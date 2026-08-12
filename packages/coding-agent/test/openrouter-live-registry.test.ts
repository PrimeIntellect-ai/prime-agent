import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resetOpenRouterModelCache } from "../src/core/openrouter-model-catalog.js";

const rawEntries = [
	{
		id: "test/live-new-model",
		name: "Live New Model",
		supported_parameters: ["tools", "reasoning"],
		architecture: {
			modality: "text+image->text",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "0.00000125", completion: "0.00000425", input_cache_read: "0.00000015" },
		top_provider: { max_completion_tokens: null },
		context_length: 1048576,
		reasoning: {
			mandatory: true,
			supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
			default_effort: "medium",
		},
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "0.000000435", completion: "0.0000019" },
		top_provider: { max_completion_tokens: 8192 },
		context_length: 32768,
		reasoning: { mandatory: false, supported_efforts: ["high", "xhigh"] },
	},
	{
		id: "moonshotai/kimi-k2.5",
		name: "MoonshotAI: Kimi K2.5",
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
		pricing: { prompt: "0.000999", completion: "0.000999", input_cache_read: "0.000999" },
		top_provider: { max_completion_tokens: 999999 },
		context_length: 262144,
		reasoning: { mandatory: false },
	},
];

const liveResponse = (): Partial<Response> => ({ ok: true, status: 200, json: async () => ({ data: rawEntries }) });

describe("ModelRegistry live OpenRouter catalog", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-openrouter-live-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOpenRouterModelCache();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => liveResponse() as Response),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetOpenRouterModelCache();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("adds a newly released model from the live catalog", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const snapshot = await registry.refreshModelCatalog();
		const model = snapshot.models.find((m) => m.provider === "openrouter" && m.id === "test/live-new-model");
		expect(model).toBeDefined();
		expect(model?.thinkingLevelMap?.off).toBeNull();
		expect(model?.input).toEqual(["text", "image"]);
	});

	test("preserves virtual aliases and snapshot transport compat", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const snapshot = await registry.refreshModelCatalog();
		expect(snapshot.models.some((m) => m.provider === "openrouter" && m.id === "auto")).toBe(true);
		expect(snapshot.models.some((m) => m.provider === "openrouter" && m.id.startsWith("~"))).toBe(true);
		const deepseek = snapshot.models.find((m) => m.provider === "openrouter" && m.id === "deepseek/deepseek-v4-pro");
		expect(deepseek?.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect(deepseek?.thinkingLevelMap?.xhigh).toBe("max");
	});

	test("drops snapshot OpenRouter models that the live catalog omitted", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const snapshot = await registry.refreshModelCatalog();
		const openrouter = snapshot.models.filter((m) => m.provider === "openrouter");
		expect(openrouter.some((m) => m.id === "test/live-new-model")).toBe(true);
		expect(openrouter.some((m) => m.id === "deepseek/deepseek-v4-pro")).toBe(true);
		expect(openrouter.some((m) => m.id === "auto")).toBe(true);
		expect(openrouter.some((m) => m.id === "ai21/jamba-large-1.7")).toBe(false);
	});

	test("a custom same-id model still wins over the live entry", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openrouter: {
						api: "openai-completions",
						apiKey: "TEST_KEY",
						models: [
							{
								id: "test/live-new-model",
								name: "Custom Muse",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const model = registry.find("openrouter", "test/live-new-model");
		expect(model?.name).toBe("Custom Muse");
		expect(model?.reasoning).toBe(false);
	});

	test("second refresh retains live models", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		await registry.refreshModelCatalog();
		expect(registry.find("openrouter", "test/live-new-model")).toBeDefined();
	});

	test("findOrFetch loads a live-only OpenRouter model for session restore", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		expect(registry.find("openrouter", "test/live-new-model")).toBeUndefined();
		const restored = await registry.findOrFetch("openrouter", "test/live-new-model");
		expect(restored?.id).toBe("test/live-new-model");
		expect(registry.find("openrouter", "test/live-new-model")).toBeDefined();
	});

	test("keeps snapshot cost and output caps for known OpenRouter ids", async () => {
		const snapshot = getModel("openrouter", "moonshotai/kimi-k2.5");
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const live = registry.find("openrouter", "moonshotai/kimi-k2.5");
		expect(live?.maxTokens).toBe(snapshot.maxTokens);
		expect(live?.cost).toEqual(snapshot.cost);
		expect(live?.contextWindow).toBe(snapshot.contextWindow);
		expect(live?.thinkingLevelMap).toEqual(snapshot.thinkingLevelMap);
	});
});
