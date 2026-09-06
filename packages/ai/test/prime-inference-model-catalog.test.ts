import { describe, expect, test } from "vitest";
import { parsePrimeInferenceModelCatalog } from "../src/prime-inference-model-catalog.js";

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

	test("rejects empty and duplicate catalogs", () => {
		expect(() => parsePrimeInferenceModelCatalog(response())).toThrow(/empty/);
		const model = { id: "duplicate", pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } };
		expect(() => parsePrimeInferenceModelCatalog(response(model, model))).toThrow(/duplicate/i);
	});
});
