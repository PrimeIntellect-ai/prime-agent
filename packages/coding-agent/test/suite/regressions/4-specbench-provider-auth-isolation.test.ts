import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentAuthStorage,
	PRIME_AGENT_EPHEMERAL_AUTH_FILE_ENV,
} from "../../../src/core/ephemeral-auth-storage.js";
import { createLocalBashOperations } from "../../../src/core/tools/bash.js";
import { prepareSpecBenchConfig, specBenchAgentEnvironment } from "../../../src/evals/specbench/runner.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue #4 SpecBench provider authentication isolation", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps selected provider auth in memory and removes it before agent tool execution", async () => {
		harness = await createHarness();
		const provider = harness.getModel().provider;
		const source = join(harness.tempDir, "source");
		const agentDir = join(harness.tempDir, "runtime", "agent");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "settings.json"), JSON.stringify({ defaultProvider: provider }));
		writeFileSync(
			join(source, "auth.json"),
			JSON.stringify({
				[provider]: { type: "api_key", key: "faux-provider-secret" },
				"mcp:linear": { type: "api_key", key: "integration-secret" },
			}),
		);

		prepareSpecBenchConfig(source, agentDir, provider);
		const authPath = join(agentDir, "auth.json");
		expect(existsSync(authPath)).toBe(true);

		const authStorage = createAgentAuthStorage({
			authPath,
			usePrimeCliConfig: false,
			environment: { [PRIME_AGENT_EPHEMERAL_AUTH_FILE_ENV]: authPath },
		});
		expect(authStorage.get(provider)).toEqual({ type: "api_key", key: "faux-provider-secret" });
		expect(authStorage.get("mcp:linear")).toBeUndefined();
		expect(existsSync(authPath)).toBe(false);

		const output: Buffer[] = [];
		const environment = {
			...specBenchAgentEnvironment({
				PATH: process.env.PATH,
				CUSTOM_PASSWORD: "ambient-secret",
				TEAM_ACCESS_KEY: "ambient-access-key",
			}),
			AUTH_PROBE_PATH: authPath,
		};
		const result = await createLocalBashOperations().exec(
			'test ! -r "$AUTH_PROBE_PATH" && test -z "$CUSTOM_PASSWORD" && test -z "$TEAM_ACCESS_KEY" && printf isolated',
			harness.tempDir,
			{
				onData: (chunk) => output.push(chunk),
				env: environment,
			},
		);

		expect(result.exitCode, Buffer.concat(output).toString("utf8")).toBe(0);
		expect(Buffer.concat(output).toString("utf8")).toBe("isolated");
		expect(existsSync(authPath)).toBe(false);
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).not.toContain("provider-secret");
	});
});
