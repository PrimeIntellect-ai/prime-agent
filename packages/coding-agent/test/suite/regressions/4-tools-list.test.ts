import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../../src/config.js";
import {
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
	type SessionSlashCommandResultMessage,
} from "../../../src/core/messages.js";
import { getToolIndexPath } from "../../../src/core/retained-tools/index.js";
import { refreshToolIndexes } from "../../../src/core/retained-tools/rebuild.js";
import type { Skill } from "../../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

const EXPECTED_COLUMNS = ["name", "scope", "path", "status", "used", "explicit_ok", "explicit_fail", "last_used"];

function makeSkill(name: string, filePath: string): Skill {
	return {
		kind: "markdown",
		name,
		description: "A test skill.",
		filePath,
		baseDir: dirname(filePath),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "temporary" }),
		disableModelInvocation: false,
	};
}

/**
 * SARK T04 session-level regression: `/tools list` is a read-only catalog over
 * the per-scope tool indexes, with project entries shadowing same-named global
 * ones. Fixtures mirror the T03 session test (test/retained-tools/usage-events-session.test.ts).
 */
describe("issue #4: /tools list read-only catalog (SARK T04)", () => {
	let agentDir: string;
	let harness: Harness | undefined;
	let skills: Skill[];

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-tools-list-"));
		agentDir = join(base, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		skills = [];
		harness = await createHarness({
			resourceLoader: createTestResourceLoader({ skills }),
		});
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		harness?.cleanup();
		harness = undefined;
		rmSync(dirname(agentDir), { recursive: true, force: true });
	});

	function writeSkill(name: string, scope: "project" | "global"): string {
		const skillsRoot =
			scope === "global" ? join(agentDir, "skills") : join(harness!.tempDir, CONFIG_DIR_NAME, "skills");
		const skillDir = join(skillsRoot, name);
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n`);
		return skillPath;
	}

	function setUpProjectSkill(name: string): void {
		skills.push(makeSkill(name, writeSkill(name, "project")));
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
	}

	function setUpGlobalSkill(name: string): void {
		skills.push(makeSkill(name, writeSkill(name, "global")));
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
	}

	function latestResult(): SessionSlashCommandResultMessage {
		const results = harness!.session.messages.filter(
			(message): message is SessionSlashCommandResultMessage =>
				message.role === "custom" && message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
		);
		expect(results.length).toBeGreaterThan(0);
		return results[results.length - 1];
	}

	async function runToolsList(): Promise<SessionSlashCommandResultMessage> {
		harness!.setResponses([]);
		await harness!.session.prompt("/tools list");
		return latestResult();
	}

	async function recordUsage(skillName: string): Promise<void> {
		harness!.setResponses([fauxAssistantMessage("done")]);
		await harness!.session.prompt(`/skill:${skillName} do the thing`);
		harness!.setResponses([fauxAssistantMessage("you're welcome")]);
		await harness!.session.prompt("it worked, thanks");
	}

	function tableRows(content: string): string[][] {
		return content
			.split("\n")
			.slice(1)
			.map((line) => line.split(/\s{2,}/));
	}

	it("prints the catalog table with the exact columns for recorded usage (acceptance 1)", async () => {
		setUpProjectSkill("demo-tool");
		await recordUsage("demo-tool");

		const result = await runToolsList();
		expect(result.details.success).toBe(true);
		const lines = result.content.split("\n");
		expect(lines[0].split(/\s{2,}/)).toEqual(EXPECTED_COLUMNS);
		expect(lines).toHaveLength(2);
		const row = lines[1].split(/\s{2,}/);
		expect(row.slice(0, 4)).toEqual(["demo-tool", "project", ".prime/agent/skills/demo-tool", "active"]);
		expect(row[4]).toBe("1"); // used
		expect(row[5]).toBe("1"); // explicit_ok
		expect(row[6]).toBe("0"); // explicit_fail
		expect(row[7]).not.toBe("-"); // last_used is recorded
	});

	it("shows a global-scope entry with its own recorded usage", async () => {
		setUpGlobalSkill("gtool");
		await recordUsage("gtool");

		const result = await runToolsList();
		expect(result.details.success).toBe(true);
		const rows = tableRows(result.content).filter((row) => row[0] === "gtool");
		expect(rows).toHaveLength(1);
		expect(rows[0].slice(0, 4)).toEqual(["gtool", "global", "skills/gtool", "active"]);
		expect(rows[0][4]).toBe("1");
		expect(rows[0][5]).toBe("1");
	});

	it("shadows a same-named global skill with the project skill (acceptance 2)", async () => {
		setUpGlobalSkill("dup-tool");
		setUpProjectSkill("dup-tool");

		const result = await runToolsList();
		expect(result.details.success).toBe(true);
		const rows = tableRows(result.content);
		const dupRows = rows.filter((row) => row[0] === "dup-tool");
		expect(dupRows).toHaveLength(1);
		expect(dupRows[0].slice(0, 3)).toEqual(["dup-tool", "project", ".prime/agent/skills/dup-tool"]);
	});

	it("is read-only: the index files are byte-identical after the command", async () => {
		setUpProjectSkill("demo-tool");
		setUpGlobalSkill("gtool");
		await recordUsage("demo-tool");

		const projectIndexPath = getToolIndexPath(join(harness!.tempDir, CONFIG_DIR_NAME, "tools"));
		const globalIndexPath = getToolIndexPath(join(agentDir, "tools"));
		const beforeProject = readFileSync(projectIndexPath);
		const beforeGlobal = readFileSync(globalIndexPath);

		const result = await runToolsList();
		expect(result.details.success).toBe(true);
		expect(readFileSync(projectIndexPath)).toEqual(beforeProject);
		expect(readFileSync(globalIndexPath)).toEqual(beforeGlobal);
	});

	it("bare /tools defaults to the list catalog", async () => {
		setUpProjectSkill("demo-tool");
		await recordUsage("demo-tool");

		harness!.setResponses([]);
		await harness!.session.prompt("/tools");
		const bare = latestResult();

		const listed = await runToolsList();
		expect(bare.details.success).toBe(true);
		expect(bare.content).toBe(listed.content);
	});

	it("rejects unknown subcommands with the usage line", async () => {
		setUpProjectSkill("demo-tool");

		harness!.setResponses([]);
		await harness!.session.prompt("/tools rollback");
		const result = latestResult();
		expect(result.details.success).toBe(false);
		expect(result.content).toBe("Command failed: Usage: /tools [list]");
		expect(result.details.error).toBe("Usage: /tools [list]");
	});

	it("reports the empty catalog in a session with no skills or indexes", async () => {
		const result = await runToolsList();
		expect(result.details.success).toBe(true);
		expect(result.content).toBe("No retained tools found.");
	});
});
