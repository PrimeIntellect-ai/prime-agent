import { readFileSync } from "node:fs";
import { parseModelCatalog } from "../src/model-catalog.js";
import { MODELS } from "../src/models.generated.js";

const path = new URL("../../../catalog/models.v1.json", import.meta.url);
const catalog = parseModelCatalog(JSON.parse(readFileSync(path, "utf8")));
const transports = new Set(
	Object.values(MODELS)
		.flatMap(Object.values)
		.map((model) => JSON.stringify([model.provider, model.api, model.baseUrl])),
);
for (const model of catalog.models) {
	if (model.provider === "prime-inference") throw new Error("Prime Inference models come from its own endpoint");
	if (!transports.has(JSON.stringify([model.provider, model.api, model.baseUrl]))) {
		throw new Error(`Unsupported provider transport: ${model.provider}/${model.id}`);
	}
}
console.log(`Validated ${catalog.models.length} curated models`);
