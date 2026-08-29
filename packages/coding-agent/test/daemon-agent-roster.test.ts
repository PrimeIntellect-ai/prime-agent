import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
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
			lastComposed: Map<string, WorkerRosterEntry>;
			lastComposedJson: Map<string, string>;
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
			lastComposed: new Map<string, WorkerRosterEntry>(),
			lastComposedJson: new Map<string, string>(),
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
	it("carries an admitted run from queued through bind, late updates, supersede, and terminal-unbound removal", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);

		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "review the API", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		expect(sentDeltas[0]?.entries.find((entry) => entry.agentId === "child-1")).toMatchObject({
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

		// Crafted without activeSessionId: the lifecycle guard, not event stamping, must reject the late update.
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.sessions.delete(childState.activeSessionId);
		daemon.flushRoster();
		const superseded = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "child-1");
		expect(superseded?.queuedChild).toBeUndefined();
		expect(superseded?.summary.id).toBe("session-child-active");
		expect(superseded?.summary.activeSessionId).toBeUndefined();

		// A run that terminates before binding is a removal, never a passivated phantom.
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-2", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-2", label: "task", status: "cancelled", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["child-2"]);
		daemon.rosterReporter.snapshotPending = true;
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.snapshot).toBe(true);
		expect(sentDeltas.at(-1)?.entries.some((entry) => entry.agentId === "child-2")).toBe(false);
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

	it("escalates undelivered changes to one replacing snapshot", () => {
		const { daemon, sentDeltas, connection } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		const sentWhileConnected = sentDeltas.length;

		// The channel drops; the child binds and dies while disconnected.
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
		expect(sentDeltas.length).toBe(sentWhileConnected);
		expect(daemon.rosterReporter.snapshotPending).toBe(true);
		daemon.sessions.delete(childState.activeSessionId);
		daemon.flushRoster();

		// Reauthentication: one full replacing snapshot carries the durable row; absence conveys removals.
		connection.connected = true;
		daemon.flushRoster();
		expect(sentDeltas.length).toBe(sentWhileConnected + 1);
		const snapshot = sentDeltas.at(-1);
		expect(snapshot?.snapshot).toBe(true);
		expect(snapshot?.removedAgentIds).toBeUndefined();
		const childRow = snapshot?.entries.find((entry) => entry.agentId === "child-1");
		expect(childRow?.queuedChild).toBeUndefined();
		expect(childRow?.summary.id).toBe("session-child-active");
		expect(childRow?.summary.activeSessionId).toBeUndefined();

		daemon.flushRoster();
		expect(sentDeltas.length).toBe(sentWhileConnected + 1);
	});

	it("treats queued writes as delivered and snapshots only across loss gaps", () => {
		const written: Buffer[] = [];
		const write = vi.fn((chunk: Buffer) => {
			written.push(Buffer.from(chunk));
			// Backpressure: the frame is queued in the socket, not refused.
			return false;
		});
		const oldWrite = vi.fn(() => true);
		const oldClient = {
			transport: "private-framed",
			authenticated: true,
			backpressured: undefined as boolean | undefined,
			socket: { destroyed: false, write: oldWrite },
		};
		const client = {
			transport: "private-framed",
			authenticated: true,
			backpressured: undefined as boolean | undefined,
			socket: { destroyed: false, write },
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			sessions: new Map(),
			cronStore: { list: () => [] },
			clients: new Set([oldClient, client]),
			supervisorClaims: new Map([[client, {}]]),
			rosterReporter: {
				lastComposed: new Map(),
				lastComposedJson: new Map(),
				queuedChildren: new Map(),
				removedAgentIds: new Set(["deleted-agent"]),
				snapshotPending: false,
			},
			rosterFlushScheduled: false,
			shuttingDown: false,
			log: vi.fn(),
		}) as { flushRoster(): void; rosterReporter: { snapshotPending: boolean; removedAgentIds: Set<string> } };

		daemon.flushRoster();
		// The queued write IS delivered: nothing stays pending and only the claimed socket was written.
		expect(write).toHaveBeenCalledTimes(1);
		expect(oldWrite).not.toHaveBeenCalled();
		expect(daemon.rosterReporter.snapshotPending).toBe(false);
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(0);

		// A destroyed claim socket is an actual loss gap: the change marks one pending snapshot.
		client.socket.destroyed = true;
		daemon.rosterReporter.removedAgentIds.add("lost-agent");
		daemon.flushRoster();
		expect(write).toHaveBeenCalledTimes(1);
		expect(daemon.rosterReporter.snapshotPending).toBe(true);

		// The gap closes with one replacing snapshot; drains never resend queued frames.
		client.socket.destroyed = false;
		daemon.flushRoster();
		daemon.flushRoster();
		expect(write).toHaveBeenCalledTimes(2);
		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(Buffer.concat(written));
		const messages = frames.map((frame) => JSON.parse(frame.payload.toString("utf8")) as RosterDelta);
		expect(messages[1]?.snapshot).toBe(true);
		expect(messages[1]?.removedAgentIds).toEqual(["lost-agent"]);
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
		lifecycle: "ready" | "failed";
		processStartId?: string;
		lastError?: string;
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

	it("replaces a worker's rows from a snapshot, deletes absentees, and reseeds only live ledger edges", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-snapshot-reseed-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const parentPath = join(sessionsDir, "root.jsonl");
		const passivatedPath = join(directory, "artifacts", "passivated-child.jsonl");
		const deletedPath = join(directory, "artifacts", "deleted-child.jsonl");
		await ledger.appendSpawn({
			childId: "passivated-child",
			parent: parentPath,
			child: passivatedPath,
			depth: 1,
			name: "passivated",
		});
		await ledger.appendSpawn({
			childId: "deleted-child",
			parent: parentPath,
			child: deletedPath,
			depth: 1,
			name: "deleted",
		});
		await ledger.appendDelete({ childId: "deleted-child", child: deletedPath, reason: "user" });
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker], { rlmSpawnLedger: () => ledger });
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
					id: "passivated-child",
					sessionId: "passivated-child",
					sessionFile: passivatedPath,
					runtimeKind: "subagent",
					rlmChildId: "passivated-child",
					parentSessionPath: parentPath,
				}),
			),
			worker,
		);
		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta([
				{
					agentId: "sessionless",
					queuedChild: true,
					summary: summary({ id: "sessionless", sessionId: "sessionless", runtimeKind: "subagent" }),
				},
			]),
		);

		// The restarted worker's replacing snapshot names only the row it still holds.
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
		await vi.waitFor(() => expect(supervisor.roster().get("kept")).toMatchObject({ status: "running" }));
		expect(supervisor.roster().has("sessionless")).toBe(false);
		// The deleted-while-disconnected child stays out; the surviving one reseeds from its live edge.
		const entries = [...supervisor.roster().values()];
		const reseeded = entries.find((entry) => entry.summary.rlmChildId === "passivated-child");
		expect(reseeded).toBeDefined();
		expect(reseeded?.summary.activeSessionId).toBeUndefined();
		expect(entries.some((entry) => entry.summary.rlmChildId === "deleted-child")).toBe(false);
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

	it("seeds catalog and spawn-ledger rows, skips tombstones, and keeps evicted rows inactive", async () => {
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

		// A push-only view needs saved top-level rows in the ledger itself, not only in list-all rescans.
		expect(supervisor.roster().has("saved-root")).toBe(true);
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

describe("saved-session delete paths", () => {
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

	it("routes offline deletes by owner reachability: forward, retryable reject, or reclaim", async () => {
		const reachableRoster = makeWorker("w-roster");
		Object.assign(reachableRoster.descriptor, { createCommand: { type: "create" } });
		reachableRoster.client = {
			request: vi.fn(async () => ({ type: "response", command: "delete_saved_session", success: true })),
		};
		const reachableDescriptor = makeWorker("w-desc");
		Object.assign(reachableDescriptor.descriptor, {
			sessionFile: "/tmp/owned-desc.jsonl",
			createCommand: { type: "create" },
		});
		reachableDescriptor.client = {
			request: vi.fn(async () => ({ type: "response", command: "delete_saved_session", success: true })),
		};
		const unreachable = makeWorker("w-down");
		Object.assign(unreachable.descriptor, {
			sessionFile: "/tmp/owned-down.jsonl",
			createCommand: { type: "create" },
		});
		unreachable.client = undefined;
		const failed = makeWorker("w-failed");
		Object.assign(failed.descriptor, {
			sessionFile: "/tmp/owned-failed.jsonl",
			createCommand: { type: "create" },
			lifecycle: "failed",
		});
		failed.client = undefined;
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const reclaimStaleWorkerRegistration = vi.fn(
			async (worker: { descriptor: { lifecycle: string; workerId: string } }) => {
				if (worker.descriptor.lifecycle !== "failed") return false;
				supervisor.workers.delete(worker.descriptor.workerId);
				return true;
			},
		);
		const supervisor = makeSupervisor([reachableRoster, reachableDescriptor, unreachable, failed], {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
			reclaimStaleWorkerRegistration,
			rlmSpawnLedger: () => ({ edges: vi.fn(async () => []) }),
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "roster-owned",
					sessionId: "roster-owned",
					sessionFile: "/tmp/owned-roster.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "child-1",
				}),
			),
			reachableRoster,
		);
		const internals = supervisor as unknown as { handleCommand(client: object, command: object): Promise<unknown> };
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		// Roster and descriptor ownership both forward to a reachable owner instead of rejecting.
		await internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-roster.jsonl" });
		expect(reachableRoster.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "delete_saved_session", sessionPath: "/tmp/owned-roster.jsonl" }),
			expect.any(Number),
		);
		await internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-desc.jsonl" });
		expect(reachableDescriptor.client.request).toHaveBeenCalled();
		expect(catalogDelete).not.toHaveBeenCalled();

		// A live-but-disconnected owner rejects instead of deleting underneath the worker.
		await expect(
			internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-down.jsonl" }),
		).rejects.toThrow(/retry the delete/);
		expect(catalogDelete).not.toHaveBeenCalled();

		// A dead failed registration is reclaimed, then the offline delete proceeds.
		await internals.handleCommand(client, { type: "delete_saved_session", sessionPath: "/tmp/owned-failed.jsonl" });
		expect(reclaimStaleWorkerRegistration).toHaveBeenCalledWith(failed);
		expect(catalogDelete).toHaveBeenCalledWith("/tmp/owned-failed.jsonl");
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

describe("review-round regressions", () => {
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

	it("trusts frames only from the current and in-flight replacement connections", () => {
		const worker = makeWorker("worker-1", { rosterCapable: true });
		const supervisor = makeSupervisor([worker], {
			streamReconstructor: { observe: vi.fn(), seed: vi.fn(), clear: vi.fn() },
		});
		const frame = (sessionId: string) => ({
			header: { kind: "outbound", outboundType: "roster_delta" },
			payload: rosterDelta([workerRosterEntryFromSummary(summary({ id: sessionId, sessionId }))]),
		});
		const internals = supervisor as unknown as {
			handleWorkerFrame(w: object, f: object, source?: object): void;
		};
		const stale = { request: vi.fn() };
		const replacement = { request: vi.fn() };

		internals.handleWorkerFrame(worker, frame("ghost"), stale);
		expect(supervisor.roster().has("ghost")).toBe(false);

		(worker as unknown as { pendingClient?: object }).pendingClient = replacement;
		internals.handleWorkerFrame(worker, frame("mid-auth"), replacement);
		expect(supervisor.roster().has("mid-auth")).toBe(true);

		// Failed auth rolls the pending source back; its buffered frames are dropped.
		(worker as unknown as { pendingClient?: object }).pendingClient = undefined;
		internals.handleWorkerFrame(worker, frame("rolled-back"), replacement);
		expect(supervisor.roster().has("rolled-back")).toBe(false);
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

	it("publishes model and name changes to the supervisor", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-model-"));
		tempDirs.push(directory);
		const daemon = new AgentDaemon(join(directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
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
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: object): Promise<unknown>;
		};
		internals.clients.add(supervisorClient);
		internals.supervisorClaims.set(supervisorClient, {});
		const state = makeState({
			activeSessionId: "root-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		const session = state.runtime.session as unknown as Record<string, unknown>;
		session.model = { provider: "prov", id: "m1" };
		session.modelRegistry = {
			refreshAvailableModels: async () => [{ provider: "prov", id: "m2" }],
		};
		session.setModel = async (model: unknown) => {
			session.model = model;
		};
		internals.sessions.set(state.activeSessionId, state);

		const decodeDeltas = () =>
			new PrivateFrameDecoder(isDaemonWorkerFrameHeader)
				.push(Buffer.concat(written))
				.filter((frame) => frame.header.kind === "outbound" && frame.header.outboundType === "roster_delta")
				.map((frame) => JSON.parse(frame.payload.toString("utf8")) as RosterDelta);

		await internals.handleCommand(supervisorClient, {
			type: "set_model",
			activeSessionId: "root-active",
			provider: "prov",
			modelId: "m2",
		});
		await vi.waitFor(() => {
			const rows = decodeDeltas().flatMap((delta) => delta.entries);
			expect(rows.at(-1)?.summary.model).toMatchObject({ id: "m2" });
		});

		// Rename: the handler updates the session and the runtime's info event triggers the flush.
		session.setSessionName = (name: string) => {
			session.sessionName = name;
		};
		await internals.handleCommand(supervisorClient, {
			type: "rename",
			activeSessionId: "root-active",
			name: "renamed-by-worker",
		});
		(
			daemon as unknown as { observeRosterEvent(state: ActiveSessionState, message: unknown): void }
		).observeRosterEvent(state, {
			type: "session_event",
			activeSessionId: "root-active",
			event: { type: "session_info_changed", name: "renamed-by-worker" },
		});
		await vi.waitFor(() => {
			const rows = decodeDeltas().flatMap((delta) => delta.entries);
			expect(rows.at(-1)?.summary.sessionName).toBe("renamed-by-worker");
		});
	});

	it("re-claims rows a concurrent snapshot reseeds instead of leaving them workerless", async () => {
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { createCommand: { type: "create" } });
		const child = summary({
			id: "x-session",
			sessionId: "x-session",
			sessionFile: "/tmp/artifacts/x.jsonl",
			runtimeKind: "subagent",
			rlmChildId: "x",
			parentSessionPath: "/tmp/sessions/root.jsonl",
		});
		const childEntry = workerRosterEntryFromSummary(child);
		let releaseEdges: (edges: unknown[]) => void = () => {};
		const edgesPromise = new Promise<unknown[]>((resolveEdges) => {
			releaseEdges = resolveEdges;
		});
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
			rlmSpawnLedger: () => ({ edges: () => edgesPromise }),
		});
		supervisor.writeRosterEntry(childEntry, worker);
		const root = summary({ id: "worker-1-root-active", sessionId: "root", activeSessionId: "worker-1-root-active" });
		worker.client = {
			request: vi.fn(async () => ({
				type: "response",
				command: "list",
				success: true,
				data: { sessions: [root, child] },
			})),
		};

		// A snapshot without the child arrives while its spawn-ledger pre-read is still in flight.
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([workerRosterEntryFromSummary(root)], undefined, true));
		const refresh = (
			supervisor as unknown as {
				refreshWorkerSummaries(worker: WorkerFixture, recovery: boolean, fillGaps: boolean): Promise<void>;
			}
		).refreshWorkerSummaries(worker, false, true);
		releaseEdges([
			{ childId: "x", parent: "/tmp/sessions/root.jsonl", child: "/tmp/artifacts/x.jsonl", depth: 1, name: "x" },
		]);
		await refresh;
		// Settle any apply work a broken serialization would leave dangling past the pull.
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		expect(supervisor.roster().get(childEntry.agentId)?.workerId).toBe("worker-1");
	});

	it("keeps an unverifiable live pre-roster worker failed instead of launching a replacement", async () => {
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { pid: process.pid, processStartId: undefined });
		const launchWorker = vi.fn();
		const recoverUncertainWorkerOperations = vi.fn(async () => {});
		const supervisor = makeSupervisor([worker], {
			assertRecoveryAllowed: vi.fn(async () => {}),
			recoverUncertainWorkerOperations,
			launchWorker,
		});

		await (
			supervisor as unknown as {
				restartPreRosterWorker(worker: WorkerFixture, observedProcessStartId?: string): Promise<void>;
			}
		).restartPreRosterWorker(worker, undefined);

		expect(recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
		expect(launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
	});

	it("skips the gap fill when a roster frame lands mid-pull", async () => {
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { createCommand: { type: "create" } });
		const staleChild = summary({
			id: "x-session",
			sessionId: "x-session",
			sessionFile: "/tmp/artifacts/x.jsonl",
			runtimeKind: "subagent",
			rlmChildId: "x",
		});
		const staleEntry = workerRosterEntryFromSummary(staleChild);
		const supervisor = makeSupervisor([worker], {
			assertRecoveryAllowed: vi.fn(async () => {}),
			persistWorker: vi.fn(),
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		supervisor.writeRosterEntry(staleEntry, worker);
		const root = summary({ id: "worker-1-root-active", sessionId: "root", activeSessionId: "worker-1-root-active" });
		let pulls = 0;
		worker.client = {
			request: vi.fn(async () => {
				pulls += 1;
				// Every pull straddles a frame: deletions keep landing while stale responses still carry the child.
				supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], [staleEntry.agentId]));
				return { type: "response", command: "list", success: true, data: { sessions: [root, staleChild] } };
			}),
		};

		await (
			supervisor as unknown as { refreshWorkerSummaries(worker: WorkerFixture, recovery: boolean): Promise<void> }
		).refreshWorkerSummaries(worker, true);

		expect(pulls).toBe(2);
		expect(supervisor.roster().has(staleEntry.agentId)).toBe(false);
	});

	it("delivers one queued snapshot through a real backpressured worker socket", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-socket-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "worker.sock");
		const received: Buffer[] = [];
		let connected: (socket: import("node:net").Socket) => void = () => {};
		const connection = new Promise<import("node:net").Socket>((resolveSocket) => {
			connected = resolveSocket;
		});
		const server = createServer((socket) => {
			socket.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
			connected(socket);
		});
		await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
		const clientSocket = connect(socketPath);
		await new Promise<void>((resolveConnect) => clientSocket.once("connect", () => resolveConnect()));
		await connection;

		const client = { transport: "private-framed", authenticated: true, socket: clientSocket };
		const reporter = {
			lastComposed: new Map<string, WorkerRosterEntry>(),
			lastComposedJson: new Map<string, string>(),
			queuedChildren: new Map<string, WorkerRosterEntry>(),
			removedAgentIds: new Set<string>(),
			snapshotPending: true,
		};
		for (let index = 0; index < 3000; index++) {
			const entry: WorkerRosterEntry = {
				agentId: `child-${index}`,
				queuedChild: true,
				summary: summary({
					id: `child-${index}`,
					sessionId: `child-${index}`,
					runtimeKind: "subagent",
					rlmChildId: `child-${index}`,
					firstMessage: "x".repeat(512),
				}),
			};
			reporter.queuedChildren.set(entry.agentId, entry);
		}
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			sessions: new Map(),
			cronStore: { list: () => [] },
			clients: new Set([client]),
			supervisorClaims: new Map([[client, {}]]),
			rosterReporter: reporter,
			rosterFlushScheduled: false,
			shuttingDown: false,
			log: vi.fn(),
		}) as { flushRoster(): void };

		daemon.flushRoster();
		daemon.flushRoster();
		await vi.waitFor(() => {
			const frames = new PrivateFrameDecoder(isDaemonWorkerFrameHeader).push(Buffer.concat(received));
			expect(frames.length).toBeGreaterThan(0);
		});
		// One multi-megabyte snapshot: queued past the high-water mark, delivered once, never resent.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
		const frames = new PrivateFrameDecoder(isDaemonWorkerFrameHeader).push(Buffer.concat(received));
		expect(frames).toHaveLength(1);
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([worker], { rlmSpawnLedger: () => ({ edges: vi.fn(async () => []) }) });
		supervisor.consumeWorkerRosterDelta(worker, frames[0]?.payload as Buffer);
		await vi.waitFor(() => expect(supervisor.workerRosterEntries(worker)).toHaveLength(3000));
		clientSocket.destroy();
		server.close();
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
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		const internals = supervisor as unknown as {
			findWorker(selector: string): Promise<{ summary: SessionSummary }>;
		};

		const match = await internals.findWorker("target-active");
		expect(match.summary.sessionId).toBe("target");
	});

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
