import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

describe("bundled workflow-builder skill", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `workflow-builder-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		mkdirSync(join(tempDir, "project"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads once by its public name alongside the existing workflow facade", () => {
		const result = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });
		const matches = result.skills.filter((skill) => skill.name === "workflow-builder");

		expect(result.diagnostics.filter((diagnostic) => diagnostic.path?.includes("workflow-builder"))).toEqual([]);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			name: "workflow-builder",
			kind: "markdown",
			sourceInfo: { source: "builtin" },
		});
		expect(result.skills.map((skill) => skill.name)).toContain("workflow");
	});

	it("resolves through the default bundled resource registry", async () => {
		const loader = new DefaultResourceLoader({
			cwd: join(tempDir, "project"),
			agentDir: join(tempDir, "agent"),
			bundledSkillsDir: getBundledSkillsDir(),
		});
		await loader.reload();

		const workflowBuilder = loader.getSkills().skills.find((skill) => skill.name === "workflow-builder");
		expect(workflowBuilder).toMatchObject({
			name: "workflow-builder",
			kind: "markdown",
			sourceInfo: { source: "builtin" },
		});
	});
});
