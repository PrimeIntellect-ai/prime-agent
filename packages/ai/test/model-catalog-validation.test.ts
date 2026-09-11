import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseModelCatalog } from "../src/model-catalog.js";
import { isModelCompat } from "../src/model-compat-schema.js";
import { getModel } from "../src/models.js";

const model = getModel("openai", "gpt-5.5");
const catalog = (entry: unknown) => ({ schemaVersion: 1, models: [entry] });

describe("compiled catalog validation", () => {
	test("validates the complete shipped catalog", () => {
		const source = JSON.parse(readFileSync(new URL("../../../catalog/models.v1.json", import.meta.url), "utf8"));
		expect(source.models.length).toBeGreaterThan(1_000);
		expect(parseModelCatalog(source)).toEqual(source);
	});

	test.each(["id", "name", "api", "provider", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"])(
		"rejects a missing required %s",
		(field) => {
			const invalid: Record<string, unknown> = { ...model };
			delete invalid[field];
			expect(() => parseModelCatalog(catalog(invalid))).toThrow("Invalid model catalog entry");
		},
	);

	test.each([
		{ id: "" },
		{ id: "x".repeat(1_025) },
		{ id: "bad\u0085id" },
		{ name: "" },
		{ name: "bad\u001bname" },
		{ api: "x".repeat(129) },
		{ provider: "" },
		{ baseUrl: "x".repeat(2_049) },
		{ reasoning: "true" },
		{ input: [] },
		{ input: ["text", "image", "text"] },
		{ input: ["audio"] },
		{ contextWindow: 1.5 },
		{ contextWindow: 100_000_001 },
		{ maxTokens: 0 },
		{ cost: { ...model.cost, input: -1 } },
		{ cost: { ...model.cost, output: 1_000_001 } },
		{ cost: { ...model.cost, cacheRead: Number.NaN } },
		{ cost: { ...model.cost, cacheWrite: Number.POSITIVE_INFINITY } },
		{ featured: "yes" },
		{ headers: { Authorization: "secret" } },
		{ unknownField: true },
		{ thinkingLevelMap: { high: "" } },
		{ thinkingLevelMap: { high: "x".repeat(129) } },
		{ thinkingLevelMap: { unknownLevel: "high" } },
		{ compat: { sendSessionIdHeader: "yes" } },
		{ compat: { supportsStore: true } },
		{ compat: { unknownCapability: true } },
	])("rejects invalid model fields %j and skips them only when requested", (fields) => {
		const invalid = { ...model, ...fields };
		expect(() => parseModelCatalog(catalog(invalid))).toThrow("Invalid model catalog entry");
		expect(
			parseModelCatalog({ schemaVersion: 1, models: [invalid, model] }, { skipInvalidModels: true }).models,
		).toEqual([model]);
	});

	test("preserves duplicate and empty-catalog checks with skipInvalidModels", () => {
		expect(() =>
			parseModelCatalog({ schemaVersion: 1, models: [model, model] }, { skipInvalidModels: true }),
		).toThrow("Duplicate");
		expect(() => parseModelCatalog(catalog({ ...model, name: "" }), { skipInvalidModels: true })).toThrow(
			"no compatible entries",
		);
		expect(() => parseModelCatalog({ schemaVersion: 1, models: [] })).toThrow("model count");
		expect(() => parseModelCatalog({ schemaVersion: 1, models: Array(20_001).fill(model) })).toThrow("model count");
	});

	test.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"])(
		"uses the responses compat schema for %s",
		(api) => {
			expect(isModelCompat(api, { sendSessionIdHeader: true, supportsLongCacheRetention: false })).toBe(true);
			expect(isModelCompat(api, { sendSessionIdHeader: "yes" })).toBe(false);
			expect(isModelCompat(api, { supportsStore: true })).toBe(false);
		},
	);

	test("preserves nested routing validation and API-specific compat restrictions", () => {
		expect(
			isModelCompat("openai-completions", {
				openRouterRouting: { data_collection: "deny", zdr: true, only: ["provider"], max_price: { prompt: "0.5" } },
				vercelGatewayRouting: { order: ["provider"] },
			}),
		).toBe(true);
		for (const compat of [
			{ openRouterRouting: { data_collection: "maybe" } },
			{ openRouterRouting: { zdr: "yes" } },
			{ openRouterRouting: { only: [123] } },
			{ openRouterRouting: { max_price: { prompt: true } } },
			{ vercelGatewayRouting: { order: "provider" } },
			{ unknownCapability: false },
		])
			expect(isModelCompat("openai-completions", compat)).toBe(false);
		expect(isModelCompat("anthropic-messages", { supportsEagerToolInputStreaming: true })).toBe(true);
		expect(isModelCompat("anthropic-messages", { supportsStore: true })).toBe(false);
		expect(isModelCompat("future-api", {})).toBe(false);
		expect(isModelCompat("future-api", undefined)).toBe(true);
	});
});
