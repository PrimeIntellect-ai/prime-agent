import type { Api, Model } from "../src/types.js";

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export const MAX_MODEL_CATALOG_MODELS = 20_000;

export interface ModelCatalogV1 {
	schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
	generatedAt: string;
	models: Model<Api>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCatalogModel(value: unknown): value is Model<Api> {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.api === "string" &&
		value.api.length > 0 &&
		typeof value.provider === "string" &&
		value.provider.length > 0 &&
		typeof value.baseUrl === "string" &&
		typeof value.reasoning === "boolean" &&
		Array.isArray(value.input) &&
		value.input.length > 0 &&
		value.input.every((item) => item === "text" || item === "image") &&
		isFiniteNonNegative(value.cost.input) &&
		isFiniteNonNegative(value.cost.output) &&
		isFiniteNonNegative(value.cost.cacheRead) &&
		isFiniteNonNegative(value.cost.cacheWrite) &&
		typeof value.contextWindow === "number" &&
		Number.isSafeInteger(value.contextWindow) &&
		value.contextWindow > 0 &&
		typeof value.maxTokens === "number" &&
		Number.isSafeInteger(value.maxTokens) &&
		value.maxTokens > 0
	);
}

function cloneModel(model: Model<Api>): Model<Api> {
	return structuredClone(model);
}

export function createModelCatalog(models: readonly Model<Api>[], generatedAt = new Date()): ModelCatalogV1 {
	const sorted = [...models]
		.map(cloneModel)
		.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
	return {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		generatedAt: generatedAt.toISOString(),
		models: sorted,
	};
}

export function parseModelCatalog(value: unknown): ModelCatalogV1 {
	if (!isRecord(value) || value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
		throw new Error("Model catalog has an unsupported schema version");
	}
	if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
		throw new Error("Model catalog has an invalid generatedAt timestamp");
	}
	if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_MODEL_CATALOG_MODELS) {
		throw new Error("Model catalog has an invalid model count");
	}

	const seen = new Set<string>();
	for (const model of value.models) {
		if (!isCatalogModel(model)) throw new Error("Model catalog contains an invalid model");
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) throw new Error(`Model catalog contains duplicate model ${key}`);
		seen.add(key);
	}
	return value as unknown as ModelCatalogV1;
}

export function assertProviderCounts(
	candidate: ModelCatalogV1,
	baseline: ModelCatalogV1,
	minimumRatio = 0.5,
): void {
	if (!(minimumRatio > 0 && minimumRatio <= 1)) throw new Error("minimumRatio must be in (0, 1]");
	const count = (catalog: ModelCatalogV1): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const model of catalog.models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		return counts;
	};
	const baselineCounts = count(baseline);
	const candidateCounts = count(candidate);
	for (const [provider, previous] of baselineCounts) {
		const current = candidateCounts.get(provider) ?? 0;
		const minimum = Math.max(1, Math.floor(previous * minimumRatio));
		if (current < minimum) {
			throw new Error(`Provider ${provider} dropped from ${previous} to ${current} models (minimum ${minimum})`);
		}
	}
}
