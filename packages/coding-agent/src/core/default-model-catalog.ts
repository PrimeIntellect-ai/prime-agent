import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, getCatalogCacheDir, getModelCacheDir } from "../config.js";
import { CatalogCache } from "./model-catalog-cache.js";

export const DEFAULT_MODEL_CATALOG_URL =
	"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/defaults.v1.json";

const DEFAULT_MODEL_ID_PATTERN = /^([a-z0-9][a-z0-9-]{0,127})\/(.+)$/;

let defaultModelCache: CatalogCache<string> | undefined;

function getDefaultModelCache(): CatalogCache<string> {
	defaultModelCache ??= new CatalogCache(
		DEFAULT_MODEL_CATALOG_URL,
		join(getModelCacheDir(), "default-model.v1.json"),
		(payload) => parseDefaultModelCatalog(payload),
		// Historical locations remain readable; writes go to the models cache dir.
		[join(getAgentDir(), "default-model.v1.json"), join(getCatalogCacheDir(), "default-model.v1.json")],
	);
	return defaultModelCache;
}

/**
 * The catalog-defined preferred default model selector ("provider/model-id"), served
 * from the last-good cache. undefined means offline with no cached value; callers
 * fall back to the compiled defaults. Catalog data can retire a default and every
 * installed client picks up the replacement without a release.
 */
export function getPreferredDefaultModelId(): string | undefined {
	return getDefaultModelCache().get("public");
}

/** Background refresh of the catalog-defined default; never blocks callers. */
export function refreshDefaultModelCatalog(force = false): Promise<string | undefined> {
	return getDefaultModelCache().refresh("public", { force });
}

/** Parse a cached default entry against the same rules the runtime cache applies. */
export function parseDefaultModelCatalog(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) throw new Error("Invalid default-model catalog");
	const parsed = payload as { schemaVersion?: unknown; defaultModel?: unknown };
	if (parsed.schemaVersion !== 1) throw new Error("Unsupported default-model catalog version");
	if (typeof parsed.defaultModel !== "string" || !DEFAULT_MODEL_ID_PATTERN.test(parsed.defaultModel)) {
		throw new Error("Invalid default-model catalog entry");
	}
	return parsed.defaultModel;
}

/** Resolve a catalog default selector against the available model list. */
export function resolvePreferredDefaultModel(
	preferredId: string | undefined,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (!preferredId) return undefined;
	const separator = preferredId.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = preferredId.slice(0, separator);
	const modelId = preferredId.slice(separator + 1);
	return availableModels.find((model) => model.provider === provider && model.id === modelId);
}
