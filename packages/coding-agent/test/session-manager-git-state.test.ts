import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { captureGitContext, captureGitContextAsync } from "../src/utils/git.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(dir: string, message: string): string {
	writeFileSync(join(dir, "file.txt"), `${message}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function gitStateEntries(sm: SessionManager) {
	return sm.getEntries().filter((e) => e.type === "git_state");
}

describe("session git state", () => {
	let repoDir: string;
	let sessionDir: string;
	let plainDir: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "sm-git-repo-"));
		sessionDir = mkdtempSync(join(tmpdir(), "sm-git-sessions-"));
		plainDir = mkdtempSync(join(tmpdir(), "sm-git-plain-"));
		git(repoDir, "init", "-q", "-b", "main");
		git(repoDir, "config", "user.email", "t@t.co");
		git(repoDir, "config", "user.name", "t");
		git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(plainDir, { recursive: true, force: true });
	});

	describe("SessionManager git state", () => {
		beforeEach(() => {
			commit(repoDir, "init");
		});

		it("records git state only after tool activity, once per change, out of the LLM context", async () => {
			const sm = SessionManager.create(repoDir, sessionDir);
			expect(await sm.recordGitStateIfChanged()).toBeUndefined();

			commit(repoDir, "external");
			expect(await sm.recordGitStateIfChanged()).toBeUndefined();
			expect(gitStateEntries(sm)).toHaveLength(0);

			sm.appendMessage(toolResult());
			const sha = commit(repoDir, "tool-made");
			expect(await sm.recordGitStateIfChanged()).toBeDefined();
			expect(gitStateEntries(sm)[0]?.git).toMatchObject({ commit: sha, branch: "main" });
			expect(sm.buildSessionContext().messages).toHaveLength(1);

			expect(await sm.recordGitStateIfChanged()).toBeUndefined();
			expect(gitStateEntries(sm)).toHaveLength(1);

			sm.appendCustomMessageEntry("extension-note", "changed the repo", true);
			const customSha = commit(repoDir, "custom-message");
			expect(await sm.recordGitStateIfChanged()).toBeDefined();
			expect(gitStateEntries(sm)[1]?.git).toMatchObject({ commit: customSha });

			sm.appendMessage(toolResult());
			commit(repoDir, "concurrent");
			const [first, second] = await Promise.all([sm.recordGitStateIfChanged(), sm.recordGitStateIfChanged()]);
			expect(first).toBeDefined();
			expect(second).toBeUndefined();
			expect(gitStateEntries(sm)).toHaveLength(3);
		});

		it("re-records git state on a branch that lacks it on its active path", async () => {
			const sm = SessionManager.create(repoDir, sessionDir);
			const msgId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
			commit(repoDir, "second");

			expect(await sm.recordGitStateIfChanged()).toBeDefined();

			// This branch's nearest git context is the header commit: no dedupe against it.
			sm.branch(msgId);
			expect(await sm.recordGitStateIfChanged()).toBeDefined();
		});
	});

	describe("git context capture", () => {
		it("matches the sync capture, including concurrent first captures and the per-cwd repo url cache", async () => {
			git(repoDir, "commit", "-q", "--allow-empty", "-m", "init");
			const sync = captureGitContext(repoDir);
			const [a, b] = await Promise.all([captureGitContextAsync(repoDir), captureGitContextAsync(repoDir)]);
			expect(sync).not.toBeNull();
			expect(a).toEqual(sync);
			expect(b).toEqual(sync);

			git(repoDir, "remote", "set-url", "origin", "https://github.com/acme/other.git");
			expect((await captureGitContextAsync(repoDir))?.repoUrl).toBe(a?.repoUrl);
			expect(captureGitContext(repoDir)?.repoUrl).toBe(a?.repoUrl);
		});

		it("tracks unborn and detached HEADs without a branch where there is none", async () => {
			const unborn = await captureGitContextAsync(repoDir);
			expect(unborn).toEqual({
				branch: "main",
				repoUrl: expect.stringContaining("acme/widgets") as string,
			});

			git(repoDir, "commit", "-q", "--allow-empty", "-m", "init");
			git(repoDir, "checkout", "-q", "--detach");
			const detached = await captureGitContextAsync(repoDir);
			expect(detached?.commit).toBe(git(repoDir, "rev-parse", "HEAD"));
			expect(detached?.branch).toBeUndefined();
		});

		it("resolves null outside a git repository", async () => {
			expect(await captureGitContextAsync(plainDir)).toBeNull();
			expect(captureGitContext(plainDir)).toBeNull();
		});
	});
});
