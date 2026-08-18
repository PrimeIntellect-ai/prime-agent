import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
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

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:pi-mcp-adapter"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);

		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.packages = [];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([]);

		manager.setTheme("light");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.theme).toBe("light");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./initial-extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});
