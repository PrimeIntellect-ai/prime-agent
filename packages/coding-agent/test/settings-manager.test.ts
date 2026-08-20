import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("onboardingShown", () => {
		it("defaults to false and persists globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOnboardingShown()).toBe(false);

			manager.setOnboardingShown(true);
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.onboardingShown).toBe(true);
			expect(manager.getOnboardingShown()).toBe(true);
		});

		it("treats the legacy completion field as already shown", () => {
			const manager = SettingsManager.inMemory({ onboardingCompleted: true });

			expect(manager.getOnboardingShown()).toBe(true);
		});
	});

	describe("autoRefine", () => {
		it("defaults to enabled while preserving explicit opt-out", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAutoRefineSettings()).toEqual({
				enabled: true,
				turnInterval: 25,
				compact: true,
				cooldownMs: 20 * 60_000,
			});

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ autoRefine: { enabled: false } }));
			const optedOut = SettingsManager.create(projectDir, agentDir);

			expect(optedOut.getAutoRefineSettings().enabled).toBe(false);
		});

		it("falls back to defaults for non-numeric turnInterval and cooldownMs", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ autoRefine: { turnInterval: "oops", cooldownMs: "nope" } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(25);
			expect(settings.cooldownMs).toBe(20 * 60_000);
			expect(Number.isFinite(settings.turnInterval)).toBe(true);
			expect(Number.isFinite(settings.cooldownMs)).toBe(true);
		});

		it("ignores non-finite numeric values that parse to Infinity", () => {
			// 1e999 is valid JSON that JSON.parse turns into Infinity.
			writeFileSync(
				join(agentDir, "settings.json"),
				`{ "autoRefine": { "turnInterval": 1e999, "cooldownMs": 1e999 } }`,
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(25);
			expect(settings.cooldownMs).toBe(20 * 60_000);
		});

		it("preserves valid numeric overrides", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ autoRefine: { turnInterval: 5, cooldownMs: 1000 } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(5);
			expect(settings.cooldownMs).toBe(1000);
		});
	});

	describe("recentModels", () => {
		it("records most-recently-used first, dedupes, and persists", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setDefaultModelAndProvider("prov", "a");
			manager.setDefaultModelAndProvider("prov", "b");
			manager.setDefaultModelAndProvider("prov", "a");
			await manager.flush();

			expect(manager.getRecentModels()).toEqual(["prov/a", "prov/b"]);
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.recentModels).toEqual(["prov/a", "prov/b"]);
		});

		it("caps the list at the limit", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			for (let i = 0; i < 25; i++) {
				manager.setDefaultModelAndProvider("prov", `m${i}`);
			}
			await manager.flush();

			const recent = manager.getRecentModels();
			expect(recent).toHaveLength(20);
			expect(recent[0]).toBe("prov/m24");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});

		it("should report a new global error when saving after the load error was drained", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const invalidSettings = "{ invalid global json";
			writeFileSync(settingsPath, invalidSettings);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors()).toHaveLength(1);

			manager.setRlmMaxDepth(3);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe("global");
			expect(errors[0]?.error.message).toContain("Global settings not saved: settings file failed to parse:");
			expect(readFileSync(settingsPath, "utf-8")).toBe(invalidSettings);
		});

		it("should report a new project error when saving after the load error was drained", async () => {
			const settingsPath = join(projectDir, ".prime", "agent", "settings.json");
			const invalidSettings = "{ invalid project json";
			writeFileSync(settingsPath, invalidSettings);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors()).toHaveLength(1);

			manager.setProjectPackages(["npm:test-pkg"]);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe("project");
			expect(errors[0]?.error.message).toContain("Project settings not saved: settings file failed to parse:");
			expect(readFileSync(settingsPath, "utf-8")).toBe(invalidSettings);
		});

		it("drains only the requested scope", () => {
			writeFileSync(join(agentDir, "settings.json"), "{ invalid global json");
			writeFileSync(join(projectDir, ".prime", "agent", "settings.json"), "{ invalid project json");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.drainErrors("global").map((entry) => entry.scope)).toEqual(["global"]);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual(["project"]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			rmSync(join(projectDir, ".prime", "agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(false);

			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			rmSync(join(projectDir, ".prime", "agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(false);

			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(true);

			expect(existsSync(join(projectDir, ".prime", "agent", "settings.json"))).toBe(true);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ sessionDir: "./sessions" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("mcpServers", () => {
		it("returns undefined when global settings are unset", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGlobalMcpServers()).toBeUndefined();
		});

		it("ignores project mcpServers when returning executable servers", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					mcpServers: {
						acme: { type: "http", url: "https://global.acme/mcp", oauth: true },
						shared: { type: "http", url: "https://global.shared/mcp" },
					},
				}),
			);
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({
					mcpServers: {
						shared: { type: "http", url: "https://project.shared/mcp" },
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGlobalMcpServers()).toEqual({
				acme: { type: "http", url: "https://global.acme/mcp", oauth: true },
				shared: { type: "http", url: "https://global.shared/mcp" },
			});
		});
	});
	describe("idle worker eviction", () => {
		it("defaults to 90 minutes and treats none as off", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getIdleEvictionMinutes()).toBe(90);

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ idleEvictionMinutes: "none" }));
			const disabled = SettingsManager.create(projectDir, agentDir);
			expect(disabled.getIdleEvictionMinutes()).toBe("off");
		});

		it("reads and writes the global daemon policy without project overrides", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ idleEvictionMinutes: 60 }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ idleEvictionMinutes: 30 }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getIdleEvictionMinutes()).toBe(60);

			manager.setIdleEvictionMinutes("off");
			await manager.flush();
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).idleEvictionMinutes).toBe("off");
		});
	});

	describe("telemetry privacy controls", () => {
		it("does not let project settings override a global opt-out or disclosure state", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ telemetry: { enabled: false, noticeShown: false } }),
			);
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ telemetry: { enabled: true, noticeShown: true } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(false);
			expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it("allows project settings to further disable globally enabled telemetry", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ telemetry: { enabled: false } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(false);
		});

		it("allows runtime overrides to further disable telemetry and control disclosure", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ telemetry: { enabled: true, noticeShown: true } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: false, noticeShown: false } });

			expect(manager.getTelemetryEnabled()).toBe(false);
			expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it("does not let a runtime override re-enable a global opt-out", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: true } });

			expect(manager.getTelemetryEnabled()).toBe(false);
		});
	});
});
