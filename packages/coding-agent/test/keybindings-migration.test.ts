import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { runMigrations } from "../src/migrations.js";

describe("keybindings migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(config: Record<string, unknown>): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keybindings-test-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "keybindings.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return agentDir;
	}

	it("rewrites old key names to namespaced ids", () => {
		const agentDir = createAgentDir({
			cursorUp: ["up", "ctrl+p"],
			expandTools: "ctrl+x",
			"app.message.dequeue": "alt+u",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"tui.editor.cursorUp": ["up", "ctrl+p"],
			"app.tools.expand": "ctrl+x",
			"app.message.navigateOlder": "alt+u",
		});
	});

	it("keeps the namespaced value when old and new names both exist", () => {
		const agentDir = createAgentDir({
			expandTools: "ctrl+x",
			"app.tools.expand": "ctrl+y",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"app.tools.expand": "ctrl+y",
		});
	});

	it("loads old key names in memory before the file is rewritten", () => {
		const agentDir = createAgentDir({
			selectConfirm: "enter",
			interrupt: "ctrl+x",
		});

		const keybindings = KeybindingsManager.create(agentDir);

		expect(keybindings.getUserBindings()).toEqual({
			"tui.select.confirm": "enter",
			"app.interrupt": "ctrl+x",
		});
		const effective = keybindings.getEffectiveConfig();
		expect(effective["tui.select.confirm"]).toBe("enter");
		expect(effective["app.interrupt"]).toBe("ctrl+x");
	});

	it("gives explicit editor bindings precedence over application defaults", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.cursorUp": ["up", "ctrl+p"],
			"tui.editor.cursorDown": ["down", "ctrl+n"],
		});

		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("app.messages.expand")).toEqual([]);
		expect(keybindings.getKeys("app.models.toggleProvider")).toEqual(["ctrl+p"]);
		expect(keybindings.getKeys("app.agents.new")).toEqual(["ctrl+n"]);
	});

	it("reports an application default that is explicitly retained against an editor binding", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.cursorUp": ["up", "ctrl+p"],
			"app.messages.expand": "ctrl+p",
		});

		expect(keybindings.getConflicts()).toContainEqual({
			key: "ctrl+p",
			keybindings: ["tui.editor.cursorUp", "app.messages.expand"],
		});
		expect(keybindings.getKeys("app.messages.expand")).toEqual(["ctrl+p"]);
	});
});
