import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = resolve(import.meta.dirname, "..");

describe("package.json exports resolve to existing paths", () => {
	const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));

	it("every subpath export points to a source file that exists", () => {
		const exports = pkg.exports;
		for (const [subpath, conditional] of Object.entries(exports)) {
			if (typeof conditional !== "object" || conditional === null) continue;
			for (const [condition, distPath] of Object.entries(conditional as Record<string, string>)) {
				// Skip the root "." export — the main index is always valid
				if (subpath === ".") continue;
				// Map dist/ back to src/ to check the source file exists
				const srcPath = distPath
					.replace(/^\.\/dist\//, "./src/")
					.replace(/\.js$/, ".ts")
					.replace(/\.d\.ts$/, ".ts");
				const fullPath = join(pkgRoot, srcPath);
				expect(
					existsSync(fullPath),
					`export "${subpath}" condition "${condition}" maps to ${distPath} (src: ${srcPath}), but ${fullPath} does not exist`,
				).toBe(true);
			}
		}
	});
});

describe("tsconfig.examples.json path mappings resolve to existing source files", () => {
	const tsconfig = JSON.parse(readFileSync(join(pkgRoot, "tsconfig.examples.json"), "utf-8"));

	it("every path mapping points to an existing .ts file", () => {
		const paths = tsconfig.compilerOptions?.paths ?? {};
		for (const [alias, targets] of Object.entries(paths)) {
			for (const target of targets as string[]) {
				const fullPath = join(pkgRoot, target);
				expect(
					existsSync(fullPath),
					`path mapping "${alias}" -> "${target}" resolves to ${fullPath}, which does not exist`,
				).toBe(true);
			}
		}
	});
});
