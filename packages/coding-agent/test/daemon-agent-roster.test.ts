import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	type AgentRosterEntry,
	sessionSummaryFromRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../src/modes/daemon/agent-roster.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	type DaemonWorkerRosterOutbound,
	isDaemonWorkerFrameHeader,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

type RosterDelta = Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>;

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// Worker-side roster reporter (daemon-mode)
// ------------------------------------------------------------------

interface WorkerReporterFixture {
	daemon: {
		sessions: Map<string, ActiveSessionState>;
		observeRosterEvent(state: ActiveSessionState, message: unknown): void;
		flushRoster(): void;
		rosterReporter: {
			lastSent: Map<string, { json: string; entry: WorkerRosterEntry }>;
			lastComposed: Map<string, WorkerRosterEntry>;
			queuedChildren: Map<string, WorkerRosterEntry>;
			removedAgentIds: Set<string>;
			tombstones: Map<string, number>;
			generation: number;
			snapshotPending: boolean;
		};
	};
	sentDeltas: RosterDelta[];
	connection: { connected: boolean };
}

function makeWorkerReporter(connected = true): WorkerReporterFixture {
	const sentDeltas: RosterDelta[] = [];
	const connection = { connected };
	const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: { authenticationToken: "token" } },
		sessions: new Map<string, ActiveSessionState>(),
		cronStore: { list: () => [] },
		rosterReporter: {
			lastSent: new Map<string, { json: string; entry: WorkerRosterEntry }>(),
			lastComposed: new Map<string, WorkerRosterEntry>(),
			queuedChildren: new Map<string, WorkerRosterEntry>(),
			removedAgentIds: new Set<string>(),
			tombstones: new Map<string, number>(),
			generation: 0,
			snapshotPending: false,
		},
		rosterFlushScheduled: false,
		shuttingDown: false,
		hasAuthenticatedSupervisorClient: () => connection.connected,
		broadcastRosterFrame: (message: DaemonWorkerRosterOutbound) => {
			if (message.type === "roster_delta") sentDeltas.push(message);
			return connection.connected;
		},
		log: vi.fn(),
	}) as WorkerReporterFixture["daemon"];
	return { daemon, sentDeltas, connection };
}

function makeState(options: {
	activeSessionId: string;
	sessionId?: string;
	sessionFile?: string;
	kind?: "top-level" | "subagent";
	rlmChildId?: string;
	parentActiveSessionId?: string;
	parentSessionFile?: string;
	messages?: AgentMessage[];
	isStreaming?: boolean;
}): ActiveSessionState {
	return {
		activeSessionId: options.activeSessionId,
		clients: new Set(),
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: options.kind ?? "top-level",
				createdAt: 1,
				...(options.rlmChildId ? { rlmChildId: options.rlmChildId } : {}),
				...(options.parentActiveSessionId ? { parentActiveSessionId: options.parentActiveSessionId } : {}),
				...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}),
			},
			diagnostics: [],
			session: {
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				rlmDepth: options.kind === "subagent" ? 1 : 0,
				sessionName: `name-${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-05-01T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => false,
				},
				messages: options.messages ?? [],
				getRlmChildSnapshots: () => [],
				hasRunningRlmChildren: () => false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 0,
				isSessionActive: options.isStreaming === true,
				getCurrentRecap: () => undefined,
				_contextTokensForCurrentMessages: () => undefined,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				state: { streamingMessage: undefined, pendingToolCalls: new Set() },
			},
		},
	} as unknown as ActiveSessionState;
}

function childUpdate(state: ActiveSessionState, child: Record<string, unknown>) {
	return {
		type: "session_event",
		activeSessionId: state.activeSessionId,
		event: { type: "rlm_child_update", child },
	};
}

describe("worker roster reporter", () => {
	it("publishes an admitted child run before its session exists and merges it on session bind", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);

		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "review the API", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();

		const queued = sentDeltas[0]?.entries.find((entry) => entry.agentId === "child-1");
		expect(queued).toMatchObject({
			agentId: "child-1",
			queuedChild: true,
			summary: { runtimeKind: "subagent", parentActiveSessionId: "parent-active", firstMessage: "review the API" },
		});

		// The child session materializes: same agentId, one resident row, no queued marker.
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, {
				id: "child-1",
				label: "review the API",
				status: "running",
				activeSessionId: "child-active",
			}),
		);
		daemon.flushRoster();

		const merged = sentDeltas.at(-1)?.entries.filter((entry) => entry.agentId === "child-1") ?? [];
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ summary: { activeSessionId: "child-active", lifecycle: "live" } });
		expect(merged[0]?.queuedChild).toBeUndefined();
	});

	it("keeps a superseded child run out of the roster after its session closes", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "running", activeSessionId: "child-active" }),
		);
		daemon.flushRoster();

		daemon.sessions.delete(childState.activeSessionId);
		daemon.flushRoster();

		const final = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "child-1");
		expect(final?.queuedChild).toBeUndefined();
		expect(final?.summary.activeSessionId).toBeUndefined();
		expect(final?.summary.id).toBe("session-child-active");
	});

	it("sends deltas only on change and flips closed sessions to non-resident instead of dropping them", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const state = makeState({
			activeSessionId: "root-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(state.activeSessionId, state);

		daemon.flushRoster();
		daemon.flushRoster();
		expect(sentDeltas).toHaveLength(1);

		daemon.sessions.delete(state.activeSessionId);
		daemon.flushRoster();
		const flipped = sentDeltas.at(-1)?.entries[0];
		expect(flipped).toMatchObject({ summary: { id: "session-root-active", isSessionActive: false } });
		expect(flipped?.summary.activeSessionId).toBeUndefined();
		expect(sentDeltas.at(-1)?.removedAgentIds).toBeUndefined();
	});

	it("retains pending state until a frame reaches an authenticated supervisor", () => {
		const { daemon, sentDeltas } = makeWorkerReporter(false);
		const state = makeState({ activeSessionId: "root-active" });
		daemon.sessions.set(state.activeSessionId, state);
		daemon.rosterReporter.removedAgentIds.add("gone-agent");

		daemon.flushRoster();

		expect(sentDeltas).toHaveLength(0);
		expect(daemon.rosterReporter.lastSent.size).toBe(0);
		expect(daemon.rosterReporter.removedAgentIds.has("gone-agent")).toBe(true);
	});

	it("sends a replacing snapshot after supervisor (re)authentication that carries pending removals", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const state = makeState({
			activeSessionId: "root-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(state.activeSessionId, state);
		daemon.rosterReporter.removedAgentIds.add("deleted-agent");
		daemon.rosterReporter.snapshotPending = true;

		daemon.flushRoster();

		expect(sentDeltas).toHaveLength(1);
		expect(sentDeltas[0]?.snapshot).toBe(true);
		expect(sentDeltas[0]?.removedAgentIds).toEqual(["deleted-agent"]);
		expect(sentDeltas[0]?.entries.map((entry) => entry.agentId)).toEqual(["session-root-active"]);
		expect(daemon.rosterReporter.snapshotPending).toBe(false);
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(0);

		daemon.flushRoster();
		expect(sentDeltas).toHaveLength(1);
	});

	it("keeps a session that lived and died while disconnected as a durable row in the reauth snapshot", () => {
		const { daemon, sentDeltas, connection } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();

		connection.connected = false;
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "running", activeSessionId: "child-active" }),
		);
		daemon.flushRoster();
		daemon.sessions.delete(childState.activeSessionId);
		daemon.flushRoster();

		connection.connected = true;
		daemon.rosterReporter.snapshotPending = true;
		daemon.flushRoster();

		const snapshot = sentDeltas.at(-1);
		expect(snapshot?.snapshot).toBe(true);
		const childRow = snapshot?.entries.find((entry) => entry.agentId === "child-1");
		expect(childRow?.queuedChild).toBeUndefined();
		expect(childRow?.summary.id).toBe("session-child-active");
		expect(childRow?.summary.activeSessionId).toBeUndefined();
	});

	it("ignores a late queued update for a child whose session is already bound", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.flushRoster();

		// Crafted without activeSessionId: the lifecycle guard, not event stamping, must reject it.
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.sessions.delete(childState.activeSessionId);
		daemon.flushRoster();

		const final = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "child-1");
		expect(final?.queuedChild).toBeUndefined();
		expect(final?.summary.id).toBe("session-child-active");
	});
});

// ------------------------------------------------------------------
// Supervisor-side roster ledger
// ------------------------------------------------------------------

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

interface WorkerFixture {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		lifecycle: "ready";
		ownerClientId?: string;
	};
	client?: { request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	rosterCapable?: boolean;
	lastFrameAt?: number;
	rosterStale?: boolean;
	snapshotCache: Map<string, unknown>;
	transcriptCaches: Map<string, unknown>;
	snapshotGenerations: Map<string, unknown>;
	snapshotLoads: Map<string, unknown>;
}

function makeWorker(workerId: string, overrides: Partial<WorkerFixture> = {}): WorkerFixture {
	return {
		descriptor: { workerId, pid: 1234, rootActiveSessionId: `${workerId}-root-active`, lifecycle: "ready" },
		client: { request: vi.fn() },
		summaries: new Map(),
		intentionalStop: false,
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		...overrides,
	};
}

interface SupervisorFixture {
	workers: Map<string, WorkerFixture>;
	consumeWorkerRosterDelta(worker: WorkerFixture, payload: Buffer): void;
	handleList(
		client: object,
		command: { id?: string; type: "list"; all?: boolean; includeClientOwned?: boolean; sessionDir?: string },
	): { success: boolean; data?: { sessions: SessionSummary[]; busyClientOwnedSessionCount?: number } };
	handleWorkerClose(worker: WorkerFixture, client: object, error: Error): Promise<void>;
	handleWorkerFrame(worker: WorkerFixture, frame: unknown): void;
	sweepRosterStaleness(now?: number): void;
	writeRosterEntry(entry: WorkerRosterEntry, worker?: WorkerFixture): AgentRosterEntry;
	workerRosterEntries(worker: WorkerFixture): AgentRosterEntry[];
	flipWorkerRosterEntriesInactive(worker: WorkerFixture): void;
	seedRosterLedger(): Promise<void>;
	roster(): {
		get(agentId: string): AgentRosterEntry | undefined;
		has(agentId: string): boolean;
		values(): IterableIterator<AgentRosterEntry>;
	};
	refreshWorkerSummaries: ReturnType<typeof vi.fn>;
}

function makeSupervisor(workers: WorkerFixture[], extra: Record<string, unknown> = {}): SupervisorFixture {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map(workers.map((worker) => [worker.descriptor.workerId, worker])),
		clients: new Set(),
		defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
		catalog: { list: vi.fn(async () => []) },
		refreshWorkerSummaries: vi.fn(async () => {}),
		persistWorker: vi.fn(),
		invalidateWorkerSessionInputPauses: vi.fn(),
		deferWorkerRecovery: vi.fn(),
		assertRecoveryAllowed: vi.fn(async () => {
			throw new Error("recovery halted for test");
		}),
		log: vi.fn(),
		...extra,
	}) as SupervisorFixture;
}

function rosterDelta(entries: WorkerRosterEntry[], removedAgentIds?: string[], snapshot?: true): Buffer {
	return Buffer.from(
		JSON.stringify({
			type: "roster_delta",
			entries,
			...(removedAgentIds ? { removedAgentIds } : {}),
			...(snapshot ? { snapshot } : {}),
		}),
	);
}

describe("supervisor roster ledger", () => {
	it("keeps queued child rows ledger-internal and lists them once their session materializes", async () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker]);

		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta([
				{
					agentId: "child-1",
					queuedChild: true,
					summary: summary({
						id: "child-1",
						sessionId: "child-1",
						runtimeKind: "subagent",
						rlmChildId: "child-1",
					}),
				},
			]),
		);

		expect((await supervisor.handleList({}, { type: "list" })).data?.sessions).toEqual([]);
		expect((await supervisor.handleList({}, { type: "list", all: true })).data?.sessions).toEqual([]);
		expect(supervisor.workerRosterEntries(worker)[0]).toMatchObject({ status: "running", statusLabel: "queued" });

		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta([
				{
					agentId: "child-1",
					summary: summary({
						id: "child-active",
						sessionId: "child-session",
						activeSessionId: "child-active",
						runtimeKind: "subagent",
						rlmChildId: "child-1",
						isSessionActive: true,
					}),
				},
			]),
		);

		const listed = await supervisor.handleList({}, { type: "list" });
		expect(listed.data?.sessions).toHaveLength(1);
		expect(listed.data?.sessions[0]).toMatchObject({ activeSessionId: "child-active", workerState: "ready" });
		expect(supervisor.workerRosterEntries(worker)[0]).toMatchObject({ status: "running" });
		expect(supervisor.workerRosterEntries(worker)[0]?.statusLabel).toBeUndefined();
	});

	it("keeps passivated children of a live worker in the resident list, seeded rows in list all only", async () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "root-active", sessionId: "root", activeSessionId: "root-active" }),
			),
			worker,
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "child-session",
					sessionId: "child-session",
					sessionFile: "/tmp/artifacts/child.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "child-1",
				}),
			),
			worker,
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "seeded", sessionId: "seeded", sessionFile: "/tmp/seeded.jsonl" })),
		);

		const resident = await supervisor.handleList({}, { type: "list" });
		expect(resident.data?.sessions.map((session) => session.sessionId).sort()).toEqual(["child-session", "root"]);
		const child = resident.data?.sessions.find((session) => session.rlmChildId === "child-1");
		expect(child).toMatchObject({ workerPid: 1234 });
		expect(child?.activeSessionId).toBeUndefined();

		const all = await supervisor.handleList({}, { type: "list", all: true });
		expect(all.data?.sessions.map((session) => session.sessionId).sort()).toEqual([
			"child-session",
			"root",
			"seeded",
		]);
	});

	it("serves list from the ledger with zero worker round-trips and exact busy counts", async () => {
		const visible = makeWorker("visible");
		const owned = makeWorker("owned", {
			descriptor: {
				workerId: "owned",
				pid: 1,
				rootActiveSessionId: "owned-root-active",
				lifecycle: "ready",
				ownerClientId: "owner-client",
			},
		});
		const supervisor = makeSupervisor([visible, owned], {
			protocolClientIds: new WeakMap(),
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "v-active", sessionId: "v", activeSessionId: "v-active" })),
			visible,
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "o-active", sessionId: "o", activeSessionId: "o-active", isSessionActive: true }),
			),
			owned,
		);

		const listed = await supervisor.handleList({}, { type: "list", includeClientOwned: true });

		expect(listed.success).toBe(true);
		expect(listed.data?.busyClientOwnedSessionCount).toBe(1);
		// Client-owned sessions are excluded for a non-owner client; busy count stays exact.
		expect(listed.data?.sessions.map((session) => session.sessionId)).toEqual(["v"]);
		expect(visible.client?.request).not.toHaveBeenCalled();
		expect(owned.client?.request).not.toHaveBeenCalled();
		expect(supervisor.refreshWorkerSummaries).not.toHaveBeenCalled();
	});

	it("replaces a worker's rows from a snapshot frame", () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "kept-active",
					sessionId: "kept",
					activeSessionId: "kept-active",
					sessionFile: "/tmp/kept.jsonl",
				}),
			),
			worker,
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "gone-active",
					sessionId: "gone",
					activeSessionId: "gone-active",
					sessionFile: "/tmp/gone.jsonl",
				}),
			),
			worker,
		);
		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta(
				[
					{
						agentId: "sessionless",
						queuedChild: true,
						summary: summary({ id: "sessionless", sessionId: "sessionless", runtimeKind: "subagent" }),
					},
				],
				undefined,
			),
		);

		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta(
				[
					workerRosterEntryFromSummary(
						summary({
							id: "kept-active",
							sessionId: "kept",
							activeSessionId: "kept-active",
							sessionFile: "/tmp/kept.jsonl",
							isSessionActive: true,
						}),
					),
				],
				undefined,
				true,
			),
		);

		expect(supervisor.roster().get("kept")).toMatchObject({ status: "running" });
		// Absent rows with a transcript passivate; the sessionless queued row vanishes with its run.
		const gone = supervisor.roster().get("gone");
		expect(gone?.summary.activeSessionId).toBeUndefined();
		expect(gone?.status).toBe("inactive");
		expect(supervisor.roster().has("sessionless")).toBe(false);
	});

	it("applies snapshot removals after replacement so deletions survive a disconnect", () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "deleted", sessionId: "deleted", sessionFile: "/tmp/deleted.jsonl" }),
			),
			worker,
		);

		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], ["deleted"], true));

		// Without the removal, the absent-with-transcript rule would revive the row as a ghost.
		expect(supervisor.roster().has("deleted")).toBe(false);
	});

	it("marks a dead worker's rows recovering natively on socket close", async () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "r-active", sessionId: "r", activeSessionId: "r-active" })),
			worker,
		);

		const client = worker.client as object;
		await supervisor.handleWorkerClose(worker, client, new Error("worker died"));

		const entry = supervisor.workerRosterEntries(worker)[0];
		expect(entry).toMatchObject({ statusLabel: "recovering" });
		expect(entry?.summary.activeSessionId).toBe("r-active");
	});

	it("stamps staleness while a worker is silent and clears it when frames resume", () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const worker = makeWorker("worker-1", { rosterCapable: true, lastFrameAt: now - 60_000 });
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active" })),
			worker,
		);

		supervisor.sweepRosterStaleness(now);
		expect(supervisor.workerRosterEntries(worker)[0]?.lastHeardFromAt).toBe(new Date(now - 60_000).toISOString());

		worker.lastFrameAt = now;
		supervisor.sweepRosterStaleness(now);
		expect(supervisor.workerRosterEntries(worker)[0]?.lastHeardFromAt).toBeUndefined();
	});

	it("refreshes summaries on events only for workers without the roster capability", () => {
		const legacy = makeWorker("legacy");
		const modern = makeWorker("modern", { rosterCapable: true });
		const supervisor = makeSupervisor([legacy, modern], {
			streamReconstructor: { observe: vi.fn(), seed: vi.fn(), clear: vi.fn() },
		});
		const frame = (activeSessionId: string) => ({
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "turn_end",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(JSON.stringify({ type: "session_event", activeSessionId, event: { type: "turn_end" } })),
		});

		supervisor.handleWorkerFrame(legacy, frame("legacy-active"));
		supervisor.handleWorkerFrame(modern, frame("modern-active"));

		expect(supervisor.refreshWorkerSummaries).toHaveBeenCalledTimes(1);
		expect(supervisor.refreshWorkerSummaries).toHaveBeenCalledWith(legacy);
	});

	it("seeds from the session catalog and spawn ledger, skips tombstones, and keeps evicted rows inactive", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-seed-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const liveChildPath = join(directory, "artifacts", "live-child.jsonl");
		const deletedChildPath = join(directory, "artifacts", "deleted-child.jsonl");
		await ledger.appendSpawn({
			childId: "live-child",
			parent: join(sessionsDir, "root.jsonl"),
			child: liveChildPath,
			depth: 1,
			name: "live-child",
		});
		await ledger.appendSpawn({
			childId: "deleted-child",
			parent: join(sessionsDir, "root.jsonl"),
			child: deletedChildPath,
			depth: 1,
			name: "deleted-child",
		});
		await ledger.appendDelete({ childId: "deleted-child", child: deletedChildPath, reason: "user" });

		const supervisor = makeSupervisor([], {
			rlmSpawnLedger: () => ledger,
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						path: join(sessionsDir, "root.jsonl"),
						cwd: "/tmp/project",
						created: new Date(0),
						modified: new Date(0),
						messageCount: 3,
						firstMessage: "hello",
						allMessagesText: "",
					},
				]),
			},
		});
		await supervisor.seedRosterLedger();

		const listed = await supervisor.handleList({}, { type: "list", all: true });
		const ids = listed.data?.sessions.map((session) => session.sessionId).sort();
		expect(ids).toEqual(["live-child", "saved-root"]);
		expect(listed.data?.sessions.every((session) => session.activeSessionId === undefined)).toBe(true);
		expect((await supervisor.handleList({}, { type: "list" })).data?.sessions).toEqual([]);

		// An evicted worker leaves its rows behind as inactive instead of dropping them.
		const worker = makeWorker("worker-1");
		supervisor.workers.set("worker-1", worker);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "e-active",
					sessionId: "evicted",
					activeSessionId: "e-active",
					sessionFile: join(sessionsDir, "evicted.jsonl"),
					isSessionActive: true,
				}),
			),
			worker,
		);
		supervisor.workers.delete("worker-1");
		supervisor.flipWorkerRosterEntriesInactive(worker);

		const afterEvict = await supervisor.handleList({}, { type: "list", all: true });
		const evicted = afterEvict.data?.sessions.find((session) => session.sessionId === "evicted");
		expect(evicted).toBeDefined();
		expect(evicted?.activeSessionId).toBeUndefined();
		expect(afterEvict.data?.sessions.some((session) => session.sessionId === "deleted-child")).toBe(false);
	});

	it("scopes list all by sessions dir through owning topology, not the shared artifacts tree", async () => {
		const supervisor = makeSupervisor([]);
		const base = "/tmp/agent-homes";
		const dirA = join(base, "a", "sessions");
		const dirB = join(base, "b", "sessions");
		const rootA = join(dirA, "root-a.jsonl");
		const rootB = join(dirB, "root-b.jsonl");
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "root-a", sessionId: "root-a", sessionFile: rootA })),
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "root-b", sessionId: "root-b", sessionFile: rootB })),
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "child-a",
					sessionId: "child-a",
					sessionFile: join(base, "a", "session-artifacts", "root-a", "child-a.jsonl"),
					parentSessionPath: rootA,
					runtimeKind: "subagent",
					rlmChildId: "child-a",
					rlmDepth: 1,
				}),
			),
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "child-b",
					sessionId: "child-b",
					sessionFile: join(base, "b", "session-artifacts", "root-b", "child-b.jsonl"),
					parentSessionPath: rootB,
					runtimeKind: "subagent",
					rlmChildId: "child-b",
					rlmDepth: 1,
				}),
			),
		);

		const listDir = async (sessionDir: string) =>
			(await supervisor.handleList({}, { type: "list", all: true, sessionDir })).data?.sessions
				.map((session) => session.sessionId)
				.sort();

		expect(await listDir(dirA)).toEqual(["child-a", "root-a"]);
		expect(await listDir(dirB)).toEqual(["child-b", "root-b"]);
	});

	it("updates the roster on offline saved-session renames", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-offline-rename-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "saved.jsonl");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & { handleCommand(client: object, command: object): Promise<unknown> };
		Object.assign(supervisor, {
			catalog: { rename: vi.fn(async () => {}), list: vi.fn(async () => []) },
			rlmLedgerSiblings: vi.fn(async () => [
				{
					id: "saved-1",
					path: sessionPath,
					cwd: directory,
					created: new Date(0),
					modified: new Date(0),
					messageCount: 1,
					firstMessage: "",
					allMessagesText: "",
				},
			]),
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath, sessionName: "old-name" }),
			),
		);

		await supervisor.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "rename_saved_session", sessionPath, name: "new-name" },
		);

		expect(supervisor.roster().get("saved-1")?.summary.sessionName).toBe("new-name");
	});

	it("removes the roster row on offline deletes, tombstones subagents, and never reseeds them", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-offline-delete-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const parentPath = join(sessionsDir, "root.jsonl");
		const childPath = join(directory, "artifacts", "child.jsonl");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & {
			handleCommand(client: object, command: object): Promise<unknown>;
			rlmSpawnLedger(): RlmSpawnLedger;
		};
		Object.assign(supervisor, {
			catalog: { delete: vi.fn(async () => ({ ok: true, method: "unlink" })), list: vi.fn(async () => []) },
		});
		await supervisor
			.rlmSpawnLedger()
			.appendSpawn({ childId: "child-1", parent: parentPath, child: childPath, depth: 1, name: "child" });
		const childEntry = workerRosterEntryFromSummary(
			summary({
				id: "child-1",
				sessionId: "child-1",
				sessionFile: childPath,
				runtimeKind: "subagent",
				rlmChildId: "child-1",
				parentSessionPath: parentPath,
			}),
		);
		supervisor.writeRosterEntry(childEntry);

		await supervisor.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: childPath },
		);

		expect(supervisor.roster().has(childEntry.agentId)).toBe(false);
		await expect(supervisor.rlmSpawnLedger().edges()).resolves.toEqual([]);

		// A fresh supervisor over the same agent dir must not reseed the tombstoned child.
		const reseeded = makeSupervisor([], {
			rlmSpawnLedger: () => supervisor.rlmSpawnLedger(),
			catalog: { list: vi.fn(async () => []) },
		});
		await reseeded.seedRosterLedger();
		expect([...reseeded.roster().values()]).toEqual([]);
	});
});

describe("worker saved-session deletion reaches the supervisor roster", () => {
	it("removes the deleted session's ledger row end-to-end", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-worker-delete-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const manager = SessionManager.create(directory, sessionsDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.flushNow();
		const sessionPath = manager.getSessionFile();
		const sessionId = manager.getSessionId();
		if (!sessionPath) throw new Error("Fixture session did not persist");

		const daemon = new AgentDaemon(join(directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
			worker: {
				authenticationToken: "token",
				workerId: "worker-1",
				rootActiveSessionId: "root-active",
			} as never,
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never);
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
		const supervisorClient = {
			id: "supervisor",
			socket,
			transport: "private-framed",
			authenticated: true,
			attachedActiveSessionIds: new Set<string>(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set<string>(),
		} as unknown as DaemonSocketClient;
		const internals = daemon as unknown as {
			clients: Set<DaemonSocketClient>;
			supervisorClaims: Map<DaemonSocketClient, object>;
			handleCommand(client: DaemonSocketClient, command: object): Promise<unknown>;
			flushRoster(): void;
		};
		internals.clients.add(supervisorClient);
		internals.supervisorClaims.set(supervisorClient, {});

		await internals.handleCommand(supervisorClient, { type: "delete_saved_session", sessionPath });
		internals.flushRoster();

		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(Buffer.concat(written));
		const deltaFrame = frames.find(
			(frame) => frame.header.kind === "outbound" && frame.header.outboundType === "roster_delta",
		);
		if (!deltaFrame) throw new Error("Worker did not publish a roster delta");
		const delta = JSON.parse(deltaFrame.payload.toString("utf8")) as RosterDelta;
		expect(delta.removedAgentIds).toEqual([sessionId]);

		const worker = makeWorker("worker-1", { rosterCapable: true });
		const supervisor = makeSupervisor([worker]);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: sessionId, sessionId, sessionFile: sessionPath })),
			worker,
		);
		supervisor.consumeWorkerRosterDelta(worker, deltaFrame.payload);
		expect(supervisor.roster().has(sessionId)).toBe(false);
	});
});

describe("roster entry projection", () => {
	it("carries modelFallbackMessage through the roster round-trip", () => {
		const source = summary({
			id: "m-active",
			sessionId: "m",
			activeSessionId: "m-active",
			modelFallbackMessage: "No models available",
		});
		const roundTripped = sessionSummaryFromRosterEntry(workerRosterEntryFromSummary(source));
		expect(roundTripped.modelFallbackMessage).toBe("No models available");
	});
});

describe("bot-round regressions", () => {
	it("removes a child run that terminates before binding instead of passivating a phantom", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();

		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "cancelled", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["child-1"]);
		expect(sentDeltas.at(-1)?.entries.some((entry) => entry.agentId === "child-1")).toBe(false);

		daemon.rosterReporter.snapshotPending = true;
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.snapshot).toBe(true);
		expect(sentDeltas.at(-1)?.entries.some((entry) => entry.agentId === "child-1")).toBe(false);
	});

	it("qualifies colliding child ids from different parents by parent path", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parentA = makeState({ activeSessionId: "parent-a", sessionFile: "/tmp/a.jsonl" });
		const parentB = makeState({ activeSessionId: "parent-b", sessionFile: "/tmp/b.jsonl" });
		daemon.sessions.set(parentA.activeSessionId, parentA);
		daemon.sessions.set(parentB.activeSessionId, parentB);

		daemon.observeRosterEvent(
			parentA,
			childUpdate(parentA, { id: "sub-1234", label: "a", status: "queued", sessionDir: "/tmp/a" }),
		);
		daemon.observeRosterEvent(
			parentB,
			childUpdate(parentB, { id: "sub-1234", label: "b", status: "queued", sessionDir: "/tmp/b" }),
		);
		daemon.flushRoster();

		const queuedRows = sentDeltas.at(-1)?.entries.filter((entry) => entry.summary.rlmChildId === "sub-1234") ?? [];
		expect(queuedRows).toHaveLength(2);
		expect(new Set(queuedRows.map((entry) => entry.agentId)).size).toBe(2);
	});

	it("keeps roster state uncommitted until a frame reaches a drained socket", () => {
		const write = vi.fn(() => false);
		const socket = { destroyed: false, write };
		const client = {
			transport: "private-framed",
			authenticated: true,
			backpressured: undefined as boolean | undefined,
			socket,
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			sessions: new Map(),
			cronStore: { list: () => [] },
			clients: new Set([client]),
			supervisorClaims: new Map([[client, {}]]),
			rosterReporter: {
				lastSent: new Map(),
				lastComposed: new Map(),
				queuedChildren: new Map(),
				removedAgentIds: new Set(["deleted-agent"]),
				tombstones: new Map(),
				generation: 0,
				snapshotPending: false,
			},
			rosterFlushScheduled: false,
			shuttingDown: false,
			log: vi.fn(),
		}) as {
			flushRoster(): void;
			rosterReporter: { removedAgentIds: Set<string>; lastSent: Map<string, unknown> };
		};

		daemon.flushRoster();
		// write() returned false: the frame is not delivered; nothing commits.
		expect(daemon.rosterReporter.removedAgentIds.has("deleted-agent")).toBe(true);
		expect(daemon.rosterReporter.lastSent.size).toBe(0);
		expect(client.backpressured).toBe(true);

		// A backpressured socket gets no further writes until it drains.
		daemon.flushRoster();
		expect(write).toHaveBeenCalledTimes(1);

		client.backpressured = false;
		write.mockReturnValue(true);
		daemon.flushRoster();
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(0);
	});

	it("merges the per-call disk scan newest-first with disk authoritative for non-resident rows", async () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker], {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "external",
						path: "/tmp/external.jsonl",
						cwd: "/tmp/project",
						created: new Date(0),
						modified: new Date(0),
						messageCount: 1,
						firstMessage: "made after startup",
						allMessagesText: "",
					},
					{
						id: "known",
						path: "/tmp/known.jsonl",
						cwd: "/tmp/project",
						created: new Date(0),
						modified: new Date(0),
						messageCount: 1,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "known",
					sessionId: "known",
					sessionFile: "/tmp/known.jsonl",
					sessionName: "stale-ledger-name",
				}),
			),
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "res-active",
					sessionId: "resident",
					sessionFile: "/tmp/external.jsonl",
					activeSessionId: "res-active",
				}),
			),
			worker,
		);

		const listed = await supervisor.handleList({}, { type: "list", all: true });
		// Newest-first catalog order with the resident row replacing its scanned file in place.
		expect(listed.data?.sessions.map((session) => session.sessionId)).toEqual(["resident", "known"]);
		// Disk is authoritative for non-resident rows; the stale ledger name loses.
		expect(listed.data?.sessions.find((session) => session.sessionId === "known")?.sessionName).toBeUndefined();
	});

	it("forwards passive-child deletes to the owning worker instead of rejecting them", async () => {
		const worker = makeWorker("worker-1");
		worker.client = {
			request: vi.fn(async () => ({ type: "response", command: "delete_saved_session", success: true })),
		};
		Object.assign(worker.descriptor, { lifecycle: "ready" });
		const catalogDelete = vi.fn();
		const supervisor = makeSupervisor([worker], {
			catalog: { list: vi.fn(async () => []), delete: catalogDelete },
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "child-session",
					sessionId: "child-session",
					sessionFile: "/tmp/artifacts/child.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "child-1",
				}),
			),
			worker,
		);
		const internals = supervisor as unknown as {
			handleCommand(client: object, command: object): Promise<unknown>;
		};

		await internals.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: "/tmp/artifacts/child.jsonl" },
		);

		expect(worker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "delete_saved_session", sessionPath: "/tmp/artifacts/child.jsonl" }),
			expect.any(Number),
		);
		expect(catalogDelete).not.toHaveBeenCalled();
	});

	it("keeps the roster row when a delete fails on disk", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-failed-delete-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "saved.jsonl");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & { handleCommand(client: object, command: object): Promise<unknown> };
		Object.assign(supervisor, {
			catalog: { delete: vi.fn(async () => ({ ok: false, error: "busy file" })), list: vi.fn(async () => []) },
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath })),
		);

		await supervisor.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath },
		);

		expect(supervisor.roster().has("saved-1")).toBe(true);
	});

	it("rejects offline deletes owned via descriptor or an unreachable worker, forwards reachable owners", async () => {
		const reachable = makeWorker("w-reach");
		Object.assign(reachable.descriptor, { sessionFile: "/tmp/owned-reach.jsonl", createCommand: { type: "create" } });
		reachable.client = {
			request: vi.fn(async () => ({ type: "response", command: "delete_saved_session", success: true })),
		};
		const unreachable = makeWorker("w-down");
		Object.assign(unreachable.descriptor, {
			sessionFile: "/tmp/owned-down.jsonl",
			createCommand: { type: "create" },
		});
		unreachable.client = undefined;
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const supervisor = makeSupervisor([reachable, unreachable], {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
		});
		const internals = supervisor as unknown as { handleCommand(client: object, command: object): Promise<unknown> };
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		// Descriptor ownership with a live socket forwards, roster row or not.
		await internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-reach.jsonl" });
		expect(reachable.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "delete_saved_session" }),
			expect.any(Number),
		);

		// A live-but-disconnected owner rejects instead of deleting underneath the worker.
		await expect(
			internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-down.jsonl" }),
		).rejects.toThrow(/retry the delete/);
		expect(catalogDelete).not.toHaveBeenCalled();
	});

	it("classifies unknown offline delete targets through the ledger", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-offline-unknown-"));
		tempDirs.push(directory);
		const garbled = join(directory, "artifacts", "garbled.jsonl");
		mkdirSync(dirname(garbled), { recursive: true });
		writeFileSync(garbled, "not a session header\n");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & {
			handleCommand(client: object, command: object): Promise<unknown>;
			rlmSpawnLedger(): RlmSpawnLedger;
		};
		Object.assign(supervisor, {
			catalog: { delete: vi.fn(async () => ({ ok: true, method: "unlink" })), list: vi.fn(async () => []) },
		});
		await supervisor.rlmSpawnLedger().appendSpawn({
			childId: "sub-9",
			parent: join(directory, "sessions", "r.jsonl"),
			child: garbled,
			depth: 1,
			name: "g",
		});

		await supervisor.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: garbled },
		);

		await expect(supervisor.rlmSpawnLedger().edges()).resolves.toEqual([]);
	});

	it("ignores buffered roster frames from a superseded worker connection", () => {
		const worker = makeWorker("worker-1", { rosterCapable: true });
		const supervisor = makeSupervisor([worker], {
			streamReconstructor: { observe: vi.fn(), seed: vi.fn(), clear: vi.fn() },
		});
		const staleClient = { request: vi.fn() };
		const frame = {
			header: { kind: "outbound", outboundType: "roster_delta" },
			payload: rosterDelta([workerRosterEntryFromSummary(summary({ id: "ghost", sessionId: "ghost" }))]),
		};

		(supervisor as unknown as { handleWorkerFrame(w: object, f: object, source?: object): void }).handleWorkerFrame(
			worker,
			frame,
			staleClient,
		);

		expect(supervisor.roster().has("ghost")).toBe(false);
	});

	it("accepts frames from the in-flight replacement connection and drops rolled-back sources", () => {
		const worker = makeWorker("worker-1", { rosterCapable: true });
		const supervisor = makeSupervisor([worker], {
			streamReconstructor: { observe: vi.fn(), seed: vi.fn(), clear: vi.fn() },
		});
		const replacement = { request: vi.fn() };
		const frame = (sessionId: string) => ({
			header: { kind: "outbound", outboundType: "roster_delta" },
			payload: rosterDelta([workerRosterEntryFromSummary(summary({ id: sessionId, sessionId }))]),
		});
		const internals = supervisor as unknown as {
			handleWorkerFrame(w: object, f: object, source?: object): void;
		};

		(worker as unknown as { pendingClient?: object }).pendingClient = replacement;
		internals.handleWorkerFrame(worker, frame("mid-auth"), replacement);
		expect(supervisor.roster().has("mid-auth")).toBe(true);

		// Failed auth rolls the pending source back; its buffered frames are dropped.
		(worker as unknown as { pendingClient?: object }).pendingClient = undefined;
		internals.handleWorkerFrame(worker, frame("rolled-back"), replacement);
		expect(supervisor.roster().has("rolled-back")).toBe(false);
	});

	it("reclaims a dead failed owner before an offline delete but keeps recovering owners rejecting", async () => {
		const failed = makeWorker("w-failed");
		Object.assign(failed.descriptor, {
			sessionFile: "/tmp/owned-failed.jsonl",
			createCommand: { type: "create" },
			lifecycle: "failed",
		});
		failed.client = undefined;
		const recovering = makeWorker("w-recovering");
		Object.assign(recovering.descriptor, {
			sessionFile: "/tmp/owned-recovering.jsonl",
			createCommand: { type: "create" },
			lifecycle: "recovering",
		});
		recovering.client = undefined;
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const reclaimStaleWorkerRegistration = vi.fn(
			async (worker: { descriptor: { lifecycle: string; workerId: string } }) => {
				if (worker.descriptor.lifecycle !== "failed") return false;
				supervisor.workers.delete(worker.descriptor.workerId);
				return true;
			},
		);
		const supervisor = makeSupervisor([failed, recovering], {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
			reclaimStaleWorkerRegistration,
			rlmSpawnLedger: () => ({ edges: vi.fn(async () => []) }),
		});
		const internals = supervisor as unknown as { handleCommand(client: object, command: object): Promise<unknown> };
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		await internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-failed.jsonl" });
		expect(reclaimStaleWorkerRegistration).toHaveBeenCalledWith(failed);
		expect(catalogDelete).toHaveBeenCalledWith("/tmp/owned-failed.jsonl");

		await expect(
			internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-recovering.jsonl" }),
		).rejects.toThrow(/retry the delete/);
	});

	it("walks parent chains beyond thirty-two hops and terminates on cycles", async () => {
		const supervisor = makeSupervisor([]);
		const base = "/tmp/deep-home";
		const dir = join(base, "sessions");
		let parentPath = join(dir, "root.jsonl");
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "root", sessionId: "root", sessionFile: parentPath })),
		);
		for (let depth = 1; depth <= 33; depth++) {
			const childPath = join(base, "session-artifacts", `d${depth}.jsonl`);
			supervisor.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({
						id: `d${depth}`,
						sessionId: `d${depth}`,
						sessionFile: childPath,
						runtimeKind: "subagent",
						rlmChildId: `d${depth}`,
						rlmDepth: depth,
						parentSessionPath: parentPath,
					}),
				),
			);
			parentPath = childPath;
		}
		const listed = await supervisor.handleList({}, { type: "list", all: true, sessionDir: dir });
		expect(listed.data?.sessions.some((session) => session.sessionId === "d33")).toBe(true);

		// A cycle terminates instead of hanging; the cyclic row simply does not match the dir.
		const cyclic = makeSupervisor([]);
		cyclic.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "loop",
					sessionId: "loop",
					sessionFile: join(base, "session-artifacts", "loop.jsonl"),
					runtimeKind: "subagent",
					rlmChildId: "loop",
					rlmDepth: 1,
					parentSessionPath: join(base, "session-artifacts", "loop.jsonl"),
				}),
			),
		);
		const cyclicListed = await cyclic.handleList({}, { type: "list", all: true, sessionDir: dir });
		expect(cyclicListed.data?.sessions.some((session) => session.sessionId === "loop")).toBe(false);
	});

	it("resolves seeded artifact children by their persisted session id before any delta", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-seed-id-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const persistedId = "0a1b2c3d4e5f0a1b2c3d4e5f";
		const childPath = join(directory, "artifacts", `${persistedId}.jsonl`);
		await ledger.appendSpawn({
			childId: "sub-abc",
			parent: join(sessionsDir, "root.jsonl"),
			child: childPath,
			depth: 1,
			name: "child",
		});
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker], {
			rlmSpawnLedger: () => ledger,
			catalog: { list: vi.fn(async () => []) },
		});
		await supervisor.seedRosterLedger();
		// Claim the seeded row for a worker so selector matching can route to it.
		const seeded = [...supervisor.roster().values()][0];
		if (!seeded) throw new Error("Missing seeded row");
		supervisor.writeRosterEntry(seeded, worker);
		const internals = supervisor as unknown as {
			findWorker(selector: string): Promise<{ summary: SessionSummary }>;
		};

		const match = await internals.findWorker(persistedId);
		expect(match.summary.rlmChildId).toBe("sub-abc");
	});

	it("routes a just-bound session through the miss-path refresh", async () => {
		const target = summary({ id: "target-active", sessionId: "target", activeSessionId: "target-active" });
		const worker = makeWorker("worker-1", { rosterCapable: true });
		worker.client = {
			request: vi.fn(async () => ({
				type: "response",
				command: "list",
				success: true,
				data: { sessions: [target] },
			})),
		};
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			syncWorkerSummariesIntoRoster: DaemonSupervisor.prototype["syncWorkerSummariesIntoRoster" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		const internals = supervisor as unknown as {
			findWorker(selector: string): Promise<{ summary: SessionSummary }>;
		};

		const match = await internals.findWorker("target-active");
		expect(match.summary.sessionId).toBe("target");
	});

	it("does not let a summaries refresh overwrite a newer roster delta", async () => {
		const worker = makeWorker("worker-1", { rosterCapable: true });
		const stale = summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active", sessionName: "stale" });
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			syncWorkerSummariesIntoRoster: DaemonSupervisor.prototype["syncWorkerSummariesIntoRoster" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		worker.client = {
			request: vi.fn(async () => {
				supervisor.consumeWorkerRosterDelta(
					worker,
					rosterDelta([
						workerRosterEntryFromSummary(
							summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active", sessionName: "fresh" }),
						),
					]),
				);
				return { type: "response", command: "list", success: true, data: { sessions: [stale] } };
			}),
		};

		await (
			supervisor as unknown as { refreshWorkerSummaries(worker: WorkerFixture): Promise<void> }
		).refreshWorkerSummaries(worker);

		expect(supervisor.roster().get("s")?.summary.sessionName).toBe("fresh");
	});
});

describe("bot-round two regressions", () => {
	it("publishes qualified removal ids from the rlm subagent deletion path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-rlm-delete-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const manager = SessionManager.create(directory, sessionsDir);
		manager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
		manager.flushNow();
		const parentFile = manager.getSessionFile();
		if (!parentFile) throw new Error("Fixture parent did not persist");
		const childDir = join(directory, "artifacts", "sub-1");
		mkdirSync(childDir, { recursive: true });
		const childFile = join(childDir, "child.jsonl");
		const daemon = new AgentDaemon(join(directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
			worker: { authenticationToken: "token" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never);
		const internals = daemon as unknown as {
			rlmSpawnLedger(): RlmSpawnLedger;
			recordRlmSubagentDeletion(parentState: ActiveSessionState, childId: string): Promise<void>;
			rosterReporter: { removedAgentIds: Set<string> };
		};
		await internals
			.rlmSpawnLedger()
			.appendSpawn({ childId: "sub-1", parent: parentFile, child: childFile, depth: 1, name: "child" });
		const parentState = makeState({ activeSessionId: "parent-active", sessionFile: parentFile });

		await internals.recordRlmSubagentDeletion(parentState, "sub-1");

		const expected = workerRosterEntryFromSummary(
			summary({
				id: "sub-1",
				sessionId: "sub-1",
				runtimeKind: "subagent",
				rlmChildId: "sub-1",
				parentSessionPath: parentFile,
			}),
		).agentId;
		expect(internals.rosterReporter.removedAgentIds.has(expected)).toBe(true);
		expect(internals.rosterReporter.removedAgentIds.has("sub-1")).toBe(false);
	});

	it("publishes qualified removal ids for discarded bound-child drafts", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "sub-1",
			parentActiveSessionId: "parent-active",
			parentSessionFile: "/tmp/parents/root.jsonl",
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.flushRoster();
		const composedId = sentDeltas[0]?.entries.find((entry) => entry.summary.rlmChildId === "sub-1")?.agentId;
		if (!composedId) throw new Error("Missing composed child row");

		daemon.sessions.delete(childState.activeSessionId);
		const removalId = (
			daemon as unknown as { rosterAgentIdForState(state: ActiveSessionState): string }
		).rosterAgentIdForState(childState);
		daemon.rosterReporter.removedAgentIds.add(removalId);
		daemon.flushRoster();

		expect(removalId).toBe(composedId);
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual([composedId]);
	});

	it("delivers only through the live supervisor claim, never a revoked socket", () => {
		const oldWrite = vi.fn(() => true);
		const newWrite = vi.fn(() => true);
		const oldClient = {
			transport: "private-framed",
			authenticated: true,
			backpressured: undefined as boolean | undefined,
			socket: { destroyed: false, write: oldWrite },
		};
		const newClient = {
			transport: "private-framed",
			authenticated: true,
			backpressured: true as boolean | undefined,
			socket: { destroyed: false, write: newWrite },
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			sessions: new Map(),
			cronStore: { list: () => [] },
			clients: new Set([oldClient, newClient]),
			supervisorClaims: new Map([[newClient, {}]]),
			rosterReporter: {
				lastSent: new Map(),
				lastComposed: new Map(),
				queuedChildren: new Map(),
				removedAgentIds: new Set(["deleted-agent"]),
				tombstones: new Map(),
				generation: 0,
				snapshotPending: true,
			},
			rosterFlushScheduled: false,
			shuttingDown: false,
			log: vi.fn(),
		}) as {
			flushRoster(): void;
			rosterReporter: { removedAgentIds: Set<string>; snapshotPending: boolean };
		};

		daemon.flushRoster();
		expect(oldWrite).not.toHaveBeenCalled();
		expect(daemon.rosterReporter.removedAgentIds.has("deleted-agent")).toBe(true);
		expect(daemon.rosterReporter.snapshotPending).toBe(true);

		newClient.backpressured = false;
		daemon.flushRoster();
		expect(oldWrite).not.toHaveBeenCalled();
		expect(newWrite).toHaveBeenCalledTimes(1);
		expect(daemon.rosterReporter.snapshotPending).toBe(false);
	});

	it("replays delivered removals to supervisors behind the acked generation and prunes on ack", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const state = makeState({
			activeSessionId: "root-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(state.activeSessionId, state);
		daemon.flushRoster();
		daemon.sessions.delete(state.activeSessionId);
		daemon.rosterReporter.removedAgentIds.add("session-root-active");
		daemon.rosterReporter.lastComposed.clear();
		daemon.flushRoster();
		const removalGeneration = daemon.rosterReporter.tombstones.get("session-root-active");
		expect(removalGeneration).toBeGreaterThan(0);

		const internals = daemon as unknown as { prepareRosterSnapshot(acked: number): void };
		// A supervisor that never consumed the removal gets it replayed on the snapshot.
		internals.prepareRosterSnapshot((removalGeneration ?? 1) - 1);
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.snapshot).toBe(true);
		expect(sentDeltas.at(-1)?.removedAgentIds).toContain("session-root-active");

		// A supervisor that acked the removal prunes the tombstone; nothing replays.
		internals.prepareRosterSnapshot(daemon.rosterReporter.generation);
		daemon.flushRoster();
		expect(daemon.rosterReporter.tombstones.size).toBe(0);
		expect(sentDeltas.at(-1)?.removedAgentIds).toBeUndefined();

		// A fresh supervisor (ack 0) would have replayed everything; the tombstone map is already pruned.
		internals.prepareRosterSnapshot(0);
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.removedAgentIds).toBeUndefined();
	});

	it("keeps a busy worker unevicted when the refresh response is staler than a delta", async () => {
		const worker = makeWorker("worker-1", { rosterCapable: true });
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			syncWorkerSummariesIntoRoster: DaemonSupervisor.prototype["syncWorkerSummariesIntoRoster" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		const staleIdle = summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active" });
		worker.client = {
			request: vi.fn(async () => {
				supervisor.consumeWorkerRosterDelta(
					worker,
					rosterDelta([
						workerRosterEntryFromSummary(
							summary({ id: "s-active", sessionId: "s", activeSessionId: "s-active", isSessionActive: true }),
						),
					]),
				);
				return { type: "response", command: "list", success: true, data: { sessions: [staleIdle] } };
			}),
		};
		const internals = supervisor as unknown as {
			refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
			workerEvictionSnapshot(worker: WorkerFixture): { sessions: Array<{ isSessionActive: boolean }> };
		};

		await internals.refreshWorkerSummaries(worker);

		const snapshot = internals.workerEvictionSnapshot(worker);
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.isSessionActive).toBe(true);
	});

	it("aborts a saved-child delete when the tombstone append fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-tombstone-fail-"));
		tempDirs.push(directory);
		const childPath = join(directory, "artifacts", "child.jsonl");
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & { handleCommand(client: object, command: object): Promise<unknown> };
		Object.assign(supervisor, {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
			rlmSpawnLedger: () => ({
				edges: vi.fn(async () => [
					{
						childId: "child-1",
						child: childPath,
						parent: join(directory, "sessions", "root.jsonl"),
						depth: 1,
						name: "c",
					},
				]),
				appendDelete: vi.fn(async () => {
					throw new Error("ledger unwritable");
				}),
			}),
		});
		const childEntry = workerRosterEntryFromSummary(
			summary({
				id: "child-1",
				sessionId: "child-1",
				sessionFile: childPath,
				runtimeKind: "subagent",
				rlmChildId: "child-1",
				parentSessionPath: join(directory, "sessions", "root.jsonl"),
			}),
		);
		supervisor.writeRosterEntry(childEntry);

		await expect(
			supervisor.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{ type: "delete_saved_session", sessionPath: childPath },
			),
		).rejects.toThrow("ledger unwritable");
		expect(catalogDelete).not.toHaveBeenCalled();
		expect(supervisor.roster().has(childEntry.agentId)).toBe(true);
	});
});

describe("worker delete tombstone durability", () => {
	function makeDeleteDaemon(directory: string, ledgerEdges: () => Promise<never[]>) {
		const daemon = new AgentDaemon(join(directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: join(directory, "sessions") },
			worker: { authenticationToken: "token" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never);
		Object.assign(daemon, { rlmSpawnLedger: () => ({ edges: ledgerEdges }) });
		return daemon as unknown as {
			handleCommand(client: object, command: object): Promise<unknown>;
			rosterReporter: { removedAgentIds: Set<string> };
		};
	}

	it("aborts a child delete when the spawn ledger cannot be read", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-ledger-read-fail-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const parentManager = SessionManager.create(directory, sessionsDir);
		parentManager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
		parentManager.flushNow();
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("Fixture parent did not persist");
		const childManager = SessionManager.create(directory, join(directory, "artifacts"));
		childManager.newSession({ parentSession: parentFile });
		childManager.appendMessage({ role: "user", content: "child", timestamp: 2 });
		childManager.flushNow();
		const childFile = childManager.getSessionFile();
		if (!childFile) throw new Error("Fixture child did not persist");
		const daemon = makeDeleteDaemon(directory, async () => {
			throw new Error("ledger unreadable");
		});

		await expect(
			daemon.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{ type: "delete_saved_session", sessionPath: childFile },
			),
		).rejects.toThrow("ledger unreadable");

		expect(existsSync(childFile)).toBe(true);
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(0);
	});

	it("deletes a top-level saved session without touching the spawn ledger", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-toplevel-delete-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const manager = SessionManager.create(directory, sessionsDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.flushNow();
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("Fixture session did not persist");
		const daemon = makeDeleteDaemon(directory, async () => {
			throw new Error("ledger unreadable");
		});

		await daemon.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath },
		);

		expect(existsSync(sessionPath)).toBe(false);
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(1);
	});
	it("classifies an unreadable delete target through the ledger", async () => {
		const setup = () => {
			const directory = mkdtempSync(join(tmpdir(), "prime-roster-unknown-delete-"));
			tempDirs.push(directory);
			const garbled = join(directory, "artifacts", "garbled.jsonl");
			mkdirSync(dirname(garbled), { recursive: true });
			writeFileSync(garbled, "not a session header\n");
			return { directory, garbled };
		};

		// (a) A live edge classifies the unknown target as a child: tombstone first, then delete.
		const withEdge = setup();
		const daemonWithEdge = new AgentDaemon(join(withEdge.directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: withEdge.directory, cwd: withEdge.directory },
			worker: { authenticationToken: "token" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never) as unknown as {
			rlmSpawnLedger(): RlmSpawnLedger;
			handleCommand(client: object, command: object): Promise<unknown>;
			rosterReporter: { removedAgentIds: Set<string> };
		};
		await daemonWithEdge.rlmSpawnLedger().appendSpawn({
			childId: "sub-9",
			parent: join(withEdge.directory, "sessions", "root.jsonl"),
			child: withEdge.garbled,
			depth: 1,
			name: "garbled",
		});
		await daemonWithEdge.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: withEdge.garbled },
		);
		expect(existsSync(withEdge.garbled)).toBe(false);
		await expect(daemonWithEdge.rlmSpawnLedger().edges()).resolves.toEqual([]);
		expect(daemonWithEdge.rosterReporter.removedAgentIds.size).toBe(1);

		// (b) An unreadable ledger aborts the unknown target's deletion.
		const withFailure = setup();
		const daemonWithFailure = makeDeleteDaemon(withFailure.directory, async () => {
			throw new Error("ledger unreadable");
		});
		await expect(
			daemonWithFailure.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{ type: "delete_saved_session", sessionPath: withFailure.garbled },
			),
		).rejects.toThrow("ledger unreadable");
		expect(existsSync(withFailure.garbled)).toBe(true);
		expect(daemonWithFailure.rosterReporter.removedAgentIds.size).toBe(0);

		// (c) No edge: the unknown target deletes as a top-level session.
		const withoutEdge = setup();
		const daemonWithoutEdge = new AgentDaemon(join(withoutEdge.directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: withoutEdge.directory, cwd: withoutEdge.directory },
			worker: { authenticationToken: "token" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never) as unknown as { handleCommand(client: object, command: object): Promise<unknown> };
		await daemonWithoutEdge.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: withoutEdge.garbled },
		);
		expect(existsSync(withoutEdge.garbled)).toBe(false);
	});
});
