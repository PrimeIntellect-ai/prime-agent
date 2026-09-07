import { describe, expect, it } from "vitest";
import {
	type CatalogLike,
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

function catalogOf(...models: CatalogRowLike[]): CatalogLike {
	const catalog: Record<string, Record<string, CatalogRowLike>> = {};
	for (const model of models) {
		catalog[model.provider] ??= {};
		catalog[model.provider][model.id] = model;
	}
	return catalog;
}

const NULL_MAP = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" };
const RICH_MAP = { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };

describe("model catalog validation", () => {
	it("accepts the committed catalog", () => {
		expect(validateModelCatalog(MODELS)).toEqual([]);
	});

	it.each<[string, CatalogLike, string[]]>([
		[
			"maxTokens above contextWindow",
			catalogOf(row({ id: "swapped", provider: "huggingface", contextWindow: 1000, maxTokens: 2000 })),
			["huggingface/swapped: maxTokens 2000 exceeds contextWindow 1000"],
		],
		[
			"unclassified and misrouted GitHub Copilot models",
			catalogOf(row({ id: "novel-model-x", provider: "github-copilot" }), row({ id: "grok-9", provider: "github-copilot" })),
			[
				"github-copilot/novel-model-x: unclassified model family; add it to copilotModelApi in validate-model-catalog.ts",
				"github-copilot/grok-9: api openai-completions does not match classification openai-responses",
			],
		],
		[
			"codex contextWindow diverging more than 2x from the openai row",
			catalogOf(
				row({ id: "gpt-9", provider: "openai", api: "openai-responses", contextWindow: 1050000 }),
				row({ id: "gpt-9", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272000 }),
			),
			["openai-codex/gpt-9: contextWindow 272000 diverges more than 2x from openai/gpt-9 (1050000)"],
		],
		[
			"same-model rows whose runtime-selectable thinking levels disagree",
			catalogOf(
				row({ id: "vendor/model-y", provider: "openrouter", reasoning: true, thinkingLevelMap: RICH_MAP }),
				row({ id: "model-y", provider: "huggingface", reasoning: true, thinkingLevelMap: NULL_MAP }),
			),
			[
				"model-y [openai-completions]: selectable thinking levels disagree across providers: " +
					"openrouter/vendor/model-y=[low,high,max], huggingface/model-y=[max]",
			],
		],
		[
			"selectable levels on a transport that cannot send reasoning effort, without crashing on a missing baseUrl",
			catalogOf(
				row({ id: "model-z", provider: "moonshotai", reasoning: true, thinkingLevelMap: NULL_MAP, baseUrl: undefined }),
			),
			["moonshotai/model-z: thinkingLevelMap offers [max] but the transport cannot send reasoning effort"],
		],
		[
			"nothing when maps differ only in off-level support",
			catalogOf(
				row({
					id: "gpt-5.9",
					provider: "openai",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { off: "none", xhigh: "xhigh" },
				}),
				row({
					id: "gpt-5.9",
					provider: "github-copilot",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { off: null, xhigh: "xhigh" },
				}),
			),
			[],
		],
	])("reports %s", (_name, catalog, expected) => {
		expect(validateModelCatalog(catalog)).toEqual(expected);
	});
});
