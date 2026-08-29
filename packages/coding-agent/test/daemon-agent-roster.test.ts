import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	kind?: "top-level" | "subagent";
	rlmChildId?: string;
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
			},
			diagnostics: [],
			session: {
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
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
	it("keeps queued child rows ledger-internal and lists them once their session materializes", () => {
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

		expect(supervisor.handleList({}, { type: "list" }).data?.sessions).toEqual([]);
		expect(supervisor.handleList({}, { type: "list", all: true }).data?.sessions).toEqual([]);
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

		const listed = supervisor.handleList({}, { type: "list" });
		expect(listed.data?.sessions).toHaveLength(1);
		expect(listed.data?.sessions[0]).toMatchObject({ activeSessionId: "child-active", workerState: "ready" });
		expect(supervisor.workerRosterEntries(worker)[0]).toMatchObject({ status: "running" });
		expect(supervisor.workerRosterEntries(worker)[0]?.statusLabel).toBeUndefined();
	});

	it("keeps passivated children of a live worker in the resident list, seeded rows in list all only", () => {
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

		const resident = supervisor.handleList({}, { type: "list" });
		expect(resident.data?.sessions.map((session) => session.sessionId).sort()).toEqual(["child-session", "root"]);
		const child = resident.data?.sessions.find((session) => session.rlmChildId === "child-1");
		expect(child).toMatchObject({ workerPid: 1234 });
		expect(child?.activeSessionId).toBeUndefined();

		const all = supervisor.handleList({}, { type: "list", all: true });
		expect(all.data?.sessions.map((session) => session.sessionId).sort()).toEqual([
			"child-session",
			"root",
			"seeded",
		]);
	});

	it("serves list from the ledger with zero worker round-trips and exact busy counts", () => {
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

		const listed = supervisor.handleList({}, { type: "list", includeClientOwned: true });

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

		const listed = supervisor.handleList({}, { type: "list", all: true });
		const ids = listed.data?.sessions.map((session) => session.sessionId).sort();
		expect(ids).toEqual(["live-child", "saved-root"]);
		expect(listed.data?.sessions.every((session) => session.activeSessionId === undefined)).toBe(true);
		expect(supervisor.handleList({}, { type: "list" }).data?.sessions).toEqual([]);

		// An evicted worker leaves its rows behind as inactive instead of dropping them.
		const worker = makeWorker("worker-1");
		supervisor.workers.set("worker-1", worker);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "e-active", sessionId: "evicted", activeSessionId: "e-active", isSessionActive: true }),
			),
			worker,
		);
		supervisor.workers.delete("worker-1");
		supervisor.flipWorkerRosterEntriesInactive(worker);

		const afterEvict = supervisor.handleList({}, { type: "list", all: true });
		const evicted = afterEvict.data?.sessions.find((session) => session.sessionId === "evicted");
		expect(evicted).toBeDefined();
		expect(evicted?.activeSessionId).toBeUndefined();
		expect(afterEvict.data?.sessions.some((session) => session.sessionId === "deleted-child")).toBe(false);
	});

	it("scopes list all by sessions dir through owning topology, not the shared artifacts tree", () => {
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

		const listDir = (sessionDir: string) =>
			supervisor
				.handleList({}, { type: "list", all: true, sessionDir })
				.data?.sessions.map((session) => session.sessionId)
				.sort();

		expect(listDir(dirA)).toEqual(["child-a", "root-a"]);
		expect(listDir(dirB)).toEqual(["child-b", "root-b"]);
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

	it("removes the roster row on offline saved-session deletes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-offline-delete-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "saved.jsonl");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorFixture & { handleCommand(client: object, command: object): Promise<unknown> };
		Object.assign(supervisor, {
			catalog: { delete: vi.fn(async () => ({ deleted: true })) },
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath })),
		);

		await supervisor.handleCommand(
			{ id: "client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath },
		);

		expect(supervisor.roster().has("saved-1")).toBe(false);
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
			handleCommand(client: DaemonSocketClient, command: object): Promise<unknown>;
			flushRoster(): void;
		};
		internals.clients.add(supervisorClient);

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
