import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	allowsDirectMessages,
	changedPaths,
	computePathDiff,
	DEFAULT_AGENT_COLLABORATION,
	formatDiffPush,
	resolveAgentCollaboration,
	sharesDiffs,
} from "../src/core/workflow/agent-collaboration.js";

const roots: string[] = [];

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "collab-"));
	roots.push(root);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a - b\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
	return root;
}

describe("agent collaboration options", () => {
	afterEach(() => {
		while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
	});

	it("defaults to blind collaboration so nothing is shared unless asked", () => {
		expect(DEFAULT_AGENT_COLLABORATION.mode).toBe("blind");
		expect(sharesDiffs(DEFAULT_AGENT_COLLABORATION)).toBe(false);
		expect(allowsDirectMessages(DEFAULT_AGENT_COLLABORATION)).toBe(false);
	});

	it("enables diff sharing without direct messaging in push_diffs", () => {
		const options = resolveAgentCollaboration({ mode: "push_diffs" });
		expect(sharesDiffs(options)).toBe(true);
		expect(allowsDirectMessages(options)).toBe(false);
	});

	it("falls back to the default on an unknown mode rather than guessing", () => {
		expect(resolveAgentCollaboration({ mode: "chatty" as never }).mode).toBe("blind");
	});

	it("computes a real diff for a changed path", async () => {
		const root = repo();
		writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");

		expect(await changedPaths(root)).toEqual(["calc.py"]);
		const diff = await computePathDiff(root, "calc.py", 8_000);
		expect(diff).toBeDefined();
		expect(diff?.truncated).toBe(false);
		expect(diff?.body).toContain("return a + b");
		expect(formatDiffPush(diff!, "implementer")).toContain("implementer changed calc.py");
	});

	it("returns nothing for an unchanged path, so no empty push is sent", async () => {
		const root = repo();
		expect(await changedPaths(root)).toEqual([]);
		expect(await computePathDiff(root, "calc.py", 8_000)).toBeUndefined();
	});

	it("summarises an oversized diff instead of flooding the reviewer's context", async () => {
		const root = repo();
		writeFileSync(join(root, "calc.py"), Array.from({ length: 500 }, (_, i) => `x${i} = ${i}`).join("\n"));
		const diff = await computePathDiff(root, "calc.py", 200);
		expect(diff?.truncated).toBe(true);
		expect(diff?.body.length).toBeLessThan(2_000);
	});
});
