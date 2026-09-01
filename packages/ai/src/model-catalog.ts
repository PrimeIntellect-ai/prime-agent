import type { Api, Model } from "./types.js";

const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
const MAX_MODEL_CATALOG_MODELS = 20_000;

export interface ModelCatalogV1 {
	schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
	generatedAt: string;
	models: Model<Api>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedJsonObject(value: unknown, depth = 0): boolean {
	if (!isRecord(value) || depth > 10 || Object.keys(value).length > 100) return false;
	return Object.entries(value).every(([key, entry]) => {
		if (key.length > 128) return false;
		if (entry === null || typeof entry === "boolean") return true;
		if (typeof entry === "string") return entry.length <= 4_096;
		if (typeof entry === "number") return Number.isFinite(entry);
		if (Array.isArray(entry))
			return entry.length <= 100 && entry.every((item) => isBoundedJsonObject({ item }, depth + 1));
		return isBoundedJsonObject(entry, depth + 1);
	});
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isThinkingLevelMap(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || Object.keys(value).some((key) => !THINKING_LEVELS.has(key))) return false;
	return Object.values(value).every(
		(entry) => entry === null || (typeof entry === "string" && entry.length > 0 && entry.length <= 128),
	);
}

function isCatalogModel(value: unknown): value is Model<Api> {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		isNonEmptyString(value.id, 1_024) &&
		isNonEmptyString(value.name, 1_024) &&
		isNonEmptyString(value.api, 128) &&
		isNonEmptyString(value.provider, 128) &&
		typeof value.baseUrl === "string" &&
		value.baseUrl.length <= 2_048 &&
		typeof value.reasoning === "boolean" &&
		isThinkingLevelMap(value.thinkingLevelMap) &&
		Array.isArray(value.input) &&
		value.input.length > 0 &&
		value.input.length <= 2 &&
		value.input.every((item) => item === "text" || item === "image") &&
		isFiniteCost(value.cost.input) &&
		isFiniteCost(value.cost.output) &&
		isFiniteCost(value.cost.cacheRead) &&
		isFiniteCost(value.cost.cacheWrite) &&
		typeof value.contextWindow === "number" &&
		Number.isSafeInteger(value.contextWindow) &&
		value.contextWindow > 0 &&
		value.contextWindow <= 100_000_000 &&
		typeof value.maxTokens === "number" &&
		Number.isSafeInteger(value.maxTokens) &&
		value.maxTokens > 0 &&
		value.maxTokens <= 100_000_000 &&
		(value.featured === undefined || typeof value.featured === "boolean") &&
		(value.headers === undefined || isBoundedJsonObject(value.headers)) &&
		(value.compat === undefined || isBoundedJsonObject(value.compat))
	);
}

export function createModelCatalog(models: readonly Model<Api>[], generatedAt = new Date()): ModelCatalogV1 {
	const sorted = [...models]
		.map((model) => structuredClone(model))
		.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
	return {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		generatedAt: generatedAt.toISOString(),
		models: sorted,
	};
}

export function parseModelCatalog(value: unknown): ModelCatalogV1 {
	if (!isRecord(value) || value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
		throw new Error("Unsupported model catalog schema version");
	}
	if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
		throw new Error("Invalid model catalog timestamp");
	}
	if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_MODEL_CATALOG_MODELS) {
		throw new Error("Invalid model catalog model count");
	}
	const seen = new Set<string>();
	for (const model of value.models) {
		if (!isCatalogModel(model)) throw new Error("Invalid model catalog entry");
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) throw new Error(`Duplicate model catalog entry ${key}`);
		seen.add(key);
	}
	return value as unknown as ModelCatalogV1;
}
