import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import type { RetainedMeta } from "../src/core/retained-tools/meta.js";
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

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	retained?: RetainedMeta;
	python?: SkillPythonMetadata;
	source?: string;
}): Skill {
	const base = {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
		// Only set when provided so tests can distinguish an absent field from undefined.
		...(options.retained !== undefined ? { retained: options.retained } : {}),
	};
	return options.python
		? {
				...base,
				kind: "python",
				python: options.python,
			}
		: {
				...base,
				kind: "markdown",
			};
}

function writePythonSkill(root: string, name: string): void {
	const skillDir = join(root, name);
	const importName = name.replaceAll("-", "_");
	mkdirSync(join(skillDir, "src", importName), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: Test skill ${name}
---

Use this skill for tests.
`,
	);
	writeFileSync(
		join(skillDir, "pyproject.toml"),
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(skillDir, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name doesn't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(true);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});

		it("should attach retained meta to skills with the retained frontmatter", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-skills-"));
			try {
				const skillDir = join(tempDir, "retained-active");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					[
						"---",
						"name: retained-active",
						"description: A retained skill.",
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

				const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "test" });

				expect(skills).toHaveLength(1);
				expect(skills[0].retained).toEqual({ version: 2, status: "active" });
				expect(diagnostics).toHaveLength(0);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should leave retained undefined for skills without the frontmatter", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].retained).toBeUndefined();
		});

		it("should attach default version with an explicit disabled status", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-skills-"));
			try {
				const skillDir = join(tempDir, "retained-disabled");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					"---\nname: retained-disabled\ndescription: A disabled retained skill.\nmetadata:\n  prime-agent:\n    retained:\n      status: disabled\n---\n\n# Body\n",
				);

				const { skills } = loadSkillsFromDir({ dir: skillDir, source: "test" });

				expect(skills).toHaveLength(1);
				expect(skills[0].retained).toEqual({ version: 1, status: "disabled" });
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should fall back to defaults for malformed retained values", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-skills-"));
			try {
				const skillDir = join(tempDir, "retained-malformed");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					'---\nname: retained-malformed\ndescription: A malformed retained skill.\nmetadata:\n  prime-agent:\n    retained:\n      version: "3"\n      status: bogus\n---\n\n# Body\n',
				);

				const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "test" });

				expect(skills).toHaveLength(1);
				expect(skills[0].retained).toEqual({ version: 1, status: "active" });
				expect(diagnostics).toHaveLength(0);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should load Python-backed skills from the same skill root", () => {
			const skillDir = join(fixturesDir, "python-skill");
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: skillDir,
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0]).toMatchObject({
				name: "python-skill",
				kind: "python",
				python: {
					importName: "python_skill",
					packagePath: skillDir,
					pyprojectPath: join(skillDir, "pyproject.toml"),
				},
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

		it("should warn and keep metadata-only skills when Python package files are missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "python-package-missing"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].kind).toBe("markdown");
			expect(
				diagnostics.some((d: ResourceDiagnostic) =>
					d.message.includes("python skill package src/python_package_missing/__init__.py not found"),
				),
			).toBe(true);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<type>markdown</type>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include Python import metadata for Python-backed skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "python-skill",
					description: "A Python skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
					python: {
						importName: "python_skill",
						packagePath: "/path/to/skill",
						pyprojectPath: "/path/to/skill/pyproject.toml",
					},
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<type>python</type>");
			expect(result).toContain("<python_import>python_skill</python_import>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use ipython to inspect a skill's file");
			expect(introText).toContain("Skills with a python_import are prepared");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});

		it("should exclude retained skills with disabled or archived status from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "plain-skill",
					description: "A plain skill.",
					filePath: "/path/plain/SKILL.md",
					baseDir: "/path/plain",
				}),
				createTestSkill({
					name: "retained-disabled",
					description: "A disabled retained skill.",
					filePath: "/path/disabled/SKILL.md",
					baseDir: "/path/disabled",
					retained: { version: 3, status: "disabled" },
				}),
				createTestSkill({
					name: "retained-archived",
					description: "An archived retained skill.",
					filePath: "/path/archived/SKILL.md",
					baseDir: "/path/archived",
					retained: { version: 2, status: "archived" },
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>plain-skill</name>");
			expect(result).not.toContain("<name>retained-disabled</name>");
			expect(result).not.toContain("<name>retained-archived</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should keep retained skills with active or flagged status in prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "retained-active",
					description: "An active retained skill.",
					filePath: "/path/active/SKILL.md",
					baseDir: "/path/active",
					retained: { version: 1, status: "active" },
				}),
				createTestSkill({
					name: "retained-flagged",
					description: "A flagged retained skill.",
					filePath: "/path/flagged/SKILL.md",
					baseDir: "/path/flagged",
					retained: { version: 5, status: "flagged" },
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>retained-active</name>");
			expect(result).toContain("<name>retained-flagged</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should keep disableModelInvocation precedence over a retained active status", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-retained",
					description: "A hidden retained skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
					retained: { version: 1, status: "active" },
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).not.toContain("<name>hidden-retained</name>");
		});

		it("should return empty string when all retained skills are hidden", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "retained-disabled",
					description: "A disabled retained skill.",
					filePath: "/path/disabled/SKILL.md",
					baseDir: "/path/disabled",
					retained: { version: 1, status: "disabled" },
				}),
			];

			expect(formatSkillsForPrompt(skills)).toBe("");
		});

		it("renders plain skills byte-identically whether retained is undefined or absent", () => {
			const withUndefined: Skill = {
				kind: "markdown",
				name: "plain-skill",
				description: "A plain skill.",
				filePath: "/path/plain/SKILL.md",
				baseDir: "/path/plain",
				sourceInfo: createSyntheticSourceInfo("/path/plain/SKILL.md", { source: "test" }),
				disableModelInvocation: false,
				retained: undefined,
			};
			const absent: Skill = {
				kind: "markdown",
				name: "plain-skill",
				description: "A plain skill.",
				filePath: "/path/plain/SKILL.md",
				baseDir: "/path/plain",
				sourceInfo: createSyntheticSourceInfo("/path/plain/SKILL.md", { source: "test" }),
				disableModelInvocation: false,
			};

			expect(formatSkillsForPrompt([withUndefined])).toBe(formatSkillsForPrompt([absent]));
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".pi/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.pi/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});

		it("should warn when Python skills share an import name", () => {
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
				expect(
					diagnostics.some((d: ResourceDiagnostic) =>
						d.message.includes(
							'python import name "web_search" is shared by skills "web-search" and "web_search"',
						),
					),
				).toBe(true);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
