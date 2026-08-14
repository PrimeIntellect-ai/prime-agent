import { describe, expect, it } from "vitest";
import { supportsFastMode } from "../src/models.js";
import { buildBaseOptions } from "../src/providers/simple-options.js";
import type { Api, Model, OpenAIResponsesCompat } from "../src/types.js";

function model(provider: string, id: string, api: Api, compat?: OpenAIResponsesCompat): Model<Api> {
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
		...(compat ? { compat } : {}),
	} as Model<Api>;
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

	it("supports an openai-responses model that declares compat.supportsFastMode", () => {
		expect(supportsFastMode(model("openai", "gpt-5.5", "openai-responses", { supportsFastMode: true }))).toBe(true);
	});

	it("treats an openai-responses model without the flag as unsupported", () => {
		expect(supportsFastMode(model("openai", "gpt-5.5", "openai-responses", {}))).toBe(false);
		expect(supportsFastMode(model("openai", "gpt-5.5", "openai-responses", { supportsFastMode: false }))).toBe(false);
	});

	it("ignores the flag on APIs that never send service_tier", () => {
		expect(
			supportsFastMode(model("anthropic", "claude-sonnet-5", "anthropic-messages", { supportsFastMode: true })),
		).toBe(false);
		expect(supportsFastMode(model("moonshotai", "kimi-k2.6", "openai-completions", { supportsFastMode: true }))).toBe(
			false,
		);
	});
});
