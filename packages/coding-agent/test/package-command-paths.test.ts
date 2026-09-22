import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ENV_AGENT_DIR,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../src/config.js";
import { main } from "../src/main.js";
import { handlePackageCommand } from "../src/package-manager-cli.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function runSelfUpdateInstallChild(args: string[]): Promise<void> {
	const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
	try {
		await main(args);
	} finally {
		restoreEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, previousValue);
	}
}

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalPrimeAgentDownloadBaseUrl: string | undefined;
	let originalTmpDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
		originalTmpDir = process.env.TMPDIR;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.TMPDIR = tempDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv("PI_PACKAGE_DIR", originalPiPackageDir);
		restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
		restoreEnv("TMPDIR", originalTmpDir);
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["package", "install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["package", "install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["package", "remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("rejects combining --nightly and --stable", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--nightly", "--stable"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("--nightly and --stable cannot be combined");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("refuses to switch to the nightly channel without a TTY or --force and changes nothing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--nightly"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Switching to the nightly channel needs confirmation");
			expect(process.exitCode).toBe(1);
			const settingsPath = join(agentDir, "settings.json");
			if (existsSync(settingsPath)) {
				expect(JSON.parse(readFileSync(settingsPath, "utf8")).updateChannel).toBeUndefined();
			}
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("keeps a successful extension update when the nightly manifest is missing for an all target", async () => {
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "https://downloads.example.test/prime-agent";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--nightly", "--force"])).resolves.toBe(true);

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Updated packages");
			expect(stderr).toContain("Could not resolve a nightly release");
			expect(stderr).toContain("was not updated and the update channel was not changed");
			expect(process.exitCode).toBeUndefined();
			const settingsPath = join(agentDir, "settings.json");
			if (existsSync(settingsPath)) {
				expect(JSON.parse(readFileSync(settingsPath, "utf-8")).updateChannel).toBeUndefined();
			}
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects --nightly for extension-only updates instead of silently ignoring it", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--extensions", "--nightly"])).resolves.toBe(true);

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("--nightly and --stable only apply to Prime Agent itself");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	interface SelfUpdateFixtureOptions {
		/** Scope the running CLI is installed under; drives the rename/alias paths. */
		scope?: string;
		/** Body the update manifest fetch returns. */
		manifest: Record<string, unknown>;
		downloadBaseUrl?: string;
		/** Also write a project-scoped npmCommand, to prove the global one wins. */
		projectNpmCommand?: boolean;
		/** Make the fake npm fail `install`, like a broken registry package. */
		failInstall?: boolean;
	}

	/**
	 * Self-update shares one fixture: a fake npm that records every invocation, an
	 * installed-package directory for the running CLI, and a stubbed update manifest.
	 * Installing the wrong package or prefix is the footgun these cases guard.
	 */
	function setupSelfUpdate(options: SelfUpdateFixtureOptions) {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(
			globalPrefix,
			"lib",
			"node_modules",
			options.scope ?? "@earendil-works",
			"pi-coding-agent",
		);
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
${options.failInstall ? 'if(args.includes("install")) process.exit(23);' : ""}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		if (options.projectNpmCommand) {
			mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
			);
		}
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		if (options.downloadBaseUrl) process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = options.downloadBaseUrl;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json(options.manifest));
		vi.stubGlobal("fetch", fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		return {
			globalPrefix,
			projectPrefix,
			fetchMock,
			errorSpy,
			stdout: () => logSpy.mock.calls.map(([message]) => String(message)).join("\n"),
			stderr: () => errorSpy.mock.calls.map(([message]) => String(message)).join("\n"),
			/** Every argv the fake npm saw, in order. */
			npmCalls: () => JSON.parse(readFileSync(recordPath, "utf-8")) as string[][],
			ranNpm: () => existsSync(recordPath),
		};
	}

	it("uses global npmCommand and the release manifest install spec for forced self updates", async () => {
		const tarballUrl = "https://downloads.example.test/prime-agent/prime-agent-current.tgz";
		const fixture = setupSelfUpdate({
			manifest: { tarball: tarballUrl, version: VERSION },
			projectNpmCommand: true,
		});

		await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();

		expect(process.exitCode).toBeUndefined();
		expect(fixture.errorSpy).not.toHaveBeenCalled();
		expect(fixture.fetchMock).toHaveBeenCalledOnce();
		const recordedArgs = fixture.npmCalls().flat();
		expect(recordedArgs).toContain(fixture.globalPrefix);
		expect(recordedArgs).toContain(tarballUrl);
		expect(recordedArgs).not.toContain(fixture.projectPrefix);
	});

	it("refuses a self update when the configured download origin is invalid instead of falling back", async () => {
		const fixture = setupSelfUpdate({
			downloadBaseUrl: "http://mirror.example/prime-agent",
			manifest: { tarball: "https://downloads.example.test/prime-agent/prime-agent-current.tgz", version: VERSION },
		});

		await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();

		expect(fixture.stderr()).toMatch(/PRIME_AGENT_DOWNLOAD_BASE_URL must use https/);
		expect(process.exitCode).toBe(1);
		// The registry fallback never ran: nothing was fetched, npm was never invoked.
		expect(fixture.fetchMock).not.toHaveBeenCalled();
		expect(fixture.ranNpm()).toBe(false);
	});

	it("uses the current package name when the update check omits packageName", async () => {
		const fixture = setupSelfUpdate({ scope: "@mariozechner", manifest: { version: getNewerPatchVersion() } });

		await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

		expect(process.exitCode).toBeUndefined();
		expect(fixture.errorSpy).not.toHaveBeenCalled();
		expect(fixture.fetchMock).toHaveBeenCalledOnce();
		expect(fixture.npmCalls().flat()).toContain(PACKAGE_NAME);
	});

	it("installs the active package name from the update check during self-update", async () => {
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		const fixture = setupSelfUpdate({
			scope: "@mariozechner",
			manifest: { packageName: activePackageName, version: "0.73.0" },
		});

		await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

		expect(process.exitCode).toBeUndefined();
		expect(fixture.errorSpy).not.toHaveBeenCalled();
		expect(fixture.npmCalls()).toEqual([
			expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
			expect.arrayContaining(["install", "-g", activePackageName]),
		]);
	});

	it("installs the Prime Agent tarball from the update manifest during self-update", async () => {
		const baseUrl = "https://downloads.example.test/prime-agent";
		const tarballPath = "releases/v0.73.0/prime-agent-0.73.0.tgz";
		const fixture = setupSelfUpdate({
			manifest: { package: "prime-agent", tarball: tarballPath, version: "0.73.0" },
			downloadBaseUrl: baseUrl,
		});

		await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

		expect(process.exitCode).toBeUndefined();
		expect(fixture.errorSpy).not.toHaveBeenCalled();
		expect(fixture.npmCalls()).toEqual([
			expect.arrayContaining(["install", "-g", `${baseUrl}/${tarballPath}`]),
			expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
		]);
	});

	it("treats a channel that is behind the installed version as nothing to update", async () => {
		const fixture = setupSelfUpdate({
			manifest: { package: "prime-agent", tarball: "releases/v0.0.1/prime-agent-0.0.1.tgz", version: "0.0.1" },
			downloadBaseUrl: "https://downloads.example.test/prime-agent",
		});

		await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

		expect(fixture.stdout()).toContain("is ahead of the stable channel");
		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
		expect(fixture.ranNpm()).toBe(false);
	});

	it("refuses a downgrade even with --nightly --force and leaves the channel unchanged", async () => {
		const fixture = setupSelfUpdate({
			manifest: {
				package: "prime-agent",
				tarball: "releases/v0.0.1-beta.1.1.abcdef0/prime-agent-0.0.1-beta.1.1.abcdef0.tgz",
				version: "0.0.1-beta.1.1.abcdef0",
			},
			downloadBaseUrl: "https://downloads.example.test/prime-agent",
		});

		await expect(runSelfUpdateInstallChild(["update", "--self", "--nightly", "--force"])).resolves.toBeUndefined();

		expect(fixture.stderr()).toContain("that is a downgrade");
		expect(fixture.ranNpm()).toBe(false);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).updateChannel).toBeUndefined();
	});

	it("does not self-update when the same-version manifest uses the Prime Agent package alias", async () => {
		const fixture = setupSelfUpdate({
			manifest: { package: "prime-agent", tarball: "releases/current/prime-agent.tgz", version: VERSION },
			downloadBaseUrl: "https://downloads.example.test/prime-agent",
		});

		await expect(main(["update"])).resolves.toBeUndefined();

		expect(process.exitCode).toBeUndefined();
		expect(fixture.errorSpy).not.toHaveBeenCalled();
		expect(fixture.stdout()).toContain("is already up to date");
		expect(fixture.ranNpm()).toBe(false);
	});

	it("fails self-update when renamed npm package installation fails", async () => {
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		const fixture = setupSelfUpdate({
			scope: "@mariozechner",
			manifest: { packageName: activePackageName, version: "0.73.0" },
			failInstall: true,
		});

		await expect(main(["update"])).resolves.toBeUndefined();

		expect(process.exitCode).toBe(1);
		expect(fixture.stdout()).not.toContain("Updated pi");
		expect(fixture.stderr()).toContain("exited with code 23");
		expect(fixture.npmCalls()).toEqual([
			expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
			expect.arrayContaining(["install", "-g", activePackageName]),
		]);
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
