import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = resolve(root, "packages/coding-agent/src/bun/cli.ts");
const normal = resolve(root, "packages/coding-agent/src/bun/normal-cli.ts");

describe("early sandbox process dispatch", () => {
	test("routes internal modes before all normal CLI imports and side effects", () => {
		const source = readFileSync(entry, "utf8");
		expect(source).not.toContain("APP_NAME");
		expect(source).not.toContain("restoreSandboxEnv");
		expect(source.split("\n").some((line) => line.startsWith("import "))).toBe(false);
		const normalSource = readFileSync(normal, "utf8");
		expect(normalSource).toContain('import { APP_NAME } from "../config.js";');
		expect(normalSource).toContain("restoreSandboxEnv();");
		expect(normalSource).toContain('await import("./register-bedrock.js");');
		expect(normalSource).toContain('await import("../cli.js");');
	});

	test("internal routes fail closed with one empty-output code when protected runtime files are absent", () => {
		for (const mode of ["--internal-sandbox-launcher", "--internal-sandbox-peer"]) {
			const result = spawnSync(process.execPath, [entry, mode], {
				cwd: root,
				env: {
					HOME: "/tmp",
					TMPDIR: "/tmp",
					PATH: "/usr/local/bin:/usr/bin:/bin",
					LANG: "C.UTF-8",
					LC_ALL: "C.UTF-8",
				},
				encoding: null,
				maxBuffer: 1024,
				timeout: 10_000,
			});
			expect(result.status).toBe(91);
			expect(result.signal).toBeNull();
			expect(result.stdout.byteLength).toBe(0);
			expect(result.stderr.byteLength).toBe(0);
		}
	});
});
