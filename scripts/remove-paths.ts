import { rm } from "node:fs/promises";
import { resolve } from "node:path";

if (process.argv.length < 3) {
	console.error("Usage: bun scripts/remove-paths.ts <path> [...path]");
	process.exit(2);
}

await Promise.all(process.argv.slice(2).map((path) => rm(resolve(path), { recursive: true, force: true })));
