import { describe, expect, it } from "vitest";
import {
	type CatalogRowLike,
	validateModelCatalog,
} from "../scripts/validate-model-catalog.js";
import { MODELS } from "../src/models.generated.js";

function row(overrides: Partial<CatalogRowLike> & { id: string }): CatalogRowLike {
	return { api: "openai-completions", contextWindow: 128000, maxTokens: 8192, ...overrides };
}

describe("model catalog validation", () => {
	it("accepts the committed catalog", () => {
		expect(validateModelCatalog(MODELS)).toEqual([]);
	});

	it("rejects maxTokens above contextWindow", () => {
		const catalog = { huggingface: { swapped: row({ id: "swapped", contextWindow: 1000, maxTokens: 2000 }) } };
		expect(validateModelCatalog(catalog)).toEqual([
			"huggingface/swapped: maxTokens 2000 exceeds contextWindow 1000",
		]);
	});

	it("rejects unclassified and misrouted GitHub Copilot models", () => {
		const catalog = {
			"github-copilot": {
				"novel-model-x": row({ id: "novel-model-x" }),
				"grok-9": row({ id: "grok-9" }),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"github-copilot/novel-model-x: unclassified model family; add it to copilotModelApi in validate-model-catalog.ts",
			"github-copilot/grok-9: api openai-completions does not match classification openai-responses",
		]);
	});

	it("rejects codex contextWindow diverging more than 2x from the openai row", () => {
		const catalog = {
			openai: { "gpt-9": row({ id: "gpt-9", api: "openai-responses", contextWindow: 1050000 }) },
			"openai-codex": { "gpt-9": row({ id: "gpt-9", api: "openai-codex-responses", contextWindow: 272000 }) },
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"openai-codex/gpt-9: contextWindow 272000 diverges more than 2x from openai/gpt-9 (1050000)",
		]);
	});

	it("rejects same-model rows whose selectable thinking levels disagree", () => {
		const catalog = {
			openrouter: {
				"vendor/model-y": row({ id: "vendor/model-y", thinkingLevelMap: { low: "low", high: "high", max: "max" } }),
			},
			moonshotai: { "model-y": row({ id: "model-y", thinkingLevelMap: { off: null, max: "max" } }) },
		};
		expect(validateModelCatalog(catalog)).toEqual([
			"model-y [openai-completions]: thinkingLevelMap selectable levels disagree across providers: " +
				"openrouter/vendor/model-y=[high,low,max], moonshotai/model-y=[max]",
		]);
	});

	it("treats off-level differences as legitimate per-provider variance", () => {
		const catalog = {
			openai: {
				"gpt-5.9": row({ id: "gpt-5.9", api: "openai-responses", thinkingLevelMap: { off: "none", xhigh: "xhigh" } }),
			},
			"github-copilot": {
				"gpt-5.9": row({ id: "gpt-5.9", api: "openai-responses", thinkingLevelMap: { off: null, xhigh: "xhigh" } }),
			},
		};
		expect(validateModelCatalog(catalog)).toEqual([]);
	});
});
