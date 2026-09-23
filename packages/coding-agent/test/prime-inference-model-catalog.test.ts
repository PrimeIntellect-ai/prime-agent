import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
	buildPrimeInferenceModels,
	PRIME_INFERENCE_BASE_URL,
	readCachedPrimeInferenceModels,
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

const entry = (id: string) => ({
	id,
	input: 1,
	output: 2,
	contextWindow: 200_000,
	maxTokens: 20_000,
	vision: true,
	reasoning: false,
});

const effortEntry = (id: string) => ({
	...entry(id),
	reasoning: true,
	supportedParameters: ["max_tokens", "reasoning", "reasoning_effort"],
	reasoningEfforts: ["low", "high", "max"],
	reasoningMandatory: true,
});

const toggleEntry = (id: string) => ({
	...entry(id),
	reasoning: true,
	supportedParameters: ["max_tokens", "reasoning", "include_reasoning"],
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

	it.each([
		{
			name: "effort route",
			entry: () => effortEntry("z-ai/glm-5.3"),
			thinkingFormat: undefined,
			supportsReasoningEffort: true,
			map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		},
		{
			name: "toggle route",
			entry: () => toggleEntry("z-ai/glm-4.7"),
			thinkingFormat: "openrouter",
			supportsReasoningEffort: false,
			map: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		},
		{
			name: "effort route without declared efforts keeps the template map",
			entry: () => ({
				...entry("z-ai/glm-5.3"),
				reasoning: true,
				supportedParameters: ["max_tokens", "reasoning", "reasoning_effort"],
				reasoningMandatory: false,
			}),
			thinkingFormat: undefined,
			supportsReasoningEffort: true,
			map: { high: "high" },
		},
		{
			name: "no-parameter route keeps the stale template",
			entry: () => entry("z-ai/glm-5.3"),
			thinkingFormat: "zai",
			supportsReasoningEffort: undefined,
			map: { high: "high" },
		},
		{
			name: "reasoning-free route drops the stale template",
			entry: () => ({ ...entry("qwen/qwen3-coder"), supportedParameters: ["max_tokens"] }),
			thinkingFormat: undefined,
			supportsReasoningEffort: false,
			map: undefined,
		},
	])("$name", ({ entry: makeEntry, ...expected }) => {
		const liveEntry = makeEntry();
		const template = model(liveEntry.id);
		const stale = { ...template, compat: { ...template.compat, thinkingFormat: "zai" as const } };
		const [live] = buildPrimeInferenceModels([stale], [liveEntry], { minimumModels: 0 }) ?? [];
		expect(live?.compat?.thinkingFormat).toBe(expected.thinkingFormat);
		expect(live?.compat?.supportsReasoningEffort).toBe(expected.supportsReasoningEffort);
		if (expected.map) expect(live?.thinkingLevelMap).toEqual(expected.map);
		else expect(live?.thinkingLevelMap).toBeUndefined();
	});

	test("gives new live models the conservative default compat plus declared controls", () => {
		const models =
			buildPrimeInferenceModels([], [effortEntry("vendor/new"), entry("vendor/plain")], { minimumModels: 0 }) ?? [];
		expect(models.map((m) => m.compat?.supportsReasoningEffort)).toEqual([true, false]);
	});

	test("caches valid responses and falls back to the cache when the fetch fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-models-"));
		directories.push(directory);
		const cachePath = join(directory, "models", "cache.json");
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

	test("uses a valid flat legacy cache when the new cache has insufficient coverage", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-models-legacy-"));
		directories.push(directory);
		const cachePath = join(directory, "models", "prime-inference-models-cache.json");
		mkdirSync(join(directory, "models"));
		const bundled = [model("vendor/model")];
		writeFileSync(cachePath, JSON.stringify({ object: "list", data: [payloadEntry("unrelated/model")] }));
		writeFileSync(
			join(directory, "prime-inference-models-cache.json"),
			JSON.stringify({ object: "list", data: [payloadEntry("vendor/model")] }),
		);
		expect(readCachedPrimeInferenceModels(cachePath, bundled)?.[0]?.name).toBe("Live vendor/model");
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

	test("treats rejected authenticated requests as no private access", async () => {
		const models = await fetchAuthorizedPrivatePrimeInferenceModels(
			"bad",
			{ "X-Prime-Team-ID": "team" },
			new Set(),
			vi.fn(async () => new Response(null, { status: 403 })),
		);
		expect(models).toEqual([]);
	});
});
