import { describe, expect, it } from "vitest";
import { supportsFastMode } from "../src/models.js";
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
	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-luna"])("supports %s through ChatGPT auth", (id) => {
		expect(supportsFastMode(model("openai-codex", id, "openai-codex-responses"))).toBe(true);
	});

	it("rejects unsupported models and API-key providers", () => {
		expect(supportsFastMode(model("openai-codex", "gpt-5.3-codex", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai-codex", "gpt-5.4-mini", "openai-codex-responses"))).toBe(false);
		expect(supportsFastMode(model("openai", "gpt-5.5", "openai-responses"))).toBe(false);
	});

	it("forwards priority through simple stream options", () => {
		const testModel = model("openai-codex", "gpt-5.5", "openai-codex-responses");
		expect(buildBaseOptions(testModel, { serviceTier: "priority" }).serviceTier).toBe("priority");
	});

	it.each(["claude-opus-5", "claude-opus-4-8"])("supports %s on Anthropic API", (id) => {
		expect(supportsFastMode(model("anthropic", id, "anthropic-messages"))).toBe(true);
	});

	it("rejects Anthropic models that do not support fast mode", () => {
		expect(supportsFastMode(model("anthropic", "claude-opus-4-7", "anthropic-messages"))).toBe(false);
		expect(supportsFastMode(model("anthropic", "claude-sonnet-5", "anthropic-messages"))).toBe(false);
		expect(supportsFastMode(model("anthropic", "claude-haiku-4-5", "anthropic-messages"))).toBe(false);
	});

	it("rejects anthropic models on non-anthropic-messages api", () => {
		expect(supportsFastMode(model("anthropic", "claude-opus-5", "openai-completions"))).toBe(false);
	});
});
