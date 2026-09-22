import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

describe("SessionManager git state", () => {
	let repoDir: string;
	let sessionDir: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "sm-git-repo-"));
		sessionDir = mkdtempSync(join(tmpdir(), "sm-git-sessions-"));
		git(repoDir, "init", "-q", "-b", "main");
		git(repoDir, "config", "user.email", "t@t.co");
		git(repoDir, "config", "user.name", "t");
		git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		commit(repoDir, "init");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("records a git_state entry once per commit change", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		expect(sm.recordGitStateIfChanged()).toBeUndefined();
		expect(sm.getEntries().some((e) => e.type === "git_state")).toBe(false);

		const secondSha = commit(repoDir, "second");
		expect(sm.recordGitStateIfChanged()).toBeDefined();
		expect(sm.getEntries().find((e) => e.type === "git_state")).toMatchObject({
			type: "git_state",
			git: { commit: secondSha },
		});

		expect(sm.recordGitStateIfChanged()).toBeUndefined();
	});

	it("re-records git state on a branch that lacks it on its active path", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		const msgId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		commit(repoDir, "second");

		expect(sm.recordGitStateIfChanged()).toBeDefined();

		// Navigate to before that entry: this branch's nearest git context is the header (first commit),
		// so even though the file already holds a git_state for the live commit, a new one must be
		// appended on this path rather than deduped away.
		sm.branch(msgId);
		expect(sm.recordGitStateIfChanged()).toBeDefined();
	});

	it("keeps git_state entries out of the LLM context", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		commit(repoDir, "second");
		sm.recordGitStateIfChanged();
		expect(sm.buildSessionContext().messages).toHaveLength(0);
	});
});
