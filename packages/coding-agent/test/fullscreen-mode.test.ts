import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("fullscreen mode settings", () => {
	const testDir = join(process.cwd(), "test-fullscreen-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	let savedEnv: string | undefined;
	let savedTermProgram: string | undefined;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		savedEnv = process.env.PI_FULLSCREEN;
		savedTermProgram = process.env.TERM_PROGRAM;
		delete process.env.PI_FULLSCREEN;
		delete process.env.TERM_PROGRAM;
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		if (savedEnv === undefined) {
			delete process.env.PI_FULLSCREEN;
		} else {
			process.env.PI_FULLSCREEN = savedEnv;
		}
		if (savedTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = savedTermProgram;
	});

	it("defaults to fullscreen with mouse capture in Ghostty", () => {
		process.env.TERM_PROGRAM = "ghostty";
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreen()).toBe(true);
		expect(manager.getFullscreenMouse()).toBe(true);
	});

	it("ignores a malformed null fullscreen mouse setting", () => {
		process.env.TERM_PROGRAM = "xterm";
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ terminal: { fullscreenMouse: null } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenMouse()).toBe(true);
	});

	it("persists the fullscreen off toggle", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setFullscreen(false);
		await manager.flush();

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(settings.terminal.fullscreen).toBe(false);

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getFullscreen()).toBe(false);
	});

	it("PI_FULLSCREEN env var overrides the setting in both directions", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setFullscreen(false);

		process.env.PI_FULLSCREEN = "1";
		expect(manager.getFullscreen()).toBe(true);

		manager.setFullscreen(true);
		process.env.PI_FULLSCREEN = "0";
		expect(manager.getFullscreen()).toBe(false);
	});

	it("persists an explicit fullscreen mouse opt-out in Ghostty", async () => {
		process.env.TERM_PROGRAM = "ghostty";
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setFullscreenMouse(false);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getFullscreenMouse()).toBe(false);
	});
});
