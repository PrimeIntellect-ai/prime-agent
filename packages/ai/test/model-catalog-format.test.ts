import { describe, expect, test } from "vitest";
import { createModelCatalog, parseModelCatalog } from "../src/model-catalog.js";
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
		const input = { ...model("z", "b"), headers: { Authorization: "bundled secret" } };
		const result = createModelCatalog([input, model("a", "z"), model("z", "a")], generatedAt);
		expect(result.generatedAt).toBe(generatedAt.toISOString());
		expect(result.models.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(["a/z", "z/a", "z/b"]);
		expect(result.models.find((entry) => entry.id === "b")?.headers).toBeUndefined();
	});

	test("treats provider and model ids as an unambiguous pair", () => {
		const parsed = parseModelCatalog({
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			models: [model("a", "b/c"), model("a/b", "c")],
		});
		expect(parsed.models).toHaveLength(2);
	});

	test("keeps compatible entries for older clients", () => {
		const current = model("provider", "current");
		const future = { ...model("provider", "future"), api: "future-api" };
		const parsed = parseModelCatalog(
			{ schemaVersion: 1, generatedAt: new Date().toISOString(), models: [current, future] },
			{ skipInvalidModels: true },
		);
		expect(parsed.models).toEqual([current]);
	});

	test("applies strict publication and entry validation", () => {
		const entry = model("provider", "model");
		const parse = (modelEntry: Model<Api>) =>
			parseModelCatalog({ schemaVersion: 1, generatedAt: new Date().toISOString(), models: [modelEntry] });

		expect(() =>
			parse({ ...entry, compat: { openRouterRouting: { only: ["anthropic"], max_price: { prompt: "1" } } } }),
		).not.toThrow();
		expect(() =>
			parseModelCatalog({ schemaVersion: 1, generatedAt: new Date().toISOString(), models: [entry, entry] }),
		).toThrow(/duplicate/i);

		const invalidEntries = [
			{ ...entry, cost: { ...entry.cost, output: Number.NaN } },
			{ ...entry, cost: { ...entry.cost, input: 1_000_001 } },
			{ ...entry, contextWindow: 100_000_001 },
			{ ...entry, thinkingLevelMap: { unsupported: "value" } },
			{ ...entry, compat: { openRouterRouting: "invalid" } },
			{ ...entry, api: "openai-responses", compat: { supportsStore: true } },
			{ ...entry, api: "future-api", compat: undefined },
			{ ...entry, headers: { authorization: "remote secret" } },
			{ ...entry, headers: { authorization: { nested: true } } },
		] as unknown as Model<Api>[];
		for (const invalid of invalidEntries) expect(() => parse(invalid)).toThrow(/invalid model/i);
	});
});
