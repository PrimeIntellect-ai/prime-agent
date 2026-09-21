import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeUpdatePlan } from "../src/cli/native-update.js";
import { NATIVE_RELEASE_ASSETS } from "../src/utils/native-installation.js";
import { getLatestPiRelease } from "../src/utils/version-check.js";

const artifact = {
	platform: "linux-x64",
	file: "prime-agent-1.2.4-linux-x64.tar.gz",
	sha256: "b".repeat(64),
};
const invalidMetadata: Array<{ name: string; binaries: unknown }> = [
	{ name: "invalid checksum", binaries: [{ ...artifact, sha256: "invalid" }] },
	{ name: "duplicate platform", binaries: [artifact, artifact] },
	{ name: "valid entry followed by invalid entry", binaries: [artifact, null] },
	{ name: "wrong archive version", binaries: [{ ...artifact, file: "prime-agent-1.2.3-linux-x64.tar.gz" }] },
	{ name: "non-array metadata", binaries: { artifact } },
];

describe("native release metadata isolation", () => {
	let root: string;
	let executable: string;
	let target: string;
	const baseUrl = "https://releases.example";

	beforeEach(() => {
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", baseUrl);
		root = realpathSync(mkdtempSync(join(tmpdir(), "prime-native-metadata-")));
		const checksum = "a".repeat(64);
		const releaseName = `1.2.3-linux-x64-${checksum}`;
		const releaseDir = join(root, "releases", releaseName);
		mkdirSync(releaseDir, { recursive: true });
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, ".managed"), "prime-agent-native-v1\n");
		for (const asset of NATIVE_RELEASE_ASSETS) {
			mkdirSync(dirname(join(releaseDir, asset)), { recursive: true });
			writeFileSync(join(releaseDir, asset), "fixture\n");
		}
		writeFileSync(join(releaseDir, ".archive-sha256"), checksum);
		writeFileSync(join(releaseDir, ".install-source"), baseUrl);
		writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
		executable = join(releaseDir, "prime-agent");
		writeFileSync(executable, "fixture executable");
		target = `../releases/${releaseName}/prime-agent`;
		symlinkSync(target, join(root, "bin", "prime-agent"));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(invalidMetadata)(
		"preserves npm release details but refuses native updates for $name",
		async ({ binaries }) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({
						version: "v1.2.4",
						package: "prime-agent",
						tarball: "releases/v1.2.4/prime-agent-1.2.4.tgz",
						binaries,
					}),
				),
			);

			await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
				version: "1.2.4",
				packageName: "prime-agent",
				installSpec: `${baseUrl}/releases/v1.2.4/prime-agent-1.2.4.tgz`,
			});
			for (const force of [false, true]) {
				await expect(getNativeUpdatePlan({ force, rollback: false, executable })).rejects.toThrow(
					"No verified compiled archive is available for linux-x64.",
				);
			}
			expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
		},
	);

	it("uses the verified platform checksum when the entire native list is valid", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);

		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable });

		expect(plan.targetVersion).toBe("1.2.4");
		expect(plan.command?.args).toContain(`PRIME_AGENT_EXPECTED_SHA256=${artifact.sha256}`);
		expect(plan.command?.args).toContain("PRIME_AGENT_INSTALL_METHOD=binary");
	});
});
