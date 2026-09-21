import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	buildPrimeInferenceModels,
	PRIME_INFERENCE_BASE_URL,
	PrimeInferenceCatalogRequestError,
	refreshPrimeInferenceModels,
} from "../src/core/prime-inference-model-catalog.js";
import {
	fetchAuthorizedPrivatePrimeInferenceModels,
	isPrivatePrimeInferenceModel,
} from "../src/core/prime-inference-models.js";

const directories: string[] = [];
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

// Capability data shape the live /models endpoint reports; see
// parsePrimeInferenceModelCatalog in @earendil-works/pi-ai.
const effortEntry = (id: string, overrides: Record<string, unknown> = {}) =>
	entry(id, {
		reasoning: true,
		supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice", "reasoning", "reasoning_effort"],
		reasoningEfforts: ["low", "high", "max"],
		reasoningMandatory: true,
		...overrides,
	});

const toggleEntry = (id: string, overrides: Record<string, unknown> = {}) =>
	entry(id, {
		reasoning: true,
		supportedParameters: ["max_tokens", "reasoning", "include_reasoning"],
		...overrides,
	});

const staleZaiTemplate = (id: string): Model<"openai-completions"> => ({
	...model(id),
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		thinkingFormat: "zai",
	},
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

const response = (...data: unknown[]) => new Response(JSON.stringify({ object: "list", data }));

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Prime Inference model catalog", () => {
	test.each([
		{ id: "internal/model", provider: "prime-inference", private: true },
		{ id: "INTERNAL/model", provider: "prime-inference", private: true },
		{ id: "dev/model", provider: "prime-inference", private: true },
		{ id: "vendor/model:deployment", provider: "prime-inference", private: true },
		{ id: "public/model", provider: "prime-inference", private: false },
		{ id: "vendor/model:deployment", provider: "openrouter", private: false },
	])("isPrivatePrimeInferenceModel($id, $provider) is $private", ({ id, provider, ...expected }) => {
		expect(isPrivatePrimeInferenceModel(model(id, provider))).toBe(expected.private);
	});

	test("drops private routes from the public catalog and rejects thin coverage", () => {
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

	test("derives reasoning compat from live parameter declarations over a stale template", () => {
		const [live] = buildPrimeInferenceModels([staleZaiTemplate("z-ai/glm-5.3")], [effortEntry("z-ai/glm-5.3")], {
			minimumModels: 0,
		}) ?? [undefined];
		expect(live?.reasoning).toBe(true);
		expect(live?.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
		expect(live?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	test("routes live toggle-only models through the reasoning object over a stale template", () => {
		const [live] = buildPrimeInferenceModels([staleZaiTemplate("z-ai/glm-5.1")], [toggleEntry("z-ai/glm-5.1")], {
			minimumModels: 0,
		}) ?? [undefined];
		expect(live?.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "openrouter",
		});
		expect(live?.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	test("keeps the bundled template compat when the live route reports no parameters", () => {
		const [live] = buildPrimeInferenceModels([staleZaiTemplate("z-ai/glm-5.3")], [entry("z-ai/glm-5.3")], {
			minimumModels: 0,
		}) ?? [undefined];
		expect(live?.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "zai",
		});
	});

	test("gives new live models the conservative default compat plus declared reasoning controls", () => {
		const [withControls, withoutControls] = buildPrimeInferenceModels(
			[],
			[effortEntry("vendor/new"), entry("vendor/plain")],
			{ minimumModels: 0 },
		) ?? [undefined, undefined];
		expect(withControls?.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
		expect(withoutControls?.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	test("caches valid responses and falls back to the cache when the fetch fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-models-"));
		directories.push(directory);
		const cachePath = join(directory, "cache.json");
		const bundled = [model("vendor/model")];
		const fetched = await refreshPrimeInferenceModels(cachePath, bundled, {
			fetchFn: vi.fn(async () => response(payloadEntry("vendor/model"))),
		});
		expect(fetched?.[0]?.name).toBe("Live vendor/model");
		expect(JSON.parse(readFileSync(cachePath, "utf8")).data).toHaveLength(1);
		const fallback = await refreshPrimeInferenceModels(cachePath, bundled, {
			fetchFn: vi.fn(async () => {
				throw new Error("offline");
			}),
		});
		expect(fallback?.[0]?.name).toBe("Live vendor/model");
	});

	test("keeps authenticated private routes with complete metadata and sends the auth headers", async () => {
		const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
			expect(new Headers(init?.headers).get("X-Prime-Team-ID")).toBe("team");
			return response(
				payloadEntry("public/model"),
				payloadEntry("internal/model"),
				payloadEntry("dev/model"),
				payloadEntry("poolside/model:deployment"),
				payloadEntry("internal/incomplete", null),
				{ id: "internal/glm-5.2-fast" },
			);
		});
		const models = await fetchAuthorizedPrivatePrimeInferenceModels(
			"secret",
			{ "X-Prime-Team-ID": "team" },
			new Set(["public/model"]),
			fetchFn,
		);
		expect(models.map(({ id }) => id)).toEqual([
			"internal/model",
			"dev/model",
			"poolside/model:deployment",
			"internal/glm-5.2-fast",
		]);
	});

	test("returns an authoritative empty authorization for a 200 catalog without private routes", async () => {
		const models = await fetchAuthorizedPrivatePrimeInferenceModels(
			"secret",
			{ "X-Prime-Team-ID": "team" },
			new Set(),
			vi.fn(async () => response(payloadEntry("public/model"))),
		);
		expect(models).toEqual([]);
	});

	test.each([401, 403] as const)(
		"surfaces rejected authenticated requests as transient failures instead of empty access",
		async (status) => {
			const failure = await fetchAuthorizedPrivatePrimeInferenceModels(
				"bad",
				{ "X-Prime-Team-ID": "team" },
				new Set(),
				vi.fn(async () => new Response(null, { status })),
			).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(PrimeInferenceCatalogRequestError);
			expect((failure as PrimeInferenceCatalogRequestError).status).toBe(status);
		},
	);
});
