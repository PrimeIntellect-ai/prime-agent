import { describe, expect, it } from "vitest";
import { buildBaseOptions, DEFAULT_MAX_OUTPUT_TOKENS } from "../src/providers/simple-options.js";
import type { Api, Model } from "../src/types.js";

function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 393216,
		maxTokens: 131072,
		...overrides,
	} as Model<Api>;
}

describe("buildBaseOptions maxTokens", () => {
	it("caps a catalog model to the default output ceiling", () => {
		expect(buildBaseOptions(testModel()).maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
	});

	it("passes an explicitly configured maxTokens through unchanged", () => {
		expect(buildBaseOptions(testModel({ maxTokensExplicit: true })).maxTokens).toBe(131072);
	});

	it("still caps an explicit model that asks for less than the ceiling", () => {
		const model = testModel({ maxTokens: 8000, maxTokensExplicit: true });
		expect(buildBaseOptions(model).maxTokens).toBe(8000);
	});

	it("leaves maxTokens undefined when the model declares none", () => {
		expect(buildBaseOptions(testModel({ maxTokens: 0 })).maxTokens).toBeUndefined();
		expect(buildBaseOptions(testModel({ maxTokens: 0, maxTokensExplicit: true })).maxTokens).toBeUndefined();
	});

	it("lets a per-request maxTokens win over both the model value and the ceiling", () => {
		expect(buildBaseOptions(testModel(), { maxTokens: 64000 }).maxTokens).toBe(64000);
	});
});
