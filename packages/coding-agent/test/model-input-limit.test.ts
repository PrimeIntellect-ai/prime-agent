import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelInputLimit } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const directories: string[] = [];
afterEach(() => {
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function registry(providers: Record<string, unknown>): ModelRegistry {
	const directory = mkdtempSync(join(tmpdir(), "prime-input-limit-"));
	directories.push(directory);
	const path = join(directory, "models.json");
	writeFileSync(path, JSON.stringify({ providers }));
	return ModelRegistry.create(AuthStorage.inMemory(), path);
}

describe("model input budgets", () => {
	it("loads input limits for custom models and built-in overrides", () => {
		const models = registry({
			local: {
				apiKey: "test-key",
				api: "openai-responses",
				baseUrl: "https://example.test/v1",
				models: [{ id: "local-model", contextWindow: 10000, maxInputTokens: 8000 }],
			},
			openai: { modelOverrides: { "gpt-6-astra": { maxInputTokens: 500000 } } },
		}).getAll();
		expect(getModelInputLimit(models.find((model) => model.id === "local-model")!)).toBe(8000);
		expect(
			getModelInputLimit(models.find((model) => model.provider === "openai" && model.id === "gpt-6-astra")!),
		).toBe(500000);
	});

	it.each([0, -1, 1.5])("rejects invalid input limit %s", (maxInputTokens) => {
		const models = registry({
			local: {
				apiKey: "test-key",
				api: "openai-responses",
				baseUrl: "https://example.test/v1",
				models: [{ id: "invalid-input-model", maxInputTokens }],
			},
		});
		expect(models.getAll().some((model) => model.id === "invalid-input-model")).toBe(false);
		expect(models.getError()).toBeTruthy();
	});
});
