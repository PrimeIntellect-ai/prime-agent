#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { assertProviderCounts, parseModelCatalog } from "./model-catalog-format.js";

const [candidatePath, baselinePath] = process.argv.slice(2);
if (!candidatePath || !baselinePath) {
	throw new Error("Usage: validate-model-catalog.ts <candidate-path> <baseline-path>");
}
const read = (path: string) => parseModelCatalog(JSON.parse(readFileSync(path, "utf8")) as unknown);
const candidate = read(candidatePath);
const baseline = read(baselinePath);
assertProviderCounts(candidate, baseline);
console.log(`Validated ${candidate.models.length} models against ${baseline.models.length} baseline models`);
