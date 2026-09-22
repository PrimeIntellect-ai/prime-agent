import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ProgressEvent, type ResolvedResource } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { shouldUseWindowsShell } from "../src/utils/child-process.js";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function pathEndsWith(actualPath: string, suffix: string): boolean {
	return normalizeForMatch(actualPath).endsWith(normalizeForMatch(suffix));
}

class MockSpawnedProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();

	kill(): boolean {
		this.emit("close", null, "SIGTERM");
		return true;
	}
}

const isEnabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && r.enabled
		: normalizedPath.includes(normalizedMatch) && r.enabled;
};

const isDisabled = (r: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") => {
	const normalizedPath = normalizeForMatch(r.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !r.enabled
		: normalizedPath.includes(normalizedMatch) && !r.enabled;
};

type PatternResourceKind = "extensions" | "skills" | "prompts" | "themes";
type ResourceExpectation = Record<string, "enabled" | "disabled" | "absent">;

const RESOURCE_FILE_BODY: Record<Exclude<PatternResourceKind, "skills">, string> = {
	extensions: "export default function() {}",
	prompts: "Prompt body",
	themes: "{}",
};

/** Write one resource fixture: skills are directories with SKILL.md, everything else is a single file. */
function writeResourceFixture(root: string, kind: PatternResourceKind, relPath: string): void {
	if (kind === "skills") {
		mkdirSync(join(root, relPath), { recursive: true });
		const name = relPath.split("/").pop() ?? relPath;
		writeFileSync(join(root, relPath, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nContent`);
		return;
	}
	const target = join(root, relPath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, RESOURCE_FILE_BODY[kind]);
}

function expectResourceStates(
	resources: ResolvedResource[],
	kind: PatternResourceKind,
	expected: ResourceExpectation,
): void {
	const matchFn = kind === "skills" ? "includes" : "endsWith";
	for (const [name, state] of Object.entries(expected)) {
		if (state === "absent") {
			expect(resources.some((r) => normalizeForMatch(r.path).includes(normalizeForMatch(name)))).toBe(false);
			continue;
		}
		const matches = state === "enabled" ? isEnabled : isDisabled;
		expect(resources.some((r) => matches(r, name, matchFn))).toBe(true);
	}
}

function setTopLevelPatterns(settings: SettingsManager, kind: PatternResourceKind, patterns: string[]): void {
	if (kind === "extensions") settings.setExtensionPaths(patterns);
	else if (kind === "skills") settings.setSkillPaths(patterns);
	else if (kind === "prompts") settings.setPromptTemplatePaths(patterns);
	else settings.setThemePaths(patterns);
}

interface PatternCase {
	name: string;
	kind: PatternResourceKind;
	files: string[];
	patterns: string[];
	expected: ResourceExpectation;
}

describe("DefaultPackageManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolve", () => {
		it("should return no package-sourced paths when no sources configured", async () => {
			const result = await packageManager.resolve();
			expect(result.extensions).toEqual([]);
			expect(result.prompts).toEqual([]);
			expect(result.themes).toEqual([]);
			expect(result.skills.every((r) => r.metadata.source === "auto" && r.metadata.origin === "top-level")).toBe(
				true,
			);
		});

		it("should resolve local extension paths from settings", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "my-extension.ts");
			writeFileSync(extPath, "export default function() {}");
			settingsManager.setExtensionPaths(["extensions/my-extension.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should resolve skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(
				skillFile,
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should auto-discover root markdown skills from .pi skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(
				skillFile,
				`---
name: single-file
description: A root markdown skill
---
Content`,
			);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("should resolve project paths relative to .pi", async () => {
			const extDir = join(tempDir, ".prime", "agent", "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "project-ext.ts");
			writeFileSync(extPath, "export default function() {}");

			settingsManager.setProjectExtensionPaths(["extensions/project-ext.ts"]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should auto-discover user prompts with overrides", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "auto.md");
			writeFileSync(promptPath, "Auto prompt");

			settingsManager.setPromptTemplatePaths(["!prompts/auto.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve symlinked user and project resources once", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const sharedDir = join(tempDir, "shared-resources");
				const sharedExtensionsDir = join(sharedDir, "extensions");
				const sharedSkillsDir = join(sharedDir, "skills");
				const sharedPromptsDir = join(sharedDir, "prompts");
				const sharedThemesDir = join(sharedDir, "themes");
				mkdirSync(sharedExtensionsDir, { recursive: true });
				mkdirSync(sharedSkillsDir, { recursive: true });
				mkdirSync(sharedPromptsDir, { recursive: true });
				mkdirSync(sharedThemesDir, { recursive: true });

				writeFileSync(join(sharedExtensionsDir, "shared.ts"), "export default function() {}");
				mkdirSync(join(sharedSkillsDir, "shared-skill"), { recursive: true });
				writeFileSync(
					join(sharedSkillsDir, "shared-skill", "SKILL.md"),
					`---
name: shared-skill
description: Shared skill
---
Content`,
				);
				writeFileSync(join(sharedPromptsDir, "shared.md"), "Shared prompt");
				writeFileSync(join(sharedThemesDir, "shared.json"), JSON.stringify({ name: "shared-theme" }));

				mkdirSync(join(agentDir), { recursive: true });
				mkdirSync(join(tempDir, ".prime", "agent"), { recursive: true });
				symlinkSync(sharedExtensionsDir, join(agentDir, "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(agentDir, "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(agentDir, "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(agentDir, "themes"), "dir");
				symlinkSync(sharedExtensionsDir, join(tempDir, ".prime", "agent", "extensions"), "dir");
				symlinkSync(sharedSkillsDir, join(tempDir, ".prime", "agent", "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(tempDir, ".prime", "agent", "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(tempDir, ".prime", "agent", "themes"), "dir");

				const result = await packageManager.resolve();

				expect({
					extensions: result.extensions.length,
					skills: result.skills.length,
					prompts: result.prompts.length,
					themes: result.themes.length,
				}).toEqual({
					extensions: 1,
					skills: 1,
					prompts: 1,
					themes: 1,
				});

				expect(result.extensions[0].metadata.scope).toBe("project");
				expect(result.skills[0].metadata.scope).toBe("project");
				expect(result.prompts[0].metadata.scope).toBe("project");
				expect(result.themes[0].metadata.scope).toBe("project");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should auto-discover project prompts with overrides", async () => {
			const promptsDir = join(tempDir, ".prime", "agent", "prompts");
			mkdirSync(promptsDir, { recursive: true });
			const promptPath = join(promptsDir, "is.md");
			writeFileSync(promptPath, "Is prompt");

			settingsManager.setProjectPromptTemplatePaths(["!prompts/is.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && !r.enabled)).toBe(true);
		});

		it("should resolve directory with package.json pi.extensions in extensions setting", async () => {
			const pkgDir = join(tempDir, "my-extensions-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-extensions-pkg",
					pi: {
						extensions: ["./extensions/clip.ts", "./extensions/cost.ts"],
					},
				}),
			);
			writeFileSync(join(pkgDir, "extensions", "clip.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "cost.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "helper.ts"), "export const x = 1;"); // Not in manifest, shouldn't be loaded

			settingsManager.setExtensionPaths([pkgDir]);

			const result = await packageManager.resolve();

			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "clip.ts") && r.enabled)).toBe(
				true,
			);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "extensions", "cost.ts") && r.enabled)).toBe(
				true,
			);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "helper.ts"))).toBe(false);
		});
	});

	describe(".agents/skills auto-discovery", () => {
		it("should scan .agents/skills from cwd up to git repo root", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const aboveRepoSkill = join(tempDir, ".agents", "skills", "above-repo", "SKILL.md");
			mkdirSync(join(tempDir, ".agents", "skills", "above-repo"), { recursive: true });
			writeFileSync(aboveRepoSkill, "---\nname: above-repo\ndescription: above\n---\n");

			const repoRootSkill = join(repoRoot, ".agents", "skills", "repo-root", "SKILL.md");
			mkdirSync(join(repoRoot, ".agents", "skills", "repo-root"), { recursive: true });
			writeFileSync(repoRootSkill, "---\nname: repo-root\ndescription: repo\n---\n");

			const nestedSkill = join(repoRoot, "packages", ".agents", "skills", "nested", "SKILL.md");
			mkdirSync(join(repoRoot, "packages", ".agents", "skills", "nested"), { recursive: true });
			writeFileSync(nestedSkill, "---\nname: nested\ndescription: nested\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === repoRootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === aboveRepoSkill)).toBe(false);
		});

		it("should scan .agents/skills up to filesystem root when not in a git repo", async () => {
			const nonRepoRoot = join(tempDir, "non-repo");
			const nestedCwd = join(nonRepoRoot, "a", "b");
			mkdirSync(nestedCwd, { recursive: true });

			const rootSkill = join(nonRepoRoot, ".agents", "skills", "root", "SKILL.md");
			mkdirSync(join(nonRepoRoot, ".agents", "skills", "root"), { recursive: true });
			writeFileSync(rootSkill, "---\nname: root\ndescription: root\n---\n");

			const middleSkill = join(nonRepoRoot, "a", ".agents", "skills", "middle", "SKILL.md");
			mkdirSync(join(nonRepoRoot, "a", ".agents", "skills", "middle"), { recursive: true });
			writeFileSync(middleSkill, "---\nname: middle\ndescription: middle\n---\n");

			const pm = new DefaultPackageManager({
				cwd: nestedCwd,
				agentDir,
				settingsManager,
			});

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === middleSkill && r.enabled)).toBe(true);
		});

		it("should ignore root markdown files in .agents/skills", async () => {
			const agentsSkillsDir = join(tempDir, ".agents", "skills");
			mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
			const rootSkill = join(agentsSkillsDir, "root-file.md");
			const nestedSkill = join(agentsSkillsDir, "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const pm = new DefaultPackageManager({
				cwd: join(tempDir, "work"),
				agentDir,
				settingsManager,
			});
			mkdirSync(join(tempDir, "work"), { recursive: true });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
		});

		it("should keep ~/.agents/skills user-scoped when cwd is under home in a non-git directory", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const cwd = join(tempDir, "scratch", "nested");
				const localAgentDir = join(tempDir, ".prime", "agent");
				const localSettingsManager = SettingsManager.inMemory();
				mkdirSync(cwd, { recursive: true });
				mkdirSync(localAgentDir, { recursive: true });

				const homeSkill = join(tempDir, ".agents", "skills", "home-skill", "SKILL.md");
				mkdirSync(join(tempDir, ".agents", "skills", "home-skill"), { recursive: true });
				writeFileSync(homeSkill, "---\nname: home-skill\ndescription: home\n---\n");

				const pm = new DefaultPackageManager({
					cwd,
					agentDir: localAgentDir,
					settingsManager: localSettingsManager,
				});

				const result = await pm.resolve();
				const matchingSkills = result.skills.filter((r) => r.path === homeSkill);
				expect(matchingSkills).toHaveLength(1);
				expect(matchingSkills[0]?.enabled).toBe(true);
				expect(matchingSkills[0]?.metadata.scope).toBe("user");
				expect(matchingSkills[0]?.metadata.source).toBe("auto");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});

		it("should dedupe user skill entries when ~/.pi/agent/skills is a symlink to ~/.agents/skills", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const agentSkillsDir = join(agentDir, "skills");
				const agentsSkillsDir = join(tempDir, ".agents", "skills");
				mkdirSync(agentsSkillsDir, { recursive: true });
				// Use junction on Windows to avoid EPERM when symlink privileges are unavailable.
				const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
				symlinkSync(agentsSkillsDir, agentSkillsDir, directoryLinkType);

				const skillPath = join(agentsSkillsDir, "foo", "SKILL.md");
				mkdirSync(join(agentsSkillsDir, "foo"), { recursive: true });
				writeFileSync(skillPath, "---\nname: foo\ndescription: foo\n---\n");

				const result = await packageManager.resolve();
				const fooSkills = result.skills.filter((r) => pathEndsWith(r.path, "foo/SKILL.md"));

				expect(fooSkills).toHaveLength(1);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe("ignore files", () => {
		it("should respect .gitignore in skill directories", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n__pycache__\n");

			const goodSkillDir = join(skillsDir, "good-skill");
			mkdirSync(goodSkillDir, { recursive: true });
			writeFileSync(join(goodSkillDir, "SKILL.md"), "---\nname: good-skill\ndescription: Good\n---\nContent");

			const ignoredSkillDir = join(skillsDir, "venv", "bad-skill");
			mkdirSync(ignoredSkillDir, { recursive: true });
			writeFileSync(join(ignoredSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path.includes("good-skill") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path.includes("venv") && r.enabled)).toBe(false);
		});

		it("should not apply parent .gitignore to .pi auto-discovery", async () => {
			writeFileSync(join(tempDir, ".gitignore"), ".prime/agent\n");

			const skillDir = join(tempDir, ".prime", "agent", "skills", "auto-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillPath = join(skillDir, "SKILL.md");
			writeFileSync(skillPath, "---\nname: auto-skill\ndescription: Auto\n---\nContent");

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillPath && r.enabled)).toBe(true);
		});
	});

	describe("resolveExtensionSources", () => {
		it("should resolve local paths", async () => {
			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			const result = await packageManager.resolveExtensionSources([extPath]);
			expect(result.extensions.some((r) => r.path === extPath && r.enabled)).toBe(true);
		});

		it("should handle directories with pi manifest", async () => {
			const pkgDir = join(tempDir, "my-package");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "my-package",
					pi: {
						extensions: ["./src/index.ts"],
						skills: ["./skills"],
					},
				}),
			);
			mkdirSync(join(pkgDir, "src"), { recursive: true });
			writeFileSync(join(pkgDir, "src", "index.ts"), "export default function() {}");
			mkdirSync(join(pkgDir, "skills", "my-skill"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills", "my-skill", "SKILL.md"),
				"---\nname: my-skill\ndescription: Test\n---\nContent",
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => r.path === join(pkgDir, "src", "index.ts") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === join(pkgDir, "skills", "my-skill", "SKILL.md") && r.enabled)).toBe(
				true,
			);
		});

		it("should handle directories with auto-discovery layout", async () => {
			const pkgDir = join(tempDir, "auto-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "main.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "themes", "dark.json"), "{}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "main.ts") && r.enabled)).toBe(true);
			expect(result.themes.some((r) => pathEndsWith(r.path, "dark.json") && r.enabled)).toBe(true);
		});

		it("should stop recursing when a package skill directory contains SKILL.md", async () => {
			const pkgDir = join(tempDir, "skill-root-pkg");
			mkdirSync(join(pkgDir, "skills", "root-skill", "nested-skill"), { recursive: true });
			const rootSkill = join(pkgDir, "skills", "root-skill", "SKILL.md");
			const nestedSkill = join(pkgDir, "skills", "root-skill", "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-skill\ndescription: Root skill\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => r.path === rootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill)).toBe(false);
		});
	});

	describe("progress callback", () => {
		it("should emit progress events", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			const extPath = join(tempDir, "ext.ts");
			writeFileSync(extPath, "export default function() {}");

			await packageManager.resolveExtensionSources([extPath]);

			expect(events.length).toBe(0);
		});
	});

	describe("windows command spawning", () => {
		it("should avoid the shell for git so Windows paths with spaces stay single arguments", () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");

			expect(shouldUseWindowsShell("git")).toBe(false);
			expect(shouldUseWindowsShell("npm")).toBe(true);
			expect(shouldUseWindowsShell("pnpm")).toBe(true);
			expect(shouldUseWindowsShell("C:/Program Files/nodejs/npm.cmd")).toBe(true);
		});
	});

	describe("npmCommand", () => {
		it("should use npmCommand argv for npm installs", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.install("npm:@scope/pkg");

			expect(runCommandSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "install", "-g", "@scope/pkg"],
				undefined,
			);
		});

		it.each([
			{
				name: "npm with --omit=dev by default",
				npmCommand: undefined,
				expected: ["npm", ["install", "--omit=dev"]],
			},
			{
				name: "a plain install through the configured npmCommand",
				npmCommand: ["pnpm"],
				expected: ["pnpm", ["install"]],
			},
		])("installs git package dependencies with $name", async ({ npmCommand, expected }) => {
			if (npmCommand) {
				settingsManager = SettingsManager.inMemory({ npmCommand });
				packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
			}
			const source = "git:github.com/user/repo";
			const targetDir = join(agentDir, "git", "github.com", "user", "repo");
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command === "git" && args[0] === "clone") {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
					}
				});

			await packageManager.install(source);

			expect(runCommandSpy).toHaveBeenCalledWith(expected[0], expected[1], { cwd: targetDir });
		});

		it.each([
			{
				name: "npm with --omit=dev by default",
				npmCommand: undefined,
				expected: ["npm", ["install", "--omit=dev"]],
			},
			{
				name: "a plain install through the configured npmCommand argv",
				npmCommand: ["mise", "exec", "node@20", "--", "pnpm"],
				expected: ["mise", ["exec", "node@20", "--", "pnpm", "install"]],
			},
		])("updates git package dependencies with $name", async ({ npmCommand, expected }) => {
			if (npmCommand) {
				settingsManager = SettingsManager.inMemory({ npmCommand });
				packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
			}
			const source = "git:github.com/user/repo";
			const targetDir = join(tempDir, ".prime", "agent", "git", "github.com", "user", "repo");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }));
			settingsManager.setProjectPackages([source]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockImplementation(async (...callArgs: unknown[]) => {
				const [_command, args] = callArgs as [string, string[]];
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}")
					return "origin/main";
				if (args[0] === "rev-parse" && args[1] === "@{upstream}") return "remote-head";
				if (args[0] === "rev-parse" && args[1] === "HEAD") return "local-head";
				throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
			});
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update(source);

			expect(runCommandSpy).toHaveBeenCalledWith(expected[0], expected[1], { cwd: targetDir });
		});

		it("should use npmCommand argv for npm root lookup and invalidate cached root when npmCommand changes", () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const root20 = join(tempDir, "node20", "lib", "node_modules");
			const root22 = join(tempDir, "node22", "lib", "node_modules");
			mkdirSync(join(root20, "@scope", "pkg"), { recursive: true });

			const runCommandSyncSpy = vi
				.spyOn(packageManager as any, "runCommandSync")
				.mockImplementation((...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "mise") {
						throw new Error(`unexpected command ${command}`);
					}
					if (args[1] === "node@20") {
						return root20;
					}
					if (args[1] === "node@22") {
						return root22;
					}
					throw new Error(`unexpected args ${args.join(" ")}`);
				});

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBe(join(root20, "@scope", "pkg"));
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(1, "mise", ["exec", "node@20", "--", "npm", "root", "-g"]);

			settingsManager.setNpmCommand(["mise", "exec", "node@22", "--", "npm"]);

			expect(packageManager.getInstalledPath("npm:@scope/pkg", "user")).toBeUndefined();
			expect(runCommandSyncSpy).toHaveBeenNthCalledWith(2, "mise", ["exec", "node@22", "--", "npm", "root", "-g"]);
		});
	});

	describe("source parsing", () => {
		it("should emit progress events on install attempt", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));

			try {
				await packageManager.install("npm:nonexistent-package@1.0.0");
			} catch {}

			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
			expect(events.some((e) => e.type === "error")).toBe(true);
		});

		it("should recognize github URLs without git: prefix", async () => {
			const events: ProgressEvent[] = [];
			packageManager.setProgressCallback((event) => events.push(event));
			const previousGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
			process.env.GIT_TERMINAL_PROMPT = "0";

			try {
				try {
					await packageManager.install("https://github.com/nonexistent/repo");
				} catch {}
			} finally {
				if (previousGitTerminalPrompt === undefined) {
					delete process.env.GIT_TERMINAL_PROMPT;
				} else {
					process.env.GIT_TERMINAL_PROMPT = previousGitTerminalPrompt;
				}
			}

			expect(events.some((e) => e.type === "start" && e.action === "install")).toBe(true);
		});

		it("should parse package source types from docs examples", () => {
			expect((packageManager as any).parseSource("npm:@scope/pkg@1.2.3").type).toBe("npm");
			expect((packageManager as any).parseSource("npm:pkg").type).toBe("npm");

			expect((packageManager as any).parseSource("git:github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("https://github.com/user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("git:git@github.com:user/repo@v1").type).toBe("git");
			expect((packageManager as any).parseSource("ssh://git@github.com/user/repo@v1").type).toBe("git");

			expect((packageManager as any).parseSource("/absolute/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("./relative/path/to/package").type).toBe("local");
			expect((packageManager as any).parseSource("../relative/path/to/package").type).toBe("local");
		});

		it("should never parse dot-relative paths as git", () => {
			const dotSlash = (packageManager as any).parseSource("./packages/agent-timers");
			expect(dotSlash.type).toBe("local");
			expect(dotSlash.path).toBe("./packages/agent-timers");

			const dotDotSlash = (packageManager as any).parseSource("../packages/agent-timers");
			expect(dotDotSlash.type).toBe("local");
			expect(dotDotSlash.path).toBe("../packages/agent-timers");
		});
	});

	describe("settings source normalization", () => {
		it("should store global local packages relative to agent settings base", () => {
			const pkgDir = join(tempDir, "packages", "local-global-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./packages/local-global-pkg");
			expect(added).toBe(true);

			const settings = settingsManager.getGlobalSettings();
			const rel = relative(agentDir, pkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should store project local packages relative to .pi settings base", () => {
			const projectPkgDir = join(tempDir, "project-local-pkg");
			mkdirSync(join(projectPkgDir, "extensions"), { recursive: true });
			writeFileSync(join(projectPkgDir, "extensions", "index.ts"), "export default function() {}");

			const added = packageManager.addSourceToSettings("./project-local-pkg", { local: true });
			expect(added).toBe(true);

			const settings = settingsManager.getProjectSettings();
			const rel = relative(join(tempDir, ".prime", "agent"), projectPkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("should remove local package entries using equivalent path forms", () => {
			const pkgDir = join(tempDir, "remove-local-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

			packageManager.addSourceToSettings("./remove-local-pkg");
			const removed = packageManager.removeSourceFromSettings(`${pkgDir}/`);
			expect(removed).toBe(true);
			expect(settingsManager.getGlobalSettings().packages ?? []).toHaveLength(0);
		});
	});

	describe("HTTPS git URL parsing (old behavior)", () => {
		it.each([
			{
				source: "https://github.com/user/repo",
				expected: { type: "git", host: "github.com", path: "user/repo", pinned: false },
			},
			{
				source: "git:https://github.com/user/repo",
				expected: { type: "git", host: "github.com", path: "user/repo" },
			},
			{
				source: "https://github.com/user/repo@v1.2.3",
				expected: { type: "git", host: "github.com", path: "user/repo", ref: "v1.2.3", pinned: true },
			},
			{
				source: "https://github.com/user/repo@feature/branch",
				expected: { type: "git", host: "github.com", path: "user/repo", ref: "feature/branch", pinned: true },
			},
			{ source: "git:github.com/user/repo", expected: { type: "git", host: "github.com", path: "user/repo" } },
			{ source: "github.com/user/repo", expected: { type: "local" } },
			{
				source: "https://github.com/user/repo.git",
				expected: { type: "git", host: "github.com", path: "user/repo" },
			},
			{ source: "https://gitlab.com/user/repo", expected: { type: "git", host: "gitlab.com", path: "user/repo" } },
			{
				source: "https://bitbucket.org/user/repo",
				expected: { type: "git", host: "bitbucket.org", path: "user/repo" },
			},
			{
				source: "https://codeberg.org/user/repo",
				expected: { type: "git", host: "codeberg.org", path: "user/repo" },
			},
		])("parses $source", ({ source, expected }) => {
			expect((packageManager as any).parseSource(source)).toMatchObject(expected);
		});

		it("should generate correct package identity for protocol and git:-prefixed URLs", async () => {
			const identity1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const identity2 = (packageManager as any).getPackageIdentity("https://github.com/user/repo@v1.0.0");
			const identity3 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const identity4 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			expect(identity1).toBe("git:github.com/user/repo");
			expect(identity2).toBe("git:github.com/user/repo");
			expect(identity3).toBe("git:github.com/user/repo");
			expect(identity4).toBe("git:github.com/user/repo");
		});

		it("should deduplicate git URLs with different supported formats", async () => {
			const pkgDir = join(tempDir, "https-dedup-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "test.ts"), "export default function() {}");

			settingsManager.setPackages([
				"https://github.com/user/repo",
				"git:github.com/user/repo",
				"https://github.com/user/repo.git",
			]);

			const id1 = (packageManager as any).getPackageIdentity("https://github.com/user/repo");
			const id2 = (packageManager as any).getPackageIdentity("git:github.com/user/repo");
			const id3 = (packageManager as any).getPackageIdentity("https://github.com/user/repo.git");

			expect(id1).toBe(id2);
			expect(id2).toBe(id3);
		});
	});

	describe("pattern filtering in top-level arrays", () => {
		const cases: PatternCase[] = [
			{
				name: "excludes extensions with a ! pattern",
				kind: "extensions",
				files: ["extensions/keep.ts", "extensions/remove.ts"],
				patterns: ["extensions", "!**/remove.ts"],
				expected: { "keep.ts": "enabled", "remove.ts": "disabled" },
			},
			{
				name: "filters themes with glob patterns",
				kind: "themes",
				files: ["themes/dark.json", "themes/light.json", "themes/funky.json"],
				patterns: ["themes", "!funky.json"],
				expected: { "dark.json": "enabled", "light.json": "enabled", "funky.json": "disabled" },
			},
			{
				name: "filters prompts with an exclusion pattern",
				kind: "prompts",
				files: ["prompts/review.md", "prompts/explain.md"],
				patterns: ["prompts", "!explain.md"],
				expected: { "review.md": "enabled", "explain.md": "disabled" },
			},
			{
				name: "filters skills with an exclusion pattern",
				kind: "skills",
				files: ["skills/good-skill", "skills/bad-skill"],
				patterns: ["skills", "!**/bad-skill"],
				expected: { "good-skill": "enabled", "bad-skill": "disabled" },
			},
			{
				name: "works without patterns (backward compatible)",
				kind: "extensions",
				files: ["extensions/my-ext.ts"],
				patterns: ["extensions/my-ext.ts"],
				expected: { "my-ext.ts": "enabled" },
			},
			{
				name: "force-includes extensions with a + pattern after exclusion",
				kind: "extensions",
				files: ["extensions/keep.ts", "extensions/excluded.ts", "extensions/force-back.ts"],
				patterns: ["extensions", "!extensions/*.ts", "+extensions/force-back.ts"],
				expected: { "keep.ts": "disabled", "excluded.ts": "disabled", "force-back.ts": "enabled" },
			},
			{
				name: "force-includes after a specific exclusion",
				kind: "extensions",
				files: ["extensions/a.ts", "extensions/b.ts"],
				patterns: ["extensions", "!extensions/b.ts", "+extensions/b.ts"],
				expected: { "a.ts": "enabled", "b.ts": "enabled" },
			},
			{
				name: "force-includes themes",
				kind: "themes",
				files: ["themes/dark.json", "themes/light.json", "themes/special.json"],
				patterns: ["themes", "!themes/*.json", "+themes/special.json"],
				expected: { "dark.json": "disabled", "light.json": "disabled", "special.json": "enabled" },
			},
			{
				name: "force-includes prompts",
				kind: "prompts",
				files: ["prompts/review.md", "prompts/explain.md", "prompts/debug.md"],
				patterns: ["prompts", "!prompts/*.md", "+prompts/debug.md"],
				expected: { "review.md": "disabled", "explain.md": "disabled", "debug.md": "enabled" },
			},
			{
				name: "force-excludes a top-level resource that a + pattern re-added",
				kind: "extensions",
				files: ["extensions/alpha.ts", "extensions/beta.ts"],
				patterns: ["extensions", "+extensions/alpha.ts", "-extensions/alpha.ts"],
				expected: { "alpha.ts": "disabled", "beta.ts": "enabled" },
			},
		];

		it.each(cases)("$name", async ({ kind, files, patterns, expected }) => {
			for (const file of files) writeResourceFixture(agentDir, kind, file);

			setTopLevelPatterns(settingsManager, kind, patterns);

			const result = await packageManager.resolve();
			expectResourceStates(result[kind], kind, expected);
		});
	});

	describe("pattern filtering in pi manifest", () => {
		const cases: PatternCase[] = [
			{
				name: "supports glob patterns in manifest extensions",
				kind: "extensions",
				files: [
					"extensions/local.ts",
					"node_modules/dep/extensions/remote.ts",
					"node_modules/dep/extensions/skip.ts",
				],
				patterns: ["extensions", "node_modules/dep/extensions", "!**/skip.ts"],
				expected: { "local.ts": "enabled", "remote.ts": "enabled", "skip.ts": "absent" },
			},
			{
				name: "supports glob patterns in manifest skills",
				kind: "skills",
				files: ["skills/good-skill", "skills/bad-skill"],
				patterns: ["skills", "!**/bad-skill"],
				expected: { "good-skill": "enabled", "bad-skill": "absent" },
			},
			{
				name: "handles force-include in manifest patterns",
				kind: "extensions",
				files: ["extensions/one.ts", "extensions/two.ts", "extensions/three.ts"],
				patterns: ["extensions", "!**/two.ts", "+extensions/two.ts"],
				expected: { "one.ts": "enabled", "two.ts": "enabled", "three.ts": "enabled" },
			},
		];

		it.each(cases)("$name", async ({ kind, files, patterns, expected }) => {
			const pkgDir = join(tempDir, "manifest-pkg");
			for (const file of files) writeResourceFixture(pkgDir, kind, file);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({ name: "manifest-pkg", pi: { [kind]: patterns } }),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expectResourceStates(result[kind], kind, expected);
		});

		it("should expand positive glob manifest entries before collecting skills", async () => {
			const pkgDir = join(tempDir, "skill-manifest-glob-pkg");
			mkdirSync(join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown"), { recursive: true });
			mkdirSync(join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api"), { recursive: true });
			writeFileSync(
				join(pkgDir, "plugins/pdf-to-markdown/skills/pdf-to-markdown", "SKILL.md"),
				"---\nname: pdf-to-markdown\ndescription: PDF to Markdown\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "plugins/nutrient-dws/skills/document-processor-api", "SKILL.md"),
				"---\nname: document-processor-api\ndescription: DWS\n---\nContent",
			);
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "skill-manifest-glob-pkg",
					pi: {
						skills: ["./plugins/*/skills"],
					},
				}),
			);

			const result = await packageManager.resolveExtensionSources([pkgDir]);
			expect(result.skills.some((r) => isEnabled(r, "pdf-to-markdown", "includes"))).toBe(true);
			expect(result.skills.some((r) => isEnabled(r, "document-processor-api", "includes"))).toBe(true);
		});

		it("should apply user filters on top of manifest filters (not replace)", async () => {
			const pkgDir = join(tempDir, "layered-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "foo.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "bar.ts"), "export default function() {}");
			writeFileSync(join(pkgDir, "extensions", "baz.ts"), "export default function() {}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "layered-pkg",
					pi: {
						extensions: ["extensions", "!**/baz.ts"],
					},
				}),
			);

			settingsManager.setPackages([
				{
					source: pkgDir,
					extensions: ["!**/bar.ts"],
					skills: [],
					prompts: [],
					themes: [],
				},
			]);

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => isEnabled(r, "foo.ts"))).toBe(true);
			expect(result.extensions.some((r) => isDisabled(r, "bar.ts"))).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "baz.ts"))).toBe(false);
		});
	});

	describe("pattern filtering in package filters", () => {
		const cases: PatternCase[] = [
			{
				name: "excludes package extensions with a ! pattern",
				kind: "extensions",
				files: ["extensions/foo.ts", "extensions/bar.ts", "extensions/baz.ts"],
				patterns: ["!**/baz.ts"],
				expected: { "foo.ts": "enabled", "bar.ts": "enabled", "baz.ts": "disabled" },
			},
			{
				name: "filters package themes",
				kind: "themes",
				files: ["themes/nice.json", "themes/ugly.json"],
				patterns: ["!ugly.json"],
				expected: { "nice.json": "enabled", "ugly.json": "disabled" },
			},
			{
				name: "combines include and exclude patterns",
				kind: "extensions",
				files: ["extensions/alpha.ts", "extensions/beta.ts", "extensions/gamma.ts"],
				patterns: ["**/alpha.ts", "**/beta.ts", "!**/beta.ts"],
				expected: { "alpha.ts": "enabled", "beta.ts": "disabled", "gamma.ts": "disabled" },
			},
			{
				name: "works with direct paths (no patterns)",
				kind: "extensions",
				files: ["extensions/one.ts", "extensions/two.ts"],
				patterns: ["extensions/one.ts"],
				expected: { "one.ts": "enabled", "two.ts": "disabled" },
			},
			{
				name: "force-include overrides exclude",
				kind: "extensions",
				files: ["extensions/alpha.ts", "extensions/beta.ts", "extensions/gamma.ts"],
				patterns: ["!**/*.ts", "+extensions/beta.ts"],
				expected: { "alpha.ts": "disabled", "beta.ts": "enabled", "gamma.ts": "disabled" },
			},
			{
				name: "force-includes multiple resources",
				kind: "skills",
				files: ["skills/skill-a", "skills/skill-b", "skills/skill-c"],
				patterns: ["!**/*", "+skills/skill-a", "+skills/skill-c"],
				expected: { "skill-a": "enabled", "skill-b": "disabled", "skill-c": "enabled" },
			},
			{
				name: "force-excludes a resource that a + pattern re-added",
				kind: "extensions",
				files: ["extensions/alpha.ts", "extensions/beta.ts"],
				patterns: ["extensions/*.ts", "+extensions/alpha.ts", "-extensions/alpha.ts"],
				expected: { "alpha.ts": "disabled", "beta.ts": "enabled" },
			},
		];

		it.each(cases)("$name", async ({ kind, files, patterns, expected }) => {
			const pkgDir = join(tempDir, "pattern-pkg");
			for (const file of files) writeResourceFixture(pkgDir, kind, file);

			const filters = {
				source: pkgDir,
				extensions: [] as string[],
				skills: [] as string[],
				prompts: [] as string[],
				themes: [] as string[],
			};
			filters[kind] = patterns;
			settingsManager.setPackages([filters]);

			const result = await packageManager.resolve();
			expectResourceStates(result[kind], kind, expected);
		});
	});

	describe("package deduplication", () => {
		it("should dedupe same local package in global and project (project wins)", async () => {
			const pkgDir = join(tempDir, "shared-pkg");
			mkdirSync(join(pkgDir, "extensions"), { recursive: true });
			writeFileSync(join(pkgDir, "extensions", "shared.ts"), "export default function() {}");

			settingsManager.setPackages([pkgDir]); // global
			settingsManager.setProjectPackages([pkgDir]); // project

			const globalSettings = settingsManager.getGlobalSettings();
			const projectSettings = settingsManager.getProjectSettings();
			expect(globalSettings.packages).toEqual([pkgDir]);
			expect(projectSettings.packages).toEqual([pkgDir]);

			const result = await packageManager.resolve();
			const sharedPaths = result.extensions.filter((r) => r.path.includes("shared-pkg"));
			expect(sharedPaths.length).toBe(1);
			expect(sharedPaths[0].metadata.scope).toBe("project");
		});

		it("should keep both if different packages", async () => {
			const pkg1Dir = join(tempDir, "pkg1");
			const pkg2Dir = join(tempDir, "pkg2");
			mkdirSync(join(pkg1Dir, "extensions"), { recursive: true });
			mkdirSync(join(pkg2Dir, "extensions"), { recursive: true });
			writeFileSync(join(pkg1Dir, "extensions", "from-pkg1.ts"), "export default function() {}");
			writeFileSync(join(pkg2Dir, "extensions", "from-pkg2.ts"), "export default function() {}");

			settingsManager.setPackages([pkg1Dir]); // global
			settingsManager.setProjectPackages([pkg2Dir]); // project

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => r.path.includes("pkg1"))).toBe(true);
			expect(result.extensions.some((r) => r.path.includes("pkg2"))).toBe(true);
		});

		it("should dedupe SSH and HTTPS URLs for same repo", async () => {
			const httpsUrl = "https://github.com/user/repo";
			const sshUrl = "git:git@github.com:user/repo";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH and HTTPS with refs", async () => {
			const httpsUrl = "https://github.com/user/repo@v1.0.0";
			const sshUrl = "git:git@github.com:user/repo@v1.0.0";

			const httpsIdentity = (packageManager as any).getPackageIdentity(httpsUrl);
			const sshIdentity = (packageManager as any).getPackageIdentity(sshUrl);

			expect(httpsIdentity).toBe("git:github.com/user/repo");
			expect(sshIdentity).toBe("git:github.com/user/repo");
			expect(httpsIdentity).toBe(sshIdentity);
		});

		it("should dedupe SSH URL with ssh:// protocol and git@ format", async () => {
			const sshProtocol = "ssh://git@github.com/user/repo";
			const gitAt = "git:git@github.com:user/repo";

			const sshProtocolIdentity = (packageManager as any).getPackageIdentity(sshProtocol);
			const gitAtIdentity = (packageManager as any).getPackageIdentity(gitAt);

			expect(sshProtocolIdentity).toBe("git:github.com/user/repo");
			expect(gitAtIdentity).toBe("git:github.com/user/repo");
			expect(sshProtocolIdentity).toBe(gitAtIdentity);
		});

		it("should dedupe all supported URL formats for same repo", async () => {
			const urls = [
				"https://github.com/user/repo",
				"https://github.com/user/repo.git",
				"ssh://git@github.com/user/repo",
				"git:https://github.com/user/repo",
				"git:github.com/user/repo",
				"git:git@github.com:user/repo",
				"git:git@github.com:user/repo.git",
			];

			const identities = urls.map((url) => (packageManager as any).getPackageIdentity(url));

			const uniqueIdentities = [...new Set(identities)];
			expect(uniqueIdentities.length).toBe(1);
			expect(uniqueIdentities[0]).toBe("git:github.com/user/repo");
		});

		it("should keep different repos separate (HTTPS vs SSH)", async () => {
			const repo1Https = "https://github.com/user/repo1";
			const repo2Ssh = "git:git@github.com:user/repo2";

			const id1 = (packageManager as any).getPackageIdentity(repo1Https);
			const id2 = (packageManager as any).getPackageIdentity(repo2Ssh);

			expect(id1).toBe("git:github.com/user/repo1");
			expect(id2).toBe("git:github.com/user/repo2");
			expect(id1).not.toBe(id2);
		});
	});

	describe("multi-file extension discovery (issue #1102)", () => {
		it("should only load index.ts from subdirectories, not helper modules", async () => {
			const pkgDir = join(tempDir, "multifile-pkg");
			mkdirSync(join(pkgDir, "extensions", "subagent"), { recursive: true });

			writeFileSync(
				join(pkgDir, "extensions", "subagent", "index.ts"),
				`import { helper } from "./agents.js";
export default function(api) { api.registerTool({ name: "test", description: "test", execute: async () => helper() }); }`,
			);
			writeFileSync(
				join(pkgDir, "extensions", "subagent", "agents.ts"),
				`export function helper() { return "helper"; }`,
			);
			writeFileSync(join(pkgDir, "extensions", "standalone.ts"), "export default function(api) {}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "subagent/index.ts") && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "standalone.ts") && r.enabled)).toBe(true);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "agents.ts"))).toBe(false);
		});

		it("should respect package.json pi.extensions manifest in subdirectories", async () => {
			const pkgDir = join(tempDir, "manifest-subdir-pkg");
			mkdirSync(join(pkgDir, "extensions", "custom"), { recursive: true });

			writeFileSync(
				join(pkgDir, "extensions", "custom", "package.json"),
				JSON.stringify({
					pi: {
						extensions: ["./main.ts"],
					},
				}),
			);
			writeFileSync(join(pkgDir, "extensions", "custom", "main.ts"), "export default function(api) {}");
			writeFileSync(join(pkgDir, "extensions", "custom", "utils.ts"), "export const util = 1;");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "custom/main.ts") && r.enabled)).toBe(true);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "utils.ts"))).toBe(false);
		});

		it("should handle mixed top-level files and subdirectories", async () => {
			const pkgDir = join(tempDir, "mixed-pkg");
			mkdirSync(join(pkgDir, "extensions", "complex"), { recursive: true });

			writeFileSync(join(pkgDir, "extensions", "simple.ts"), "export default function(api) {}");

			writeFileSync(
				join(pkgDir, "extensions", "complex", "index.ts"),
				"import { a } from './a.js'; export default function(api) {}",
			);
			writeFileSync(join(pkgDir, "extensions", "complex", "a.ts"), "export const a = 1;");
			writeFileSync(join(pkgDir, "extensions", "complex", "b.ts"), "export const b = 2;");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "simple.ts") && r.enabled)).toBe(true);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/index.ts") && r.enabled)).toBe(true);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/a.ts"))).toBe(false);
			expect(result.extensions.some((r) => pathEndsWith(r.path, "complex/b.ts"))).toBe(false);

			expect(result.extensions.filter((r) => r.enabled).length).toBe(2);
		});

		it("should skip subdirectories without index.ts or manifest", async () => {
			const pkgDir = join(tempDir, "no-entry-pkg");
			mkdirSync(join(pkgDir, "extensions", "broken"), { recursive: true });

			writeFileSync(join(pkgDir, "extensions", "broken", "helper.ts"), "export const x = 1;");
			writeFileSync(join(pkgDir, "extensions", "broken", "another.ts"), "export const y = 2;");

			writeFileSync(join(pkgDir, "extensions", "valid.ts"), "export default function(api) {}");

			const result = await packageManager.resolveExtensionSources([pkgDir]);

			expect(result.extensions.some((r) => pathEndsWith(r.path, "valid.ts") && r.enabled)).toBe(true);
			expect(result.extensions.filter((r) => r.enabled).length).toBe(1);
		});
	});

	describe("offline mode and network timeouts", () => {
		it("should update project npm packages using @latest when newer version is available", async () => {
			const installedPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).toHaveBeenCalledWith(
				"npm",
				["install", "example@latest", "--prefix", join(tempDir, ".prime", "agent", "npm")],
				undefined,
			);
		});

		it("should skip project npm update when installed version matches latest", async () => {
			const installedPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.2.3" }));
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');
			const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);

			await packageManager.update("npm:example");

			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
			expect(runCommandSpy).not.toHaveBeenCalled();
		});

		it("should batch npm updates per scope and run git updates in parallel while skipping pinned and current packages", async () => {
			vi.spyOn(packageManager as any, "getGlobalNpmRoot").mockReturnValue(join(agentDir, "node_modules"));

			const userOldPath = join(agentDir, "node_modules", "user-old");
			const userCurrentPath = join(agentDir, "node_modules", "user-current");
			const userUnknownPath = join(agentDir, "node_modules", "user-unknown");
			const projectOldPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "project-old");
			const projectCurrentPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "project-current");
			const installPaths = [userOldPath, userCurrentPath, userUnknownPath, projectOldPath, projectCurrentPath];
			for (const installPath of installPaths) {
				mkdirSync(installPath, { recursive: true });
			}
			writeFileSync(join(userOldPath, "package.json"), JSON.stringify({ name: "user-old", version: "1.0.0" }));
			writeFileSync(
				join(userCurrentPath, "package.json"),
				JSON.stringify({ name: "user-current", version: "1.0.0" }),
			);
			writeFileSync(
				join(userUnknownPath, "package.json"),
				JSON.stringify({ name: "user-unknown", version: "1.0.0" }),
			);
			writeFileSync(join(projectOldPath, "package.json"), JSON.stringify({ name: "project-old", version: "1.0.0" }));
			writeFileSync(
				join(projectCurrentPath, "package.json"),
				JSON.stringify({ name: "project-current", version: "1.0.0" }),
			);

			settingsManager.setPackages([
				"npm:user-old",
				"npm:user-current",
				"npm:user-unknown",
				"npm:user-pinned@1.0.0",
				"git:github.com/example/user-repo-a",
				"git:github.com/example/user-repo-b",
				"git:github.com/example/user-repo-pinned@v1",
			]);
			settingsManager.setProjectPackages([
				"npm:project-old",
				"npm:project-current",
				"npm:project-missing",
				"git:github.com/example/project-repo-a",
			]);

			const runCommandCaptureSpy = vi
				.spyOn(packageManager as any, "runCommandCapture")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [_command, args] = callArgs as [string, string[]];
					if (args[0] !== "view") {
						throw new Error(`Unexpected runCommandCapture args: ${args.join(" ")}`);
					}
					switch (args[1]) {
						case "user-old":
						case "project-old":
							return '"2.0.0"';
						case "user-current":
						case "project-current":
							return '"1.0.0"';
						case "user-unknown":
							throw new Error("registry unavailable");
						default:
							throw new Error(`Unexpected package lookup: ${args[1]}`);
					}
				});

			let activeNpmUpdates = 0;
			let maxConcurrentNpmUpdates = 0;
			const runCommandSpy = vi
				.spyOn(packageManager as any, "runCommand")
				.mockImplementation(async (...callArgs: unknown[]) => {
					const [command, args] = callArgs as [string, string[]];
					if (command !== "npm") {
						throw new Error(`Unexpected runCommand call: ${command} ${args.join(" ")}`);
					}
					activeNpmUpdates += 1;
					maxConcurrentNpmUpdates = Math.max(maxConcurrentNpmUpdates, activeNpmUpdates);
					await new Promise((resolve) => setTimeout(resolve, 20));
					activeNpmUpdates -= 1;
				});

			let activeGitUpdates = 0;
			let maxConcurrentGitUpdates = 0;
			const updateGitSpy = vi.spyOn(packageManager as any, "updateGit").mockImplementation(async () => {
				activeGitUpdates += 1;
				maxConcurrentGitUpdates = Math.max(maxConcurrentGitUpdates, activeGitUpdates);
				await new Promise((resolve) => setTimeout(resolve, 20));
				activeGitUpdates -= 1;
			});

			await packageManager.update();

			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(5);
			expect(runCommandSpy).toHaveBeenCalledTimes(2);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				1,
				"npm",
				["install", "-g", "user-old@latest", "user-unknown@latest"],
				undefined,
			);
			expect(runCommandSpy).toHaveBeenNthCalledWith(
				2,
				"npm",
				[
					"install",
					"project-old@latest",
					"project-missing@latest",
					"--prefix",
					join(tempDir, ".prime", "agent", "npm"),
				],
				undefined,
			);
			expect(updateGitSpy).toHaveBeenCalledTimes(3);
			expect(maxConcurrentNpmUpdates).toBeGreaterThan(1);
			expect(maxConcurrentGitUpdates).toBeGreaterThan(1);
		});

		it("should suggest npm source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["npm:example"]);

			await expect(packageManager.update("example")).rejects.toThrow(
				"No matching package found for example. Did you mean npm:example?",
			);
		});

		it("should suggest git source prefixes for update lookups", async () => {
			settingsManager.setProjectPackages(["git:github.com/example/repo"]);

			await expect(packageManager.update("github.com/example/repo")).rejects.toThrow(
				"No matching package found for github.com/example/repo. Did you mean git:github.com/example/repo?",
			);
		});

		it("should skip installing missing package sources when offline", async () => {
			process.env.PI_OFFLINE = "1";
			settingsManager.setProjectPackages(["npm:missing-package", "git:github.com/example/missing-repo"]);

			const installParsedSourceSpy = vi.spyOn(packageManager as any, "installParsedSource");

			const result = await packageManager.resolve();
			const allResources = [...result.extensions, ...result.skills, ...result.prompts, ...result.themes];
			expect(allResources.some((r) => r.metadata.origin === "package")).toBe(false);
			expect(installParsedSourceSpy).not.toHaveBeenCalled();
		});

		it("should skip refreshing temporary git sources when offline", async () => {
			process.env.PI_OFFLINE = "1";
			const gitSource = "git:github.com/example/repo";
			const parsedGitSource = (packageManager as any).parseSource(gitSource);
			const installedPath = (packageManager as any).getGitInstallPath(parsedGitSource, "temporary") as string;

			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");

			const refreshTemporaryGitSourceSpy = vi.spyOn(packageManager as any, "refreshTemporaryGitSource");

			const result = await packageManager.resolveExtensionSources([gitSource], { temporary: true });
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(refreshTemporaryGitSourceSpy).not.toHaveBeenCalled();
		});

		it("should not run npm view during resolve for installed unpinned packages", async () => {
			const installedPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(join(installedPath, "extensions"), { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			writeFileSync(join(installedPath, "extensions", "index.ts"), "export default function() {};");
			settingsManager.setProjectPackages(["npm:example"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const result = await packageManager.resolve();
			expect(result.extensions.some((r) => pathEndsWith(r.path, "extensions/index.ts") && r.enabled)).toBe(true);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		it("should reinstall pinned npm packages when installed version does not match", async () => {
			const installedPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example@2.0.0"]);

			const installParsedSourceSpy = vi
				.spyOn(packageManager as any, "installParsedSource")
				.mockResolvedValue(undefined);

			await packageManager.resolve();
			expect(installParsedSourceSpy).toHaveBeenCalledTimes(1);
		});

		it("should not check package updates when offline", async () => {
			process.env.PI_OFFLINE = "1";
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
		});

		it("should report updates for installed unpinned npm packages", async () => {
			const installedPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(installedPath, { recursive: true });
			writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			settingsManager.setProjectPackages(["npm:example"]);

			vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([
				{
					source: "npm:example",
					displayName: "example",
					type: "npm",
					scope: "project",
				},
			]);
		});

		it("should skip pinned packages when checking for updates", async () => {
			const installedNpmPath = join(tempDir, ".prime", "agent", "npm", "node_modules", "example");
			mkdirSync(installedNpmPath, { recursive: true });
			writeFileSync(join(installedNpmPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			const parsedGitSource = (packageManager as any).parseSource("git:github.com/example/repo@v1");
			const installedGitPath = (packageManager as any).getGitInstallPath(parsedGitSource, "project") as string;
			mkdirSync(installedGitPath, { recursive: true });

			settingsManager.setProjectPackages(["npm:example@1.0.0", "git:github.com/example/repo@v1"]);

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture");
			const gitUpdateSpy = vi.spyOn(packageManager as any, "gitHasAvailableUpdate");

			const updates = await packageManager.checkForAvailableUpdates();
			expect(updates).toEqual([]);
			expect(runCommandCaptureSpy).not.toHaveBeenCalled();
			expect(gitUpdateSpy).not.toHaveBeenCalled();
		});

		it("should use npm view to fetch latest version", async () => {
			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("example");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledTimes(1);
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"npm",
				["view", "example", "version", "--json"],
				expect.objectContaining({ cwd: tempDir, timeoutMs: expect.any(Number) }),
			);
		});

		it("should use npmCommand argv for npm update checks", async () => {
			settingsManager = SettingsManager.inMemory({
				npmCommand: ["mise", "exec", "node@20", "--", "npm"],
			});
			packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager,
			});

			const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue('"1.2.3"');

			const latest = await (packageManager as any).getLatestNpmVersion("@scope/pkg");
			expect(latest).toBe("1.2.3");
			expect(runCommandCaptureSpy).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "view", "@scope/pkg", "version", "--json"],
				expect.objectContaining({ cwd: tempDir }),
			);
		});

		it("should wait for close before resolving captured stdout", async () => {
			const managerWithInternals = packageManager as unknown as {
				spawnCaptureCommand(
					command: string,
					args: string[],
					options?: { cwd?: string; env?: Record<string, string> },
				): MockSpawnedProcess;
				runCommandCapture(
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				): Promise<string>;
			};
			const child = new MockSpawnedProcess();
			vi.spyOn(managerWithInternals, "spawnCaptureCommand").mockReturnValue(child);

			let settled = false;
			const capturePromise = managerWithInternals.runCommandCapture("git", ["rev-parse", "HEAD"]).then((value) => {
				settled = true;
				return value;
			});

			child.emit("exit", 0, null);
			await Promise.resolve();
			expect(settled).toBe(false);

			child.stdout.write("abc123\n");
			child.stdout.end();
			child.emit("close", 0, null);

			await expect(capturePromise).resolves.toBe("abc123");
		});
	});
});
