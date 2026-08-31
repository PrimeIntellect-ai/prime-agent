import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { buildAgentsViewRows, getAgentsViewSummaryIdentity } from "../src/modes/agents-view/agents-view-state.js";
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
	it("subscribes once per hello, re-subscribes on a new hello, and reports a missing capability", async () => {
		const unsupported = fakeRosterClient([], false);
		await expect(new AgentsViewRosterStore().attach(unsupported as never)).resolves.toBe(false);
		expect(unsupported.request).not.toHaveBeenCalled();

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
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(1);

		const listener = vi.fn();
		store.onUpdate(listener);
		client.emit({
			type: "roster_update",
			changed: [ledgerEntry({ id: "c", sessionId: "c" }, { status: "running" })],
		});
		client.emit({ type: "roster_update", changed: [], removed: ["b"] });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["c"]);
		expect(store.summaries()[0]?.rosterStatus).toBe("running");
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "d", sessionId: "d" })], resync: true });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["d"]);
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);

		// A reconnect mints a new hello: the stale subscribed flag must not mask the dead subscription.
		client.hello = { type: "daemon_hello" };
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(2);
	});

	it("rejects a roster subscribe cut off mid-flight instead of parking it behind request recovery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-park-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "park.sock");
		const server = createServer((socket) => {
			socket.write(
				`${JSON.stringify({ type: "daemon_hello", protocol: { version: 7 }, serverCapabilities: ["agent_roster"] })}\n`,
			);
			socket.on("data", () => socket.destroy());
		});
		await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
		const client = new DaemonClient(socketPath);
		client.enableRequestRecovery();
		try {
			await client.connect();
			await client.waitForHello();
			await expect(new AgentsViewRosterStore().attach(client)).rejects.toThrow();
		} finally {
			client.close();
			server.close();
		}
	});

	it("serializes attaches and dispose so stale settles cannot drop or outlive the live subscription", async () => {
		let releaseFirst: (response: unknown) => void = () => {};
		const client = fakeRosterClient([ledgerEntry({ id: "a", sessionId: "a" })]);
		client.request.mockImplementationOnce(
			() =>
				new Promise((resolveFirst) => {
					releaseFirst = resolveFirst;
				}) as never,
		);
		const store = new AgentsViewRosterStore();
		const first = store.attach(client as never);
		const second = store.attach(client as never);
		await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
		releaseFirst({ success: false, error: "stale socket" });
		await expect(first).rejects.toThrow("roster_subscribe failed");
		await expect(second).resolves.toBe(true);
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
		expect(
			store
				.summaries()
				.map((entry) => entry.sessionId)
				.sort(),
		).toEqual(["a", "b"]);

		// Dispose joins the chain: it detaches the live listener, and on a closed
		// client it skips the unsubscribe RPC entirely.
		client.isConnected = false;
		const requests = client.request.mock.calls.length;
		await store.dispose();
		expect(client.request.mock.calls.length).toBe(requests);
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })] });
		expect(
			store
				.summaries()
				.map((entry) => entry.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
	});
});

describe("roster-driven agents view rows", () => {
	it("labels queued and stale rows from ledger state and keeps one identity across the bind push", () => {
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
		const root = ledgerEntry({ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" });
		const stale = ledgerEntry(
			{ id: "s-active", sessionId: "s", activeSessionId: "s-active" },
			{ status: "idle", lastHeardFromAt: new Date(Date.now() - 60_000).toISOString() },
		);

		const summaries = [root, queued, stale].map((entry) => sessionSummaryFromRosterEntry(entry));
		const rootIdentity = buildAgentsViewRows(summaries).find(
			(row) => row.summary.sessionId === "root-session",
		)?.identity;
		if (!rootIdentity) throw new Error("Missing root row");
		const rows = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		expect(rows.find((row) => row.summary.rlmChildId === "child-1")).toMatchObject({
			section: "running",
			statusLabel: "queued",
		});
		expect(rows.find((row) => row.summary.sessionId === "s")?.statusLabel).toMatch(/^last heard \d+(s|m|h) ago$/);

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
		expect(queuedOnly[0]?.identity).toBe(boundOnly[0]?.identity);
	});
});

describe("supervisor roster subscription", () => {
	it("seeds subscribers, coalesces pushes, and never writes roster_update to an unsubscribed client", async () => {
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
		const bystander = new DaemonClient(socketPath);
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
			await bystander.connect();
			await bystander.waitForHello();
			const bystanderUpdates: DaemonOutbound["type"][] = [];
			bystander.onMessage((message) => {
				if (message.type === "roster_update") bystanderUpdates.push(message.type);
			});

			const subscribed = await client.request({ type: "roster_subscribe" });
			if (!subscribed.success) throw new Error(subscribed.error);
			const roster = (subscribed.data as { roster: AgentRosterEntry[] }).roster;
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
			expect(bystanderUpdates).toEqual([]);
		} finally {
			client.close();
			bystander.close();
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
		Reflect.set(view, "rosterStore", store);
		Reflect.set(view, "client", client);
		Reflect.set(view, "savedCatalogReady", true);
		return { view, store, client };
	}

	it("serves refreshes from the store with zero requests and settles a missing anchor on push", async () => {
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
		]);
		await store.attach(client as never);
		client.request.mockClear();
		const internals = view as unknown as {
			refreshSessions(): Promise<void>;
			onRosterUpdate(): void;
			persistentState: { selectedRowIdentity?: string };
			selectionAnchorPending: boolean;
			rows: Array<{ summary: SessionSummary }>;
		};
		await internals.refreshSessions();
		expect(client.request).not.toHaveBeenCalled();
		expect(internals.rows.some((row) => row.summary.sessionId === "a")).toBe(true);

		// A vanished remembered selection re-arms the pending anchor; the push must settle it.
		internals.persistentState.selectedRowIdentity = "file:/tmp/sessions/vanished.jsonl";
		internals.onRosterUpdate();
		expect(internals.selectionAnchorPending).toBe(false);
	});

	it("keeps passivated rows when a failed delete's liveness probe narrows the list", async () => {
		const passivated = ledgerEntry(
			{ id: "gone", sessionId: "gone", sessionFile: "/tmp/sessions/gone.jsonl" },
			{ status: "inactive" },
		);
		const { view, store, client } = makeView([passivated]);
		await store.attach(client as never);
		const internals = view as unknown as {
			refreshSessions(): Promise<void>;
			handleDeleteSelected(): Promise<void>;
			reconcileCatalogs(): void;
			rows: Array<{ summary: SessionSummary }>;
		};
		await internals.refreshSessions();
		const rowIndex = internals.rows.findIndex((row) => row.summary.sessionId === "gone");
		const rowSummary = internals.rows[rowIndex]?.summary;
		if (!rowSummary) throw new Error("Missing passivated row");
		Reflect.set(view, "selectedIndex", rowIndex);
		Reflect.set(view, "pendingDeleteAgent", {
			identity: getAgentsViewSummaryIdentity(rowSummary),
			sessionFile: "/tmp/sessions/gone.jsonl",
			summary: rowSummary,
			stopped: false,
		});
		Reflect.set(view, "deleteConfirmExpiresAt", Date.now() + 60_000);
		client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") {
				return { type: "response", command: command.type, success: true, data: { sessions: [] } };
			}
			return { type: "response", command: command.type, success: false, error: "delete failed" };
		});

		await internals.handleDeleteSelected();

		// The next non-push reconcile (the 15s heartbeat tick) must still render the row.
		internals.reconcileCatalogs();
		expect(internals.rows.some((row) => row.summary.sessionId === "gone")).toBe(true);
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
			publishedRosterIds: new Set(),
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

	it("pushes watchdog staleness stamps once per transition and clears them on recovery", async () => {
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

		const stampedPushes = pushes.length;
		supervisor.sweepRosterStaleness(now + 1000);
		await settle();
		expect(pushes.length).toBe(stampedPushes);

		worker.lastFrameAt = now;
		supervisor.sweepRosterStaleness(now);
		await settle();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBeUndefined();
	});

	it("removes a claimed row once, stays silent for owned-worker writes, and re-publishes on promotion", async () => {
		const { supervisor, pushes, settle } = makePushSupervisor({
			protocolClientIds: new WeakMap(),
		});
		const owned = pushWorker("w1", "owner-1");
		supervisor.workers.set("w1", owned);
		// A row born to a client-owned worker is never published: no push, no id leak.
		const bornOwned = workerRosterEntryFromSummary(
			summary({ id: "p-active", sessionId: "p", activeSessionId: "p-active", sessionFile: "/tmp/p.jsonl" }),
		);
		supervisor.writeRosterEntry(bornOwned, owned);
		await settle();
		expect(pushes).toEqual([]);

		const entry = workerRosterEntryFromSummary(
			summary({ id: "o-active", sessionId: "o", activeSessionId: "o-active", sessionFile: "/tmp/o.jsonl" }),
		);
		supervisor.writeRosterEntry(entry);
		await settle();
		pushes.length = 0;

		supervisor.writeRosterEntry(entry, owned);
		await settle();
		expect(pushes.at(-1)?.removed).toEqual([entry.agentId]);
		expect(pushes.at(-1)?.changed).toEqual([]);

		pushes.length = 0;
		supervisor.writeRosterEntry(entry, owned);
		supervisor.writeRosterEntry(bornOwned, owned);
		await settle();
		expect(pushes).toEqual([]);

		await supervisor.promoteOwnedWorker({ id: "owner-1" }, owned);
		await settle();
		expect(
			pushes
				.at(-1)
				?.changed.map((changedEntry) => changedEntry.agentId)
				.sort(),
		).toEqual([bornOwned.agentId, entry.agentId].sort());
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

		expect(pushes.some((push) => push.removed?.includes(childEntry.agentId))).toBe(false);
		expect(
			pushes.flatMap((push) => push.changed).find((entry) => entry.agentId === childEntry.agentId),
		).toBeDefined();
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
		const barChild = (id: string, overrides: Partial<SessionSummary> = {}) =>
			workerRosterEntryFromSummary(
				summary({
					id,
					sessionId: id,
					runtimeKind: "subagent",
					rlmChildId: id,
					parentActiveSessionId: "parent-active",
					...overrides,
				}),
			);
		try {
			await internals.start();
			internals.writeRosterEntry(barChild("child-a", { activeSessionId: "child-a-active", isSessionActive: true }));
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
			}) as unknown as { subscribeToRosterBar(): Promise<void>; ui: { requestRender: ReturnType<typeof vi.fn> } };

			await bar.subscribeToRosterBar();
			expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 1, running: 1, idle: 0, inactive: 0 });
			bar.ui.requestRender.mockClear();

			internals.writeRosterEntry(barChild("child-b", { sessionFile: "/tmp/child-b.jsonl" }));
			await vi.waitFor(() =>
				expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 2, running: 1, idle: 0, inactive: 1 }),
			);
			// A push with no accompanying session event must still repaint.
			expect(bar.ui.requestRender).toHaveBeenCalled();
		} finally {
			client.close();
			await internals.cleanupSupervisorResources();
		}
	});
});
