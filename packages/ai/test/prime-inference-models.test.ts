import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalPrimeApiKey = process.env.PRIME_API_KEY;

afterEach(() => {
	if (originalPrimeApiKey === undefined) {
		delete process.env.PRIME_API_KEY;
	} else {
		process.env.PRIME_API_KEY = originalPrimeApiKey;
	}
});

describe("Prime Inference models", () => {
	it("registers the Prime Inference catalog", () => {
		const modelIds = getModels("prime-inference").map((model) => model.id);

		expect(modelIds.length).toBeGreaterThanOrEqual(90);
		expect(modelIds).toEqual(
			expect.arrayContaining([
				"anthropic/claude-opus-4.7",
				"anthropic/claude-opus-4.8",
				"anthropic/claude-opus-5",
				"anthropic/claude-sonnet-5",
				"deepseek/deepseek-v4-pro",
				"google/gemini-2.5-pro",
				"meta-llama/llama-4-maverick",
				"minimax/minimax-m3",
				"moonshotai/kimi-k2.7-code",
				"nvidia/nemotron-3-super-120b-a12b",
				"openai/gpt-5.4",
				"openai/gpt-5.5",
				"qwen/qwen3-coder-next",
				"qwen/qwen3-vl-235b-a22b-thinking",
				"x-ai/grok-4.20",
				"z-ai/glm-4.6",
				"z-ai/glm-5",
				"z-ai/glm-5.1",
				"z-ai/glm-5.2",
			]),
		);
	});

	it("skips private, raw, and duplicate catalog variants", () => {
		const modelIds = getModels("prime-inference").map((model) => model.id);

		expect(modelIds.filter((id) => id.startsWith("internal/"))).toEqual([]);
		expect(modelIds).not.toContain("zai-org/GLM-4.7");
		expect(modelIds).not.toContain("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16");
		expect(modelIds).not.toContain("Qwen/Qwen3.5-4B");
		expect(modelIds.filter((id) => id.includes(":"))).toEqual([]);
	});

	it("marks flagship models as featured so pickers can pin them above the long tail", () => {
		expect(getModel("prime-inference", "openai/gpt-5.5").featured).toBe(true);
		expect(getModel("prime-inference", "z-ai/glm-5.2").featured).toBe(true);
		expect(getModel("prime-inference", "moonshotai/kimi-k3").featured).toBe(true);
		expect(getModel("prime-inference", "google/gemini-2.5-pro").featured).toBeUndefined();
		expect(getModel("prime-inference", "openai/gpt-4o").featured).toBeUndefined();
	});

	it("uses mandatory provider efforts for Qwen 3.8 Max", () => {
		const model = getModel("prime-inference", "qwen/qwen3.8-max");

		expect(model.featured).toBe(true);
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("uses reasoning toggles for models without effort selectors", () => {
		for (const provider of ["prime-inference", "openrouter"] as const) {
			const model = getModel(provider, "qwen/qwen3.7-flash");

			expect(model.compat?.supportsReasoningEffort).toBe(false);
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
			if (provider === "prime-inference") expect(model.compat?.thinkingFormat).toBe("openrouter");
		}
	});

	it("registers Kimi K3 on Prime Inference and OpenRouter", () => {
		for (const provider of ["prime-inference", "openrouter"] as const) {
			const model = getModel(provider, "moonshotai/kimi-k3");

			expect(model.api).toBe("openai-completions");
			expect(model.reasoning).toBe(true);
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.contextWindow).toBe(1048576);
			expect(model.maxTokens).toBe(1048576);
			expect(model.cost.input).toBe(3);
			expect(model.cost.output).toBe(15);
		}
	});

	it("borrows OpenRouter metadata for non-curated catalog models", () => {
		const gemini = getModel("prime-inference", "google/gemini-2.5-pro");
		expect(gemini.contextWindow).toBe(1048576);
		expect(gemini.maxTokens).toBe(65536);
		expect(gemini.input).toEqual(["text", "image"]);
		expect(gemini.reasoning).toBe(true);

		const nemotronSuper = getModel("prime-inference", "nvidia/nemotron-3-super-120b-a12b");
		expect(nemotronSuper.reasoning).toBe(true);
		expect(nemotronSuper.input).toEqual(["text"]);
		expect(nemotronSuper.contextWindow).toBe(262144);
		expect(nemotronSuper.maxTokens).toBe(4096);

		const maverick = getModel("prime-inference", "meta-llama/llama-4-maverick");
		expect(maverick.contextWindow).toBe(1048576);
		expect(maverick.input).toEqual(["text", "image"]);
		expect(maverick.reasoning).toBe(false);
	});

	it("registers the default OpenAI-compatible model", () => {
		const model = getModel("prime-inference", "openai/gpt-5.5");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("prime-inference");
		expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh"]);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1050000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("marks known reasoning-capable Prime Inference model families", () => {
		const opus48 = getModel("prime-inference", "anthropic/claude-opus-4.8");
		expect(opus48.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(opus48)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);

		const sonnet5 = getModel("prime-inference", "anthropic/claude-sonnet-5");
		expect(sonnet5.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(sonnet5)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(sonnet5.input).toEqual(["text", "image"]);
		expect(sonnet5.contextWindow).toBe(1000000);
		expect(sonnet5.maxTokens).toBe(128000);
		expect(sonnet5.cost).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		expect(getSupportedThinkingLevels(sonnet5)).toContain("xhigh");
		expect(getSupportedThinkingLevels(sonnet5)).toContain("max");

		expect(getModel("prime-inference", "anthropic/claude-opus-4.7").reasoning).toBe(true);
		const deepseekV4Flash = getModel("prime-inference", "deepseek/deepseek-v4-flash");
		expect(deepseekV4Flash.reasoning).toBe(true);
		expect(deepseekV4Flash.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		const glm51 = getModel("prime-inference", "z-ai/glm-5.1");
		expect(glm51.reasoning).toBe(true);
		expect(glm51.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		const glm52 = getModel("prime-inference", "z-ai/glm-5.2");
		expect(glm52.reasoning).toBe(true);
		expect(glm52.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		expect(getModel("prime-inference", "qwen/qwen3-coder-next").reasoning).toBe(false);
		expect(getModel("prime-inference", "x-ai/grok-4.20").reasoning).toBe(true);
		expect(getModel("prime-inference", "minimax/minimax-m3").reasoning).toBe(true);
		expect(getModel("prime-inference", "moonshotai/kimi-k2.7-code").reasoning).toBe(true);
	});

	it("uses route-specific context windows for Prime Inference Claude routes", () => {
		const fable = getModel("prime-inference", "anthropic/claude-fable-5");
		expect(fable.contextWindow).toBe(1000000);
		expect(fable.cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
		});
		expect(getModel("prime-inference", "anthropic/claude-opus-4.6").contextWindow).toBe(1000000);
		expect(getModel("prime-inference", "anthropic/claude-opus-4.7").contextWindow).toBe(1000000);
		expect(getModel("prime-inference", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
		expect(getModel("prime-inference", "anthropic/claude-sonnet-4.6").contextWindow).toBe(1000000);
		expect(getModel("prime-inference", "anthropic/claude-sonnet-5").contextWindow).toBe(1000000);
		expect(getModel("prime-inference", "anthropic/claude-haiku-4.5").contextWindow).toBe(200000);
		expect(getModel("prime-inference", "anthropic/claude-sonnet-4.5").contextWindow).toBe(200000);
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
