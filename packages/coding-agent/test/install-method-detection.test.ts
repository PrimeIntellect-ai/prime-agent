import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getNativeUpdatePlan } from "../src/cli/native-update.js";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	isHomebrewManagedPath,
	resolveExecutablePath,
} from "../src/config.js";
import { NATIVE_RELEASE_ASSETS } from "../src/utils/native-installation.js";

/**
 * Install-source detection for COMPILED copies.
 *
 * Homebrew now ships the compiled binary through our own tap formula, and npm ships it through
 * per-platform packages. Both put a `bun --compile` executable somewhere that a package manager
 * owns, so "this is a compiled binary" can no longer imply "the self-updater owns it".
 */

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", { value, configurable: true });
}

afterEach(() => {
	if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
	if (originalPiPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

/** A formula-installed keg: the compiled binary lives in `<keg>/bin`, linked from `<prefix>/bin`. */
function createHomebrewBinaryInstall(): { keg: string; executable: string; link: string } {
	const prefix = mkdtempSync(join(tmpdir(), "pi-brew-binary-"));
	tempDir = prefix;
	const keg = join(prefix, "Cellar", "prime-agent", "0.9.5");
	const binDir = join(keg, "bin");
	mkdirSync(binDir, { recursive: true });
	// brew writes an INSTALL_RECEIPT.json into every keg; it is what marks a Cellar as Homebrew's.
	writeFileSync(join(keg, "INSTALL_RECEIPT.json"), "{}\n");
	const executable = join(binDir, "prime-agent");
	writeFileSync(executable, "#!/bin/sh\n");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	const link = join(prefix, "bin", "prime-agent");
	symlinkSync(executable, link);
	process.env.PI_PACKAGE_DIR = binDir;
	setExecPath(executable);
	return { keg, executable, link };
}

/**
 * The dangerous shape: a keg whose contents are ALSO a valid self-updater installation (the same
 * layout install.sh produces), reached only through the `<prefix>/bin` symlink. Judged by the
 * invoked path alone it is installer-owned; judged by what the path resolves to it is Homebrew's.
 */
function createInstallerShapedHomebrewKeg(): { keg: string; link: string; target: string } {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "pi-brew-managed-")));
	tempDir = prefix;
	const keg = join(prefix, "Cellar", "prime-agent", "1.2.3");
	const checksum = "a".repeat(64);
	const releaseName = `1.2.3-linux-x64-${checksum}`;
	const releaseDir = join(keg, "releases", releaseName);
	mkdirSync(releaseDir, { recursive: true });
	mkdirSync(join(keg, "bin"));
	writeFileSync(join(keg, "INSTALL_RECEIPT.json"), "{}\n");
	writeFileSync(join(keg, ".managed"), "prime-agent-native-v1\n");
	for (const asset of NATIVE_RELEASE_ASSETS) {
		mkdirSync(dirname(join(releaseDir, asset)), { recursive: true });
		writeFileSync(join(releaseDir, asset), "fixture\n");
	}
	writeFileSync(join(releaseDir, ".archive-sha256"), checksum);
	writeFileSync(join(releaseDir, ".install-source"), "https://releases.example");
	writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
	writeFileSync(join(releaseDir, "prime-agent"), "#!/bin/sh\n", { mode: 0o755 });
	const target = `../releases/${releaseName}/prime-agent`;
	symlinkSync(target, join(keg, "bin", "prime-agent"));
	mkdirSync(join(prefix, "bin"), { recursive: true });
	const link = join(prefix, "bin", "prime-agent");
	symlinkSync(join(keg, "bin", "prime-agent"), link);
	return { keg, link, target };
}

/** An npm per-platform package: the same compiled binary, under a global node_modules tree. */
function createNpmBinaryInstall(): { executable: string } {
	const prefix = mkdtempSync(join(tmpdir(), "pi-npm-binary-"));
	tempDir = prefix;
	const packageDir = join(prefix, "lib", "node_modules", "@primeintellect", "prime-agent-darwin-arm64");
	const binDir = join(packageDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const executable = join(binDir, "prime-agent");
	writeFileSync(executable, "#!/bin/sh\n");
	process.env.PI_PACKAGE_DIR = binDir;
	setExecPath(executable);
	return { executable };
}

describe("isHomebrewManagedPath", () => {
	test("matches a keg under any default Homebrew prefix, whatever the layout inside it", () => {
		expect(isHomebrewManagedPath("/opt/homebrew/Cellar/prime-agent/0.9.5/bin/prime-agent")).toBe(true);
		expect(isHomebrewManagedPath("/usr/local/Cellar/prime-agent/0.9.5/bin/prime-agent")).toBe(true);
		expect(
			isHomebrewManagedPath(
				"/home/linuxbrew/.linuxbrew/Cellar/prime-agent/0.9.5/libexec/lib/node_modules/prime-agent",
			),
		).toBe(true);
		// Homebrew does not exist on Windows; a Cellar-shaped path there is somebody else's directory.
		expect(isHomebrewManagedPath("C:\\brew\\Cellar\\prime-agent\\0.9.5\\bin")).toBe(false);
	});

	test("does not match paths that merely contain the word cellar", () => {
		expect(isHomebrewManagedPath("/Users/kevin/wine-cellar/prime-agent")).toBe(false);
		expect(isHomebrewManagedPath("/Users/kevin/.local/share/prime-agent/releases/0.9.5/prime-agent")).toBe(false);
	});

	test("a user directory named Cellar is not Homebrew unless brew left its receipt there", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-not-brew-"));
		tempDir = home;
		const keg = join(home, "Cellar", "project", "1.0");
		mkdirSync(join(keg, "bin"), { recursive: true });
		const executable = join(keg, "bin", "prime-agent");
		writeFileSync(executable, "#!/bin/sh\n");
		expect(isHomebrewManagedPath(executable)).toBe(false);

		writeFileSync(join(keg, "INSTALL_RECEIPT.json"), "{}\n");
		expect(isHomebrewManagedPath(executable)).toBe(true);
	});

	test("HOMEBREW_PREFIX and HOMEBREW_CELLAR make a non-default prefix count without a receipt", () => {
		const previousPrefix = process.env.HOMEBREW_PREFIX;
		const previousCellar = process.env.HOMEBREW_CELLAR;
		try {
			process.env.HOMEBREW_PREFIX = "/srv/brew";
			delete process.env.HOMEBREW_CELLAR;
			expect(isHomebrewManagedPath("/srv/brew/Cellar/prime-agent/0.9.5/bin/prime-agent")).toBe(true);
			expect(isHomebrewManagedPath("/srv/other/Cellar/prime-agent/0.9.5/bin/prime-agent")).toBe(false);
			delete process.env.HOMEBREW_PREFIX;
			process.env.HOMEBREW_CELLAR = "/srv/other/Cellar";
			expect(isHomebrewManagedPath("/srv/other/Cellar/prime-agent/0.9.5/bin/prime-agent")).toBe(true);
		} finally {
			if (previousPrefix === undefined) delete process.env.HOMEBREW_PREFIX;
			else process.env.HOMEBREW_PREFIX = previousPrefix;
			if (previousCellar === undefined) delete process.env.HOMEBREW_CELLAR;
			else process.env.HOMEBREW_CELLAR = previousCellar;
		}
	});
});

describe("detectInstallMethod for compiled copies", () => {
	test("a brew-installed compiled binary is Homebrew's, not the self-updater's", () => {
		createHomebrewBinaryInstall();

		expect(detectInstallMethod()).toBe("homebrew");
		expect(getSelfUpdateCommand("prime-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("prime-agent")).toBe("Update with: brew upgrade prime-agent");
		expect(getUpdateInstruction("prime-agent")).toBe("Update with: brew upgrade prime-agent");
	});

	test("a brew copy invoked through the prefix symlink is still detected", () => {
		const { link } = createHomebrewBinaryInstall();
		// PI_PACKAGE_DIR unset and execPath is `<prefix>/bin/prime-agent`, which is not keg-shaped.
		// Only resolving the symlink reveals the keg, so detection must do that.
		delete process.env.PI_PACKAGE_DIR;
		setExecPath(link);

		expect(isHomebrewManagedPath(link)).toBe(false);
		expect(detectInstallMethod()).toBe("homebrew");
		expect(getUpdateInstruction("prime-agent")).toBe("Update with: brew upgrade prime-agent");
	});

	test("the self-updater refuses to rewrite a Homebrew keg", async () => {
		const { executable } = createHomebrewBinaryInstall();

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			"managed by Homebrew. Update it with: brew upgrade prime-agent",
		);
	});

	test("resolveExecutablePath follows the prefix symlink into the keg and tolerates unresolvable paths", () => {
		const { link, executable } = createHomebrewBinaryInstall();

		expect(resolveExecutablePath(link)).toBe(realpathSync(executable));
		expect(resolveExecutablePath("/nonexistent/prime-agent")).toBe("/nonexistent/prime-agent");
		expect(resolveExecutablePath("")).toBe("");
	});

	test("the self-updater refuses a brew keg reached through the <prefix>/bin symlink, even an installer-shaped one", async () => {
		const { keg, link, target } = createInstallerShapedHomebrewKeg();
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			// The invoked path is not keg-shaped; only its resolution is.
			expect(isHomebrewManagedPath(link)).toBe(false);
			expect(isHomebrewManagedPath(resolveExecutablePath(link))).toBe(true);

			for (const rollback of [false, true]) {
				await expect(getNativeUpdatePlan({ force: true, rollback, executable: link })).rejects.toThrow(
					"managed by Homebrew. Update it with: brew upgrade prime-agent",
				);
			}
			// Nothing was planned, fetched or rewritten.
			expect(fetchMock).not.toHaveBeenCalled();
			expect(readlinkSync(join(keg, "bin", "prime-agent"))).toBe(target);

			// The same keg reported through process.execPath is Homebrew's for the instruction text too.
			delete process.env.PI_PACKAGE_DIR;
			setExecPath(link);
			expect(detectInstallMethod()).toBe("homebrew");
			expect(getUpdateInstruction("prime-agent")).toBe("Update with: brew upgrade prime-agent");
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	test("update planning consults the install method before choosing the native self-updater", () => {
		// `isBunBinary` is fixed at module load from import.meta.url, so the branch cannot be driven
		// from a unit test. Pin the structure instead: the native plan is reachable only when the
		// classified method is the loose compiled binary, and a package-manager copy takes the
		// registry path where `getSelfUpdateCommand` yields that manager's command.
		const source = readFileSync(join(__dirname, "../src/package-manager-cli.ts"), "utf8");
		const plan = source.slice(
			source.indexOf("async function getSelfUpdatePlan"),
			source.indexOf("async function runSelfUpdate("),
		);
		expect(plan).toMatch(/const installMethod = detectInstallMethod\(\);/);
		expect(plan).toMatch(/if \(isBunBinary && installMethod === "bun-binary"\)/);
		expect(plan.indexOf("detectInstallMethod()")).toBeLessThan(plan.indexOf("getNativeUpdatePlan("));
		// A compiled copy that a package manager owns gets that manager's command from the registry path.
		createNpmBinaryInstall();
		expect(detectInstallMethod()).toBe("npm");
		expect(getSelfUpdateCommand("prime-agent")?.display ?? getUpdateInstruction("prime-agent")).toMatch(
			/npm install -g prime-agent/,
		);
	});

	test("an npm-installed compiled binary reports npm and gets an npm instruction", () => {
		createNpmBinaryInstall();

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("prime-agent")).toBe("Run: npm install -g prime-agent");
	});
});
