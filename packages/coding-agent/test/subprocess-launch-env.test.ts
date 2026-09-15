import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliSubprocessEnv } from "../src/cli/subprocess-launch.js";

const tempRoots: string[] = [];

function makeCheckout(): { root: string; entrypoint: string } {
	const root = mkdtempSync(join(tmpdir(), "subprocess-env-checkout-"));
	tempRoots.push(root);
	mkdirSync(join(root, "node_modules", "tsx"), { recursive: true });
	writeFileSync(join(root, "tsconfig.json"), "{}");
	writeFileSync(join(root, "node_modules", "tsx", "package.json"), "{}");
	const entrypoint = join(root, "packages", "coding-agent", "src", "cli.ts");
	mkdirSync(join(root, "packages", "coding-agent", "src"), { recursive: true });
	writeFileSync(entrypoint, "");
	return { root, entrypoint };
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("createCliSubprocessEnv tsconfig pinning", () => {
	it("overrides a stale inherited TSX_TSCONFIG_PATH with this checkout's tsconfig", () => {
		const { root, entrypoint } = makeCheckout();
		const env = createCliSubprocessEnv({ TSX_TSCONFIG_PATH: "/nonexistent/stale/tsconfig.json" }, entrypoint, [
			"--require",
			"tsx",
		]);
		expect(env.TSX_TSCONFIG_PATH).toBe(join(root, "tsconfig.json"));
	});

	it("keeps an inherited value untouched when the launch is not tsx-based", () => {
		const { entrypoint } = makeCheckout();
		const stale = "/nonexistent/stale/tsconfig.json";
		const env = createCliSubprocessEnv({ TSX_TSCONFIG_PATH: stale }, entrypoint, ["--inspect"]);
		expect(env.TSX_TSCONFIG_PATH).toBe(stale);
	});

	it("keeps an inherited value when no checkout is discoverable from the entrypoint", () => {
		const outside = mkdtempSync(join(tmpdir(), "subprocess-env-outside-"));
		tempRoots.push(outside);
		const stale = "/nonexistent/stale/tsconfig.json";
		const env = createCliSubprocessEnv({ TSX_TSCONFIG_PATH: stale }, join(outside, "cli.ts"), ["--require", "tsx"]);
		expect(env.TSX_TSCONFIG_PATH).toBe(stale);
	});

	it("leaves the environment unchanged when no entrypoint is available", () => {
		const stale = "/nonexistent/stale/tsconfig.json";
		const env = createCliSubprocessEnv({ TSX_TSCONFIG_PATH: stale }, "", ["--require", "tsx"]);
		expect(env.TSX_TSCONFIG_PATH).toBe(stale);
	});

	it("discovers the tsconfig from this repo for the real cli entrypoint", () => {
		const entrypoint = join(__dirname, "..", "src", "cli.ts");
		const env = createCliSubprocessEnv({ TSX_TSCONFIG_PATH: "/nonexistent/stale/tsconfig.json" }, entrypoint, [
			"--require",
			"tsx",
		]);
		expect(existsSync(env.TSX_TSCONFIG_PATH ?? "")).toBe(true);
	});
});
