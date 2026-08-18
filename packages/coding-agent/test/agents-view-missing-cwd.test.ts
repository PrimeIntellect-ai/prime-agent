import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionLease } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createAgentsViewResumeConfig, resolveAgentsViewOpenCwd } from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "./utilities.js";

describe("agents view open with a missing session cwd", () => {
	it("repros the failure and proves the override opens the session", async () => {
		const root = mkdtempSync(join(tmpdir(), "agents-view-missing-cwd-"));
		const launchCwd = join(root, "launch");
		const worktree = join(root, "worktree");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		try {
			mkdirSync(launchCwd, { recursive: true });
			const session = SessionManager.create(worktree, sessionDir);
			session.appendMessage(userMsg("do the thing"));
			session.appendMessage(assistantMsg("done"));
			const sessionFile = session.getSessionFile()!;

			rmSync(worktree, { recursive: true, force: true });

			const factory = async () => {
				throw new Error("runtime factory should not be reached when the cwd is missing");
			};

			// With cwd stripped, the session resolves against its deleted cwd and throws.
			const stripped = await SessionManager.openAsync(sessionFile, sessionDir);
			const suppliedLease = new SessionLease(sessionFile, join(root, "missing-cwd-lease"), "lease-token");
			const releaseLease = vi.spyOn(suppliedLease, "release");
			await expect(
				createAgentSessionRuntime(factory, {
					cwd: stripped.getCwd(),
					agentDir,
					sessionManager: stripped,
					sessionLease: suppliedLease,
				}),
			).rejects.toThrowError(MissingSessionCwdError);
			expect(releaseLease).toHaveBeenCalledOnce();

			const summary: SessionSummary = {
				id: session.getSessionId(),
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				sessionId: session.getSessionId(),
				sessionFile,
				cwd: worktree,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 2,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			};
			const { overrideCwd, notice } = resolveAgentsViewOpenCwd(summary, launchCwd);
			expect(overrideCwd).toBe(launchCwd);
			expect(notice).toContain(worktree);

			const resumeConfig = createAgentsViewResumeConfig({ cwd: launchCwd, agentDir }, overrideCwd);
			const overridden = await SessionManager.openAsync(sessionFile, sessionDir, resumeConfig.cwd);
			expect(overridden.getCwd()).toBe(launchCwd);

			// The override gets the build past the cwd guard and into the factory.
			let factoryCwd: string | undefined;
			const okFactory = async (opts: { cwd: string }) => {
				factoryCwd = opts.cwd;
				throw new Error("stop after the cwd guard");
			};
			await expect(
				createAgentSessionRuntime(okFactory as never, {
					cwd: overridden.getCwd(),
					agentDir,
					sessionManager: overridden,
				}),
			).rejects.toThrow("stop after the cwd guard");
			expect(factoryCwd).toBe(launchCwd);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
