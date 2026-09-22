import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	type AppKeybinding,
	KEYBINDINGS,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
} from "../src/core/keybindings.js";
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

	function migrate(config: Record<string, unknown>): Record<string, unknown> {
		const agentDir = createAgentDir(config);
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			runMigrations(agentDir);
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
		}
		return JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<string, unknown>;
	}

	it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
		[
			"rewrites old key names to namespaced ids",
			{ cursorUp: ["up", "ctrl+p"], expandTools: "ctrl+x", "app.message.dequeue": "alt+u" },
			{
				"tui.editor.cursorUp": ["up", "ctrl+p"],
				"app.tools.expand": "ctrl+x",
				"app.message.navigateOlder": "alt+u",
			},
		],
		[
			"keeps the namespaced value when old and new names both exist",
			{ expandTools: "ctrl+x", "app.tools.expand": "ctrl+y" },
			{ "app.tools.expand": "ctrl+y" },
		],
	])("%s", (_name, config, expected) => {
		expect(migrate(config)).toEqual(expected);
	});

	it("loads old key names in memory before the file is rewritten", () => {
		const keybindings = KeybindingsManager.create(createAgentDir({ selectConfirm: "enter", interrupt: "ctrl+x" }));

		expect(keybindings.getUserBindings()).toEqual({ "tui.select.confirm": "enter", "app.interrupt": "ctrl+x" });
		expect(keybindings.getEffectiveConfig()["tui.select.confirm"]).toBe("enter");
	});

	const editorOverride: KeybindingsConfig = { "tui.editor.cursorUp": ["up", "ctrl+o"] };
	it.each<[KeybindingsConfig, AppKeybinding, KeyId[]]>([
		[{}, "app.model.cycleForward", ["alt+m"]],
		[{}, "app.model.cycleBackward", ["shift+alt+m"]],
		[{}, "app.models.toggleProvider", ["ctrl+p"]],
		[{ ...editorOverride, "tui.editor.cursorDown": ["down", "ctrl+n"] }, "app.tools.expand", []],
		[{ ...editorOverride, "tui.editor.cursorDown": ["down", "ctrl+n"] }, "app.agents.new", ["ctrl+n"]],
		[{ ...editorOverride, "app.tools.expand": "ctrl+o" }, "app.tools.expand", ["ctrl+o"]],
		[{ "tui.editor.cursorUp": ["up", "ctrl+p"] }, "app.tools.expand", ["ctrl+o"]],
	])("resolves %j -> %s", (config, id, keys) => {
		expect(new KeybindingsManager(config).getKeys(id)).toEqual(keys);
	});

	it("reports an application default explicitly retained against an editor binding", () => {
		const keybindings = new KeybindingsManager({ ...editorOverride, "app.tools.expand": "ctrl+o" });

		expect(keybindings.getConflicts()).toContainEqual({
			key: "ctrl+o",
			keybindings: ["tui.editor.cursorUp", "app.tools.expand"],
		});
	});

	it("does not define an independent message expansion action", () => {
		expect(KEYBINDINGS).not.toHaveProperty("app.messages.expand");
	});
});
