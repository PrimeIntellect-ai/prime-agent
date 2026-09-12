import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { canonicalizePath } from "../utils/paths.js";
import type { MarkdownSkill, PythonSkill, Skill } from "./skills.js";

/**
 * Trust decisions for project-scoped Python skills.
 *
 * A project Python skill (`<cwd>/.prime/agent/skills/<name>/pyproject.toml`, or a
 * Python skill added by the project's settings) is code from the repository being
 * opened. Installing it runs its build backend and importing it runs its module
 * code inside the kernel, so neither happens until the user trusts the project.
 * Decisions are persisted per canonical project path in the agent dir; a project
 * without a decision is treated as untrusted.
 */

export type ProjectSkillTrustDecision = "trusted" | "denied" | "undecided";
export type ProjectSkillTrustChoice = Exclude<ProjectSkillTrustDecision, "undecided">;

export const PROJECT_SKILL_TRUST_FILE = "project-skill-trust.json";
export const PROJECT_SKILL_TRUST_COMMAND = "trust-project-skills";

interface ProjectSkillTrustRecord {
	decision: ProjectSkillTrustChoice;
	decidedAt: string;
}

interface ProjectSkillTrustFile {
	version: 1;
	projects: Record<string, ProjectSkillTrustRecord>;
}

export interface ProjectSkillTrustStore {
	/** Where decisions are persisted; undefined for in-memory stores. */
	readonly path?: string;
	getDecision(projectDir: string): ProjectSkillTrustDecision;
	setDecision(projectDir: string, decision: ProjectSkillTrustChoice): void;
	clearDecision(projectDir: string): void;
}

export function projectSkillTrustKey(projectDir: string): string {
	return canonicalizePath(resolve(projectDir));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyTrustFile(): ProjectSkillTrustFile {
	return { version: 1, projects: {} };
}

function parseTrustFile(raw: string): ProjectSkillTrustFile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.projects)) {
		return emptyTrustFile();
	}
	const projects: Record<string, ProjectSkillTrustRecord> = {};
	for (const [key, value] of Object.entries(parsed.projects)) {
		if (!isRecord(value)) continue;
		if (value.decision !== "trusted" && value.decision !== "denied") continue;
		projects[key] = {
			decision: value.decision,
			decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : new Date(0).toISOString(),
		};
	}
	return { version: 1, projects };
}

class FileProjectSkillTrustStore implements ProjectSkillTrustStore {
	constructor(readonly path: string) {}

	private read(): ProjectSkillTrustFile {
		if (!existsSync(this.path)) return emptyTrustFile();
		try {
			return parseTrustFile(readFileSync(this.path, "utf8"));
		} catch {
			// An unreadable or corrupt store must fail closed: nothing is trusted.
			return emptyTrustFile();
		}
	}

	private write(file: ProjectSkillTrustFile): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileAtomicSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	}

	getDecision(projectDir: string): ProjectSkillTrustDecision {
		return this.read().projects[projectSkillTrustKey(projectDir)]?.decision ?? "undecided";
	}

	setDecision(projectDir: string, decision: ProjectSkillTrustChoice): void {
		const file = this.read();
		file.projects[projectSkillTrustKey(projectDir)] = { decision, decidedAt: new Date().toISOString() };
		this.write(file);
	}

	clearDecision(projectDir: string): void {
		const file = this.read();
		const key = projectSkillTrustKey(projectDir);
		if (!(key in file.projects)) return;
		delete file.projects[key];
		this.write(file);
	}
}

class InMemoryProjectSkillTrustStore implements ProjectSkillTrustStore {
	readonly path = undefined;
	private readonly decisions = new Map<string, ProjectSkillTrustChoice>();

	getDecision(projectDir: string): ProjectSkillTrustDecision {
		return this.decisions.get(projectSkillTrustKey(projectDir)) ?? "undecided";
	}

	setDecision(projectDir: string, decision: ProjectSkillTrustChoice): void {
		this.decisions.set(projectSkillTrustKey(projectDir), decision);
	}

	clearDecision(projectDir: string): void {
		this.decisions.delete(projectSkillTrustKey(projectDir));
	}
}

export function createProjectSkillTrustStore(agentDir: string): ProjectSkillTrustStore {
	return new FileProjectSkillTrustStore(join(agentDir, PROJECT_SKILL_TRUST_FILE));
}

export function createInMemoryProjectSkillTrustStore(): ProjectSkillTrustStore {
	return new InMemoryProjectSkillTrustStore();
}

/** Python skills whose code comes from the opened project rather than the user's own config. */
export function isProjectPythonSkill(skill: Skill): skill is PythonSkill {
	return skill.kind === "python" && skill.sourceInfo.scope === "project";
}

export function getProjectPythonSkills(skills: readonly Skill[]): PythonSkill[] {
	return skills.filter(isProjectPythonSkill);
}

/**
 * Keep the SKILL.md of an untrusted project Python skill readable but strip the
 * Python half, so it neither reaches the kernel bootstrap nor advertises a
 * `python_import` the kernel does not provide.
 */
export function downgradeProjectPythonSkill(skill: PythonSkill): MarkdownSkill {
	return {
		kind: "markdown",
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		sourceInfo: skill.sourceInfo,
		disableModelInvocation: skill.disableModelInvocation,
	};
}

/**
 * Apply the project's trust decision to a skill list. The decision is resolved
 * lazily so sessions without project Python skills never touch the store.
 */
export function applyProjectSkillTrust(
	skills: readonly Skill[],
	getDecision: () => ProjectSkillTrustDecision,
): Skill[] {
	if (!skills.some(isProjectPythonSkill)) return [...skills];
	if (getDecision() === "trusted") return [...skills];
	return skills.map((skill) => (isProjectPythonSkill(skill) ? downgradeProjectPythonSkill(skill) : skill));
}

export interface ProjectSkillTrustStatus {
	decision: ProjectSkillTrustDecision;
	/** Project Python skills discovered for the current project (trusted or not). */
	skills: Array<{ name: string; importName: string; packagePath: string }>;
}

export function describeProjectSkillTrust(
	skills: readonly Skill[],
	decision: ProjectSkillTrustDecision,
): ProjectSkillTrustStatus {
	return {
		decision,
		skills: getProjectPythonSkills(skills).map((skill) => ({
			name: skill.name,
			importName: skill.python.importName,
			packagePath: skill.python.packagePath,
		})),
	};
}

export const PROJECT_SKILL_TRUST_CHOICES = {
	trust: "Trust and install",
	notNow: "Not now (ask again next time)",
	never: "Never for this project",
} as const;

export function formatProjectSkillTrustPrompt(skillNames: readonly string[]): string {
	const list = skillNames.join(", ");
	return [
		`This project provides Python skills: ${list}`,
		"Installing them builds packages from this repository and imports their code in the Python kernel.",
		`Trust this project's Python skills? Change later with /${PROJECT_SKILL_TRUST_COMMAND}.`,
	].join("\n");
}
