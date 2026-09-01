import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const distDir = join(packageDir, "dist");
const mode = process.argv[2];

async function copyFiles(sourceDir: string, targetDir: string, suffix: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(suffix)) {
			await cp(join(sourceDir, entry.name), join(targetDir, entry.name));
		}
	}
}

async function replaceDirectory(source: string, target: string): Promise<void> {
	await rm(target, { recursive: true, force: true });
	await cp(source, target, { recursive: true });
}

async function copyFile(source: string, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	await cp(source, join(targetDir, basename(source)));
}

async function copyPackageAssets(): Promise<void> {
	await chmod(join(distDir, "cli.js"), 0o755);
	await copyFiles(join(packageDir, "src/modes/interactive/theme"), join(distDir, "modes/interactive/theme"), ".json");
	await copyFiles(join(packageDir, "src/modes/interactive/assets"), join(distDir, "modes/interactive/assets"), ".png");
	const exportDir = join(distDir, "core/export-html");
	for (const name of ["template.html", "template.css", "template.js"]) {
		await copyFile(join(packageDir, "src/core/export-html", name), exportDir);
	}
	await copyFiles(join(packageDir, "src/core/export-html/vendor"), join(exportDir, "vendor"), ".js");
	await replaceDirectory(join(repoDir, "prime-agent-runtime"), join(distDir, "prime-agent-runtime"));
	await replaceDirectory(join(packageDir, "skills"), join(distDir, "skills"));
}

async function copyBinaryAssets(): Promise<void> {
	for (const name of ["package.json", "README.md", "CHANGELOG.md"]) {
		await copyFile(join(packageDir, name), distDir);
	}
	await copyFiles(join(packageDir, "src/modes/interactive/theme"), join(distDir, "theme"), ".json");
	await copyFiles(join(packageDir, "src/modes/interactive/assets"), join(distDir, "assets"), ".png");
	await copyFile(join(packageDir, "src/core/export-html/template.html"), join(distDir, "export-html"));
	await copyFiles(join(packageDir, "src/core/export-html/vendor"), join(distDir, "export-html/vendor"), ".js");
	await replaceDirectory(join(packageDir, "docs"), join(distDir, "docs"));
	await replaceDirectory(join(packageDir, "examples"), join(distDir, "examples"));
	await copyFile(join(repoDir, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), distDir);
	await replaceDirectory(join(packageDir, "skills"), join(distDir, "skills"));
}

if (mode === "package") {
	await copyPackageAssets();
} else if (mode === "binary") {
	await copyBinaryAssets();
} else {
	console.error("Usage: bun scripts/copy-assets.ts <package|binary>");
	process.exit(2);
}
