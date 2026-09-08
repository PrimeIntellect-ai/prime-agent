import type { Api, Context, Model, SimpleStreamOptions, Usage } from "./types.js";

/** An opaque provider checkpoint; replay the entire window without rewriting its items. */
export interface ProviderCompactionCheckpoint {
	version: 1;
	provider: string;
	api: Api;
	model: string;
	baseUrl: string;
	items: Record<string, unknown>[];
	estimatedTokens: number;
}

export interface ProviderCompactionResult {
	checkpoint: ProviderCompactionCheckpoint;
	usage?: Usage;
}

export interface CompactionOptions extends SimpleStreamOptions {
	customInstructions?: string;
}

/** Undefined means unsupported; failures must leave the caller's history intact. */
export type CompactFunction<TApi extends Api = Api> = (
	model: Model<TApi>,
	context: Context,
	options?: CompactionOptions,
) => Promise<ProviderCompactionResult | undefined>;

export function isCompactionCheckpoint(value: unknown): value is ProviderCompactionCheckpoint {
	if (!value || typeof value !== "object") return false;
	const checkpoint = value as Partial<ProviderCompactionCheckpoint>;
	return (
		checkpoint.version === 1 &&
		typeof checkpoint.provider === "string" &&
		typeof checkpoint.api === "string" &&
		typeof checkpoint.model === "string" &&
		typeof checkpoint.baseUrl === "string" &&
		typeof checkpoint.estimatedTokens === "number" &&
		Number.isFinite(checkpoint.estimatedTokens) &&
		checkpoint.estimatedTokens >= 0 &&
		Array.isArray(checkpoint.items) &&
		checkpoint.items.length > 0 &&
		checkpoint.items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
	);
}

export function compactionMatchesModel(
	checkpoint: ProviderCompactionCheckpoint,
	model: Pick<Model<Api>, "provider" | "id"> & Partial<Pick<Model<Api>, "api" | "baseUrl">>,
): boolean {
	return (
		checkpoint.provider === model.provider &&
		checkpoint.model === model.id &&
		(model.api === undefined || checkpoint.api === model.api) &&
		(model.baseUrl === undefined || checkpoint.baseUrl.replace(/\/+$/, "") === model.baseUrl.replace(/\/+$/, ""))
	);
}
