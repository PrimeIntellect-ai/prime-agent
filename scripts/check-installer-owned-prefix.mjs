import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer owned-prefix check failed: could not find final main "$@" call.');
	process.exit(1);
}

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-prefix-"));

try {
	const separateCase = runHarness("separate-prefix", false);
	assertNpmInstallUsesOwnedPrefix(separateCase);
	assertUserShimLinksToOwnedPrefix(separateCase);

	const sameCase = runHarness("same-prefix", true);
	assertNpmInstallUsesOwnedPrefix(sameCase);
	assertOwnedBinaryIsPreserved(sameCase);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer owned-prefix check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer owned-prefix check passed.");

function runHarness(label, samePrefix) {
	const caseDir = join(tempDir, label);
	const harnessPath = join(caseDir, "harness.sh");
	const fakeBinDir = join(caseDir, "fake-bin");
	const fakeNpmPath = join(fakeBinDir, "npm");
	const userPrefix = join(caseDir, "user-prefix");
	const ownedPrefix = samePrefix ? userPrefix : join(caseDir, "owned-prefix");
	const npmLog = join(caseDir, "npm.log");
	const tarballPath = join(caseDir, "prime-agent-0.0.0.tgz");
	const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_run_quiet_with_animation_steps() {
	shift 3
	"$@"
}

prime_agent_owned_npm_prefix() {
	printf '%s' "$PRIME_AGENT_TEST_OWNED_PREFIX"
}

prime_agent_user_npm_prefix() {
	printf '%s' "$PRIME_AGENT_TEST_USER_PREFIX"
}

prime_agent_bootstrap_kernel_on_install=0
install_prime_agent_package "$PRIME_AGENT_TEST_TARBALL"
`;

	spawnSync("mkdir", ["-p", fakeBinDir, join(userPrefix, "bin"), ownedPrefix], { encoding: "utf-8" });
	writeFileSync(harnessPath, harnessSource, "utf-8");
	writeFileSync(tarballPath, "fake tarball", "utf-8");
	writeFakeNpm(fakeNpmPath);

	const result = spawnSync("sh", [harnessPath], {
		detached: true,
		encoding: "utf-8",
		env: {
			...process.env,
			PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
			PRIME_AGENT_TEST_NPM_LOG: npmLog,
			PRIME_AGENT_TEST_OWNED_PREFIX: ownedPrefix,
			PRIME_AGENT_TEST_USER_PREFIX: userPrefix,
			PRIME_AGENT_TEST_TARBALL: tarballPath,
		},
	});

	if (result.status !== 0) {
		failures.push(`${label}: harness exited with ${result.status ?? "unknown"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}

	return {
		label,
		npmOutput: existsSync(npmLog) ? readFileSync(npmLog, "utf-8") : "",
		ownedBin: join(ownedPrefix, "bin", "prime-agent"),
		ownedPrefix,
		userShim: join(userPrefix, "bin", "prime-agent"),
	};
}

function writeFakeNpm(fakeNpmPath) {
	writeFileSync(
		fakeNpmPath,
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$PRIME_AGENT_TEST_NPM_LOG"
if [ "\${1:-}" = prefix ] && [ "\${2:-}" = -g ]; then
	printf '%s\\n' "$PRIME_AGENT_TEST_USER_PREFIX"
	exit 0
fi
if [ "\${1:-}" = install ]; then
	prefix=
	while [ "$#" -gt 0 ]; do
		if [ "$1" = --prefix ]; then
			shift
			prefix="\${1:-}"
		fi
		shift || true
	done
	if [ -z "$prefix" ]; then
		printf 'missing --prefix for npm install\\n' >&2
		exit 17
	fi
	mkdir -p "$prefix/bin"
	printf '#!/bin/sh\\n' > "$prefix/bin/prime-agent"
	chmod +x "$prefix/bin/prime-agent"
	exit 0
fi
printf 'unexpected npm command: %s\\n' "$*" >&2
exit 18
`,
		"utf-8",
	);
	spawnSync("chmod", ["+x", fakeNpmPath], { encoding: "utf-8" });
}

function assertNpmInstallUsesOwnedPrefix(testCase) {
	if (!testCase.npmOutput.includes(`install -g --prefix ${testCase.ownedPrefix}`)) {
		failures.push(
			`${testCase.label}: expected npm install to use the Prime-Agent-owned prefix ${testCase.ownedPrefix}; got:\n${testCase.npmOutput}`,
		);
	}
}

function assertUserShimLinksToOwnedPrefix(testCase) {
	if (!existsSync(testCase.userShim)) {
		failures.push(`${testCase.label}: expected ${testCase.userShim} to be created`);
	} else if (!lstatSync(testCase.userShim).isSymbolicLink()) {
		failures.push(`${testCase.label}: expected ${testCase.userShim} to be a symlink into the Prime-Agent-owned install prefix`);
	} else if (!readlinkSync(testCase.userShim).includes(testCase.ownedPrefix)) {
		failures.push(`${testCase.label}: expected ${testCase.userShim} to point at the Prime-Agent-owned install prefix`);
	}
}

function assertOwnedBinaryIsPreserved(testCase) {
	if (!existsSync(testCase.ownedBin)) {
		failures.push(`${testCase.label}: expected ${testCase.ownedBin} to be preserved when user and owned prefixes match`);
	} else if (lstatSync(testCase.ownedBin).isSymbolicLink()) {
		failures.push(`${testCase.label}: expected ${testCase.ownedBin} not to be replaced by a self-referential symlink`);
	}
}
