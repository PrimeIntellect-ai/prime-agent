import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function writePackageFile(root: string, relativePath: string, content: string): string {
	const filePath = join(root, relativePath);
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

function harnessJson(kind: string, id: string, overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ kind, id, title: `${id} title`, content: `${id} content`, ...overrides }, null, 2)}\n`;
}

describe("package harness discovery", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-harness-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers pi.harness resources alongside pi.skills", { timeout: 10_000 }, async () => {
		const packageDir = join(tempDir, "combined-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "combined-package", pi: { skills: ["./skills"], harness: ["./harness"] } }),
		);
		const skillPath = writePackageFile(
			packageDir,
			"skills/reviewer/SKILL.md",
			"---\nname: reviewer\ndescription: Review code\n---\n",
		);
		const memoryPath = writePackageFile(
			packageDir,
			"harness/memory/reviewer.json",
			harnessJson("memory", "reviewer"),
		);
		const promptPath = writePackageFile(packageDir, "harness/prompt/policy.json", harnessJson("prompt", "policy"));
		settingsManager.setPackages([packageDir]);

		const resolved = await packageManager.resolve();

		expect(resolved.skills).toContainEqual(
			expect.objectContaining({
				path: skillPath,
				enabled: true,
				metadata: expect.objectContaining({ scope: "user" }),
			}),
		);
		expect(new Set(resolved.harness.map((resource) => resource.path))).toEqual(new Set([memoryPath, promptPath]));
		expect(resolved.harness.every((resource) => resource.enabled && resource.metadata.origin === "package")).toBe(
			true,
		);
		expect(resolved.harness.every((resource) => resource.metadata.baseDir === packageDir)).toBe(true);
	});

	it("auto-discovers a conventional harness/ directory without a pi manifest", { timeout: 10_000 }, async () => {
		const packageDir = join(tempDir, "conventional-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "conventional-package" }));
		const subagentPath = writePackageFile(
			packageDir,
			"harness/subagent/reviewer.json",
			harnessJson("subagent", "reviewer"),
		);
		settingsManager.setPackages([packageDir]);

		const resolved = await packageManager.resolve();

		expect(resolved.harness.map((resource) => resource.path)).toEqual([subagentPath]);
		expect(resolved.harness[0]?.enabled).toBe(true);
	});

	it("applies PackageSource harness filters independently of other resources", { timeout: 10_000 }, async () => {
		const packageDir = join(tempDir, "filtered-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "filtered-package", pi: { harness: ["./harness"], skills: ["./skills"] } }),
		);
		const keepPath = writePackageFile(packageDir, "harness/memory/keep.json", harnessJson("memory", "keep"));
		const dropPath = writePackageFile(packageDir, "harness/memory/drop.json", harnessJson("memory", "drop"));
		const skillPath = writePackageFile(
			packageDir,
			"skills/reviewer/SKILL.md",
			"---\nname: reviewer\ndescription: Review code\n---\n",
		);
		settingsManager.setPackages([
			{
				source: packageDir,
				skills: ["skills/reviewer/SKILL.md"],
				harness: ["harness/memory/keep.json"],
			},
		]);

		const resolved = await packageManager.resolve();

		expect(resolved.harness).toContainEqual(expect.objectContaining({ path: keepPath, enabled: true }));
		expect(resolved.harness).toContainEqual(expect.objectContaining({ path: dropPath, enabled: false }));
		expect(resolved.skills).toContainEqual(expect.objectContaining({ path: skillPath, enabled: true }));
	});

	it("disables package harness resources with an explicit empty filter", { timeout: 10_000 }, async () => {
		const packageDir = join(tempDir, "disabled-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "disabled-package" }));
		const memoryPath = writePackageFile(packageDir, "harness/memory/off.json", harnessJson("memory", "off"));
		settingsManager.setPackages([{ source: packageDir, harness: [] }]);

		const resolved = await packageManager.resolve();

		expect(resolved.harness).toContainEqual(expect.objectContaining({ path: memoryPath, enabled: false }));
	});

	it("ranks project-scope package harness resources ahead of user-scope ones", { timeout: 10_000 }, async () => {
		const projectDir = join(tempDir, "project-package");
		const userDir = join(tempDir, "user-package");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "project-package" }));
		writeFileSync(join(userDir, "package.json"), JSON.stringify({ name: "user-package" }));
		const projectPath = writePackageFile(projectDir, "harness/memory/shared.json", harnessJson("memory", "shared"));
		const userPath = writePackageFile(userDir, "harness/memory/shared.json", harnessJson("memory", "shared"));
		settingsManager.setPackages([userDir]);
		settingsManager.setProjectPackages([projectDir]);

		const resolved = await packageManager.resolve();

		expect(resolved.harness[0]).toMatchObject({ path: projectPath, metadata: { scope: "project" } });
		expect(resolved.harness[1]).toMatchObject({ path: userPath, metadata: { scope: "user" } });
	});

	it("resolves no harness resources when no packages are configured", { timeout: 10_000 }, async () => {
		const resolved = await packageManager.resolve();

		expect(resolved.harness).toEqual([]);
		expect(resolved.extensions).toEqual([]);
		expect(resolved.prompts).toEqual([]);
		expect(resolved.themes).toEqual([]);
	});
});
