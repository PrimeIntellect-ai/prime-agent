import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeCodeTreeDigest,
	PRIME_AGENT_BUILD_ID_ENV,
	PRIME_AGENT_CODE_TREE_DIGEST_ENV,
	PRIME_AGENT_INSTALLED_BUILD_ID_ENV,
	resolveDaemonRuntimeBuildIdentity,
} from "../src/modes/daemon/daemon-runtime-identity.js";

describe("daemon runtime identity", () => {
	it("keeps an embedded installed identity ahead of launcher metadata", () => {
		const identity = resolveDaemonRuntimeBuildIdentity(
			{
				[PRIME_AGENT_BUILD_ID_ENV]: "launcher-build",
				[PRIME_AGENT_INSTALLED_BUILD_ID_ENV]: "launcher-installed-build",
				[PRIME_AGENT_CODE_TREE_DIGEST_ENV]: "sha256:launcher-tree",
			},
			{
				sourceBuildId: "embedded-source-build",
				installedBuildId: "installed-build",
				codeTreeDigest: "sha256:installed-tree",
			},
		);

		expect(identity).toEqual({
			buildId: "installed-build",
			sourceBuildId: "launcher-build",
			installedBuildId: "installed-build",
			codeTreeDigest: "sha256:installed-tree",
		});
	});

	it("hashes declared code inputs deterministically", () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-runtime-identity-"));
		try {
			writeFileSync(join(dir, "b.txt"), "bravo");
			writeFileSync(join(dir, "a.txt"), "alpha");

			const first = computeCodeTreeDigest(dir, ["b.txt", "a.txt"]);
			const second = computeCodeTreeDigest(dir, ["a.txt", "b.txt"]);
			expect(first).toBe(second);

			writeFileSync(join(dir, "a.txt"), "changed");
			expect(computeCodeTreeDigest(dir, ["a.txt", "b.txt"])).not.toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
