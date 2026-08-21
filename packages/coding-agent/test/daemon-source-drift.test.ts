import { describe, expect, it } from "vitest";
import { detectDaemonSourceDrift } from "../src/modes/daemon/daemon-runtime-identity.js";

const LAUNCHER = "/repo/prime-agent.sh";

/**
 * A daemon pins its source at startup. That cost a real overnight run an hour: two fixes were
 * committed and tested while every session kept dying on the exact bug they fixed, and nothing
 * anywhere said a restart would help. These pin the reporting, including the cases where silence is
 * the honest answer.
 */
describe("daemon source drift", () => {
	it("reports drift when the tree has moved since the daemon started", () => {
		const drift = detectDaemonSourceDrift(
			{ PRIME_AGENT_SOURCE_BUILD_ID: "v0.7.2-5-gaaaaaaa", PRIME_AGENT_LAUNCHER_PATH: LAUNCHER },
			() => "v0.7.2-6-gbbbbbbb-dirty",
		);
		expect(drift).toEqual({ recorded: "v0.7.2-5-gaaaaaaa", current: "v0.7.2-6-gbbbbbbb-dirty" });
	});

	it("stays quiet when the source is unchanged", () => {
		expect(
			detectDaemonSourceDrift(
				{ PRIME_AGENT_SOURCE_BUILD_ID: "v0.7.2-6-gbbbbbbb", PRIME_AGENT_LAUNCHER_PATH: LAUNCHER },
				() => "v0.7.2-6-gbbbbbbb",
			),
		).toBeUndefined();
	});

	it("stays quiet for a bundled runtime with no launcher directory to interrogate", () => {
		expect(detectDaemonSourceDrift({ PRIME_AGENT_SOURCE_BUILD_ID: "release-0.7.3" }, () => "x")).toBeUndefined();
	});

	it("stays quiet when git cannot answer, rather than claiming drift", () => {
		expect(
			detectDaemonSourceDrift(
				{ PRIME_AGENT_SOURCE_BUILD_ID: "v0.7.2-5-gaaaaaaa", PRIME_AGENT_LAUNCHER_PATH: LAUNCHER },
				() => undefined,
			),
		).toBeUndefined();
	});

	it("falls back to the legacy build id variable", () => {
		expect(
			detectDaemonSourceDrift({ PRIME_AGENT_BUILD_ID: "old", PRIME_AGENT_LAUNCHER_PATH: LAUNCHER }, () => "new"),
		).toEqual({ recorded: "old", current: "new" });
	});

	it("asks git about the launcher's directory, not the process cwd", () => {
		const asked: string[] = [];
		detectDaemonSourceDrift(
			{ PRIME_AGENT_SOURCE_BUILD_ID: "old", PRIME_AGENT_LAUNCHER_PATH: "/repo/nested/prime-agent.sh" },
			(dir) => {
				asked.push(dir);
				return "new";
			},
		);
		expect(asked).toEqual(["/repo/nested"]);
	});
});
