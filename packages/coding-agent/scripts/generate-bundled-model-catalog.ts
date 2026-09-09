import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getModels } from "@earendil-works/pi-ai";
import { createBundledModelCatalog } from "../src/core/bundled-model-catalog.js";
import { isModelCatalogOffline } from "../src/core/model-catalog-cache.js";
import { PRIME_INFERENCE_BASE_URL } from "../src/core/prime-inference-model-catalog.js";
import { parsePrimeInferenceCatalogModels } from "../src/core/prime-inference-models.js";

const providerCatalog = JSON.parse(readFileSync(new URL("../../../catalog/models.v1.json", import.meta.url), "utf8"));
let primeModels = getModels("prime-inference");
if (!isModelCatalogOffline()) {
	try {
		const response = await fetch(`${PRIME_INFERENCE_BASE_URL}/models`, {
			headers: { accept: "application/json", "user-agent": "prime-agent-catalog-snapshot/1.0" },
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		primeModels = parsePrimeInferenceCatalogModels(await response.json(), primeModels, false);
	} catch (error) {
		console.warn(`Using compiled Prime Inference models for the install snapshot: ${String(error)}`);
	}
}
const catalog = createBundledModelCatalog(providerCatalog, primeModels);
const dist = new URL("../dist/", import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("models.bundled.json", dist), `${JSON.stringify(catalog)}\n`);
console.log(`Bundled ${catalog.models.length} models, including ${primeModels.length} public Prime Inference models`);
