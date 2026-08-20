import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/core/skills.js";

const roots: string[] = [];

function writeSkill(root: string, name: string, body: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`);
	return dir;
}

function newRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

describe("skill name collisions", () => {
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
	});

	it("does not report a collision when a local skill shadows a bundled one", () => {
		const root = newRoot("skills-shadow-");
		writeSkill(root, "brainstorming", "local checkout wins");

		// includeDefaults pulls in the bundled superpowers tree, which also defines brainstorming.
		const result = loadSkills({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [root],
			includeDefaults: true,
		});
		const brainstormingCollisions = result.diagnostics.filter(
			(d) => d.type === "collision" && d.collision?.name === "brainstorming",
		);

		expect(brainstormingCollisions).toEqual([]);
	});

	it("still reports a collision between two non-bundled sources", () => {
		const root = newRoot("skills-conflict-");
		const a = join(root, "a");
		const b = join(root, "b");
		writeSkill(a, "duplicate-demo", "one");
		writeSkill(b, "duplicate-demo", "two");

		const result = loadSkills({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [a, b],
			includeDefaults: false,
		});

		expect(
			result.diagnostics.filter((d) => d.type === "collision" && d.collision?.name === "duplicate-demo"),
		).toHaveLength(1);
	});
});
