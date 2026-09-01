#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { parseModelCatalog } from "./model-catalog-format.js";

const [candidatePath] = process.argv.slice(2);
if (!candidatePath) throw new Error("Usage: validate-model-catalog.ts <candidate-path>");
const candidate = parseModelCatalog(JSON.parse(readFileSync(candidatePath, "utf8")) as unknown);
console.log(`Validated ${candidate.models.length} models`);
