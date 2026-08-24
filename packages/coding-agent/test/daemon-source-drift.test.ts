import { describe, expect, it } from "vitest";
import {
	classifyDaemonRuntimeMismatch,
	DAEMON_RUNTIME_ATTESTATION_FIELDS,
	DAEMON_RUNTIME_WIRE_FIELDS,
	detectDaemonSourceDrift,
} from "../src/modes/daemon/daemon-runtime-identity.js";

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

/**
 * The attestation mixes wire facts (protocol, schema) with source facts (build ids, code digest,
 * path). Conflating them told me to run `shutdown --force` — which stops every agent on the machine —
 * when the real situation was a healthy session whose daemon merely predated my last commit.
 */
describe("runtime mismatch classification", () => {
	it("calls a protocol or schema difference a wire break", () => {
		expect(classifyDaemonRuntimeMismatch(["protocolVersion"])).toBe("wire");
		expect(classifyDaemonRuntimeMismatch(["schemaId"])).toBe("wire");
		expect(classifyDaemonRuntimeMismatch(["schemaRevision"])).toBe("wire");
	});

	it("calls a build-id-only difference source drift", () => {
		// The exact mismatch that locked the CLI out of a running session: these two and nothing else.
		expect(classifyDaemonRuntimeMismatch(["sourceBuildId", "installedBuildId"])).toBe("source");
		expect(classifyDaemonRuntimeMismatch(["codeTreeDigest"])).toBe("source");
		expect(classifyDaemonRuntimeMismatch(["executablePath"])).toBe("source");
	});

	it("treats a mixed set as a wire break, because the wire field decides", () => {
		expect(classifyDaemonRuntimeMismatch(["sourceBuildId", "schemaId"])).toBe("wire");
	});

	it("reports source for an empty set rather than inventing a wire break", () => {
		expect(classifyDaemonRuntimeMismatch([])).toBe("source");
	});

	it("keeps the wire field list disjoint from the source fields it must outrank", () => {
		for (const field of DAEMON_RUNTIME_WIRE_FIELDS) {
			expect(classifyDaemonRuntimeMismatch([field])).toBe("wire");
			expect(DAEMON_RUNTIME_ATTESTATION_FIELDS).toContain(field);
		}
	});
});
