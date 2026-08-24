import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../../src/config.js";
import { loadToolIndex } from "../../../src/core/retained-tools/index.js";
import { refreshToolIndexes } from "../../../src/core/retained-tools/rebuild.js";
import { loadSkillsFromDir, type Skill } from "../../../src/core/skills.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * SARK T05 session-level regressions for the `metadata.prime-agent.retained`
 * frontmatter contract (docs/retained-tools/frontmatter-contract.md):
 *
 * 1. (AC1) loading a skill dir with retained frontmatter populates the tool
 *    index entry (version, status) on refresh.
 * 2. (AC2) a status: disabled skill is absent from the <available_skills>
 *    prompt block but still invocable via /skill:<name>.
 * 3. (AC3) the default-catalog prompt block is byte-identical for skills
 *    without the frontmatter (golden captured before any T3 change).
 */
describe("issue #5: retained frontmatter contract (SARK T05)", () => {
	let agentDir: string;
	let harness: Harness | undefined;
	let skills: Skill[];

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-retained-frontmatter-"));
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

	function projectSkillsRoot(): string {
		return join(harness!.tempDir, CONFIG_DIR_NAME, "skills");
	}

	function writeSkill(name: string, body: string): void {
		const skillDir = join(projectSkillsRoot(), name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), body);
	}

	/**
	 * Real loader path: read the skill dirs from disk, feed them to the session
	 * resource loader, refresh the indexes, and force a system-prompt rebuild
	 * (the harness builds its base prompt with an empty skill array at
	 * construction).
	 */
	function loadFromDisk(): void {
		const { skills: loaded, diagnostics } = loadSkillsFromDir({
			dir: projectSkillsRoot(),
			source: "project",
		});
		expect(diagnostics).toHaveLength(0);
		skills.push(...loaded);
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
		harness!.session.setActiveToolsByName(harness!.session.getActiveToolNames());
	}

	function projectIndex() {
		return loadToolIndex(join(harness!.tempDir, CONFIG_DIR_NAME, "tools"));
	}

	function userTexts(): string[] {
		return harness!.session.messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const c = m.content;
				if (typeof c === "string") return c;
				if (Array.isArray(c))
					return c
						.map((b) => (typeof (b as { text?: string }).text === "string" ? (b as { text: string }).text : ""))
						.join("");
				return "";
			});
	}

	it("populates the tool index entry from retained frontmatter on load (acceptance 1)", () => {
		writeSkill(
			"deploy-staging-canary",
			[
				"---",
				"name: deploy-staging-canary",
				"description: Deploy to staging behind a canary.",
				"metadata:",
				"  prime-agent:",
				"    retained:",
				"      version: 2",
				"      status: active",
				"      provenance:",
				"        created_by: refine",
				"        source_sessions:",
				"          - 01a0205d-0b6f-74f8-94f4-ad4cde6226c8",
				"        first_seen: 2026-08-20T18:00:00Z",
				"        summary: Retained from 2 sessions.",
				"    smoke:",
				'      - "import deploy_canary; assert deploy_canary.ping()"',
				"    always_in_prompt: true",
				"---",
				"",
				"# Body",
			].join("\n"),
		);

		loadFromDisk();

		const loadedSkill = skills.find((s) => s.name === "deploy-staging-canary");
		expect(loadedSkill?.retained).toEqual({ version: 2, status: "active" });

		const entry = projectIndex().skills["deploy-staging-canary"];
		expect(entry).toBeDefined();
		expect(entry?.scope).toBe("project");
		expect(entry?.path).toBe(`${CONFIG_DIR_NAME}/skills/deploy-staging-canary`);
		expect(entry?.version).toBe(2);
		expect(entry?.status).toBe("active");
		expect(entry?.usage).toEqual({
			used: 0,
			explicit_ok: 0,
			explicit_fail: 0,
			last_used: null,
			last_status: null,
			recent_failures: [],
		});
		// Frontmatter beyond version/status is not part of the index entry.
		expect(Object.keys(entry!).sort()).toEqual(
			["description_hash", "embedding", "path", "scope", "status", "usage", "version"].sort(),
		);
	});

	it("keeps a disabled retained skill out of the prompt but invocable via /skill (acceptance 2)", async () => {
		writeSkill("plain-alpha", "---\nname: plain-alpha\ndescription: Plain alpha.\n---\n\nBody.\n");
		writeSkill(
			"retained-disabled-tool",
			"---\nname: retained-disabled-tool\ndescription: A disabled retained tool.\nmetadata:\n  prime-agent:\n    retained:\n      version: 2\n      status: disabled\n---\n\nBody.\n",
		);
		loadFromDisk();

		const prompt = harness!.session.systemPrompt;
		expect(prompt).toContain("<name>plain-alpha</name>");
		expect(prompt).not.toContain("<name>retained-disabled-tool</name>");
		expect(prompt).not.toContain("A disabled retained tool.");

		// Still invocable: /skill: expands the disabled skill and records usage.
		harness!.setResponses([fauxAssistantMessage("ok")]);
		await harness!.session.prompt("/skill:retained-disabled-tool do it");
		const user = userTexts().join("\n");
		expect(user).toContain('<skill name="retained-disabled-tool"');
		expect(user).toContain("do it");
		expect(projectIndex().skills["retained-disabled-tool"]?.usage.used).toBe(1);
	});

	it("renders the default catalog byte-identically for skills without the frontmatter (acceptance 3)", () => {
		// Same fixtures as the pre-change golden generator.
		writeSkill("alpha-notes", "---\nname: alpha-notes\ndescription: Alpha notes skill.\n---\n\n# alpha-notes\nBody.");
		const pyDir = join(projectSkillsRoot(), "beta-pytool");
		mkdirSync(join(pyDir, "src", "beta_pytool"), { recursive: true });
		writeFileSync(
			join(pyDir, "SKILL.md"),
			"---\nname: beta-pytool\ndescription: Beta Python tool.\n---\n\n# beta-pytool\nBody.",
		);
		writeFileSync(join(pyDir, "pyproject.toml"), '[project]\nname = "beta-pytool"\nversion = "0.1.0"\n');
		writeFileSync(join(pyDir, "src", "beta_pytool", "__init__.py"), "async def run():\n    return 'ok'\n");
		writeSkill(
			"gamma-escape",
			"---\nname: gamma-escape\ndescription: Handles <special> & \"quoted\" names with 'apostrophes'.\n---\n\n# gamma-escape\nBody.",
		);

		const { skills: loaded, diagnostics } = loadSkillsFromDir({
			dir: projectSkillsRoot(),
			source: "project",
		});
		expect(diagnostics).toHaveLength(0);
		// Sort by name: readdir order is filesystem-dependent.
		skills.push(...loaded.sort((a, b) => a.name.localeCompare(b.name)));
		expect(loaded.every((s) => s.retained === undefined)).toBe(true);
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
		harness!.session.setActiveToolsByName(harness!.session.getActiveToolNames());

		const prompt = harness!.session.systemPrompt;
		const start = prompt.indexOf("The following skills");
		const end = prompt.indexOf("</available_skills>");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const block = prompt.slice(start, end + "</available_skills>".length);
		const normalized = block.replaceAll(projectSkillsRoot(), "__SKILLS_ROOT__");
		const golden = readFileSync(
			join(__dirname, "..", "..", "fixtures", "retained-tools", "available-skills-default-catalog.txt"),
			"utf-8",
		);
		expect(normalized).toBe(golden);
	});
});
