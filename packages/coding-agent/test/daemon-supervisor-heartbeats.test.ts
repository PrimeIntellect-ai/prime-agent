import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
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
	onWorkerResidencyGained(): void;
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

function heartbeatIds(response: unknown): string[] {
	const rows = (response as { data?: { heartbeats?: Array<{ job: { id: string } }> } })?.data?.heartbeats;
	return (rows ?? []).map((heartbeat) => heartbeat.job.id);
}

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function worker(
	lifecycle: "starting" | "ready" | "recovering" | "failed",
	connected = true,
): {
	descriptor: { lifecycle: "starting" | "ready" | "recovering" | "failed" };
	client?: object;
	heartbeatSnapshot?: Array<{ job: { id: string } }>;
	heartbeatSnapshotStale?: boolean;
	heartbeatSnapshotAt?: number;
	heartbeatSnapshotRefresh?: Promise<void>;
	heartbeatSnapshotRefreshQueued?: boolean;
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
		// The second list serves both workers from their cached snapshots: the
		// recovering worker keeps its last complete one, and the healthy worker
		// is not re-forwarded per request.
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

	it("does not fan out to workers on repeated lists", async () => {
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

		const firstList = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(firstList).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);

		for (const id of ["list-2", "list-3"]) {
			const repeat = await supervisor.handleCommand({} as DaemonSocketClient, { id, type: "heartbeats_list" });
			expect(repeat).toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
			});
		}
		// One forward per worker populated its snapshot; repeated lists served from the cache.
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("refreshes only the worker that reported heartbeats_changed", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		let secondHeartbeatId = "heartbeat-2";
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : secondHeartbeatId } }],
			}),
		);

		await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);

		secondHeartbeatId = "heartbeat-2-updated";
		supervisor.handleWorkerFrame(second, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		await flushAsyncWork();

		// Only the reporting worker was re-forwarded, once.
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.forwardToWorker).toHaveBeenLastCalledWith(
			second,
			expect.objectContaining({ type: "heartbeats_list" }),
			5000,
		);

		const updated = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});
		expect(updated).toMatchObject({
			success: true,
			data: {
				heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2-updated" } }],
			},
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("coalesces a burst of heartbeats_changed frames into one refresh pass", async () => {
		const supervisor = createSupervisorHarness();
		const target = worker("ready");
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(1);

		for (let frame = 0; frame < 3; frame++) {
			supervisor.handleWorkerFrame(target, {
				header: { kind: "outbound", outboundType: "heartbeats_changed" },
				payload: Buffer.alloc(0),
			});
		}
		await flushAsyncWork();

		// Three frames in one burst collapse into the in-flight refresh plus at
		// most one trailing pass, not one forward per frame: one populate
		// forward plus two burst forwards.
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
		expect(target.heartbeatSnapshotStale).toBe(false);
	});

	it("refreshes an aged worker snapshot in the background while serving it", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const target = worker("ready");
			supervisor.workers.set("target", target);
			let heartbeatId = "heartbeat-1";
			supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: heartbeatId } }] }),
			);

			await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
			expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(1);

			// A missed frame cannot pin stale data forever: past the age bound the
			// next list serves the cached rows and refreshes in the background.
			heartbeatId = "heartbeat-1-updated";
			await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_SNAPSHOT_MAX_AGE_MS);
			const served = await supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-2",
				type: "heartbeats_list",
			});
			expect(served).toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
			expect(target.heartbeatSnapshot).toEqual([{ job: { id: "heartbeat-1-updated" } }]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("daemon supervisor passive scheduled-jobs snapshot", () => {
	it("arms the wake timer from the cached snapshot without a disk scan", async () => {
		const supervisor = createSupervisorHarness();
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [
				{
					rootSessionFile: join("tmp", "root.jsonl"),
					job: { id: "job-1", status: "active", nextRunAt: new Date(Date.now() + 3_600_000).toISOString() },
					info: sessionInfoFor(join("tmp", "root.jsonl"), "session-1"),
				},
			],
		};

		supervisor.scheduleScheduledSessionWakeRecompute();
		await flushAsyncWork();
		expect(family).not.toHaveBeenCalled();

		// Without a snapshot the same recompute still scans fresh.
		supervisor.passiveScheduledJobs = undefined;
		supervisor.scheduleScheduledSessionWakeRecompute();
		await flushAsyncWork();
		expect(family).toHaveBeenCalledTimes(1);
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
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(heartbeatIds(initial)).toEqual([job.id]);
		expect(family).toHaveBeenCalledTimes(1);

		const managed = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: manager.getSessionId(),
			jobId: job.id,
			action: "pause",
		});
		expect(managed).toMatchObject({ success: true, data: { heartbeat: { id: job.id, status: "paused" } } });

		// The paused row serves from the patched snapshot; no second scan.
		const paused = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});
		expect(heartbeatIds(paused)).toEqual([job.id]);
		expect((paused as { data?: { heartbeats?: Array<{ job: { status: string } }> } }).data?.heartbeats).toMatchObject(
			[{ job: { status: "paused" } }],
		);
		expect(family).toHaveBeenCalledTimes(1);
	});

	it("drops snapshot rows covered by a newly resident worker without a disk scan", async () => {
		const supervisor = createSupervisorHarness();
		vi.spyOn(supervisor.rlmSpawnLedger(), "family").mockResolvedValue([]);
		const scan = vi.spyOn(
			supervisor as unknown as { scanPassiveScheduledJobs: () => Promise<unknown[]> },
			"scanPassiveScheduledJobs",
		);
		const sessionFile = join("tmp", "root.jsonl");
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [
				{
					rootSessionFile: sessionFile,
					job: { id: "job-1", status: "active" },
					info: sessionInfoFor(sessionFile, "session-1"),
				},
			],
		};
		const covering = {
			descriptor: {
				workerId: "worker-1",
				lifecycle: "ready",
				sessionFile,
				createCommand: { sessionPath: sessionFile },
			},
		} as never;
		supervisor.workers.set("worker-1", covering);

		supervisor.onWorkerResidencyGained(covering);
		await flushAsyncWork();

		expect(supervisor.passiveScheduledJobs?.rows).toEqual([]);
		expect(scan).not.toHaveBeenCalled();
	});

	it("does not rescan the passive catalog when a worker reports heartbeats_changed", async () => {
		const supervisor = createSupervisorHarness();
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [],
		};
		const target = worker("ready");
		supervisor.workers.set("target", target);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		await flushAsyncWork();

		// A live worker's tree is never passive: the frame triggers only the
		// targeted snapshot refresh, not a fleet scan.
		expect(family).not.toHaveBeenCalled();
		expect(supervisor.passiveScheduledJobs?.rows).toEqual([]);
	});

	it("derives the residency drop from the current snapshot, not a pre-await copy", async () => {
		const supervisor = createSupervisorHarness();
		const coverableSession = join("tmp", "coverable.jsonl");
		const freshSession = join("tmp", "fresh.jsonl");
		let releaseFamily: (() => void) | undefined;
		const family = vi
			.spyOn(supervisor.rlmSpawnLedger(), "family")
			.mockImplementationOnce(() => new Promise((resolve) => (releaseFamily = () => resolve([]))));
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [
				{
					rootSessionFile: coverableSession,
					job: { id: "job-1", status: "active" },
					info: sessionInfoFor(coverableSession, "session-1"),
				},
			],
		};
		const covering = {
			descriptor: {
				workerId: "worker-1",
				lifecycle: "ready",
				sessionFile: coverableSession,
				createCommand: { sessionPath: coverableSession },
			},
		} as never;
		supervisor.workers.set("worker-1", covering);

		// The drop pass reads the ledger first; while it awaits, the snapshot
		// changes underneath it (a daemon-owned patch or a post-stop rescan).
		supervisor.onWorkerResidencyGained(covering);
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [
				{
					rootSessionFile: freshSession,
					job: { id: "job-2", status: "active" },
					info: sessionInfoFor(freshSession, "session-2"),
				},
			],
		};
		releaseFamily!();
		await flushAsyncWork();

		// The drop must not revert to its pre-await copy: the current rows are
		// what gets re-derived (the fresh uncovered row survives; the covered
		// pre-await row stays gone).
		expect(supervisor.passiveScheduledJobs?.rows).toEqual([
			{
				rootSessionFile: freshSession,
				job: { id: "job-2", status: "active" },
				info: sessionInfoFor(freshSession, "session-2"),
			},
		]);
		expect(family).toHaveBeenCalledTimes(1);
	});

	it("forces a fresh scan when the residency drop fails", async () => {
		const supervisor = createSupervisorHarness();
		const family = vi
			.spyOn(supervisor.rlmSpawnLedger(), "family")
			.mockRejectedValueOnce(new Error("ledger read failed"))
			.mockResolvedValueOnce([]);
		supervisor.passiveScheduledJobs = {
			scannedAt: Date.now(),
			rows: [
				{
					rootSessionFile: join("tmp", "root.jsonl"),
					job: { id: "job-1", status: "active" },
					info: sessionInfoFor(join("tmp", "root.jsonl"), "session-1"),
				},
			],
		};
		const covering = { descriptor: { workerId: "worker-1", lifecycle: "ready" } } as never;
		supervisor.workers.set("worker-1", covering);

		supervisor.onWorkerResidencyGained(covering);
		await flushAsyncWork();

		// The failed drop invalidates and the recompute it arms rescans fresh:
		// covered rows cannot linger in the snapshot pinning the wake timer.
		expect(family).toHaveBeenCalledTimes(2);
		expect(supervisor.passiveScheduledJobs?.rows).toEqual([]);
	});

	it("marks the previous incarnation's heartbeat snapshot stale on a ready transition", async () => {
		const supervisor = createSupervisorHarness();
		const restarted = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};

		supervisor.onWorkerResidencyGained(restarted as never);

		// A restart on the same worker object must not serve the previous
		// incarnation's snapshot as fresh for the age bound.
		expect(restarted.heartbeatSnapshotStale).toBe(true);
	});
});

describe("daemon supervisor heartbeats_changed delivery", () => {
	function socketClient(): {
		socket: { destroyed: boolean; write: ReturnType<typeof vi.fn> };
		tracksHeartbeats?: boolean;
	} {
		return { socket: { destroyed: false, write: vi.fn(() => true) } };
	}

	function heartbeatsChangedWrites(client: { socket: { write: ReturnType<typeof vi.fn> } }): string[] {
		return client.socket.write.mock.calls
			.map((args) => String(args[0]))
			.filter((line) => line.includes('"type":"heartbeats_changed"'));
	}

	it("marks clients as tracking on scheduled-job commands", async () => {
		const supervisor = createSupervisorHarness();
		const tracked = socketClient();
		const other = socketClient();

		await supervisor.handleCommand(tracked as never, { id: "list-1", type: "heartbeats_list" });
		await supervisor.handleCommand(tracked as never, { id: "cron-1", type: "cron_list" });

		expect(tracked.tracksHeartbeats).toBe(true);
		expect(other.tracksHeartbeats).toBeUndefined();
	});

	it("delivers heartbeats_changed only to clients that track heartbeats", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const tracked = socketClient();
			const other = socketClient();
			supervisor.clients.add(tracked);
			supervisor.clients.add(other);
			await supervisor.handleCommand(tracked as never, { id: "list-1", type: "heartbeats_list" });
			const target = worker("ready");
			supervisor.workers.set("target", target);

			supervisor.handleWorkerFrame(target, {
				header: { kind: "outbound", outboundType: "heartbeats_changed" },
				payload: Buffer.alloc(0),
			});
			await vi.advanceTimersByTimeAsync(HEARTBEATS_CHANGED_COALESCE_MS);

			expect(heartbeatsChangedWrites(tracked)).toHaveLength(1);
			expect(heartbeatsChangedWrites(other)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces a burst of mutations into one broadcast", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			const tracked = socketClient();
			supervisor.clients.add(tracked);
			await supervisor.handleCommand(tracked as never, { id: "list-1", type: "heartbeats_list" });
			const target = worker("ready");
			supervisor.workers.set("target", target);

			for (let frame = 0; frame < 3; frame++) {
				supervisor.handleWorkerFrame(target, {
					header: { kind: "outbound", outboundType: "heartbeats_changed" },
					payload: Buffer.alloc(0),
				});
			}
			await vi.advanceTimersByTimeAsync(HEARTBEATS_CHANGED_COALESCE_MS);

			// Three frames in the window collapse into one push, not one per frame.
			expect(heartbeatsChangedWrites(tracked)).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks clients that attach with the heartbeat_catalog capability and pushes to them", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = createSupervisorHarness();
			// The ACP adapter attaches with the capability and never issues a
			// scheduled-job command; the attach itself must opt it in.
			supervisor.attachClient = vi.fn(async () => ({ result: { activeSessionId: "active-1" } })) as never;
			const acp = socketClient();
			const plain = socketClient();
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
			supervisor.handleWorkerFrame(target, {
				header: { kind: "outbound", outboundType: "heartbeats_changed" },
				payload: Buffer.alloc(0),
			});
			await vi.advanceTimersByTimeAsync(HEARTBEATS_CHANGED_COALESCE_MS);

			expect(heartbeatsChangedWrites(acp)).toHaveLength(1);
			expect(heartbeatsChangedWrites(plain)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
