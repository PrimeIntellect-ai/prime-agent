#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBundledCatalogDir } from "../packages/coding-agent/scripts/catalog-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
	"dist/models.bundled.json",
	"dist/mcp-services.bundled.json",
	"dist/prime-agent-runtime/pyproject.toml",
	"dist/skills/websearch/SKILL.md",
];

validateBundledCatalogDir(join(root, "packages/coding-agent/dist"), { allowSmallFixture: true });
const outDir = mkdtempSync(join(tmpdir(), "prime-agent-npm-pack-"));
try {
	const result = spawnSync(
		"npm",
		["pack", "--workspace", "packages/coding-agent", "--json", "--pack-destination", outDir],
		{ cwd: root, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	const [pack] = JSON.parse(result.stdout);
	const files = new Set(pack.files.map((file) => file.path));
	for (const file of required) {
		if (!files.has(file)) throw new Error(`npm pack omitted ${file}`);
	}
	if (!existsSync(join(outDir, pack.filename))) throw new Error(`npm pack did not create ${pack.filename}`);
	console.log(`npm pack includes bundled catalog assets: ${pack.filename}`);
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
