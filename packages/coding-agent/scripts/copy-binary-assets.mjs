import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageDir, "../..");
const excluded = new Set([
	"node_modules",
	".venv",
	"__pycache__",
	".pytest_cache",
	".ruff_cache",
	".mypy_cache",
	".git",
	".DS_Store",
]);

export const binaryAssets = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"prime-agent-runtime",
	"skills",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
	"photon_rs_bg.wasm",
];

function includeBinaryAsset(source) {
	return !source
		.split(/[\\/]/)
		.some((part) => excluded.has(part) || part.endsWith(".pyc") || part.endsWith(".egg-info"));
}

export function copyBinaryAssets(destination) {
	mkdirSync(destination, { recursive: true });
	const sources = {
		"package.json": join(packageDir, "package.json"),
		"README.md": join(packageDir, "README.md"),
		"CHANGELOG.md": join(packageDir, "CHANGELOG.md"),
		LICENSE: join(root, "LICENSE"),
		"prime-agent-runtime": join(root, "prime-agent-runtime"),
		skills: join(packageDir, "skills"),
		theme: join(packageDir, "src/modes/interactive/theme"),
		assets: join(packageDir, "src/modes/interactive/assets"),
		"export-html": join(packageDir, "src/core/export-html"),
		docs: join(packageDir, "docs"),
		examples: join(packageDir, "examples"),
		"photon_rs_bg.wasm": join(root, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
	};
	for (const [name, source] of Object.entries(sources)) {
		const target = join(destination, name);
		rmSync(target, { recursive: true, force: true });
		cpSync(source, target, {
			recursive: true,
			filter: (path) => {
				if (!includeBinaryAsset(relative(source, path))) return false;
				if (lstatSync(path).isSymbolicLink()) throw new Error(`Unexpected symlink in binary assets: ${path}`);
				if (name === "theme") return path === source || path.endsWith(".json");
				if (name === "export-html") return !path.endsWith(".ts");
				return true;
			},
		});
	}
}

export function validateBinaryAssets(directory) {
	for (const name of binaryAssets) lstatSync(join(directory, name));
	for (const name of [
		"prime-agent-runtime/pyproject.toml",
		"prime-agent-runtime/src/rlm/repl.py",
		"theme/prime.json",
		"theme/dark.json",
		"theme/light.json",
		"export-html/template.html",
		"export-html/template.css",
		"export-html/template.js",
		"export-html/vendor/marked.min.js",
		"export-html/vendor/highlight.min.js",
	]) {
		if (!lstatSync(join(directory, name)).isFile()) throw new Error(`Missing binary asset: ${name}`);
	}
	function visit(path) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !includeBinaryAsset(relative(directory, path))) {
			throw new Error(`Unexpected binary asset: ${path}`);
		}
		if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
	}
	visit(directory);
}

export function setBinaryVersion(directory, version) {
	const path = join(directory, "package.json");
	const metadata = JSON.parse(readFileSync(path, "utf8"));
	metadata.version = version;
	writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	copyBinaryAssets(resolve(process.argv[2] ?? join(packageDir, "dist")));
}
