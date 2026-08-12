import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx/esm");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "src/cli.ts");

function runLogin(choice: string): { code: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, "login"], {
		cwd: packageRoot,
		input: `${choice}\n`,
		encoding: "utf8",
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("pi-ai login interactive provider selection", () => {
	it("reports 'Invalid selection' for non-numeric input instead of crashing (#1271)", () => {
		const { code, stderr } = runLogin("abc");
		expect(code).toBe(1);
		expect(stderr).toContain("Invalid selection");
	});

	it("reports 'Invalid selection' for an out-of-range number", () => {
		const { code, stderr } = runLogin("999");
		expect(code).toBe(1);
		expect(stderr).toContain("Invalid selection");
	});
});
