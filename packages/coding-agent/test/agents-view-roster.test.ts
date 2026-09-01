import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
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
	it("owns the subscription lifecycle: capability miss, raced pushes, hello re-key, attach/dispose races", async () => {
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
		// A same-hello re-attach is request-free; a new hello re-subscribes.
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(1);
		client.hello = { type: "daemon_hello" };
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(2);
		// The re-subscribe resynced from the daemon's snapshot.
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["a"]);

		const listener = vi.fn();
		// A throwing consumer must not break delivery to the others (or the process).
		store.onUpdate(() => {
			throw new Error("consumer exploded");
		});
		store.onUpdate(listener);
		client.emit({
			type: "roster_update",
			changed: [ledgerEntry({ id: "c", sessionId: "c" }, { status: "running" })],
		});
		client.emit({ type: "roster_update", changed: [], removed: ["a"] });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["c"]);
		expect(store.summaries()[0]?.rosterStatus).toBe("running");
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "d", sessionId: "d" })], resync: true });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["d"]);
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);

		// Overlapping attaches serialize: a stale failure cannot drop the winner's listener.
		let releaseStale: (response: unknown) => void = () => {};
		client.hello = { type: "daemon_hello" };
		client.request.mockImplementationOnce(
			() =>
				new Promise((resolveStale) => {
					releaseStale = resolveStale;
				}) as never,
		);
		const stale = store.attach(client as never);
		const winner = store.attach(client as never);
		await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
		releaseStale({ success: false, error: "stale socket" });
		await expect(stale).rejects.toThrow("roster_subscribe failed");
		await expect(winner).resolves.toBe(true);
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "e", sessionId: "e" })] });
		expect(store.summaries().some((entry) => entry.sessionId === "e")).toBe(true);

		// Dispose detaches the listener and skips the unsubscribe RPC on a closed client.
		client.isConnected = false;
		const requests = client.request.mock.calls.length;
		await store.dispose();
		expect(client.request.mock.calls.length).toBe(requests);
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "f", sessionId: "f" })] });
		expect(store.summaries().some((entry) => entry.sessionId === "f")).toBe(false);
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
	it("seeds, coalesces, skips unsubscribed clients, and feeds the chat bar over one real socket", async () => {
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
			expect((subscribed.data as { roster: AgentRosterEntry[] }).roster.map((entry) => entry.agentId)).toEqual([
				"seeded",
			]);

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

			// The chat bar rides the same push surface through its own connection; a
			// public parent has its own roster row alongside its children.
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({ id: "parent-active", sessionId: "parent", activeSessionId: "parent-active" }),
				),
			);
			internals.writeRosterEntry(barChild("child-a", { activeSessionId: "child-a-active", isSessionActive: true }));
			const barClient = new DaemonClient(socketPath);
			await barClient.connect();
			await barClient.waitForHello();
			const connection = new DaemonAgentConnection(barClient, "parent-active");
			const setSubagentCounts = vi.fn();
			const bar = Object.assign(Object.create(InteractiveMode.prototype), {
				agentConnection: connection,
				connectionState: { activeSessionId: "parent-active", sessionId: "parent" },
				// A stale snapshot claims one lone running child; a nonempty roster must win.
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
			}) as unknown as {
				subscribeToRosterBar(): Promise<void>;
				updateSubagentSummaryLine(): void;
				connectionState: object;
				ui: { requestRender: ReturnType<typeof vi.fn> };
			};
			try {
				await bar.subscribeToRosterBar();
				expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 1, running: 1, idle: 0, inactive: 0 });
				bar.ui.requestRender.mockClear();

				internals.writeRosterEntry(barChild("child-b", { sessionFile: "/tmp/child-b.jsonl" }));
				await vi.waitFor(() =>
					expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 2, running: 1, idle: 0, inactive: 1 }),
				);
				// A push with no accompanying session event must still repaint.
				expect(bar.ui.requestRender).toHaveBeenCalled();

				// A client-owned session has no public roster row: the bar falls back to snapshots.
				bar.connectionState = { activeSessionId: "owned-active", sessionId: "owned" };
				bar.updateSubagentSummaryLine();
				expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 1, running: 1, idle: 0, inactive: 0 });

				// A public parent whose children all left the roster shows zero, never stale snapshots.
				bar.connectionState = { activeSessionId: "parent2-active", sessionId: "parent2" };
				internals.writeRosterEntry(
					workerRosterEntryFromSummary(
						summary({ id: "parent2-active", sessionId: "parent2", activeSessionId: "parent2-active" }),
					),
				);
				await vi.waitFor(() =>
					expect(setSubagentCounts).toHaveBeenLastCalledWith({ total: 0, running: 0, idle: 0, inactive: 0 }),
				);
			} finally {
				barClient.close();
			}
		} finally {
			client.close();
			bystander.close();
			await internals.cleanupSupervisorResources();
		}
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

	it("restamps last-heard marks that a row-rebuilding write dropped, and clears them on recovery", async () => {
		const { supervisor, pushes, settle } = makePushSupervisor();
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const worker = { ...pushWorker("w1"), lastFrameAt: now - 60_000 };
		supervisor.workers.set("w1", worker);
		const entry = workerRosterEntryFromSummary(
			summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active" }),
		);
		supervisor.writeRosterEntry(entry, worker);
		supervisor.sweepRosterStaleness(now);
		await settle();
		const stamp = new Date(now - 60_000).toISOString();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBe(stamp);

		// A repeat sweep of an already-stamped row emits nothing.
		pushes.length = 0;
		supervisor.sweepRosterStaleness(now + 1000);
		await settle();
		expect(pushes).toEqual([]);

		// A gap-fill write rebuilds the row without the mark; the next sweep restamps it.
		supervisor.writeRosterEntry(entry, worker);
		await settle();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBeUndefined();
		supervisor.sweepRosterStaleness(now + 2000);
		await settle();
		expect(pushes.at(-1)?.changed[0]?.lastHeardFromAt).toBe(stamp);

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
		mkdirSync(sessionsDir, { recursive: true });
		mkdirSync(join(directory, "artifacts"), { recursive: true });
		writeFileSync(parentPath, "");
		writeFileSync(childPath, "");
		await ledger.appendSpawn({ childId: "live-child", parent: parentPath, child: childPath, depth: 1, name: "c" });
		const { supervisor, pushes, settle } = makePushSupervisor({
			rlmSpawnLedger: () => ledger,
			defaultSessionConfig: { agentDir: directory, cwd: directory },
		});
		// Reseeds are family-scoped: the worker must own the family root it snapshots for.
		const worker = { ...pushWorker("w1"), descriptor: { ...pushWorker("w1").descriptor, sessionFile: parentPath } };
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
