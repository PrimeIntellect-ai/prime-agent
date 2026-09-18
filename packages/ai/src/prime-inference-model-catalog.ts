import type { ThinkingLevel, ThinkingLevelMap } from "./types.js";

export interface PrimeInferenceCatalogEntry {
	id: string;
	name?: string;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
	/** Request parameter names the live route declares; absent when the route reports none. */
	supportedParameters?: string[];
	/** Reasoning effort values the live route declares; absent when the route has no effort selector. */
	reasoningEfforts?: string[];
	/** Whether the live route rejects requests that disable reasoning. */
	reasoningMandatory?: boolean;
}

/** Reasoning request controls derived from a live Prime Inference catalog entry. */
export interface PrimeInferenceReasoningControls {
	/** Whether the route accepts a top-level `reasoning_effort` parameter. */
	supportsReasoningEffort: boolean;
	/** Thinking format required to address the route's declared reasoning parameters. */
	thinkingFormat?: "zai" | "openrouter";
	/** Local-to-route effort map; absent when the route exposes no selectable efforts. */
	thinkingLevelMap?: ThinkingLevelMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const REASONING_EFFORT_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return entries.length > 0 ? [...new Set(entries)] : undefined;
}

/**
 * Derives reasoning request controls from the parameters a live route declares.
 * Returns undefined when the route does not report parameter support; callers
 * then keep their bundled template compat instead of guessing.
 */
export function getPrimeInferenceReasoningControls(
	entry: Pick<PrimeInferenceCatalogEntry, "supportedParameters" | "reasoningEfforts" | "reasoningMandatory">,
): PrimeInferenceReasoningControls | undefined {
	const supported = entry.supportedParameters;
	if (!supported) return undefined;
	const includes = new Set(supported);
	const supportsReasoningEffort = includes.has("reasoning_effort");
	const mandatory = entry.reasoningMandatory === true;
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	if (entry.reasoningEfforts) {
		thinkingLevelMap = {};
		if (mandatory) thinkingLevelMap.off = null;
		else if (entry.reasoningEfforts.includes("none")) thinkingLevelMap.off = "none";
		for (const level of REASONING_EFFORT_LEVELS) {
			thinkingLevelMap[level] = entry.reasoningEfforts.includes(level) ? level : null;
		}
	} else if (includes.has("reasoning")) {
		// The route can only toggle reasoning on or off; expose a single generic level.
		thinkingLevelMap = {
			...(mandatory ? { off: null } : {}),
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		};
	}
	const thinkingFormat = includes.has("enable_thinking")
		? "zai"
		: includes.has("reasoning") && !supportsReasoningEffort
			? "openrouter"
			: undefined;
	return {
		supportsReasoningEffort,
		...(thinkingFormat ? { thinkingFormat } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

export function isPrivatePrimeInferenceModelId(modelId: string): boolean {
	const normalizedId = modelId.toLowerCase();
	return normalizedId.startsWith("internal/") || normalizedId.startsWith("dev/") || normalizedId.includes(":");
}

export function parsePrimeInferenceModelCatalog(
	value: unknown,
	options: { allowEmpty?: boolean } = {},
): PrimeInferenceCatalogEntry[] {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Invalid Prime Inference model catalog");
	const models: PrimeInferenceCatalogEntry[] = [];
	const seen = new Set<string>();
	for (const item of value.data) {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 1_024) continue;
		if (/[\u0000-\u001f\u007f-\u009f]/.test(item.id)) continue;
		if (seen.has(item.id)) throw new Error(`Duplicate Prime Inference model ${item.id}`);
		const pricing = isRecord(item.pricing) ? item.pricing : {};
		const input = nonNegativeNumber(pricing.input_usd_per_mtok);
		const output = nonNegativeNumber(pricing.output_usd_per_mtok);
		if (input === undefined || output === undefined) continue;

		const name =
			typeof item.display_name === "string"
				? item.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()
				: "";
		const specs = isRecord(item.specs) ? item.specs : {};
		const modalities = isRecord(specs.modalities) ? specs.modalities : {};
		const inputModalities =
			Array.isArray(modalities.input) && modalities.input.every((modality) => typeof modality === "string")
				? modalities.input
				: undefined;
		const outputModalities =
			Array.isArray(modalities.output) && modalities.output.every((modality) => typeof modality === "string")
				? modalities.output
				: undefined;
		const contextWindow = positiveInteger(specs.context_window);
		const maxTokens = positiveInteger(specs.max_output_tokens);
		const reasoning = typeof specs.supports_reasoning === "boolean" ? specs.supports_reasoning : undefined;
		const hasSpecs =
			contextWindow !== undefined &&
			maxTokens !== undefined &&
			reasoning !== undefined &&
			inputModalities !== undefined &&
			outputModalities !== undefined;
		const cacheRead = nonNegativeNumber(pricing.cache_read_usd_per_mtok);
		const cacheWrite = nonNegativeNumber(pricing.cache_write_usd_per_mtok);
		const supportedParameters = parseStringArray(item.supported_parameters);
		const reasoningSpec = isRecord(item.reasoning) ? item.reasoning : undefined;
		const reasoningEfforts = parseStringArray(reasoningSpec?.supported_efforts);
		const reasoningMandatory = reasoningSpec?.mandatory === true ? true : undefined;

		seen.add(item.id);
		models.push({
			id: item.id,
			...(name ? { name } : {}),
			input,
			output,
			...(cacheRead !== undefined ? { cacheRead } : {}),
			...(cacheWrite !== undefined ? { cacheWrite } : {}),
			...(supportedParameters ? { supportedParameters } : {}),
			...(reasoningEfforts ? { reasoningEfforts } : {}),
			...(reasoningMandatory !== undefined ? { reasoningMandatory } : {}),
			...(hasSpecs
				? {
						contextWindow,
						maxTokens: Math.min(maxTokens, contextWindow),
						vision: inputModalities.includes("image"),
						reasoning,
					}
				: {}),
		});
	}
	if (models.length === 0 && !options.allowEmpty) throw new Error("Prime Inference model catalog is empty");
	return models;
}
