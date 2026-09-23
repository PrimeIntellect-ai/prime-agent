import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore, SESSION_SCHEDULED_JOBS_FILENAME } from "../src/core/cron-jobs.js";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import {
	DaemonSupervisor,
	HEARTBEAT_LIST_FORWARD_TIMEOUT_MS,
	HEARTBEAT_LIST_LAUNCH_WAIT_MS,
	HEARTBEATS_CHANGED_COALESCE_MS,
	WORKER_HEARTBEAT_SNAPSHOT_MAX_AGE_MS,
} from "../src/modes/daemon/daemon-supervisor.js";

interface PassiveScheduledJobRow {
	rootSessionFile: string;
	job: { id: string; status: string; nextRunAt?: string };
	info: SessionInfo;
}

interface SupervisorHarness {
	workers: Map<string, unknown>;
	clients: Set<{ socket: { destroyed: boolean; write: ReturnType<typeof vi.fn> }; tracksHeartbeats?: boolean }>;
	openingWorkers: Map<string, Promise<unknown>>;
	catalogOpeningWorkers: Map<string, Promise<unknown>>;
	passiveScheduledJobs?: { rows: PassiveScheduledJobRow[]; scannedAt: number };
	findWorkerForClient(client: DaemonSocketClient, selector: string): Promise<{ worker: unknown }>;
	attachClient(client: unknown, command: unknown): Promise<unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
	rlmSpawnLedger(): { family: (filename?: string) => Promise<SessionInfo[]> };
	scheduleScheduledSessionWakeRecompute(): void;
	onWorkerResidencyGained(worker: object): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(directory?: string): SupervisorHarness {
	const agentDir = directory ?? mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	if (directory === undefined) tempDirs.push(agentDir);
	return new DaemonSupervisor(join(agentDir, "daemon.sock"), {
		defaultSessionConfig: { agentDir, cwd: agentDir },
		descriptorDir: join(agentDir, "workers"),
	}) as unknown as SupervisorHarness;
}

function sessionInfoFor(path: string, id: string): SessionInfo {
	return {
		path,
		id,
		cwd: path,
		rlmDepth: 0,
		created: new Date(),
		modified: new Date(),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

function passiveRow(sessionFile: string, id: string): PassiveScheduledJobRow {
	return { rootSessionFile: sessionFile, job: { id, status: "active" }, info: sessionInfoFor(sessionFile, id) };
}

const HEARTBEATS_CHANGED_FRAME = {
	header: { kind: "outbound" as const, outboundType: "heartbeats_changed" as const },
	payload: Buffer.alloc(0),
};

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function worker(
	lifecycle: "starting" | "ready" | "recovering" | "failed",
	connected = true,
): {
	descriptor: { lifecycle: "starting" | "ready" | "recovering" | "failed" };
	client?: object;
	heartbeatSnapshot?: Array<{ job: { id: string } }>;
	heartbeatSnapshotStale?: boolean;
} {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it.each([true, false])("waits for startup before listing heartbeats (registered: %s)", async (registered) => {
		const supervisor = createSupervisorHarness();
		const target = worker("starting");
		if (registered) supervisor.workers.set("target", target);
		let finishStartup = () => {};
		const opening = new Promise<unknown>((resolve) => {
			finishStartup = () => resolve(target);
		});
		supervisor.openingWorkers.set("target", opening);
		supervisor.catalogOpeningWorkers.set("target", opening);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const pending = supervisor.handleCommand({} as DaemonSocketClient, { type: "heartbeats_list" });
		expect(supervisor.forwardToWorker).not.toHaveBeenCalled();
		target.descriptor.lifecycle = "ready";
		supervisor.workers.set("target", target);
		finishStartup();

		await expect(pending).resolves.toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("skips client-owned launches without waiting on them", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("public", worker("ready"));
		// A client-owned create can never join the public catalog (isVisibleWorker),
		// so a launch that never settles must not gate the global list.
		supervisor.openingWorkers.set("private", new Promise<unknown>(() => {}));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const watchdog = new Promise<never>((_, reject) => {
			const timer = globalThis.setTimeout(
				() => reject(new Error("heartbeats_list waited on a client-owned launch")),
				1_000,
			);
			timer.unref?.();
		});
		const response = await Promise.race([
			supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" }),
			watchdog,
		]);

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("stops waiting on slow catalog launches after the launch wait budget", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.workers.set("public", worker("ready"));
			supervisor.openingWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.catalogOpeningWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
			);

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(supervisor.forwardToWorker).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_LAUNCH_WAIT_MS);
			await expect(pending).resolves.toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
			expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a still-starting worker after the launch wait instead of omitting it", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.workers.set("public", worker("ready"));
			supervisor.openingWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.catalogOpeningWorkers.set("slow", new Promise<unknown>(() => {}));
			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
			);

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
			});
			await vi.advanceTimersByTimeAsync(0);
			// The slow launch registers mid-wait but never becomes ready.
			supervisor.workers.set("slow", worker("starting"));

			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_LAUNCH_WAIT_MS);
			await expect(pending).resolves.toMatchObject({
				success: false,
				error: "Cannot list heartbeats while session worker is starting",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails the session-scoped list when the forward outlives its budget", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.findWorkerForClient = vi.fn(async () => ({ worker: worker("ready") }));
			supervisor.forwardToWorker = vi.fn(() => new Promise<DaemonResponse>(() => {}));

			const pending = supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-1",
				type: "heartbeats_list",
				activeSessionId: "session-1",
			});
			await vi.advanceTimersByTimeAsync(HEARTBEAT_LIST_FORWARD_TIMEOUT_MS);
			await expect(pending).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining("Timed out waiting for session worker to list heartbeats"),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds the session-scoped list forward inside the client request budget", async () => {
		const supervisor = createSupervisorHarness();
		const target = worker("ready");
		supervisor.findWorkerForClient = vi.fn(async () => ({ worker: target }));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
			activeSessionId: "session-1",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeats_list" }),
			HEARTBEAT_LIST_FORWARD_TIMEOUT_MS,
		);
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
		// The second list serves both workers from their cached snapshots: no re-forward per request.
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
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

	it("lets concurrent lists join one refresh without queuing a trailing pass", async () => {
		const supervisor = createSupervisorHarness();
		const target = worker("ready");
		supervisor.workers.set("target", target);
		let release = () => {};
		const firstAnswer = new Promise<void>((resolve) => {
			release = resolve;
		});
		let forwards = 0;
		supervisor.forwardToWorker = vi.fn(async (_worker, command) => {
			if (++forwards === 1) await firstAnswer;
			return success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] });
		});

		const lists = ["list-1", "list-2"].map((id) =>
			supervisor.handleCommand({} as DaemonSocketClient, { id, type: "heartbeats_list" }),
		);
		await flushAsyncWork();
		release();
		await Promise.all(lists);

		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("refreshes only the reporting worker, coalesces frames, ages out, and never serves a stale snapshot", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const first = worker("ready");
			const second = worker("ready");
			supervisor.workers.set("first", first);
			supervisor.workers.set("second", second);
			let firstHeartbeatId = "heartbeat-1";
			let secondHeartbeatId = "heartbeat-2";
			supervisor.forwardToWorker = vi.fn(async (target, command) =>
				success(command.id, command.type, {
					heartbeats: [{ job: { id: target === first ? firstHeartbeatId : secondHeartbeatId } }],
				}),
			);
			const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
			const list = (id: string) =>
				supervisor.handleCommand({} as DaemonSocketClient, { id, type: "heartbeats_list" });

			// One forward per worker populates the snapshots; repeated lists serve them.
			await list("list-1");
			await list("list-2");
			expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);

			secondHeartbeatId = "heartbeat-2-updated";
			for (let frame = 0; frame < 3; frame++) {
				supervisor.handleWorkerFrame(second, HEARTBEATS_CHANGED_FRAME);
			}
			await vi.advanceTimersByTimeAsync(0);
			expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(4);
			expect(family).toHaveBeenCalledTimes(1);

			const updated = (await list("list-3")) as { data?: { heartbeats?: Array<{ job: { id: string } }> } };
			expect(updated.data?.heartbeats?.map((heartbeat) => heartbeat.job.id)).toEqual([
				"heartbeat-1",
				"heartbeat-2-updated",
			]);

			firstHeartbeatId = "heartbeat-1-updated";
			await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_SNAPSHOT_MAX_AGE_MS);
			const served = (await list("list-4")) as { data?: { heartbeats?: Array<{ job: { id: string } }> } };
			expect(served.data?.heartbeats?.[0]?.job.id).toBe("heartbeat-1");
			await vi.advanceTimersByTimeAsync(0);
			expect(first.heartbeatSnapshot).toEqual([{ job: { id: "heartbeat-1-updated" } }]);

			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				failure(command.id, command.type, "worker unavailable"),
			);
			supervisor.handleWorkerFrame(second, HEARTBEATS_CHANGED_FRAME);
			await vi.advanceTimersByTimeAsync(0);
			const failedRefresh = await list("list-5");
			expect(second.heartbeatSnapshotStale).toBe(true);
			expect(failedRefresh).toMatchObject({ success: false, error: "worker unavailable" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("daemon supervisor passive scheduled-jobs snapshot", () => {
	it("keeps the passive snapshot honest across residency gains without disk scans", async () => {
		const supervisor = createSupervisorHarness();
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
		const scan = vi.spyOn(
			supervisor as unknown as { scanPassiveScheduledJobs: () => Promise<unknown[]> },
			"scanPassiveScheduledJobs",
		);
		const coverableSession = join("tmp", "coverable.jsonl");
		const freshSession = join("tmp", "fresh.jsonl");
		const covering = {
			descriptor: {
				workerId: "worker-1",
				lifecycle: "ready",
				sessionFile: coverableSession,
				createCommand: { sessionPath: coverableSession },
			},
		} as never;
		supervisor.workers.set("worker-1", covering);
		const restarted = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};

		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [passiveRow(coverableSession, "job-1")],
		};
		supervisor.scheduleScheduledSessionWakeRecompute();
		await flushAsyncWork();
		expect(scan).not.toHaveBeenCalled();

		supervisor.onWorkerResidencyGained(restarted as never);
		expect(restarted.heartbeatSnapshotStale).toBe(true);
		let releaseFamily: (() => void) | undefined;
		family.mockImplementationOnce(() => new Promise((resolve) => (releaseFamily = () => resolve([]))));
		supervisor.onWorkerResidencyGained(covering);
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [passiveRow(freshSession, "job-2")],
		};
		releaseFamily!();
		await flushAsyncWork();
		const rows = supervisor.passiveScheduledJobs?.rows ?? [];
		expect(rows.map((row) => [row.rootSessionFile, row.job.id])).toEqual([[freshSession, "job-2"]]);

		family.mockRejectedValueOnce(new Error("ledger read failed")).mockResolvedValueOnce([]);
		supervisor.onWorkerResidencyGained(covering);
		await flushAsyncWork();
		expect(scan).toHaveBeenCalledTimes(1);
		expect(supervisor.passiveScheduledJobs?.rows).toEqual([]);
	});

	it("daemon-owned manage patches the snapshot row instead of rescanning", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-"));
		tempDirs.push(directory);
		const supervisor = createSupervisorHarness(directory);
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = await store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
		expect(family).toHaveBeenCalledTimes(1);
		const managed = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: manager.getSessionId(),
			jobId: job.id,
			action: "pause",
		});
		expect(managed).toMatchObject({ success: true, data: { heartbeat: { id: job.id, status: "paused" } } });

		const paused = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});
		expect(
			(paused as { data?: { heartbeats?: Array<{ job: { id: string; status: string } }> } }).data?.heartbeats,
		).toMatchObject([{ job: { id: job.id, status: "paused" } }]);
		expect(family).toHaveBeenCalledTimes(1);
	});

	it("forwards a manage to the worker that became resident while the passive write waited for the lock", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-"));
		tempDirs.push(directory);
		const supervisor = createSupervisorHarness(directory);
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = await store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
		const covering = {
			descriptor: {
				workerId: "worker-1",
				lifecycle: "ready",
				sessionFile: manager.getSessionFile(),
				createCommand: { sessionPath: manager.getSessionFile() },
			},
		} as never;
		supervisor.findWorkerForClient = vi.fn(async () => ({ worker: covering }));
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeat: { ...job, status: "paused" } }),
		);
		const jobsPath = join(manager.getSessionArtifactDir()!, SESSION_SCHEDULED_JOBS_FILENAME);
		const release = await lock(jobsPath, { realpath: false, lockfilePath: `${jobsPath}.lock`, stale: 30_000 });

		const managed = supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: manager.getSessionId(),
			jobId: job.id,
			action: "pause",
		});
		await flushAsyncWork();
		supervisor.workers.set("worker-1", covering);
		await release();

		await expect(managed).resolves.toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			covering,
			expect.objectContaining({ type: "heartbeat_manage", jobId: job.id }),
		);
		expect(store.list().map((candidate) => candidate.status)).toEqual(["active"]);
	});
});

describe("daemon supervisor heartbeats_changed delivery", () => {
	function socketClient(): {
		socket: { destroyed: boolean; write: ReturnType<typeof vi.fn> };
		tracksHeartbeats?: boolean;
		capabilities?: Set<string>;
	} {
		return {
			socket: { destroyed: false, write: vi.fn(() => true) },
			capabilities: new Set(["attach_snapshot", "event_sequence"]),
		};
	}

	function heartbeatsChangedWrites(client: { socket: { write: ReturnType<typeof vi.fn> } }): number {
		return client.socket.write.mock.calls.filter((args) => String(args[0]).includes('"type":"heartbeats_changed"'))
			.length;
	}

	it("delivers one coalesced push only to clients that track heartbeats", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const tracked = socketClient();
			const other = socketClient();
			supervisor.clients.add(tracked);
			supervisor.clients.add(other);
			await supervisor.handleCommand(tracked as never, { id: "list-1", type: "heartbeats_list" });
			expect(tracked.tracksHeartbeats).toBe(true);
			expect(other.tracksHeartbeats).toBeUndefined();
			const target = worker("ready");
			supervisor.workers.set("target", target);

			// Three frames in the window collapse into one push, not one per frame.
			for (let frame = 0; frame < 3; frame++) {
				supervisor.handleWorkerFrame(target, HEARTBEATS_CHANGED_FRAME);
			}
			await vi.advanceTimersByTimeAsync(HEARTBEATS_CHANGED_COALESCE_MS);
			expect(heartbeatsChangedWrites(tracked)).toBe(1);
			expect(heartbeatsChangedWrites(other)).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks clients that attach with the heartbeat_catalog capability and pushes to them", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			supervisor.attachClient = vi.fn(async () => ({ result: { activeSessionId: "active-1" } })) as never;
			const acp = socketClient();
			const plain = socketClient();
			supervisor.clients.add(acp);
			supervisor.clients.add(plain);
			await supervisor.handleCommand(acp as never, {
				id: "attach-1",
				type: "attach",
				activeSessionId: "active-1",
				capabilities: ["attach_snapshot", "event_sequence", "heartbeat_catalog"],
			});
			await supervisor.handleCommand(plain as never, {
				id: "attach-2",
				type: "attach",
				activeSessionId: "active-1",
				capabilities: ["attach_snapshot", "event_sequence"],
			});
			expect(acp.tracksHeartbeats).toBe(true);
			expect(plain.tracksHeartbeats).toBeUndefined();

			const target = worker("ready");
			supervisor.workers.set("target", target);
			supervisor.handleWorkerFrame(target, HEARTBEATS_CHANGED_FRAME);
			await vi.advanceTimersByTimeAsync(HEARTBEATS_CHANGED_COALESCE_MS);
			expect(heartbeatsChangedWrites(acp)).toBe(1);
			expect(heartbeatsChangedWrites(plain)).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
