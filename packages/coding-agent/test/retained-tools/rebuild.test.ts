import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import {
	getToolIndexPath,
	loadToolIndex,
	saveToolIndex,
	type ToolIndex,
	type ToolIndexEntry,
} from "../../src/core/retained-tools/index.js";
import {
	hashDescription,
	readRetainedMeta,
	refreshToolIndexes,
	zeroToolUsage,
} from "../../src/core/retained-tools/rebuild.js";

type RenameSync = (typeof fs)["renameSync"];
type WriteFileSync = (typeof fs)["writeFileSync"];

const fsMocks = vi.hoisted(() => ({
	actualRenameSync: undefined as RenameSync | undefined,
	actualWriteFileSync: undefined as WriteFileSync | undefined,
	renameSync: vi.fn<RenameSync>(),
	writeFileSync: vi.fn<WriteFileSync>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.actualRenameSync = actual.renameSync;
	fsMocks.actualWriteFileSync = actual.writeFileSync;
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		renameSync: fsMocks.renameSync,
		writeFileSync: fsMocks.writeFileSync,
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	fsMocks.writeFileSync.mockReset();
	fsMocks.writeFileSync.mockImplementation(fsMocks.actualWriteFileSync!);
	fsMocks.renameSync.mockReset();
	fsMocks.renameSync.mockImplementation(fsMocks.actualRenameSync!);
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "prime-agent-retained-rebuild-test-"));
	tempDirs.push(dir);
	return dir;
}

/** Write a directory skill (dir + SKILL.md) under skillsRoot; returns the SKILL.md path. */
function writeSkill(skillsRoot: string, name: string, description = "Does the thing.", extraFrontmatter = ""): string {
	const skillDir = join(skillsRoot, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\nBody.`);
	return filePath;
}

function globalSkillsRoot(agentDir: string): string {
	return join(agentDir, "skills");
}

function projectSkillsRoot(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "skills");
}

function seededEntry(overrides: Partial<ToolIndexEntry> = {}): ToolIndexEntry {
	return {
		scope: "project",
		path: `${CONFIG_DIR_NAME}/skills/beta`,
		version: 1,
		status: "active",
		usage: {
			used: 14,
			explicit_ok: 12,
			explicit_fail: 1,
			last_used: "2026-08-19T10:22:00Z",
			last_status: "ok",
			recent_failures: [{ at: "2026-08-14T09:00:00Z", note: "rollout step timed out twice" }],
		},
		description_hash: "sha256:stale-hash",
		embedding: [1, 2, 3],
		...overrides,
	};
}

function seedIndex(toolsDir: string, skills: Record<string, ToolIndexEntry>): void {
	saveToolIndex(toolsDir, {
		schema: 1,
		updated: "2026-08-20T18:00:00Z",
		skills,
		embedding_model: null,
		embedding_dim: null,
	});
}

function expectRebuiltContent(
	entry: ToolIndexEntry,
	scope: "global" | "project",
	path: string,
	description: string,
): void {
	expect(entry.scope).toBe(scope);
	expect(entry.path).toBe(path);
	expect(entry.version).toBe(1);
	expect(entry.status).toBe("active");
	expect(entry.description_hash).toBe(hashDescription(description));
}

describe("refreshToolIndexes (SARK T02: upsert, rebuild, counter merge)", () => {
	it("rebuilds a deleted index from disk with all content fields restored", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(globalSkillsRoot(agentDir), "alpha", "Global alpha.");
		writeSkill(projectSkillsRoot(cwd), "beta", "Project beta.");

		refreshToolIndexes({ cwd, agentDir });
		const globalIndexPath = getToolIndexPath(join(agentDir, "tools"));
		const projectIndexPath = getToolIndexPath(join(cwd, CONFIG_DIR_NAME, "tools"));
		fs.rmSync(globalIndexPath);
		fs.rmSync(projectIndexPath);

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(fs.existsSync(globalIndexPath)).toBe(true);
		expect(fs.existsSync(projectIndexPath)).toBe(true);
		expectRebuiltContent(result.global.skills.alpha, "global", "skills/alpha", "Global alpha.");
		expectRebuiltContent(result.project.skills.beta, "project", `${CONFIG_DIR_NAME}/skills/beta`, "Project beta.");
		expect(result.global.skills.alpha.usage).toEqual(zeroToolUsage());
		expect(result.project.skills.beta.usage).toEqual(zeroToolUsage());
	});

	it("preserves previously recorded counters and embeddings through the merge", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(projectSkillsRoot(cwd), "beta", "Project beta.");
		seedIndex(join(cwd, CONFIG_DIR_NAME, "tools"), { beta: seededEntry() });

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.project.skills.beta.usage).toEqual(seededEntry().usage);
		expect(result.project.skills.beta.embedding).toEqual([1, 2, 3]);
		// Content fields still come from disk, not the stale index.
		expectRebuiltContent(result.project.skills.beta, "project", `${CONFIG_DIR_NAME}/skills/beta`, "Project beta.");
	});

	it("drops the index entry for a deleted skill and keeps the rest", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(projectSkillsRoot(cwd), "beta", "Project beta.");
		seedIndex(join(cwd, CONFIG_DIR_NAME, "tools"), {
			beta: seededEntry(),
			gone: seededEntry({ path: `${CONFIG_DIR_NAME}/skills/gone` }),
		});

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(Object.keys(result.project.skills)).toEqual(["beta"]);
		expect(result.project.skills.beta.usage).toEqual(seededEntry().usage);
	});

	it("resets counters when a skill moves to a new path (merge is keyed by (name, path))", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		seedIndex(join(cwd, CONFIG_DIR_NAME, "tools"), {
			mover: seededEntry({ path: `${CONFIG_DIR_NAME}/skills/mover` }),
		});
		const nestedRoot = join(projectSkillsRoot(cwd), "nested");
		writeSkill(nestedRoot, "mover", "Moved skill.");

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.project.skills.mover.path).toBe(`${CONFIG_DIR_NAME}/skills/nested/mover`);
		expect(result.project.skills.mover.usage).toEqual(zeroToolUsage());
	});

	it("rebuilds a corrupted index from disk", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(projectSkillsRoot(cwd), "beta", "Project beta.");
		const toolsDir = join(cwd, CONFIG_DIR_NAME, "tools");
		fs.mkdirSync(toolsDir, { recursive: true });
		fs.writeFileSync(getToolIndexPath(toolsDir), "{ not json", "utf8");

		const result = refreshToolIndexes({ cwd, agentDir });

		const reloaded = loadToolIndex(toolsDir);
		expect(reloaded.schema).toBe(1);
		expectRebuiltContent(reloaded.skills.beta, "project", `${CONFIG_DIR_NAME}/skills/beta`, "Project beta.");
		expect(result.project.skills.beta.usage).toEqual(zeroToolUsage());
	});

	it("records version and status from the retained frontmatter", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const extra = "metadata:\n  prime-agent:\n    retained:\n      version: 3\n      status: flagged\n";
		writeSkill(projectSkillsRoot(cwd), "gamma", "Versioned.", extra);

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.project.skills.gamma.version).toBe(3);
		expect(result.project.skills.gamma.status).toBe("flagged");
	});

	it("falls back to defaults for invalid retained frontmatter values", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const extra = "metadata:\n  prime-agent:\n    retained:\n      version: -2\n      status: bogus\n";
		writeSkill(projectSkillsRoot(cwd), "gamma", "Invalid meta.", extra);

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.project.skills.gamma.version).toBe(1);
		expect(result.project.skills.gamma.status).toBe("active");
	});

	it("updates description_hash when the skill description changes", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const filePath = writeSkill(projectSkillsRoot(cwd), "beta", "Original description.");
		refreshToolIndexes({ cwd, agentDir });
		const firstHash = loadToolIndex(join(cwd, CONFIG_DIR_NAME, "tools")).skills.beta.description_hash;

		fs.writeFileSync(filePath, `---\nname: beta\ndescription: Changed description.\n---\nBody.`);
		const second = refreshToolIndexes({ cwd, agentDir });

		expect(firstHash).toBe(hashDescription("Original description."));
		expect(second.project.skills.beta.description_hash).toBe(hashDescription("Changed description."));
		expect(second.project.skills.beta.usage).toEqual(zeroToolUsage());
	});

	it("stores file-relative paths for root-level .md skills so entries stay distinct", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const skillsRoot = projectSkillsRoot(cwd);
		fs.mkdirSync(skillsRoot, { recursive: true });
		fs.writeFileSync(join(skillsRoot, "a.md"), "---\nname: a\ndescription: A.\n---\nBody.");
		fs.writeFileSync(join(skillsRoot, "b.md"), "---\nname: b\ndescription: B.\n---\nBody.");

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.project.skills.a.path).toBe(`${CONFIG_DIR_NAME}/skills/a.md`);
		expect(result.project.skills.b.path).toBe(`${CONFIG_DIR_NAME}/skills/b.md`);
	});

	it("still refreshes the project index when the global index write fails", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(globalSkillsRoot(agentDir), "alpha", "Global alpha.");
		writeSkill(projectSkillsRoot(cwd), "beta", "Project beta.");
		const globalToolsDir = join(agentDir, "tools");
		fsMocks.writeFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
			if (String(args[0]).startsWith(globalToolsDir)) {
				throw new Error("EACCES (simulated)");
			}
			return fsMocks.actualWriteFileSync!(...args);
		});

		const result = refreshToolIndexes({ cwd, agentDir });

		expect(result.global.skills).toEqual({});
		expect(result.project.skills.beta).toBeDefined();
		expect(fs.existsSync(join(cwd, CONFIG_DIR_NAME, "tools", "index.json"))).toBe(true);
	});
});

describe("readRetainedMeta", () => {
	it("returns defaults for a skill file without retained frontmatter", () => {
		const file = makeTempDir();
		const p = join(file, "SKILL.md");
		fs.writeFileSync(p, "---\nname: x\ndescription: D.\n---\nBody.");
		expect(readRetainedMeta(p)).toEqual({ version: 1, status: "active" });
	});

	it("returns defaults for an unreadable or frontmatter-less file", () => {
		const file = makeTempDir();
		const missing = join(file, "nope.md");
		const noFm = join(file, "no-fm.md");
		fs.writeFileSync(noFm, "Just a body, no frontmatter.");
		expect(readRetainedMeta(missing)).toEqual({ version: 1, status: "active" });
		expect(readRetainedMeta(noFm)).toEqual({ version: 1, status: "active" });
	});

	it("parses valid retained frontmatter", () => {
		const file = makeTempDir();
		const p = join(file, "SKILL.md");
		fs.writeFileSync(
			p,
			"---\nname: x\ndescription: D.\nmetadata:\n  prime-agent:\n    retained:\n      version: 7\n      status: disabled\n---\nBody.",
		);
		expect(readRetainedMeta(p)).toEqual({ version: 7, status: "disabled" });
	});
});

describe("hashDescription", () => {
	it("is stable, prefixed, and input-sensitive", () => {
		const a = hashDescription("same");
		expect(a).toBe(hashDescription("same"));
		expect(a.startsWith("sha256:")).toBe(true);
		expect(a).not.toBe(hashDescription("different"));
	});
});

describe("DefaultResourceLoader integration", () => {
	it("reload() refreshes both per-scope tool indexes from disk", async () => {
		const tempDir = makeTempDir();
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		fs.mkdirSync(join(agentDir, "skills", "gamma"), { recursive: true });
		fs.writeFileSync(
			join(agentDir, "skills", "gamma", "SKILL.md"),
			"---\nname: gamma\ndescription: Gamma.\n---\nBody.",
		);
		fs.mkdirSync(join(cwd, CONFIG_DIR_NAME, "skills", "delta"), { recursive: true });
		fs.writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "skills", "delta", "SKILL.md"),
			"---\nname: delta\ndescription: Delta.\n---\nBody.",
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const globalIndex: ToolIndex = loadToolIndex(join(agentDir, "tools"));
		const projectIndex: ToolIndex = loadToolIndex(join(cwd, CONFIG_DIR_NAME, "tools"));
		expect(globalIndex.skills.gamma).toBeDefined();
		expect(globalIndex.skills.gamma.path).toBe("skills/gamma");
		expect(projectIndex.skills.delta).toBeDefined();
		expect(projectIndex.skills.delta.path).toBe(`${CONFIG_DIR_NAME}/skills/delta`);
	});

	it("reload() does not throw when the index write fails", async () => {
		const tempDir = makeTempDir();
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		fs.mkdirSync(join(agentDir, "tools"), { recursive: true });
		fsMocks.writeFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
			if (String(args[0]).startsWith(join(agentDir, "tools"))) {
				throw new Error("EACCES (simulated)");
			}
			return fsMocks.actualWriteFileSync!(...args);
		});

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await expect(loader.reload()).resolves.toBeUndefined();
	});
});
