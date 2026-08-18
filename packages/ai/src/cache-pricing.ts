import type { Api, Model } from "./types.js";

export type AnthropicCacheDuration = "5m" | "1h";

export interface AnthropicCacheCreationUsage {
	ephemeral_5m_input_tokens: number;
	ephemeral_1h_input_tokens: number;
}

const ANTHROPIC_CACHE_READ_COST_MULTIPLIER = 0.1;
const ANTHROPIC_FIVE_MINUTE_CACHE_WRITE_COST_MULTIPLIER = 1.25;
const ANTHROPIC_ONE_HOUR_CACHE_WRITE_COST_MULTIPLIER = 2;

export function hasStandardAnthropicCachePricing<TApi extends Api>(model: Model<TApi>): boolean {
	const modelId = model.id.toLowerCase();
	const isAnthropicModel =
		model.provider === "anthropic" || modelId.startsWith("anthropic/") || modelId.startsWith("claude-");
	if (!isAnthropicModel) {
		return false;
	}

	const expectedCacheWriteCost = model.cost.input * ANTHROPIC_FIVE_MINUTE_CACHE_WRITE_COST_MULTIPLIER;
	const tolerance = Number.EPSILON * Math.max(1, model.cost.cacheWrite, expectedCacheWriteCost);
	return Math.abs(model.cost.cacheWrite - expectedCacheWriteCost) <= tolerance;
}

export function getAnthropicCacheCosts(
	inputCost: number,
	duration: AnthropicCacheDuration,
): { cacheRead: number; cacheWrite: number } {
	return {
		cacheRead: inputCost * ANTHROPIC_CACHE_READ_COST_MULTIPLIER,
		cacheWrite:
			inputCost *
			(duration === "1h"
				? ANTHROPIC_ONE_HOUR_CACHE_WRITE_COST_MULTIPLIER
				: ANTHROPIC_FIVE_MINUTE_CACHE_WRITE_COST_MULTIPLIER),
	};
}

export function getAnthropicCacheWriteCost(
	inputCost: number,
	duration: AnthropicCacheDuration,
	cacheCreation?: AnthropicCacheCreationUsage | null,
): number {
	if (!cacheCreation) {
		return getAnthropicCacheCosts(inputCost, duration).cacheWrite;
	}

	const fiveMinuteTokens = cacheCreation.ephemeral_5m_input_tokens;
	const oneHourTokens = cacheCreation.ephemeral_1h_input_tokens;
	const totalTokens = fiveMinuteTokens + oneHourTokens;
	if (totalTokens === 0) {
		return getAnthropicCacheCosts(inputCost, duration).cacheWrite;
	}

	return (
		(inputCost *
			(fiveMinuteTokens * ANTHROPIC_FIVE_MINUTE_CACHE_WRITE_COST_MULTIPLIER +
				oneHourTokens * ANTHROPIC_ONE_HOUR_CACHE_WRITE_COST_MULTIPLIER)) /
		totalTokens
	);
}
