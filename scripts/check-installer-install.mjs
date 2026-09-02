import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCallIndex = installerSource.lastIndexOf('\nmain "$@"');
if (mainCallIndex === -1) {
	console.error('Installer install check failed: could not find final main "$@" call.');
	process.exit(1);
}

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-install-"));
const binDir = join(tempDir, "bin");
const harnessPath = join(tempDir, "harness.sh");
const npmPath = join(binDir, "npm");
const tarballPath = join(tempDir, "verified release package.tgz");

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_npm_install "$1"
`;

const npmSource = `#!/bin/sh
set -eu

if [ "\${1:-}" = "--version" ]; then
	printf '%s\\n' "$FAKE_NPM_VERSION"
	exit 0
fi
[ "\${1:-}" = install ] || exit 1

remote_policy=
script_policy=
target=
for arg in "$@"; do
	case "$arg" in
		--allow-remote=*) remote_policy=\${arg#*=} ;;
		--allow-scripts=*) script_policy=\${arg#*=} ;;
		"$FAKE_NPM_TARBALL") target="$arg" ;;
	esac
done
[ "$target" = "$FAKE_NPM_TARBALL" ] || exit 1

npm_major=\${FAKE_NPM_VERSION%%.*}
if [ "$npm_major" -ge 12 ]; then
	[ "$remote_policy" = all ] && [ "$script_policy" = "$FAKE_NPM_TARBALL" ] || exit 1
else
	[ -z "$remote_policy" ] && [ -z "$script_policy" ] || exit 1
fi
`;

try {
	mkdirSync(binDir);
	writeFileSync(harnessPath, harnessSource, "utf-8");
	writeFileSync(npmPath, npmSource, "utf-8");
	writeFileSync(tarballPath, "verified fixture", "utf-8");
	chmodSync(npmPath, 0o755);

	for (const npmVersion of ["10.9.8", "11.12.1", "12.0.2"]) {
		const result = spawnSync("sh", [harnessPath, tarballPath], {
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_NPM_TARBALL: tarballPath,
				FAKE_NPM_VERSION: npmVersion,
				PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			},
		});
		if (result.status !== 0) {
			console.error(`Installer install check failed for npm ${npmVersion}:\n${result.stderr}${result.stdout}`);
			process.exit(1);
		}
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

console.log("Installer install check passed.");
