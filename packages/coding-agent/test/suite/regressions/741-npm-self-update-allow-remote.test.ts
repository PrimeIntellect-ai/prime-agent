import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getSelfUpdateCommand } from "../../../src/config.js";

const TARBALL_URL = "https://downloads.example.test/releases/v0.7.2/prime-agent-0.7.2.tgz";
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
let tempDir: string | undefined;

// Fake a global npm install under a custom prefix so self-update resolves to npm.
function createNpmPrefixInstall(): string {
	const prefix = mkdtempSync(join(tmpdir(), "pi-741-"));
	const packageDir = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	Object.defineProperty(process, "execPath", { value: join(packageDir, "dist", "cli.js"), configurable: true });
	return prefix;
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("issue #741: npm 12 refuses the self-update release tarball", () => {
	it("grants allow-remote to the install step when updating from a release artifact", () => {
		const prefix = createNpmPrefixInstall();

		const command = getSelfUpdateCommand(PACKAGE_NAME, undefined, TARBALL_URL);

		expect(command?.env).toEqual({ npm_config_allow_remote: "all" });
		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", TARBALL_URL]);
		expect(command?.display).toBe(`npm_config_allow_remote=all npm --prefix ${prefix} install -g ${TARBALL_URL}`);
	});

	it("keeps registry updates on the npm 12 default", () => {
		createNpmPrefixInstall();

		const command = getSelfUpdateCommand(PACKAGE_NAME);

		expect(command?.env).toBeUndefined();
		expect(command?.display).not.toContain("allow_remote");
	});

	it("grants allow-remote to the install step only, not the follow-up uninstall", () => {
		createNpmPrefixInstall();

		const command = getSelfUpdateCommand(PACKAGE_NAME, undefined, TARBALL_URL, "prime-agent");

		expect(command?.steps?.map((step) => step.env)).toEqual([{ npm_config_allow_remote: "all" }, undefined]);
	});

	it("grants allow-remote to local artifacts too, whose transitive dependencies are remote", () => {
		createNpmPrefixInstall();

		const command = getSelfUpdateCommand(PACKAGE_NAME, undefined, "file:/tmp/prime-agent-0.7.2.tgz");

		expect(command?.env).toEqual({ npm_config_allow_remote: "all" });
	});
});
