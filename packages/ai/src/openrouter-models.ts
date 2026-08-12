import { getOpenRouterReasoningCapabilities } from "./openrouter-reasoning.js";
import type { Model } from "./types.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Transport overlay matching `generate-models.ts` for DeepSeek V4 OpenRouter routes. */
const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "max",
	max: null,
} as const;

/**
 * Parse a page of the OpenRouter model catalog into normalized models.
 * Skips malformed entries, drops `:batch` routes, and keeps tool-capable text
 * routes. Throws on a malformed top-level payload. Reasoning levels come from
 * {@link getOpenRouterReasoningCapabilities}.
 */
export function parseOpenRouterModels(payload: unknown): Model<"openai-completions">[] {
	const data = catalogEntries(payload);
	const models: Model<"openai-completions">[] = [];
	for (const raw of data) {
		const model = parseOpenRouterModel(raw);
		if (model) models.push(model);
	}
	return models;
}

function catalogEntries(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
	throw new Error("Invalid OpenRouter model catalog payload");
}

function parseOpenRouterModel(raw: unknown): Model<"openai-completions"> | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" ? raw.id : undefined;
	if (!id) return undefined;
	const parameters = stringArray(raw.supported_parameters);
	if (!parameters.includes("tools") || id.endsWith(":batch")) return undefined;

	const architecture = isRecord(raw.architecture) ? raw.architecture : {};
	const output = stringArray(architecture.output_modalities);
	if (output.length > 0 && !output.includes("text")) return undefined;

	const contextWindow = finitePositive(raw.context_length) ?? 4096;
	const topProvider = isRecord(raw.top_provider) ? raw.top_provider : {};
	const pricing = isRecord(raw.pricing) ? raw.pricing : {};
	const reasoningCapabilities = getOpenRouterReasoningCapabilities(raw);
	const model: Model<"openai-completions"> = {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: parameters.includes("reasoning"),
		input: hasImageInput(architecture) ? ["text", "image"] : ["text"],
		cost: {
			input: toCost(pricing.prompt),
			output: toCost(pricing.completion),
			cacheRead: toCost(pricing.input_cache_read),
			cacheWrite: toCost(pricing.input_cache_write),
		},
		contextWindow,
		maxTokens: Math.min(finitePositive(topProvider.max_completion_tokens) ?? 4096, contextWindow),
		...(reasoningCapabilities?.thinkingLevelMap ? { thinkingLevelMap: reasoningCapabilities.thinkingLevelMap } : {}),
		...(reasoningCapabilities?.supportsReasoningEffort === false
			? { compat: { supportsReasoningEffort: false } }
			: {}),
	};
	if (id.includes("deepseek-v4")) {
		model.compat = {
			...model.compat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
		model.thinkingLevelMap = { ...model.thinkingLevelMap, ...DEEPSEEK_V4_THINKING_LEVEL_MAP };
	}
	return model;
}

function hasImageInput(architecture: Record<string, unknown>): boolean {
	const modalities = stringArray(architecture.input_modalities);
	if (modalities.length > 0) return modalities.includes("image");
	const modality = typeof architecture.modality === "string" ? architecture.modality : "";
	return modality.split("->")[0].includes("image");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finitePositive(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toCost(value: unknown): number {
	const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
	return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
}
