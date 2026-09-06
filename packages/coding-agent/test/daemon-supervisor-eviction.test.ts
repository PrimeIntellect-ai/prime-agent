import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionsDir } from "../src/config.js";
import { type AgentCronJob, AgentCronJobStore, SESSION_SCHEDULED_JOBS_FILENAME } from "../src/core/cron-jobs.js";
import { getSessionArtifactPathForFile, type SessionInfo } from "../src/core/session-manager.js";
import { workerRosterEntryFromSummary } from "../src/modes/daemon/agent-roster.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, idleEvictionSweepIntervalMs } from "../src/modes/daemon/daemon-supervisor.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		sessionFile?: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
		createCommand: { type: "create"; config?: { sessionDir?: string } };
		version?: number;
		supervisorSocketPath?: string;
		socketPath?: string;
		authenticationToken?: string;
		recoveryJournalPath?: string;
		createdAt?: string;
		updatedAt?: string;
		consecutiveFailures?: number;
	};
	descriptorPath?: string;
	transcriptCaches?: Map<string, unknown>;
	snapshotCache?: Map<string, unknown>;
	stopRevision?: number;
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
	mutationDrain: { begin(): void; end(): void };
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; list?: ReturnType<typeof vi.fn> };
	rlmSpawnLedgerInstance?: { family: ReturnType<typeof vi.fn>; liveEdges: ReturnType<typeof vi.fn> };
	updateRestartPhase?: "draining" | "fencing" | "prepared";
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	scheduledWakeTimer?: ReturnType<typeof setTimeout>;
	scheduledWakeRecompute?: Promise<void>;
	scheduleIdleEvictionSweep(): void;
	runIdleEvictionSweep(now?: number): Promise<void>;
	recomputeScheduledSessionWake(): Promise<void>;
	wakeDueScheduledSessions(now?: number): Promise<void>;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
	handleCommand(client: object, command: object): Promise<unknown>;
	writeRosterEntry(entry: object, worker?: object): unknown;
	cancelEphemeralWorkerScheduledJobs(worker: WorkerFixture): Promise<boolean>;
	descriptorDir: string;
	socketPath: string;
	defaultSessionConfig: { agentDir?: string; sessionDir?: string };
	persistWorker(worker: WorkerFixture): void;
	stopWorkerUntracked(worker: WorkerFixture, removeDescriptor: boolean, force?: boolean): Promise<void>;
	promoteOwnedWorker(client: object, worker: WorkerFixture): Promise<void>;
	loadWorkerDescriptors(): void;
	adoptOrRecoverWorker(worker: WorkerFixture): Promise<void>;
	assertRecoveryAllowed: () => Promise<void>;
	cancelScheduledJobsForSessionTree: (id: string, file: string) => Promise<void>;
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
		// A schedule outside the enumerable sessions root cannot be re-woken; it must stay resident.
		const sessionsRoot = getSessionsDir(supervisor.defaultSessionConfig.agentDir ?? "");
		mkdirSync(sessionsRoot, { recursive: true });
		heartbeat.descriptor.sessionFile = join(sessionsRoot, "heartbeat-root.jsonl");
		const blindDir = mkdtempSync(join(tmpdir(), "prime-custom-session-dir-"));
		tempDirs.push(blindDir);
		const blind = makeWorker("blind-heartbeat", [makeSummary("blind-root", now, { hasRegisteredHeartbeat: true })]);
		blind.descriptor.sessionFile = join(blindDir, "blind-root.jsonl");
		for (const worker of [idle, active, heartbeat, cron, attached, blind]) {
			supervisor.workers.set(worker.descriptor.workerId, worker);
		}
		seedSupervisorRoster(supervisor, idle, active, heartbeat, cron, attached, blind);
		supervisor.clients.add({ id: "viewer", attachedActiveSessionIds: new Set(["attached-root"]) });

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(2);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(heartbeat, true);
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringMatching(/Evicted idle worker idle .*idleMinutes=120 sessions=2/),
		);
		expect([...supervisor.workers.keys()].sort()).toEqual(["active", "attached", "blind-heartbeat", "cron"]);
	});

	it("keeps a custom-dir worker resident when a heartbeat lands during the eviction drain", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const blindDir = mkdtempSync(join(tmpdir(), "prime-custom-session-dir-"));
		tempDirs.push(blindDir);
		const worker = makeWorker("blind", [makeSummary("blind-root", now)]);
		worker.descriptor.sessionFile = join(blindDir, "blind-root.jsonl");
		supervisor.workers.set("blind", worker);
		seedSupervisorRoster(supervisor, worker);
		const armed = makeSummary("blind-root", now, { hasRegisteredHeartbeat: true });
		worker
			.client!.request.mockImplementationOnce(async () =>
				success(undefined, "list", { sessions: [makeSummary("blind-root", now)] }),
			)
			.mockImplementation(async () => {
				// A heartbeat_set admitted mid-drain pushes its registration mark before the fenced recheck.
				supervisor.writeRosterEntry(workerRosterEntryFromSummary(armed), worker);
				return success(undefined, "list", { sessions: [armed] });
			});

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.get("blind")).toBe(worker);
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
		seedSupervisorRoster(supervisor, active, whollyIdle);

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
		supervisor.createOrReuseWorker = vi.fn(async () => {
			seedSupervisorRoster(supervisor, reopened);
			return reopened;
		});
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
		Object.assign(source.descriptor, { sessionDir: "/tmp/custom-sessions" });
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
		seedSupervisorRoster(supervisor, source);
		supervisor.catalog.resolve = vi.fn(async () => "/tmp/target.jsonl");
		supervisor.createOrReuseWorker = vi.fn(async () => {
			seedSupervisorRoster(supervisor, target);
			return target;
		});
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
		seedSupervisorRoster(supervisor, worker);
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
		seedSupervisorRoster(supervisor, source);
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

describe("daemon supervisor empty-session eviction on detach", () => {
	function makeDetachClient(id: string, attached: string[]) {
		return { id, attachedActiveSessionIds: new Set(attached), socket: { destroyed: true } };
	}

	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	it("evicts only abandoned empty unnamed sessions, and only on the last detach", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const empty = makeWorker("empty", [makeSummary("empty-root", now, { messageCount: 0 })]);
		const heartbeat = makeWorker("heartbeat", [
			makeSummary("heartbeat-root", now, { messageCount: 0, hasRegisteredHeartbeat: true }),
		]);
		const exempt = [
			makeWorker("named", [makeSummary("named-root", now, { messageCount: 0, sessionName: "keep me" })]),
			makeWorker("busy", [makeSummary("busy-root", now, { messageCount: 0, isSessionActive: true })]),
			makeWorker("one-message", [makeSummary("one-message-root", now)]),
			makeWorker("cron", [makeSummary("cron-root", now, { messageCount: 0, hasRegisteredCronJob: true })]),
			makeWorker("owned", [makeSummary("owned-root", now, { messageCount: 0 })]),
			makeWorker("blind-heartbeat", [
				makeSummary("blind-root", now, { messageCount: 0, hasRegisteredHeartbeat: true }),
			]),
		];
		exempt[4]!.descriptor.ownerClientId = "owner";
		const blindDir = mkdtempSync(join(tmpdir(), "prime-custom-session-dir-"));
		tempDirs.push(blindDir);
		exempt[5]!.descriptor.sessionFile = join(blindDir, "blind-root.jsonl");
		for (const worker of [empty, heartbeat, ...exempt]) {
			supervisor.workers.set(worker.descriptor.workerId, worker);
		}
		seedSupervisorRoster(supervisor, empty, heartbeat, ...exempt);
		const first = makeDetachClient("first", ["empty-root"]);
		const viewer = makeDetachClient("viewer", [
			"empty-root",
			"named-root",
			"busy-root",
			"one-message-root",
			"heartbeat-root",
			"cron-root",
			"owned-root",
			"blind-root",
		]);
		supervisor.clients.add(first);
		supervisor.clients.add(viewer);

		await supervisor.handleCommand(first, { id: "detach-1", type: "detach", activeSessionId: "empty-root" });
		await settle();
		expect(supervisor.stopWorker).not.toHaveBeenCalled();

		await supervisor.handleCommand(viewer, { id: "detach-all", type: "detach" });
		await vi.waitFor(() => expect(supervisor.stopWorker).toHaveBeenCalledWith(empty, true));
		await vi.waitFor(() => expect(supervisor.stopWorker).toHaveBeenCalledWith(heartbeat, true));
		await settle();
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(2);
		expect([...supervisor.workers.keys()].sort()).toEqual([
			"blind-heartbeat",
			"busy",
			"cron",
			"named",
			"one-message",
			"owned",
		]);
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("Evicted empty session worker empty"));
	});

	it("evicts an empty draft when the worker reports its last direct viewer gone", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const liveSummaries = [makeSummary("draft-root", now, { messageCount: 0, directAttachedClients: 1 })];
		const worker = makeWorker("draft", liveSummaries);
		supervisor.workers.set("draft", worker);
		seedSupervisorRoster(supervisor, worker);

		// Clean detach and socket drop both surface as the same worker roster truth.
		const detached = makeSummary("draft-root", now, { messageCount: 0 });
		liveSummaries[0] = detached;
		worker.summaries.set("draft-root", detached);
		supervisor.writeRosterEntry(workerRosterEntryFromSummary(detached), worker);

		await vi.waitFor(() => expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true));
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("Evicted empty session worker draft"));
	});

	it("evicts a mixed-client empty draft only when the last of both client kinds is gone", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const liveSummaries = [makeSummary("mixed-root", now, { messageCount: 0, directAttachedClients: 1 })];
		const worker = makeWorker("mixed", liveSummaries);
		supervisor.workers.set("mixed", worker);
		seedSupervisorRoster(supervisor, worker);
		const routed = makeDetachClient("routed", ["mixed-root"]);
		supervisor.clients.add(routed);

		await supervisor.handleCommand(routed, { id: "detach-1", type: "detach", activeSessionId: "mixed-root" });
		await settle();
		expect(supervisor.stopWorker).not.toHaveBeenCalled();

		const detached = makeSummary("mixed-root", now, { messageCount: 0 });
		liveSummaries[0] = detached;
		worker.summaries.set("mixed-root", detached);
		supervisor.writeRosterEntry(workerRosterEntryFromSummary(detached), worker);

		await vi.waitFor(() => expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true));
	});

	it("does not stop a worker that was replaced while its summary refresh was in flight", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const worker = makeWorker("swap", [makeSummary("swap-root", now, { messageCount: 0 })]);
		let releaseList!: () => void;
		worker.client!.request.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseList = () => resolve(success(undefined, "list", { sessions: [...worker.summaries.values()] }));
				}),
		);
		supervisor.workers.set("swap", worker);
		seedSupervisorRoster(supervisor, worker);
		const client = makeDetachClient("viewer", ["swap-root"]);
		supervisor.clients.add(client);

		await supervisor.handleCommand(client, { id: "detach", type: "detach", activeSessionId: "swap-root" });
		await vi.waitFor(() => expect(worker.client!.request).toHaveBeenCalled());
		const successor = makeWorker("swap", [makeSummary("swap-root", now, { messageCount: 0 })]);
		supervisor.workers.set("swap", successor);
		releaseList();
		await settle();

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.get("swap")).toBe(successor);
	});

	it("does not evict when a mutation admitted during the refresh registers a cron schedule", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const worker = makeWorker("gap", [makeSummary("gap-root", now, { messageCount: 0 })]);
		let releaseList!: () => void;
		worker.client!.request.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseList = () =>
						resolve(
							success(undefined, "list", { sessions: [makeSummary("gap-root", now, { messageCount: 0 })] }),
						);
				}),
		);
		supervisor.workers.set("gap", worker);
		seedSupervisorRoster(supervisor, worker);
		const client = makeDetachClient("viewer", ["gap-root"]);
		supervisor.clients.add(client);

		await supervisor.handleCommand(client, { id: "detach", type: "detach", activeSessionId: "gap-root" });
		await vi.waitFor(() => expect(worker.client!.request).toHaveBeenCalled());
		// A cron_add admitted mid-refresh registers a schedule before the eviction decision.
		supervisor.mutationDrain.begin();
		worker.client!.request.mockImplementation(async () =>
			success(undefined, "list", {
				sessions: [makeSummary("gap-root", now, { messageCount: 0, hasRegisteredCronJob: true })],
			}),
		);
		releaseList();
		await settle();
		supervisor.mutationDrain.end();
		await settle();

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.get("gap")).toBe(worker);
	});

	it("evicts every empty draft when one client detaches from several at once", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const draftA = makeWorker("draft-a", [makeSummary("draft-a-root", now, { messageCount: 0 })]);
		const draftB = makeWorker("draft-b", [makeSummary("draft-b-root", now, { messageCount: 0 })]);
		supervisor.workers.set("draft-a", draftA);
		supervisor.workers.set("draft-b", draftB);
		seedSupervisorRoster(supervisor, draftA, draftB);
		const client = makeDetachClient("viewer", ["draft-a-root", "draft-b-root"]);
		supervisor.clients.add(client);

		await supervisor.handleCommand(client, { id: "detach-all", type: "detach" });

		await vi.waitFor(() => expect(supervisor.stopWorker).toHaveBeenCalledTimes(2));
		expect(supervisor.workers.size).toBe(0);
	});

	it("makes a starting sweep wait for the detach fence instead of overwriting it", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		// Recent activity keeps the worker out of the sweep's own idle candidates.
		const emptySessions = () => [
			makeSummary("gap-root", now, { messageCount: 0, lastActivityAt: new Date(now).toISOString() }),
		];
		const worker = makeWorker("gap", emptySessions());
		let releaseSweepList!: () => void;
		let releaseHookList!: () => void;
		worker
			.client!.request.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseSweepList = () => resolve(success(undefined, "list", { sessions: emptySessions() }));
					}),
			)
			.mockImplementationOnce(async () => success(undefined, "list", { sessions: emptySessions() }))
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseHookList = () => resolve(success(undefined, "list", { sessions: emptySessions() }));
					}),
			);
		supervisor.workers.set("gap", worker);
		seedSupervisorRoster(supervisor, worker);
		const client = makeDetachClient("viewer", ["gap-root"]);
		supervisor.clients.add(client);

		const sweep = supervisor.runIdleEvictionSweep(now);
		await vi.waitFor(() => expect(worker.client!.request).toHaveBeenCalledTimes(1));
		await supervisor.handleCommand(client, { id: "detach", type: "detach", activeSessionId: "gap-root" });
		await vi.waitFor(() => expect(worker.client!.request).toHaveBeenCalledTimes(3));
		releaseSweepList();
		await settle();

		// The hook is still mid-decision, so its fence must still be in the slot.
		expect(supervisor.idleEvictionFence).toBeDefined();
		releaseHookList();
		await sweep;
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true);
	});
});

describe("daemon supervisor scheduled-session wake", () => {
	const now = Date.parse("2026-08-01T12:00:00.000Z");

	function makeSavedInfo(path: string, id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
		return {
			path,
			id,
			cwd: "/tmp/project",
			rlmDepth: 0,
			created: new Date(now - 12 * 60 * 60_000),
			modified: new Date(now - 12 * 60 * 60_000),
			messageCount: 1,
			...overrides,
		} as SessionInfo;
	}

	function makeScheduledSessionFile(
		fileBase: string,
		sessionId = fileBase,
	): { sessionFile: string; store: AgentCronJobStore } {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-wake-"));
		tempDirs.push(directory);
		const sessionDir = join(directory, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `${fileBase}.jsonl`);
		writeFileSync(sessionFile, "");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionId, getSessionArtifactPathForFile(sessionFile, sessionId));
		return { sessionFile, store };
	}

	function armHeartbeat(store: AgentCronJobStore, sessionId: string, sessionFile: string, at: number): AgentCronJob {
		return store.createHeartbeat({
			activeSessionId: "stale-active",
			sessionId,
			sessionFile,
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "tick",
			now: new Date(at),
		});
	}

	it("wakes the non-resident root through the existing create path when a descendant heartbeat is due", async () => {
		const supervisor = makeSupervisor();
		const root = makeScheduledSessionFile("wake-root");
		const child = makeScheduledSessionFile("wake-child");
		armHeartbeat(child.store, "wake-child", child.sessionFile, now - 10 * 60_000);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [
				makeSavedInfo(root.sessionFile, "wake-root"),
				makeSavedInfo(child.sessionFile, "wake-child", { parentSessionPath: root.sessionFile, rlmDepth: 1 }),
			]),
			liveEdges: vi.fn(async () => []),
		};
		const woken = makeWorker("woken", [
			makeSummary("woken-root", now, { sessionId: "wake-root", sessionFile: root.sessionFile }),
		]);
		woken.descriptor.sessionFile = root.sessionFile;
		supervisor.createOrReuseWorker = vi.fn(async () => {
			supervisor.workers.set("woken", woken);
			return woken;
		});

		await supervisor.wakeDueScheduledSessions(now);

		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith("scheduled-wake", {
			type: "create",
			sessionPath: root.sessionFile,
		});
	});

	it("does not wake the passive root over a mid-tree session that has its own resident worker", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const root = makeScheduledSessionFile("covered-mid-root");
		const mid = makeScheduledSessionFile("covered-mid");
		armHeartbeat(mid.store, "covered-mid", mid.sessionFile, now - 10 * 60_000);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [
				makeSavedInfo(root.sessionFile, "covered-mid-root"),
				makeSavedInfo(mid.sessionFile, "covered-mid", { parentSessionPath: root.sessionFile, rlmDepth: 1 }),
			]),
			liveEdges: vi.fn(async () => []),
		};
		const resident = makeWorker("mid-worker", []);
		resident.descriptor.sessionFile = mid.sessionFile;
		supervisor.workers.set("mid-worker", resident);

		await supervisor.wakeDueScheduledSessions(now);
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		await supervisor.scheduledWakeRecompute;
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
	});

	it("skips a corrupt scheduled-jobs artifact but still wakes the other passive sessions", async () => {
		const supervisor = makeSupervisor();
		const healthy = makeScheduledSessionFile("healthy-root");
		const corrupt = makeScheduledSessionFile("corrupt-root");
		armHeartbeat(healthy.store, "healthy-root", healthy.sessionFile, now - 10 * 60_000);
		armHeartbeat(corrupt.store, "corrupt-root", corrupt.sessionFile, now - 10 * 60_000);
		writeFileSync(
			join(getSessionArtifactPathForFile(corrupt.sessionFile, "corrupt-root"), SESSION_SCHEDULED_JOBS_FILENAME),
			"{ not json",
		);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [
				makeSavedInfo(healthy.sessionFile, "healthy-root"),
				makeSavedInfo(corrupt.sessionFile, "corrupt-root"),
			]),
			liveEdges: vi.fn(async () => []),
		};
		supervisor.createOrReuseWorker = vi.fn(async () => makeWorker("woken", []));

		await supervisor.wakeDueScheduledSessions(now);

		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith("scheduled-wake", {
			type: "create",
			sessionPath: healthy.sessionFile,
		});
	});

	it("re-arms the wake timer from the durable store and skips covered, paused, and cancelled jobs", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const { sessionFile, store } = makeScheduledSessionFile("armed-root");
		// Real-clock epochs keep nextRunAt in the future so the armed timer never fires mid-test.
		const armedAt = Date.now();
		const job = armHeartbeat(store, "armed-root", sessionFile, armedAt);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "armed-root")]),
			liveEdges: vi.fn(async () => []),
		};

		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeDefined();

		const resident = makeWorker("resident", []);
		resident.descriptor.sessionFile = sessionFile;
		supervisor.workers.set("resident", resident);
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
		supervisor.workers.delete("resident");

		store.pauseHeartbeat("stale-active");
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
		await supervisor.wakeDueScheduledSessions(armedAt + 60 * 60_000);
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		// Settle the recompute the wake pass queued before mutating the store again.
		await supervisor.scheduledWakeRecompute;

		store.resumeHeartbeat("stale-active");
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeDefined();

		store.cancel(job.id);
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
	});

	it("does not arm the wake timer while an update restart is being prepared", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const { sessionFile, store } = makeScheduledSessionFile("restart-root");
		armHeartbeat(store, "restart-root", sessionFile, now - 10 * 60_000);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "restart-root")]),
			liveEdges: vi.fn(async () => []),
		};
		supervisor.updateRestartPhase = "prepared";

		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
		await supervisor.wakeDueScheduledSessions(now);
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();

		supervisor.updateRestartPhase = undefined;
		// A throwing launch keeps the re-armed overdue job on the 60s retry backoff.
		supervisor.createOrReuseWorker = vi.fn(async () => {
			throw new Error("no launch in this test");
		});
		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeDefined();
	});

	it("cancels a client-owned worker's scheduled jobs, descendants included, when its registration dies", async () => {
		const supervisor = makeSupervisor();
		const root = makeScheduledSessionFile("owned-root");
		// The child's persisted id differs from its filename; the artifact keys on the id.
		const child = makeScheduledSessionFile("owned-child", "owned-child-real");
		armHeartbeat(root.store, "owned-root", root.sessionFile, now);
		armHeartbeat(child.store, "owned-child-real", child.sessionFile, now);
		const owned = makeWorker("owned", []);
		owned.descriptor.ownerClientId = "owner";
		owned.descriptor.rootSessionId = "owned-root";
		owned.descriptor.sessionFile = root.sessionFile;
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [
				makeSavedInfo(root.sessionFile, "owned-root"),
				makeSavedInfo(child.sessionFile, "owned-child-real", {
					parentSessionPath: root.sessionFile,
					rlmDepth: 1,
				}),
			]),
			liveEdges: vi.fn(async () => []),
		};

		// A different worker covering ANY tree member keeps its schedules; only a fully uncovered tree is cancelled.
		const covering = makeWorker("covering", []);
		covering.descriptor.sessionFile = child.sessionFile;
		supervisor.workers.set("covering", covering);
		expect(await supervisor.cancelEphemeralWorkerScheduledJobs(owned)).toBe(true);
		expect(root.store.list().map((job) => job.status)).toEqual(["active"]);
		covering.descriptor.sessionFile = root.sessionFile;
		expect(await supervisor.cancelEphemeralWorkerScheduledJobs(owned)).toBe(true);
		expect(root.store.list().map((job) => job.status)).toEqual(["active"]);
		supervisor.workers.delete("covering");

		expect(await supervisor.cancelEphemeralWorkerScheduledJobs(owned)).toBe(true);

		expect(root.store.list().map((job) => job.status)).toEqual(["cancelled"]);
		expect(child.store.list().map((job) => job.status)).toEqual(["cancelled"]);
	});

	it("keeps schedules that were promoted public while the ephemeral cancel was in flight", async () => {
		const supervisor = makeSupervisor();
		const { sessionFile, store } = makeScheduledSessionFile("promoted-root");
		armHeartbeat(store, "promoted-root", sessionFile, now);
		let releaseFamily = () => {};
		const familyGate = new Promise<void>((resolve) => {
			releaseFamily = resolve;
		});
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => {
				await familyGate;
				return [makeSavedInfo(sessionFile, "promoted-root")];
			}),
			liveEdges: vi.fn(async () => []),
		};
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-promote-"));
		tempDirs.push(directory);
		const owned = makeWorker("owned", []);
		owned.descriptor.ownerClientId = "owner";
		owned.descriptor.rootSessionId = "promoted-root";
		owned.descriptor.sessionFile = sessionFile;
		owned.descriptorPath = join(directory, "owned.json");

		const cancel = supervisor.cancelEphemeralWorkerScheduledJobs(owned);
		await supervisor.promoteOwnedWorker({ id: "owner", attachedActiveSessionIds: new Set<string>() }, owned);
		releaseFamily();

		expect(await cancel).toBe(true);
		expect(owned.descriptor.ownerClientId).toBeUndefined();
		expect(store.list().map((job) => job.status)).toEqual(["active"]);
	});

	it("never parks or retries the cancel once the tree was promoted during a failing family read", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const { sessionFile, store } = makeScheduledSessionFile("promoted-parked-root");
		armHeartbeat(store, "promoted-parked-root", sessionFile, now - 10 * 60_000);
		let failFamily: (error: Error) => void = () => {};
		const familyGate = new Promise<never>((_, reject) => {
			failFamily = reject;
		});
		let familyReads = 0;
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => {
				familyReads += 1;
				if (familyReads === 1) await familyGate;
				return [makeSavedInfo(sessionFile, "promoted-parked-root")];
			}),
			liveEdges: vi.fn(async () => []),
		};
		mkdirSync(supervisor.descriptorDir, { recursive: true });
		const owned = makeWorker("owned", []);
		owned.descriptor.ownerClientId = "owner";
		owned.descriptor.rootSessionId = "promoted-parked-root";
		owned.descriptor.sessionFile = sessionFile;
		owned.descriptor.version = 2;
		owned.descriptor.supervisorSocketPath = supervisor.socketPath;
		owned.descriptor.socketPath = "owned.sock";
		owned.descriptor.authenticationToken = "token";
		owned.descriptor.recoveryJournalPath = join(supervisor.descriptorDir, "owned.recovery.jsonl");
		owned.descriptor.createdAt = new Date(now).toISOString();
		owned.descriptor.updatedAt = new Date(now).toISOString();
		owned.descriptor.consecutiveFailures = 0;
		owned.descriptor.stopRequestedAt = new Date(now).toISOString();
		owned.descriptorPath = join(supervisor.descriptorDir, "owned.json");

		const cancel = supervisor.cancelEphemeralWorkerScheduledJobs(owned);
		await supervisor.promoteOwnedWorker({ id: "owner", attachedActiveSessionIds: new Set<string>() }, owned);
		failFamily(new Error("ledger read failed"));

		const settled = await cancel;
		await supervisor.recomputeScheduledSessionWake();
		expect(store.list().map((job) => job.status)).toEqual(["active"]);
		expect(settled).toBe(true);
	});

	it("keeps a tree wake-ineligible after a failed ephemeral cancel until an enumeration retry lands", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const { sessionFile, store } = makeScheduledSessionFile("failed-cancel-root");
		armHeartbeat(store, "failed-cancel-root", sessionFile, now - 10 * 60_000);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "failed-cancel-root")]),
			liveEdges: vi.fn(async () => []),
		};
		mkdirSync(supervisor.descriptorDir, { recursive: true });
		const owned = makeWorker("owned", []);
		owned.descriptor.ownerClientId = "owner";
		owned.descriptor.rootSessionId = "failed-cancel-root";
		owned.descriptor.sessionFile = sessionFile;
		owned.descriptor.version = 2;
		owned.descriptor.supervisorSocketPath = supervisor.socketPath;
		owned.descriptor.socketPath = "owned.sock";
		owned.descriptor.authenticationToken = "token";
		owned.descriptor.recoveryJournalPath = join(supervisor.descriptorDir, "owned.recovery.jsonl");
		owned.descriptor.createdAt = new Date(now).toISOString();
		owned.descriptor.updatedAt = new Date(now).toISOString();
		owned.descriptor.consecutiveFailures = 0;
		owned.descriptor.stopRequestedAt = new Date(now).toISOString();
		owned.descriptorPath = join(supervisor.descriptorDir, "owned.json");
		supervisor.persistWorker(owned);
		const treeCancel = vi
			.spyOn(
				supervisor as unknown as { cancelScheduledJobsForSessionTree: (id: string, file: string) => Promise<void> },
				"cancelScheduledJobsForSessionTree",
			)
			.mockRejectedValue(new Error("corrupt scheduled-jobs.json"));

		await supervisor.cancelEphemeralWorkerScheduledJobs(owned);
		expect(store.list().map((job) => job.status)).toEqual(["active"]);

		await supervisor.recomputeScheduledSessionWake();
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
		await supervisor.wakeDueScheduledSessions(now);
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(store.list().map((job) => job.status)).toEqual(["active"]);

		// The next enumeration retries the cancel; once it lands the jobs are gone for good.
		treeCancel.mockRestore();
		await supervisor.recomputeScheduledSessionWake();
		expect(store.list().map((job) => job.status)).toEqual(["cancelled"]);
		expect(existsSync(owned.descriptorPath)).toBe(false);
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
	});

	it("keeps the tombstoned descriptor after a failed ephemeral cancel so the next boot finishes it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-durable-cancel-"));
		tempDirs.push(directory);
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
		const workersDir = join(directory, "workers");
		mkdirSync(workersDir, { recursive: true });
		const socketPath = join(directory, "daemon.sock");
		const { sessionFile, store } = makeScheduledSessionFile("durable-cancel-root");
		armHeartbeat(store, "durable-cancel-root", sessionFile, now - 10 * 60_000);
		const bootSupervisor = (): SupervisorInternals => {
			const supervisor = new DaemonSupervisor(socketPath, {
				defaultSessionConfig: { agentDir: directory, cwd: directory },
				descriptorDir: workersDir,
			}) as unknown as SupervisorInternals;
			supervisor.log = vi.fn();
			supervisor.rlmSpawnLedgerInstance = {
				family: vi.fn(async () => [makeSavedInfo(sessionFile, "durable-cancel-root")]),
				liveEdges: vi.fn(async () => []),
			};
			return supervisor;
		};
		const descriptorPath = join(workersDir, "owned-worker.json");
		const owned: WorkerFixture = {
			descriptor: {
				workerId: "owned-worker",
				lifecycle: "ready",
				version: 2,
				supervisorSocketPath: socketPath,
				socketPath: join(directory, "worker.sock"),
				authenticationToken: "token",
				recoveryJournalPath: join(workersDir, "owned-worker.recovery.jsonl"),
				rootActiveSessionId: "owned-active",
				rootSessionId: "durable-cancel-root",
				sessionFile,
				pid: 2_000_000_000,
				ownerClientId: "owner",
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				consecutiveFailures: 0,
				createCommand: { type: "create" },
			},
			descriptorPath,
			summaries: new Map(),
			transcriptCaches: new Map(),
			snapshotCache: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const stopping = bootSupervisor();
		stopping.workers.set("owned-worker", owned);
		vi.spyOn(stopping, "cancelScheduledJobsForSessionTree").mockRejectedValue(new Error("store busy"));

		await stopping.stopWorkerUntracked(owned, true, true);
		await stopping.scheduledWakeRecompute;

		// The stop tombstone survives the failed cancel as the durable intent.
		expect(existsSync(descriptorPath)).toBe(true);
		expect(store.list().map((job) => job.status)).toEqual(["active"]);

		const rebooted = bootSupervisor();
		rebooted.assertRecoveryAllowed = vi.fn(async () => {});
		rebooted.loadWorkerDescriptors();
		expect(rebooted.workers.size).toBe(1);
		await rebooted.adoptOrRecoverWorker([...rebooted.workers.values()][0]!);

		expect(store.list().map((job) => job.status)).toEqual(["cancelled"]);
		expect(existsSync(descriptorPath)).toBe(false);
		await rebooted.recomputeScheduledSessionWake();
		expect(rebooted.scheduledWakeTimer).toBeUndefined();
	});

	it("pauses a passivated heartbeat against its durable store without waking it", async () => {
		const supervisor = makeSupervisor();
		supervisor.createOrReuseWorker = vi.fn();
		const { sessionFile, store } = makeScheduledSessionFile("managed-root");
		const job = armHeartbeat(store, "managed-root", sessionFile, now - 10 * 60_000);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "managed-root")]),
			liveEdges: vi.fn(async () => []),
		};

		const response = await supervisor.handleCommand(
			{ id: "manager", attachedActiveSessionIds: new Set<string>() },
			{ id: "manage-1", type: "heartbeat_manage", activeSessionId: "stale-active", jobId: job.id, action: "pause" },
		);

		expect(response).toMatchObject({ success: true, data: { heartbeat: { id: job.id, status: "paused" } } });
		expect(store.list().map((candidate) => candidate.status)).toEqual(["paused"]);
		await supervisor.scheduledWakeRecompute;
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});

	it("lists and cancels a passive scheduled job without a resident worker", async () => {
		const supervisor = makeSupervisor();
		const { sessionFile, store } = makeScheduledSessionFile("unscoped-root");
		const job = armHeartbeat(store, "unscoped-root", sessionFile, now);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "unscoped-root")]),
			liveEdges: vi.fn(async () => []),
		};
		const client = { id: "manager", attachedActiveSessionIds: new Set<string>() };

		const listed = await supervisor.handleCommand(client, { id: "list-1", type: "cron_list" });
		expect(listed).toMatchObject({ success: true, data: { jobs: [{ id: job.id, status: "active" }] } });

		const cancelled = await supervisor.handleCommand(client, { id: "cancel-1", type: "cron_cancel", jobId: job.id });
		expect(cancelled).toMatchObject({ success: true, data: { job: { id: job.id, status: "cancelled" } } });
		expect(store.list().map((candidate) => candidate.status)).toEqual(["cancelled"]);

		// Terminal jobs stay reachable through an inclusive listing, exactly like resident sessions.
		const relisted = await supervisor.handleCommand(client, { id: "list-2", type: "cron_list" });
		expect(relisted).toMatchObject({ success: true, data: { jobs: [] } });
		const inclusive = await supervisor.handleCommand(client, {
			id: "list-3",
			type: "cron_list",
			includeInactive: true,
		});
		expect(inclusive).toMatchObject({ success: true, data: { jobs: [{ id: job.id, status: "cancelled" }] } });
	});

	it("drops a stale ephemeral-cancel intent once a worker covers the tree again", async () => {
		const supervisor = makeSupervisor();
		const { sessionFile, store } = makeScheduledSessionFile("reopened-root");
		armHeartbeat(store, "reopened-root", sessionFile, now);
		supervisor.rlmSpawnLedgerInstance = {
			family: vi.fn(async () => [makeSavedInfo(sessionFile, "reopened-root")]),
			liveEdges: vi.fn(async () => []),
		};
		mkdirSync(supervisor.descriptorDir, { recursive: true });
		const stopped = makeWorker("stopped", []);
		stopped.descriptor.ownerClientId = "owner";
		stopped.descriptor.rootSessionId = "reopened-root";
		stopped.descriptor.sessionFile = sessionFile;
		stopped.descriptor.version = 2;
		stopped.descriptor.supervisorSocketPath = supervisor.socketPath;
		stopped.descriptor.socketPath = "stopped.sock";
		stopped.descriptor.authenticationToken = "token";
		stopped.descriptor.recoveryJournalPath = join(supervisor.descriptorDir, "stopped.recovery.jsonl");
		stopped.descriptor.createdAt = new Date(now).toISOString();
		stopped.descriptor.updatedAt = new Date(now).toISOString();
		stopped.descriptor.consecutiveFailures = 0;
		stopped.descriptor.stopRequestedAt = new Date(now).toISOString();
		stopped.descriptorPath = join(supervisor.descriptorDir, "stopped.json");
		supervisor.persistWorker(stopped);
		const reopened = makeWorker("reopened", []);
		reopened.descriptor.sessionFile = sessionFile;
		supervisor.workers.set("reopened", reopened);

		const response = await supervisor.handleCommand(
			{ id: "viewer", attachedActiveSessionIds: new Set<string>() },
			{ id: "hb-list", type: "heartbeats_list" },
		);

		expect(response).toMatchObject({ success: true });
		expect(store.list().map((job) => job.status)).toEqual(["active"]);
		expect(existsSync(stopped.descriptorPath)).toBe(false);
	});
});
