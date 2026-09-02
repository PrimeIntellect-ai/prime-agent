import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = join(dirname(fileURLToPath(import.meta.url)), "../../../install.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRelease(
	root: string,
	version: string,
	executable: string,
	checksumIsValid = true,
	omitSidecar?: string,
): void {
	const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const releaseDir = join(root, "server", "releases", `v${version}`);
	const stage = join(root, `stage-${version}`);
	mkdirSync(releaseDir, { recursive: true });
	mkdirSync(stage, { recursive: true });
	writeFileSync(join(stage, "prime-agent"), executable);
	chmodSync(join(stage, "prime-agent"), 0o755);
	const requiredFiles = [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"install.sh",
		"photon_rs_bg.wasm",
		"prime-agent-runtime/pyproject.toml",
		"theme/prime.json",
		"theme/dark.json",
		"theme/light.json",
		"theme/theme-schema.json",
		"export-html/template.html",
		"export-html/template.css",
		"export-html/template.js",
	];
	for (const relative of requiredFiles) {
		mkdirSync(dirname(join(stage, relative)), { recursive: true });
		writeFileSync(
			join(stage, relative),
			relative === "package.json" ? JSON.stringify({ name: "prime-agent", version }) : "fixture",
		);
	}
	for (const relative of ["skills", "assets", "docs", "examples", "export-html/vendor"]) {
		mkdirSync(join(stage, relative), { recursive: true });
		writeFileSync(join(stage, relative, ".keep"), "fixture");
	}
	if (omitSidecar) rmSync(join(stage, omitSidecar), { recursive: true, force: true });
	chmodSync(join(stage, "install.sh"), 0o755);
	const archiveName = `prime-agent-${version}-${platform}.tar.gz`;
	const archive = join(releaseDir, archiveName);
	const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
	if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
	const checksum = checksumIsValid ? createHash("sha256").update(readFileSync(archive)).digest("hex") : "0".repeat(64);
	writeFileSync(join(releaseDir, "SHA256SUMS"), `${checksum}  ${archiveName}\n`);
}

function corruptReleaseArchive(root: string, version: string): void {
	const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const releaseDir = join(root, "server", "releases", `v${version}`);
	const archiveName = `prime-agent-${version}-${platform}.tar.gz`;
	const archive = join(releaseDir, archiveName);
	writeFileSync(archive, "not a tar archive");
	const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
	writeFileSync(
		join(releaseDir, "SHA256SUMS"),
		`${checksum}  ${archiveName}
`,
	);
}

function installerEnv(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const home = join(root, "home");
	mkdirSync(join(home, ".prime"), { recursive: true });
	writeFileSync(join(home, ".prime", "sentinel"), "user data");
	return {
		...process.env,
		HOME: home,
		PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
		PRIME_AGENT_VERSIONS_DIR: join(root, "apps", "versions"),
		PRIME_AGENT_BIN_DIR: join(root, "bin"),
		TERM: "dumb",
		...overrides,
	};
}

function runInstaller(
	root: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): { exitCode: number; stdout: string; stderr: string } {
	const result = spawnSync("sh", [installer, ...args], {
		cwd: root,
		env: installerEnv(root, env),
		encoding: "utf8",
	});
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
}

function goodExecutable(version: string): string {
	return `#!/bin/sh\nif [ "${"$"}1" = "--version" ]; then echo "prime-agent ${version}"; exit 0; fi\nexit 0\n`;
}

describe("compiled binary installer", () => {
	test("installs a flat archive into a versioned app directory and preserves user data", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));

		const result = runInstaller(root, ["1.2.3"]);
		expect(result.exitCode, result.stderr).toBe(0);
		const target = join(realpathSync(root), "apps", "versions", "v1.2.3", "prime-agent");
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
		expect(readFileSync(join(root, "apps", "versions", "v1.2.3", "package.json"), "utf8")).toContain('"1.2.3"');
		expect(readFileSync(join(root, "home", ".prime", "sentinel"), "utf8")).toBe("user data");

		const secondInstall = runInstaller(root, ["1.2.3"]);
		expect(secondInstall.exitCode, secondInstall.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	test("links a custom command name to the canonical archive executable", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));

		const result = runInstaller(root, ["1.2.3"], { PRIME_AGENT_CMD: "pa" });
		expect(result.exitCode, result.stderr).toBe(0);
		const command = join(root, "bin", "pa");
		expect(readlinkSync(command)).toContain("v1.2.3/prime-agent");
		expect(spawnSync(command, ["--version"], { encoding: "utf8" }).status).toBe(0);
	});

	test("does not trust install metadata from the working directory in a piped install", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		const attackerDir = join(root, "attacker");
		mkdirSync(attackerDir);
		writeFileSync(
			join(attackerDir, ".install-paths"),
			`${join(root, "attacker-versions")}\n${join(root, "attacker-bin", "prime-agent")}\nprime-agent\n`,
		);
		const home = join(root, "piped-home");
		mkdirSync(home);

		const result = spawnSync("sh", ["-s", "--", "1.2.3"], {
			cwd: attackerDir,
			input: readFileSync(installer),
			env: {
				...process.env,
				HOME: home,
				PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
				PRIME_AGENT_VERSIONS_DIR: undefined,
				PRIME_AGENT_BIN_DIR: undefined,
				XDG_DATA_HOME: undefined,
				XDG_BIN_HOME: undefined,
				TERM: "dumb",
			},
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readlinkSync(join(home, ".local", "bin", "prime-agent"))).toContain("v1.2.3/prime-agent");
		expect(() => readlinkSync(join(root, "attacker-bin", "prime-agent"))).toThrow();
	});

	test("self-updates the persisted custom install paths without exported overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const v1Sidecar = join(root, "apps", "versions", "v1.2.3", "install.sh");
		writeFileSync(v1Sidecar, readFileSync(installer));
		chmodSync(v1Sidecar, 0o755);
		makeRelease(root, "2.0.0", goodExecutable("2.0.0"));
		const isolatedHome = join(root, "isolated-home");
		mkdirSync(isolatedHome);
		const result = spawnSync("sh", [v1Sidecar, "--update", "2.0.0"], {
			cwd: root,
			env: {
				...process.env,
				HOME: isolatedHome,
				PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
				PRIME_AGENT_VERSIONS_DIR: undefined,
				PRIME_AGENT_BIN_DIR: undefined,
				XDG_DATA_HOME: undefined,
				XDG_BIN_HOME: undefined,
				TERM: "dumb",
			},
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v2.0.0/prime-agent");
		expect(() => readlinkSync(join(isolatedHome, ".local", "bin", "prime-agent"))).toThrow();
	});

	test("accepts persisted paths from an old resident version after activation advances", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const oldSidecar = join(root, "apps", "versions", "v1.2.3", "install.sh");
		writeFileSync(oldSidecar, readFileSync(installer));
		chmodSync(oldSidecar, 0o755);
		makeRelease(root, "2.0.0", goodExecutable("2.0.0"));
		expect(runInstaller(root, ["--update", "2.0.0"]).exitCode).toBe(0);

		const isolatedHome = join(root, "isolated-home");
		mkdirSync(isolatedHome);
		const result = spawnSync("sh", [oldSidecar, "--update", "2.0.0"], {
			cwd: root,
			env: {
				...process.env,
				HOME: isolatedHome,
				PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
				PRIME_AGENT_VERSIONS_DIR: undefined,
				PRIME_AGENT_BIN_DIR: undefined,
				XDG_DATA_HOME: undefined,
				XDG_BIN_HOME: undefined,
				TERM: "dumb",
			},
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v2.0.0/prime-agent");
		expect(() => readlinkSync(join(isolatedHome, ".local", "bin", "prime-agent"))).toThrow();
	});

	test("repairs a missing public command from the bundled installer sidecar", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const sidecar = join(root, "apps", "versions", "v1.2.3", "install.sh");
		writeFileSync(sidecar, readFileSync(installer));
		chmodSync(sidecar, 0o755);
		rmSync(link);
		const isolatedHome = join(root, "isolated-home");
		mkdirSync(isolatedHome);

		const result = spawnSync("sh", [sidecar, "--update", "1.2.3"], {
			cwd: root,
			env: {
				...process.env,
				HOME: isolatedHome,
				PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
				PRIME_AGENT_VERSIONS_DIR: undefined,
				PRIME_AGENT_BIN_DIR: undefined,
				XDG_DATA_HOME: undefined,
				XDG_BIN_HOME: undefined,
				TERM: "dumb",
			},
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(readlinkSync(link)).toContain("v1.2.3/prime-agent");
		expect(() => readlinkSync(join(isolatedHome, ".local", "bin", "prime-agent"))).toThrow();
	});

	test("rejects a persisted command routed through a symlinked version directory", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const sidecar = join(root, "apps", "versions", "v1.2.3", "install.sh");
		writeFileSync(sidecar, readFileSync(installer));
		chmodSync(sidecar, 0o755);
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "prime-agent"), goodExecutable("attacker"));
		chmodSync(join(outside, "prime-agent"), 0o755);
		symlinkSync(outside, join(root, "apps", "versions", "escape"), "dir");
		rmSync(link);
		symlinkSync(join(root, "apps", "versions", "escape", "prime-agent"), link);

		const result = spawnSync("sh", [sidecar, "--update", "1.2.3"], {
			cwd: root,
			env: {
				...process.env,
				PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
				PRIME_AGENT_VERSIONS_DIR: undefined,
				PRIME_AGENT_BIN_DIR: undefined,
				TERM: "dumb",
			},
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("path metadata does not match");
		expect(readlinkSync(link)).toContain("versions/escape/prime-agent");
	});

	test("completes an explicit-path install without HOME when the command is not on PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));

		const result = runInstaller(root, ["1.2.3"], {
			HOME: undefined,
			XDG_DATA_HOME: undefined,
			XDG_BIN_HOME: undefined,
			PRIME_AGENT_SHELL_PROFILE: undefined,
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v1.2.3/prime-agent");
		expect(result.stdout).toContain("Add to your shell profile");
	});

	test("rejects a fresh install that fails through the activated command symlink", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(
			root,
			"1.2.3",
			'#!/bin/sh\ncase "$0" in */bin/prime-agent) exit 1 ;; esac\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 0\n',
		);

		const result = runInstaller(root, ["1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("installed Prime Agent command did not run correctly");
		expect(() => readlinkSync(join(root, "bin", "prime-agent"))).toThrow();
	});

	test("rejects a bad checksum before changing the active version", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"), false);

		const result = runInstaller(root, ["1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(() => readlinkSync(join(root, "bin", "prime-agent"))).toThrow();
	});

	test("rejects a pre-existing directory at the command path", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		const commandPath = join(root, "bin", "prime-agent");
		mkdirSync(commandPath, { recursive: true });

		const result = runInstaller(root, ["1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("command path is a directory");
		expect(readFileSync(join(root, "home", ".prime", "sentinel"), "utf8")).toBe("user data");
	});

	test("repairs a broken active command when updating to the same version", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const target = readlinkSync(link);
		writeFileSync(target, "#!/bin/sh\nexit 1\n");
		chmodSync(target, 0o755);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));

		const result = runInstaller(root, ["--update", "1.2.3"]);
		expect(result.exitCode, result.stderr).toBe(0);
		const smoke = spawnSync(link, ["--version"], { encoding: "utf8" });
		expect(smoke.status).toBe(0);
		expect(smoke.stdout).toContain("1.2.3");
	});

	test("keeps the active same-version install when repair extraction fails", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const target = readlinkSync(link);
		rmSync(join(dirname(target), "theme", "prime.json"));
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		corruptReleaseArchive(root, "1.2.3");

		const result = runInstaller(root, ["--update", "1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(readlinkSync(link)).toBe(target);
		expect(spawnSync(link, ["--version"], { encoding: "utf8" }).status).toBe(0);
		expect(readFileSync(join(dirname(target), "package.json"), "utf8").length).toBeGreaterThan(0);
	});

	test("does not use the repaired version as its own rollback target", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const target = readlinkSync(link);
		const publicPathFailure =
			'#!/bin/sh\ncase "$0" in */bin/prime-agent) exit 1 ;; esac\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 0\n';
		writeFileSync(target, publicPathFailure);
		chmodSync(target, 0o755);
		makeRelease(root, "1.2.3", publicPathFailure);

		const result = runInstaller(root, ["--update", "1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("no healthy rollback version was available");
		expect(() => readlinkSync(link)).toThrow();
		expect(readFileSync(join(root, "apps", "versions", "v1.2.3", "package.json"), "utf8").length).toBeGreaterThan(0);
	});

	test("does not self-rollback through an aliased versions directory", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		const physicalVersions = join(root, "physical-versions");
		const aliasedVersions = join(root, "aliased-versions");
		mkdirSync(physicalVersions);
		symlinkSync(physicalVersions, aliasedVersions, "dir");
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		const pathEnv = { PRIME_AGENT_VERSIONS_DIR: aliasedVersions };
		expect(runInstaller(root, ["1.2.3"], pathEnv).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const target = readlinkSync(link);
		writeFileSync(target, "#!/bin/sh\nexit 1\n");
		chmodSync(target, 0o755);
		const publicPathFailure =
			'#!/bin/sh\ncase "$0" in */bin/prime-agent) exit 1 ;; esac\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 0\n';
		makeRelease(root, "1.2.3", publicPathFailure);

		const result = runInstaller(root, ["1.2.3"], pathEnv);
		expect(result.exitCode).not.toBe(0);
		expect(() => readlinkSync(link)).toThrow();
		expect(readFileSync(join(physicalVersions, "v1.2.3", "package.json"), "utf8").length).toBeGreaterThan(0);
	});

	test("keeps the previous symlink when an update fails its smoke test", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const oldTarget = readlinkSync(link);

		makeRelease(root, "2.0.0", "#!/bin/sh\nexit 1\n");
		const result = runInstaller(root, ["--update", "2.0.0"]);
		expect(result.exitCode).not.toBe(0);
		expect(readlinkSync(link)).toBe(oldTarget);
		expect(readFileSync(join(root, "home", ".prime", "sentinel"), "utf8")).toBe("user data");
	});

	test("serializes concurrent updates without deleting an activated version", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		makeRelease(root, "2.0.0", goodExecutable("2.0.0").replace("then echo", "then sleep 1; echo"));
		const staleRoot = join(root, "apps", "versions", ".install-locks");
		mkdirSync(join(staleRoot, "1-99999991"), { recursive: true });

		const result = spawnSync(
			"sh",
			[
				"-c",
				'sh "$1" --update 2.0.0 & first=$!; sh "$1" --update 2.0.0 & second=$!; wait "$first"; a=$?; wait "$second"; b=$?; [ "$a" -eq 0 ] && [ "$b" -eq 0 ]',
				"--",
				installer,
			],
			{ cwd: root, env: installerEnv(root), encoding: "utf8", timeout: 20_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const link = join(root, "bin", "prime-agent");
		expect(readlinkSync(link)).toContain("v2.0.0/prime-agent");
		expect(spawnSync(link, ["--version"], { encoding: "utf8" }).status).toBe(0);
		expect(readdirSync(staleRoot)).toEqual([]);
	});

	test("recovers an install lock whose recorded process is gone", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		makeRelease(root, "2.0.0", goodExecutable("2.0.0"));
		const lockRoot = join(root, "apps", "versions", ".install-locks");
		const staleContender = join(lockRoot, "1-99999999");
		mkdirSync(staleContender, { recursive: true });

		const result = runInstaller(root, ["--update", "2.0.0"], {
			PRIME_AGENT_INSTALL_LOCK_TIMEOUT_SECONDS: "1",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v2.0.0/prime-agent");
		expect(() => readFileSync(join(staleContender, "pid"))).toThrow();
	});

	test("keeps the previous version when an update is missing a required sidecar", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const oldTarget = readlinkSync(link);

		makeRelease(root, "2.0.0", goodExecutable("2.0.0"), true, "theme/prime.json");
		const result = runInstaller(root, ["--update", "2.0.0"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("missing required sidecar: theme/prime.json");
		expect(readlinkSync(link)).toBe(oldTarget);
	});

	test("rolls back when the activated symlink fails its smoke test", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
		const link = join(root, "bin", "prime-agent");
		const oldTarget = readlinkSync(link);

		makeRelease(
			root,
			"2.0.0",
			'#!/bin/sh\ncase "$0" in */bin/prime-agent) exit 1 ;; esac\nif [ "$1" = "--version" ]; then echo "prime-agent 2.0.0"; exit 0; fi\nexit 0\n',
		);
		const result = runInstaller(root, ["--update", "2.0.0"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("restored the previous Prime Agent version");
		expect(readlinkSync(link)).toBe(oldTarget);
	});

	test("rejects glibc binaries on musl Linux before downloading", () => {
		if (process.platform !== "linux") return;
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		const tools = join(root, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "ldd"), '#!/bin/sh\necho "musl libc"\n');
		chmodSync(join(tools, "ldd"), 0o755);
		const result = runInstaller(root, ["1.2.3"], { PATH: `${tools}:${process.env.PATH}` });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("require glibc Linux");
	});

	test("warns when an older command shadows the installed binary", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
		const tools = join(root, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "prime-agent"), '#!/bin/sh\necho "old"\n');
		chmodSync(join(tools, "prime-agent"), 0o755);

		const result = runInstaller(root, ["1.2.3"], { PATH: `${tools}:${process.env.PATH}` });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).toContain("currently shadows the new binary");
		expect(result.stdout).toContain("export PATH='");
	});
	test("canonicalizes relative version directories before linking", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"));

		const result = runInstaller(root, ["1.2.3"], { PRIME_AGENT_VERSIONS_DIR: "relative/versions" });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(
			join(realpathSync(root), "relative", "versions", "v1.2.3", "prime-agent"),
		);
	});
});
