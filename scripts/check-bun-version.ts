import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const expected = readFileSync(resolve(import.meta.dir, "../.bun-version"), "utf8").trim();
const actual = Bun.version;

if (actual !== expected) {
	console.error(`Expected Bun ${expected}, got ${actual}.`);
	process.exit(1);
}

console.log(`Validated Bun ${actual} (${process.execPath})`);
