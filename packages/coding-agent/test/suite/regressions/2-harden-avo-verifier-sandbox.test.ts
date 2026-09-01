import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AVO_VERIFICATION_BROKER_SOCKET_ENV,
	AVO_VERIFICATION_BROKER_TOKEN_ENV,
} from "../../../src/core/avo/verification-broker.js";
import type { BashResult } from "../../../src/core/bash-executor.js";
import { createHarness, type Harness } from "../harness.js";

interface VerificationInternals {
	_executeAvoVerificationBash(
		command: string,
	): Promise<BashResult & { verificationMode: "host_broker" | "local_sandbox" | "unavailable" }>;
}

describe("issue #2 local AVO verification sandbox", () => {
	let harness: Harness | undefined;
	let credentialRoot: string | undefined;

	afterEach(() => {
		vi.unstubAllEnvs();
		harness?.cleanup();
		if (credentialRoot && existsSync(credentialRoot)) {
			rmSync(credentialRoot, { recursive: true, force: true });
		}
		harness = undefined;
		credentialRoot = undefined;
	});

	it("hides credentials, secret environment values, and host runtime sockets", async () => {
		if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return;
		harness = await createHarness();
		credentialRoot = mkdtempSync(join(tmpdir(), "prime-avo-verifier-credentials-"));
		writeFileSync(join(credentialRoot, "auth.json"), '{"token":"fixture-secret"}\n');
		const fixturePath = join(harness.tempDir, "verification-fixture.txt");
		writeFileSync(fixturePath, "visible\n");

		vi.stubEnv(AVO_VERIFICATION_BROKER_SOCKET_ENV, "");
		vi.stubEnv(AVO_VERIFICATION_BROKER_TOKEN_ENV, "");
		vi.stubEnv("PRIME_AGENT_AVO_CONFIG_DIR", credentialRoot);
		vi.stubEnv("AVO_REVIEW_API_KEY", "fixture-secret");
		vi.stubEnv("SSH_AUTH_SOCK", "/run/fixture-agent.sock");

		const result = await (harness.session as unknown as VerificationInternals)._executeAvoVerificationBash(
			[
				`test -r ${JSON.stringify(fixturePath)} || { printf 'workspace fixture unavailable\\n'; exit 11; }`,
				"test ! -e \"$PRIME_AGENT_AVO_CONFIG_DIR/auth.json\" || { printf 'credential file visible\\n'; exit 12; }",
				`test -z "\${AVO_REVIEW_API_KEY+x}" || { printf 'secret environment visible\\n'; exit 13; }`,
				`test -z "\${SSH_AUTH_SOCK+x}" || { printf 'auth socket environment visible\\n'; exit 14; }`,
				"test ! -S /run/docker.sock || { printf 'docker socket visible\\n'; exit 15; }",
			].join("; "),
		);

		expect(result.verificationMode).toBe("local_sandbox");
		expect(result.exitCode, result.output).toBe(0);
	});
});
