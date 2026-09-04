import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("Prime runtime assets", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
	});

	it("ships only runtime source and project metadata", () => {
		const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		expect(packageJson.scripts?.["copy-assets"]).toContain("node scripts/copy-prime-runtime-assets.mjs");

		const root = join(tmpdir(), `prime-runtime-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const source = join(root, "source");
		const destination = join(root, "destination");
		directories.push(root);
		mkdirSync(join(source, "src", "rlm", "__pycache__"), { recursive: true });
		mkdirSync(join(source, ".venv", "bin"), { recursive: true });
		mkdirSync(join(source, "test"), { recursive: true });
		writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "runtime"\n');
		writeFileSync(join(source, "uv.lock"), "lock");
		writeFileSync(join(source, "src", "rlm", "__init__.py"), "VALUE = 1\n");
		writeFileSync(join(source, "src", "rlm", "__pycache__", "inspection.pyc"), "cache");
		writeFileSync(join(source, ".venv", "bin", "python"), "local interpreter");
		writeFileSync(join(source, "test", "test_runtime.py"), "test-only source");

		const script = join(process.cwd(), "scripts", "copy-prime-runtime-assets.mjs");
		const result = spawnSync(process.execPath, [script, source, destination], { encoding: "utf8" });

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(destination, "pyproject.toml"), "utf8")).toContain('name = "runtime"');
		expect(readFileSync(join(destination, "src", "rlm", "__init__.py"), "utf8")).toBe("VALUE = 1\n");
		expect(existsSync(join(destination, "src", "rlm", "__pycache__"))).toBe(false);
		expect(existsSync(join(destination, ".venv"))).toBe(false);
		expect(existsSync(join(destination, "test"))).toBe(false);
		expect(existsSync(join(destination, "uv.lock"))).toBe(false);
	});
});
