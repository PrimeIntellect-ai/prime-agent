import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);

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

prime_agent_screen_enabled=0
prime_agent_bootstrap_kernel_on_install="$1"
install_prime_agent_package "$2"
`;

const npmSource = `#!/bin/sh
set -eu

if [ "\${1:-}" = "--version" ]; then
	printf '%s\\n' "$FAKE_NPM_VERSION"
	exit 0
fi

if [ "\${1:-}" != install ]; then
	printf 'unexpected npm command: %s\\n' "\${1:-}" >&2
	exit 2
fi

remote_policy=
script_policy=
for arg in "$@"; do
	case "$arg" in
		--allow-remote=*) remote_policy=\${arg#*=} ;;
		--allow-scripts=*) script_policy=\${arg#*=} ;;
	esac
done

npm_major=\${FAKE_NPM_VERSION%%.*}
if [ "$npm_major" -ge 12 ]; then
	if [ "$remote_policy" != all ]; then
		printf 'npm error code EALLOWREMOTE\\n' >&2
		exit 1
	fi
	if [ "$script_policy" != "$FAKE_NPM_TARBALL" ]; then
		printf 'npm error postinstall script was not explicitly allowed\\n' >&2
		exit 1
	fi
elif [ -n "$remote_policy" ] || [ -n "$script_policy" ]; then
	printf 'npm error Unknown allow option\\n' >&2
	exit 1
fi

if [ "\${PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL:-}" != 1 ]; then
	printf 'missing tool bootstrap environment\\n' >&2
	exit 2
fi
if [ "$EXPECT_KERNEL_BOOTSTRAP" = 1 ]; then
	if [ "\${PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL:-}" != 1 ] || [ "\${PRIME_AGENT_INSTALL_UV:-}" != 1 ]; then
		printf 'missing kernel bootstrap environment\\n' >&2
		exit 2
	fi
elif [ -n "\${PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL:-}" ] || [ -n "\${PRIME_AGENT_INSTALL_UV:-}" ]; then
	printf 'unexpected kernel bootstrap environment\\n' >&2
	exit 2
fi

printf 'remote=%s\\nscripts=%s\\n' "$remote_policy" "$script_policy" > "$FAKE_NPM_RESULT"
`;

try {
	mkdirSync(binDir);
	writeFileSync(harnessPath, harnessSource, "utf-8");
	writeFileSync(npmPath, npmSource, "utf-8");
	writeFileSync(tarballPath, "verified fixture", "utf-8");
	chmodSync(npmPath, 0o755);

	for (const npmVersion of ["10.9.8", "11.12.1", "12.0.2"]) {
		for (const bootstrapKernel of [false, true]) {
			const resultPath = join(tempDir, `npm-${npmVersion}-${bootstrapKernel ? "kernel" : "tools"}.txt`);
			const result = spawnSync("sh", [harnessPath, bootstrapKernel ? "1" : "0", tarballPath], {
				encoding: "utf-8",
				env: {
					...process.env,
					EXPECT_KERNEL_BOOTSTRAP: bootstrapKernel ? "1" : "0",
					FAKE_NPM_RESULT: resultPath,
					FAKE_NPM_TARBALL: tarballPath,
					FAKE_NPM_VERSION: npmVersion,
					PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
				},
			});
			if (result.status !== 0) {
				console.error(
					`Installer install check failed for npm ${npmVersion} (${bootstrapKernel ? "kernel" : "tools"}):\n${result.stderr}${result.stdout}`,
				);
				process.exit(1);
			}

			const policies = Object.fromEntries(
				readFileSync(resultPath, "utf-8")
					.trimEnd()
					.split("\n")
					.map((line) => line.split("=", 2)),
			);
			const npm12OrNewer = Number.parseInt(npmVersion, 10) >= 12;
			const expectedRemotePolicy = npm12OrNewer ? "all" : "";
			const expectedScriptPolicy = npm12OrNewer ? tarballPath : "";
			if (policies.remote !== expectedRemotePolicy || policies.scripts !== expectedScriptPolicy) {
				console.error(
					`Installer install check failed for npm ${npmVersion}: expected ${JSON.stringify({ remote: expectedRemotePolicy, scripts: expectedScriptPolicy })}, got ${JSON.stringify(policies)}.`,
				);
				process.exit(1);
			}
		}
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

console.log("Installer install check passed.");
