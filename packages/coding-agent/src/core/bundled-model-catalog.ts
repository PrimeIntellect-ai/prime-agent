import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function getBundledModels(): Model<Api>[] {
	const packageDir = getPackageDir();
	try {
		const source = !isBunBinary && existsSync(join(packageDir, "src"));
		const catalog = source
			? createBundledModelCatalog(JSON.parse(readFileSync(join(packageDir, "../../catalog/models.v1.json"), "utf8")))
			: parseModelCatalog(
					JSON.parse(
						readFileSync(join(packageDir, ...(isBunBinary ? [] : ["dist"]), "models.bundled.json"), "utf8"),
					),
				);
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
