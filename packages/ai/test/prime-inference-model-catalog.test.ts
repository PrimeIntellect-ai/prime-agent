import { afterEach, describe, expect, test } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import {
	getPrimeInferenceReasoningControls,
	parsePrimeInferenceModelCatalog,
} from "../src/prime-inference-model-catalog.js";

function response(...data: unknown[]) {
	return { object: "list", data };
}

describe("Prime Inference model catalog", () => {
	test("parses pricing and model specs", () => {
		const [model] = parsePrimeInferenceModelCatalog(
			response({
				id: "vendor/model",
				display_name: "Model Name",
				pricing: {
					input_usd_per_mtok: 1,
					output_usd_per_mtok: 2,
					cache_read_usd_per_mtok: 0.1,
					cache_write_usd_per_mtok: 1.25,
				},
				specs: {
					context_window: 200_000,
					max_output_tokens: 64_000,
					modalities: { input: ["text", "image", "file"], output: ["text"] },
					supports_reasoning: true,
				},
			}),
		);
		expect(model).toEqual({
			id: "vendor/model",
			name: "Model Name",
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			contextWindow: 200_000,
			maxTokens: 64_000,
			vision: true,
			reasoning: true,
		});
	});

	test("keeps priced entries without complete specs for bundled fallback", () => {
		expect(
			parsePrimeInferenceModelCatalog(
				response(
					{
						id: "vendor/no-specs",
						pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
						specs: null,
					},
					{
						id: "vendor/partial-specs",
						pricing: { input_usd_per_mtok: 3, output_usd_per_mtok: 4 },
						specs: {
							context_window: 100_000,
							max_output_tokens: 10_000,
							modalities: { output: ["text"] },
							supports_reasoning: false,
						},
					},
				),
			),
		).toEqual([
			{ id: "vendor/no-specs", input: 1, output: 2 },
			{ id: "vendor/partial-specs", input: 3, output: 4 },
		]);
	});

	test("rejects control-bearing IDs without rewriting Unicode model identities", () => {
		const pricing = { input_usd_per_mtok: 1, output_usd_per_mtok: 2 };
		const id = "vendor/模型-é";
		const controls = Array.from({ length: 33 }, (_, i) => String.fromCharCode(i + 0x7f)).concat(
			Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
		);
		const models = parsePrimeInferenceModelCatalog(
			response({ id, pricing }, ...controls.map((control) => ({ id: `${id}${control}`, pricing }))),
		);
		expect(models.map((model) => model.id)).toEqual([id]);
	});

	test("removes display-name terminal controls while preserving Unicode", () => {
		const pricing = { input_usd_per_mtok: 1, output_usd_per_mtok: 2 };
		const controls =
			Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") +
			Array.from({ length: 33 }, (_, i) => String.fromCharCode(i + 0x7f)).join("");
		const models = parsePrimeInferenceModelCatalog(
			response(
				{ id: "unicode", display_name: ` 模型 é 👩‍💻${controls} `, pricing },
				{ id: "fallback", display_name: controls, pricing },
			),
		);
		expect(models[0].name).toBe("模型 é 👩‍💻");
		expect(models[1]).not.toHaveProperty("name");
	});

	test("rejects empty and duplicate catalogs", () => {
		expect(() => parsePrimeInferenceModelCatalog(response())).toThrow(/empty/);
		const model = { id: "duplicate", pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } };
		expect(() => parsePrimeInferenceModelCatalog(response(model, model))).toThrow(/duplicate/i);
	});

	test("parses and sanitizes live reasoning declarations", () => {
		const [model] = parsePrimeInferenceModelCatalog(
			response({
				id: "z-ai/glm-5.3",
				pricing: { input_usd_per_mtok: 1.4, output_usd_per_mtok: 4.4 },
				supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", 42, null],
				reasoning: { supported_efforts: ["low", "high", "max", "high", null], mandatory: true },
			}),
		);
		expect(model.supportedParameters).toEqual(["max_tokens", "reasoning", "reasoning_effort"]);
		expect(model.reasoningEfforts).toEqual(["low", "high", "max"]);
		expect(model.reasoningMandatory).toBe(true);
	});
});

// Folded in from prime-inference-models.test.ts: the catalog/config assertions there churned on
// every catalog refresh; only API-key resolution is a real contract.
describe("Prime Inference API key resolution", () => {
	const originalPrimeApiKey = process.env.PRIME_API_KEY;

	afterEach(() => {
		if (originalPrimeApiKey === undefined) {
			delete process.env.PRIME_API_KEY;
		} else {
			process.env.PRIME_API_KEY = originalPrimeApiKey;
		}
	});

	test("resolves PRIME_API_KEY from the environment", () => {
		process.env.PRIME_API_KEY = "test-prime-key";

		expect(findEnvKeys("prime-inference")).toEqual(["PRIME_API_KEY"]);
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-key");
	});

	test("requires an explicit Prime Inference API key", () => {
		delete process.env.PRIME_API_KEY;

		expect(findEnvKeys("prime-inference")).toBeUndefined();
		expect(getEnvApiKey("prime-inference")).toBeUndefined();
	});
});

// Maps live /models reasoning metadata onto request controls; the gateway
// rejects undeclared efforts, and "none" disables non-mandatory effort routes.
describe("getPrimeInferenceReasoningControls", () => {
	const mandatoryMap = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };
	const optionalMap = { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null };

	test("maps declared route shapes onto reasoning controls", () => {
		const effortRoute = { supportedParameters: ["reasoning", "reasoning_effort"] };
		expect(
			getPrimeInferenceReasoningControls({
				...effortRoute,
				reasoningEfforts: ["low", "high", "max"],
				reasoningMandatory: true,
			}),
		).toEqual({ supportsReasoningEffort: true, thinkingLevelMap: mandatoryMap });
		expect(getPrimeInferenceReasoningControls({ ...effortRoute, reasoningEfforts: ["xhigh", "high"] })).toEqual({
			supportsReasoningEffort: true,
			thinkingLevelMap: optionalMap,
		});
		const toggleControls = {
			supportsReasoningEffort: false,
			thinkingFormat: "openrouter",
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		};
		expect(getPrimeInferenceReasoningControls({ supportedParameters: ["reasoning"] })).toEqual(toggleControls);
		expect(
			getPrimeInferenceReasoningControls({ supportedParameters: ["reasoning"], reasoningEfforts: ["high"] }),
		).toEqual(toggleControls);
		// An effort route that declares reasoning_effort but no supported efforts
		// gets no map (and no format): the values are unknown, so callers fall
		// back to their bounded bundled template map instead of a guessed toggle.
		expect(getPrimeInferenceReasoningControls({ supportedParameters: ["reasoning", "reasoning_effort"] })).toEqual({
			supportsReasoningEffort: true,
		});
		// enable_thinking routes take the ZAI toggle: mandatory routes must hide
		// off (the serializer would otherwise disable reasoning), and a route that
		// also declares reasoning_effort must keep the effort arm so the selected
		// level is actually sent.
		expect(
			getPrimeInferenceReasoningControls({ supportedParameters: ["enable_thinking"], reasoningMandatory: true }),
		).toEqual({ supportsReasoningEffort: false, thinkingFormat: "zai", thinkingLevelMap: { off: null } });
		expect(getPrimeInferenceReasoningControls({ supportedParameters: ["enable_thinking"] })).toEqual({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		expect(
			getPrimeInferenceReasoningControls({
				supportedParameters: ["enable_thinking", "reasoning_effort"],
				reasoningEfforts: ["high"],
			}),
		).toEqual({
			supportsReasoningEffort: true,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
		});
		expect(
			getPrimeInferenceReasoningControls({ supportedParameters: ["enable_thinking", "reasoning_effort"] }),
		).toEqual({ supportsReasoningEffort: true });
		expect(getPrimeInferenceReasoningControls({ supportedParameters: ["max_tokens"] })).toEqual({
			supportsReasoningEffort: false,
		});
		expect(getPrimeInferenceReasoningControls({})).toBeUndefined();
	});
});
