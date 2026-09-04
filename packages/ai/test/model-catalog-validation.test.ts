import { describe, expect, it } from "vitest";
import {
	type CatalogRowLike,
	validateModelCatalog,
} from "../scripts/validate-model-catalog.js";
import { MODELS } from "../src/models.generated.js";

function row(overrides: Partial<CatalogRowLike> & { id: string; provider: string }): CatalogRowLike {
	return {
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

describe("model catalog validation", () => {
	it("accepts the committed catalog", () => {
		expect(validateModelCatalog(MODELS)).toEqual([]);
	});

	it("rejects maxTokens above contextWindow", () => {
		const catalog = {
			huggingface: { swapped: row({ id: "swapped", provider: "huggingface", contextWindow: 1000, maxTokens: 2000 }) },
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"huggingface/swapped: maxTokens 2000 exceeds contextWindow 1000",
		]);
	});

	it("rejects unclassified and misrouted GitHub Copilot models", () => {
		const catalog = {
			"github-copilot": {
				"novel-model-x": row({ id: "novel-model-x", provider: "github-copilot" }),
				"grok-9": row({ id: "grok-9", provider: "github-copilot" }),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"github-copilot/novel-model-x: unclassified model family; add it to copilotModelApi in validate-model-catalog.ts",
			"github-copilot/grok-9: api openai-completions does not match classification openai-responses",
		]);
	});

	it("rejects codex contextWindow diverging more than 2x from the openai row", () => {
		const catalog = {
			openai: { "gpt-9": row({ id: "gpt-9", provider: "openai", api: "openai-responses", contextWindow: 1050000 }) },
			"openai-codex": {
				"gpt-9": row({ id: "gpt-9", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272000 }),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"openai-codex/gpt-9: contextWindow 272000 diverges more than 2x from openai/gpt-9 (1050000)",
		]);
	});

	it("rejects same-model rows whose selectable thinking levels disagree at runtime", () => {
		const catalog = {
			openrouter: {
				"vendor/model-y": row({
					id: "vendor/model-y",
					provider: "openrouter",
					reasoning: true,
					thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
				}),
			},
			huggingface: {
				"model-y": row({
					id: "model-y",
					provider: "huggingface",
					reasoning: true,
					thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
				}),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"model-y [openai-completions]: selectable thinking levels disagree across providers: " +
				"openrouter/vendor/model-y=[low,high,max], huggingface/model-y=[max]",
		]);
	});

	it("rejects selectable levels on a transport that cannot send reasoning effort", () => {
		const catalog = {
			moonshotai: {
				"model-z": row({
					id: "model-z",
					provider: "moonshotai",
					reasoning: true,
					thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
				}),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"moonshotai/model-z: thinkingLevelMap offers [max] but the transport cannot send reasoning effort",
		]);
	});

	it("treats off-level differences as legitimate per-provider variance", () => {
		const catalog = {
			openai: {
				"gpt-5.9": row({
					id: "gpt-5.9",
					provider: "openai",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { off: "none", xhigh: "xhigh" },
				}),
			},
			"github-copilot": {
				"gpt-5.9": row({
					id: "gpt-5.9",
					provider: "github-copilot",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { off: null, xhigh: "xhigh" },
				}),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([]);
	});
});
