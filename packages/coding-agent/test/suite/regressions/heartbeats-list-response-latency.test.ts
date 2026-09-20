import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import * as sessionManager from "../../../src/core/session-manager.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import { createHarness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function createSupervisorHarness() {
	const harness = await createHarness();
	harnesses.push(harness);
	const directory = harness.tempDir;
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as {
		defaultSessionConfig: { agentDir: string };
		rlmSpawnLedger: DaemonSupervisor["rlmSpawnLedger"];
		handleCommand: DaemonSupervisor["handleCommand"];
		broadcastHeartbeatsChanged: DaemonSupervisor["broadcastHeartbeatsChanged"];
		passiveScheduledJobs?: { rows: unknown[]; scannedAt: number };
	};
}
type Supervisor = Awaited<ReturnType<typeof createSupervisorHarness>>;
function listHeartbeats(supervisor: Supervisor, id: string) {
	return supervisor.handleCommand({} as never, { id, type: "heartbeats_list" });
}
function heartbeatIds(response: Awaited<ReturnType<Supervisor["handleCommand"]>>): string[] {
	const rows = (response as { data?: { heartbeats?: Array<{ job: { id: string } }> } })?.data?.heartbeats;
	return (rows ?? []).map((h) => h.job.id);
}
describe("heartbeats_list response latency", () => {
	it("serves heartbeats_list from one shared scan without queueing behind metadata reads", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = (
			await store.createHeartbeat({
				activeSessionId: manager.getSessionId(),
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile()!,
				cwd: directory,
				scheduleText: "every 1h",
				prompt: "continue",
			})
		).id;
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
		const responses = await Promise.all(["1", "2", "3", "4", "5"].map((id) => listHeartbeats(supervisor, id)));
		expect(responses.map(heartbeatIds)).toEqual([[job], [job], [job], [job], [job]]); // one scan served five lists
		await listHeartbeats(supervisor, "6");
		expect(family).toHaveBeenCalledTimes(1); // all six lists shared one scan, then served from the snapshot
		const readSessionInfo = sessionManager.readSessionInfo;
		const [scanStarted, releaseScan] = [createDeferred(), createDeferred()];
		vi.spyOn(sessionManager, "readSessionInfo").mockImplementationOnce(async (...args) => {
			scanStarted.resolve();
			await releaseScan.promise;
			return readSessionInfo(...args);
		});
		supervisor.passiveScheduledJobs = undefined; // force the next list to scan cold
		const siblings = supervisor.rlmSpawnLedger().siblings(manager.getSessionFile()!);
		await scanStarted.promise;
		try {
			expect(heartbeatIds(await listHeartbeats(supervisor, "cold"))).toEqual([job]);
		} finally {
			releaseScan.resolve();
			await siblings;
		}
		await store.manageHeartbeat(manager.getSessionId(), job, "pause");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "7"))).toEqual([job]); // broadcast dropped the snapshot
		await store.manageHeartbeat(manager.getSessionId(), job, "stop");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "8"))).toEqual([]);
	});
});
