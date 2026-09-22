import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getAuxiliaryThinkingLevel(model: Model<Api>, thinkingLevel: ThinkingLevel = "low"): ThinkingLevel {
	// Keep auxiliary calls inexpensive without disabling an enabled session's reasoning.
	// Clamping may raise this preference when the model requires a higher effort.
	const preferred = thinkingLevel === "off" || thinkingLevel === "minimal" ? thinkingLevel : "low";
	return clampThinkingLevel(model, preferred);
}
