import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const globalPath = join(agentDir, "settings.json");
	const projectPath = join(projectDir, ".prime", "agent", "settings.json");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	const writeSettings = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));
	const readSettings = (path: string): Record<string, unknown> =>
		JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

	describe("on-disk settings file", () => {
		it("preserves keys it does not own, including ones written after load", async () => {
			writeSettings(globalPath, { theme: "dark", defaultModel: "claude-sonnet" });
			const manager = SettingsManager.create(projectDir, agentDir);

			// A second writer (another process, or the user's editor) adds keys after load.
			writeSettings(globalPath, {
				...readSettings(globalPath),
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
				defaultThinkingLevel: "low",
			});

			manager.setDefaultThinkingLevel("high");
			manager.setTheme("light");
			await manager.flush();

			expect(readSettings(globalPath)).toEqual({
				theme: "light",
				defaultModel: "claude-sonnet",
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
				// In-memory changes win for keys the manager owns.
				defaultThinkingLevel: "high",
			});
		});

		it("reloads rewritten settings from disk", async () => {
			writeSettings(globalPath, { theme: "dark", extensions: ["/before.ts"] });
			const manager = SettingsManager.create(projectDir, agentDir);

			writeSettings(globalPath, { theme: "light", extensions: ["/after.ts"], defaultModel: "claude-sonnet" });
			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		// An unparsable file must never be clobbered: the user's settings would be lost.
		it.each<[string, string, (manager: SettingsManager) => void, string]>([
			["global", globalPath, (manager) => manager.setRlmMaxDepth(3), "Global settings not saved"],
			[
				"project",
				projectPath,
				(manager) => manager.setProjectPackages(["npm:test-pkg"]),
				"Project settings not saved",
			],
		])("keeps invalid %s settings on disk and reports the failed save", async (scope, path, mutate, message) => {
			const invalid = `{ invalid ${scope} json`;
			writeFileSync(path, invalid);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual([scope]);
			expect(manager.drainErrors()).toEqual([]);

			mutate(manager);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe(scope);
			expect(errors[0]?.error.message).toContain(message);
			expect(readFileSync(path, "utf-8")).toBe(invalid);
		});

		it("keeps the previously loaded values when a reload finds invalid JSON", async () => {
			writeSettings(globalPath, { theme: "dark" });
			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(globalPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});

		it("drains errors per scope", () => {
			writeFileSync(globalPath, "{ invalid global json");
			writeFileSync(projectPath, "{ invalid project json");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.drainErrors("global").map((entry) => entry.scope)).toEqual(["global"]);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual(["project"]);
		});

		it("creates the project settings directory only when project settings are written", async () => {
			writeSettings(globalPath, { theme: "dark" });
			rmSync(join(projectDir, ".prime", "agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(false);
			expect(manager.getTheme()).toBe("dark");

			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			expect(existsSync(projectPath)).toBe(true);
		});
	});

	describe("project vs global precedence", () => {
		it.each<[string, unknown, unknown, (manager: SettingsManager) => unknown, unknown]>([
			[
				"project sessionDir overrides global",
				{ sessionDir: "/global/sessions" },
				{ sessionDir: "./sessions" },
				(manager) => manager.getSessionDir(),
				"./sessions",
			],
			[
				"global sessionDir expands ~",
				{ sessionDir: "~/sessions" },
				{},
				(manager) => manager.getSessionDir(),
				join(homedir(), "sessions"),
			],
			[
				"mcpServers stay global-only",
				{ mcpServers: { shared: { type: "http", url: "https://global.shared/mcp" } } },
				{ mcpServers: { shared: { type: "http", url: "https://project.shared/mcp" } } },
				(manager) => manager.getGlobalMcpServers(),
				{ shared: { type: "http", url: "https://global.shared/mcp" } },
			],
			[
				"idle eviction stays global-only",
				{ idleEvictionMinutes: 60 },
				{ idleEvictionMinutes: 30 },
				(manager) => manager.getIdleEvictionMinutes(),
				60,
			],
			[
				"autonomous limits merge project over global, dropping invalid entries",
				{ autonomous: { maxContinuations: 10, maxTurns: 40 } },
				{ autonomous: { maxContinuations: "unlimited", maxTokens: "one million" } },
				(manager) => manager.getAutonomousLimits(),
				{
					maxContinuations: Number.MAX_SAFE_INTEGER,
					maxTurns: 40,
					maxTokens: undefined,
					timeoutMs: undefined,
				},
			],
		])("%s", (_label, global, project, read, expected) => {
			writeSettings(globalPath, global);
			writeSettings(projectPath, project);

			expect(read(SettingsManager.create(projectDir, agentDir))).toEqual(expected);
		});
	});

	// Telemetry may only ever be narrowed: no project file or runtime override can opt a user back in.
	describe("telemetry privacy controls", () => {
		it.each<[string, unknown, unknown, boolean]>([
			[
				"a global opt-out survives project opt-in",
				{ enabled: false, noticeShown: false },
				{ enabled: true, noticeShown: true },
				false,
			],
			["a project opt-out disables globally enabled telemetry", { enabled: true }, { enabled: false }, false],
			["both enabled keeps telemetry on", { enabled: true }, { enabled: true }, true],
		])("%s", (_label, global, project, expected) => {
			writeSettings(globalPath, { telemetry: global });
			writeSettings(projectPath, { telemetry: project });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(expected);
			if (!expected) expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it.each<[string, boolean, boolean, boolean]>([
			["further disable telemetry", true, false, false],
			["not re-enable a global opt-out", false, true, false],
		])("runtime overrides can %s", (_label, globalEnabled, overrideEnabled, expected) => {
			writeSettings(globalPath, { telemetry: { enabled: globalEnabled, noticeShown: true } });
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: overrideEnabled, noticeShown: overrideEnabled } });

			expect(manager.getTelemetryEnabled()).toBe(expected);
		});
	});
});
