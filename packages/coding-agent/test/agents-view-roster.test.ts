import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { buildAgentsViewRows, classifyAgentsViewSession } from "../src/modes/agents-view/agents-view-state.js";
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
import { countDirectSubagentStatuses } from "../src/modes/interactive/components/subagent-summary-line.js";
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
	onMessage: (listener: (message: DaemonOutbound) => void) => () => void;
	request: ReturnType<typeof vi.fn>;
	emit: (message: DaemonOutbound) => void;
};

function fakeRosterClient(roster: AgentRosterEntry[], supported = true): FakeClient {
	const listeners = new Set<(message: DaemonOutbound) => void>();
	return {
		supportsServerCapability: () => supported,
		isConnected: true,
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

	it("reports an unsupported daemon so the view can keep the legacy poll path", async () => {
		const store = new AgentsViewRosterStore();
		const client = fakeRosterClient([], false);
		await expect(store.attach(client as never)).resolves.toBe(false);
		expect(client.request).not.toHaveBeenCalled();
	});

	it("applies pushed updates, removals, and full resyncs", async () => {
		const client = fakeRosterClient([ledgerEntry({ id: "a", sessionId: "a" })]);
		const store = new AgentsViewRosterStore();
		await store.attach(client as never);

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
	});

	it("emits one listener call for several updates arriving in the same tick", async () => {
		const client = fakeRosterClient([]);
		const store = new AgentsViewRosterStore();
		await store.attach(client as never);
		const listener = vi.fn();
		store.onUpdate(listener);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "a", sessionId: "a" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })] });
		await Promise.resolve();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.summaries()).toHaveLength(3);
	});
});

describe("roster-driven agents view rows", () => {
	it("shows a queued child with its ledger label before any session exists", () => {
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

		const summaries = [root, queued].map((entry) => sessionSummaryFromRosterEntry(entry));
		const rootIdentity = buildAgentsViewRows(summaries).find(
			(row) => row.summary.sessionId === "root-session",
		)?.identity;
		if (!rootIdentity) throw new Error("Missing root row");
		const rows = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		const queuedRow = rows.find((row) => row.summary.rlmChildId === "child-1");
		expect(queuedRow).toBeDefined();
		expect(queuedRow?.section).toBe("running");
		expect(queuedRow?.statusLabel).toBe("queued");
	});

	it("labels recovering and stale rows from ledger state instead of hiding them", () => {
		const recovering = ledgerEntry(
			{ id: "r-active", sessionId: "r", activeSessionId: "r-active" },
			{ status: "running", statusLabel: "recovering" },
		);
		const stale = ledgerEntry(
			{ id: "s-active", sessionId: "s", activeSessionId: "s-active" },
			{ status: "idle", lastHeardFromAt: new Date(Date.now() - 60_000).toISOString() },
		);

		const rows = buildAgentsViewRows([recovering, stale].map((entry) => sessionSummaryFromRosterEntry(entry)));
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.summary.sessionId === "r")?.statusLabel).toBe("recovering");
		expect(rows.find((row) => row.summary.sessionId === "s")?.statusLabel).toMatch(/^last heard \d+(s|m) ago$/);
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

	it("serves navigation refreshes from the store with zero catalog requests", async () => {
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
		]);
		await store.attach(client as never);
		client.request.mockClear();

		const internals = view as unknown as {
			refreshSessions(): Promise<boolean>;
			refreshBothCatalogs(): Promise<boolean>;
			rows: Array<{ summary: SessionSummary }>;
		};
		await expect(internals.refreshSessions()).resolves.toBe(true);
		await expect(internals.refreshBothCatalogs()).resolves.toBe(true);

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

	it("navigates rows without issuing any daemon requests", async () => {
		setKeybindings(new KeybindingsManager());
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
			ledgerEntry({ id: "b-active", sessionId: "b", activeSessionId: "b-active" }, { status: "idle" }),
		]);
		await store.attach(client as never);
		(view as unknown as { onRosterUpdate(): void }).onRosterUpdate();
		client.request.mockClear();

		view.handleInput("\u001b[B");
		view.handleInput("\u001b[A");

		expect(client.request).not.toHaveBeenCalled();
	});

	it("reconciles once per pushed batch", async () => {
		const { view, store, client } = makeView([]);
		await store.attach(client as never);
		const applySessionList = vi.fn();
		Reflect.set(view, "applySessionList", applySessionList);
		Reflect.set(
			view,
			"unsubscribeRosterUpdate",
			store.onUpdate(() => (view as unknown as { onRosterUpdate(): void }).onRosterUpdate()),
		);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "a", sessionId: "a" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })] });
		await Promise.resolve();

		expect(applySessionList).toHaveBeenCalledTimes(1);
	});
});

describe("bar and view lifecycle equality", () => {
	function makeBar() {
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: "parent-node",
			refreshSubagentSummary: vi.fn(),
		}) as unknown as {
			subagentSnapshots: Map<string, AgentConnectionRlmChildAgentSnapshot>;
			updateSubagentSummary(child: AgentConnectionRlmChildAgentSnapshot): void;
		};
		return mode;
	}

	it("keeps bar counts equal to roster-derived view sections across the child lifecycle matrix", () => {
		const bar = makeBar();
		const feed = (child: Partial<AgentConnectionRlmChildAgentSnapshot> & { id: string; status: string }) =>
			bar.updateSubagentSummary({
				parentId: "parent-node",
				label: child.id,
				sessionDir: "/tmp",
				...child,
			} as AgentConnectionRlmChildAgentSnapshot);

		// unbound-error: queued run fails before any session exists -> removed everywhere.
		feed({ id: "c-unbound", status: "queued" });
		feed({ id: "c-unbound", status: "error", error: "boom" });
		// queued: admitted, no session yet.
		feed({ id: "c-queued", status: "queued" });
		// bound: running with a live session.
		feed({ id: "c-bound", status: "queued" });
		feed({ id: "c-bound", status: "running", activeSessionId: "bound-active" });
		// heartbeat-only: finished but pinned by an active heartbeat.
		feed({ id: "c-heartbeat", status: "running", activeSessionId: "hb-active" });
		feed({ id: "c-heartbeat", status: "done", activeSessionId: "hb-active" });
		// passivated: finished, session left memory, transcript retained (token evidence).
		feed({ id: "c-passive", status: "running", activeSessionId: "p-active", tokenCount: 42 });
		feed({ id: "c-passive", status: "done", tokenCount: 42 });
		// recovering: still resident; its worker state is a label, not a status change.
		feed({ id: "c-recovering", status: "running", activeSessionId: "r-active" });

		const barCounts = countDirectSubagentStatuses(
			bar.subagentSnapshots.values(),
			"parent-node",
			new Set(["hb-active"]),
		);

		const rosterRows: AgentRosterEntry[] = [
			ledgerEntry(
				{ id: "c-queued", sessionId: "c-queued", runtimeKind: "subagent", rlmChildId: "c-queued" },
				{ status: "running", statusLabel: "queued", queuedChild: true },
			),
			ledgerEntry(
				{
					id: "bound-active",
					sessionId: "bound-session",
					activeSessionId: "bound-active",
					runtimeKind: "subagent",
					rlmChildId: "c-bound",
					isSessionActive: true,
				},
				{ status: "running" },
			),
			ledgerEntry(
				{
					id: "hb-active",
					sessionId: "hb-session",
					activeSessionId: "hb-active",
					runtimeKind: "subagent",
					rlmChildId: "c-heartbeat",
					hasActiveHeartbeat: true,
				},
				{ status: "running" },
			),
			ledgerEntry(
				{ id: "p-session", sessionId: "p-session", runtimeKind: "subagent", rlmChildId: "c-passive" },
				{ status: "inactive" },
			),
			ledgerEntry(
				{
					id: "r-active",
					sessionId: "r-session",
					activeSessionId: "r-active",
					runtimeKind: "subagent",
					rlmChildId: "c-recovering",
					isSessionActive: true,
				},
				{ status: "running", statusLabel: "recovering" },
			),
		];
		const viewCounts = { running: 0, idle: 0, inactive: 0 };
		for (const entry of rosterRows) {
			viewCounts[classifyAgentsViewSession(sessionSummaryFromRosterEntry(entry))] += 1;
		}

		expect(bar.subagentSnapshots.has("c-unbound")).toBe(false);
		expect(barCounts).toEqual({ total: 5, ...viewCounts });
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
			rosterCapable: true,
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

	it("retries a refused drain resync on the next drain", async () => {
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
		expect(client.rosterResyncPending).toBe(true);
		expect(pushes.filter((push) => push.resync)).toHaveLength(1);

		socket.emit("drain");
		expect(client.rosterResyncPending).toBe(false);
		expect(pushes.filter((push) => push.resync)).toHaveLength(2);
	});
});

describe("queued to bound row identity", () => {
	it("keeps one stable row identity across the bind push", () => {
		const queued = sessionSummaryFromRosterEntry(
			ledgerEntry(
				{
					id: "sub-1",
					sessionId: "sub-1",
					runtimeKind: "subagent",
					rlmChildId: "sub-1",
					parentSessionPath: "/tmp/parents/root.jsonl",
					messageCount: 0,
				},
				{ status: "running", statusLabel: "queued", queuedChild: true },
			),
		);
		const bound = sessionSummaryFromRosterEntry(
			ledgerEntry(
				{
					id: "child-active",
					sessionId: "child-session",
					activeSessionId: "child-active",
					sessionFile: "/tmp/artifacts/child.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "sub-1",
					parentSessionPath: "/tmp/parents/root.jsonl",
				},
				{ status: "running" },
			),
		);

		const queuedRows = buildAgentsViewRows([queued]);
		const boundRows = buildAgentsViewRows([bound]);
		expect(queuedRows).toHaveLength(1);
		expect(boundRows).toHaveLength(1);
		expect(queuedRows[0]?.identity).toBe(boundRows[0]?.identity);
	});
});
