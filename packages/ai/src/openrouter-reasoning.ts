import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface OpenRouterReasoningCapabilities {
	/** Exact local-to-provider effort map. null entries are unsupported. */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Whether the model exposes effort selection, rather than only an enabled toggle. */
	supportsReasoningEffort: boolean;
	/** Whether the model rejects attempts to disable reasoning. */
	mandatory: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledOnlyCapabilities(mandatory: boolean): OpenRouterReasoningCapabilities {
	// The model supports reasoning as an on/off capability, but does not expose
	// effort selection. Represent that as one generic active level in the UI.
	return {
		thinkingLevelMap: {
			...(mandatory ? { off: null } : {}),
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
		supportsReasoningEffort: false,
		mandatory,
	};
}

export function getOpenRouterReasoningCapabilities(model: unknown): OpenRouterReasoningCapabilities | undefined {
	if (!isRecord(model)) return undefined;
	const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
	if (!supportedParameters.includes("reasoning") || !isRecord(model.reasoning)) return undefined;

	const mandatory = model.reasoning.mandatory === true;
	const rawEfforts = model.reasoning.supported_efforts;
	if (rawEfforts === null) {
		const thinkingLevelMap: ThinkingLevelMap = {};
		if (mandatory) thinkingLevelMap.off = null;
		for (const level of THINKING_LEVELS) thinkingLevelMap[level] = level;
		return { thinkingLevelMap, supportsReasoningEffort: true, mandatory };
	}

	if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
		const supportedEfforts = new Set(
			rawEfforts.filter(
				(effort): effort is ThinkingLevel =>
					typeof effort === "string" && THINKING_LEVELS.includes(effort as ThinkingLevel),
			),
		);
		if (supportedEfforts.size === 0) return enabledOnlyCapabilities(mandatory);
		const thinkingLevelMap: ThinkingLevelMap = {};
		if (mandatory) thinkingLevelMap.off = null;
		for (const level of THINKING_LEVELS) {
			thinkingLevelMap[level] = supportedEfforts.has(level) ? level : null;
		}
		return { thinkingLevelMap, supportsReasoningEffort: true, mandatory };
	}

	return enabledOnlyCapabilities(mandatory);
}
