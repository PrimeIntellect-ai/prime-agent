import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4527 worker heartbeat scheduling", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("starts 50 independently owned heartbeats while one worker is blocked", async () => {
		const workerCount = 50;
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("blocked worker completed")]);
		let releaseBlockedWorker: () => void = () => {};
		const blockedWorker = new Promise<void>((resolve) => {
			releaseBlockedWorker = resolve;
		});
		const started = new Set<number>();
		const stores: AgentCronJobStore[] = [];
		const runs: Array<Promise<number>> = [];
		const now = new Date();

		for (let index = 0; index < workerCount; index++) {
			const sessionId = `session-${index}`;
			const artifactDir = join(harness.tempDir, "session-artifacts", sessionId);
			const sessionFile = join(harness.tempDir, "sessions", `${sessionId}.jsonl`);
			const store = AgentCronJobStore.forSessionArtifacts();
			store.registerSessionArtifact(sessionId, artifactDir);
			store.createHeartbeat({
				activeSessionId: `worker-${index}`,
				sessionId,
				sessionFile,
				cwd: harness.tempDir,
				scheduleText: "every 10s",
				prompt: `heartbeat ${index}`,
				now: new Date(now.getTime() - 20_000),
			});
			stores.push(store);
			const scheduler = new AgentCronScheduler(store, {
				runJob: async (job) => {
					started.add(index);
					if (index === 0) {
						await blockedWorker;
						await harness.session.promptHeartbeat(job, { source: "rpc" });
					}
					return undefined;
				},
			});
			runs.push(scheduler.runDue(now));
		}

		await waitFor(
			() => started.size === workerCount,
			() => `${started.size}/${workerCount} workers started`,
		);
		expect(started.size).toBe(workerCount);
		for (const store of stores) {
			expect(store.nextActiveRunAt()?.getTime()).toBeGreaterThan(now.getTime());
		}

		releaseBlockedWorker();
		await Promise.all(runs);
		expect(stores.every((store) => store.list()[0]?.runCount === 1)).toBe(true);
	}, 60_000);
});

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (predicate()) {
		return;
	}
	throw new Error(`Timed out waiting for heartbeat fanout: ${describe()}`);
}
