import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { AgentCronJobStore, type AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { createHarness, type Harness } from "../harness.js";

type AgentDaemonCronInternals = {
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	registerCronStoreForState(state: ActiveSessionState): void;
	rebindCronJobsToState(state: ActiveSessionState): void;
};

describe("ENG-4657 update heartbeat recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs an overdue heartbeat after an unchanged worker session is restored", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("heartbeat recovered")]);
		const sessionFile = harness.session.sessionFile;
		const artifactDir = harness.sessionManager.getSessionArtifactDir();
		if (!sessionFile || !artifactDir) {
			throw new Error("Test session was not persisted");
		}

		const activeSessionId = "restored-active";
		const persistedStore = AgentCronJobStore.forSessionArtifacts();
		persistedStore.registerSessionArtifact(harness.session.sessionId, artifactDir);
		const heartbeat = persistedStore.createHeartbeat({
			activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile,
			cwd: harness.tempDir,
			scheduleText: "every 10s",
			prompt: "continue after the update",
			now: new Date(Date.now() - 20_000),
		});

		const daemon = new AgentDaemon(`${harness.tempDir}/worker.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "test-token", restoreActiveSessionId: activeSessionId },
		});
		const internals = daemon as unknown as AgentDaemonCronInternals;
		const state: ActiveSessionState = {
			activeSessionId,
			runtime: {
				session: harness.session,
				metadata: { kind: "top-level", createdAt: Date.now() },
				runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
				cwd: harness.tempDir,
				diagnostics: [],
				dispose: async () => {},
			} as unknown as AgentSessionRuntime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "restored-generation",
			lastEventSequence: 0,
		};
		internals.sessions.set(activeSessionId, state);
		internals.cronScheduler.start();

		try {
			internals.registerCronStoreForState(state);
			internals.rebindCronJobsToState(state);
			await waitFor(() => internals.cronStore.list().find((job) => job.id === heartbeat.id)?.runCount === 1);

			const recovered = internals.cronStore.list().find((job) => job.id === heartbeat.id);
			expect(recovered).toMatchObject({
				status: "active",
				runCount: 1,
				prompt: "continue after the update",
			});
			expect(Date.parse(recovered?.nextRunAt ?? "")).toBeGreaterThan(Date.now());
		} finally {
			internals.cronScheduler.stop();
		}
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for the restored heartbeat");
}
