#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The bundle loads the same code
 * from ~20 chunk files in under half the time. dist/ stays unbundled for
 * library consumers and type resolution; only the bin entry uses the bundle.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 */
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageDir, "dist", "bundle");
let buildId;
try {
	buildId = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
		cwd: dirname(packageDir),
		encoding: "utf8",
	}).trim();
} catch {
	buildId = `release-${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version}`;
}

rmSync(outdir, { recursive: true, force: true });

// The Bedrock provider is reached through a deliberately non-literal dynamic
// import (`register-builtins.ts` builds the specifier at runtime) so esbuild's
// static reachability analysis never sees it and cannot split it off the way
// every other provider's plain `import("./provider.js")` gets split and
// rewritten automatically. Left alone, esbuild never bundles the module or its
// `@aws-sdk` dependency at all: the compiled output still calls
// `import("./amazon-bedrock.js")`, but no such file is ever emitted, and
// Bedrock fails at first use with "Cannot find module" (see #751 — the
// released v0.7.0 tarball shipped exactly this way). Declaring the module as
// its own literal, unhashed entry point here forces esbuild to compile and
// bundle it (and its `@aws-sdk` closure) into the exact filename the runtime
// specifier expects, without changing the lazy, on-first-use loading behavior
// for ordinary startup.
const bedrockEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/bedrock-provider"));

await build({
	entryPoints: [
		{ in: join(packageDir, "dist", "cli.js"), out: "cli" },
		{ in: bedrockEntry, out: "amazon-bedrock" },
	],
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	// Native or interop-sensitive packages stay external; they resolve from
	// node_modules at runtime (and are loaded via createRequire/lazily anyway).
	external: ["zeromq", "koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
	define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: JSON.stringify(buildId) },
	banner: {
		js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
	},
	logLevel: "warning",
});

chmodSync(join(outdir, "cli.js"), 0o755);

// Verify bundle closure for every provider chunk reachable only through a
// non-literal dynamic import, which esbuild cannot police on its own: an
// unresolved specifier fails silently at first use instead of at build time
// (see #751 and the "provider bundle closure" acceptance criterion tracked in
// #1379). Extend this list if another provider adopts the same pattern.
const requiredRuntimeChunks = ["amazon-bedrock.js"];
const missingRuntimeChunks = requiredRuntimeChunks.filter((name) => !existsSync(join(outdir, name)));
if (missingRuntimeChunks.length > 0) {
	throw new Error(
		`bundle.mjs: expected dist/bundle/{${missingRuntimeChunks.join(", ")}} to exist for a runtime dynamic ` +
			"import esbuild cannot statically resolve, but esbuild did not emit them. " +
			"This provider will fail with \"Cannot find module\" at first use.",
	);
}

console.log("bundled dist/cli.js -> dist/bundle/");
