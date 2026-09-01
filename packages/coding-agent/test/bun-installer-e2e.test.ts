import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = join(dirname(fileURLToPath(import.meta.url)), "../../../install.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRelease(root: string, version: string, executable: string, checksumIsValid = true): void {
	const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const releaseDir = join(root, "server", "releases", `v${version}`);
	const stage = join(root, `stage-${version}`);
	mkdirSync(releaseDir, { recursive: true });
	mkdirSync(stage, { recursive: true });
	writeFileSync(join(stage, "prime-agent"), executable);
	chmodSync(join(stage, "prime-agent"), 0o755);
	writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "prime-agent", version }));
	writeFileSync(join(stage, "install.sh"), "#!/bin/sh\n");
	const archiveName = `prime-agent-${version}-${platform}.tar.gz`;
	const archive = join(releaseDir, archiveName);
	const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
	if (packed.status !== 0) throw new Error(packed.stderr || "tar failed");
	const checksum = checksumIsValid ? createHash("sha256").update(readFileSync(archive)).digest("hex") : "0".repeat(64);
	writeFileSync(join(releaseDir, "SHA256SUMS"), `${checksum}  ${archiveName}\n`);
}

function runInstaller(root: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const home = join(root, "home");
	const versions = join(root, "apps", "versions");
	const bin = join(root, "bin");
	mkdirSync(join(home, ".prime"), { recursive: true });
	writeFileSync(join(home, ".prime", "sentinel"), "user data");
	const result = spawnSync("sh", [installer, ...args], {
		env: {
			...process.env,
			HOME: home,
			PRIME_AGENT_DOWNLOAD_BASE_URL: `file://${join(root, "server")}`,
			PRIME_AGENT_VERSIONS_DIR: versions,
			PRIME_AGENT_BIN_DIR: bin,
			TERM: "dumb",
		},
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
		const target = join(root, "apps", "versions", "v1.2.3", "prime-agent");
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
		expect(readFileSync(join(root, "apps", "versions", "v1.2.3", "package.json"), "utf8")).toContain('"1.2.3"');
		expect(readFileSync(join(root, "home", ".prime", "sentinel"), "utf8")).toBe("user data");

		const secondInstall = runInstaller(root, ["1.2.3"]);
		expect(secondInstall.exitCode, secondInstall.stderr).toBe(0);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	test("rejects a bad checksum before changing the active version", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-installer-"));
		temporaryRoots.push(root);
		makeRelease(root, "1.2.3", goodExecutable("1.2.3"), false);

		const result = runInstaller(root, ["1.2.3"]);
		expect(result.exitCode).not.toBe(0);
		expect(() => readlinkSync(join(root, "bin", "prime-agent"))).toThrow();
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
});
