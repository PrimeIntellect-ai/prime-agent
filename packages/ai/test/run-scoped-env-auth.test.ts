import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model } from "../src/types.js";

function model<TApi extends "anthropic-messages" | "openai-completions" | "openai-responses">(
	api: TApi,
	provider: string,
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

describe("run-scoped provider authentication", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("fails before transport instead of using OpenAI or Anthropic environment keys", () => {
		vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
		vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic-key");
		const options = { disableEnvApiKey: true } as const;

		expect(() => streamSimpleOpenAIResponses(model("openai-responses", "openai"), { messages: [] }, options)).toThrow(
			"No API key for provider: openai",
		);
		expect(() =>
			streamSimpleOpenAICompletions(model("openai-completions", "openai"), { messages: [] }, options),
		).toThrow("No API key for provider: openai");
		expect(() => streamSimpleAnthropic(model("anthropic-messages", "anthropic"), { messages: [] }, options)).toThrow(
			"No API key for provider: anthropic",
		);
	});
});
