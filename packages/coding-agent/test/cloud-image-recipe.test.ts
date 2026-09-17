import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract for the direct-cloud runtime image recipe. The Dockerfile is a
 * product surface: a base prepared for an older prime-agent can carry a stale
 * agent config that breaks the current agent's Bash tool at startup (a
 * settings shellPath that no longer exists throws before any command runs),
 * so the recipe must wipe it and pin every artifact by checksum.
 */
const DOCKERFILE = readFileSync(join(__dirname, "../cloud-image/Dockerfile"), "utf8");
const CHECKSUMS = readFileSync(join(__dirname, "../cloud-image/checksums.sha256"), "utf8");

describe("cloud image recipe", () => {
	it("pins the runtime base by immutable digest, never by tag", () => {
		const from = DOCKERFILE.split("\n").find((line) => line.startsWith("FROM "));
		expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
	});

	it("wipes the stale base agent config and neutralizes both inherited overrides before install", () => {
		const wipe = DOCKERFILE.indexOf("rm -rf /root/.prime/agent /root/.config/pi");
		const agentDirOverride = DOCKERFILE.indexOf('ENV PRIME_AGENT_CODING_AGENT_DIR=""');
		const kernelPythonOverride = DOCKERFILE.indexOf('ENV PRIME_AGENT_KERNEL_PYTHON=""');
		const install = DOCKERFILE.indexOf("npm install -g /tmp/prime-agent-0.9.5.tgz");
		expect(wipe).toBeGreaterThan(-1);
		expect(agentDirOverride).toBeGreaterThan(-1);
		expect(kernelPythonOverride).toBeGreaterThan(-1);
		// All three precede the fresh install so the postinstall bootstrap
		// starts from a clean config, and the empty overrides make
		// getAgentDir()/kernel bootstrap treat them as unset. Without the
		// kernel-python reset, 0.9.5 honors the base's 0.2.9-era venv path and
		// every kernel/bash tool call fails at startup.
		expect(agentDirOverride).toBeLessThan(install);
		expect(kernelPythonOverride).toBeLessThan(install);
		expect(wipe).toBeLessThan(install);
	});

	it("verifies every release artifact against the pinned checksums", () => {
		expect(DOCKERFILE).toContain("sha256sum -c checksums.sha256");
		expect(CHECKSUMS).toContain(
			"349f1682c7909550842f1b04a71ba95814341b136474ade736df93f8ec006876  prime-agent-0.9.5.tgz",
		);
		expect(CHECKSUMS).toContain(
			"317a17a7adac2e6bed2d7a83dc077da91ced0d110e1636373ece8ae5ac8b578b  frp_0.66.0_linux_amd64.tar.gz",
		);
		expect(DOCKERFILE).toContain(
			"2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524  /tmp/frp_0.66.0_linux_amd64/frpc",
		);
	});
});
