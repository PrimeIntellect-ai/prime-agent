import type { Api, Model } from "@earendil-works/pi-ai";
import { getFixtureModel } from "../../ai/test/fixture-models.js";

const codingAgentFixtureModels = {
	"anthropic/claude-sonnet-5": {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
} satisfies Record<string, Model<Api>>;

export function getCodingAgentFixtureModel<TApi extends Api = Api>(provider: string, modelId: string): Model<TApi> {
	const localModel = codingAgentFixtureModels[`${provider}/${modelId}` as keyof typeof codingAgentFixtureModels];
	if (localModel) return localModel as Model<TApi>;
	return getFixtureModel<TApi>(provider, modelId);
}
