import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, idleEvictionSweepIntervalMs } from "../src/modes/daemon/daemon-supervisor.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
		createCommand: { type: "create"; config?: { sessionDir?: string } };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	updateRestartPrepareClient?: object;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	idleEvictionFence?: Promise<void>;
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	scheduleIdleEvictionSweep(): void;
	runIdleEvictionSweep(now?: number): Promise<void>;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
	handleCommand(client: object, command: object): Promise<unknown>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, now: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date(now - 120 * 60_000).toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeWorker(id: string, summaries: SessionSummary[]): WorkerFixture {
	const client = {
		request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
		requestWorker: vi.fn(),
		close: vi.fn(),
	};
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-descriptor-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client,
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

function makeSupervisor(idleEvictionMinutes: number | "off" = 90): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-eviction-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.stopWorker = vi.fn(async (worker: WorkerFixture) => {
		supervisor.workers.delete(worker.descriptor.workerId);
	});
	supervisor.log = vi.fn();
	return supervisor;
}

describe("daemon supervisor whole-tree eviction", () => {
	it("derives a bounded sweep interval from the live threshold", () => {
		expect(idleEvictionSweepIntervalMs("off")).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(90)).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(6)).toBe(2 * 60_000);
		expect(idleEvictionSweepIntervalMs(1)).toBe(60_000);
	});

	it("stops a fully idle worker and leaves pinned workers resident", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now), makeSummary("idle-child", now)]);
		const active = makeWorker("active", [makeSummary("active-root", now, { isSessionActive: true })]);
		const heartbeat = makeWorker("heartbeat", [makeSummary("heartbeat-root", now, { hasRegisteredHeartbeat: true })]);
		const cron = makeWorker("cron", [makeSummary("cron-root", now, { hasRegisteredCronJob: true })]);
		const attached = makeWorker("attached", [makeSummary("attached-root", now)]);
		for (const worker of [idle, active, heartbeat, cron, attached]) {
			supervisor.workers.set(worker.descriptor.workerId, worker);
		}
		supervisor.clients.add({ id: "viewer", attachedActiveSessionIds: new Set(["attached-root"]) });

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringMatching(/Evicted idle worker idle .*idleMinutes=120 sessions=2/),
		);
		expect([...supervisor.workers.keys()].sort()).toEqual(["active", "attached", "cron", "heartbeat"]);
	});

	it("delegates capped child passivation only to live non-evictable workers", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const active = makeWorker("active", [
			makeSummary("active-root", now, { isSessionActive: true }),
			makeSummary("idle-child", now, { runtimeKind: "subagent", parentActiveSessionId: "active-root" }),
		]);
		const whollyIdle = makeWorker("wholly-idle", [makeSummary("idle-root", now)]);
		active.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_passivate_idle_children",
			success: true,
			data: { count: 1 },
		});
		supervisor.workers.set("active", active);
		supervisor.workers.set("wholly-idle", whollyIdle);

		await supervisor.runIdleEvictionSweep(now);

		expect(active.client?.requestWorker).toHaveBeenCalledWith(
			{
				type: "worker_passivate_idle_children",
				idleEvictionMinutes: 90,
				now,
				limit: 2,
			},
			30_000,
		);
		expect(whollyIdle.client?.requestWorker).not.toHaveBeenCalled();
		expect(supervisor.stopWorker).toHaveBeenCalledWith(whollyIdle, true);
	});

	it("does not fence unrelated mutations while child passivation is in flight", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const active = makeWorker("active", [makeSummary("active-root", now, { isSessionActive: true })]);
		let releasePassivation!: () => void;
		active.client!.requestWorker.mockImplementation(
			() =>
				new Promise((resolve) => {
					releasePassivation = () =>
						resolve({
							type: "response",
							command: "worker_passivate_idle_children",
							success: true,
							data: { count: 0 },
						});
				}),
		);
		supervisor.workers.set("active", active);

		const sweep = supervisor.runIdleEvictionSweep(now);
		await vi.waitFor(() => expect(active.client?.requestWorker).toHaveBeenCalledOnce());

		expect(supervisor.idleEvictionFence).toBeUndefined();
		releasePassivation();
		await sweep;
	});

	it("uses canonical busy state so a stale parent with a running child is not evicted", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const parent = makeWorker("parent", [makeSummary("parent-root", now, { hasRunningRlmChildren: true })]);
		supervisor.workers.set("parent", parent);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.has("parent")).toBe(true);
	});

	it("evicts a paused-heartbeat session but pins an active-heartbeat session", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const paused = makeWorker("paused", [makeSummary("paused-root", now)]);
		const active = makeWorker("active-heartbeat", [
			makeSummary("active-heartbeat-root", now, { hasRegisteredHeartbeat: true }),
		]);
		supervisor.workers.set("paused", paused);
		supervisor.workers.set("active-heartbeat", active);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(paused, true);
		expect(supervisor.workers.has("active-heartbeat")).toBe(true);
	});

	it("honors off after reloading settings at sweep time", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor("off");
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(idle.client?.request).not.toHaveBeenCalled();
	});

	it("awaits an in-flight eviction sweep before shutdown tears down workers", async () => {
		vi.useFakeTimers();
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		vi.setSystemTime(now);
		let resolveList: (response: ReturnType<typeof success>) => void = () => undefined;
		const listResponse = new Promise<ReturnType<typeof success>>((resolve) => {
			resolveList = resolve;
		});
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		idle.client!.request = vi.fn(() => listResponse);
		supervisor.workers.set("idle", idle);
		supervisor.catalog.stop = vi.fn(async () => undefined);
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);

		try {
			supervisor.scheduleIdleEvictionSweep();
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(idle.client?.request).toHaveBeenCalledOnce();

			const shutdown = supervisor.shutdown(42, false).then(
				() => undefined,
				(error: unknown) => error,
			);
			await Promise.resolve();
			expect(exit).not.toHaveBeenCalled();
			expect(supervisor.stopWorker).not.toHaveBeenCalled();

			resolveList(success(undefined, "list", { sessions: [makeSummary("idle-root", now)] }));
			await expect(shutdown).resolves.toEqual(new Error("exit 42"));
			expect(supervisor.stopWorker).not.toHaveBeenCalled();
			expect(exit).toHaveBeenCalledWith(42);
		} finally {
			exit.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reopens an inactive saved session through the existing create path used before attach", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const rootSummary = makeSummary("new-active-id", now, {
			sessionId: "saved-session",
			sessionFile: "/tmp/saved.jsonl",
		});
		const reopened = makeWorker("reopened", [rootSummary]);
		reopened.descriptor.rootActiveSessionId = "new-active-id";
		supervisor.createOrReuseWorker = vi.fn(async () => reopened);
		const client = { id: "viewer", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "create-1",
			type: "create",
			sessionPath: "/tmp/saved.jsonl",
			continueRecent: false,
		});

		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"viewer",
			expect.objectContaining({ sessionPath: "/tmp/saved.jsonl" }),
		);
		expect(response).toMatchObject({
			success: true,
			command: "create",
			data: { activeSessionId: "new-active-id", sessionId: "saved-session" },
		});
	});

	it("resolves a saved target in the source worker's create-time session directory", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const source = makeWorker("source", [sourceSummary]);
		source.descriptor.createCommand.config = { sessionDir: "/tmp/custom-sessions" };
		source.summaries = new Map([["source-active", sourceSummary]]);
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target-session",
			sessionFile: "/tmp/target.jsonl",
		});
		const target = makeWorker("target", [targetSummary]);
		target.descriptor.rootActiveSessionId = "target-active";
		target.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => "/tmp/target.jsonl");
		supervisor.createOrReuseWorker = vi.fn(async () => target);
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "message-1",
			type: "send_message",
			targetActiveSessionId: "target-session",
			fromActiveSessionId: "source-active",
			message: "wake up",
		});

		expect(supervisor.catalog.resolve).toHaveBeenCalledWith("target-session", "/tmp/project", "/tmp/custom-sessions");
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"sender",
			expect.objectContaining({ type: "create", sessionPath: "/tmp/target.jsonl", continueRecent: false }),
		);
		expect(target.client?.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: "target-active",
				message: "wake up",
			}),
			24 * 60 * 60 * 1000,
		);
		expect(response).toMatchObject({ success: true, id: "message-1", command: "send_message" });
	});

	it("delivers a same-worker name selector through its canonical active session id", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target-session",
			sessionName: "Saved target",
		});
		const worker = makeWorker("shared", [sourceSummary, targetSummary]);
		worker.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("shared", worker);
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "message-same-worker",
			type: "send_message",
			targetActiveSessionId: "Saved target",
			fromActiveSessionId: "source-active",
			message: "continue",
		});

		expect(worker.client?.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: "target-active",
				message: "continue",
			}),
			24 * 60 * 60 * 1000,
		);
		expect(worker.client?.request).not.toHaveBeenCalled();
		expect(response).toMatchObject({
			success: true,
			id: "message-same-worker",
			command: "send_message",
			data: { deliveryStatus: "delivered" },
		});
	});

	it("fails an unknown agent-message selector without forwarding it back to the worker", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now)]);
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => {
			throw new Error("Unknown saved session: missing-target");
		});
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				id: "message-missing",
				type: "send_message",
				targetActiveSessionId: "missing-target",
				fromActiveSessionId: "source-active",
				message: "continue",
			}),
		).rejects.toThrow("Unknown active session: missing-target");
		expect(source.client?.requestWorker).not.toHaveBeenCalled();
		expect(source.client?.request).toHaveBeenCalledOnce();
		expect(source.client?.request).toHaveBeenCalledWith({ type: "list" }, 5000);
	});

	it("propagates an ambiguous saved-session selector during a2a wake", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now)]);
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => {
			throw new Error('Ambiguous session selector "target"');
		});
		supervisor.createOrReuseWorker = vi.fn();
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				id: "message-ambiguous",
				type: "send_message",
				targetActiveSessionId: "target",
				fromActiveSessionId: "source-active",
				message: "wake up",
			}),
		).rejects.toThrow('Ambiguous session selector "target"');
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});
});
