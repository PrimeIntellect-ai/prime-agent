import { describe, expect, test } from "vitest";
import { createModelCatalog, parseModelCatalog } from "../scripts/model-catalog-format.js";
import type { Api, Model } from "../src/types.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("hosted model catalog format", () => {
	test("creates deterministic provider/model ordering", () => {
		const generatedAt = new Date("2026-08-31T00:00:00.000Z");
		const result = createModelCatalog([model("z", "b"), model("a", "z"), model("z", "a")], generatedAt);
		expect(result.generatedAt).toBe(generatedAt.toISOString());
		expect(result.models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(["a/z", "z/a", "z/b"]);
	});

	test("rejects duplicate entries and invalid prices", () => {
		const entry = model("provider", "model");
		expect(() =>
			parseModelCatalog({ schemaVersion: 1, generatedAt: new Date().toISOString(), models: [entry, entry] }),
		).toThrow("duplicate");
		expect(() =>
			parseModelCatalog({
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				models: [{ ...entry, cost: { ...entry.cost, output: Number.NaN } }],
			}),
		).toThrow("invalid model");
	});
});
