import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import {
	formatSkillsForPrompt,
	getPythonSkillRuntimeInfo,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillPythonMetadata,
} from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");
const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

function createTestSkill(options: {
	name: string;
	description: string;
	disableModelInvocation?: boolean;
	python?: SkillPythonMetadata;
}): Skill {
	const filePath = `/path/${options.name}/SKILL.md`;
	const base = {
		name: options.name,
		description: options.description,
		filePath,
		baseDir: `/path/${options.name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
	return options.python ? { ...base, kind: "python", python: options.python } : { ...base, kind: "markdown" };
}

function writePythonSkill(root: string, name: string): void {
	const skillDir = join(root, name);
	const importName = name.replaceAll("-", "_");
	mkdirSync(join(skillDir, "src", importName), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nUse this skill for tests.\n`,
	);
	writeFileSync(join(skillDir, "pyproject.toml"), `[project]\nname = "${name}"\nversion = "0.1.0"\n`);
	writeFileSync(join(skillDir, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
}

describe("skills", () => {
	// One case table for loader validation: which fixtures load, under what names, and whether
	// the loader reports a diagnostic. Exact warning wording is not part of the contract.
	it.each([
		{ fixture: "valid-skill", names: ["valid-skill"], diagnostics: false },
		{ fixture: "unknown-field", names: ["unknown-field"], diagnostics: false },
		{ fixture: "multiline-description", names: ["multiline-description"], diagnostics: false },
		{ fixture: "nested", names: ["child-skill"], diagnostics: false },
		{ fixture: "root-skill-preferred", names: ["root-skill-preferred"], diagnostics: false },
		{ fixture: "disable-model-invocation", names: ["disable-model-invocation"], diagnostics: false },
		{ fixture: "name-mismatch", names: ["different-name"], diagnostics: true },
		{ fixture: "invalid-name-chars", names: undefined, diagnostics: true },
		{ fixture: "long-name", names: undefined, diagnostics: true },
		{ fixture: "consecutive-hyphens", names: undefined, diagnostics: true },
		{ fixture: "missing-description", names: [], diagnostics: true },
		{ fixture: "no-frontmatter", names: [], diagnostics: true },
		{ fixture: "invalid-yaml", names: [], diagnostics: true },
	])("loadSkillsFromDir($fixture)", ({ fixture, names, diagnostics }) => {
		const result = loadSkillsFromDir({ dir: join(fixturesDir, fixture), source: "test" });

		if (names) expect(result.skills.map((skill) => skill.name)).toEqual(names);
		else expect(result.skills).toHaveLength(1);
		expect(result.diagnostics.length > 0).toBe(diagnostics);
		for (const skill of result.skills) expect(skill.sourceInfo.source).toBe("test");
	});

	it("reads disable-model-invocation, defaulting to false", () => {
		const [disabled] = loadSkillsFromDir({
			dir: join(fixturesDir, "disable-model-invocation"),
			source: "test",
		}).skills;
		const [enabled] = loadSkillsFromDir({ dir: join(fixturesDir, "valid-skill"), source: "test" }).skills;

		expect(disabled.disableModelInvocation).toBe(true);
		expect(enabled.disableModelInvocation).toBe(false);
	});

	it("returns nothing for a non-existent directory", () => {
		const result = loadSkillsFromDir({ dir: "/non/existent/path", source: "test" });

		expect(result.skills).toHaveLength(0);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("loads the whole fixture tree in one pass", () => {
		const { skills } = loadSkillsFromDir({ dir: fixturesDir, source: "test" });

		// Everything with a description loads, warnings and all; the rest is skipped.
		expect(skills.length).toBeGreaterThanOrEqual(6);
		expect(skills.map((skill) => skill.name)).not.toContain("missing-description");
	});

	it("reads Python skill packaging from disk", () => {
		const skillDir = join(fixturesDir, "python-skill");
		const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "test" });

		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "python-skill",
			kind: "python",
			python: { importName: "python_skill", packagePath: skillDir, pyprojectPath: join(skillDir, "pyproject.toml") },
		});
		expect(getPythonSkillRuntimeInfo(skills)).toEqual([
			{
				name: "python-skill",
				importName: "python_skill",
				packagePath: skillDir,
				pyprojectPath: join(skillDir, "pyproject.toml"),
			},
		]);
		expect(diagnostics).toHaveLength(0);
	});

	it("degrades a Python skill to markdown when its package files are missing", () => {
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: join(fixturesDir, "python-package-missing"),
			source: "test",
		});

		expect(skills).toHaveLength(1);
		expect(skills[0].kind).toBe("markdown");
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	describe("loadSkills", () => {
		it("loads explicit skillPaths as temporary skills and warns about missing ones", () => {
			const loaded = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(loaded.skills).toHaveLength(1);
			expect(loaded.skills[0].sourceInfo.scope).toBe("temporary");
			expect(loaded.diagnostics).toHaveLength(0);

			const missing = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(missing.skills).toHaveLength(0);
			expect(missing.diagnostics.length).toBeGreaterThan(0);
		});

		it("expands ~ in skillPaths", () => {
			const base = { agentDir: emptyAgentDir, cwd: emptyCwd, includeDefaults: true };
			const withTilde = loadSkills({ ...base, skillPaths: ["~/.pi/agent/skills"] });
			const withoutTilde = loadSkills({ ...base, skillPaths: [join(homedir(), ".pi/agent/skills")] });

			expect(withTilde.skills.length).toBe(withoutTilde.skills.length);
		});

		it("keeps the first skill on a name collision and reports the loser", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(collisionFixturesDir, "first"), join(collisionFixturesDir, "second")],
				includeDefaults: false,
			});

			expect(skills.map((skill) => skill.name)).toEqual(["calendar"]);
			expect(skills[0].filePath).toContain(join("skills-collision", "first"));
			const collisions = diagnostics.filter((diagnostic) => diagnostic.type === "collision");
			expect(collisions).toHaveLength(1);
			expect(collisions[0].collision).toMatchObject({
				resourceType: "skill",
				name: "calendar",
				winnerPath: skills[0].filePath,
			});
		});

		it("warns when two Python skills share an import name", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-skills-"));
			try {
				writePythonSkill(tempDir, "web-search");
				writePythonSkill(tempDir, "web_search");

				const { skills, diagnostics } = loadSkills({
					agentDir: emptyAgentDir,
					cwd: emptyCwd,
					skillPaths: [tempDir],
					includeDefaults: false,
				});

				expect(skills.map((skill) => skill.name).sort()).toEqual(["web-search", "web_search"]);
				expect(diagnostics.length).toBeGreaterThan(0);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("formatSkillsForPrompt", () => {
		it.each([
			{ name: "no skills", skills: [] as Skill[], visible: [] as string[] },
			{
				name: "markdown and python skills",
				skills: [
					createTestSkill({ name: "skill-one", description: "First skill." }),
					createTestSkill({
						name: "python-skill",
						description: "A Python skill.",
						python: {
							importName: "python_skill",
							packagePath: "/path/python-skill",
							pyprojectPath: "/path/python-skill/pyproject.toml",
						},
					}),
				],
				visible: ["skill-one", "python-skill"],
			},
			{
				name: "model-invocation-disabled skills",
				skills: [
					createTestSkill({ name: "visible-skill", description: "A visible skill." }),
					createTestSkill({ name: "hidden-skill", description: "A hidden skill.", disableModelInvocation: true }),
				],
				visible: ["visible-skill"],
			},
			{
				name: "only disabled skills",
				skills: [createTestSkill({ name: "hidden-skill", description: "hidden", disableModelInvocation: true })],
				visible: [],
			},
		])("lists $name", ({ skills, visible }) => {
			const result = formatSkillsForPrompt(skills);

			if (visible.length === 0) {
				expect(result).toBe("");
				return;
			}
			expect([...result.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1])).toEqual(visible);
		});
	});
});
