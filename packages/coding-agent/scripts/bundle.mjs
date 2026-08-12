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
import { chmodSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
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

// Deliberately NOT wiping outdir. Provider backends are loaded with a lazy
// import() of a content-hashed chunk (./anthropic-<hash>.js and friends), which
// can fire hours into a session. Because the installed bin points straight at
// dist/bundle/cli.js, wiping the directory mid-session deletes chunks a live
// process has not imported yet — that process then dies on the next provider
// call with "Cannot find module .../anthropic-<oldhash>.js", and retrying can
// never fix it. Superseded chunks are instead left in place so running sessions
// keep resolving them, then pruned once they age past the grace window.
// Use `npm run clean` for a pristine dist; prepublishOnly already does.
const STALE_GRACE_MS = Number(process.env.PI_BUNDLE_STALE_GRACE_MS ?? 7 * 24 * 60 * 60 * 1000);

const result = await build({
	entryPoints: [join(packageDir, "dist", "cli.js")],
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
	// Needed to tell this build's outputs from superseded ones during the prune.
	metafile: true,
});

chmodSync(join(outdir, "cli.js"), 0o755);

// Drop superseded chunks that have outlived the grace window. Content hashing
// means a stale name is never re-emitted with different contents, so anything
// left over is either still serving an old process or already unreachable.
const emitted = new Set(Object.keys(result.metafile.outputs).map((file) => basename(file)));
let pruned = 0;
for (const name of readdirSync(outdir)) {
	if (emitted.has(name)) continue;
	const stale = join(outdir, name);
	if (Date.now() - statSync(stale).mtimeMs <= STALE_GRACE_MS) continue;
	rmSync(stale, { recursive: true, force: true });
	pruned++;
}

console.log(`bundled dist/cli.js -> dist/bundle/${pruned ? ` (pruned ${pruned} stale)` : ""}`);
