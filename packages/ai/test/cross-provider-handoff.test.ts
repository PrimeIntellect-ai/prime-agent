import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import type { Api, Model } from "../src/types.js";

interface ProviderModelPair {
	provider: string;
	model: string;
	apiOverride?: Api;
}

// One pair per wire format that has to survive a handoff: anthropic, google, openai-completions,
// openai-responses and the codex variant. Catalog validation is unconditional and makes no live calls.
const PROVIDER_MODEL_PAIRS: ProviderModelPair[] = [
	{ provider: "anthropic", model: "claude-sonnet-4-5" },
	{ provider: "google", model: "gemini-3-flash-preview" },
	{ provider: "openai", model: "gpt-4o-mini", apiOverride: "openai-completions" },
	{ provider: "openai", model: "gpt-5-mini" },
	{ provider: "openai-codex", model: "gpt-5.2-codex" },
];

function resolveProviderModel(pair: ProviderModelPair): Model<Api> | undefined {
	const base = (getModel as (provider: string, model: string) => Model<Api> | undefined)(pair.provider, pair.model);
	if (!base) return undefined;
	return pair.apiOverride ? { ...base, api: pair.apiOverride } : base;
}

describe("Cross-Provider Handoff configuration", () => {
	it("references models in the generated catalog", () => {
		const missing = PROVIDER_MODEL_PAIRS.filter((pair) => !resolveProviderModel(pair)).map(
			(pair) => `${pair.provider}/${pair.model}`,
		);
		expect(missing).toEqual([]);
	});
});
