import { type TProperties, Type } from "typebox";
import { Value } from "typebox/value";
import { isModelCompat } from "./model-compat-schema.js";
import type { Api, Model } from "./types.js";

const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
const MAX_MODEL_CATALOG_MODELS = 20_000;

export interface ModelCatalogV1 {
	schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
	generatedAt: string;
	models: Model<Api>[];
}

function strictObject<T extends TProperties>(properties: T) {
	return Type.Object(properties, { additionalProperties: false });
}

const ThinkingLevelValueSchema = Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]);
const ThinkingLevelMapSchema = strictObject({
	off: Type.Optional(ThinkingLevelValueSchema),
	minimal: Type.Optional(ThinkingLevelValueSchema),
	low: Type.Optional(ThinkingLevelValueSchema),
	medium: Type.Optional(ThinkingLevelValueSchema),
	high: Type.Optional(ThinkingLevelValueSchema),
	xhigh: Type.Optional(ThinkingLevelValueSchema),
	max: Type.Optional(ThinkingLevelValueSchema),
});
const CostSchema = Type.Number({ minimum: 0, maximum: 1_000_000 });
const CatalogModelSchema = strictObject({
	id: Type.String({ minLength: 1, maxLength: 1_024 }),
	name: Type.String({ minLength: 1, maxLength: 1_024 }),
	api: Type.String({ minLength: 1, maxLength: 128 }),
	provider: Type.String({ minLength: 1, maxLength: 128 }),
	baseUrl: Type.String({ maxLength: 2_048 }),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, maxItems: 2 }),
	cost: Type.Object({
		input: CostSchema,
		output: CostSchema,
		cacheRead: CostSchema,
		cacheWrite: CostSchema,
	}),
	contextWindow: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
	maxTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
	featured: Type.Optional(Type.Boolean()),
	compat: Type.Optional(Type.Unknown()),
});
const ModelCatalogEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(MODEL_CATALOG_SCHEMA_VERSION),
	generatedAt: Type.String(),
	models: Type.Array(Type.Unknown(), { minItems: 1, maxItems: MAX_MODEL_CATALOG_MODELS }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createModelCatalog(models: readonly Model<Api>[], generatedAt = new Date()): ModelCatalogV1 {
	return {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		generatedAt: generatedAt.toISOString(),
		models: models
			.map((model) => {
				const catalogModel = structuredClone(model);
				delete catalogModel.headers;
				return catalogModel;
			})
			.sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id)),
	};
}

export function parseModelCatalog(value: unknown, options: { skipInvalidModels?: boolean } = {}): ModelCatalogV1 {
	if (!isRecord(value) || value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
		throw new Error("Unsupported model catalog schema version");
	}
	if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
		throw new Error("Invalid model catalog timestamp");
	}
	if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_MODEL_CATALOG_MODELS) {
		throw new Error("Invalid model catalog model count");
	}
	if (!Value.Check(ModelCatalogEnvelopeSchema, value)) throw new Error("Invalid model catalog entry");

	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	for (const candidate of value.models) {
		if (!Value.Check(CatalogModelSchema, candidate)) {
			if (options.skipInvalidModels) continue;
			throw new Error("Invalid model catalog entry");
		}
		const model = candidate as Model<Api>;
		if (!isModelCompat(model.api, model.compat)) {
			if (options.skipInvalidModels) continue;
			throw new Error("Invalid model catalog entry");
		}
		const key = JSON.stringify([model.provider, model.id]);
		if (seen.has(key)) throw new Error(`Duplicate model catalog entry ${key}`);
		seen.add(key);
		models.push(model);
	}
	if (models.length === 0) throw new Error("Model catalog has no compatible entries");
	return { schemaVersion: MODEL_CATALOG_SCHEMA_VERSION, generatedAt: value.generatedAt, models };
}
