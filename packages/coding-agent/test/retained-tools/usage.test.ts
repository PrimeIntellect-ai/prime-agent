import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.js";
import {
	emptyToolIndex,
	loadToolIndex,
	saveToolIndex,
	type ToolIndex,
	type ToolIndexEntry,
} from "../../src/core/retained-tools/index.js";
import {
	classifyExplicitOutcome,
	detectSkillFileReads,
	ExplicitOutcomeTracker,
	extractRefinementToolSignals,
	recordToolUsageEvent,
	textMentionsSkill,
} from "../../src/core/retained-tools/usage.js";

function makeEntry(scope: "global" | "project", name: string): ToolIndexEntry {
	return {
		scope,
		path: `skills/${name}/SKILL.md`,
		version: 1,
		status: "active",
		usage: {
			used: 0,
			explicit_ok: 0,
			explicit_fail: 0,
			last_used: null,
			last_status: null,
			recent_failures: [],
		},
		description_hash: "h",
		embedding: [],
	};
}

function seedIndex(toolsDir: string, names: Array<{ name: string; scope: "global" | "project" }>): void {
	const index: ToolIndex = emptyToolIndex();
	for (const { name, scope } of names) index.skills[name] = makeEntry(scope, name);
	saveToolIndex(toolsDir, index);
}

describe("retained tool usage recording (T03)", () => {
	let cwd: string;
	let agentDir: string;
	const projectToolsDir = () => join(cwd, CONFIG_DIR_NAME, "tools");
	const globalToolsDir = () => join(agentDir, "tools");

	beforeEach(() => {
		const base = mkdtempSync(join(tmpdir(), "pi-usage-unit-"));
		cwd = join(base, "cwd");
		agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		const base = join(cwd, "..");
		rmSync(base, { recursive: true, force: true });
	});

	describe("recordToolUsageEvent", () => {
		it("increments used exactly once per event and stamps last_used", () => {
			seedIndex(projectToolsDir(), [{ name: "demo-tool", scope: "project" }]);
			expect(
				recordToolUsageEvent({
					skillName: "demo-tool",
					event: "used",
					scope: "project",
					cwd,
					agentDir,
				}),
			).toBe(true);
			const entry = loadToolIndex(projectToolsDir()).skills["demo-tool"];
			expect(entry.usage.used).toBe(1);
			expect(entry.usage.last_used).toBeTruthy();
			expect(entry.usage.explicit_ok).toBe(0);
			expect(entry.usage.explicit_fail).toBe(0);
		});

		it("does not create entries for skills that are not in the index", () => {
			seedIndex(projectToolsDir(), [{ name: "demo-tool", scope: "project" }]);
			expect(
				recordToolUsageEvent({
					skillName: "ghost-tool",
					event: "used",
					scope: "project",
					cwd,
					agentDir,
				}),
			).toBe(false);
			const index = loadToolIndex(projectToolsDir());
			expect(index.skills["ghost-tool"]).toBeUndefined();
			expect(Object.keys(index.skills)).toEqual(["demo-tool"]);
		});

		it("increments explicit_ok and sets last_status to ok", () => {
			seedIndex(projectToolsDir(), [{ name: "demo-tool", scope: "project" }]);
			recordToolUsageEvent({
				skillName: "demo-tool",
				event: "explicit_ok",
				scope: "project",
				cwd,
				agentDir,
				note: "it worked",
			});
			const entry = loadToolIndex(projectToolsDir()).skills["demo-tool"];
			expect(entry.usage.explicit_ok).toBe(1);
			expect(entry.usage.last_status).toBe("ok");
			expect(entry.usage.used).toBe(0);
			expect(entry.usage.recent_failures).toEqual([]);
		});

		it("increments explicit_fail, records a failure note, and caps the recent list", () => {
			seedIndex(projectToolsDir(), [{ name: "demo-tool", scope: "project" }]);
			for (let i = 0; i < 22; i++) {
				recordToolUsageEvent({
					skillName: "demo-tool",
					event: "explicit_fail",
					scope: "project",
					cwd,
					agentDir,
					note: `failure ${i}`,
				});
			}
			const entry = loadToolIndex(projectToolsDir()).skills["demo-tool"];
			expect(entry.usage.explicit_fail).toBe(22);
			expect(entry.usage.last_status).toBe("fail");
			expect(entry.usage.recent_failures.length).toBe(20);
			expect(entry.usage.recent_failures[0].note).toBe("failure 2");
			expect(entry.usage.recent_failures.at(-1)?.note).toBe("failure 21");
		});

		it("records against the global scope index when scope is global", () => {
			seedIndex(globalToolsDir(), [{ name: "gtool", scope: "global" }]);
			recordToolUsageEvent({ skillName: "gtool", event: "used", scope: "global", cwd, agentDir });
			expect(loadToolIndex(globalToolsDir()).skills.gtool.usage.used).toBe(1);
			// The project index must stay untouched.
			expect(loadToolIndex(projectToolsDir()).skills.gtool).toBeUndefined();
		});

		it("degrades to false when the index is corrupt", () => {
			mkdirSync(projectToolsDir(), { recursive: true });
			writeFileSync(join(projectToolsDir(), "index.json"), "{ not json", "utf8");
			expect(recordToolUsageEvent({ skillName: "demo-tool", event: "used", scope: "project", cwd, agentDir })).toBe(
				false,
			);
		});
	});

	describe("classifyExplicitOutcome", () => {
		it("classifies explicit success phrases", () => {
			for (const text of [
				"it worked",
				"It worked, thanks",
				"that fixed it",
				"now it's working",
				"success",
				"ran successfully",
				"that solved it",
				"everything is working now",
				"exactly what I needed",
				"thanks for fixing it",
				"the build is green",
			]) {
				expect(classifyExplicitOutcome(text), text).toBe("explicit_ok");
			}
		});

		it("classifies explicit failure phrases (including contractions)", () => {
			for (const text of [
				"it failed",
				"that broke the build",
				"still failing",
				"it's broken",
				"it doesn't work",
				"it didn't work",
				"not fixed",
				"the run crashed",
				"it regressed",
			]) {
				expect(classifyExplicitOutcome(text), text).toBe("explicit_fail");
			}
		});

		it("returns null for neutral statements and empty text", () => {
			for (const text of ["", "   ", "hmm", "I tried it again", "can you look at the logs?", "ship it"]) {
				expect(classifyExplicitOutcome(text), text).toBe(null);
			}
		});

		it("returns null when the statement claims both success and failure", () => {
			expect(classifyExplicitOutcome("it worked but the tests failed")).toBe(null);
		});
	});

	describe("textMentionsSkill", () => {
		it("matches names with word boundaries and the python import alias", () => {
			expect(textMentionsSkill("the demo-tool worked", "demo-tool")).toBe(true);
			expect(textMentionsSkill("demo_tool worked", "demo-tool")).toBe(true);
			expect(textMentionsSkill("DEMO-TOOL worked", "demo-tool")).toBe(true);
		});

		it("does not match partial names", () => {
			expect(textMentionsSkill("the demo-tools worked", "demo-tool")).toBe(false);
			expect(textMentionsSkill("super-demo-tool worked", "demo-tool")).toBe(false);
		});
	});

	describe("detectSkillFileReads", () => {
		const skillPath = "/home/u/proj/.prime/agent/skills/demo-tool/SKILL.md";
		const baseDir = "/home/u/proj/.prime/agent/skills/demo-tool";
		const sources = [{ name: "demo-tool", skillFilePath: skillPath, baseDir }];

		it("counts python open/read, pathlib read_text, and bash cat reads", () => {
			const cwd = "/home/u/proj";
			const cases = [
				`content = open("${skillPath}").read()`,
				`f = open("${skillPath}", "r")\ntext = f.read()`,
				`from pathlib import Path\ntext = Path("${skillPath}").read_text()`,
				"%%bash\ncat /home/u/proj/.prime/agent/skills/demo-tool/SKILL.md",
				`text = open(".prime/agent/skills/demo-tool/SKILL.md").read()`,
			];
			for (const code of cases) {
				expect(detectSkillFileReads(code, sources, cwd), code).toEqual(new Set(["demo-tool"]));
			}
		});

		it("does not count writes or non-read mentions", () => {
			const cwd = "/home/u/proj";
			const cases = [
				`f = open("${skillPath}", "w")\nf.write("hello")`,
				`from pathlib import Path\nPath("${skillPath}").write_text("hello")`,
				`echo hi > ${skillPath}`,
				`target = "${skillPath}"`,
				`# read ${skillPath} later`,
			];
			for (const code of cases) {
				expect(detectSkillFileReads(code, sources, cwd), code).toEqual(new Set());
			}
		});

		it("emits at most one read per skill per cell", () => {
			const cwd = "/home/u/proj";
			const code = `a = open("${skillPath}").read()\nb = Path("${skillPath}").read_text()`;
			const found = detectSkillFileReads(code, sources, cwd);
			expect(found).toEqual(new Set(["demo-tool"]));
		});

		it("ignores unknown skills and empty cells", () => {
			expect(detectSkillFileReads(`open("/other/SKILL.md").read()`, sources, "/x")).toEqual(new Set());
			expect(detectSkillFileReads("", sources, "/x")).toEqual(new Set());
			expect(detectSkillFileReads(`open("${skillPath}").read()`, [], "/x")).toEqual(new Set());
		});
	});

	describe("ExplicitOutcomeTracker", () => {
		it("attributes an unnamed statement to the most recently used pending skill", () => {
			const tracker = new ExplicitOutcomeTracker();
			tracker.markUsed("project", "old-tool", 1000);
			tracker.markUsed("project", "new-tool", 2000);
			const attribution = tracker.onUserStatement("it worked", ["old-tool", "new-tool"]);
			expect(attribution).toEqual({ scope: "project", skillName: "new-tool", event: "explicit_ok" });
		});

		it("prefers a named pending skill over recency, with project shadowing global", () => {
			const tracker = new ExplicitOutcomeTracker();
			tracker.markUsed("project", "new-tool", 2000);
			tracker.markUsed("global", "demo-tool", 1000);
			tracker.markUsed("project", "demo-tool", 1500);
			const attribution = tracker.onUserStatement("demo-tool worked", ["demo-tool", "new-tool"]);
			expect(attribution).toEqual({ scope: "project", skillName: "demo-tool", event: "explicit_ok" });
		});

		it("returns null when the named skill is not pending", () => {
			const tracker = new ExplicitOutcomeTracker();
			tracker.markUsed("project", "other-tool");
			expect(tracker.onUserStatement("demo-tool worked", ["demo-tool", "other-tool"])).toBe(null);
			expect(tracker.size).toBe(1);
		});

		it("consumes the attribution (single use) and keeps pendings for neutral text", () => {
			const tracker = new ExplicitOutcomeTracker();
			tracker.markUsed("project", "demo-tool");
			expect(tracker.onUserStatement("it worked", ["demo-tool"])).not.toBe(null);
			expect(tracker.size).toBe(0);
			expect(tracker.onUserStatement("it worked", ["demo-tool"])).toBe(null);

			tracker.markUsed("project", "demo-tool");
			expect(tracker.onUserStatement("hmm", ["demo-tool"])).toBe(null);
			expect(tracker.size).toBe(1);
		});

		it("returns null with nothing pending", () => {
			const tracker = new ExplicitOutcomeTracker();
			expect(tracker.onUserStatement("it worked", ["demo-tool"])).toBe(null);
		});

		it("caps the pending map", () => {
			const tracker = new ExplicitOutcomeTracker();
			for (let i = 0; i < 60; i++) tracker.markUsed("project", `tool-${i}`, i);
			expect(tracker.size).toBe(50);
			tracker.clear();
			expect(tracker.size).toBe(0);
		});
	});

	describe("extractRefinementToolSignals", () => {
		const known = ["demo-tool", "other-tool"];

		it("attributes a structured skill change with an explicit outcome", () => {
			expect(
				extractRefinementToolSignals(
					{
						trigger: "user asked to tighten the demo-tool guidance",
						changes: ["update skill:demo-tool: clarify the output format"],
						outcome: "it worked",
					},
					known,
				),
			).toEqual({ skillName: "demo-tool", event: "explicit_ok" });

			expect(
				extractRefinementToolSignals(
					{ trigger: "t", changes: ["update skill:other-tool"], outcome: "still failing" },
					known,
				),
			).toEqual({ skillName: "other-tool", event: "explicit_fail" });
		});

		it("falls back to skill mentions in the event text", () => {
			expect(
				extractRefinementToolSignals(
					{
						trigger: "record_refinement run after the demo-tool run",
						changes: ["create memory:demo-tool-prefers-json"],
						outcome: "that solved it",
					},
					known,
				),
			).toEqual({ skillName: "demo-tool", event: "explicit_ok" });
		});

		it("returns null without an explicit outcome phrase", () => {
			expect(
				extractRefinementToolSignals(
					{ trigger: "t", changes: ["update skill:demo-tool"], outcome: "recorded for next session" },
					known,
				),
			).toBe(null);
		});

		it("returns null with zero or multiple skill references", () => {
			expect(
				extractRefinementToolSignals({ trigger: "t", changes: ["update memory:foo"], outcome: "it worked" }, known),
			).toBe(null);
			expect(
				extractRefinementToolSignals(
					{
						trigger: "t",
						changes: ["update skill:demo-tool", "update skill:other-tool"],
						outcome: "it worked",
					},
					known,
				),
			).toBe(null);
		});

		it("ignores unknown skill names in structured changes", () => {
			expect(
				extractRefinementToolSignals(
					{ trigger: "t", changes: ["update skill:ghost-tool"], outcome: "it worked" },
					known,
				),
			).toBe(null);
		});
	});
});
