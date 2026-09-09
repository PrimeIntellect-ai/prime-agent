import {
	type Api,
	isPrivatePrimeInferenceModelId,
	type Model,
	type OpenAICompletionsCompat,
	type PrimeInferenceCatalogEntry,
} from "@earendil-works/pi-ai";

export const PRIME_INFERENCE_BASE_URL = "https://api.pinference.ai/api/v1";
const MIN_CATALOG_COVERAGE = 0.5;

const DEFAULT_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	// The endpoint does not yet describe reasoning controls. Do not send an
	// unconfirmed reasoning_effort parameter for models without a bundled template.
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};

function cacheCosts(entry: PrimeInferenceCatalogEntry, template?: Model<"openai-completions">) {
	const anthropic = entry.id.toLowerCase().startsWith("anthropic/");
	return {
		cacheRead: entry.cacheRead ?? template?.cost.cacheRead ?? (anthropic ? entry.input * 0.1 : 0),
		cacheWrite: entry.cacheWrite ?? template?.cost.cacheWrite ?? (anthropic ? entry.input * 1.25 : 0),
	};
}

export function buildPrimeInferenceModels(
	bundledModels: readonly Model<"openai-completions">[],
	entries: readonly PrimeInferenceCatalogEntry[],
	options: { includePrivate?: boolean; minimumModels?: number } = {},
): Model<"openai-completions">[] | undefined {
	const bundled = new Map(bundledModels.map((model) => [model.id.toLowerCase(), model]));
	const models: Model<"openai-completions">[] = [];
	for (const entry of entries) {
		if (!options.includePrivate && isPrivatePrimeInferenceModelId(entry.id)) continue;
		const template = bundled.get(entry.id.toLowerCase());
		if (!template && (!entry.contextWindow || !entry.maxTokens || entry.reasoning === undefined)) continue;
		const contextWindow = entry.contextWindow ?? template?.contextWindow ?? 0;
		const maxTokens = Math.min(entry.maxTokens ?? template?.maxTokens ?? 0, contextWindow);
		models.push({
			id: entry.id,
			name: entry.name ?? template?.name ?? entry.id,
			api: "openai-completions",
			provider: "prime-inference",
			baseUrl: PRIME_INFERENCE_BASE_URL,
			reasoning: entry.reasoning ?? template?.reasoning ?? false,
			...(template?.thinkingLevelMap ? { thinkingLevelMap: { ...template.thinkingLevelMap } } : {}),
			input: (entry.vision ?? template?.input.includes("image")) ? ["text", "image"] : ["text"],
			cost: { input: entry.input, output: entry.output, ...cacheCosts(entry, template) },
			contextWindow,
			maxTokens,
			...(template?.featured ? { featured: true } : {}),
			compat: structuredClone(template?.compat ?? DEFAULT_COMPAT),
		});
	}
	const minimumModels = options.minimumModels ?? Math.ceil(bundledModels.length * MIN_CATALOG_COVERAGE);
	const coveredBundledModels = models.filter((model) => bundled.has(model.id.toLowerCase())).length;
	return coveredBundledModels >= minimumModels ? models : undefined;
}

export function mergePrimeInferenceModels(
	bundledModels: readonly Model<Api>[],
	livePrimeInferenceModels?: readonly Model<"openai-completions">[],
): Model<Api>[] {
	if (!livePrimeInferenceModels) return [...bundledModels];
	return [...bundledModels.filter((model) => model.provider !== "prime-inference"), ...livePrimeInferenceModels];
}
