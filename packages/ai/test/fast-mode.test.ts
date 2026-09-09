import { describe, expect, it } from "vitest";
import { clampServiceTier, supportsFastMode, supportsServiceTier } from "../src/models.js";
import { buildBaseOptions } from "../src/providers/simple-options.js";
import type { Api, Model } from "../src/types.js";

function model(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("Fast mode", () => {
	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-6-astra"])("supports %s through ChatGPT auth", (id) => {
		expect(supportsFastMode(model("openai-codex", id, "openai-codex-responses"))).toBe(true);
	});

	it("rejects unsupported models and non-OpenAI gateways", () => {
		expect(supportsFastMode(model("openai-codex", "gpt-5.3-codex", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai-codex", "gpt-5.4-mini", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai", "gpt-5.1", "openai-responses"))).toBe(false);
		expect(supportsFastMode(model("github-copilot", "gpt-5.5", "openai-responses"))).toBe(false);
	});

	it("admits API-key models and forwards priority", () => {
		const testModel = model("openai", "gpt-5.5", "openai-responses");
		expect(supportsFastMode(testModel)).toBe(true);
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});

	it("forwards priority through simple stream options", () => {
		const testModel = model("openai-codex", "gpt-5.5", "openai-codex-responses");
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});
});

describe("Service tier support", () => {
	it("gates flex to OpenAI API-key responses models and OpenRouter", () => {
		expect(supportsServiceTier(model("openai", "gpt-5.5", "openai-responses"), "flex")).toBe(true);
		expect(supportsServiceTier(model("openrouter", "anthropic/claude-opus-5", "openai-completions"), "flex")).toBe(
			true,
		);
		expect(supportsServiceTier(model("openai-codex", "gpt-5.5", "openai-codex-responses"), "flex")).toBe(false);
		expect(supportsServiceTier(model("groq", "llama-4", "openai-completions"), "flex")).toBe(false);
	});

	it("clamps an unsupported tier to default and passes supported tiers through", () => {
		expect(clampServiceTier(model("groq", "llama-4", "openai-completions"), "flex")).toBe("default");
		expect(clampServiceTier(undefined, "priority")).toBe("default");
		expect(clampServiceTier(model("openai", "gpt-5.5", "openai-responses"), "flex")).toBe("flex");
		expect(clampServiceTier(model("groq", "llama-4", "openai-completions"), "default")).toBe("default");
		// "scale" is entitlement-gated on OpenAI surfaces and must pass through unclamped.
		expect(clampServiceTier(model("openai", "gpt-4o", "openai-responses"), "scale")).toBe("scale");
	});
});
