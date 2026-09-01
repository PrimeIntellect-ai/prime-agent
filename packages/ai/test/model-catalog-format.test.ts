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

	test("applies the same strict schema used by clients", () => {
		const entry = model("provider", "model");
		const catalog = (modelEntry: Model<Api>) => ({
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			models: [modelEntry],
		});
		expect(() => parseModelCatalog({ ...catalog(entry), models: [entry, entry] })).toThrow(/duplicate/i);
		expect(() => parseModelCatalog(catalog({ ...entry, cost: { ...entry.cost, output: Number.NaN } }))).toThrow(
			/invalid model/i,
		);
		expect(() => parseModelCatalog(catalog({ ...entry, cost: { ...entry.cost, input: 1_000_001 } }))).toThrow(
			/invalid model/i,
		);
		expect(() => parseModelCatalog(catalog({ ...entry, contextWindow: 100_000_001 }))).toThrow(/invalid model/i);
		expect(() =>
			parseModelCatalog(catalog({ ...entry, thinkingLevelMap: { unsupported: "value" } } as Model<Api>)),
		).toThrow(/invalid model/i);
	});
});
