import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";

/** Built-in thinking level for models that are not open weight. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Open-weight models reason noticeably worse at "medium", so they start at the
 * highest level they support. Models without a "max"/"xhigh" mapping clamp down
 * to their own ceiling.
 */
export const OPEN_WEIGHT_DEFAULT_THINKING_LEVEL: ThinkingLevel = "max";

/**
 * Open-weight model families, matched as substrings of the lowercased model id
 * and name. Matching by id keeps private (`internal/...`, `dev/...`) and live
 * catalog models covered without listing every provider-specific id. Ambiguous
 * families such as mistral are deliberately left out. Extend this list when a
 * new open-weight family ships.
 */
const OPEN_WEIGHT_MODEL_FAMILIES: readonly string[] = [
	"glm",
	"z-ai",
	"zai",
	"qwen",
	"deepseek",
	"kimi",
	"moonshot",
	"minimax",
	"llama",
	"gpt-oss",
];

export function isOpenWeightModel(model: Pick<Model<Api>, "id" | "name"> | undefined): boolean {
	if (!model) return false;
	const haystack = `${model.id} ${model.name}`.toLowerCase();
	return OPEN_WEIGHT_MODEL_FAMILIES.some((family) => haystack.includes(family));
}

/**
 * Thinking level to use when the user has not configured one and no session
 * value is restored. Open-weight models get their maximum supported level,
 * everything else keeps the built-in default.
 */
export function defaultThinkingLevelForModel(model: Model<Api> | undefined): ThinkingLevel {
	if (!model || !isOpenWeightModel(model)) return DEFAULT_THINKING_LEVEL;
	return clampThinkingLevel(model, OPEN_WEIGHT_DEFAULT_THINKING_LEVEL) as ThinkingLevel;
}
