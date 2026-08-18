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
	let firstSha: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "sm-git-repo-"));
		sessionDir = mkdtempSync(join(tmpdir(), "sm-git-sessions-"));
		git(repoDir, "init", "-q", "-b", "main");
		git(repoDir, "config", "user.email", "t@t.co");
		git(repoDir, "config", "user.name", "t");
		git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
		firstSha = commit(repoDir, "init");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("captures git context in the session header", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		expect(sm.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("does not record a git_state entry when nothing changed", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		expect(sm.recordGitStateIfChanged()).toBeUndefined();
		expect(sm.getEntries().some((e) => e.type === "git_state")).toBe(false);
	});

	it("records a git_state entry when the commit changes", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		const secondSha = commit(repoDir, "second");

		const id = sm.recordGitStateIfChanged();
		expect(id).toBeDefined();

		const entry = sm.getEntries().find((e) => e.type === "git_state");
		expect(entry).toMatchObject({ type: "git_state", git: { commit: secondSha } });

		expect(sm.recordGitStateIfChanged()).toBeUndefined();
	});

	it("re-records git state on a branch that lacks it on its active path", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		const msgId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		commit(repoDir, "second");

		expect(sm.recordGitStateIfChanged()).toBeDefined();

		// Navigate to before that entry: this branch's nearest git context is the header (firstSha),
		// so even though the file already holds a git_state for the live commit, a new one must be
		// appended on this path rather than deduped away.
		sm.branch(msgId);
		expect(sm.recordGitStateIfChanged()).toBeDefined();
	});

	it("captures git context in a forked session header", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		const msgId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		sm.createBranchedSession(msgId);
		expect(sm.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("captures target git context when forking and drops the source's git_state", () => {
		const sourcePath = join(sessionDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "src",
					timestamp: "t",
					cwd: "/old",
					git: { repoUrl: "https://github.com/acme/source.git", commit: "sourcesha", branch: "main" },
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				JSON.stringify({
					type: "git_state",
					id: "g1",
					parentId: "m1",
					timestamp: "t",
					git: { repoUrl: "https://github.com/acme/source.git", commit: "sourcesha", branch: "main" },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "g1",
					timestamp: "t",
					message: { role: "user", content: "more", timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		const forked = SessionManager.forkFrom(sourcePath, repoDir, sessionDir);

		expect(forked.getHeader()?.git).toEqual({
			branch: "main",
			commit: firstSha,
			repoUrl: "https://github.com/acme/widgets.git",
		});
		// Source git_state is dropped and its child re-linked to keep the tree intact.
		const entries = forked.getEntries();
		expect(entries.some((e) => e.type === "git_state")).toBe(false);
		expect(entries.find((e) => e.id === "m2")?.parentId).toBe("m1");
	});

	it("keeps git_state entries out of the LLM context", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		commit(repoDir, "second");
		sm.recordGitStateIfChanged();
		expect(sm.buildSessionContext().messages).toHaveLength(0);
	});
});
