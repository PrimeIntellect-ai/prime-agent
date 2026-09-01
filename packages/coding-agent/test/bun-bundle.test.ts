import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const bundleDir = join(process.cwd(), "dist", "bundle");
const bundleEntry = join(bundleDir, "cli.js");
const distEntry = join(process.cwd(), "dist", "cli.js");
const bundleScript = join(process.cwd(), "scripts", "bundle.mjs");

beforeAll(() => {
	if (!existsSync(distEntry)) {
		for (const packageDir of ["../tui", "../ai", "../agent", "."]) {
			execFileSync("bun", ["--bun", "tsgo", "-p", "tsconfig.build.json"], {
				cwd: join(process.cwd(), packageDir),
			});
		}
	}
	if (existsSync(bundleDir)) {
		rmSync(bundleDir, { recursive: true, force: true });
	}
	execFileSync("bun", [bundleScript], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
});

function readEntry(): string {
	return readFileSync(bundleEntry, "utf8");
}

function listDir(): string[] {
	return readdirSync(bundleDir);
}

describe("bun-bundle build output", () => {
	it("creates dist/bundle/ directory", () => {
		expect(existsSync(bundleDir)).toBe(true);
	});

	it("creates entry point cli.js", () => {
		expect(existsSync(bundleEntry)).toBe(true);
	});

	it("sets cli.js executable", () => {
		const mode = statSync(bundleEntry).mode;
		expect(mode & 0o100).toBeTruthy();
	});
});

describe("bun-bundle entry content", () => {
	it("preserves shebang", () => {
		expect(readEntry().startsWith("#!/usr/bin/env node")).toBe(true);
	});

	it("injects require polyfill banner (createRequire)", () => {
		const text = readEntry();
		expect(text).toContain("createRequire as __piBundleCreateRequire");
		expect(text).toContain("node:module");
	});

	it("inlines __PI_BUNDLED__ define", () => {
		expect(readEntry()).not.toContain("__PI_BUNDLED__");
	});

	it("inlines __PI_BUILD_ID__ define", () => {
		expect(readEntry()).not.toContain("__PI_BUILD_ID__");
	});
});

describe("bun-bundle externals", () => {
	const packages = ["koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"];
	for (const pkg of packages) {
		it(`keeps ${pkg} external (not inlined)`, () => {
			expect(readEntry()).not.toContain(pkg);
		});
	}
});

describe("bun-bundle structure", () => {
	it("produces at least 20 chunk files", () => {
		const chunks = listDir().filter((f) => f !== "cli.js");
		expect(chunks.length).toBeGreaterThanOrEqual(20);
	});

	it("produces named provider chunks", () => {
		const named = listDir().filter(
			(f) =>
				f.startsWith("anthropic-") ||
				f.startsWith("google-") ||
				f.startsWith("azure-") ||
				f.startsWith("code-highlighter-"),
		);
		expect(named.length).toBeGreaterThanOrEqual(3);
	});

	it("entry imports relative chunks", () => {
		const relativeImports = readEntry().match(/from\s+["']\.\//g) || [];
		expect(relativeImports.length).toBeGreaterThanOrEqual(1);
	});

	it("writes linked source maps for the entry and chunks", () => {
		const files = listDir();
		const scripts = files.filter((file) => file.endsWith(".js"));
		const maps = files.filter((file) => file.endsWith(".js.map"));
		expect(maps.length).toBe(scripts.length);
		expect(readEntry()).toContain("sourceMappingURL=cli.js.map");
	});
});

describe("bun-bundle banner in chunks", () => {
	it("injects require polyfill into chunk files too", () => {
		const chunks = listDir()
			.filter((file) => file.endsWith(".js") && file !== "cli.js")
			.slice(0, 3);
		for (const chunk of chunks) {
			const content = readFileSync(join(bundleDir, chunk), "utf8");
			expect(content).toContain("createRequire");
			expect(content).toContain("node:module");
		}
	});
});
