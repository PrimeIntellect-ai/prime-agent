import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

describe("daemon catalog entrypoint", () => {
	it("starts the dedicated catalog process over IPC", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pa-catalog-entry-"));
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		const client = new DaemonCatalogClient(() => {});
		try {
			await expect(client.start()).resolves.toBeUndefined();
			await expect(client.list()).resolves.toEqual([]);
		} finally {
			await client.stop();
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 10_000);
});
