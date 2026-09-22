import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { toPosixPath } from "../../utils/paths.js";
import { addIgnoreRules, createIgnoreMatcher } from "../ignore-rules.js";

interface PiExtensionManifest {
	extensions?: unknown;
}

function readManifestExtensions(packageJsonPath: string): string[] | undefined {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: PiExtensionManifest };
		const declared = pkg.pi?.extensions;
		if (!Array.isArray(declared)) return undefined;
		return declared.filter((entry) => typeof entry === "string");
	} catch {
		return undefined;
	}
}

/**
 * Resolve the entry points of one extension directory:
 * package.json "pi.extensions" first, then index.ts, then index.js.
 * Returns null when the directory declares no entry point.
 */
export function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const declared = readManifestExtensions(packageJsonPath);
		if (declared?.length) {
			const entries = declared.map((extPath) => resolve(dir, extPath)).filter((extPath) => existsSync(extPath));
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	const indexJs = join(dir, "index.js");
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Collect extension entry points one level below dir: direct .ts/.js files and
 * subdirectories that declare an entry point. Entries matched by the directory's
 * ignore files, dot entries and node_modules are skipped.
 */
export function collectExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = createIgnoreMatcher();
	addIgnoreRules(ig, dir, dir);

	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(isDir ? `${relPath}/` : relPath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				entries.push(...(resolveExtensionEntries(fullPath) ?? []));
			}
		}
	} catch {
		// Unreadable directory: keep whatever was discovered so far.
	}

	return entries;
}
