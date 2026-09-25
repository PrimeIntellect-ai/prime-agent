import { type Api, getModels, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { getBundledModels } from "../src/core/bundled-model-catalog.js";
import {
	defaultModelPerProvider,
	findInitialModel,
	resolveCliModel,
	resolveModelScopeFromModels,
} from "../src/core/model-resolver.js";
import { getPrivatePrimeInferenceModels } from "../src/core/prime-inference-models.js";

/** Any catalog model, matching what ModelRegistry.getAll() returns. */
type AnyModel = Model<Api>;
type TestModel = Model<"anthropic-messages">;
type CliRegistry = Parameters<typeof resolveCliModel>[0]["modelRegistry"];
type InitialRegistry = Parameters<typeof findInitialModel>[0]["modelRegistry"];

function model(overrides: Partial<TestModel> & Pick<TestModel, "id" | "provider">): TestModel {
	return {
		name: overrides.id,
		api: "anthropic-messages",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

const sonnet = model({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" });
const gpt4o = model({ id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false });
const qwenExacto = model({ id: "qwen/qwen3-coder:exacto", provider: "openrouter" });
const gpt4oExtended = model({ id: "openai/gpt-4o:extended", provider: "openrouter", reasoning: false });
const allModels = [sonnet, gpt4o, qwenExacto, gpt4oExtended];

const primeInference = (id: string) =>
	model({ id, provider: "prime-inference", baseUrl: "https://api.pinference.ai/api/v1" });
const zaiDirect = model({ id: "glm-5", provider: "zai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" });
const zaiGateway = model({ id: "zai/glm-5", provider: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh" });

const cliRegistry = (models: AnyModel[]): CliRegistry => ({ getAll: () => models }) as unknown as CliRegistry;

describe("resolveModelScopeFromModels", () => {
	test("resolves scope patterns, thinking suffixes, and provider-qualified ids", () => {
		const daemonOnly = primeInference("daemon-only-model");
		const hfGlm = model({
			id: "zai-org/GLM-5.2",
			provider: "huggingface",
			baseUrl: "https://router.huggingface.co/v1",
		});
		const primeGlm = primeInference("z-ai/glm-5.2");
		const models = [...allModels, daemonOnly, hfGlm, primeGlm];

		expect(resolveModelScopeFromModels(["prime-inference/daemon-only-model:high", "openai/gpt-4o"], models)).toEqual([
			{ model: daemonOnly, thinkingLevel: "high" },
			{ model: gpt4o, thinkingLevel: undefined },
		]);
		// A thinking level may follow a colon-bearing model id.
		expect(resolveModelScopeFromModels(["openrouter/qwen/qwen3-coder:exacto:high"], models)).toEqual([
			{ model: qwenExacto, thinkingLevel: "high" },
		]);
		// A provider prefix wins over a same-named model from another provider.
		expect(resolveModelScopeFromModels(["huggingface/zai-org/GLM-5.2"], models)).toEqual([
			{ model: hfGlm, thinkingLevel: undefined },
		]);
	});

	test("keeps the model, warns, and drops an invalid thinking suffix", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(resolveModelScopeFromModels(["sonnet:random"], allModels)).toEqual([
				{ model: sonnet, thinkingLevel: undefined },
			]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid thinking level "random"'));
		} finally {
			warn.mockRestore();
		}
	});
});

describe("resolveCliModel", () => {
	test.each<
		[
			string,
			{ provider?: string; pattern: string; models?: AnyModel[] },
			{ provider: string; id: string; thinking?: string },
		]
	>([
		["provider/id without --provider", { pattern: "openai/gpt-4o" }, { provider: "openai", id: "gpt-4o" }],
		[
			"a fuzzy pattern inside an explicit provider",
			{ provider: "openai", pattern: "4o" },
			{ provider: "openai", id: "gpt-4o" },
		],
		[
			"a provider-prefixed fuzzy pattern",
			{ pattern: "openrouter/qwen" },
			{ provider: "openrouter", id: "qwen/qwen3-coder:exacto" },
		],
		[
			"a <pattern>:<thinking> suffix",
			{ pattern: "sonnet:high" },
			{ provider: "anthropic", id: "claude-sonnet-4-5", thinking: "high" },
		],
		// An exact id match beats provider inference, and an invalid :suffix stays part of the id.
		[
			"an exact OpenRouter-style id",
			{ pattern: "openai/gpt-4o:extended" },
			{ provider: "openrouter", id: "openai/gpt-4o:extended" },
		],
		[
			"a raw id with a non-thinking suffix",
			{ provider: "openai", pattern: "gpt-4o:extended" },
			{ provider: "openai", id: "gpt-4o:extended" },
		],
		[
			"a custom id without double prefixing",
			{ provider: "openrouter", pattern: "openrouter/openai/ghost-model" },
			{ provider: "openrouter", id: "openai/ghost-model" },
		],
		// A provider/model split beats a gateway model whose id happens to match.
		[
			"provider split over a gateway id",
			{ pattern: "zai/glm-5", models: [...allModels, zaiDirect, zaiGateway] },
			{ provider: "zai", id: "glm-5" },
		],
	])("resolves %s", (_label, { provider, pattern, models }, expected) => {
		const result = resolveCliModel({
			cliProvider: provider,
			cliModel: pattern,
			modelRegistry: cliRegistry(models ?? allModels),
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe(expected.provider);
		expect(result.model?.id).toBe(expected.id);
		expect(result.thinkingLevel).toBe(expected.thinking);
	});

	test.each<[string, AnyModel[], string]>([
		["there are no models", [], "No models available"],
		["a private id has no private template", getModels("prime-inference"), "not found"],
	])("reports an error when %s", (_label, models, errorFragment) => {
		const result = resolveCliModel({
			cliProvider: "prime-inference",
			cliModel: "internal/glm-5.3-fast",
			modelRegistry: cliRegistry(models),
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain(errorFragment);
	});

	test("derives unknown Prime Inference ids from the matching route template", () => {
		// The registry a daemon worker builds for a fresh session: bundled public
		// catalog plus bundled private models, without the team-authorized private
		// catalog that only loads after refreshAvailableModels().
		const registry = cliRegistry([...getModels("prime-inference"), ...getPrivatePrimeInferenceModels()]);

		const priv = resolveCliModel({
			cliProvider: "prime-inference",
			cliModel: "internal/glm-5.3-fast",
			modelRegistry: registry,
		});
		expect(priv.error).toBeUndefined();
		expect(priv.model?.id).toBe("internal/glm-5.3-fast");
		expect(priv.model?.provider).toBe("prime-inference");
		expect(priv.model?.baseUrl).toBe("https://api.pinference.ai/api/v1");
		const privateModel = priv.model as Model<"openai-completions">;
		// Prime Inference rejects enable_thinking, so no route may carry the zai
		// thinking format.
		expect(privateModel.compat?.thinkingFormat).toBeUndefined();
		// The public template's thinkingLevelMap would coerce thinking "off" to "low".
		expect(getSupportedThinkingLevels(privateModel).includes("off")).toBe(true);

		const pub = resolveCliModel({ cliProvider: "prime-inference", cliModel: "z-ai/glm-9", modelRegistry: registry });
		expect(pub.error).toBeUndefined();
		expect(pub.model?.id).toBe("z-ai/glm-9");
		expect((pub.model as Model<"openai-completions">).compat?.thinkingFormat).toBeUndefined();
	});
});

describe("default model selection", () => {
	test("every per-provider default exists in the bundled runtime catalog", () => {
		const bundledModels = getBundledModels();
		for (const [provider, modelId] of Object.entries(defaultModelPerProvider)) {
			const models = bundledModels.filter((entry) => entry.provider === provider);
			if (models.length === 0) continue;
			expect(
				models.map((entry) => entry.id),
				`default for ${provider}`,
			).toContain(modelId);
		}
	});

	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: cliRegistry(allModels) as unknown as InitialRegistry,
		});

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("findInitialModel uses medium as the built-in default thinking level", async () => {
		const registry = { refreshAvailableModels: async () => [sonnet] } as unknown as InitialRegistry;

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRegistry: registry });

		expect(result.model).toBe(sonnet);
		expect(result.thinkingLevel).toBe("medium");
	});

	test.each<[string, AnyModel[], string]>([
		[
			"prefers the Prime Inference default",
			[sonnet, primeInference("z-ai/glm-5.2"), primeInference("z-ai/glm-5.3")],
			"z-ai/glm-5.3",
		],
		["falls back to another provider default", [sonnet], "claude-sonnet-4-5"],
		[
			"selects the ai-gateway default",
			[
				model({
					id: "anthropic/claude-opus-4-6",
					provider: "vercel-ai-gateway",
					baseUrl: "https://ai-gateway.vercel.sh",
				}),
			],
			"anthropic/claude-opus-4-6",
		],
	])("findInitialModel %s", async (_label, available, expectedId) => {
		const registry = { refreshAvailableModels: async () => available } as unknown as InitialRegistry;

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRegistry: registry });

		expect(result.model?.id).toBe(expectedId);
	});

	test("findInitialModel skips saved defaults without configured auth", async () => {
		const primeModel = primeInference("openai/gpt-5.5");
		const registry = {
			find: (provider: string, modelId: string) =>
				[sonnet, primeModel].find((entry) => entry.provider === provider && entry.id === modelId),
			hasConfiguredAuth: (entry: TestModel) => entry.provider === "prime-inference",
			refreshAvailableModels: async () => [primeModel],
		} as unknown as InitialRegistry;

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: sonnet.provider,
			defaultModelId: sonnet.id,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("prime-inference");
		expect(result.model?.id).toBe("openai/gpt-5.5");
	});

	test.each<[string, { provider: string; modelId: string; snapshot: AnyModel[] }, string]>([
		[
			"rebuilds a saved default missing from the snapshot when the provider is authed",
			{
				provider: "prime-inference",
				modelId: "anthropic/claude-opus-4.6",
				snapshot: [primeInference("openai/gpt-5.5")],
			},
			"anthropic/claude-opus-4.6",
		],
		[
			"does not rebuild a saved default for an unauthed provider",
			{
				provider: "anthropic",
				modelId: "claude-ghost-9",
				snapshot: [...allModels, primeInference("openai/gpt-5.5")],
			},
			"openai/gpt-5.5",
		],
	])("findInitialModel %s", async (_label, saved, expectedId) => {
		const primeModel = primeInference("openai/gpt-5.5");
		const registry = {
			find: () => undefined,
			getAll: () => saved.snapshot,
			hasConfiguredAuth: (entry: TestModel) => entry.provider === "prime-inference",
			refreshAvailableModels: async () => [primeModel],
		} as unknown as InitialRegistry;

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: saved.provider,
			defaultModelId: saved.modelId,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("prime-inference");
		expect(result.model?.id).toBe(expectedId);
	});
});
