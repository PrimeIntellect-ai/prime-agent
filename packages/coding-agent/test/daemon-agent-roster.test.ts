import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
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

// --- Worker-side roster reporter (daemon-mode) ---

interface WorkerReporterFixture {
	daemon: {
		sessions: Map<string, ActiveSessionState>;
		observeRosterEvent(state: ActiveSessionState, message: unknown): void;
		flushRoster(): void;
		rosterReporter: {
			lastComposed: Map<string, WorkerRosterEntry>;
			lastComposedJson: Map<string, string>;
			queuedChildren: Map<string, WorkerRosterEntry>;
			removedAgentIds: Map<string, string | undefined>;
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
		cronStore: { list: () => [], cancelJobsForSession: () => [] },
		summarizer: { forget: () => {} },
		acpMcpOwners: new Map(),
		rosterReporter: {
			lastComposed: new Map<string, WorkerRosterEntry>(),
			lastComposedJson: new Map<string, string>(),
			queuedChildren: new Map<string, WorkerRosterEntry>(),
			removedAgentIds: new Map<string, string | undefined>(),
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
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		runtime: {
			dispose: async () => {},
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
					appendSessionState: () => {},
				},
				messages: options.messages ?? [],
				getRlmChildSnapshots: () => [],
				hasRunningRlmChildren: () => false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 0,
				abort: async () => {},
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
		expect(sentDeltas[0]?.entries.find((entry) => entry.agentId === "parent-active#child-1")).toMatchObject({
			queuedChild: true,
			summary: { runtimeKind: "subagent", parentActiveSessionId: "parent-active", firstMessage: "review the API" },
		});

		// The same child id from a second parent stays a distinct row, qualified by parent path
		// (or by the live parent id when a no-session parent has no path).
		expect(
			workerRosterEntryFromSummary(
				summary({
					id: "c",
					sessionId: "c",
					runtimeKind: "subagent",
					rlmChildId: "c",
					parentActiveSessionId: "pa-1",
				}),
			).agentId,
		).not.toBe(
			workerRosterEntryFromSummary(
				summary({
					id: "c",
					sessionId: "c",
					runtimeKind: "subagent",
					rlmChildId: "c",
					parentActiveSessionId: "pa-2",
				}),
			).agentId,
		);
		const parentB = makeState({ activeSessionId: "parent-b", sessionFile: "/tmp/parents/b.jsonl" });
		daemon.sessions.set(parentB.activeSessionId, parentB);
		daemon.observeRosterEvent(
			parentB,
			childUpdate(parentB, { id: "child-1", label: "b", status: "queued", sessionDir: "/tmp/b" }),
		);
		daemon.flushRoster();
		const collided = sentDeltas.at(-1)?.entries.find((entry) => entry.summary.rlmChildId === "child-1");
		expect(collided?.queuedChild).toBe(true);
		expect(collided?.agentId).not.toBe("parent-active#child-1");

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
		const merged = sentDeltas.at(-1)?.entries.filter((entry) => entry.agentId === "parent-active#child-1") ?? [];
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
		const superseded = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "parent-active#child-1");
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
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["parent-active#child-2"]);
		daemon.rosterReporter.snapshotPending = true;
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.snapshot).toBe(true);
		expect(sentDeltas.at(-1)?.entries.some((entry) => entry.agentId === "parent-active#child-2")).toBe(false);

		// Bind window: the child session registers before any rlm_child_update reports the bind.
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-3", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		const boundState = makeState({
			activeSessionId: "child-3-active",
			kind: "subagent",
			rlmChildId: "child-3",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(boundState.activeSessionId, boundState);
		daemon.flushRoster();
		const bound = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "parent-active#child-3");
		expect(bound?.queuedChild).toBeUndefined();
		expect(bound?.summary.activeSessionId).toBe("child-3-active");
		expect(daemon.rosterReporter.queuedChildren.has("parent-active#child-3")).toBe(false);
	});

	it("cancels pending removals for reincarnated ids but keeps the removed incarnation suppressed", () => {
		const { daemon, sentDeltas, connection } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);

		// A deletion while disconnected leaves the removal pending; the id is then reused by a new admission.
		connection.connected = false;
		daemon.rosterReporter.removedAgentIds.set("parent-active#child-1", "old-session");
		daemon.flushRoster();
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "again", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();
		connection.connected = true;
		daemon.flushRoster();
		const snapshot = sentDeltas.at(-1);
		expect(snapshot?.snapshot).toBe(true);
		expect(snapshot?.removedAgentIds).toBeUndefined();
		expect(
			snapshot?.entries.some((entry) => entry.agentId === "parent-active#child-1" && entry.queuedChild === true),
		).toBe(true);

		// The removed incarnation itself (same sessionId, mid-teardown) stays suppressed and never ghosts.
		daemon.rosterReporter.queuedChildren.clear();
		const dying = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-2",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(dying.activeSessionId, dying);
		daemon.flushRoster();
		daemon.rosterReporter.removedAgentIds.set("parent-active#child-2", "session-child-active");
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["parent-active#child-2"]);
		daemon.sessions.delete(dying.activeSessionId);
		daemon.flushRoster();
		expect(daemon.rosterReporter.lastComposed.has("parent-active#child-2")).toBe(false);
	});

	it("publishes a removal when an archived top-level close leaves the worker's list", async () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const state = makeState({
			activeSessionId: "root-active",
			sessionFile: "/tmp/sessions/root.jsonl",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(state.activeSessionId, state);
		daemon.flushRoster();

		await (
			daemon as unknown as {
				closeSessionOnce(
					state: ActiveSessionState,
					reason: string,
					waitForAbort: boolean,
					cascadeChildren: boolean,
					descendants: Set<ActiveSessionState>,
				): Promise<void>;
			}
		).closeSessionOnce(state, "killed", false, false, new Set());
		daemon.flushRoster();

		// Archived by the kill: no passivated ghost, the disk scan is the only remaining source.
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["session-root-active"]);
		expect(daemon.rosterReporter.lastComposed.has("session-root-active")).toBe(false);
	});

	it("flushes cron and model changes that have no session-event carrier", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-cron-flush-"));
		tempDirs.push(directory);
		const daemon = new AgentDaemon(join(directory, "worker.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			worker: { authenticationToken: "token" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		} as never);
		const state = makeState({
			activeSessionId: "root-active",
			sessionFile: join(directory, "sessions", "root.jsonl"),
		});
		Object.assign(state.runtime, { cwd: directory });
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			cronStore: { registerSessionArtifact(sessionId: string, artifactDir: string): boolean };
			handleCommand(client: object, command: object): Promise<{ success: boolean; data?: { job?: { id: string } } }>;
			rosterReporter: { lastComposed: Map<string, WorkerRosterEntry> };
		};
		internals.cronStore.registerSessionArtifact("session-root-active", join(directory, "sessions", "root"));
		internals.sessions.set(state.activeSessionId, state);
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const added = await internals.handleCommand(client, {
			id: "cron-1",
			type: "cron_add",
			activeSessionId: "root-active",
			schedule: "every 1h",
			prompt: "check status",
		});
		expect(added.success).toBe(true);
		await new Promise((resolveSettle) => setImmediate(resolveSettle));
		const agentId = "session-root-active";
		expect(internals.rosterReporter.lastComposed.get(agentId)?.summary.hasRegisteredCronJob).toBe(true);

		const jobId = added.data?.job?.id;
		if (!jobId) throw new Error("cron_add returned no job id");
		await internals.handleCommand(client, {
			id: "cron-2",
			type: "cron_cancel",
			activeSessionId: "root-active",
			jobId,
		});
		await new Promise((resolveSettle) => setImmediate(resolveSettle));
		expect(internals.rosterReporter.lastComposed.get(agentId)?.summary.hasRegisteredCronJob).toBeUndefined();

		// set_model has no session-event carrier either; its explicit flush publishes the new model.
		const session = state.runtime.session as unknown as Record<string, unknown>;
		session.modelRegistry = { refreshAvailableModels: async () => [{ provider: "prov", id: "m2" }] };
		session.setModel = async (model: unknown) => {
			session.model = model;
		};
		await internals.handleCommand(client, {
			id: "model-1",
			type: "set_model",
			activeSessionId: "root-active",
			provider: "prov",
			modelId: "m2",
		});
		await new Promise((resolveSettle) => setImmediate(resolveSettle));
		expect(internals.rosterReporter.lastComposed.get(agentId)?.summary.model).toMatchObject({ id: "m2" });
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

		const reporter = daemon as unknown as { rosterFlushScheduled: boolean };
		for (const [type, scheduled] of [
			["tool_execution_start", true],
			["message_start", false],
		] as const) {
			reporter.rosterFlushScheduled = false;
			daemon.observeRosterEvent(state, {
				type: "session_event",
				activeSessionId: state.activeSessionId,
				event: { type },
			});
			expect(reporter.rosterFlushScheduled, type).toBe(scheduled);
		}

		daemon.sessions.delete(state.activeSessionId);
		daemon.flushRoster();
		const flipped = sentDeltas.at(-1)?.entries[0];
		expect(flipped).toMatchObject({ summary: { id: "session-root-active", isSessionActive: false } });
		expect(flipped?.summary.activeSessionId).toBeUndefined();
		expect(sentDeltas.at(-1)?.removedAgentIds).toBeUndefined();
	});
});

// --- Supervisor-side roster ledger ---

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
		rootSessionId?: string;
		sessionFile?: string;
	};
	client?: { request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
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

/** Real supervisor over a temp agent dir for offline (no-worker) command routes. */
function makeOfflineSupervisor(prefix: string, overrides: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	const sessionsDir = join(directory, "sessions");
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorFixture & {
		handleCommand(client: object, command: object): Promise<unknown>;
		rlmSpawnLedger(): RlmSpawnLedger;
	};
	Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) }, ...overrides });
	return { directory, sessionsDir, supervisor };
}

function offlineClient() {
	return { id: "client", attachedActiveSessionIds: new Set<string>() };
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

		// Queued child rows stay ledger-internal until their session materializes.
		{
			const queuedWorker = makeWorker("worker-q");
			const queuedSupervisor = makeSupervisor([queuedWorker]);
			queuedSupervisor.consumeWorkerRosterDelta(
				queuedWorker,
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
			expect((await queuedSupervisor.handleList({}, { type: "list" })).data?.sessions).toEqual([]);
			expect((await queuedSupervisor.handleList({}, { type: "list", all: true })).data?.sessions).toEqual([]);
			expect(queuedSupervisor.workerRosterEntries(queuedWorker)[0]).toMatchObject({
				status: "running",
				statusLabel: "queued",
			});
		}
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

	it("drops a client-owned worker's rows on unregistration instead of leaking public inactive rows", async () => {
		const owned = makeWorker("w-owned");
		Object.assign(owned.descriptor, { ownerClientId: "owner-client" });
		const supervisor = makeSupervisor([owned], { catalog: { list: vi.fn(async () => []) } });
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "o-active",
					sessionId: "o",
					activeSessionId: "o-active",
					sessionFile: "/tmp/sessions/owned.jsonl",
				}),
			),
			owned,
		);
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "oc",
					sessionId: "oc",
					sessionFile: "/tmp/artifacts/oc.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "oc",
					parentSessionPath: "/tmp/sessions/owned.jsonl",
				}),
			),
			owned,
		);

		supervisor.flipWorkerRosterEntriesInactive(owned);
		supervisor.workers.delete("w-owned");

		expect([...supervisor.roster().values()]).toHaveLength(0);
		const listed = await supervisor.handleList(
			{ id: "intruder", attachedActiveSessionIds: new Set<string>() },
			{ type: "list", all: true },
		);
		expect(listed.data?.sessions).toEqual([]);

		// An unowned worker flips resident rows passivated and removes queued rows outright.
		{
			const worker = makeWorker("worker-1");
			const supervisor = makeSupervisor([worker]);
			supervisor.writeRosterEntry(
				workerRosterEntryFromSummary(summary({ id: "r-active", sessionId: "r", activeSessionId: "r-active" })),
				worker,
			);
			supervisor.consumeWorkerRosterDelta(
				worker,
				rosterDelta([
					{
						agentId: "queued-child",
						queuedChild: true,
						summary: summary({ id: "queued-child", sessionId: "queued-child", runtimeKind: "subagent" }),
					},
				]),
			);
			expect(supervisor.roster().has("queued-child")).toBe(true);

			supervisor.flipWorkerRosterEntriesInactive(worker);

			// A terminal unbound child run owns no transcript: removal, never a fileless inactive ghost.
			expect(supervisor.roster().has("queued-child")).toBe(false);
			expect(supervisor.roster().get("r")).toMatchObject({ status: "inactive" });
			expect(supervisor.roster().get("r")?.workerId).toBeUndefined();
		}
	});

	it("seeds catalog and ledger rows list-all-only, serves resident worker rows, and keeps evicted rows inactive", async () => {
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

		// A live worker's rows: the active root and its passivated child are resident; seeded rows stay list-all-only.
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
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "child-session",
					sessionId: "child-session",
					sessionFile: join(directory, "artifacts", "passive-child.jsonl"),
					runtimeKind: "subagent",
					rlmChildId: "passive-child",
				}),
			),
			worker,
		);
		const resident = await supervisor.handleList({}, { type: "list" });
		expect(resident.data?.sessions.map((session) => session.sessionId).sort()).toEqual(["child-session", "evicted"]);
		const passiveChild = resident.data?.sessions.find((session) => session.rlmChildId === "passive-child");
		expect(passiveChild).toMatchObject({ workerPid: 1234 });
		expect(passiveChild?.activeSessionId).toBeUndefined();

		// One list-all serves resident worker rows and workerless seeded rows side by side.
		const liveAll = await supervisor.handleList({}, { type: "list", all: true });
		expect(liveAll.data?.sessions.map((session) => session.sessionId).sort()).toEqual([
			"child-session",
			"evicted",
			"live-child",
			"saved-root",
		]);
		expect(liveAll.data?.sessions.some((session) => session.sessionId === "deleted-child")).toBe(false);

		// Eviction leaves the worker's rows behind as inactive instead of dropping them.
		supervisor.workers.delete("worker-1");
		supervisor.flipWorkerRosterEntriesInactive(worker);

		const afterEvict = await supervisor.handleList({}, { type: "list", all: true });
		const evicted = afterEvict.data?.sessions.find((session) => session.sessionId === "evicted");
		expect(evicted).toBeDefined();
		expect(evicted?.activeSessionId).toBeUndefined();
		expect((await supervisor.handleList({}, { type: "list" })).data?.sessions).toEqual([]);
		expect(afterEvict.data?.sessions.some((session) => session.sessionId === "deleted-child")).toBe(false);
	});

	it("removes the roster row on offline deletes, tombstones subagents, and never reseeds them", async () => {
		const { directory, sessionsDir, supervisor } = makeOfflineSupervisor("prime-roster-offline-delete-", {
			catalog: { delete: vi.fn(async () => ({ ok: true, method: "unlink" })), list: vi.fn(async () => []) },
		});
		const parentPath = join(sessionsDir, "root.jsonl");
		const childPath = join(directory, "artifacts", "child.jsonl");
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

		await supervisor.handleCommand(offlineClient(), { type: "delete_saved_session", sessionPath: childPath });

		expect(supervisor.roster().has(childEntry.agentId)).toBe(false);
		await expect(supervisor.rlmSpawnLedger().edges()).resolves.toEqual([]);

		// A fresh supervisor over the same agent dir must not reseed the tombstoned child.
		const reseeded = makeSupervisor([], {
			rlmSpawnLedger: () => supervisor.rlmSpawnLedger(),
			catalog: { list: vi.fn(async () => []) },
		});
		await reseeded.seedRosterLedger();
		expect([...reseeded.roster().values()]).toEqual([]);

		// An offline rename updates the row in place.
		{
			const { directory, supervisor } = makeOfflineSupervisor("prime-roster-offline-rename-");
			const sessionPath = join(directory, "saved.jsonl");
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

			await supervisor.handleCommand(offlineClient(), {
				type: "rename_saved_session",
				sessionPath,
				name: "new-name",
			});

			expect(supervisor.roster().get("saved-1")?.summary.sessionName).toBe("new-name");
		}

		// A delete that fails on disk keeps the row.
		{
			const { directory, supervisor } = makeOfflineSupervisor("prime-roster-failed-delete-", {
				catalog: { delete: vi.fn(async () => ({ ok: false, error: "busy file" })), list: vi.fn(async () => []) },
			});
			const sessionPath = join(directory, "saved.jsonl");
			supervisor.writeRosterEntry(
				workerRosterEntryFromSummary(summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath })),
			);

			await supervisor.handleCommand(offlineClient(), { type: "delete_saved_session", sessionPath });

			expect(supervisor.roster().has("saved-1")).toBe(true);
		}
	});
});

describe("saved-session delete paths", () => {
	it("routes offline deletes by owner reachability: forward, retryable reject, or reclaim", async () => {
		const reachableRoster = makeWorker("w-roster");
		Object.assign(reachableRoster.descriptor, { createCommand: { type: "create" } });
		reachableRoster.client = {
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
		const supervisor = makeSupervisor([reachableRoster, unreachable, failed], {
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

	it("rejects a foreign client's delete of a client-owned worker's passivated session as unknown", async () => {
		const owned = makeWorker("w-owned");
		Object.assign(owned.descriptor, {
			ownerClientId: "owner-client",
			sessionFile: "/tmp/owned-private.jsonl",
			createCommand: { type: "create" },
		});
		owned.client = {
			request: vi.fn(async () => ({ type: "response", command: "delete_saved_session", success: true })),
		};
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const supervisor = makeSupervisor([owned], {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
			protocolClientIds: new Map(),
			rlmSpawnLedger: () => ({ edges: vi.fn(async () => []) }),
		});
		const internals = supervisor as unknown as { handleCommand(client: object, command: object): Promise<unknown> };

		await expect(
			internals.handleCommand(
				{ id: "intruder", attachedActiveSessionIds: new Set<string>() },
				{ type: "delete_saved_session", sessionPath: "/tmp/owned-private.jsonl" },
			),
		).rejects.toThrow("Unknown active session: /tmp/owned-private.jsonl");
		expect(owned.client.request).not.toHaveBeenCalled();
		expect(catalogDelete).not.toHaveBeenCalled();

		// The owning client still routes the delete through its own worker.
		await internals.handleCommand(
			{ id: "owner-client", attachedActiveSessionIds: new Set<string>() },
			{ type: "delete_saved_session", sessionPath: "/tmp/owned-private.jsonl" },
		);
		expect(owned.client.request).toHaveBeenCalled();
	});

	it("keeps a row rewritten during the delete's own await", async () => {
		const { directory, supervisor } = makeOfflineSupervisor("prime-roster-delete-race-");
		const sessionPath = join(directory, "saved.jsonl");
		const stale = supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath })),
		);
		Object.assign(supervisor, {
			catalog: {
				delete: vi.fn(async () => {
					// A frame rewrites the row while the unlink is in flight.
					supervisor.writeRosterEntry(
						workerRosterEntryFromSummary(
							summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath }),
						),
					);
					return { ok: true, method: "unlink" };
				}),
				list: vi.fn(async () => []),
			},
		});

		await supervisor.handleCommand(offlineClient(), { type: "delete_saved_session", sessionPath });

		expect(supervisor.roster().get("saved-1")).toBeDefined();
		expect(supervisor.roster().get("saved-1")).not.toBe(stale);
	});

	it("aborts a saved-child delete when the tombstone append fails", async () => {
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" }));
		const { directory, sessionsDir, supervisor } = makeOfflineSupervisor("prime-roster-tombstone-fail-", {
			catalog: { delete: catalogDelete, list: vi.fn(async () => []) },
		});
		const childPath = join(directory, "artifacts", "child.jsonl");
		Object.assign(supervisor, {
			rlmSpawnLedger: () => ({
				edges: vi.fn(async () => [
					{ childId: "child-1", child: childPath, parent: join(sessionsDir, "root.jsonl"), depth: 1, name: "c" },
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
				parentSessionPath: join(sessionsDir, "root.jsonl"),
			}),
		);
		supervisor.writeRosterEntry(childEntry);

		await expect(
			supervisor.handleCommand(offlineClient(), { type: "delete_saved_session", sessionPath: childPath }),
		).rejects.toThrow("ledger unwritable");
		expect(catalogDelete).not.toHaveBeenCalled();
		expect(supervisor.roster().has(childEntry.agentId)).toBe(true);
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

		// A client-owned worker's file: the live row stays private, the public scan lists it inactive.
		{
			const owned = makeWorker("w-owned");
			Object.assign(owned.descriptor, { ownerClientId: "owner-client", createCommand: { type: "create" } });
			const ownedPath = "/tmp/sessions/owned.jsonl";
			const supervisor = makeSupervisor([owned], {
				protocolClientIds: new Map(),
				catalog: {
					list: vi.fn(async () => [
						{
							id: "owned-session",
							path: ownedPath,
							cwd: "/tmp/project",
							created: new Date(0),
							modified: new Date(0),
							messageCount: 2,
							firstMessage: "private work",
							allMessagesText: "",
						},
					]),
				},
			});
			supervisor.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({
						id: "owned-active",
						sessionId: "owned-session",
						activeSessionId: "owned-active",
						sessionFile: ownedPath,
						isSessionActive: true,
					}),
				),
				owned,
			);

			const listed = await supervisor.handleList(
				{ id: "intruder", attachedActiveSessionIds: new Set<string>() },
				{ type: "list", all: true },
			);

			// The live row stays private; the public on-disk scan still lists the file as inactive.
			expect(listed.data?.sessions).toHaveLength(1);
			expect(listed.data?.sessions[0]).toMatchObject({ sessionId: "owned-session" });
			expect(listed.data?.sessions[0]?.activeSessionId).toBeUndefined();
			expect(listed.data?.sessions[0]?.workerPid).toBeUndefined();
		}
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
			messageCount: 4,
			lastActivityAt: "2026-08-01T10:00:00.000Z",
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

		const restored = supervisor.roster().get(childEntry.agentId);
		expect(restored?.workerId).toBe("worker-1");
		// The reseed and queued fill keep the hydrated summary: no synthetic seed, no NaN eviction pin.
		expect(restored?.summary.cwd).toBe("/tmp/project");
		expect(restored?.summary.lastActivityAt).toBe("2026-08-01T10:00:00.000Z");
		expect(restored?.summary.messageCount).toBe(4);
		expect(restored?.seededCwd).toBeUndefined();
	});

	it("keeps passive rows and repairs by pull when a snapshot's ledger pre-read fails", async () => {
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { createCommand: { type: "create" } });
		const refreshWorkerSummaries = vi.fn(async () => {});
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries,
			rlmSpawnLedger: () => ({
				edges: vi.fn(async () => {
					throw new Error("ledger unreadable");
				}),
			}),
		});
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({
					id: "p-session",
					sessionId: "p-session",
					sessionFile: "/tmp/artifacts/p.jsonl",
					runtimeKind: "subagent",
					rlmChildId: "p",
					parentSessionPath: "/tmp/sessions/root.jsonl",
				}),
			),
			worker,
		);
		const root = summary({ id: "worker-1-root-active", sessionId: "root", activeSessionId: "worker-1-root-active" });

		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([workerRosterEntryFromSummary(root)], undefined, true));
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		// Without readable edges the absentee sweep cannot run; the passive child survives, claimed.
		const passiveRow = [...supervisor.roster().values()].find((entry) => entry.summary.rlmChildId === "p");
		expect(passiveRow?.workerId).toBe("worker-1");
		expect(supervisor.roster().get("root")?.workerId).toBe("worker-1");
		expect(refreshWorkerSummaries).toHaveBeenCalledTimes(1);
	});

	it("aborts queued roster applies when the worker stops during the snapshot ledger pre-read", async () => {
		const worker = makeWorker("worker-1");
		const root = summary({
			id: "worker-1-root-active",
			sessionId: "root",
			activeSessionId: "worker-1-root-active",
			sessionFile: "/tmp/sessions/root.jsonl",
		});
		const rootEntry = workerRosterEntryFromSummary(root);
		let releaseEdges: (edges: unknown[]) => void = () => {};
		const edgesPromise = new Promise<unknown[]>((resolveEdges) => {
			releaseEdges = resolveEdges;
		});
		const supervisor = makeSupervisor([worker], { rlmSpawnLedger: () => ({ edges: () => edgesPromise }) });
		supervisor.writeRosterEntry(rootEntry, worker);

		// The snapshot apply starts and blocks on the ledger pre-read; a delta queues behind it.
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([rootEntry], undefined, true));
		await Promise.resolve();
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([rootEntry]));
		// The stop lands mid pre-read: registration gone, rows flipped inactive.
		supervisor.workers.delete("worker-1");
		supervisor.flipWorkerRosterEntriesInactive(worker);
		releaseEdges([]);
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		const entry = supervisor.roster().get(rootEntry.agentId);
		expect(entry?.workerId).toBeUndefined();
		expect(entry?.summary.activeSessionId).toBeUndefined();

		// A socket close (registration intact) equally stales queued applies: recovering labels survive.
		const closed = makeWorker("worker-2");
		const closedEntry = workerRosterEntryFromSummary(
			summary({ id: "worker-2-root-active", sessionId: "root-2", activeSessionId: "worker-2-root-active" }),
		);
		let releaseClosedEdges: (edges: unknown[]) => void = () => {};
		const closedSupervisor = makeSupervisor([closed], {
			rlmSpawnLedger: () => ({
				edges: () =>
					new Promise<unknown[]>((resolveEdges) => {
						releaseClosedEdges = resolveEdges;
					}),
			}),
		});
		closedSupervisor.writeRosterEntry(closedEntry, closed);
		closedSupervisor.consumeWorkerRosterDelta(closed, rosterDelta([closedEntry], undefined, true));
		await closedSupervisor.handleWorkerClose(closed, closed.client as object, new Error("worker died"));
		// A reconnect starts authenticating before the parked apply resumes; the apply's source is dead.
		(closed as unknown as { pendingClient: object }).pendingClient = {};
		releaseClosedEdges([]);
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		expect(closedSupervisor.workerRosterEntries(closed)[0]).toMatchObject({ statusLabel: "recovering" });

		// Unchained (fast-path) deltas obey the same currency rule.
		{
			const worker = makeWorker("worker-1");
			const supervisor = makeSupervisor([]);

			supervisor.consumeWorkerRosterDelta(
				worker,
				rosterDelta([
					workerRosterEntryFromSummary(summary({ id: "z-active", sessionId: "z", activeSessionId: "z-active" })),
				]),
			);

			expect(supervisor.roster().has("z")).toBe(false);
		}
	});

	it("repairs failed roster applies with one single-flight pull that never respawns itself", async () => {
		const worker = makeWorker("worker-1");
		let repairs = 0;
		const supervisor = makeSupervisor([worker], {
			applyWorkerRosterSnapshot: vi.fn(async () => {
				throw new Error("apply exploded");
			}),
			refreshWorkerSummaries: vi.fn(() => {
				repairs += 1;
				return new Promise<void>(() => {});
			}),
		});

		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], undefined, true));
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], undefined, true));
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], undefined, true));
		await new Promise((resolveSettle) => setImmediate(resolveSettle));
		expect(repairs).toBe(1);

		// A repair that itself fails logs the worker and does not spawn another pull.
		const failingWorker = makeWorker("worker-2");
		const log = vi.fn();
		const failingSupervisor = makeSupervisor([failingWorker], {
			applyWorkerRosterSnapshot: vi.fn(async () => {
				throw new Error("apply exploded");
			}),
			refreshWorkerSummaries: vi.fn(async () => {
				throw new Error("repair pull failed");
			}),
			log,
		});
		failingSupervisor.consumeWorkerRosterDelta(failingWorker, rosterDelta([], undefined, true));
		await new Promise((resolveSettle) => setImmediate(resolveSettle));
		expect(failingSupervisor.refreshWorkerSummaries).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Roster repair pull failed for worker worker-2"));
	});

	it.each([
		{ scenario: "live but unverifiable", verdicts: undefined },
		{ scenario: "current then unknown after the kill wait", verdicts: ["current", "unknown"] },
	])("keeps a pre-roster worker failed with no replacement when its identity is $scenario", async ({ verdicts }) => {
		const worker = makeWorker("worker-1");
		if (!verdicts) Object.assign(worker.descriptor, { pid: process.pid, processStartId: undefined });
		const launchWorker = vi.fn();
		const recoverUncertainWorkerOperations = vi.fn(async () => {});
		const supervisor = makeSupervisor([worker], {
			assertRecoveryAllowed: vi.fn(async () => {}),
			recoverUncertainWorkerOperations,
			launchWorker,
			...(verdicts
				? { processIdentity: vi.fn().mockReturnValueOnce(verdicts[0]).mockReturnValue(verdicts[1]) }
				: {}),
		});

		await (
			supervisor as unknown as {
				restartPreRosterWorker(worker: WorkerFixture, observedProcessStartId?: string): Promise<void>;
			}
		).restartPreRosterWorker(worker, verdicts ? "start-id-1" : undefined);

		if (!verdicts) expect(recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
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
			rosterReporter: { removedAgentIds: Map<string, string | undefined> };
		};
	}

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
		expect([...daemon.rosterReporter.removedAgentIds.keys()]).toEqual([manager.getSessionId()]);
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
			rosterReporter: { removedAgentIds: Map<string, string | undefined> };
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
		// The published removal id is parent-qualified, never the bare child id.
		expect([...daemonWithEdge.rosterReporter.removedAgentIds.keys()]).toEqual([expect.stringMatching(/#sub-9$/)]);

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
