import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
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
	catalog: {
		resolve: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		list?: ReturnType<typeof vi.fn>;
		family?: ReturnType<typeof vi.fn>;
		siblings?: ReturnType<typeof vi.fn>;
	};
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	familyCatalogEntries(
		sessionDir?: string,
	): Promise<readonly import("../src/core/agent-messages.js").AgentFamilyCatalogEntry[]>;
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

	it("uses the merged custom session directory for named saved-session siblings", async () => {
		const supervisor = makeSupervisor();
		const sessionPath = "/tmp/custom-sessions/saved.jsonl";
		const target = {
			id: "saved",
			path: sessionPath,
			cwd: "/tmp/project",
			parentSessionPath: "/tmp/custom-sessions/parent.jsonl",
			rlmDepth: 1,
			created: new Date("2026-08-01T12:00:00.000Z"),
			modified: new Date("2026-08-01T12:00:00.000Z"),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		supervisor.catalog.resolve = vi.fn(async () => sessionPath);
		supervisor.catalog.siblings = vi.fn(async () => [target]);
		const launched = makeWorker("launched", [makeSummary("launched-active", Date.now())]);
		const launchWorker = vi.fn(async () => launched);
		Object.assign(supervisor, { launchWorker });
		const createOrReuseWorker = (
			supervisor as unknown as {
				createOrReuseWorker(clientId: string, command: object): Promise<WorkerFixture>;
			}
		).createOrReuseWorker.bind(supervisor);

		await expect(
			createOrReuseWorker("client", {
				id: "named-custom",
				type: "create",
				sessionPath: "saved",
				name: "renamed",
				config: { sessionDir: "/tmp/custom-sessions" },
			}),
		).resolves.toBe(launched);
		expect(supervisor.catalog.resolve).toHaveBeenCalledWith("saved", expect.any(String), "/tmp/custom-sessions");
		expect(supervisor.catalog.siblings).toHaveBeenCalledWith(sessionPath, "/tmp/custom-sessions");
		expect(launchWorker).toHaveBeenCalledWith(
			expect.objectContaining({ sessionPath, config: { sessionDir: "/tmp/custom-sessions" } }),
			undefined,
			undefined,
		);
	});

	it("resolves a saved target in the source worker's create-time session directory", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const source = makeWorker("source", [sourceSummary]);
		source.descriptor.createCommand.config = { sessionDir: "/tmp/custom-sessions" };
		source.summaries = new Map([["source-active", sourceSummary]]);
		// The wake path reads this row before authorizing it, so model an actual
		// saved session rather than a summary whose sessionFile is not readable.
		const targetDirectory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-target-"));
		tempDirs.push(targetDirectory);
		const targetManager = SessionManager.create(targetDirectory, join(targetDirectory, "sessions"));
		targetManager.newSession();
		targetManager.appendSessionInfo("saved target");
		targetManager.flushNow();
		const targetPath = targetManager.getSessionFile();
		if (!targetPath) throw new Error("Missing saved target session path");
		const targetSummary = makeSummary("target-active", now, {
			sessionId: targetManager.getSessionId(),
			sessionFile: targetPath,
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
		supervisor.catalog.resolve = vi.fn(async () => targetPath);
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
			expect.objectContaining({
				type: "create",
				sessionPath: targetPath,
				continueRecent: false,
				config: { sessionDir: "/tmp/custom-sessions" },
			}),
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

	it("captures every inactive descendant for cross-worker sibling authorization", async () => {
		const supervisor = makeSupervisor();
		const timestamp = new Date("2026-08-01T12:00:00.000Z");
		const catalog = [
			{
				id: "root",
				path: "/tmp/root.jsonl",
				cwd: "/tmp",
				rlmDepth: 0,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
			{
				id: "middle",
				path: "/tmp/middle.jsonl",
				cwd: "/tmp",
				parentSessionPath: "/tmp/root.jsonl",
				rlmDepth: 1,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
			{
				id: "first",
				path: "/tmp/first.jsonl",
				cwd: "/tmp",
				parentSessionPath: "/tmp/middle.jsonl",
				rlmDepth: 2,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
			{
				id: "second",
				path: "/tmp/second.jsonl",
				cwd: "/tmp",
				parentSessionPath: "/tmp/middle.jsonl",
				rlmDepth: 2,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
		];
		supervisor.catalog.list = vi.fn(async () => catalog);
		Object.assign(supervisor.catalog, { family: vi.fn(async () => catalog) });
		const entries = await supervisor.familyCatalogEntries("/tmp/custom-sessions");
		expect(supervisor.catalog.list).toHaveBeenCalledWith(undefined, "/tmp/custom-sessions");
		expect(supervisor.catalog.family).toHaveBeenCalledWith("/tmp/custom-sessions");
		expect(entries.map((entry) => entry.id)).toEqual(["root", "middle", "first", "second"]);
		const { assertAgentFamilyReach } = await import("../src/core/agent-messages.js");
		expect(
			assertAgentFamilyReach(
				entries.find((entry) => entry.id === "first")!,
				entries.find((entry) => entry.id === "second")!,
				entries,
			),
		).toBe("sibling");
	});

	it("scopes live family rows to the requested configured session directory", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source", now)]);
		source.descriptor.createCommand.config = { sessionDir: "/tmp/sessions-a" };
		const foreign = makeWorker("foreign", [makeSummary("foreign", now)]);
		foreign.descriptor.createCommand.config = { sessionDir: "/tmp/sessions-b" };
		supervisor.workers.set("source", source);
		supervisor.workers.set("foreign", foreign);
		supervisor.catalog.list = vi.fn(async () => []);
		Object.assign(supervisor.catalog, { family: vi.fn(async () => []) });

		const entries = await supervisor.familyCatalogEntries("/tmp/sessions-a");
		expect(entries.map((entry) => entry.id)).toEqual(["source-session"]);
	});

	it("anchors relative live parent paths to the child session file", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const worker = makeWorker("family", [
			makeSummary("root", now, { sessionId: "root", sessionFile: "/tmp/family/root.jsonl", rlmDepth: 0 }),
			makeSummary("child", now, {
				sessionId: "child",
				sessionFile: "/tmp/family/children/child.jsonl",
				rlmDepth: 1,
				parentSessionId: "root",
				parentSessionPath: "../root.jsonl",
			}),
		]);
		worker.descriptor.createCommand.config = { sessionDir: "/tmp/sessions" };
		supervisor.workers.set("family", worker);
		supervisor.catalog.list = vi.fn(async () => []);
		Object.assign(supervisor.catalog, { family: vi.fn(async () => []) });

		const entries = await supervisor.familyCatalogEntries("/tmp/sessions");
		const { assertAgentFamilyReach } = await import("../src/core/agent-messages.js");
		expect(assertAgentFamilyReach(entries[0]!, entries[1]!, entries)).toBe("child");
	});

	it("uses the source worker session directory for agent-origin family snapshots", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now, { sessionId: "source" })]);
		source.descriptor.createCommand.config = { sessionDir: "/tmp/custom-sessions" };
		const target = makeWorker("target", [makeSummary("target-active", now, { sessionId: "target" })]);
		target.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("source", source);
		supervisor.workers.set("target", target);
		const familyCatalogEntries = vi.fn(async () =>
			Object.freeze([
				{ id: "root", depth: 0, status: "inactive" as const },
				{ id: "source", depth: 1, status: "running" as const, parentSessionId: "root" },
				{ id: "target", depth: 1, status: "running" as const, parentSessionId: "root" },
			]),
		);
		Object.assign(supervisor, { familyCatalogEntries });

		await expect(
			supervisor.handleCommand(
				{ id: "sender" },
				{
					id: "custom-root",
					type: "send_message",
					agentOrigin: true,
					fromActiveSessionId: "source-active",
					targetActiveSessionId: "target-active",
					message: "deliver",
				},
			),
		).resolves.toMatchObject({ success: true });
		expect(familyCatalogEntries).toHaveBeenCalledWith("/tmp/custom-sessions");
	});

	it("rejects active topology that conflicts with the persisted row before remote delivery", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, {
			sessionId: "source",
			rlmDepth: 1,
			parentSessionPath: "/tmp/root.jsonl",
		});
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target",
			sessionFile: "/tmp/target.jsonl",
			rlmDepth: 1,
			parentSessionPath: "/tmp/forged-parent.jsonl",
		});
		const source = makeWorker("source", [sourceSummary]);
		const target = makeWorker("target", [targetSummary]);
		supervisor.workers.set("source", source);
		supervisor.workers.set("target", target);
		const timestamp = new Date(now);
		const catalog = [
			{
				id: "root",
				path: "/tmp/root.jsonl",
				cwd: "/tmp",
				rlmDepth: 0,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
			{
				id: "target",
				path: "/tmp/target.jsonl",
				cwd: "/tmp",
				parentSessionPath: "/tmp/root.jsonl",
				rlmDepth: 1,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
			},
		];
		supervisor.catalog.list = vi.fn(async () => catalog);
		Object.assign(supervisor.catalog, { family: vi.fn(async () => catalog) });

		await expect(
			supervisor.handleCommand(
				{ id: "sender" },
				{
					id: "persisted-conflict",
					type: "send_message",
					agentOrigin: true,
					fromActiveSessionId: "source-active",
					targetActiveSessionId: "target-active",
					message: "deny",
				},
			),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
		expect(target.client?.requestWorker).not.toHaveBeenCalled();
	});

	it("uses only the source custom directory when denying a conflicting family topology", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, {
			sessionId: "source",
			rlmDepth: 1,
			parentSessionPath: "/tmp/custom-sessions/root.jsonl",
		});
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target",
			sessionFile: "/tmp/custom-sessions/target.jsonl",
			rlmDepth: 1,
			parentSessionPath: "/tmp/custom-sessions/forged-parent.jsonl",
		});
		const source = makeWorker("source", [sourceSummary]);
		source.descriptor.createCommand.config = { sessionDir: "/tmp/custom-sessions" };
		const target = makeWorker("target", [targetSummary]);
		target.descriptor.createCommand.config = { sessionDir: "/tmp/custom-sessions" };
		supervisor.workers.set("source", source);
		supervisor.workers.set("target", target);
		const timestamp = new Date(now);
		const catalog = [
			{
				id: "root",
				path: "/tmp/custom-sessions/root.jsonl",
				cwd: "/tmp",
				rlmDepth: 0,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			},
			{
				id: "target",
				path: "/tmp/custom-sessions/target.jsonl",
				cwd: "/tmp",
				parentSessionPath: "/tmp/custom-sessions/root.jsonl",
				rlmDepth: 1,
				created: timestamp,
				modified: timestamp,
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			},
		];
		supervisor.catalog.list = vi.fn(async () => catalog);
		supervisor.catalog.family = vi.fn(async () => catalog);

		await expect(
			supervisor.handleCommand(
				{ id: "sender" },
				{
					id: "custom-persisted-conflict",
					type: "send_message",
					agentOrigin: true,
					fromActiveSessionId: "source-active",
					targetActiveSessionId: "target-active",
					message: "deny",
				},
			),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
		expect(supervisor.catalog.list).toHaveBeenCalledWith(undefined, "/tmp/custom-sessions");
		expect(supervisor.catalog.family).toHaveBeenCalledWith("/tmp/custom-sessions");
		expect(target.client?.requestWorker).not.toHaveBeenCalled();
	});

	it("rejects duplicate snapshot identities before cross-worker delivery", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source" });
		const targetSummary = makeSummary("target-active", now, { sessionId: "target" });
		const source = makeWorker("source", [sourceSummary]);
		const target = makeWorker("target", [targetSummary]);
		supervisor.workers.set("source", source);
		supervisor.workers.set("target", target);
		Object.assign(supervisor, {
			familyCatalogEntries: vi.fn(async () =>
				Object.freeze([
					{ id: "root", depth: 0, status: "inactive" as const },
					{ id: "source", depth: 1, status: "running" as const, parentSessionId: "root" },
					{ id: "target", depth: 1, status: "running" as const, parentSessionId: "root" },
					{ id: "target", depth: 1, status: "running" as const, parentSessionId: "forged" },
				]),
			),
		});
		await expect(
			supervisor.handleCommand(
				{ id: "sender" },
				{
					id: "duplicate",
					type: "send_message",
					agentOrigin: true,
					fromActiveSessionId: "source-active",
					targetActiveSessionId: "target-active",
					message: "deny",
				},
			),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
		expect(target.client?.requestWorker).not.toHaveBeenCalled();
	});

	it("rejects a postwake session substitution without delivery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-postwake-substitution-"));
		tempDirs.push(directory);
		const parentManager = SessionManager.create(directory, join(directory, "sessions"));
		parentManager.newSession({ rlmDepth: 0 });
		parentManager.flushNow();
		const parentPath = parentManager.getSessionFile();
		if (!parentPath) throw new Error("Missing parent session path");
		const targetManager = SessionManager.create(directory, join(directory, "sessions"));
		targetManager.newSession({ parentSession: parentPath, rlmDepth: 1 });
		targetManager.flushNow();
		const targetPath = targetManager.getSessionFile();
		if (!targetPath) throw new Error("Missing target session path");
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source" });
		const source = makeWorker("source", [sourceSummary]);
		const substituted = makeSummary("woken-active", now, { sessionId: "substitute", sessionFile: targetPath });
		const woken = makeWorker("woken", [substituted]);
		const supervisor = makeSupervisor();
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => targetPath);
		supervisor.createOrReuseWorker = vi.fn(async () => woken);
		Object.assign(supervisor, {
			familyCatalogEntries: vi.fn(async () =>
				Object.freeze([
					{ id: parentManager.getSessionId(), depth: 0, status: "inactive" as const, sessionPath: parentPath },
					{ id: "source", depth: 1, status: "running" as const, parentSessionId: parentManager.getSessionId() },
					{
						id: targetManager.getSessionId(),
						depth: 1,
						status: "inactive" as const,
						parentSessionPath: parentPath,
						sessionPath: targetPath,
					},
				]),
			),
		});
		await expect(
			supervisor.handleCommand(
				{ id: "sender" },
				{
					id: "substitution",
					type: "send_message",
					agentOrigin: true,
					fromActiveSessionId: "source-active",
					targetActiveSessionId: targetManager.getSessionId(),
					message: "deny",
				},
			),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
		expect(woken.client?.requestWorker).not.toHaveBeenCalled();
	});
});
