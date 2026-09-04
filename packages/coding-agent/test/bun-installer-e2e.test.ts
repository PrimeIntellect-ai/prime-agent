import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
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
import { basename, dirname, join } from "node:path";
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

function installVersionDir(root: string, version: string, executable: string, corrupt = false): string {
	const versionsDir = join(root, "apps", "versions");
	const verDir = join(versionsDir, `v${version}`);
	mkdirSync(verDir, { recursive: true });
	const binPath = join(verDir, "prime-agent");
	if (corrupt) {
		writeFileSync(binPath, "#!/bin/sh\nexit 1\n");
	} else {
		writeFileSync(binPath, executable);
	}
	chmodSync(binPath, 0o755);
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
		const dir = dirname(join(verDir, relative));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(verDir, relative),
			relative === "package.json" ? JSON.stringify({ name: "prime-agent", version }) : "fixture",
		);
	}
	for (const relative of ["skills", "assets", "docs", "examples", "export-html/vendor"]) {
		mkdirSync(join(verDir, relative), { recursive: true });
		writeFileSync(join(verDir, relative, ".keep"), "fixture");
	}
	writeFileSync(join(verDir, "install.sh"), readFileSync(installer));
	chmodSync(join(verDir, "install.sh"), 0o755);
	return verDir;
}

function failExec(): string {
	return '#!/bin/sh\ncase "$0" in */bin/prime-agent) exit 1 ;; esac\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 0\n';
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
	// ============================================================================

	// ============================================================================
	// ============================================================================
	describe("version-directory preservation", () => {
		test.each([
			["inactive healthy dir preserved on same-version install", "1.2.3", false, "1.2.3", false, "", ""],
			["inactive unhealthy dir repaired (fresh install)", "1.2.3", true, "1.2.3", false, "", ""],
			["inactive unhealthy dir repaired (update)", "2.0.0", true, "2.0.0", true, "1.2.3", "1.2.3"],
		])(
			"preserves dir: %s",
			(_name: string, preDirVer: string, isCorrupt: boolean, installVer: string, isUpdate: boolean, firstInstallVer: string, activeVerRelease: string) => {
				const root = mkdtempSync(join(tmpdir(), "pi-vdp-"));
				temporaryRoots.push(root);
				makeRelease(root, installVer, goodExecutable(installVer));
				if (activeVerRelease) makeRelease(root, activeVerRelease, goodExecutable(activeVerRelease));
				const exec = isCorrupt ? "#!/bin/sh\\nexit 1\\n" : goodExecutable(installVer);
				const dir = installVersionDir(root, preDirVer, exec, isCorrupt);
				const pkgPre = readFileSync(join(dir, "package.json"), "utf8");
				const hashPre = createHash("sha256").update(pkgPre).digest("hex");
				if (firstInstallVer) {
					makeRelease(root, firstInstallVer, goodExecutable(firstInstallVer));
					expect(runInstaller(root, [firstInstallVer]).exitCode).toBe(0);
				}
				const args = isUpdate ? ["--update", installVer] : [installVer];
				const result = runInstaller(root, args);
				expect(result.exitCode, result.stderr).toBe(0);
				const pkgPost = readFileSync(join(dir, "package.json"), "utf8");
				expect(pkgPost).toBe(pkgPre);
				expect(createHash("sha256").update(pkgPost).digest("hex")).toBe(hashPre);
				const link = readlinkSync(join(root, "bin", "prime-agent"));
				expect(spawnSync(link, ["--version"], { encoding: "utf8" }).status).toBe(0);
			},
		);
	});
	describe("collision-path safety", () => {
		// --- atomic wrappers with mkdir sentinels ---
		function createCpWrapper(toolsDir: string, mode: "fail" | "succeed-then-rm"): { cpSentinel: string } {
			const cpSentinel = join(toolsDir, "cp_publication_sentinel");
			const failScript = "exit 1\n";
			const succeedScript =
				'/bin/cp -R "$@"\n' +
				"rc=$?\n" +
				'if [ "$rc" = 0 ]; then\n' +
				'  rm -f "$_last/theme/prime.json"\n' +
				"fi\n" +
				"exit $rc\n";
			const postCopyAction = mode === "fail" ? failScript : succeedScript;
			const script =
				"#!/bin/sh\n" +
				'SENT="' +
				cpSentinel.replace(/'/g, "'''") +
				'"\n' +
				"# Get last positional arg (destination) without eval\n" +
				"for _last do :; done\n" +
				"# Only count publication cp (dest is final or repair path, not .tmp.)\n" +
				'case "$_last" in\n' +
				'  *.tmp.*) exec /bin/cp -R "$@" ;;\n' +
				"  *.repair.*|*/apps/versions/v*) ;;\n" +
				'  *) exec /bin/cp -R "$@" ;;\n' +
				"esac\n" +
				"c=0\n" +
				'while ! mkdir "$SENT/__cp__$((c+1))" 2>/dev/null; do\n' +
				"  c=$((c + 1))\n" +
				'  if [ "$c" -gt 100 ]; then exit 1; fi\n' +
				"done\n" +
				"c=$((c + 1))\n" +
				postCopyAction;
			mkdirSync(cpSentinel, { recursive: true });
			writeFileSync(join(toolsDir, "cp"), script);
			chmodSync(join(toolsDir, "cp"), 0o755);
			return { cpSentinel };
		}
		function createMvWrapper(toolsDir: string, failOn: number): { mvSentinel: string } {
			const mvSentinel = join(toolsDir, "mv_link_sentinel");
			const script =
				"#!/bin/sh\n" +
				'SENT="' +
				mvSentinel.replace(/'/g, "'''") +
				'"\n' +
				"# Only intercept atomic symlink mv where dest is prime-agent\n" +
				"# and source ends prime-agent.tmp.* (skip .install-paths mv).\n" +
				'case "$2" in\n' +
				"  *prime-agent.tmp.*) ;;\n" +
				'  *) exec /bin/mv "$@" ;;\n' +
				"esac\n" +
				"c=0\n" +
				'while ! mkdir "$SENT/__mv__$((c+1))" 2>/dev/null; do\n' +
				"  c=$((c + 1))\n" +
				'  if [ "$c" -gt 100 ]; then exit 1; fi\n' +
				"done\n" +
				"c=$((c + 1))\n" +
				'if [ "$c" -eq ' +
				failOn +
				" ]; then\n" +
				"  exit 1\n" +
				"fi\n" +
				'exec /bin/mv "$@"\n';
			mkdirSync(mvSentinel, { recursive: true });
			writeFileSync(join(toolsDir, "mv"), script);
			chmodSync(join(toolsDir, "mv"), 0o755);
			return { mvSentinel };
		}
		function createReadlinkWrapper(toolsDir: string): { rdlSentinel: string } {
			const rdlSentinel = join(toolsDir, "rdl_public_verification");
			const script =
				"#!/bin/sh\n" +
				'SENT="' +
				rdlSentinel.replace(/'/g, "'''") +
				'"\n' +
				"# Count invocations targeting */bin/prime-agent\n" +
				'case "$1" in\n' +
				"  */bin/prime-agent) ;;\n" +
				'  *) exec /usr/bin/readlink "$@" ;;\n' +
				"esac\n" +
				"c=0\n" +
				'while ! mkdir "$SENT/__rdl__$((c+1))" 2>/dev/null; do\n' +
				"  c=$((c + 1))\n" +
				'  if [ "$c" -gt 100 ]; then exit 1; fi\n' +
				"done\n" +
				"c=$((c + 1))\n" +
				"# On 1st invocation (post-mv verification), return wrong target\n" +
				'if [ "$c" -eq 1 ]; then\n' +
				'  printf "/wrong/target\n"\n' +
				"  exit 0\n" +
				"fi\n" +
				'exec /usr/bin/readlink "$@"\n';
			mkdirSync(rdlSentinel, { recursive: true });
			writeFileSync(join(toolsDir, "readlink"), script);
			chmodSync(join(toolsDir, "readlink"), 0o755);
			return { rdlSentinel };
		}
		// --- pre-existing entity tests ---
		const preExistingEntityCases: readonly (readonly [string, "symlink" | "file", string])[] = [
			["broken symlink at version path", "symlink", "/nonexistent"],
			["regular file at version path", "file", "I am a file, not a directory"],
		];
		test.each(preExistingEntityCases)("pre-existing entity not removed: %s", (_name, beforeType, beforeContent) => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const cp = join(root, "apps", "versions", "v1.2.3");
			mkdirSync(dirname(cp), { recursive: true });
			if (beforeType === "symlink") symlinkSync(beforeContent, cp);
			else writeFileSync(cp, beforeContent);

			const r = runInstaller(root, ["1.2.3"]);
			expect(r.exitCode, r.stderr).toBe(0);
			if (beforeType === "symlink") expect(readlinkSync(cp)).toBe(beforeContent);
			else expect(readFileSync(cp, "utf8")).toBe(beforeContent);
			expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v1.2.3.repair.");
		});

		test("pre-existing repair dir does not block install", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const vd = join(root, "apps", "versions");
			const pr1 = join(vd, "v1.2.3.repair.32767");
			const pr2 = join(vd, "v1.2.3.repair.32767.0");
			mkdirSync(pr1, { recursive: true });
			mkdirSync(pr2, { recursive: true });
			writeFileSync(join(pr1, "stale"), "stale");
			writeFileSync(join(pr2, "stale"), "stale");
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			expect(readFileSync(join(pr1, "stale"), "utf8")).toBe("stale");
			expect(readFileSync(join(pr2, "stale"), "utf8")).toBe("stale");
		});

		test("repair-path symlink preserves exact target", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			installVersionDir(root, "1.2.3", "#!/bin/sh\\nexit 1\\n");
			const vd = join(root, "apps", "versions");
			const wrapper = join(root, "rsw.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'final="$1"\n' +
				'installer="$2"\n' +
				'mkdir -p "$final"\n' +
				'printf "#!/bin/sh\\\\nexit 1\\\\n" > "$final/prime-agent"\n' +
				'chmod +x "$final/prime-agent"\n' +
				'ln -sf /nonexistent "$final.repair.$$"\n' +
				'printf blocker > "$final.repair.$$.1"\n' +
				'exec sh "$installer" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const env = installerEnv(root);
			const r = spawnSync("sh", [wrapper, join(vd, "v1.2.3"), installer], {
				cwd: root,
				env,
				encoding: "utf8",
			});
			expect(r.status, r.stderr).toBe(0);
			// Pre-existing symlink at repair path must retain its target
			if (existsSync(join(vd, "v1.2.3.repair." + r.pid + ".0"))) {
				expect(readFileSync(join(vd, "v1.2.3.repair." + r.pid + ".0"), "utf8")).toBe("blocker");
			}
		});

		test("bounded repair exhaustion fails closed preserving collision bytes", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const vd = join(root, "apps", "versions");
			const wrapper = join(root, "bcw.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'final="$1"\n' +
				'installer="$2"\n' +
				'mkdir -p "$final"\n' +
				'printf "#!/bin/sh\\\\nexit 1\\\\n" > "$final/prime-agent"\n' +
				'chmod +x "$final/prime-agent"\n' +
				'i=0; while [ "$i" -le 100 ]; do\n' +
				'  p="$final.repair.$$"\n' +
				'  [ "$i" -ge 1 ] && p="$p.$i"\n' +
				'  mkdir -p "$p" && printf blocker > "$p/blocker"\n' +
				"  i=$((i+1))\n" +
				"done\n" +
				'exec sh "$installer" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const env = installerEnv(root);
			const r = spawnSync("sh", [wrapper, join(vd, "v1.2.3"), installer], {
				cwd: root,
				env,
				encoding: "utf8",
			});
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain("could not claim directory");
			// All pre-existing dirs still have their content
			for (let i = 0; i <= 100; i++) {
				const d = join(vd, `v1.2.3.repair.${r.pid}` + (i === 0 ? "" : "." + i));
				if (existsSync(join(d, "blocker"))) expect(readFileSync(join(d, "blocker"), "utf8")).toBe("blocker");
			}
		});

		test("healthy-reuse activation failure restores prior symlink", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.0.0", goodExecutable("1.0.0"));
			makeRelease(root, "1.2.3", failExec());
			expect(runInstaller(root, ["1.0.0"]).exitCode).toBe(0);
			const link = join(root, "bin", "prime-agent");
			const oldTarget = readlinkSync(link);
			installVersionDir(root, "1.2.3", failExec());
			const r = runInstaller(root, ["--update", "1.2.3"]);
			expect(r.exitCode).not.toBe(0);
			expect(readlinkSync(link)).toBe(join(realpathSync(dirname(oldTarget)), basename(oldTarget)));
			expect(spawnSync(link, ["--version"], { encoding: "utf8" }).status).toBe(0);
		});

		// --- same-PID staging collision uses installer shell $$ ---
		test("same-PID staging collision preserves prior staging dir", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const vd = join(root, "apps", "versions", "v1.2.3");
			const wrapper = join(root, "spid.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'collision_dir="$1.tmp.$$"\n' +
				'mkdir -p "$collision_dir"\n' +
				'printf "leftover" > "$collision_dir/leftover"\n' +
				'exec sh "$2" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const env = installerEnv(root);
			const result = spawnSync("sh", [wrapper, vd, installer], {
				cwd: root,
				env,
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
			// Pre-existing collision dir must still exist with content
			const collisionDir = join(root, "apps", "versions", `v1.2.3.tmp.${result.pid}`);
			expect(readFileSync(join(collisionDir, "leftover"), "utf8")).toBe("leftover");
			expect(readlinkSync(join(root, "bin", "prime-agent"))).toContain("v1.2.3");
		});

		// --- atomic-link mv failure tests ---
		test("atomic-link failure preserves prior symlink when present", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.0.0", goodExecutable("1.0.0"));
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.0.0"]).exitCode).toBe(0);
			const link = join(root, "bin", "prime-agent");
			const oldTarget = readlinkSync(link);
			const ld = dirname(link);
			const wrapper = join(root, "alf.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'ld="$1"\n' +
				'installer="$2"\n' +
				'i=0; while [ "$i" -le 100 ]; do\n' +
				'  s="$ld/prime-agent.tmp.$$"\n' +
				'  [ "$i" -ge 1 ] && s="$s.$i"\n' +
				'  ln -sf /nonexistent "$s"\n' +
				"  i=$((i+1))\n" +
				"done\n" +
				'exec sh "$installer" "--update" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const r = spawnSync("sh", [wrapper, ld, installer], {
				cwd: root,
				env: installerEnv(root),
				encoding: "utf8",
			});
			expect(r.status).not.toBe(0);
			expect(readlinkSync(link)).toBe(oldTarget);
		});

		test("atomic-link failure with no prior leaves no symlink", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const ld = join(root, "bin");
			mkdirSync(ld, { recursive: true });
			const wrapper = join(root, "alf2.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'ld="$1"\n' +
				'installer="$2"\n' +
				'i=0; while [ "$i" -le 100 ]; do\n' +
				'  s="$ld/prime-agent.tmp.$$"\n' +
				'  [ "$i" -ge 1 ] && s="$s.$i"\n' +
				'  ln -sf /nonexistent "$s"\n' +
				"  i=$((i+1))\n" +
				"done\n" +
				'exec sh "$installer" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const r = spawnSync("sh", [wrapper, ld, installer], {
				cwd: root,
				env: installerEnv(root),
				encoding: "utf8",
			});
			expect(r.status).not.toBe(0);
			expect(() => readlinkSync(join(root, "bin", "prime-agent"))).toThrow();
		});

		test("rollback rejects symlinked version directory", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			const link = join(root, "bin", "prime-agent");
			const oldTarget = readlinkSync(link);
			const ovd = dirname(oldTarget);
			const outside = join(root, "outside-v");
			mkdirSync(outside);
			writeFileSync(join(outside, "prime-agent"), goodExecutable("1.2.3"));
			chmodSync(join(outside, "prime-agent"), 0o755);
			rmSync(ovd, { recursive: true, force: true });
			symlinkSync(outside, ovd, "dir");
			makeRelease(root, "2.0.0", failExec());
			const r = runInstaller(root, ["--update", "2.0.0"]);
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("no healthy rollback version was available");
		});

		test("no staging inside version dir", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-col-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			for (const e of readdirSync(join(root, "apps", "versions", "v1.2.3"))) {
				expect(e).not.toMatch(/\.(tmp|repair)\./);
			}
		});

		// --- write-install-paths mv failure ---
		test("write-install-paths mv failure cleans staging and exits", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-wip-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const wipSentinel = join(toolsDir, "wip_sentinel");
			// mv wrapper that fails only for .install-paths mv
			const script =
				"#!/bin/sh\n" +
				'SENT="' +
				wipSentinel.replace(/'/g, "'''") +
				'"\n' +
				'case "$3" in\n' +
				'  *.install-paths) mkdir -p "$SENT"; exit 1 ;;\n' +
				'  *) exec /bin/mv "$@" ;;\n' +
				"esac\n";
			writeFileSync(join(toolsDir, "mv"), script);
			chmodSync(join(toolsDir, "mv"), 0o755);
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert the .install-paths mv branch was reached
			expect(existsSync(wipSentinel)).toBe(true);
			// Staging and download dirs must be cleaned; no version dir created
			const entries = readdirSync(join(root, "apps", "versions")).filter(
				(e: string) => !e.startsWith(".install-locks"),
			);
			expect(entries).toEqual([]);
		});

		// --- mkdir real-failure (not collision) ---
		test("mkdir real failure cleans staging and does not fall through to repair", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-mkf-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			// Interpose mkdir to fail only for the final version dir path.
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const mkdirSentinel = join(toolsDir, "mkdir_fail_sentinel");
			const script =
				"#!/bin/sh\n" +
				'SENT="' +
				mkdirSentinel.replace(/'/g, "'''") +
				'"\n' +
				'case "$1" in\n' +
				'  */apps/versions/v1.2.3) mkdir -p "$SENT"; exit 1 ;;\n' +
				'  *) exec /bin/mkdir "$@" ;;\n' +
				"esac\n";
			writeFileSync(join(toolsDir, "mkdir"), script);
			chmodSync(join(toolsDir, "mkdir"), 0o755);
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert the mkdir failure branch was reached
			expect(existsSync(mkdirSentinel)).toBe(true);
			// Staging and download cleaned; no version or repair dir persists
			const vd = join(root, "apps", "versions");
			const entries = readdirSync(vd).filter((e: string) => !e.startsWith(".install-locks"));
			expect(entries).toEqual([]);
		});

		// --- cp failure inside repair_copy (publication) ---
		test("copy failure into owned dest cleans only owned dirs", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-cf-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			// Pre-existing file at version path so publish_staging uses repair path
			const vp = join(root, "apps", "versions", "v1.2.3");
			mkdirSync(dirname(vp), { recursive: true });
			writeFileSync(vp, "pre-existing file");
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { cpSentinel } = createCpWrapper(toolsDir, "fail");
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert publication cp branch was reached (cpSentinel has __cp__1)
			expect(existsSync(join(cpSentinel, "__cp__1"))).toBe(true);
			// Pre-existing file preserved (not deleted by cleanup)
			expect(readFileSync(vp, "utf8")).toBe("pre-existing file");
		});

		test("copy failure into fresh claimed destination", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-cf2-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { cpSentinel } = createCpWrapper(toolsDir, "fail");
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert publication cp branch was reached
			expect(existsSync(join(cpSentinel, "__cp__1"))).toBe(true);
			// No v1.2.3 version dir should exist (all cleanup was owned)
			const entries = readdirSync(join(root, "apps", "versions")).filter(
				(e: string) => !e.startsWith(".install-locks"),
			);
			expect(entries).toEqual([]);
		});

		// --- cp succeeds, then post-copy validation fails ---
		test("post-copy validation failure cleans owned destination", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-pcv-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { cpSentinel } = createCpWrapper(toolsDir, "succeed-then-rm");
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert publication cp was reached and the post-copy rm happened
			expect(existsSync(join(cpSentinel, "__cp__1"))).toBe(true);
			// No v1.2.3 version dir should exist
			const entries = readdirSync(join(root, "apps", "versions")).filter(
				(e: string) => !e.startsWith(".install-locks"),
			);
			expect(entries).toEqual([]);
		});

		// --- atomic mv failure after ln -s success ---
		test("atomic mv failure cleans temp symlink", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-amv-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { mvSentinel } = createMvWrapper(toolsDir, 1); // fail first atomic-link mv
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert the atomic-link mv branch was reached
			expect(existsSync(join(mvSentinel, "__mv__1"))).toBe(true);
			// No temp symlink should remain (rm -f in atomic_symlink on mv failure)
			const leftovers = readdirSync(join(root, "bin")).filter((e: string) => e.includes("prime-agent.tmp"));
			expect(leftovers).toEqual([]);
		});

		// --- rollback mv failure (second atomic-link mv fails) ---
		test("rollback atomic symlink mv failure cleans temp symlinks", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-rsf-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			const link = join(root, "bin", "prime-agent");
			const oldTarget = readlinkSync(link);
			// Corrupt the binary so update will need to repair and rollback
			writeFileSync(oldTarget, "#!/bin/sh\nexit 1\n");
			chmodSync(oldTarget, 0o755);
			makeRelease(root, "1.2.3", failExec());
			// Interpose mv: fail second atomic-link mv (first is placement, second is rollback)
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { mvSentinel } = createMvWrapper(toolsDir, 2);
			const r = runInstaller(root, ["--update", "1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert both placement (__mv__1) and rollback (__mv__2) mv calls were reached
			expect(existsSync(join(mvSentinel, "__mv__1"))).toBe(true);
			expect(existsSync(join(mvSentinel, "__mv__2"))).toBe(true);
			// When placement mv succeeds but rollback mv fails, _prime_agent_symlink_placed=1
			// and installer deletes the public symlink (no healthy rollback available)
			expect(existsSync(link)).toBe(false);
			// The original version dir is intact
			expect(existsSync(join(dirname(oldTarget), "package.json"))).toBe(true);
			// No temp symlinks remain
			const leftovers = readdirSync(dirname(link)).filter((e: string) => e.includes("prime-agent.tmp"));
			expect(leftovers).toEqual([]);
		});

		// --- post-mv readlink mismatch preserves public path ---
		test("post-mv readlink mismatch preserves public path", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-rdl-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const toolsDir = join(root, "tools");
			mkdirSync(toolsDir);
			const { rdlSentinel } = createReadlinkWrapper(toolsDir);
			const r = runInstaller(root, ["1.2.3"], { PATH: `${toolsDir}:/usr/bin:/bin` });
			expect(r.exitCode).not.toBe(0);
			// Assert post-mv verification readlink branch was reached
			expect(existsSync(join(rdlSentinel, "__rdl__1"))).toBe(true);
			// mv succeeded so the symlink entry exists; the public path was NOT
			// deleted by the readlink mismatch handler (fail closed).
			// readlinkSync works on dangling symlinks; confirms entry not deleted.
			const linkPath = join(root, "bin", "prime-agent");
			expect(readlinkSync(linkPath)).toContain("v1.2.3/prime-agent");
		});

		// --- malicious healthy repair collision ---
		// Pre-create repair.$$ as a healthy-looking directory that would pass
		// validation. The installer must claim a new path ($.0) and not reuse
		// the pre-existing one. The pre-existing dir must remain exactly intact.
		test("malicious healthy repair collision never reused", () => {
			const root = mkdtempSync(join(tmpdir(), "pi-hrc-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const vd = join(root, "apps", "versions");
			const wrapper = join(root, "hrc.sh");
			const ws =
				"#! /bin/sh\n" +
				"set -eu\n" +
				'final="$1"\n' +
				'installer="$2"\n' +
				'versions="$3"\n' +
				"# Pre-create a file at the version path to force repair path\n" +
				'mkdir -p "$(dirname "$final")"\n' +
				'printf "blocker" > "$final"\n' +
				"# Pre-create repair REPAIR_BASE = $$ -- the exact PID name that\n" +
				"# publish_staging passes to claim_path.  This ensures the first\n" +
				"# candidate claim_path tries ($final.repair.$$) already exists\n" +
				"# and is a HEALTHY real directory.  The installer must NOT reuse\n" +
				"# this pre-existing dir; it must claim the next counter ($.0).\n" +
				'rp="$versions/v1.2.3.repair.$$"\n' +
				'mkdir -p "$rp"\n' +
				"# Populate with genuinely healthy content that would pass validation\n" +
				'printf "#!/bin/sh\\nprintf fake-v > /dev/null\\n" > "$rp/prime-agent"\n' +
				'chmod +x "$rp/prime-agent"\n' +
				'mkdir -p "$rp/theme"\n' +
				'printf "{}" > "$rp/theme/prime.json"\n' +
				'printf "{}" > "$rp/theme/dark.json"\n' +
				'printf "{}" > "$rp/theme/light.json"\n' +
				'printf "{}" > "$rp/theme/theme-schema.json"\n' +
				'printf "pkg" > "$rp/package.json"\n' +
				'printf "readme" > "$rp/README.md"\n' +
				'printf "changelog" > "$rp/CHANGELOG.md"\n' +
				'printf "fake atop" > "$rp/install.sh"\n' +
				'printf ".wasm" > "$rp/photon_rs_bg.wasm"\n' +
				'mkdir -p "$rp/prime-agent-runtime"\n' +
				'printf "toml" > "$rp/prime-agent-runtime/pyproject.toml"\n' +
				'mkdir -p "$rp/export-html"\n' +
				'printf "html" > "$rp/export-html/template.html"\n' +
				'printf "css" > "$rp/export-html/template.css"\n' +
				'printf "js" > "$rp/export-html/template.js"\n' +
				'mkdir -p "$rp/export-html/vendor"\n' +
				'printf "v" > "$rp/export-html/vendor/.keep"\n' +
				'mkdir -p "$rp/skills"\n' +
				'printf "s" > "$rp/skills/.keep"\n' +
				'mkdir -p "$rp/assets"\n' +
				'printf "a" > "$rp/assets/.keep"\n' +
				'mkdir -p "$rp/docs"\n' +
				'printf "d" > "$rp/docs/.keep"\n' +
				'mkdir -p "$rp/examples"\n' +
				'printf "e" > "$rp/examples/.keep"\n' +
				'exec sh "$installer" "1.2.3"\n';
			writeFileSync(wrapper, ws);
			chmodSync(wrapper, 0o755);
			const env = installerEnv(root);
			const r = spawnSync("sh", [wrapper, join(vd, "v1.2.3"), installer, vd], {
				cwd: root,
				env,
				encoding: "utf8",
			});
			expect(r.status, r.stderr).toBe(0);
			// Pre-existing repair dir at $$ base must still be intact
			const repairDir = join(vd, `v1.2.3.repair.${r.pid}`);
			expect(readFileSync(join(repairDir, "README.md"), "utf8")).toBe("readme");
			// The installed link must NOT point to the pre-existing repair dir
			const installedLink = readlinkSync(join(root, "bin", "prime-agent"));
			expect(installedLink).toContain("v1.2.3");
			expect(readFileSync(join(dirname(installedLink), "README.md"), "utf8")).not.toBe("readme");
		});
	});

	describe("installer interruption and metadata refresh", () => {
		test("removes a claimed destination when publication is interrupted", () => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-interrupt-copy-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const tools = join(root, "tools");
			const marker = join(root, "copy-interrupted");
			mkdirSync(tools);
			writeFileSync(
				join(tools, "cp"),
				[
					"#!/bin/sh",
					"for _last do :; done",
					'case "$_last" in',
					"  */apps/versions/v1.2.3|*/apps/versions/v1.2.3/)",
					'    mkdir "$INTERRUPT_MARKER"',
					'    printf partial > "$_last/partial"',
					'    kill -TERM "$PPID"',
					"    exit 1",
					"    ;;",
					'  *) exec /bin/cp "$@" ;;',
					"esac",
				].join("\n"),
			);
			chmodSync(join(tools, "cp"), 0o755);

			const result = runInstaller(root, ["1.2.3"], {
				INTERRUPT_MARKER: marker,
				PATH: `${tools}:/usr/bin:/bin`,
			});
			expect(result.exitCode).not.toBe(0);
			expect(existsSync(marker)).toBe(true);
			const entries = readdirSync(join(root, "apps", "versions")).filter((entry) => entry !== ".install-locks");
			expect(entries).toEqual([]);
		});

		test("keeps the activated version when download cleanup is interrupted", () => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-interrupt-cleanup-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			const tools = join(root, "tools");
			const marker = join(root, "cleanup-interrupted");
			mkdirSync(tools);
			writeFileSync(
				join(tools, "rm"),
				[
					"#!/bin/sh",
					"for _arg do",
					'  case "$_arg" in',
					"    */prime-agent-install.*)",
					'      if mkdir "$INTERRUPT_MARKER" 2>/dev/null; then',
					'        /bin/rm "$@"',
					'        kill -TERM "$PPID"',
					"        exit 0",
					"      fi",
					"      ;;",
					"  esac",
					"done",
					'exec /bin/rm "$@"',
				].join("\n"),
			);
			chmodSync(join(tools, "rm"), 0o755);

			const result = runInstaller(root, ["1.2.3"], {
				INTERRUPT_MARKER: marker,
				PATH: `${tools}:/usr/bin:/bin`,
			});
			expect(result.exitCode).not.toBe(0);
			expect(existsSync(marker)).toBe(true);
			const command = join(root, "bin", "prime-agent");
			const target = readlinkSync(command);
			expect(existsSync(target)).toBe(true);
			expect(spawnSync(command, ["--version"], { encoding: "utf8" }).status).toBe(0);
		});

		test("refreshes install metadata when a healthy version is reused", () => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-refresh-paths-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			const customBin = join(root, "custom-bin");

			const result = runInstaller(root, ["1.2.3"], { PRIME_AGENT_BIN_DIR: customBin });
			expect(result.exitCode, result.stderr).toBe(0);
			const versionDir = join(realpathSync(root), "apps", "versions", "v1.2.3");
			const paths = readFileSync(join(versionDir, ".install-paths"), "utf8").trim().split("\n");
			expect(paths).toEqual([
				join(realpathSync(root), "apps", "versions"),
				join(realpathSync(customBin), "prime-agent"),
				"prime-agent",
			]);
			expect(readlinkSync(join(customBin, "prime-agent"))).toBe(join(versionDir, "prime-agent"));
		});

		test.each(["directory", "symlink"] as const)("rejects an unsafe %s at the install metadata path", (kind) => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-unsafe-metadata-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			const versionDir = join(realpathSync(root), "apps", "versions", "v1.2.3");
			const statePath = join(versionDir, ".install-paths");
			const outside = join(root, "outside-metadata");
			rmSync(statePath);
			if (kind === "directory") {
				mkdirSync(statePath);
				writeFileSync(join(statePath, "sentinel"), "directory");
			} else {
				writeFileSync(outside, "outside");
				symlinkSync(outside, statePath);
			}
			const customBin = join(root, "custom-bin");

			const result = runInstaller(root, ["1.2.3"], { PRIME_AGENT_BIN_DIR: customBin });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("install metadata path is not a regular file");
			expect(existsSync(join(customBin, "prime-agent"))).toBe(false);
			if (kind === "directory") {
				expect(readFileSync(join(statePath, "sentinel"), "utf8")).toBe("directory");
			} else {
				expect(readlinkSync(statePath)).toBe(outside);
				expect(readFileSync(outside, "utf8")).toBe("outside");
			}
		});

		test("does not follow a colliding install metadata temp symlink", () => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-metadata-collision-"));
			temporaryRoots.push(root);
			makeRelease(root, "1.2.3", goodExecutable("1.2.3"));
			expect(runInstaller(root, ["1.2.3"]).exitCode).toBe(0);
			const versionDir = join(realpathSync(root), "apps", "versions", "v1.2.3");
			const outside = join(root, "outside");
			const wrapper = join(root, "collision.sh");
			const customBin = join(root, "custom-bin");
			mkdirSync(outside);
			writeFileSync(join(outside, "sentinel"), "outside");
			writeFileSync(
				wrapper,
				["#!/bin/sh", "set -eu", 'ln -s "$3" "$1/.install-paths.tmpdir.$$"', 'exec sh "$2" 1.2.3'].join("\n"),
			);
			chmodSync(wrapper, 0o755);

			const result = spawnSync("sh", [wrapper, versionDir, installer, outside], {
				cwd: root,
				env: installerEnv(root, { PRIME_AGENT_BIN_DIR: customBin }),
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(typeof result.pid).toBe("number");
			const collision = join(versionDir, `.install-paths.tmpdir.${result.pid}`);
			expect(readlinkSync(collision)).toBe(outside);
			expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside");
			expect(readlinkSync(join(customBin, "prime-agent"))).toBe(join(versionDir, "prime-agent"));
		});

		test("honors an immediate install lock timeout override", () => {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-lock-timeout-"));
			temporaryRoots.push(root);
			const lockRoot = join(root, "apps", "versions", ".install-locks");
			mkdirSync(join(lockRoot, `1-${process.pid}`), { recursive: true });

			const result = runInstaller(root, ["1.2.3"], {
				PRIME_AGENT_INSTALL_LOCK_TIMEOUT_SECONDS: "0",
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("timed out waiting for another Prime Agent install or update");
		});
	});
});
