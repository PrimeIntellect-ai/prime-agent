import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSpecBenchSandboxArgs,
	ensureSpecBenchNooaUvCache,
	resolveSpecBenchUvCacheRoot,
	specBenchAgentEnvironment,
	specBenchToolchainProvenance,
} from "../../../src/evals/specbench/runner.js";

function sandboxArgs(environment: NodeJS.ProcessEnv): string[] {
	return buildSpecBenchSandboxArgs(
		"/agent",
		[],
		"/output/current",
		"/output",
		"/output/current/workspace",
		"/official-specbench",
		"/config",
		[],
		[],
		environment,
	);
}

describe("issue #6: SpecBench UV cache resolution", () => {
	it("uses the supplied home for the default cache and sandbox overlay", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-default-uv-cache-"));
		try {
			const suppliedHome = join(root, "home");
			const uvCache = join(suppliedHome, ".cache", "uv");
			mkdirSync(uvCache, { recursive: true });
			const environment = { HOME: suppliedHome, PATH: process.env.PATH };

			expect(resolveSpecBenchUvCacheRoot(environment)).toBe(uvCache);
			const args = sandboxArgs(environment);
			expect(args).toContain(uvCache);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses UV_CACHE_DIR for preflight, agent execution, provenance, and sandbox overlay", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-specbench-custom-uv-cache-"));
		try {
			const customCache = join(root, "custom-uv");
			mkdirSync(customCache, { recursive: true });
			const environment = { HOME: join(root, "home"), PATH: process.env.PATH, UV_CACHE_DIR: customCache };

			expect(resolveSpecBenchUvCacheRoot(environment)).toBe(customCache);
			expect(specBenchAgentEnvironment(environment).UV_CACHE_DIR).toBe(customCache);
			expect(specBenchToolchainProvenance(environment).uvCacheRoot).toBe(customCache);
			expect(sandboxArgs(environment)).toContain(customCache);

			const missingCache = join(root, "missing-uv");
			expect(() => ensureSpecBenchNooaUvCache({ ...environment, UV_CACHE_DIR: missingCache })).toThrow(
				`SpecBench NOOA uv cache is missing: ${missingCache}`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
