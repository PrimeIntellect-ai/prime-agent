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

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= 100 &&
		value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256)
	);
}

function isStringRecord(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.keys(value).length <= 100 &&
		Object.entries(value).every(
			([key, entry]) => key.length <= 128 && typeof entry === "string" && entry.length <= 4_096,
		)
	);
}

const OPENROUTER_ROUTING_KEYS = new Set([
	"allow_fallbacks",
	"require_parameters",
	"data_collection",
	"zdr",
	"enforce_distillable_text",
	"order",
	"only",
	"ignore",
	"quantizations",
	"sort",
	"max_price",
	"preferred_min_throughput",
	"preferred_max_latency",
]);
const OPENROUTER_BOOLEAN_KEYS = ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"] as const;
const OPENROUTER_ARRAY_KEYS = ["order", "only", "ignore", "quantizations"] as const;
const PERCENTILE_KEYS = new Set(["p50", "p75", "p90", "p99"]);
const OPENROUTER_SORT_KEYS = new Set(["by", "partition"]);
const OPENROUTER_PRICE_KEYS = new Set(["prompt", "completion", "image", "audio", "request"]);
const VERCEL_ROUTING_KEYS = new Set(["only", "order"]);
const OPENAI_RESPONSES_COMPAT_KEYS = new Set(["sendSessionIdHeader", "supportsLongCacheRetention"]);
const ANTHROPIC_MESSAGES_COMPAT_KEYS = new Set(["supportsEagerToolInputStreaming", "supportsLongCacheRetention"]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPercentileValue(value: unknown): boolean {
	if (isNonNegativeFiniteNumber(value)) return true;
	return (
		isRecord(value) && hasOnlyKeys(value, PERCENTILE_KEYS) && Object.values(value).every(isNonNegativeFiniteNumber)
	);
}

function isOpenRouterRouting(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, OPENROUTER_ROUTING_KEYS)) return false;
	for (const key of OPENROUTER_BOOLEAN_KEYS) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
	}
	for (const key of OPENROUTER_ARRAY_KEYS) {
		if (value[key] !== undefined && !isStringArray(value[key])) return false;
	}
	if (value.data_collection !== undefined && value.data_collection !== "allow" && value.data_collection !== "deny")
		return false;
	if (value.sort !== undefined) {
		if (typeof value.sort !== "string") {
			if (!isRecord(value.sort) || !hasOnlyKeys(value.sort, OPENROUTER_SORT_KEYS)) return false;
			if (value.sort.by !== undefined && typeof value.sort.by !== "string") return false;
			if (
				value.sort.partition !== undefined &&
				value.sort.partition !== null &&
				typeof value.sort.partition !== "string"
			)
				return false;
		}
	}
	if (value.max_price !== undefined) {
		if (!isRecord(value.max_price) || !hasOnlyKeys(value.max_price, OPENROUTER_PRICE_KEYS)) return false;
		if (
			!Object.values(value.max_price).every(
				(entry) => isNonNegativeFiniteNumber(entry) || (typeof entry === "string" && entry.length <= 128),
			)
		)
			return false;
	}
	return (
		(value.preferred_min_throughput === undefined || isPercentileValue(value.preferred_min_throughput)) &&
		(value.preferred_max_latency === undefined || isPercentileValue(value.preferred_max_latency))
	);
}

const OPENAI_COMPLETIONS_COMPAT_KEYS = new Set([
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"maxTokensField",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"thinkingFormat",
	"openRouterRouting",
	"vercelGatewayRouting",
	"zaiToolStream",
	"supportsStrictMode",
	"cacheControlFormat",
	"sendSessionAffinityHeaders",
	"supportsLongCacheRetention",
]);
const OPENAI_COMPLETIONS_BOOLEAN_KEYS = [
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"zaiToolStream",
	"supportsStrictMode",
	"sendSessionAffinityHeaders",
	"supportsLongCacheRetention",
] as const;
const THINKING_FORMATS = new Set(["openai", "openrouter", "deepseek", "zai", "qwen", "qwen-chat-template"]);

function isOpenAiCompletionsCompat(value: Record<string, unknown>): boolean {
	if (!hasOnlyKeys(value, OPENAI_COMPLETIONS_COMPAT_KEYS)) return false;
	for (const key of OPENAI_COMPLETIONS_BOOLEAN_KEYS) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
	}
	if (
		value.maxTokensField !== undefined &&
		value.maxTokensField !== "max_completion_tokens" &&
		value.maxTokensField !== "max_tokens"
	)
		return false;
	if (value.thinkingFormat !== undefined && !THINKING_FORMATS.has(value.thinkingFormat as string)) return false;
	if (value.cacheControlFormat !== undefined && value.cacheControlFormat !== "anthropic") return false;
	if (value.openRouterRouting !== undefined && !isOpenRouterRouting(value.openRouterRouting)) return false;
	if (value.vercelGatewayRouting !== undefined) {
		if (
			!isRecord(value.vercelGatewayRouting) ||
			!hasOnlyKeys(value.vercelGatewayRouting, VERCEL_ROUTING_KEYS) ||
			(value.vercelGatewayRouting.only !== undefined && !isStringArray(value.vercelGatewayRouting.only)) ||
			(value.vercelGatewayRouting.order !== undefined && !isStringArray(value.vercelGatewayRouting.order))
		)
			return false;
	}
	return true;
}

function isCatalogCompat(api: string, value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || !isBoundedJsonObject(value)) return false;
	if (api === "openai-completions") return isOpenAiCompletionsCompat(value);
	if (api === "openai-responses") {
		return (
			hasOnlyKeys(value, OPENAI_RESPONSES_COMPAT_KEYS) &&
			Object.values(value).every((entry) => typeof entry === "boolean")
		);
	}
	if (api === "anthropic-messages") {
		return (
			hasOnlyKeys(value, ANTHROPIC_MESSAGES_COMPAT_KEYS) &&
			Object.values(value).every((entry) => typeof entry === "boolean")
		);
	}
	return false;
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
		(value.headers === undefined || isStringRecord(value.headers)) &&
		isCatalogCompat(value.api, value.compat)
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
		const key = JSON.stringify([model.provider, model.id]);
		if (seen.has(key)) throw new Error(`Duplicate model catalog entry ${key}`);
		seen.add(key);
	}
	return value as unknown as ModelCatalogV1;
}
