import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";

const originalPrimeApiKey = process.env.PRIME_API_KEY;

afterEach(() => {
	if (originalPrimeApiKey === undefined) {
		delete process.env.PRIME_API_KEY;
	} else {
		process.env.PRIME_API_KEY = originalPrimeApiKey;
	}
});

describe("Prime Inference models", () => {
	const models = getModels("prime-inference");

	it("registers a non-empty, well-formed catalog", () => {
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("prime-inference");
			expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
			expect(model.input.length).toBeGreaterThan(0);
			expect(model.cost.input).toBeGreaterThanOrEqual(0);
			expect(model.cost.output).toBeGreaterThanOrEqual(0);
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
			});
		}
	});

	it("keeps private, raw, and duplicate variants out of the committed catalog", () => {
		for (const { id } of models) {
			expect(id.toLowerCase()).not.toMatch(/^internal\//);
			expect(id).not.toContain(":");
			expect(id.toLowerCase()).not.toMatch(/-bf16$/);
			const vendor = id.split("/")[0] ?? "";
			expect(vendor).toBe(vendor.toLowerCase());
			expect(vendor).not.toBe("zai-org");
		}
	});

	it("pins featured flagships above the long tail", () => {
		expect(models.some((model) => model.featured)).toBe(true);
	});

	it("keeps the coding-agent default model available and featured", () => {
		// Guards defaultModelPerProvider["prime-inference"] in packages/coding-agent.
		const model = getModel("prime-inference", "z-ai/glm-5.2");

		expect(model).toBeDefined();
		expect(model.featured).toBe(true);
	});

	it("resolves PRIME_API_KEY from the environment", () => {
		process.env.PRIME_API_KEY = "test-prime-key";

		expect(findEnvKeys("prime-inference")).toEqual(["PRIME_API_KEY"]);
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-key");
	});

	it("requires an explicit Prime Inference API key", () => {
		delete process.env.PRIME_API_KEY;

		expect(findEnvKeys("prime-inference")).toBeUndefined();
		expect(getEnvApiKey("prime-inference")).toBeUndefined();
	});
});
