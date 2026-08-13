import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";

const originalNebiusApiKey = process.env.NEBIUS_API_KEY;

afterEach(() => {
	if (originalNebiusApiKey === undefined) {
		delete process.env.NEBIUS_API_KEY;
	} else {
		process.env.NEBIUS_API_KEY = originalNebiusApiKey;
	}
});

describe("Nebius Token Factory models", () => {
	it("registers the default coding model via OpenAI-compatible chat completions", () => {
		const model = getModel("nebius", "moonshotai/Kimi-K2.7-Code");

		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("nebius");
		expect(model.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(262144);
		expect(model.maxTokens).toBe(8000);
		expect(model.compat).toEqual({
			supportsStore: true,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
		});
	});

	it("registers only the current public tool-capable catalog on the Nebius endpoint", () => {
		const models = getModels("nebius");

		expect(models).toHaveLength(25);
		expect(models.every((model) => model.api === "openai-completions")).toBe(true);
		expect(models.every((model) => model.baseUrl === "https://api.tokenfactory.nebius.com/v1")).toBe(true);
		expect(models.every((model) => model.maxTokens <= model.contextWindow)).toBe(true);
		expect(models.map((model) => model.id)).toContain("zai-org/GLM-5.1");
		expect(models.map((model) => model.id)).toContain("moonshotai/Kimi-K2.6");
		expect(models.map((model) => model.id)).not.toContain("zai-org/GLM-5");
		expect(models.map((model) => model.id)).not.toContain("moonshotai/Kimi-K2.5-fast");
	});

	it("preserves DeepSeek V4 reasoning replay compatibility", () => {
		const model = getModel("nebius", "deepseek-ai/DeepSeek-V4-Pro");

		expect(model.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect(model.thinkingLevelMap).toMatchObject({ high: "high", xhigh: "max" });
	});

	it("preserves Kimi K3's live multimodal capability", () => {
		const model = getModel("nebius", "moonshotai/Kimi-K3");

		expect(model.input).toEqual(["text", "image"]);
	});

	it("resolves NEBIUS_API_KEY from the environment", () => {
		process.env.NEBIUS_API_KEY = "test-nebius-key";

		expect(findEnvKeys("nebius")).toEqual(["NEBIUS_API_KEY"]);
		expect(getEnvApiKey("nebius")).toBe("test-nebius-key");
	});
});
