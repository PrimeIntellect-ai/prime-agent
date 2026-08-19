import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Cheapest reasoning request for background (non-interactive) completions such
 * as refinement, compaction, and status summaries. Requests thinking off when
 * the model supports it (providers translate this to their disable mechanism,
 * e.g. reasoning_effort "none" on z.ai GLM-5.2/5.3); mandatory-thinking models
 * get their lowest supported effort. Returns undefined only for non-reasoning
 * models.
 */
export function backgroundThinkingLevel(
	model: Model<any>,
	requested?: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	return clampThinkingLevel(model, requested ?? "off");
}
