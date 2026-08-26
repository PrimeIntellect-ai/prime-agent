import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Api, Model } from "../src/types.js";

function model(api: Api, provider: string): Model<Api> {
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

	it("rejects ambient credentials centrally for every explicit-access provider api", () => {
		vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
		vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic-key");
		vi.stubEnv("AZURE_OPENAI_API_KEY", "ambient-azure-key");
		vi.stubEnv("GEMINI_API_KEY", "ambient-google-key");
		vi.stubEnv("MISTRAL_API_KEY", "ambient-mistral-key");
		const routes: Array<readonly [Api, string]> = [
			["anthropic-messages", "anthropic"],
			["azure-openai-responses", "azure-openai-responses"],
			["google-generative-ai", "google"],
			["google-vertex", "google-vertex"],
			["mistral-conversations", "mistral"],
			["openai-codex-responses", "openai-codex"],
			["openai-completions", "openai"],
			["openai-responses", "openai"],
		];

		for (const [api, provider] of routes) {
			expect(() => streamSimple(model(api, provider), { messages: [] }, { disableEnvApiKey: true })).toThrow(
				`Run-scoped request requires explicit access for provider: ${provider}`,
			);
		}
	});

	it("rejects unsupported run-scoped APIs before provider dispatch", () => {
		expect(() =>
			streamSimple(
				model("bedrock-converse-stream", "amazon-bedrock"),
				{ messages: [] },
				{
					disableEnvApiKey: true,
					apiKey: "explicit-but-unsupported",
				},
			),
		).toThrow("Run-scoped requests do not support api: bedrock-converse-stream");
		expect(() =>
			streamSimple(
				model("future-provider-api", "future-provider"),
				{ messages: [] },
				{
					disableEnvApiKey: true,
					apiKey: "explicit-but-unsupported",
				},
			),
		).toThrow("Run-scoped requests do not support api: future-provider-api");
	});
});
