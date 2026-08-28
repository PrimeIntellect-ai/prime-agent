import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});

	it("includes both xhigh and max for Anthropic Opus 4.7 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("includes both xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 (adaptive thinking)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});

	it("includes both xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
	});

	it("does not include max for older budget-based Claude models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it("does not include xhigh for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it.each(["gpt-5.4", "gpt-5.5"] as const)("includes xhigh for %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh and max for %s through the OpenAI API and Codex subscription",
		(modelId) => {
			const apiModel = getModel("openai", modelId);
			const codexModel = getModel("openai-codex", modelId);

			expect(apiModel).toBeDefined();
			expect(codexModel).toBeDefined();
			expect(getSupportedThinkingLevels(apiModel!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
			expect(getSupportedThinkingLevels(codexModel!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		},
	);

	it("supports disabling reasoning for the base GPT-5.6 API alias", () => {
		const model = getModel("openai", "gpt-5.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("off");
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes max but not xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("max");
		expect(levels).not.toContain("xhigh");
	});
});
