import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generatorPath = fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url));
const generatedModelsPath = fileURLToPath(new URL("../src/models.generated.ts", import.meta.url));
const tsxPath = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runGenerator(mode: string) {
	return spawnSync(process.execPath, [tsxPath, generatorPath], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: { ...process.env, PRIME_AGENT_MODEL_CATALOG_MODE: mode },
		encoding: "utf8",
	});
}

describe("model catalog generation modes", () => {
	it("uses the committed snapshot without fetching or rewriting it", () => {
		const before = readFileSync(generatedModelsPath, "utf8");
		const result = runGenerator("snapshot");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Using committed src/models.generated.ts snapshot");
		expect(result.stderr).toBe("");
		expect(readFileSync(generatedModelsPath, "utf8")).toBe(before);
	});

	it("fails closed on an unknown generation mode", () => {
		const result = runGenerator("not-a-mode");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown PRIME_AGENT_MODEL_CATALOG_MODE");
	});
});
