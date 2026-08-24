import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	pathsInsideProtected,
	pathsOutsideOwned,
	touchedPaths,
	trackedUnder,
	worktreesWithChanges,
} from "../src/core/workflow/agent-collaboration.js";

const run = promisify(execFile);

async function repoWith(files: Record<string, string>, committed: readonly string[] = []): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "scope-check-"));
	await run("git", ["init", "-q"], { cwd: dir });
	await run("git", ["config", "user.email", "t@t"], { cwd: dir });
	await run("git", ["config", "user.name", "t"], { cwd: dir });
	await writeFile(join(dir, "seed"), "seed\n");
	await run("git", ["add", "."], { cwd: dir });
	await run("git", ["commit", "-qm", "seed"], { cwd: dir });
	for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
	if (committed.length > 0) await run("git", ["add", ...committed], { cwd: dir });
	return dir;
}

describe("workflow task scope violations", () => {
	it("reports a written path that no declared prefix covers", () => {
		expect(pathsOutsideOwned(["src/model.py", "eval/gate.py"], ["src"])).toEqual(["eval/gate.py"]);
	});

	it("permits nothing when the prefix list is empty, which is how a no-write task is enforced", () => {
		// [] and undefined are different: the dispatcher passes [] for a task holding no write
		// authority, and never reaches this function for a task with no declaration at all.
		expect(pathsOutsideOwned(["eval/gate.py"], [])).toEqual(["eval/gate.py"]);
	});

	it("reports every write for a no-write task, deduped and sorted", () => {
		expect(pathsOutsideOwned(["b.py", "a.py", "b.py"], [])).toEqual(["a.py", "b.py"]);
	});

	it("covers a path by directory prefix, not string prefix", () => {
		// "src" must not cover "srcfoo/x": prefix matching is per path segment.
		expect(pathsOutsideOwned(["srcfoo/x.py"], ["src"])).toEqual(["srcfoo/x.py"]);
	});

	it("sees a newly created file, which git diff alone cannot", async () => {
		const dir = await repoWith({ "gate.py": "assert False\n" });
		const written = await touchedPaths(dir);
		expect(written).toContain("gate.py");
		expect(pathsOutsideOwned(written, ["src"])).toEqual(["gate.py"]);
	});

	it("sees a staged edit to an existing file", async () => {
		const dir = await repoWith({ seed: "weakened\n" }, ["seed"]);
		expect(pathsOutsideOwned(await touchedPaths(dir), ["src"])).toEqual(["seed"]);
	});
});

describe("workflow immutable paths", () => {
	it("reports a write under a declared immutable prefix", () => {
		expect(pathsInsideProtected(["eval/gate.py", "src/model.py"], ["eval"])).toEqual(["eval/gate.py"]);
	});

	it("reports nothing when the workflow declared no immutable paths", () => {
		expect(pathsInsideProtected(["eval/gate.py"], [])).toEqual([]);
	});

	it("matches by directory segment, so a sibling directory is not protected by accident", () => {
		expect(pathsInsideProtected(["evaluation/gate.py"], ["eval"])).toEqual([]);
		expect(pathsInsideProtected(["eval/weeks/manifest.json"], ["eval"])).toEqual(["eval/weeks/manifest.json"]);
	});

	it("protects an exact file path, not only a directory", () => {
		expect(pathsInsideProtected(["eval/gate.py", "eval/other.py"], ["eval/gate.py"])).toEqual(["eval/gate.py"]);
	});

	it("applies independently of ownership, which is what makes it cover every task", () => {
		// A task owning src/ that edits the evaluator is reported by the immutable check even though
		// the ownership check would have to be opted into by declaring ownedPaths.
		const written = ["src/model.py", "eval/gate.py"];
		expect(pathsOutsideOwned(written, ["src", "eval"])).toEqual([]);
		expect(pathsInsideProtected(written, ["eval"])).toEqual(["eval/gate.py"]);
	});

	it("sees a newly created file beside a protected one", async () => {
		const dir = await repoWith({ "gate2.py": "assert True\n" });
		expect(pathsInsideProtected(await touchedPaths(dir), ["gate2.py"])).toEqual(["gate2.py"]);
	});
});

describe("immutable prefix audit", () => {
	it("counts tracked files under a prefix that exists", async () => {
		const dir = await repoWith({});
		expect(await trackedUnder(dir, "seed")).toBe(1);
	});

	it("returns zero for a prefix matching nothing, which is what a typo looks like", async () => {
		const dir = await repoWith({});
		expect(await trackedUnder(dir, "sed")).toBe(0);
		expect(await trackedUnder(dir, "eval/gate.py")).toBe(0);
	});

	it("does not count an untracked file, so a build artifact cannot pass for protection", async () => {
		const dir = await repoWith({ "gate.py": "x\n" });
		expect(await trackedUnder(dir, "gate.py")).toBe(0);
	});

	it("returns zero outside a repository rather than throwing", async () => {
		expect(await trackedUnder("/", "definitely-not-here")).toBe(0);
	});
});

describe("gitignore evasion", () => {
	it("stops seeing a file once it is ignored, which is why .gitignore itself must be protected", async () => {
		// Both detectors ask git, so anything a worker adds to .gitignore becomes invisible to them.
		// Appending one line is therefore a complete bypass of the scope and immutable checks - unless
		// .gitignore is itself declared immutable, which turns the bypass attempt into the thing that
		// gets reported.
		const dir = await repoWith({ "secret.py": "cheat\n" });
		expect(await touchedPaths(dir)).toContain("secret.py");

		await writeFile(join(dir, ".gitignore"), "secret.py\n");
		const afterIgnore = await touchedPaths(dir);
		expect(afterIgnore).not.toContain("secret.py");

		// The write that hid it is itself a write, and it lands under a protected prefix.
		expect(afterIgnore).toContain(".gitignore");
		expect(pathsInsideProtected(afterIgnore, [".gitignore"])).toEqual([".gitignore"]);
	});
});

describe("work escaping the observed tree", () => {
	it("reports a linked worktree that holds uncommitted work", async () => {
		const main = await repoWith({});
		const wt = join(main, "..", `wt-${Date.now().toString(36)}`);
		await run("git", ["worktree", "add", "-q", "-b", "feat", wt], { cwd: main });

		// Nothing written yet: the observed tree is clean and so is the worktree.
		expect(await worktreesWithChanges(main)).toEqual([]);

		await writeFile(join(wt, "model.py"), "x = 1\n");
		const changed = await worktreesWithChanges(main);
		expect(changed).toHaveLength(1);
		expect(await realpath(changed[0]!)).toBe(await realpath(wt));

		// The point of the check: the observed tree still looks completely idle.
		expect(await touchedPaths(main)).toEqual([]);
	});

	it("never reports the observed tree itself, even when it is dirty", async () => {
		const main = await repoWith({ "dirty.py": "x\n" });
		expect(await touchedPaths(main)).toContain("dirty.py");
		expect(await worktreesWithChanges(main)).toEqual([]);
	});

	it("returns nothing outside a repository rather than throwing", async () => {
		expect(await worktreesWithChanges("/")).toEqual([]);
	});
});
