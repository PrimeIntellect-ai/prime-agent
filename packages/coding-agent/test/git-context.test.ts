import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGitContext, gitContextsEqual } from "../src/utils/git.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();
}

function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.co");
	git(dir, "config", "user.name", "t");
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

describe("captureGitContext", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "git-context-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads branch, commit, and normalized repo url", () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		const sha = commit(dir, "init");

		expect(captureGitContext(dir)).toEqual({
			branch: "main",
			commit: sha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("reports a detached HEAD as a commit with no branch", () => {
		initRepo(dir);
		const sha = commit(dir, "init");
		git(dir, "checkout", "-q", sha);

		const ctx = captureGitContext(dir);
		expect(ctx?.commit).toBe(sha);
		expect(ctx?.branch).toBeUndefined();
	});

	it("omits repo url when there is no origin remote", () => {
		initRepo(dir);
		const sha = commit(dir, "init");

		const ctx = captureGitContext(dir);
		expect(ctx?.repoUrl).toBeUndefined();
		expect(ctx?.commit).toBe(sha);
	});

	it("keeps an ssh remote url verbatim when it cannot be normalized", () => {
		initRepo(dir);
		git(dir, "remote", "add", "origin", "git@github.com:acme/widgets.git");
		commit(dir, "init");

		expect(captureGitContext(dir)?.repoUrl).toBe("git@github.com:acme/widgets.git");
	});

	it("returns null outside a git repo", () => {
		expect(captureGitContext(dir)).toBeNull();
	});
});

describe("gitContextsEqual", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";
	const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

	it("compares all fields", () => {
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA, branch: "main" })).toBe(true);
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA2, branch: "main" })).toBe(false);
		expect(gitContextsEqual({ commit: SHA }, { commit: SHA, branch: "main" })).toBe(false);
	});
});
