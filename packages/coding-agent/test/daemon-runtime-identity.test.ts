import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.js";
import { getDaemonRuntimeIdentity, PRIME_AGENT_BUILD_ID_ENV } from "../src/modes/daemon/daemon-runtime-identity.js";

// __PI_BUILD_ID__ is substituted by scripts/bundle.mjs at build time and is absent under tsx,
// so a stubbed global is how a test observes the bundled branch.
function withBundledBuildId(buildId: string): void {
	vi.stubGlobal("__PI_BUILD_ID__", buildId);
}

describe("daemon runtime identity", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports the bundle's embedded build id even when the launcher exports a newer one", () => {
		// prime-agent.sh exports the worktree's live `git describe`. A daemon still serving an
		// older bundle must not inherit it, or committing without rebuilding hides the staleness.
		withBundledBuildId("beta-33-gaaaaaaaaa");

		const identity = getDaemonRuntimeIdentity({ [PRIME_AGENT_BUILD_ID_ENV]: "beta-37-gbbbbbbbbb" });

		expect(identity.buildId).toBe("beta-33-gaaaaaaaaa");
	});

	it("falls back to the launcher environment when running unbundled", () => {
		const identity = getDaemonRuntimeIdentity({ [PRIME_AGENT_BUILD_ID_ENV]: "beta-37-gbbbbbbbbb" });

		expect(identity.buildId).toBe("beta-37-gbbbbbbbbb");
	});

	it("falls back to the package version when neither source is available", () => {
		const identity = getDaemonRuntimeIdentity({});

		expect(identity.buildId).toBe(`release-${VERSION}`);
	});
});
