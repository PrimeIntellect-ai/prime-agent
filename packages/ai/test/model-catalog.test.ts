import { describe, expect, test } from "vitest";
import { createModelCatalog, parseModelCatalog } from "../src/model-catalog.js";
import { getModel } from "../src/models.js";

const model = getModel("openai", "gpt-5.5");
describe("curated model catalog", () => {
	test("roundtrips model metadata without credentials", () => {
		const catalog = createModelCatalog([{ ...model, headers: { Authorization: "secret" } }]);
		expect(parseModelCatalog(catalog)).toEqual(catalog);
		expect(catalog.models[0]).not.toHaveProperty("headers");
	});
	test("rejects invalid versions, duplicate entries, and untrusted metadata", () => {
		expect(() => parseModelCatalog({ schemaVersion: 2, models: [model] })).toThrow();
		expect(() => parseModelCatalog({ schemaVersion: 1, models: [model, model] })).toThrow("Duplicate");
		for (const invalid of [
			{ ...model, headers: { Authorization: "secret" } },
			{ ...model, contextWindow: -1 },
			{ ...model, cost: { ...model.cost, input: Number.NaN } },
			{ ...model, compat: { supportsStore: "yes" } },
			{ ...model, name: "bad\x1b]52;clipboard\x07" },
		]) {
			expect(() => parseModelCatalog({ schemaVersion: 1, models: [invalid] })).toThrow();
		}
	});
	test("lets an older client skip models with unsupported metadata", () => {
		const unsupported = { ...model, id: "future", compat: { newCapability: true } };
		expect(
			parseModelCatalog({ schemaVersion: 1, models: [model, unsupported] }, { skipInvalidModels: true }).models,
		).toEqual([model]);
	});
});
