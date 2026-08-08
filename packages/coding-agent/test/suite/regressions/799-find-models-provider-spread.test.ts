import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { findRlmModelMatches } from "../../../src/core/rlm-runtime.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

// Mirrors the reported setup: several providers where one sorts first alphabetically
// and carries more models than the default limit.
function catalog(): Model<Api>[] {
	const providers = ["anthropic", "openai-codex", "openrouter", "zai"];
	return providers.flatMap((provider) =>
		Array.from({ length: 10 }, (_, index) => model(provider, `${provider}-model-${index}`)),
	);
}

describe("issue #799 unqualified find_models must not read as a single-vendor catalog", () => {
	it("spans every provider instead of returning an alphabetical head slice", () => {
		const matches = findRlmModelMatches("", catalog(), 8);

		expect(matches).toHaveLength(8);
		expect(new Set(matches.map((m) => m.provider))).toEqual(
			new Set(["anthropic", "openai-codex", "openrouter", "zai"]),
		);
	});

	it("does not return only the alphabetically first provider", () => {
		const providers = findRlmModelMatches("", catalog(), 8).map((m) => m.provider);
		expect(providers.every((provider) => provider === "anthropic")).toBe(false);
	});

	it("keeps each provider's own ordering stable", () => {
		const anthropic = findRlmModelMatches("", catalog(), 40)
			.filter((m) => m.provider === "anthropic")
			.map((m) => m.id);
		expect(anthropic).toEqual([...anthropic].sort((a, b) => a.localeCompare(b)));
	});

	it("returns every model when the limit exceeds the catalog", () => {
		expect(findRlmModelMatches("", catalog(), 40)).toHaveLength(40);
	});

	it("leaves a real query ranked by relevance rather than spread", () => {
		const matches = findRlmModelMatches("zai-model-3", catalog(), 8);
		expect(matches[0].selector).toBe("zai/zai-model-3");
	});

	it("handles a single-provider catalog without dropping or reordering", () => {
		const single = Array.from({ length: 3 }, (_, index) => model("anthropic", `anthropic-model-${index}`));
		expect(findRlmModelMatches("", single, 8).map((m) => m.id)).toEqual([
			"anthropic-model-0",
			"anthropic-model-1",
			"anthropic-model-2",
		]);
	});
});
