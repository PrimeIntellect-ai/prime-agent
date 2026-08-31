#!/usr/bin/env tsx

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api, Model } from "../src/types.js";
import { MODELS } from "../src/models.generated.js";
import { createModelCatalog } from "./model-catalog-format.js";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: export-model-catalog.ts <output-path>");
const models = Object.values(MODELS).flatMap((providerModels) => Object.values(providerModels)) as Model<Api>[];
writeFileSync(resolve(outputPath), `${JSON.stringify(createModelCatalog(models), null, 2)}\n`);
console.log(`Exported ${models.length} models to ${resolve(outputPath)}`);
