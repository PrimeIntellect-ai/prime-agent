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
		if (seen.has(item.id)) throw new Error(`Duplicate Prime Inference model ${item.id}`);
		const pricing = isRecord(item.pricing) ? item.pricing : {};
		const input = nonNegativeNumber(pricing.input_usd_per_mtok);
		const output = nonNegativeNumber(pricing.output_usd_per_mtok);
		if (input === undefined || output === undefined) continue;

		const name = typeof item.display_name === "string" ? item.display_name.trim() : "";
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

		seen.add(item.id);
		models.push({
			id: item.id,
			...(name ? { name } : {}),
			input,
			output,
			...(cacheRead !== undefined ? { cacheRead } : {}),
			...(cacheWrite !== undefined ? { cacheWrite } : {}),
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
