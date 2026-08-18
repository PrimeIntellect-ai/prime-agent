import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return THINKING_LEVELS.includes(level as ThinkingLevel);
}
