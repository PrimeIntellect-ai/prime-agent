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
		vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://hostile-azure.invalid");
		vi.stubEnv("AZURE_OPENAI_API_VERSION", "hostile-version");
		vi.stubEnv("AZURE_OPENAI_RESOURCE_NAME", "hostile-resource");
		vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", '{"test-model":"hostile-deployment"}');
		vi.stubEnv("GEMINI_API_KEY", "ambient-google-key");
		vi.stubEnv("GOOGLE_CLOUD_API_KEY", "ambient-vertex-key");
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "hostile-project");
		vi.stubEnv("GOOGLE_CLOUD_LOCATION", "hostile-location");
		vi.stubEnv("MISTRAL_API_KEY", "ambient-mistral-key");
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		vi.stubEnv("PRIME_TEAM_ID", "hostile-team");
		const routes: Array<readonly [Api, string]> = [
			["anthropic-messages", "anthropic"],
			["google-generative-ai", "google"],
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
		for (const api of ["azure-openai-responses", "google-vertex"] as const) {
			expect(() =>
				streamSimple(model(api, api), { messages: [] }, { disableEnvApiKey: true, apiKey: "explicit-key" }),
			).toThrow(`Run-scoped requests do not support api: ${api}`);
		}
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

	it("requires an explicit safe endpoint before provider dispatch", () => {
		for (const baseUrl of ["", "not-a-url", "file:///tmp/socket", "https://user:secret@example.invalid/v1"]) {
			expect(() =>
				streamSimple(
					{ ...model("openai-responses", "openai"), baseUrl },
					{ messages: [] },
					{ disableEnvApiKey: true, apiKey: "explicit-key" },
				),
			).toThrow("Run-scoped request requires an explicit HTTP endpoint for provider: openai");
		}
	});

	it("rejects unresolved Cloudflare endpoints without consulting hostile environment configuration", () => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "hostile-account");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "hostile-gateway");
		expect(() =>
			streamSimple(
				{
					...model("openai-responses", "cloudflare-ai-gateway"),
					baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
				},
				{ messages: [] },
				{ disableEnvApiKey: true, apiKey: "explicit-key" },
			),
		).toThrow("Run-scoped request requires a resolved Cloudflare endpoint for provider: cloudflare-ai-gateway");
	});
});
