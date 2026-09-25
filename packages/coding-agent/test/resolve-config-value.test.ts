import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidateCommandTtlCacheEntry,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueOrThrowAsync,
	resolveConfigValueUncached,
	resolveHeadersOrThrowAsync,
} from "../src/core/resolve-config-value.js";

const VAR = "PRIME_AGENT_TEST_CREDENTIAL_VAR";

describe("resolveConfigValue env fallback", () => {
	it("uses a set env var as the value, a set-but-empty one as missing, an unset one as the literal", async () => {
		process.env[VAR] = "secret-value";
		expect(resolveConfigValue(VAR)).toBe("secret-value");
		expect(resolveConfigValueUncached(VAR)).toBe("secret-value");

		process.env[VAR] = "";
		expect(resolveConfigValue(VAR)).toBeUndefined();
		expect(resolveConfigValueUncached(VAR)).toBeUndefined();
		await expect(resolveConfigValueOrThrowAsync(VAR, "test credential")).rejects.toThrow(
			"Failed to resolve test credential",
		);

		delete process.env[VAR];
		expect(resolveConfigValue(VAR)).toBe(VAR);
		expect(resolveConfigValue("sk-literal-key")).toBe("sk-literal-key");
	});
});

describe("resolveConfigValueAsync command TTL", () => {
	let tempDir: string;
	let execLog: string;
	let valueFile: string;

	function loggingCommand(): string {
		return `!sh -c 'printf x >> "${join(tempDir, "exec.log")}"; cat "${valueFile}"'`;
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "resolve-config-ttl-"));
		execLog = join(tempDir, "exec.log");
		valueFile = join(tempDir, "value.txt");
		writeFileSync(valueFile, "value-1");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("shares one exec per TTL window, re-runs after expiry, and honors invalidation", async () => {
		const config = loggingCommand();
		const [a, b] = await Promise.all([resolveConfigValueAsync(config), resolveConfigValueAsync(config)]);
		expect(a).toBe("value-1");
		expect(b).toBe("value-1");
		expect(readFileSync(execLog, "utf8")).toHaveLength(1);

		writeFileSync(valueFile, "value-2");
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(Date.now() + 60_000); // well past the command TTL
		expect(await resolveConfigValueAsync(config)).toBe("value-2");

		writeFileSync(valueFile, "value-3");
		invalidateCommandTtlCacheEntry(config);
		expect(await resolveConfigValueAsync(config)).toBe("value-3");
	});

	it("does not cache an exec that was invalidated while in flight", async () => {
		const config = loggingCommand();
		const pending = resolveConfigValueAsync(config);
		invalidateCommandTtlCacheEntry(config);
		expect(await pending).toBe("value-1");

		writeFileSync(valueFile, "value-2");
		expect(await resolveConfigValueAsync(config)).toBe("value-2");
		expect(readFileSync(execLog, "utf8")).toHaveLength(2);
	});

	it("throws when an async command resolution fails, and resolves headers, env vars, and literals", async () => {
		await expect(resolveConfigValueOrThrowAsync("!exit 3", "test credential")).rejects.toThrow(
			"Failed to resolve test credential from shell command",
		);

		process.env[VAR] = "async-env-value";
		const headers = await resolveHeadersOrThrowAsync(
			{ "X-Command": loggingCommand(), "X-Env": VAR, "X-Literal": "header-literal" },
			"test",
		);
		expect(headers).toEqual({
			"X-Command": "value-1",
			"X-Env": "async-env-value",
			"X-Literal": "header-literal",
		});
		delete process.env[VAR];
	});
});
