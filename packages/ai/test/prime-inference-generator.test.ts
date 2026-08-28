import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.js";

// Same guard CI uses: importing the generator must not trigger live fetches.
process.env.PI_SKIP_MODEL_GENERATION = "1";
const {
	buildPrimeInferenceOpenRouterIndex,
	createPrimeInferenceModel,
	isPrimeInferencePrivateModel,
	isPrimeInferenceRawVariant,
	mergePrimeInferenceModels,
	parsePrimeInferenceCatalog,
} = await import("../scripts/generate-models.js");

const OPENROUTER_FIXTURE = [
	{
		id: "acme/spec-model",
		context_length: 200000,
		top_provider: { max_completion_tokens: 32000 },
		architecture: { input_modalities: ["text", "image"] },
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: ["low", "high"] },
	},
	{
		id: "acme/toggle-model",
		context_length: 64000,
		top_provider: { max_completion_tokens: 8000 },
		architecture: { input_modalities: ["text"] },
		supported_parameters: ["reasoning"],
		reasoning: { mandatory: false, supported_efforts: [] },
	},
];

const orIndex = buildPrimeInferenceOpenRouterIndex(OPENROUTER_FIXTURE);

describe("Prime Inference catalog curation", () => {
	it("drops private and raw/duplicate variant ids and keeps canonical ones", () => {
		expect(isPrimeInferencePrivateModel("internal/prime-agent-loop")).toBe(true);
		expect(isPrimeInferencePrivateModel("z-ai/glm-5.2")).toBe(false);
		expect(isPrimeInferenceRawVariant("acme/model-BF16")).toBe(true);
		expect(isPrimeInferenceRawVariant("acme/model:free")).toBe(true);
		expect(isPrimeInferenceRawVariant("zai-org/GLM-4.7")).toBe(true);
		expect(isPrimeInferenceRawVariant("Qwen/Qwen3.5-4B")).toBe(true);
		expect(isPrimeInferenceRawVariant("z-ai/glm-5.2")).toBe(false);
	});

	it("keeps only priced catalog entries and reads limits and reasoning flags", () => {
		const catalog = parsePrimeInferenceCatalog({
			data: [
				{
					id: "acme/priced",
					pricing: { input_usd_per_mtok: 1.5, output_usd_per_mtok: 6 },
					context_window: 100000,
					max_tokens: 50000,
					supported_parameters: ["reasoning"],
				},
				{ id: "acme/unpriced" },
				"garbage",
			],
		});

		expect(catalog).toEqual([
			{ id: "acme/priced", input: 1.5, output: 6, contextWindow: 100000, maxTokens: 50000, reasoning: true },
		]);
	});
});

describe("createPrimeInferenceModel", () => {
	it("borrows OpenRouter metadata when the catalog entry has no limits", () => {
		const model = createPrimeInferenceModel(
			{ id: "acme/spec-model", input: 2, output: 8 },
			undefined,
			orIndex.get("acme/spec-model"),
		);

		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("prime-inference");
		expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
		expect(model.contextWindow).toBe(200000);
		expect(model.maxTokens).toBe(32000);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high"]);
		expect(model.cost).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
	});

	it("prefers catalog limits over overrides and clamps maxTokens to the window", () => {
		const model = createPrimeInferenceModel(
			{ id: "acme/spec-model", input: 1, output: 2, contextWindow: 90000, maxTokens: 120000 },
			{ contextWindow: 70000 },
			orIndex.get("acme/spec-model"),
		);

		expect(model.contextWindow).toBe(90000);
		expect(model.maxTokens).toBe(90000);
	});

	it("prefers curated overrides over OpenRouter metadata", () => {
		const model = createPrimeInferenceModel(
			{ id: "acme/spec-model", input: 1, output: 2 },
			{ contextWindow: 70000, maxTokens: 7000, vision: false, name: "Spec" },
			orIndex.get("acme/spec-model"),
		);

		expect(model.contextWindow).toBe(70000);
		expect(model.maxTokens).toBe(7000);
		expect(model.input).toEqual(["text"]);
		expect(model.name).toBe("Spec");
	});

	it("falls back to conservative defaults without OpenRouter metadata", () => {
		const model = createPrimeInferenceModel({ id: "acme/unlisted", input: 1, output: 2 }, undefined, undefined);

		expect(model.contextWindow).toBe(128000);
		expect(model.maxTokens).toBe(8192);
		expect(model.input).toEqual(["text"]);
		expect(model.reasoning).toBe(false);
		expect(model.featured).toBeUndefined();
	});

	it("flags models from the curated featured set", () => {
		const model = createPrimeInferenceModel({ id: "z-ai/glm-5.2", input: 1, output: 2 }, undefined, undefined);

		expect(model.featured).toBe(true);
	});

	it("resolves reasoning from the catalog flag before id heuristics", () => {
		const make = (id: string, reasoning?: boolean) =>
			createPrimeInferenceModel({ id, input: 1, output: 2, reasoning }, undefined, undefined);

		expect(make("acme/unlisted", true).reasoning).toBe(true);
		expect(make("z-ai/glm-99", false).reasoning).toBe(false);
		expect(make("z-ai/glm-99").reasoning).toBe(true);
	});

	it("applies provider compat quirks by model family", () => {
		const make = (id: string) => createPrimeInferenceModel({ id, input: 1, output: 2 }, undefined, orIndex.get(id));

		const deepseek = make("deepseek/deepseek-v4-pro");
		expect(deepseek.compat).toMatchObject({
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		});

		const zai = make("z-ai/glm-5.2");
		expect(zai.compat).toMatchObject({ thinkingFormat: "zai", supportsReasoningEffort: false });

		const toggle = make("acme/toggle-model");
		expect(toggle.compat).toMatchObject({ supportsReasoningEffort: false, thinkingFormat: "openrouter" });
		expect(getSupportedThinkingLevels(toggle)).toEqual(["off", "high"]);

		for (const model of [deepseek, zai, toggle]) {
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
			});
		}
	});

	it("adds Anthropic cache pricing to anthropic/ routes only", () => {
		const claude = createPrimeInferenceModel(
			{ id: "anthropic/claude-sonnet-5", input: 2, output: 10 },
			undefined,
			undefined,
		);

		expect(claude.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
	});
});

describe("mergePrimeInferenceModels", () => {
	it("prefers live catalog entries over snapshot models by case-insensitive id", () => {
		const make = (id: string, input: number) =>
			createPrimeInferenceModel({ id, input, output: 1 }, undefined, undefined);

		const merged = mergePrimeInferenceModels([make("acme/Alpha", 1), make("acme/beta", 1)], [make("acme/alpha", 9)]);

		expect(merged.map((model) => model.id).sort()).toEqual(["acme/alpha", "acme/beta"]);
		expect(merged.find((model) => model.id === "acme/alpha")?.cost.input).toBe(9);
	});
});
