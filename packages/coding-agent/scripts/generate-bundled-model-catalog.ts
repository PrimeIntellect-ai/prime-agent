import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadModelCatalogSnapshot } from "./model-catalog-snapshot.js";

const providerCatalog = JSON.parse(readFileSync(new URL("../../../catalog/models.v1.json", import.meta.url), "utf8"));
const catalog = await loadModelCatalogSnapshot(providerCatalog);
const dist = new URL("../dist/", import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("models.bundled.json", dist), `${JSON.stringify(catalog)}\n`);
const primeCount = catalog.models.filter((model) => model.provider === "prime-inference").length;
console.log(`Bundled ${catalog.models.length} models, including ${primeCount} public Prime Inference models`);
