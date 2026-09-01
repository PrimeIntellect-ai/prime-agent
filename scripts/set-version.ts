import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPaths = [
	"package.json",
	"packages/tui/package.json",
	"packages/ai/package.json",
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
] as const;
const target = process.argv.find((arg, index) => index >= 2 && !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;

if (!target || (!semverPattern.test(target) && !["patch", "minor", "major"].includes(target))) {
	console.error("Usage: bun scripts/set-version.ts <patch|minor|major|x.y.z> [--dry-run]");
	process.exit(2);
}

const manifests = await Promise.all(
	manifestPaths.map(async (path) => {
		const text = await readFile(join(rootDir, path), "utf8");
		return { path, text, value: JSON.parse(text) };
	}),
);
const currentVersions = new Set(manifests.map(({ value }) => value.version as string));
if (currentVersions.size !== 1) {
	throw new Error(`Workspace versions are not in lockstep: ${[...currentVersions].join(", ")}`);
}
const currentVersion = manifests[0].value.version as string;
const currentMatch = currentVersion.match(semverPattern);
if (!currentMatch) {
	throw new Error(`Current version is not x.y.z: ${currentVersion}`);
}

function nextVersion(): string {
	if (semverPattern.test(target!)) return target!;
	let major = Number(currentMatch![1]);
	let minor = Number(currentMatch![2]);
	let patch = Number(currentMatch![3]);
	if (target === "major") {
		major += 1;
		minor = 0;
		patch = 0;
	} else if (target === "minor") {
		minor += 1;
		patch = 0;
	} else {
		patch += 1;
	}
	return `${major}.${minor}.${patch}`;
}

const version = nextVersion();
const workspaceVersions = new Map(manifests.slice(1).map(({ value }) => [value.name as string, version]));
for (const manifest of manifests) {
	manifest.value.version = version;
	for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
		const dependencies = manifest.value[section] as Record<string, string> | undefined;
		if (!dependencies) continue;
		for (const name of Object.keys(dependencies)) {
			if (workspaceVersions.has(name)) dependencies[name] = `^${version}`;
		}
	}
}

console.log(`${currentVersion} -> ${version}`);
if (dryRun) process.exit(0);

const lockPath = join(rootDir, "bun.lock");
const originalLock = await readFile(lockPath, "utf8");
for (const manifest of manifests) {
	await writeFile(join(rootDir, manifest.path), `${JSON.stringify(manifest.value, null, "\t")}\n`);
}
const install = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
	cwd: rootDir,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
if (install.exitCode !== 0) {
	await Promise.all(manifests.map((manifest) => writeFile(join(rootDir, manifest.path), manifest.text)));
	await writeFile(lockPath, originalLock);
	console.error("Version update failed; restored manifests and bun.lock.");
	process.exit(install.exitCode);
}
