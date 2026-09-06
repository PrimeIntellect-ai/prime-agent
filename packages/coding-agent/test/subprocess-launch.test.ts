import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliSubprocessLaunchSpec, resolveInstalledBinaryLauncher } from "../src/cli/subprocess-launch.js";

const temporaryRoots: string[] = [];

function installedFixture(): { oldBinary: string; activeBinary: string; launcher: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-launcher-"));
	temporaryRoots.push(root);
	const versions = join(root, "versions");
	const oldDir = join(versions, "v1.0.0");
	const activeDir = join(versions, "v1.1.0");
	const binDir = join(root, "bin");
	mkdirSync(oldDir, { recursive: true });
	mkdirSync(activeDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	const oldBinary = join(oldDir, "pi");
	const activeBinary = join(activeDir, "pi");
	for (const binary of [oldBinary, activeBinary]) {
		writeFileSync(binary, "#!/bin/sh\nexit 0\n");
		chmodSync(binary, 0o755);
	}
	const launcher = join(binDir, "prime-agent");
	symlinkSync(activeBinary, launcher);
	writeFileSync(join(oldDir, ".install-paths"), `${versions}\n${launcher}\nprime-agent\n`);
	return { oldBinary, activeBinary, launcher };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compiled CLI subprocess launch", () => {
	test("uses the active public launcher from old-version install metadata", () => {
		const fixture = installedFixture();
		expect(resolveInstalledBinaryLauncher(fixture.oldBinary)).toBe(fixture.launcher);
		expect(createCliSubprocessLaunchSpec(["update"], fixture.oldBinary, [], "/$bunfs/root/pi", {}, true)).toEqual({
			command: fixture.launcher,
			args: ["update"],
		});
	});

	test("rejects a launcher whose target is outside the managed versions directory", () => {
		const fixture = installedFixture();
		const outside = join(temporaryRoots.at(-1)!, "outside");
		writeFileSync(outside, "#!/bin/sh\nexit 0\n");
		chmodSync(outside, 0o755);
		rmSync(fixture.launcher);
		symlinkSync(outside, fixture.launcher);
		expect(resolveInstalledBinaryLauncher(fixture.oldBinary)).toBeUndefined();
	});

	test("prefers an explicit launcher environment value", () => {
		const launch = createCliSubprocessLaunchSpec(
			["status"],
			"/versions/v1/pi",
			[],
			"/$bunfs/root/pi",
			{ PRIME_AGENT_LAUNCHER_PATH: "/custom/bin/prime-agent" },
			true,
		);
		expect(launch).toEqual({ command: "/custom/bin/prime-agent", args: ["status"] });
	});

	test("preserves script launches outside compiled binaries", () => {
		const launch = createCliSubprocessLaunchSpec(["status"], "/usr/bin/bun", ["--smol"], "src/cli.ts", {}, false);
		expect(launch.command).toBe("/usr/bin/bun");
		expect(launch.args).toEqual(["--smol", expect.stringContaining("/src/cli.ts"), "status"]);
	});
});
