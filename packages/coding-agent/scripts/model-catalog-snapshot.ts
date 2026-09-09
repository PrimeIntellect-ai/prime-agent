import { getModels, type ModelCatalogV1 } from "@earendil-works/pi-ai";
import { createBundledModelCatalog } from "../src/core/bundled-model-catalog.js";
import { isModelCatalogOffline } from "../src/core/model-catalog-cache.js";
import { PRIME_INFERENCE_BASE_URL } from "../src/core/prime-inference-model-catalog.js";
import { parsePrimeInferenceCatalogModels } from "../src/core/prime-inference-models.js";

export async function loadModelCatalogSnapshot(providerCatalog: unknown): Promise<ModelCatalogV1> {
	const primeModels = getModels("prime-inference");
	const fallback = createBundledModelCatalog(providerCatalog, primeModels);
	if (!isModelCatalogOffline()) {
		try {
			const response = await fetch(`${PRIME_INFERENCE_BASE_URL}/models`, {
				headers: { accept: "application/json", "user-agent": "prime-agent-catalog-snapshot/1.0" },
				signal: AbortSignal.timeout(5_000),
				redirect: "error",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return createBundledModelCatalog(
				providerCatalog,
				parsePrimeInferenceCatalogModels(await response.json(), primeModels, false),
			);
		} catch (error) {
			console.warn(`Using compiled Prime Inference models for the install snapshot: ${String(error)}`);
		}
	}
	return fallback;
}
