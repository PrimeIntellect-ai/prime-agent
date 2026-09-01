import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	inspectNativeExecutable,
	REQUIRED_BINARY_SIDECARS,
	runEmptyDiagnostic,
	runPackagedSmoke,
} from "../../../scripts/compiled-artifact-smoke.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");
const binary = join(distDir, "pi");

function dependencyDirectories(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name);
		if (["node_modules", ".venv", "__pycache__", ".pytest_cache"].includes(entry.name)) found.push(path);
		else found.push(...dependencyDirectories(path));
	}
	return found;
}

describe("compiled Bun artifact", () => {
	it("is a native executable", () => {
		expect(existsSync(binary)).toBe(true);
		expect(statSync(binary).size).toBeGreaterThan(10 * 1024 * 1024);
		expect(["elf", "mach-o"]).toContain(inspectNativeExecutable(binary));
	});

	it("documents the unsupported binary-only layout", () => {
		const result = runEmptyDiagnostic(binary);
		expect(result.detectedMissingPackageJson).toBe(true);
		expect(result.run.exitCode).not.toBe(0);
	});

	it("contains the complete supported sidecar set", () => {
		for (const name of REQUIRED_BINARY_SIDECARS) {
			expect(existsSync(join(distDir, name)), name).toBe(true);
		}
		for (const name of ["template.html", "template.css", "template.js"]) {
			expect(existsSync(join(distDir, "export-html", name)), name).toBe(true);
		}
		expect(existsSync(join(distDir, "prime-agent-runtime", "pyproject.toml"))).toBe(true);
	});

	it("contains no installed dependency or cache directories", () => {
		expect(dependencyDirectories(distDir)).toEqual([]);
	});

	it("runs --version and --help with no Node or npm on PATH", () => {
		const result = runPackagedSmoke(binary, distDir);
		expect(result.nodeAvailable).toBe(false);
		expect(result.npmAvailable).toBe(false);
		expect(result.passed).toBe(true);
		for (const run of result.runs) {
			expect(run.exitCode).toBe(0);
			expect(run.stdout.trim().length).toBeGreaterThan(0);
			expect(run.stderr).not.toContain("ENOENT");
		}
	});
});
