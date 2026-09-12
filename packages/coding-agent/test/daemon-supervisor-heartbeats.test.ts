import { mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import * as sessionManager from "../src/core/session-manager.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

interface SupervisorHarness {
	defaultSessionConfig: { agentDir: string };
	workers: Map<string, unknown>;
	rlmSpawnLedger(): RlmSpawnLedger;
	collectPassiveScheduledJobs(): Promise<
		Array<{ rootSessionFile: string; job: AgentCronJob; info: sessionManager.SessionInfo }>
	>;
	findWorkerBySessionFile(path: string): unknown;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering" | "failed", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it("shares concurrent refreshes across clients while preserving response ids", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scan = vi.spyOn(supervisor, "collectPassiveScheduledJobs").mockImplementation(async () => {
			await blocked;
			return [];
		});
		const requests = Array.from({ length: 10 }, (_, index) =>
			supervisor.handleCommand({ id: `client-${index}` } as DaemonSocketClient, {
				id: `list-${index}`,
				type: "heartbeats_list",
			}),
		);
		await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		release();
		const responses = await Promise.all(requests);
		for (const [index, response] of responses.entries()) {
			expect(response).toMatchObject({ id: `list-${index}`, success: true, data: { heartbeats: [] } });
		}
		await supervisor.handleCommand({} as DaemonSocketClient, { type: "heartbeats_list" });
		expect(scan).toHaveBeenCalledTimes(2);
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("clears a rejected refresh so the next request can recover", async () => {
		const supervisor = createSupervisorHarness();
		const scan = vi
			.spyOn(supervisor, "collectPassiveScheduledJobs")
			.mockRejectedValueOnce(new Error("unreadable ledger"))
			.mockResolvedValue([]);
		await expect(supervisor.handleCommand({} as DaemonSocketClient, { type: "heartbeats_list" })).rejects.toThrow(
			"unreadable ledger",
		);
		await expect(
			supervisor.handleCommand({} as DaemonSocketClient, { type: "heartbeats_list" }),
		).resolves.toMatchObject({ success: true, data: { heartbeats: [] } });
		expect(scan).toHaveBeenCalledTimes(2);
	});

	it("starts a fresh read after changes without letting the older read overwrite its snapshot", async () => {
		const supervisor = createSupervisorHarness();
		const target = { ...worker("ready"), heartbeatSnapshot: [], heartbeatSnapshotStale: false };
		supervisor.workers.set("ready", target);
		vi.spyOn(supervisor, "collectPassiveScheduledJobs").mockResolvedValue([]);
		const replies: Array<(response: DaemonResponse) => void> = [];
		supervisor.forwardToWorker = vi.fn(() => new Promise<DaemonResponse>((resolve) => replies.push(resolve)));
		const old = supervisor.handleCommand({} as DaemonSocketClient, { id: "old", type: "heartbeats_list" });
		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const current = supervisor.handleCommand({} as DaemonSocketClient, { id: "current", type: "heartbeats_list" });
		expect(replies).toHaveLength(2);
		replies[0]!(success("old", "heartbeats_list", { heartbeats: [{ job: { id: "old-job" } }] }));
		await old;
		expect(target.heartbeatSnapshotStale).toBe(true);
		const joined = supervisor.handleCommand({} as DaemonSocketClient, { id: "joined", type: "heartbeats_list" });
		expect(replies).toHaveLength(2);
		replies[1]!(success("current", "heartbeats_list", { heartbeats: [{ job: { id: "new-job" } }] }));
		await expect(current).resolves.toMatchObject({
			id: "current",
			data: { heartbeats: [{ job: { id: "new-job" } }] },
		});
		await expect(joined).resolves.toMatchObject({ id: "joined", data: { heartbeats: [{ job: { id: "new-job" } }] } });
		expect(target.heartbeatSnapshot).toEqual([{ job: { id: "new-job" } }]);
		expect(target.heartbeatSnapshotStale).toBe(false);
	});

	it("only scans scheduled transcripts while retaining ancestry, session ids, and archived filtering", async () => {
		const supervisor = createSupervisorHarness();
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
			store.createHeartbeat({
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
		vi.spyOn(supervisor, "findWorkerBySessionFile").mockImplementation((path) =>
			path === parentFile ? {} : undefined,
		);
		await expect(supervisor.collectPassiveScheduledJobs()).resolves.toEqual([]);
	});

	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("returns a worker failure instead of a partial catalog", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("does not fall back to a snapshot after the worker reports heartbeat changes", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-stale",
			type: "heartbeats_list",
		});

		expect(target.heartbeatSnapshotStale).toBe(true);
		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
	});

	it("fails rather than returning a partial catalog without a cached snapshot", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.workers.set("recovering", worker("recovering", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: false,
			error: "Cannot list heartbeats while session worker is recovering",
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("skips terminally failed workers without blocking healthy heartbeats", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("healthy", worker("ready"));
		supervisor.workers.set("failed", worker("failed", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-failed-worker",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("routes management by cached job ownership after a session unloads", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1", activeSessionId: "unloaded-session" } }],
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, {
				heartbeat: { id: "heartbeat-1", activeSessionId: "unloaded-session", status: "cancelled" },
			}),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: "unloaded-session",
			jobId: "heartbeat-1",
			action: "stop",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeat_manage", jobId: "heartbeat-1" }),
		);
		expect(target.heartbeatSnapshot).toEqual([]);
	});
});
