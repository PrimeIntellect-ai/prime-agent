import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyProjectSkillTrust,
	createInMemoryProjectSkillTrustStore,
	createProjectSkillTrustStore,
	describeProjectSkillTrust,
	getProjectPythonSkills,
	isProjectPythonSkill,
	PROJECT_SKILL_TRUST_FILE,
	projectSkillTrustKey,
} from "../src/core/project-skill-trust.js";
import type { PythonSkill, Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo, type SourceScope } from "../src/core/source-info.js";

let tempDir = "";

function pythonSkill(name: string, scope: SourceScope): PythonSkill {
	const skillDir = join(tempDir, scope, name);
	const filePath = join(skillDir, "SKILL.md");
	return {
		kind: "python",
		name,
		description: `${name} skill`,
		filePath,
		baseDir: skillDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope, baseDir: skillDir }),
		disableModelInvocation: false,
		python: {
			importName: name.replaceAll("-", "_"),
			packagePath: skillDir,
			pyprojectPath: join(skillDir, "pyproject.toml"),
		},
	};
}

function markdownSkill(name: string, scope: SourceScope): Skill {
	const skillDir = join(tempDir, scope, name);
	const filePath = join(skillDir, "SKILL.md");
	return {
		kind: "markdown",
		name,
		description: `${name} skill`,
		filePath,
		baseDir: skillDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope, baseDir: skillDir }),
		disableModelInvocation: false,
	};
}

describe("project skill trust store", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-project-skill-trust-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("treats projects without a decision as undecided and persists decisions per project", () => {
		const agentDir = join(tempDir, "agent");
		const projectA = join(tempDir, "a");
		const projectB = join(tempDir, "b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		const store = createProjectSkillTrustStore(agentDir);

		expect(store.getDecision(projectA)).toBe("undecided");
		expect(existsSync(join(agentDir, PROJECT_SKILL_TRUST_FILE))).toBe(false);

		store.setDecision(projectA, "trusted");
		store.setDecision(projectB, "denied");

		expect(store.getDecision(projectA)).toBe("trusted");
		expect(store.getDecision(projectB)).toBe("denied");
		expect(createProjectSkillTrustStore(agentDir).getDecision(projectA)).toBe("trusted");
		const file = JSON.parse(readFileSync(join(agentDir, PROJECT_SKILL_TRUST_FILE), "utf8"));
		expect(file.version).toBe(1);
		expect(file.projects[projectSkillTrustKey(projectA)]).toMatchObject({ decision: "trusted" });
		if (process.platform !== "win32") {
			expect(statSync(join(agentDir, PROJECT_SKILL_TRUST_FILE)).mode & 0o777).toBe(0o600);
		}

		store.clearDecision(projectA);
		expect(store.getDecision(projectA)).toBe("undecided");
		expect(store.getDecision(projectB)).toBe("denied");
	});

	it("keys decisions by the canonical project path", () => {
		const agentDir = join(tempDir, "agent");
		const project = join(tempDir, "real-project");
		const link = join(tempDir, "linked-project");
		mkdirSync(project, { recursive: true });
		symlinkSync(project, link, "dir");
		const store = createProjectSkillTrustStore(agentDir);

		store.setDecision(link, "trusted");

		expect(store.getDecision(project)).toBe("trusted");
		expect(store.getDecision(`${project}/`)).toBe("trusted");
		expect(store.getDecision(join(tempDir, "other"))).toBe("undecided");
	});

	it("fails closed on a corrupt or unreadable store", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const path = join(agentDir, PROJECT_SKILL_TRUST_FILE);
		writeFileSync(path, "{ not json");
		const store = createProjectSkillTrustStore(agentDir);
		expect(store.getDecision(tempDir)).toBe("undecided");

		writeFileSync(
			path,
			JSON.stringify({ version: 1, projects: { [projectSkillTrustKey(tempDir)]: { decision: "yes" } } }),
		);
		expect(store.getDecision(tempDir)).toBe("undecided");

		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			writeFileSync(
				path,
				JSON.stringify({ version: 1, projects: { [projectSkillTrustKey(tempDir)]: { decision: "trusted" } } }),
			);
			chmodSync(path, 0o000);
			try {
				expect(store.getDecision(tempDir)).toBe("undecided");
			} finally {
				chmodSync(path, 0o600);
			}
		}
	});

	it("keeps in-memory decisions out of the filesystem", () => {
		const store = createInMemoryProjectSkillTrustStore();
		store.setDecision(tempDir, "trusted");
		expect(store.getDecision(tempDir)).toBe("trusted");
		expect(store.path).toBeUndefined();
		expect(existsSync(join(tempDir, PROJECT_SKILL_TRUST_FILE))).toBe(false);
	});
});

describe("applyProjectSkillTrust", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-project-skill-trust-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("only classifies project-scoped Python skills as project Python skills", () => {
		const projectPython = pythonSkill("marker-skill", "project");
		const userPython = pythonSkill("web-search", "user");
		const projectMarkdown = markdownSkill("notes", "project");

		expect(isProjectPythonSkill(projectPython)).toBe(true);
		expect(isProjectPythonSkill(userPython)).toBe(false);
		expect(isProjectPythonSkill(projectMarkdown)).toBe(false);
		expect(getProjectPythonSkills([projectPython, userPython, projectMarkdown])).toEqual([projectPython]);
	});

	it("downgrades project Python skills to markdown unless the project is trusted", () => {
		const projectPython = pythonSkill("marker-skill", "project");
		const userPython = pythonSkill("web-search", "user");
		const projectMarkdown = markdownSkill("notes", "project");
		const skills = [projectPython, userPython, projectMarkdown];

		for (const decision of ["undecided", "denied"] as const) {
			const applied = applyProjectSkillTrust(skills, () => decision);
			expect(applied.map((skill) => skill.kind)).toEqual(["markdown", "python", "markdown"]);
			expect(applied[0]).toMatchObject({
				kind: "markdown",
				name: "marker-skill",
				filePath: projectPython.filePath,
				sourceInfo: projectPython.sourceInfo,
			});
			expect((applied[0] as { python?: unknown }).python).toBeUndefined();
			expect(applied[1]).toBe(userPython);
			expect(applied[2]).toBe(projectMarkdown);
		}

		const trusted = applyProjectSkillTrust(skills, () => "trusted");
		expect(trusted).toEqual(skills);
	});

	it("does not consult the store when no project Python skill is present", () => {
		let consulted = 0;
		const applied = applyProjectSkillTrust(
			[pythonSkill("web-search", "user"), markdownSkill("notes", "project")],
			() => {
				consulted += 1;
				return "denied";
			},
		);
		expect(consulted).toBe(0);
		expect(applied.map((skill) => skill.kind)).toEqual(["python", "markdown"]);
	});

	it("describes the project Python skills a decision applies to", () => {
		const projectPython = pythonSkill("marker-skill", "project");
		expect(describeProjectSkillTrust([projectPython, pythonSkill("web-search", "user")], "denied")).toEqual({
			decision: "denied",
			skills: [
				{
					name: "marker-skill",
					importName: "marker_skill",
					packagePath: projectPython.python.packagePath,
				},
			],
		});
	});
});
