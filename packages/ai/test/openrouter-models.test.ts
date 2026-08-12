import { describe, expect, test } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.js";
import { parseOpenRouterModels } from "../src/openrouter-models.js";

describe("parseOpenRouterModels", () => {
	const entry = (overrides: Record<string, unknown> = {}) => ({
		id: "vendor/model",
		name: "Model",
		supported_parameters: ["tools"],
		architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
		top_provider: { max_completion_tokens: 8192 },
		context_length: 32768,
		...overrides,
	});

	test("parses a normal entry with structured modalities and pricing", () => {
		const [model] = parseOpenRouterModels({ data: [entry()] });
		expect(model.id).toBe("vendor/model");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("openrouter");
		expect(model.input).toEqual(["text"]);
		expect(model.cost.input).toBe(1);
		expect(model.cost.output).toBe(2);
		expect(Math.abs(model.cost.cacheRead - 0.1)).toBeLessThan(1e-9);
		expect(model.cost.cacheWrite).toBe(0);
		expect(model.contextWindow).toBe(32768);
		expect(model.maxTokens).toBe(8192);
		expect(model.reasoning).toBe(false);
	});

	test("accepts a bare data array, the same shape the generator already holds", () => {
		expect(parseOpenRouterModels([entry()]).map((m) => m.id)).toEqual(["vendor/model"]);
	});

	test("detects image from structured input_modalities and legacy modality", () => {
		expect(
			parseOpenRouterModels({
				data: [entry({ architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } })],
			})[0].input,
		).toEqual(["text", "image"]);
		expect(
			parseOpenRouterModels({
				data: [entry({ architecture: { modality: "text+image->text", output_modalities: ["text"] } })],
			})[0].input,
		).toEqual(["text", "image"]);
	});

	test("skips non-tool, :batch, and non-text-output entries", () => {
		const models = parseOpenRouterModels({
			data: [
				entry(),
				entry({ id: "no/tools", supported_parameters: [] }),
				entry({ id: "vendor/model:batch" }),
				entry({ id: "vendor/audio", architecture: { output_modalities: ["audio"] } }),
			],
		});
		expect(models.map((m) => m.id)).toEqual(["vendor/model"]);
	});

	test("uses provider reasoning metadata for mandatory sparse efforts", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					supported_parameters: ["tools", "reasoning"],
					reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"] },
				}),
			],
		});
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	test("treats omitted supported_efforts as a toggle, matching catalog generation", () => {
		const [model] = parseOpenRouterModels({
			data: [entry({ supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: false } })],
		});
		expect(model.compat?.supportsReasoningEffort).toBe(false);
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
	});

	test("applies deepseek transport corrections", () => {
		const [model] = parseOpenRouterModels({
			data: [entry({ id: "deepseek/deepseek-v4-pro", supported_parameters: ["tools", "reasoning"] })],
		});
		expect(model.compat).toEqual({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect(model.thinkingLevelMap?.xhigh).toBe("max");
	});

	test("clamps maxTokens and treats invalid pricing as zero", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					context_length: 10000,
					top_provider: { max_completion_tokens: 999999 },
					pricing: { prompt: null, completion: "NaN", input_cache_read: "-5" },
				}),
			],
		});
		expect(model.maxTokens).toBe(10000);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("throws on a malformed payload but skips malformed entries", () => {
		expect(() => parseOpenRouterModels({})).toThrow();
		expect(parseOpenRouterModels({ data: [{}, 1, "x", entry({ id: 123 })] })).toEqual([]);
	});
});
