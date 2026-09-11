import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Api,
	createModelCatalog,
	getModels,
	getProviders,
	isPrivatePrimeInferenceModelId,
	type Model,
	type ModelCatalogV1,
	parseModelCatalog,
} from "@earendil-works/pi-ai";
import { getPackageDir, isBunBinary } from "../config.js";
import { PRIME_INFERENCE_BASE_URL } from "./prime-inference-model-catalog.js";
import { parseProviderModelCatalog } from "./provider-model-catalog.js";

const installedModels = getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
const bundledModelsByAsset = new Map<string, Model<Api>[]>();

function freezeCatalog(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeCatalog(child);
	Object.freeze(value);
}

export function createBundledModelCatalog(
	providerCatalog: unknown,
	primeModels: readonly Model<"openai-completions">[] = getModels("prime-inference"),
): ModelCatalogV1 {
	return parseModelCatalog(
		createModelCatalog([
			...parseProviderModelCatalog(parseModelCatalog(providerCatalog), installedModels),
			...primeModels.filter((model) => !isPrivatePrimeInferenceModelId(model.id)),
		]),
	);
}

function loadBundledModels(source: boolean, assetPath: string): Model<Api>[] {
	try {
		const catalog = source
			? createBundledModelCatalog(JSON.parse(readFileSync(assetPath, "utf8")))
			: parseModelCatalog(JSON.parse(readFileSync(assetPath, "utf8")));
		return [
			...parseProviderModelCatalog(catalog, installedModels),
			...catalog.models.filter(
				(model) =>
					model.provider === "prime-inference" &&
					model.api === "openai-completions" &&
					model.baseUrl === PRIME_INFERENCE_BASE_URL &&
					!isPrivatePrimeInferenceModelId(model.id),
			),
		];
	} catch {
		// A damaged installation must still offer the compiled model definitions.
		return installedModels;
	}
}

export function getBundledModels(): Model<Api>[] {
	const packageDir = getPackageDir();
	const source = !isBunBinary && existsSync(join(packageDir, "src"));
	const assetPath = source
		? resolve(packageDir, "../../catalog/models.v1.json")
		: resolve(packageDir, ...(isBunBinary ? [] : ["dist"]), "models.bundled.json");
	let models = bundledModelsByAsset.get(assetPath);
	if (!models) {
		// Install assets are immutable for this process. Clone once before freezing so
		// transport headers and fallback definitions do not freeze the global pi-ai models.
		models = structuredClone(loadBundledModels(source, assetPath));
		freezeCatalog(models);
		bundledModelsByAsset.set(assetPath, models);
	}
	// Callers may reorder the list, but model metadata is shared and immutable.
	return [...models];
}
