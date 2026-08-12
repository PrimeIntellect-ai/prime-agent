import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx/esm");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "src/cli.ts");

describe("OAuth CLI", () => {
	it("rejects a non-numeric interactive provider selection", () => {
		const testDir = mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		try {
			const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, "login"], {
				cwd: testDir,
				encoding: "utf8",
				input: "abc\n",
				timeout: 5_000,
			});

			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(1);
			expect(result.stdout).toContain("Select a provider:");
			expect(result.stdout).not.toContain("Logging in to");
			expect(result.stderr.trim()).toBe("Invalid selection");
			expect(result.stderr).not.toContain("TypeError");
			expect(result.stderr).not.toContain("Cannot read properties");
			expect(existsSync(join(testDir, "auth.json"))).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
