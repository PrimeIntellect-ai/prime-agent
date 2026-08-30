import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { buildAgentsViewRows } from "../src/modes/agents-view/agents-view-state.js";
import { AgentsViewRosterStore } from "../src/modes/agents-view/roster-store.js";
import {
	type AgentRosterEntry,
	sessionSummaryFromRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../src/modes/daemon/agent-roster.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function ledgerEntry(
	overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">,
	roster: Partial<Pick<AgentRosterEntry, "status" | "statusLabel" | "lastHeardFromAt" | "queuedChild">> = {},
): AgentRosterEntry {
	const base = workerRosterEntryFromSummary(summary(overrides));
	return { ...base, status: roster.status ?? "idle", ...roster };
}

type FakeClient = {
	supportsServerCapability: (capability: string) => boolean;
	isConnected: boolean;
	hello: object;
	onMessage: (listener: (message: DaemonOutbound) => void) => () => void;
	request: ReturnType<typeof vi.fn>;
	emit: (message: DaemonOutbound) => void;
};

function fakeRosterClient(roster: AgentRosterEntry[], supported = true): FakeClient {
	const listeners = new Set<(message: DaemonOutbound) => void>();
	return {
		supportsServerCapability: () => supported,
		isConnected: true,
		hello: { type: "daemon_hello" },
		onMessage: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		request: vi.fn(async (command: { type: string }) => {
			if (command.type === "roster_subscribe") {
				return { type: "response", command: command.type, success: true, data: { roster } };
			}
			return { type: "response", command: command.type, success: true };
		}),
		emit: (message) => {
			for (const listener of listeners) listener(message);
		},
	};
}

describe("agents-view roster store", () => {
	it("subscribes once and re-attaches without any further requests", async () => {
		const client = fakeRosterClient([
			ledgerEntry({ id: "a", sessionId: "a", activeSessionId: "a" }, { status: "idle" }),
		]);
		const store = new AgentsViewRosterStore();

		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["a"]);

		// Scope transitions re-attach the surviving store: zero additional requests.
		await expect(store.attach(client as never)).resolves.toBe(true);
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(1);
	});

	it("reports an unsupported daemon so the view can hard-error instead of polling", async () => {
		const store = new AgentsViewRosterStore();
		const client = fakeRosterClient([], false);
		await expect(store.attach(client as never)).resolves.toBe(false);
		expect(client.request).not.toHaveBeenCalled();
	});

	it("applies pushed updates, removals, and full resyncs with one listener emission per tick", async () => {
		const client = fakeRosterClient([ledgerEntry({ id: "a", sessionId: "a" })]);
		const store = new AgentsViewRosterStore();
		await store.attach(client as never);
		const listener = vi.fn();
		store.onUpdate(listener);

		client.emit({
			type: "roster_update",
			changed: [ledgerEntry({ id: "b", sessionId: "b" }, { status: "running" })],
		});
		expect(
			store
				.summaries()
				.map((entry) => entry.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
		expect(store.summaries().find((entry) => entry.sessionId === "b")?.rosterStatus).toBe("running");

		client.emit({ type: "roster_update", changed: [], removed: ["a"] });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["b"]);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })], resync: true });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["c"]);

		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("replays pushes that raced the subscribe reply after the snapshot resync", async () => {
		const client = fakeRosterClient([ledgerEntry({ id: "a", sessionId: "a" })]);
		const store = new AgentsViewRosterStore();
		client.request.mockImplementationOnce(async (command: { type: string }) => {
			// Newer pushes land while the subscribe reply is still in flight.
			client.emit({ type: "roster_update", changed: [], removed: ["a"] });
			client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
			return {
				type: "response",
				command: command.type,
				success: true,
				data: { roster: [ledgerEntry({ id: "a", sessionId: "a" })] },
			};
		});

		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["b"]);
	});
});

describe("roster-driven agents view rows", () => {
	it("labels queued, recovering, and stale rows from ledger state instead of hiding them", () => {
		const queued = ledgerEntry(
			{
				id: "child-1",
				sessionId: "child-1",
				runtimeKind: "subagent",
				rlmChildId: "child-1",
				parentSessionId: "root-session",
				messageCount: 0,
				firstMessage: "review the API",
			},
			{ status: "running", statusLabel: "queued", queuedChild: true },
		);
		const root = ledgerEntry(
			{ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" },
			{ status: "idle" },
		);
		const recovering = ledgerEntry(
			{ id: "r-active", sessionId: "r", activeSessionId: "r-active" },
			{ status: "running", statusLabel: "recovering" },
		);
		const stale = ledgerEntry(
			{ id: "s-active", sessionId: "s", activeSessionId: "s-active" },
			{ status: "idle", lastHeardFromAt: new Date(Date.now() - 60_000).toISOString() },
		);

		const summaries = [root, queued, recovering, stale].map((entry) => sessionSummaryFromRosterEntry(entry));
		const rootIdentity = buildAgentsViewRows(summaries).find(
			(row) => row.summary.sessionId === "root-session",
		)?.identity;
		if (!rootIdentity) throw new Error("Missing root row");
		const rows = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		const queuedRow = rows.find((row) => row.summary.rlmChildId === "child-1");
		expect(queuedRow).toMatchObject({ section: "running", statusLabel: "queued" });
		expect(rows.find((row) => row.summary.sessionId === "r")?.statusLabel).toBe("recovering");
		expect(rows.find((row) => row.summary.sessionId === "s")?.statusLabel).toMatch(/^last heard \d+(s|m) ago$/);

		// The bind push keeps one stable row identity for the same child run.
		const bound = sessionSummaryFromRosterEntry(
			ledgerEntry(
				{
					id: "child-active",
					sessionId: "child-session",
					activeSessionId: "child-active",
					sessionFile: "/tmp/artifacts/child.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "child-1",
					parentSessionId: "root-session",
				},
				{ status: "running" },
			),
		);
		const queuedOnly = buildAgentsViewRows([sessionSummaryFromRosterEntry(queued)]);
		const boundOnly = buildAgentsViewRows([bound]);
		expect(queuedOnly).toHaveLength(1);
		expect(boundOnly).toHaveLength(1);
		expect(queuedOnly[0]?.identity).toBe(boundOnly[0]?.identity);
	});
});

describe("supervisor roster subscription", () => {
	it("seeds subscribers and pushes one coalesced update per mutation batch over the wire", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-push-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		});
		const internals = supervisor as unknown as {
			start(): Promise<void>;
			cleanupSupervisorResources(): Promise<void>;
			writeRosterEntry(entry: WorkerRosterEntry): AgentRosterEntry;
			roster(): { delete(agentId: string): void };
		};
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		const client = new DaemonClient(socketPath);
		try {
			await internals.start();
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(summary({ id: "seeded", sessionId: "seeded", sessionFile: "/tmp/s.jsonl" })),
			);
			await client.connect();
			await client.waitForHello();
			expect(client.supportsServerCapability("agent_roster")).toBe(true);
			const updates: Array<Extract<DaemonOutbound, { type: "roster_update" }>> = [];
			client.onMessage((message) => {
				if (message.type === "roster_update") updates.push(message);
			});

			const subscribed = await client.request({ type: "roster_subscribe" });
			if (!subscribed.success) throw new Error(subscribed.error);
			const roster = (subscribed.success ? (subscribed.data as { roster: AgentRosterEntry[] }) : { roster: [] })
				.roster;
			expect(roster.map((entry) => entry.agentId)).toEqual(["seeded"]);

			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({ id: "a-active", sessionId: "a", activeSessionId: "a-active", isSessionActive: true }),
				),
			);
			internals.writeRosterEntry(workerRosterEntryFromSummary(summary({ id: "b", sessionId: "b" })));
			internals.roster().delete("seeded");
			await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

			expect(updates).toHaveLength(1);
			expect(updates[0]?.changed.map((entry) => entry.agentId).sort()).toEqual(["a", "b"]);
			expect(updates[0]?.changed.find((entry) => entry.agentId === "a")?.status).toBe("running");
			expect(updates[0]?.removed).toEqual(["seeded"]);
		} finally {
			client.close();
			await internals.cleanupSupervisorResources();
		}
	});
});

describe("roster-driven agents view instance", () => {
	function makeView(entries: AgentRosterEntry[]) {
		const store = new AgentsViewRosterStore();
		const client = fakeRosterClient(entries);
		const view = new AgentsViewMode(
			{
				config: {} as never,
				uiServices: {
					settingsManager: SettingsManager.inMemory({ theme: "dark" }),
					modelRegistry: {} as never,
					getInitialCwd: () => process.cwd(),
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			{},
		) as AgentsViewMode & Record<string, unknown>;
		Reflect.set(view, "rosterSupported", true);
		Reflect.set(view, "rosterStore", store);
		Reflect.set(view, "client", client);
		Reflect.set(view, "liveCatalogReady", true);
		Reflect.set(view, "savedCatalogReady", true);
		return { view, store, client };
	}

	it("serves refreshes from the store with zero daemon requests", async () => {
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
		]);
		await store.attach(client as never);
		client.request.mockClear();

		const internals = view as unknown as {
			refreshSessions(): Promise<boolean>;
			rows: Array<{ summary: SessionSummary }>;
		};
		await expect(internals.refreshSessions()).resolves.toBe(true);
		await expect(internals.refreshSessions()).resolves.toBe(true);

		expect(client.request).not.toHaveBeenCalled();
		expect(internals.rows.some((row) => row.summary.sessionId === "a")).toBe(true);
	});

	it("fetches the saved catalog at most once per view instance, and only when a query is typed", () => {
		const { view } = makeView([]);
		const refreshSavedSessions = vi.fn(async () => true);
		Reflect.set(view, "refreshSavedSessions", refreshSavedSessions);
		const internals = view as unknown as {
			queryChanged(): void;
			editor: { setText(text: string): void };
		};

		internals.queryChanged();
		expect(refreshSavedSessions).not.toHaveBeenCalled();

		internals.editor.setText("needle");
		internals.queryChanged();
		internals.editor.setText("needle two");
		internals.queryChanged();
		expect(refreshSavedSessions).toHaveBeenCalledTimes(1);
	});
});

describe("subscriber push transitions", () => {
	function makePushSupervisor(extra: Record<string, unknown> = {}) {
		const pushes: Array<Extract<DaemonOutbound, { type: "roster_update" }>> = [];
		const write = vi.fn((_client: object, message: DaemonOutbound) => {
			if (message.type === "roster_update") pushes.push(message);
			return true;
		});
		const subscriber = { id: "sub", rosterSubscribed: true, backpressured: false };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map(),
			clients: new Set([subscriber]),
			pendingRosterChanged: new Set(),
			pendingRosterRemoved: new Set(),
			rosterPushScheduled: false,
			persistWorker: vi.fn(),
			write,
			log: vi.fn(),
			...extra,
		}) as {
			workers: Map<string, unknown>;
			writeRosterEntry(entry: unknown, worker?: unknown): AgentRosterEntry;
			workerRosterEntries(worker: unknown): AgentRosterEntry[];
			sweepRosterStaleness(now?: number): void;
			promoteOwnedWorker(client: object, worker: unknown): Promise<void>;
			roster(): { delete(agentId: string): void };
		};
		const settle = async () => {
			await new Promise((resolve) => setImmediate(resolve));
		};
		return { supervisor, pushes, settle, subscriber };
	}

	function pushWorker(workerId: string, ownerClientId?: string) {
		return {
			descriptor: { workerId, pid: 1, rootActiveSessionId: `${workerId}-root`, lifecycle: "ready", ownerClientId },
			client: {},
			intentionalStop: false,
		};
	}

	it("pushes watchdog staleness stamps and clears to subscribers", async () => {
		const { supervisor, pushes, settle } = makePushSupervisor();
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const worker = { ...pushWorker("w1"), lastFrameAt: now - 60_000 };
		supervisor.workers.set("w1", worker);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active" })),
			worker,
		);
		await settle();
		pushes.length = 0;

		supervisor.sweepRosterStaleness(now);
		await settle();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBe(new Date(now - 60_000).toISOString());

		// Already-stale workers are not re-stamped: repeat sweeps emit zero mutations.
		const stampedPushes = pushes.length;
		supervisor.sweepRosterStaleness(now + 1000);
		await settle();
		expect(pushes.length).toBe(stampedPushes);

		worker.lastFrameAt = now;
		supervisor.sweepRosterStaleness(now);
		await settle();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBeUndefined();
	});

	it("removes rows that turn client-owned and re-publishes them on promotion", async () => {
		const { supervisor, pushes, settle } = makePushSupervisor({
			protocolClientIds: new WeakMap(),
		});
		const owned = pushWorker("w1", "owner-1");
		supervisor.workers.set("w1", owned);
		const entry = workerRosterEntryFromSummary(
			summary({ id: "o-active", sessionId: "o", activeSessionId: "o-active", sessionFile: "/tmp/o.jsonl" }),
		);
		supervisor.writeRosterEntry(entry);
		await settle();
		pushes.length = 0;

		// The row is claimed by a client-owned worker: subscribers see a removal.
		supervisor.writeRosterEntry(entry, owned);
		await settle();
		expect(pushes.at(-1)?.removed).toEqual([entry.agentId]);
		expect(pushes.at(-1)?.changed).toEqual([]);

		// Promotion clears ownership: subscribers gain the rows again.
		await supervisor.promoteOwnedWorker({ id: "owner-1" }, owned);
		await settle();
		expect(pushes.at(-1)?.changed.map((changedEntry) => changedEntry.agentId)).toEqual([entry.agentId]);
	});

	it("never surfaces a live edge as a transient removal during a snapshot apply", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-flicker-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const parentPath = join(sessionsDir, "root.jsonl");
		const childPath = join(directory, "artifacts", "live-child.jsonl");
		await ledger.appendSpawn({ childId: "live-child", parent: parentPath, child: childPath, depth: 1, name: "c" });
		const { supervisor, pushes, settle } = makePushSupervisor({
			rlmSpawnLedger: () => ledger,
			defaultSessionConfig: { agentDir: directory, cwd: directory },
		});
		const worker = pushWorker("w1");
		supervisor.workers.set("w1", worker);
		const childEntry = workerRosterEntryFromSummary(
			summary({
				id: "live-child",
				sessionId: "live-child",
				sessionFile: childPath,
				runtimeKind: "subagent",
				rlmChildId: "live-child",
				parentSessionPath: parentPath,
			}),
		);
		supervisor.writeRosterEntry(childEntry, worker);
		await settle();
		pushes.length = 0;

		const internals = supervisor as unknown as {
			consumeWorkerRosterDelta(worker: object, payload: Buffer): void;
		};
		internals.consumeWorkerRosterDelta(
			worker,
			Buffer.from(JSON.stringify({ type: "roster_delta", entries: [], snapshot: true })),
		);
		await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(0));
		await settle();

		// The absentee deletion and the ledger reseed land in one apply: no push ever removes the live edge.
		expect(pushes.some((push) => push.removed?.includes(childEntry.agentId))).toBe(false);
		const reseeded = pushes.flatMap((push) => push.changed).find((entry) => entry.agentId === childEntry.agentId);
		expect(reseeded).toBeDefined();
	});

	it("sends one drain resync per loss gap even when the write reports backpressure", async () => {
		const { supervisor, pushes, subscriber } = makePushSupervisor({
			connectionIds: new Map(),
			sessionInputPauseEpochs: new Map(),
			detachingInputPauseSessions: new Map(),
			ready: new Promise(() => {}),
			catchUpClient: vi.fn(async () => {}),
		});
		const internals = supervisor as unknown as {
			handleConnection(socket: unknown): void;
			clients: Set<{ rosterSubscribed?: boolean; rosterResyncPending?: boolean; backpressured?: boolean }>;
			write: ReturnType<typeof vi.fn>;
		};
		internals.clients.delete(subscriber as never);
		const socket = Object.assign(new EventEmitter(), { destroyed: false, write: () => true });
		internals.handleConnection(socket);
		const client = [...internals.clients][0];
		if (!client) throw new Error("Missing connected client");
		client.rosterSubscribed = true;
		client.rosterResyncPending = true;

		internals.write.mockImplementationOnce((_client: object, message: DaemonOutbound) => {
			if (message.type === "roster_update") pushes.push(message);
			return false;
		});
		socket.emit("drain");
		// socket.write queues the resync even when it reports backpressure; the flag must not re-arm.
		expect(client.rosterResyncPending).toBe(false);
		expect(pushes.filter((push) => push.resync)).toHaveLength(1);

		socket.emit("drain");
		expect(pushes.filter((push) => push.resync)).toHaveLength(1);
	});
});

describe("push-fed subagents bar", () => {
	it("feeds the daemon-mode bar from the pushed roster, not stale snapshots", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-bar-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		});
		const internals = supervisor as unknown as {
			start(): Promise<void>;
			cleanupSupervisorResources(): Promise<void>;
			writeRosterEntry(entry: WorkerRosterEntry): AgentRosterEntry;
		};
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		const client = new DaemonClient(socketPath);
		try {
			await internals.start();
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({
						id: "child-a-active",
						sessionId: "child-a",
						activeSessionId: "child-a-active",
						runtimeKind: "subagent",
						rlmChildId: "child-a",
						parentActiveSessionId: "parent-active",
						isSessionActive: true,
					}),
				),
			);
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({
						id: "child-b",
						sessionId: "child-b",
						sessionFile: "/tmp/child-b.jsonl",
						runtimeKind: "subagent",
						rlmChildId: "child-b",
						parentActiveSessionId: "parent-active",
					}),
				),
			);
			await client.connect();
			await client.waitForHello();
			const connection = new DaemonAgentConnection(client, "parent-active");
			const setSubagentCounts = vi.fn();
			const bar = Object.assign(Object.create(InteractiveMode.prototype), {
				agentConnection: connection,
				connectionState: { activeSessionId: "parent-active" },
				// A stale snapshot claims one lone running child; the pushed roster must win.
				subagentSnapshots: new Map([
					["stale", { id: "stale", label: "stale", status: "running", sessionDir: "/tmp" }],
				]),
				rlmNodeId: undefined,
				heartbeatCatalog: [],
				subagentSummaryLine: { setSubagentCounts, isSelectable: () => false, focused: false },
				scheduleHeartbeatManagerRefresh: vi.fn(),
				updateWorkingPulse: vi.fn(),
				syncWorkingLoader: vi.fn(),
				updateWorkingLoaderMessage: vi.fn(),
				ui: { requestRender: vi.fn() },
			}) as unknown as { subscribeToRosterBar(): Promise<void> };

			await bar.subscribeToRosterBar();
			expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 2, running: 1, idle: 0, inactive: 1 });

			// A pushed change reaches the bar without any snapshot traffic.
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({
						id: "child-c",
						sessionId: "child-c",
						sessionFile: "/tmp/child-c.jsonl",
						runtimeKind: "subagent",
						rlmChildId: "child-c",
						parentSessionPath: "/tmp/parents/root.jsonl",
						parentActiveSessionId: "parent-active",
					}),
				),
			);
			await vi.waitFor(() =>
				expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 3, running: 1, idle: 0, inactive: 2 }),
			);
		} finally {
			client.close();
			await internals.cleanupSupervisorResources();
		}
	});
});
