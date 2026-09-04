import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.argv[2] ?? join(scriptDirectory, "..", "..", "..", "prime-agent-runtime"));
const destinationRoot = resolve(process.argv[3] ?? join(scriptDirectory, "..", "dist", "prime-agent-runtime"));
const excludedNames = new Set([".venv", "__pycache__"]);

function requirePath(path, kind) {
	if (!existsSync(path) || (kind === "directory" ? !statSync(path).isDirectory() : !statSync(path).isFile())) {
		throw new Error(`Prime runtime ${kind} is missing: ${path}`);
	}
}

function shouldCopy(source) {
	const segments = relative(sourceRoot, source).split(sep);
	return !segments.some((segment) => excludedNames.has(segment)) && !source.endsWith(".pyc");
}

const pyproject = join(sourceRoot, "pyproject.toml");
const sourceDirectory = join(sourceRoot, "src");
requirePath(pyproject, "file");
requirePath(sourceDirectory, "directory");

rmSync(destinationRoot, { force: true, recursive: true });
mkdirSync(destinationRoot, { recursive: true });
cpSync(pyproject, join(destinationRoot, "pyproject.toml"));
cpSync(sourceDirectory, join(destinationRoot, "src"), {
	filter: shouldCopy,
	recursive: true,
});
