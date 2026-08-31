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
		cronStore: { list: () => [] },
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

		// The same child id from a second parent stays a distinct row, qualified by parent path.
		const parentB = makeState({ activeSessionId: "parent-b", sessionFile: "/tmp/parents/b.jsonl" });
		daemon.sessions.set(parentB.activeSessionId, parentB);
		daemon.observeRosterEvent(
			parentB,
			childUpdate(parentB, { id: "child-1", label: "b", status: "queued", sessionDir: "/tmp/b" }),
		);
		daemon.flushRoster();
		const collided = sentDeltas.at(-1)?.entries.find((entry) => entry.summary.rlmChildId === "child-1");
		expect(collided?.queuedChild).toBe(true);
		expect(collided?.agentId).not.toBe("child-1");

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

	it("lets a composed session row beat a lingering queued marker during the bind window", () => {
		const { daemon, sentDeltas } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);
		daemon.observeRosterEvent(
			parent,
			childUpdate(parent, { id: "child-1", label: "task", status: "queued", sessionDir: "/tmp/c" }),
		);
		daemon.flushRoster();

		// The child session registers before any rlm_child_update reports the bind.
		const childState = makeState({
			activeSessionId: "child-active",
			kind: "subagent",
			rlmChildId: "child-1",
			parentActiveSessionId: "parent-active",
			messages: [{ role: "user", content: "hi" } as unknown as AgentMessage],
		});
		daemon.sessions.set(childState.activeSessionId, childState);
		daemon.flushRoster();

		const row = sentDeltas.at(-1)?.entries.find((entry) => entry.agentId === "child-1");
		expect(row?.queuedChild).toBeUndefined();
		expect(row?.summary.activeSessionId).toBe("child-active");
		expect(daemon.rosterReporter.queuedChildren.size).toBe(0);
	});

	it("cancels pending removals for reincarnated ids but keeps the removed incarnation suppressed", () => {
		const { daemon, sentDeltas, connection } = makeWorkerReporter();
		const parent = makeState({ activeSessionId: "parent-active" });
		daemon.sessions.set(parent.activeSessionId, parent);

		// A deletion while disconnected leaves the removal pending; the id is then reused by a new admission.
		connection.connected = false;
		daemon.rosterReporter.removedAgentIds.set("child-1", "old-session");
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
		expect(snapshot?.entries.some((entry) => entry.agentId === "child-1" && entry.queuedChild === true)).toBe(true);

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
		daemon.rosterReporter.removedAgentIds.set("child-2", "session-child-active");
		daemon.flushRoster();
		expect(sentDeltas.at(-1)?.removedAgentIds).toEqual(["child-2"]);
		daemon.sessions.delete(dying.activeSessionId);
		daemon.flushRoster();
		expect(daemon.rosterReporter.lastComposed.has("child-2")).toBe(false);
	});

	it("flushes hasRegisteredCronJob on cron_add and cron_cancel without any session event", async () => {
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
	});

	it("schedules a republish for retry and tool-execution transitions", () => {
		const { daemon } = makeWorkerReporter();
		const state = makeState({ activeSessionId: "root-active" });
		daemon.sessions.set(state.activeSessionId, state);
		const reporter = daemon as unknown as { rosterFlushScheduled: boolean };
		for (const type of ["auto_retry_start", "auto_retry_end", "tool_execution_start", "tool_execution_end"]) {
			reporter.rosterFlushScheduled = false;
			daemon.observeRosterEvent(state, {
				type: "session_event",
				activeSessionId: state.activeSessionId,
				event: { type },
			});
			expect(reporter.rosterFlushScheduled, type).toBe(true);
		}
		// Events with no roster-visible field stay out of the trigger set.
		reporter.rosterFlushScheduled = false;
		daemon.observeRosterEvent(state, {
			type: "session_event",
			activeSessionId: state.activeSessionId,
			event: { type: "message_start" },
		});
		expect(reporter.rosterFlushScheduled).toBe(false);
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
				removedAgentIds: new Map([["deleted-agent", undefined]]),
				snapshotPending: false,
			},
			rosterFlushScheduled: false,
			shuttingDown: false,
			log: vi.fn(),
		}) as {
			flushRoster(): void;
			rosterReporter: { snapshotPending: boolean; removedAgentIds: Map<string, string | undefined> };
		};

		daemon.flushRoster();
		// The queued write IS delivered: nothing stays pending and only the claimed socket receives the write.
		expect(write).toHaveBeenCalledTimes(1);
		expect(oldWrite).not.toHaveBeenCalled();
		expect(daemon.rosterReporter.snapshotPending).toBe(false);
		expect(daemon.rosterReporter.removedAgentIds.size).toBe(0);

		// A destroyed claim socket is an actual loss gap: the change marks one pending snapshot.
		client.socket.destroyed = true;
		daemon.rosterReporter.removedAgentIds.set("lost-agent", undefined);
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

		// A published removal drops the row from the ledger.
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([], ["child-1"]));
		expect(supervisor.roster().has("child-1")).toBe(false);
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
	});

	it("removes queued rows on worker unregistration instead of passivating unlistable ghosts", () => {
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
	});

	it("never clobbers a row rebound while its seeded header read was in flight", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-hydrate-race-"));
		tempDirs.push(directory);
		const manager = SessionManager.create(directory, join(directory, "artifacts"));
		manager.appendMessage({ role: "user", content: "child fixture", timestamp: 1 });
		manager.flushNow();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const supervisor = makeSupervisor([]);
		const stale = supervisor.writeRosterEntry({
			agentId: "raced",
			seededCwd: true,
			summary: summary({ id: "raced", sessionId: "raced", sessionFile, cwd: join(directory, "artifacts") }),
		});
		// A frame rebinds the agentId while the header read would be in flight.
		const live = supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(
				summary({ id: "raced", sessionId: "raced", activeSessionId: "raced-active", sessionFile }),
			),
		);

		const internals = supervisor as unknown as {
			hydrateSeededEntry(entry: AgentRosterEntry): Promise<AgentRosterEntry>;
		};
		const hydrated = await internals.hydrateSeededEntry(stale);

		expect(hydrated).toBe(live);
		expect(supervisor.roster().get("raced")).toBe(live);
		expect(supervisor.roster().get("raced")?.summary.activeSessionId).toBe("raced-active");
	});

	it("lists a client-owned worker's file as a plain inactive row for other clients", async () => {
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
	});

	it("keeps claimed passive children in the non-all list across snapshots that omit them", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-claim-stability-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const parentPath = join(sessionsDir, "root.jsonl");
		const childPath = join(directory, "artifacts", "p.jsonl");
		await ledger.appendSpawn({ childId: "p", parent: parentPath, child: childPath, depth: 1, name: "p" });
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { createCommand: { type: "create" } });
		const supervisor = makeSupervisor([worker], { rlmSpawnLedger: () => ledger });
		const root = summary({ id: "worker-1-root-active", sessionId: "root", activeSessionId: "worker-1-root-active" });
		const passive = summary({
			id: "p-session",
			sessionId: "p-session",
			sessionFile: childPath,
			runtimeKind: "subagent",
			rlmChildId: "p",
			parentSessionPath: parentPath,
			messageCount: 4,
			lastActivityAt: "2026-08-01T10:00:00.000Z",
		});
		worker.summaries.set("worker-1-root-active", root);
		worker.summaries.set("p-session", passive);
		(
			supervisor as unknown as { syncRosterFromWorkerSummaries(worker: WorkerFixture): void }
		).syncRosterFromWorkerSummaries(worker);

		// A snapshot composes only live sessions; the passive registry child must not flap off the worker.
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([workerRosterEntryFromSummary(root)], undefined, true));
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		const passiveRow = [...supervisor.roster().values()].find((entry) => entry.summary.rlmChildId === "p");
		expect(passiveRow?.workerId).toBe("worker-1");
		// The reseed keeps the hydrated summary: a synthetic seed would drop lastActivityAt (NaN pins
		// canEvictWorker false forever) and degrade list output to messageCount 0 with a synthetic cwd.
		expect(passiveRow?.summary.lastActivityAt).toBe("2026-08-01T10:00:00.000Z");
		expect(passiveRow?.summary.messageCount).toBe(4);
		expect(passiveRow?.summary.cwd).toBe("/tmp/project");
		expect(passiveRow?.seededCwd).toBeUndefined();
		const listed = await supervisor.handleList({}, { type: "list" });
		expect(listed.data?.sessions.map((session) => session.sessionId).sort()).toEqual([
			passiveRow?.summary.sessionId,
			"root",
		]);
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

		await supervisor.handleCommand(offlineClient(), { type: "rename_saved_session", sessionPath, name: "new-name" });

		expect(supervisor.roster().get("saved-1")?.summary.sessionName).toBe("new-name");
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
	});
});

describe("saved-session delete paths", () => {
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

	it("keeps the roster row when a delete fails on disk", async () => {
		const { directory, supervisor } = makeOfflineSupervisor("prime-roster-failed-delete-", {
			catalog: { delete: vi.fn(async () => ({ ok: false, error: "busy file" })), list: vi.fn(async () => []) },
		});
		const sessionPath = join(directory, "saved.jsonl");
		supervisor.writeRosterEntry(
			workerRosterEntryFromSummary(summary({ id: "saved-1", sessionId: "saved-1", sessionFile: sessionPath })),
		);

		await supervisor.handleCommand(offlineClient(), { type: "delete_saved_session", sessionPath });

		expect(supervisor.roster().has("saved-1")).toBe(true);
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
	});

	it("trusts frames only from the current and in-flight replacement connections", () => {
		const worker = makeWorker("worker-1");
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

	it("keeps frame-updated root pointers when a stale summaries pull lands", async () => {
		const worker = makeWorker("worker-1");
		Object.assign(worker.descriptor, { createCommand: { type: "create" } });
		let releaseList: (response: unknown) => void = () => {};
		worker.client = {
			request: vi.fn(
				() =>
					new Promise((resolveList) => {
						releaseList = resolveList;
					}),
			),
		};
		const supervisor = makeSupervisor([worker], {
			refreshWorkerSummaries: DaemonSupervisor.prototype["refreshWorkerSummaries" as never],
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
		});
		const staleRoot = summary({
			id: "worker-1-root-active",
			sessionId: "root",
			activeSessionId: "worker-1-root-active",
			sessionFile: "/tmp/sessions/old.jsonl",
		});
		const freshRoot = { ...staleRoot, sessionFile: "/tmp/sessions/new.jsonl" };

		const refresh = (
			supervisor as unknown as { refreshWorkerSummaries(worker: WorkerFixture, recovery: boolean): Promise<void> }
		).refreshWorkerSummaries(worker, false);
		// A frame updates the root pointers while the pull is still in flight.
		supervisor.consumeWorkerRosterDelta(worker, rosterDelta([workerRosterEntryFromSummary(freshRoot)]));
		expect(worker.descriptor.sessionFile).toBe("/tmp/sessions/new.jsonl");
		releaseList({ type: "response", command: "list", success: true, data: { sessions: [staleRoot] } });
		await refresh;

		expect(worker.descriptor.sessionFile).toBe("/tmp/sessions/new.jsonl");
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

		const restored = supervisor.roster().get(childEntry.agentId);
		expect(restored?.workerId).toBe("worker-1");
		// The queued fill also replaced the synthetic ledger seed with the pulled summary.
		expect(restored?.summary.cwd).toBe("/tmp/project");
		expect(restored?.seededCwd).toBeUndefined();
	});

	it("drops unchained deltas from an unregistered worker registration", () => {
		const worker = makeWorker("worker-1");
		const supervisor = makeSupervisor([]);

		supervisor.consumeWorkerRosterDelta(
			worker,
			rosterDelta([
				workerRosterEntryFromSummary(summary({ id: "z-active", sessionId: "z", activeSessionId: "z-active" })),
			]),
		);

		expect(supervisor.roster().has("z")).toBe(false);
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
		releaseClosedEdges([]);
		await new Promise((resolveSettle) => setImmediate(resolveSettle));

		expect(closedSupervisor.workerRosterEntries(closed)[0]).toMatchObject({ statusLabel: "recovering" });
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
			removedAgentIds: new Map<string, string | undefined>(),
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
		const worker = makeWorker("worker-1");
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
			rosterReporter: { removedAgentIds: Map<string, string | undefined> };
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
