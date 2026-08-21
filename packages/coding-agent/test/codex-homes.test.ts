import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, RuntimeApiKeyChainState } from "../src/core/auth-storage.js";
import { applyCodexHomes } from "../src/core/codex-homes.js";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

const temporaryDirectories: string[] = [];

function createCodexHome(name: string, accessToken?: string): string {
	const directory = join(tmpdir(), `prime-codex-home-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	temporaryDirectories.push(directory);
	writeFileSync(
		join(directory, "auth.json"),
		JSON.stringify(accessToken ? { tokens: { access_token: accessToken } } : { tokens: {} }),
	);
	return directory;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("Codex homes", () => {
	it("loads readable homes in configured order and omits invalid credentials", async () => {
		const first = createCodexHome("first", "first-token");
		const invalid = createCodexHome("invalid");
		const second = createCodexHome("second", "second-token");
		const authStorage = AuthStorage.inMemory();

		const result = applyCodexHomes(authStorage, [first, invalid, second]);

		expect(result.loadedHomes).toEqual([first, second]);
		await expect(authStorage.getApiKey("openai-codex")).resolves.toBe("first-token");
		expect(authStorage.getAuthStatus("openai-codex")).toEqual({
			configured: false,
			source: "runtime_chain",
			label: first,
		});
	});

	it("rotates shared storage to the next home when the active source is exhausted", async () => {
		const first = createCodexHome("first", "first-token");
		const second = createCodexHome("second", "second-token");
		const authStorage = AuthStorage.inMemory();
		applyCodexHomes(authStorage, [first, second]);

		const firstToken = authStorage.getCurrentAuthSourceToken("openai-codex");
		expect(firstToken?.source).toBe("runtime_chain");
		expect(firstToken && authStorage.markAuthSourceStale(firstToken)).toBe(true);

		await expect(authStorage.getApiKey("openai-codex")).resolves.toBe("second-token");
		expect(authStorage.getAuthStatus("openai-codex").label).toBe(second);

		const secondToken = authStorage.getCurrentAuthSourceToken("openai-codex");
		expect(secondToken && authStorage.markAuthSourceStale(secondToken)).toBe(true);
		authStorage.set("openai-codex", { type: "api_key", key: "stored-token" });
		await expect(authStorage.getApiKey("openai-codex")).resolves.toBeUndefined();
		expect(authStorage.getAuthStatus("openai-codex").source).toBe("stale");
	});

	it("shares rotation across daemon sessions without sharing their auth storage", async () => {
		const first = createCodexHome("first", "first-token");
		const second = createCodexHome("second", "second-token");
		const chainState = new RuntimeApiKeyChainState();
		applyCodexHomes(chainState, [first, second]);
		const firstSession = AuthStorage.inMemory({}, { runtimeApiKeyChainState: chainState });
		const secondSession = AuthStorage.inMemory({}, { runtimeApiKeyChainState: chainState });

		const exhausted = firstSession.getCurrentAuthSourceToken("openai-codex");
		expect(exhausted && firstSession.markAuthSourceStale(exhausted)).toBe(true);
		expect(exhausted && secondSession.markAuthSourceStale(exhausted)).toBe(false);

		await expect(firstSession.getApiKey("openai-codex")).resolves.toBe("second-token");
		await expect(secondSession.getApiKey("openai-codex")).resolves.toBe("second-token");
	});

	it("keeps explicit runtime keys ahead of the configured home chain", async () => {
		const home = createCodexHome("home", "home-token");
		const authStorage = AuthStorage.inMemory();
		applyCodexHomes(authStorage, [home]);
		authStorage.setRuntimeApiKey("openai-codex", "explicit-token");

		await expect(authStorage.getApiKey("openai-codex")).resolves.toBe("explicit-token");
		authStorage.removeRuntimeApiKey("openai-codex");
		await expect(authStorage.getApiKey("openai-codex")).resolves.toBe("home-token");
	});

	it("uses only global codexHomes and reports project overrides", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ codexHomes: ["~/.codex"] }));
		storage.withLock("project", () => JSON.stringify({ codexHomes: ["~/.project-codex"] }));
		const settings = SettingsManager.fromStorage(storage);

		expect(settings.getCodexHomes()).toEqual(["~/.codex"]);
		expect(settings.drainErrors()).toMatchObject([
			{ scope: "project", error: { message: expect.stringContaining("global-only") } },
		]);
		await settings.reload();
		expect(settings.drainErrors("project")[0]?.error.message).toContain("global-only");
	});

	it("validates codexHomes as ordered non-empty directory strings", () => {
		expect(SettingsManager.inMemory({ codexHomes: [" ~/.codex ", "~/.codex-personal"] }).getCodexHomes()).toEqual([
			"~/.codex",
			"~/.codex-personal",
		]);
		expect(() => SettingsManager.inMemory({ codexHomes: [""] }).getCodexHomes()).toThrow(
			"codexHomes entries must be non-empty strings",
		);
	});
});
