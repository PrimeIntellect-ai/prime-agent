import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	buildPrimeInferenceModels,
	mergePrimeInferenceModels,
	PRIME_INFERENCE_BASE_URL,
} from "../src/core/prime-inference-model-catalog.js";
import { isPrivatePrimeInferenceModel, parsePrimeInferenceCatalogModels } from "../src/core/prime-inference-models.js";

const model = (id: string, provider = "prime-inference"): Model<"openai-completions"> => ({
	id,
	name: `Bundled ${id}`,
	api: "openai-completions",
	provider,
	baseUrl: provider === "prime-inference" ? PRIME_INFERENCE_BASE_URL : "https://example.com/v1",
	reasoning: true,
	thinkingLevelMap: { high: "high" },
	input: ["text"],
	cost: { input: 9, output: 10, cacheRead: 0.9, cacheWrite: 11.25 },
	contextWindow: 100_000,
	maxTokens: 10_000,
	featured: true,
	compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
});

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	input: 1,
	output: 2,
	contextWindow: 200_000,
	maxTokens: 20_000,
	vision: true,
	reasoning: false,
	...overrides,
});

const payloadEntry = (
	id: string,
	specs: unknown = {
		context_window: 200_000,
		max_output_tokens: 20_000,
		modalities: { input: ["text", "image"], output: ["text"] },
		supports_reasoning: false,
	},
) => ({
	id,
	display_name: `Live ${id}`,
	pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
	specs,
});

describe("Prime Inference model catalog", () => {
	test("uses live metadata while retaining bundled client compatibility", () => {
		const [live] = buildPrimeInferenceModels(
			[model("vendor/model")],
			[entry("vendor/model", { name: "Live Name", cacheRead: 0.1, cacheWrite: 1.25, maxTokens: 250_000 })],
		) ?? [undefined];
		expect(live).toMatchObject({
			id: "vendor/model",
			name: "Live Name",
			baseUrl: PRIME_INFERENCE_BASE_URL,
			api: "openai-completions",
			provider: "prime-inference",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 200_000,
			thinkingLevelMap: { high: "high" },
			featured: true,
			compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		});
		expect(live).not.toHaveProperty("headers");
	});

	test("adds complete new models and skips incomplete unknown models", () => {
		const models =
			buildPrimeInferenceModels(
				[model("bundled")],
				[entry("new/complete"), { id: "new/incomplete", input: 1, output: 2 }],
				{ minimumModels: 0 },
			) ?? [];
		expect(models.map(({ id }) => id)).toEqual(["new/complete"]);
	});

	test("retains bundled specs when an existing live entry has none", () => {
		const [live] = buildPrimeInferenceModels(
			[model("vendor/model")],
			[{ id: "vendor/model", name: "Renamed", input: 1, output: 2 }],
		) ?? [undefined];
		expect(live).toMatchObject({ name: "Renamed", contextWindow: 100_000, maxTokens: 10_000, reasoning: true });
	});

	test("filters private routes and measures coverage against bundled models", () => {
		const bundled = [model("one"), model("two"), model("three")];
		expect(
			buildPrimeInferenceModels(bundled, [
				entry("internal/private"),
				entry("dev/private"),
				entry("poolside/model:deployment"),
				entry("one"),
			]),
		).toBeUndefined();
		expect(
			buildPrimeInferenceModels(bundled, [entry("new/one"), entry("new/two"), entry("new/three")]),
		).toBeUndefined();
	});

	test("requires authorization for private prefixes and deployment routes", () => {
		for (const id of ["internal/model", "INTERNAL/model", "dev/model", "vendor/model:deployment"]) {
			expect(isPrivatePrimeInferenceModel(model(id))).toBe(true);
		}
		expect(isPrivatePrimeInferenceModel(model("public/model"))).toBe(false);
		expect(isPrivatePrimeInferenceModel(model("vendor/model:deployment", "openrouter"))).toBe(false);
	});

	test("replaces only the Prime Inference provider list", () => {
		const external = model("external", "openrouter");
		const live = model("live");
		expect(mergePrimeInferenceModels([external, model("removed")], [live])).toEqual([external, live]);
	});

	test("uses a complete authenticated response for public and private routes", () => {
		const models = parsePrimeInferenceCatalogModels(
			{
				data: [
					payloadEntry("public/model"),
					payloadEntry("internal/model"),
					payloadEntry("dev/model"),
					payloadEntry("poolside/model:deployment"),
					payloadEntry("internal/incomplete", null),
				],
			},
			[],
			true,
		);
		expect(models.map(({ id }) => id)).toEqual([
			"public/model",
			"internal/model",
			"dev/model",
			"poolside/model:deployment",
		]);
	});

	test("uses bundled metadata for known private routes in older endpoint responses", () => {
		const models = parsePrimeInferenceCatalogModels(
			{ data: [{ id: "internal/glm-5.2-fast" }] },
			[model("public/model")],
			true,
		);
		expect(models.map(({ id }) => id)).toEqual(["public/model", "internal/glm-5.2-fast"]);
	});

	test("never includes private routes in the unauthenticated catalog", () => {
		const models = parsePrimeInferenceCatalogModels(
			{ data: [payloadEntry("public/model"), payloadEntry("internal/model")] },
			[model("public/model")],
			false,
		);
		expect(models.map(({ id }) => id)).toEqual(["public/model"]);
	});
});
