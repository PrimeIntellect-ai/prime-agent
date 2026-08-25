import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { createHarness, type Harness } from "../harness.js";

type AgentDaemonCronInternals = {
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	createRuntime(command: { type: "create"; sessionPath: string }): Promise<ActiveSessionState>;
	sessions: Map<string, ActiveSessionState>;
	runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
};

function createDaemon(harness: Harness, createRuntime: CreateAgentSessionRuntimeFactory): AgentDaemon {
	return new AgentDaemon(join(harness.tempDir, "daemon.sock"), {
		defaultSessionConfig: {
			agentDir: harness.tempDir,
			cwd: harness.tempDir,
			sessionDir: join(harness.tempDir, "sessions"),
		},
		createRuntime,
	});
}

function createDueHeartbeat(
	store: AgentCronJobStore,
	input: { activeSessionId: string; sessionId: string; sessionFile: string; cwd: string },
): AgentCronJob {
	return store.createHeartbeat({
		...input,
		scheduleText: "every 10s",
		prompt: "continue scheduled work",
		now: new Date(Date.now() - 20_000),
	});
}

function runtimeResult(harness: Harness, cwd: string, agentDir: string) {
	return {
		session: harness.session,
		services: { cwd, agentDir } as never,
		diagnostics: [],
		extensionsResult: {} as never,
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

describe("ENG-4519 heartbeat rebirth", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("cancels legacy jobs instead of reopening an archived session", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.sessionManager.appendSessionState({ status: "active" });
		harness.sessionManager.appendSessionState({ status: "archived" });
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(async () => {
			throw new Error("archived sessions must not be reopened");
		});
		const daemon = createDaemon(harness, createRuntime);
		const internals = daemon as unknown as AgentDaemonCronInternals;
		const sessionFile = harness.session.sessionFile!;
		const heartbeat = createDueHeartbeat(internals.cronStore, {
			activeSessionId: "old-active",
			sessionId: harness.session.sessionId,
			sessionFile,
			cwd: harness.tempDir,
		});
		const pausedHeartbeat = internals.cronStore.createRlmHeartbeat({
			activeSessionId: "old-active",
			sessionId: harness.session.sessionId,
			sessionFile,
			cwd: harness.tempDir,
			scheduleText: "every 1m",
			prompt: "check internal work",
			now: new Date(),
		});
		internals.cronStore.updateRlmHeartbeat("old-active", pausedHeartbeat.id, { status: "pause" });

		await expect(internals.cronScheduler.runDue(new Date())).resolves.toBe(0);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(internals.sessions.size).toBe(0);
		for (const id of [heartbeat.id, pausedHeartbeat.id]) {
			expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "cancelled" });
		}
	});

	it("cancels a job without recreating its deleted session file", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(async () => {
			throw new Error("missing sessions must not be recreated");
		});
		const daemon = createDaemon(harness, createRuntime);
		const internals = daemon as unknown as AgentDaemonCronInternals;
		const sessionFile = join(harness.tempDir, "sessions", "deleted-session.jsonl");
		const heartbeat = createDueHeartbeat(internals.cronStore, {
			activeSessionId: "old-active",
			sessionId: "deleted-session",
			sessionFile,
			cwd: harness.tempDir,
		});

		await expect(internals.cronScheduler.runDue(new Date())).resolves.toBe(0);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(existsSync(sessionFile)).toBe(false);
		expect(internals.sessions.size).toBe(0);
		expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
			status: "cancelled",
		});
	});

	it("stops opening a runtime when its heartbeat is cancelled in flight", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.sessionManager.appendSessionState({ status: "active" });
		let releaseRuntime: () => void = () => {};
		const runtimeGate = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(async ({ cwd, agentDir }) => {
			await runtimeGate;
			return runtimeResult(harness, cwd, agentDir);
		});
		const daemon = createDaemon(harness, createRuntime);
		const internals = daemon as unknown as AgentDaemonCronInternals;
		const heartbeat = createDueHeartbeat(internals.cronStore, {
			activeSessionId: "old-active",
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile!,
			cwd: harness.tempDir,
		});

		const run = internals.runCronJob(heartbeat);
		await waitForCondition(() => createRuntime.mock.calls.length > 0);
		expect(createRuntime).toHaveBeenCalledOnce();
		internals.cronStore.cancel(heartbeat.id);
		releaseRuntime();

		await expect(run).resolves.toBe("skipped");
		expect(internals.sessions.size).toBe(0);
	});

	it("still restores and prompts a session explicitly persisted as active", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.sessionManager.appendSessionState({ status: "active" });
		const promptHeartbeat = vi.spyOn(harness.session, "promptHeartbeat").mockResolvedValue();
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(async ({ cwd, agentDir }) =>
			runtimeResult(harness, cwd, agentDir),
		);
		const daemon = createDaemon(harness, createRuntime);
		const internals = daemon as unknown as AgentDaemonCronInternals;
		const heartbeat = createDueHeartbeat(internals.cronStore, {
			activeSessionId: "old-active",
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile!,
			cwd: harness.tempDir,
		});

		await expect(internals.runCronJob(heartbeat)).resolves.toBeUndefined();

		expect(createRuntime).toHaveBeenCalledOnce();
		expect(internals.sessions.size).toBe(1);
		expect(promptHeartbeat).toHaveBeenCalledWith(
			expect.objectContaining({ id: heartbeat.id, prompt: "continue scheduled work" }),
			expect.objectContaining({
				streamingBehavior: "steer",
				followUpQueueKey: `heartbeat:${heartbeat.id}`,
				source: "rpc",
			}),
		);
	});
});
