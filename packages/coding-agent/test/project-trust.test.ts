import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { resolveProjectTrusted } from "../src/core/project-trust.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ProjectTrustStore } from "../src/core/trust-manager.js";

interface ProjectTrustFixture {
	root: string;
	repo: string;
	cwd: string;
	agentDir: string;
	projectConfigDir: string;
	projectExtensionPath: string;
	projectExtensionSentinel: string;
	packageExtensionPath: string;
	packageExtensionSentinel: string;
	projectSkillPath: string;
	ancestorSkillPath: string;
	projectPromptPath: string;
	projectThemePath: string;
	projectAgentsPath: string;
	projectClaudePath: string;
}

function writeFixtureFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function createProjectTrustFixture(): ProjectTrustFixture {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-"));
	const repo = join(root, "repo");
	const cwd = join(repo, "packages", "app");
	const agentDir = join(root, "user-agent");
	const projectConfigDir = join(cwd, ".prime", "agent");
	const projectExtensionPath = join(projectConfigDir, "extensions", "hostile.ts");
	const projectExtensionSentinel = join(root, "project-extension-executed");
	const packageDir = join(root, "hostile-package");
	const packageExtensionPath = join(packageDir, "extensions", "hostile-package.ts");
	const packageExtensionSentinel = join(root, "package-extension-executed");
	const projectSkillPath = join(projectConfigDir, "skills", "project-hostile", "SKILL.md");
	const ancestorSkillPath = join(repo, ".agents", "skills", "ancestor-hostile", "SKILL.md");
	const projectPromptPath = join(projectConfigDir, "prompts", "project-hostile.md");
	const projectThemePath = join(projectConfigDir, "themes", "project-hostile.json");
	const projectAgentsPath = join(repo, "AGENTS.md");
	const projectClaudePath = join(cwd, "CLAUDE.md");

	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	writeFixtureFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultModel: "global-model", defaultProjectTrust: "ask" }, null, 2)}\n`,
	);
	writeFixtureFile(join(agentDir, "AGENTS.md"), "global context");
	writeFixtureFile(join(agentDir, "SYSTEM.md"), "global system prompt");
	writeFixtureFile(join(agentDir, "APPEND_SYSTEM.md"), "global append prompt");
	writeFixtureFile(
		join(agentDir, "prompts", "global-prompt.md"),
		"---\ndescription: trusted global prompt\n---\nglobal prompt",
	);

	writeFixtureFile(
		projectExtensionPath,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(projectExtensionSentinel)}, "executed", "utf8");\nexport default function hostileExtension() {}\n`,
	);
	writeFixtureFile(projectSkillPath, "---\nname: project-hostile\ndescription: project skill\n---\nproject skill");
	writeFixtureFile(ancestorSkillPath, "---\nname: ancestor-hostile\ndescription: ancestor skill\n---\nancestor skill");
	writeFixtureFile(projectPromptPath, "---\ndescription: project prompt\n---\nproject prompt");

	const theme = JSON.parse(
		readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf8"),
	) as { name: string; vars?: Record<string, string> };
	theme.name = "project-hostile-theme";
	writeFixtureFile(projectThemePath, `${JSON.stringify(theme, null, 2)}\n`);
	writeFixtureFile(join(projectConfigDir, "SYSTEM.md"), "project system prompt");
	writeFixtureFile(join(projectConfigDir, "APPEND_SYSTEM.md"), "project append prompt");
	writeFixtureFile(projectAgentsPath, "ancestor AGENTS context");
	writeFixtureFile(projectClaudePath, "cwd CLAUDE context");

	writeFixtureFile(
		packageExtensionPath,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(packageExtensionSentinel)}, "executed", "utf8");\nexport default function hostilePackageExtension() {}\n`,
	);
	writeFixtureFile(
		join(packageDir, "package.json"),
		`${JSON.stringify(
			{
				name: "hostile-project-package",
				version: "1.0.0",
				pi: { extensions: ["./extensions/hostile-package.ts"] },
			},
			null,
			2,
		)}\n`,
	);
	writeFixtureFile(
		join(projectConfigDir, "settings.json"),
		`${JSON.stringify(
			{
				defaultModel: "project-model",
				defaultProjectTrust: "always",
				packages: [packageDir],
			},
			null,
			2,
		)}\n`,
	);

	return {
		root,
		repo,
		cwd,
		agentDir,
		projectConfigDir,
		projectExtensionPath,
		projectExtensionSentinel,
		packageExtensionPath,
		packageExtensionSentinel,
		projectSkillPath,
		ancestorSkillPath,
		projectPromptPath,
		projectThemePath,
		projectAgentsPath,
		projectClaudePath,
	};
}

describe("project trust resolution", () => {
	let fixture: ProjectTrustFixture;

	beforeEach(() => {
		fixture = createProjectTrustFixture();
	});

	afterEach(() => {
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it("applies ask, always, and never only when there is no saved decision", async () => {
		const store = new ProjectTrustStore(fixture.agentDir);
		const base = { cwd: fixture.cwd, trustStore: store, interactive: false } as const;

		await expect(resolveProjectTrusted({ ...base, defaultProjectTrust: "ask" })).resolves.toBe(false);
		await expect(resolveProjectTrusted({ ...base, defaultProjectTrust: "always" })).resolves.toBe(true);
		await expect(resolveProjectTrusted({ ...base, defaultProjectTrust: "never" })).resolves.toBe(false);
		expect(store.get(fixture.cwd)).toBeNull();

		store.set(fixture.cwd, false);
		await expect(resolveProjectTrusted({ ...base, defaultProjectTrust: "always" })).resolves.toBe(false);
		store.set(fixture.cwd, true);
		await expect(resolveProjectTrusted({ ...base, defaultProjectTrust: "never" })).resolves.toBe(true);

		const settings = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false });
		expect(settings.getGlobalSettings().defaultProjectTrust).toBe("ask");
		expect(settings.getProjectSettings()).toEqual({});
	});

	it("parses approve and no-approve as non-persistent one-run overrides with highest precedence", async () => {
		const store = new ProjectTrustStore(fixture.agentDir);
		const cases = [
			{ flag: "--approve", expected: true },
			{ flag: "-a", expected: true },
			{ flag: "--no-approve", expected: false },
			{ flag: "-na", expected: false },
		] as const;

		for (const { flag, expected } of cases) {
			store.set(fixture.cwd, !expected);
			const parsed = parseArgs([flag]);
			expect(parsed.projectTrustOverride).toBe(expected);
			await expect(
				resolveProjectTrusted({
					cwd: fixture.cwd,
					trustStore: store,
					trustOverride: parsed.projectTrustOverride,
					defaultProjectTrust: expected ? "never" : "always",
					interactive: false,
				}),
			).resolves.toBe(expected);
			expect(store.get(fixture.cwd)).toBe(!expected);
		}
	});

	it("omits every project source while untrusted and loads the same fixture when trusted", async () => {
		const untrustedSettings = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false });
		const untrustedLoader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: untrustedSettings,
			bundledSkillsDir: null,
		});

		await untrustedLoader.reload();

		expect(untrustedSettings.getDefaultModel()).toBe("global-model");
		expect(untrustedSettings.getProjectSettings()).toEqual({});
		expect(existsSync(fixture.projectExtensionSentinel)).toBe(false);
		expect(existsSync(fixture.packageExtensionSentinel)).toBe(false);
		expect(untrustedLoader.getLoadedExtensionPaths()).not.toContain(fixture.projectExtensionPath);
		expect(untrustedLoader.getLoadedExtensionPaths()).not.toContain(fixture.packageExtensionPath);
		expect(untrustedLoader.getSkills().skills.map((skill) => skill.name)).not.toEqual(
			expect.arrayContaining(["project-hostile", "ancestor-hostile"]),
		);
		expect(untrustedLoader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(["global-prompt"]);
		expect(untrustedLoader.getThemes().themes.some((themeEntry) => themeEntry.name === "project-hostile-theme")).toBe(
			false,
		);
		expect(untrustedLoader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual([
			join(fixture.agentDir, "AGENTS.md"),
		]);
		expect(untrustedLoader.getSystemPrompt()).toBe("global system prompt");
		expect(untrustedLoader.getAppendSystemPrompt()).toEqual(["global append prompt"]);

		const trustedSettings = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true });
		const trustedLoader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: trustedSettings,
			bundledSkillsDir: null,
		});

		await trustedLoader.reload();

		expect(trustedSettings.getDefaultModel()).toBe("project-model");
		expect(existsSync(fixture.projectExtensionSentinel)).toBe(true);
		expect(existsSync(fixture.packageExtensionSentinel)).toBe(true);
		expect(trustedLoader.getLoadedExtensionPaths()).toEqual(
			expect.arrayContaining([fixture.projectExtensionPath, fixture.packageExtensionPath]),
		);
		expect(trustedLoader.getSkills().skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["project-hostile", "ancestor-hostile"]),
		);
		expect(trustedLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("project-hostile");
		expect(trustedLoader.getThemes().themes.some((themeEntry) => themeEntry.name === "project-hostile-theme")).toBe(
			true,
		);
		expect(trustedLoader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual(
			expect.arrayContaining([fixture.projectAgentsPath, fixture.projectClaudePath]),
		);
		expect(trustedLoader.getSystemPrompt()).toBe("project system prompt");
		expect(trustedLoader.getAppendSystemPrompt()).toEqual(["project append prompt"]);
	});

	it("allows only an explicitly supplied absolute CLI resource through the untrusted boundary", async () => {
		const settings = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: settings,
			additionalExtensionPaths: [fixture.projectExtensionPath],
			bundledSkillsDir: null,
		});

		await loader.reload();

		expect(existsSync(fixture.projectExtensionSentinel)).toBe(true);
		expect(existsSync(fixture.packageExtensionSentinel)).toBe(false);
		const explicitExtension = loader
			.getExtensions()
			.extensions.find((extension) => extension.path === fixture.projectExtensionPath);
		expect(explicitExtension?.sourceInfo).toMatchObject({ source: "cli", scope: "temporary" });
		expect(loader.getSkills().skills.map((skill) => skill.name)).not.toEqual(
			expect.arrayContaining(["project-hostile", "ancestor-hostile"]),
		);
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(["global-prompt"]);
		expect(loader.getThemes().themes.some((themeEntry) => themeEntry.name === "project-hostile-theme")).toBe(false);
		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.path)).toEqual([
			join(fixture.agentDir, "AGENTS.md"),
		]);
		expect(loader.getSystemPrompt()).toBe("global system prompt");
		expect(loader.getAppendSystemPrompt()).toEqual(["global append prompt"]);
	});

	it("prompts for trust only when the directory or an ancestor has trust-requiring resources", async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-empty-"));
		const ancestorRoot = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-ancestor-"));
		try {
			const store = new ProjectTrustStore(fixture.agentDir);
			const noResourcesSelect = vi.fn();

			await expect(
				resolveProjectTrusted({
					cwd: emptyDir,
					trustStore: store,
					defaultProjectTrust: "ask",
					interactive: true,
					selectDecision: noResourcesSelect,
				}),
			).resolves.toBe(false);
			expect(noResourcesSelect).not.toHaveBeenCalled();

			const nestedDir = join(ancestorRoot, "nested", "deep");
			mkdirSync(nestedDir, { recursive: true });
			writeFixtureFile(join(ancestorRoot, "AGENTS.md"), "ancestor context");
			const ancestorSelect = vi.fn(async () => undefined);

			await resolveProjectTrusted({
				cwd: nestedDir,
				trustStore: store,
				defaultProjectTrust: "ask",
				interactive: true,
				selectDecision: ancestorSelect,
			});
			expect(ancestorSelect).toHaveBeenCalled();
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
			rmSync(ancestorRoot, { recursive: true, force: true });
		}
	});

	it("prompts for an ancestor context file reached through a symlinked working directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-symlink-"));
		try {
			// The resource loaders walk the lexical ancestry, so the alias ancestor owns the context
			// file even though the physical directory it points at has no trust-requiring resource.
			const physicalDir = join(root, "physical", "project", "subdir");
			const aliasParent = join(root, "aliases");
			mkdirSync(physicalDir, { recursive: true });
			mkdirSync(aliasParent, { recursive: true });
			writeFixtureFile(join(aliasParent, "AGENTS.md"), "alias ancestor context");
			symlinkSync(join(root, "physical", "project"), join(aliasParent, "project"));

			const aliasSelect = vi.fn(async () => undefined);
			await resolveProjectTrusted({
				cwd: join(aliasParent, "project", "subdir"),
				trustStore: new ProjectTrustStore(fixture.agentDir),
				defaultProjectTrust: "ask",
				interactive: true,
				selectDecision: aliasSelect,
			});

			expect(aliasSelect).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists a trust-parent decision that a later run resolves through the same symlinked cwd", async () => {
		const aliasRoot = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-parent-alias-"));
		const physicalRoot = mkdtempSync(join(tmpdir(), "prime-agent-project-trust-parent-physical-"));
		try {
			// The symlink target lives in a separate tree, so the alias's lexical parent is a sibling
			// of the physical project's canonical ancestry, the branch ProjectTrustStore.get never walks.
			const physicalProject = join(physicalRoot, "project");
			const aliasCwd = join(aliasRoot, "current");
			mkdirSync(physicalProject, { recursive: true });
			writeFixtureFile(join(physicalProject, "AGENTS.md"), "project context");
			symlinkSync(physicalProject, aliasCwd);

			await expect(
				resolveProjectTrusted({
					cwd: aliasCwd,
					trustStore: new ProjectTrustStore(fixture.agentDir),
					defaultProjectTrust: "ask",
					interactive: true,
					selectDecision: async () => "trust-parent",
				}),
			).resolves.toBe(true);

			const storedTrust: unknown = JSON.parse(readFileSync(join(fixture.agentDir, "trust.json"), "utf8"));
			expect(Object.keys(storedTrust as Record<string, boolean>)).toEqual([dirname(realpathSync(aliasCwd))]);

			await expect(
				resolveProjectTrusted({
					cwd: aliasCwd,
					trustStore: new ProjectTrustStore(fixture.agentDir),
					defaultProjectTrust: "ask",
					interactive: false,
				}),
			).resolves.toBe(true);
		} finally {
			rmSync(aliasRoot, { recursive: true, force: true });
			rmSync(physicalRoot, { recursive: true, force: true });
		}
	});
});
