import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	type AgentRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../src/modes/daemon/agent-roster.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerRosterOutbound } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

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
		rosterRemovedAgentIds: Set<string>;
	};
	sentDeltas: RosterDelta[];
}

function makeWorkerReporter(): WorkerReporterFixture {
	const sentDeltas: RosterDelta[] = [];
	const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: { authenticationToken: "token" } },
		sessions: new Map<string, ActiveSessionState>(),
		cronStore: { list: () => [] },
		rosterLastSent: new Map<string, { json: string; entry: WorkerRosterEntry }>(),
		rosterQueuedChildren: new Map<string, WorkerRosterEntry>(),
		rosterRemovedAgentIds: new Set<string>(),
		rosterFlushScheduled: false,
		shuttingDown: false,
		broadcastRosterFrame: (message: DaemonWorkerRosterOutbound) => {
			if (message.type === "roster_delta") sentDeltas.push(message);
		},
		log: vi.fn(),
	}) as WorkerReporterFixture["daemon"];
	return { daemon, sentDeltas };
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

	it("removes discarded and deleted agents explicitly", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const draft = makeState({ activeSessionId: "draft-active" });
		daemon.sessions.set(draft.activeSessionId, draft);
		daemon.flushRoster();

		daemon.sessions.delete(draft.activeSessionId);
		daemon.rosterRemovedAgentIds.add("session-draft-active");
		daemon.flushRoster();

		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["session-draft-active"]);
		expect(sentDeltas.at(-1)?.entries).toHaveLength(0);
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
		command: { id?: string; type: "list"; all?: boolean; includeClientOwned?: boolean },
	): { success: boolean; data?: { sessions: SessionSummary[]; busyClientOwnedSessionCount?: number } };
	handleWorkerClose(worker: WorkerFixture, client: object, error: Error): Promise<void>;
	handleWorkerFrame(worker: WorkerFixture, frame: unknown): void;
	sweepRosterStaleness(now?: number): void;
	writeRosterEntry(entry: WorkerRosterEntry, worker?: WorkerFixture): AgentRosterEntry;
	workerRosterEntries(worker: WorkerFixture): AgentRosterEntry[];
	flipWorkerRosterEntriesInactive(worker: WorkerFixture): void;
	seedRosterLedger(): Promise<void>;
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

function rosterDelta(entries: WorkerRosterEntry[], removedAgentIds?: string[]): Buffer {
	return Buffer.from(
		JSON.stringify({ type: "roster_delta", entries, ...(removedAgentIds ? { removedAgentIds } : {}) }),
	);
}

describe("supervisor roster ledger", () => {
	it("classifies at write, labels queued children, and merges them into their session row", () => {
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

		let listed = supervisor.handleList({}, { type: "list" });
		expect(listed.data?.sessions.map((session) => session.sessionId)).toEqual(["child-1"]);
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

		listed = supervisor.handleList({}, { type: "list" });
		expect(listed.data?.sessions).toHaveLength(1);
		expect(listed.data?.sessions[0]).toMatchObject({ activeSessionId: "child-active", workerState: "ready" });
		expect(supervisor.workerRosterEntries(worker)[0]).toMatchObject({ status: "running" });
		expect(supervisor.workerRosterEntries(worker)[0]?.statusLabel).toBeUndefined();
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
});
