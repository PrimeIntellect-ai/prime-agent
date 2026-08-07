import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../../../src/core/model-registry.js";

describe("issue #755 configured maxTokens must not be silently clamped", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-755-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	function customModel(id: string, maxTokens?: number) {
		return {
			id,
			reasoning: false,
			contextWindow: 393216,
			...(maxTokens === undefined ? {} : { maxTokens }),
		};
	}

	function loadRegistry(providers: Record<string, unknown>): ModelRegistry {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
		return ModelRegistry.create(authStorage, modelsJsonPath);
	}

	// Several built-in providers ship a model called glm-5.2, so match on provider as well as id.
	function find(registry: ModelRegistry, provider: string, id: string) {
		const model = registry.getAll().find((m) => m.provider === provider && m.id === id);
		if (!model) throw new Error(`model ${provider}/${id} not found in registry`);
		return model;
	}

	it("marks a models.json maxTokens as explicit and keeps the configured value", () => {
		const registry = loadRegistry({
			"glm-h200": {
				baseUrl: "http://vllm.example.test:8000/v1",
				api: "openai-completions",
				apiKey: "TEST_KEY",
				models: [customModel("glm-5.2", 131072)],
			},
		});

		const model = find(registry, "glm-h200", "glm-5.2");
		expect(model.maxTokens).toBe(131072);
		expect(model.maxTokensExplicit).toBe(true);
	});

	it("leaves a custom model that omits maxTokens unmarked so the default ceiling still applies", () => {
		const registry = loadRegistry({
			"glm-h200": {
				baseUrl: "http://vllm.example.test:8000/v1",
				api: "openai-completions",
				apiKey: "TEST_KEY",
				models: [customModel("glm-5.2-default")],
			},
		});

		const model = find(registry, "glm-h200", "glm-5.2-default");
		expect(model.maxTokens).toBe(16384);
		expect(model.maxTokensExplicit).toBe(false);
	});

	it("marks a per-model override of a built-in model as explicit", () => {
		const registry = loadRegistry({
			anthropic: {
				modelOverrides: {
					"claude-sonnet-4-5-20250929": { maxTokens: 200000 },
				},
			},
		});

		const model = find(registry, "anthropic", "claude-sonnet-4-5-20250929");
		expect(model.maxTokens).toBe(200000);
		expect(model.maxTokensExplicit).toBe(true);
	});

	it("leaves built-in models untouched when no override configures maxTokens", () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = find(registry, "anthropic", "claude-sonnet-4-5-20250929");
		expect(model.maxTokensExplicit).toBeUndefined();
	});
});
