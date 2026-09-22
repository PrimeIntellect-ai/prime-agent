import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentCronJob, AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import * as sessionManager from "../../../src/core/session-manager.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { RlmSpawnLedger } from "../../../src/modes/daemon/rlm-ledger.js";
import { createHarness, type Harness } from "../harness.js";

interface SupervisorHarness {
	defaultSessionConfig: { agentDir: string };
	rlmSpawnLedger(): RlmSpawnLedger;
	collectPassiveScheduledJobs(): Promise<
		Array<{ rootSessionFile: string; job: AgentCronJob; info: sessionManager.SessionInfo }>
	>;
	findWorkerBySessionFile(path: string): unknown;
}
const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function createSupervisorHarness(): Promise<SupervisorHarness> {
	const harness = await createHarness();
	harnesses.push(harness);
	const directory = harness.tempDir;
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}
describe("scheduled catalog metadata scans", () => {
	it.each(["", "\n \t\r\n", "\n".repeat(65_536), "malformed JSON\n", "\n".repeat(1024 * 1024)])(
		"only scans scheduled transcripts while retaining ancestry, imported session ids, and archived filtering (case %#)",
		async (prefix) => {
			const supervisor = await createSupervisorHarness();
			const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
			const [parent, child, archived, unrelated] = ["parent", "child", "archived", "unrelated"].map((name) => {
				const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
				manager.newSession({ parentSession: join(directory, "stale-parent.jsonl"), rlmDepth: 9 });
				manager.appendSessionInfo(name);
				manager.appendMessage({ role: "user", content: name, timestamp: 1 });
				if (name === "archived") manager.appendSessionState({ status: "archived" });
				manager.flushNow();
				return manager;
			});
			const parentFile = parent!.getSessionFile()!;
			const childFile = join(directory, "sessions", "imported-child.jsonl");
			renameSync(child!.getSessionFile()!, childFile);
			writeFileSync(childFile, prefix + readFileSync(childFile, "utf8"));
			await supervisor.rlmSpawnLedger().appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: childFile,
				depth: 1,
				name: "ledger-child",
			});
			const store = AgentCronJobStore.forSessionArtifacts();
			for (const manager of [child!, archived!]) {
				store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
				await store.createHeartbeat({
					activeSessionId: manager.getSessionId(),
					sessionId: manager.getSessionId(),
					sessionFile: manager === child ? childFile : manager.getSessionFile()!,
					cwd: directory,
					scheduleText: "every 1h",
					prompt: "continue",
				});
			}
			const readInfo = vi.spyOn(sessionManager, "readSessionInfo");
			const jobs = await supervisor.collectPassiveScheduledJobs();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({
				rootSessionFile: parentFile,
				info: {
					id: child!.getSessionId(),
					name: "ledger-child",
					firstMessage: "child",
					parentSessionPath: parentFile,
					rlmDepth: 1,
				},
			});
			expect(readInfo).toHaveBeenCalledTimes(2);
			expect(readInfo).not.toHaveBeenCalledWith(parentFile);
			expect(readInfo).not.toHaveBeenCalledWith(unrelated!.getSessionFile());
			const late = unrelated!;
			store.registerSessionArtifact(late.getSessionId(), late.getSessionArtifactDir()!);
			await store.createHeartbeat({
				activeSessionId: late.getSessionId(),
				sessionId: late.getSessionId(),
				sessionFile: late.getSessionFile()!,
				cwd: directory,
				scheduleText: "every 1h",
				prompt: "continue",
			});
			expect(await supervisor.collectPassiveScheduledJobs()).toHaveLength(2);
			expect(readInfo).toHaveBeenCalledWith(late.getSessionFile());
			vi.spyOn(supervisor, "findWorkerBySessionFile").mockImplementation((path) =>
				path === parentFile ? {} : undefined,
			);
			expect(await supervisor.collectPassiveScheduledJobs()).toMatchObject([{ info: { id: late.getSessionId() } }]);
		},
	);

	it.each(["\n", "x"])("falls back to full metadata for oversized header probes (case %#)", async (prefix) => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.flushNow();
		const file = manager.getSessionFile()!;
		writeFileSync(file, `${prefix.repeat(2 * 1024 * 1024)}\n${readFileSync(file, "utf8")}`);
		const readInfo = vi.spyOn(sessionManager, "readSessionInfo");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: file,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		expect(await supervisor.collectPassiveScheduledJobs()).toMatchObject([{ info: { id: manager.getSessionId() } }]);
		expect(readInfo).toHaveBeenCalledWith(file);
	});
});
