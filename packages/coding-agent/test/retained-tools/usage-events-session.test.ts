import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../src/config.js";
import { getGlobalHarnessStateDir, loadHarnessState, saveHarnessState } from "../../src/core/refinement/index.js";
import { loadToolIndex } from "../../src/core/retained-tools/index.js";
import { refreshToolIndexes } from "../../src/core/retained-tools/rebuild.js";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createHarness, type Harness } from "../suite/harness.js";
import { createTestResourceLoader } from "../utilities.js";

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

function writeSkill(cwdPath: string, agentPath: string, name: string): string {
	const skillsRoot = join(cwdPath, ".prime", "agent", "skills");
	const skillDir = name === "gtool" ? join(agentPath, "skills", name) : join(skillsRoot, name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n`);
	return skillPath;
}

/**
 * SARK T03 session-level synthetic session: exercises the non-kernel count
 * sources — (a) /skill:<name> invocation and (d) explicit signals (user
 * statements and record_refinement outcomes). The kernel sources (b/c) are
 * covered in usage-events-kernel.test.ts; together they cover all four.
 */
describe("retained tool usage events in a synthetic session (T03)", () => {
	let agentDir: string;
	let harness: Harness | undefined;
	let skills: Skill[];

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-usage-session-"));
		agentDir = join(base, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		// Skills are pushed after the harness exists (its tempDir is the session cwd).
		skills = [];
		harness = await createHarness({
			resourceLoader: createTestResourceLoader({ skills }),
		});
		const projectSkillPath = writeSkill(harness.tempDir, agentDir, "demo-tool");
		const globalSkillPath = writeSkill(harness.tempDir, agentDir, "gtool");
		refreshToolIndexes({ cwd: harness.tempDir, agentDir });
		skills.push(makeSkill("demo-tool", projectSkillPath), makeSkill("gtool", globalSkillPath));
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		harness?.cleanup();
		harness = undefined;
		rmSync(dirname(agentDir), { recursive: true, force: true });
	});

	function projectIndex() {
		return loadToolIndex(join(harness!.tempDir, CONFIG_DIR_NAME, "tools"));
	}

	it("counts a /skill: invocation once and attributes a following explicit-ok statement", async () => {
		harness!.setResponses([fauxAssistantMessage("done")]);
		await harness!.session.prompt("/skill:demo-tool do the thing");
		expect(projectIndex().skills["demo-tool"].usage).toMatchObject({
			used: 1,
			explicit_ok: 0,
			explicit_fail: 0,
		});

		harness!.setResponses([fauxAssistantMessage("you're welcome")]);
		await harness!.session.prompt("it worked, thanks");
		expect(projectIndex().skills["demo-tool"].usage).toMatchObject({ used: 1, explicit_ok: 1 });
		expect(projectIndex().skills["demo-tool"].usage.last_status).toBe("ok");
	});

	it("attributes an explicit-fail statement and records the note", async () => {
		harness!.setResponses([fauxAssistantMessage("retrying")]);
		await harness!.session.prompt("/skill:demo-tool retry the build");

		harness!.setResponses([fauxAssistantMessage("sorry about that")]);
		await harness!.session.prompt("it failed, still broken");
		const usage = projectIndex().skills["demo-tool"].usage;
		expect(usage).toMatchObject({ used: 1, explicit_ok: 0, explicit_fail: 1 });
		expect(usage.last_status).toBe("fail");
		expect(usage.recent_failures.length).toBe(1);
		expect(usage.recent_failures[0].note).toContain("it failed, still broken");
	});

	it("counts a record_refinement outcome referencing a tool, exactly once", async () => {
		// First user statement baselines the seen refinement events.
		harness!.setResponses([fauxAssistantMessage("hi")]);
		await harness!.session.prompt("hello");

		// A preceding turn (this session's earlier refine) recorded an event.
		const stateDir = getGlobalHarnessStateDir(agentDir);
		const state = loadHarnessState(stateDir, "global");
		state.refinements.push({
			id: "refine-ev-1",
			trigger: "user asked to tighten the demo-tool guidance",
			changes: ["update skill:demo-tool: clarify the output format"],
			evidence: "demo-tool produced prose where JSON was expected",
			outcome: "it worked",
			created_at: new Date().toISOString(),
		});
		saveHarnessState(stateDir, state);

		harness!.setResponses([fauxAssistantMessage("ok")]);
		await harness!.session.prompt("next task");
		expect(projectIndex().skills["demo-tool"].usage).toMatchObject({ explicit_ok: 1, explicit_fail: 0 });

		// No double count on the next turn.
		harness!.setResponses([fauxAssistantMessage("ok")]);
		await harness!.session.prompt("another task");
		expect(projectIndex().skills["demo-tool"].usage.explicit_ok).toBe(1);
	});

	it("produces zero explicit_ok for a successful session with no explicit signal", async () => {
		harness!.setResponses([fauxAssistantMessage("all set, the tool ran to completion")]);
		await harness!.session.prompt("/skill:demo-tool do the thing");
		expect(projectIndex().skills["demo-tool"].usage).toMatchObject({
			used: 1,
			explicit_ok: 0,
			explicit_fail: 0,
		});
		expect(projectIndex().skills["demo-tool"].usage.last_status).toBe(null);
	});

	it("does not self-attribute outcome phrases contained in the skill body", async () => {
		// A skill whose SKILL.md body contains an explicit-ok phrase must not
		// credit itself when invoked: only the user's own words count.
		const chatterDir = join(harness!.tempDir, ".prime", "agent", "skills", "chatter");
		mkdirSync(chatterDir, { recursive: true });
		const chatterPath = join(chatterDir, "SKILL.md");
		writeFileSync(
			chatterPath,
			`---\nname: chatter\ndescription: chatty skill.\n---\n\n# chatter\n\nIt worked last time, so run it again.\n`,
		);
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
		skills.push(makeSkill("chatter", chatterPath));

		harness!.setResponses([fauxAssistantMessage("done")]);
		await harness!.session.prompt("/skill:chatter run it");
		expect(projectIndex().skills.chatter.usage).toMatchObject({
			used: 1,
			explicit_ok: 0,
			explicit_fail: 0,
		});
	});

	it("ignores skills that are not in any tool index (bundled-style)", async () => {
		// gtool lives in the global agentDir and IS indexed; a skill outside the
		// tracked roots has no entry and must never be created by usage events.
		const untrackedDir = join(harness!.tempDir, "untracked-skills", "ghost-tool");
		mkdirSync(untrackedDir, { recursive: true });
		const ghostPath = join(untrackedDir, "SKILL.md");
		writeFileSync(ghostPath, `---\nname: ghost-tool\ndescription: untracked\n---\n\n# ghost\n`);
		skills.push(makeSkill("ghost-tool", ghostPath));

		harness!.setResponses([fauxAssistantMessage("done")]);
		await harness!.session.prompt("/skill:ghost-tool do the thing");
		harness!.setResponses([fauxAssistantMessage("thanks")]);
		await harness!.session.prompt("it worked");
		expect(projectIndex().skills["ghost-tool"]).toBeUndefined();
		const globalIndex = loadToolIndex(join(agentDir, "tools"));
		expect(globalIndex.skills["ghost-tool"]).toBeUndefined();
	});
});
