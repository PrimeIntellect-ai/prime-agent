import type { ServiceTier, Usage } from "../types.js";

/**
 * Shared OpenAI service-tier pricing, used by the responses, codex-responses,
 * and completions streaming paths so the multiplier table has one owner.
 * Multipliers per https://developers.openai.com/api/docs/pricing (retrieved 2026-08-21).
 */
function getServiceTierCostMultiplier(modelId: string, serviceTier: ServiceTier | undefined): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority": {
			// Gateway model ids carry a vendor prefix (e.g. "openai/gpt-5.5").
			const bareId = modelId.slice(modelId.lastIndexOf("/") + 1);
			return bareId.startsWith("gpt-5.5") ? 2.5 : 2;
		}
		default:
			return 1;
	}
}

export function applyServiceTierPricing(usage: Usage, serviceTier: ServiceTier | undefined, modelId: string): void {
	const multiplier = getServiceTierCostMultiplier(modelId, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
