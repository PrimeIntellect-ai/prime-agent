import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import {
	peekConfigValue,
	resolveConfigValue,
	resolveConfigValueAsync,
} from "../../../src/core/resolve-config-value.js";
import { createHarness, type Harness } from "../harness.js";

describe("PR 2138 credential command retries", () => {
	let harness: Harness;
	let tokenPath: string;
	let countPath: string;
	let command: string;

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		harness = await createHarness();
		tokenPath = join(harness.tempDir, "token");
		countPath = join(harness.tempDir, "command-count");
		const scriptPath = join(harness.tempDir, "credential.cjs");
		writeFileSync(countPath, "");
		writeFileSync(
			scriptPath,
			`const fs = require("node:fs"); fs.appendFileSync(process.argv[3], "x"); process.stdout.write(fs.readFileSync(process.argv[2], "utf8"));`,
		);
		command = `!"${process.execPath}" "${scriptPath}" "${tokenPath}" "${countPath}"`;
	});

	afterEach(() => {
		harness.cleanup();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("retries normal request auth after a forced catalog refresh helper failure", async () => {
		writeFileSync(tokenPath, "working-key");
		const auth = AuthStorage.inMemory({ "prime-inference": { type: "api_key", key: command } });
		const registry = ModelRegistry.inMemory(auth);
		expect(await auth.getApiKey("prime-inference")).toBe("working-key");

		rmSync(tokenPath);
		await registry.refreshAvailableModels({ background: false });
		expect(peekConfigValue(command)).toBeUndefined();
		writeFileSync(tokenPath, "rotated-key");

		expect(await auth.getApiKey("prime-inference")).toBe("rotated-key");
		expect(readFileSync(countPath, "utf8")).toBe("xxx");
	});

	test.each(["failure", "empty output"])("coalesces retries after initial %s", async (failure) => {
		if (failure === "empty output") writeFileSync(tokenPath, "");
		expect(await resolveConfigValueAsync(command)).toBeUndefined();
		writeFileSync(tokenPath, "recovered-key");

		const keys = await Promise.all([resolveConfigValueAsync(command), resolveConfigValueAsync(command)]);
		expect(keys).toEqual(["recovered-key", "recovered-key"]);
		expect(readFileSync(countPath, "utf8")).toBe("xx");
		expect(await resolveConfigValueAsync(command)).toBe("recovered-key");
		expect(readFileSync(countPath, "utf8")).toBe("xx");
	});

	test("retries after a synchronous resolver cached a failed command", async () => {
		expect(resolveConfigValue(command)).toBeUndefined();
		writeFileSync(tokenPath, "recovered-key");

		expect(await resolveConfigValueAsync(command)).toBe("recovered-key");
		expect(readFileSync(countPath, "utf8")).toBe("xx");
	});

	test("does not reuse the previous key when a forced helper refresh fails", async () => {
		writeFileSync(tokenPath, "previous-key");
		expect(await resolveConfigValueAsync(command)).toBe("previous-key");
		rmSync(tokenPath);

		expect(await resolveConfigValueAsync(command, { force: true })).toBeUndefined();
		expect(peekConfigValue(command)).toBeUndefined();
		expect(await resolveConfigValueAsync(command)).toBeUndefined();
		expect(readFileSync(countPath, "utf8")).toBe("xxx");
	});

	test("does not restore auth when logout happens during a retry", async () => {
		const provider = harness.getModel().provider;
		const auth = AuthStorage.inMemory({ [provider]: { type: "api_key", key: command } });
		expect(await auth.getApiKey(provider)).toBeUndefined();
		writeFileSync(tokenPath, "recovered-key");

		const pending = auth.getApiKey(provider);
		auth.logout(provider);
		expect(await pending).toBeUndefined();
		expect(await auth.getApiKey(provider)).toBeUndefined();
		expect(auth.hasAuth(provider)).toBe(false);
	});
});
