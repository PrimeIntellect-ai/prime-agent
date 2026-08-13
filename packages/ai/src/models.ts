import { MODELS } from "./models.generated.js";
import type { Api, CostTier, KnownProvider, Model, ModelThinkingLevel, ServiceTier, Usage } from "./types.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function supportsFastMode<TApi extends Api>(model: Model<TApi>): boolean {
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		(model.id === "gpt-5.4" || model.id === "gpt-5.5" || model.id === "gpt-5.6" || model.id.startsWith("gpt-5.6-"))
	);
}

export interface CostOverrides {
	cacheWrite?: number;
	/**
	 * Optional service-tier override (e.g. "priority", "flex") the caller
	 * wants charged for this request. When set, `calculateCost` looks up the
	 * corresponding multiplier in `Model.cost.serviceTierMultipliers` and
	 * scales the resolved per-token rates uniformly (input, output,
	 * cacheRead, cacheWrite). A missing or unknown tier is a no-op.
	 */
	serviceTier?: ServiceTier;
}

/**
 * Pick the highest-threshold tier whose `contextThreshold` is STRICTLY less
 * than `totalInputUsage`. `tiers` may be in any order; the highest matching
 * tier wins. Returns `undefined` if no tier matches.
 */
function pickCostTier(tiers: CostTier[] | undefined, totalInputUsage: number): CostTier | undefined {
	if (!tiers || tiers.length === 0) return undefined;
	let best: CostTier | undefined;
	for (const tier of tiers) {
		if (totalInputUsage > tier.contextThreshold) {
			if (!best || tier.contextThreshold > best.contextThreshold) {
				best = tier;
			}
		}
	}
	return best;
}

export function calculateCost<TApi extends Api>(
	model: Model<TApi>,
	usage: Usage,
	overrides?: CostOverrides,
): Usage["cost"] {
	// Tier selection uses total input-usage tokens (input + cacheRead + cacheWrite).
	// A tier applies only when the total is STRICTLY greater than its threshold,
	// so a value exactly equal to the threshold stays on the base rates.
	const totalInputUsage = usage.input + usage.cacheRead + usage.cacheWrite;
	const tier = pickCostTier(model.cost.tiers, totalInputUsage);
	const inputRate = tier?.input ?? model.cost.input;
	const outputRate = tier?.output ?? model.cost.output;
	const cacheReadRate = tier?.cacheRead ?? model.cost.cacheRead;
	// Preserve current cacheWrite override behavior: caller-supplied override
	// wins over both the tier cacheWrite rate and the base model.cost.cacheWrite.
	const cacheWriteRate = overrides?.cacheWrite ?? tier?.cacheWrite ?? model.cost.cacheWrite;

	usage.cost.input = (inputRate / 1000000) * usage.input;
	usage.cost.output = (outputRate / 1000000) * usage.output;
	usage.cost.cacheRead = (cacheReadRate / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (cacheWriteRate / 1000000) * usage.cacheWrite;

	// Apply model-declared service-tier multiplier AFTER explicit rates and
	// the cacheWrite override. A missing/unknown tier is a no-op (1).
	const multiplier =
		overrides?.serviceTier !== undefined && overrides.serviceTier !== null
			? (model.cost.serviceTierMultipliers?.[overrides.serviceTier] ?? 1)
			: 1;
	if (multiplier !== 1) {
		usage.cost.input *= multiplier;
		usage.cost.output *= multiplier;
		usage.cost.cacheRead *= multiplier;
		usage.cost.cacheWrite *= multiplier;
	}

	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
