/**
 * Reusable session-host core.
 *
 * The bookkeeping a process needs to host live `AgentSessionRuntime`s: the
 * active-session map, the bind/publish lifecycle of `addRuntime`, bound-state
 * lookup with lazy hydration, and worker roster composition. The daemon worker
 * owns this through `AgentDaemon`; the resident cloud guest daemon owns it
 * through `runCloudDaemonMode`. Both are the same session-host semantics over
 * the same `bindActiveSessionState` path - there is no second implementation
 * of the agent loop.
 *
 * Host-specific concerns stay behind callbacks: broadcasting to attached
 * clients, connection-state shaping, shutdown, subagent runtime hosting,
 * cron/summarizer integration, roster frame delivery, and RLM passive
 * hydration. Everything else is here.
 */

import { resolve } from "node:path";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentCronJob } from "../../core/cron-jobs.js";
import type { SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import type { AgentConnectionRlmChildAgentSnapshot, AgentConnectionState } from "../agent-connection/types.js";
import {
	type ActiveSessionState,
	AmbiguousActiveSessionError,
	createActiveSessionId,
	resolveActiveSessionState,
} from "../daemon/active-session-state.js";
import {
	passivatedWorkerRosterEntry,
	type RosterSessionSummary,
	rosterAgentIdForSummary,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../daemon/agent-roster.js";
import { bindActiveSessionState } from "../daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../daemon/daemon-protocol.js";
import { buildSessionList, scheduledJobRegistrations } from "../daemon/daemon-session-list.js";
import type { DaemonWorkerRosterOutbound } from "../daemon/daemon-worker-protocol.js";

/** A bound runtime that failed its opening guard; the runtime is disposed. */
export class RuntimeOpenCancelledError extends Error {
	constructor() {
		super("Runtime open was cancelled");
		this.name = "RuntimeOpenCancelledError";
	}
}

/** A session exists but is not yet targetable (still binding or closing). */
export class BoundSessionUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BoundSessionUnavailableError";
	}
}

/** Guard evaluated before and after runtime creation; false cancels the open. */
export type RuntimeOpenGuard = () => boolean | Promise<boolean>;

export interface SessionHostCoreCallbacks {
	/** Deliver one outbound message to the session's attached clients. */
	broadcast(state: ActiveSessionState, message: DaemonOutbound): void;
	/** Shape the connection state for attach snapshots. */
	createConnectionState(state: ActiveSessionState): AgentConnectionState;
	/** A live runtime was replaced in place (new/switch/fork/import). */
	sessionReplaced(state: ActiveSessionState): void;
	/** Host shutdown request (an extension asked for it). */
	shutdown(): void;
	/**
	 * The subagent runtime host for recursive children of this session, or
	 * undefined to use the runtime's own inline host (the guest daemon does
	 * this: its children are ordinary in-process subagent runtimes).
	 */
	createSubagentRuntimeHost(state: ActiveSessionState): SubagentRuntimeHost | undefined;
	/** Apply a session name before binding completes. */
	setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
	/** After binding is published: register host-owned per-state machinery. */
	onStateReleased(state: ActiveSessionState): void;
	/** True while the host is closing this session; closing sessions are unavailable. */
	isSessionClosing(activeSessionId: string): boolean;
	/** After the resident marking entry: summarize and record readiness. */
	onStateReady(state: ActiveSessionState): void;
}

/** Lazy hydration of passive (passivated or completed) RLM descendants. */
export interface SessionHostPassiveHooks<TCandidate = unknown> {
	/** Find a passive descendant by selector or session file. */
	findPassiveRlmSubagent(selector: string): Promise<TCandidate | undefined>;
	/** Hydrate a passive descendant into a live bound state. */
	hydratePassiveRlmSubagent(candidate: TCandidate, clientEnv?: Record<string, string>): Promise<ActiveSessionState>;
	/** A passivation promise for this session file, if one is in flight. */
	findPassivationBySessionFile(sessionFile: string): Promise<void> | undefined;
	/** Wait for the in-flight passivation of this session file. */
	waitForPassivation(sessionFile: string): Promise<void>;
}

export interface SessionHostRosterCallbacks {
	/** True when roster frames are reported at all (worker mode). */
	enabled(): boolean;
	isShuttingDown(): boolean;
	log(message: string): void;
	/** Scheduled jobs folded into passivated rows. */
	scheduledJobs(): readonly AgentCronJob[];
	/** True while a supervisor client can receive frames. */
	hasAuthenticatedSupervisorClient(): boolean;
	/** Deliver one composed roster frame; false means it was not delivered. */
	broadcastRosterFrame(message: DaemonWorkerRosterOutbound): boolean;
}

/** Roster reporter state shared by the composition and removal paths. */
export interface WorkerRosterReporterState {
	lastComposed: Map<string, WorkerRosterEntry>;
	lastComposedJson: Map<string, string>;
	queuedChildren: Map<string, WorkerRosterEntry>;
	/** Pending removals: agentId -> removed sessionId; a new incarnation of the id cancels it. */
	removedAgentIds: Map<string, string | undefined>;
	snapshotPending: boolean;
}

/** Session events that must refresh the composed roster. */
export const ROSTER_SESSION_EVENT_TRIGGERS = new Set([
	"turn_start",
	"turn_end",
	"bash_start",
	"bash_end",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"tool_execution_start",
	"tool_execution_end",
	"message_end",
	"session_action_update",
	"session_info_changed",
	"thinking_level_changed",
]);

export interface SessionHostCoreOptions<TPassive = unknown> {
	/** Worker restore: prefer this active session id for the next top-level add. */
	restoreActiveSessionId?: string;
	/** Restrict-then-delegate roster delivery; omit to disable roster frames. */
	roster?: SessionHostRosterCallbacks;
	/** Lazy hydration of passive descendants; omit to disable. */
	passive?: SessionHostPassiveHooks<TPassive>;
}

export class SessionHostCore<TPassive = unknown> {
	private readonly sessions = new Map<string, ActiveSessionState>();
	private readonly bindingSessions = new Set<string>();
	private readonly bindingCompletions = new Map<string, Promise<void>>();
	private restoreActiveSessionId: string | undefined;
	private readonly roster?: SessionHostRosterCallbacks;
	private readonly passive?: SessionHostPassiveHooks<TPassive>;
	private readonly rosterReporter: WorkerRosterReporterState = {
		lastComposed: new Map(),
		lastComposedJson: new Map(),
		queuedChildren: new Map(),
		removedAgentIds: new Map(),
		snapshotPending: false,
	};
	private rosterFlushScheduled = false;

	constructor(
		private readonly callbacks: SessionHostCoreCallbacks,
		options: SessionHostCoreOptions<TPassive> = {},
	) {
		this.restoreActiveSessionId = options.restoreActiveSessionId;
		this.roster = options.roster;
		this.passive = options.passive;
	}

	/** A future top-level add will reuse this active session id (worker restore). */
	setRestoreActiveSessionId(activeSessionId: string | undefined): void {
		this.restoreActiveSessionId = activeSessionId;
	}

	/** Live bound states by active session id. */
	values(): IterableIterator<ActiveSessionState> {
		return this.sessions.values();
	}

	/** The live session map itself; hosts mutate it only through addRuntime/dropState. */
	asMap(): Map<string, ActiveSessionState> {
		return this.sessions;
	}

	/** The in-binding session ids; a host must not target these. */
	bindingSet(): Set<string> {
		return this.bindingSessions;
	}

	get size(): number {
		return this.sessions.size;
	}

	get(id: string): ActiveSessionState | undefined {
		return this.sessions.get(id);
	}

	has(id: string): boolean {
		return this.sessions.has(id);
	}

	/** Delete a state from the map; the host owns disposal. */
	remove(id: string): boolean {
		return this.sessions.delete(id);
	}

	/** Composition/removal bookkeeping shared with the host's roster edges. */
	get reporter(): WorkerRosterReporterState {
		return this.rosterReporter;
	}

	isBinding(activeSessionId: string): boolean {
		return this.bindingSessions.has(activeSessionId);
	}

	/** Resolves when a binding session finishes binding, regardless of outcome. */
	bindingCompletion(activeSessionId: string): Promise<void> | undefined {
		return this.bindingCompletions.get(activeSessionId);
	}

	/**
	 * Bind one runtime as an active session: allocate the state, publish it to
	 * the map during binding (host controllers must see it), name it, bind
	 * extensions and event routing, then publish readiness. A bind failure
	 * disposes the runtime and unpublishes the state.
	 */
	async addRuntime(
		runtime: AgentSessionRuntime,
		name?: string,
		clientEnv?: Record<string, string>,
		onStateCreated?: (state: ActiveSessionState) => void,
		runtimeOpenGuard?: RuntimeOpenGuard,
		onStateBound?: (state: ActiveSessionState) => void,
		restoreActiveSessionId?: string,
	): Promise<ActiveSessionState> {
		const desiredActiveSessionId =
			runtime.metadata.kind === "top-level" ? this.restoreActiveSessionId : restoreActiveSessionId;
		if (runtime.metadata.kind === "top-level" && desiredActiveSessionId) {
			this.restoreActiveSessionId = undefined;
		}
		const state: ActiveSessionState = {
			activeSessionId:
				desiredActiveSessionId && !this.sessions.has(desiredActiveSessionId)
					? desiredActiveSessionId
					: createActiveSessionId(this.sessions),
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: createActiveSessionId(),
			lastEventSequence: 0,
			clientEnv,
		};
		this.sessions.set(state.activeSessionId, state);
		this.bindingSessions.add(state.activeSessionId);
		let completeBinding!: () => void;
		const bindingCompletion = new Promise<void>((resolveBinding) => {
			completeBinding = resolveBinding;
		});
		this.bindingCompletions.set(state.activeSessionId, bindingCompletion);
		onStateCreated?.(state);
		try {
			if (name) {
				await this.callbacks.setStateSessionName(state, name);
			}
			await bindActiveSessionState(state, {
				broadcast: (targetSessionState, message) => this.callbacks.broadcast(targetSessionState, message),
				createConnectionState: (targetSessionState) => this.callbacks.createConnectionState(targetSessionState),
				sessionReplaced: (targetSessionState) => this.callbacks.sessionReplaced(targetSessionState),
				shutdown: () => this.callbacks.shutdown(),
				subagentRuntimeHost: this.callbacks.createSubagentRuntimeHost(state),
			});
			if (runtimeOpenGuard) {
				const guardResult = runtimeOpenGuard();
				if (!(typeof guardResult === "boolean" ? guardResult : await guardResult)) {
					throw new RuntimeOpenCancelledError();
				}
			}
			onStateBound?.(state);
			this.scheduleRosterFlush();
		} catch (error) {
			state.unsubscribe?.();
			this.sessions.delete(state.activeSessionId);
			await runtime.dispose().catch(() => undefined);
			throw error;
		} finally {
			this.bindingSessions.delete(state.activeSessionId);
			this.bindingCompletions.delete(state.activeSessionId);
			completeBinding();
		}
		this.callbacks.onStateReleased(state);
		if (runtime.metadata.kind !== "subagent") {
			// Mark the session as resident so a restarted host can restore it.
			// Closes for kill/completed/replaced flip this back to sleep; clean
			// shutdowns leave it in place on purpose.
			try {
				runtime.session.sessionManager.appendSessionState({ status: "active" });
			} catch {
				// Marking is best-effort; the session still works unrestored.
			}
		}
		this.callbacks.onStateReady(state);
		return state;
	}

	/** Force-unpublish a state (host is mid-teardown). */
	dropState(state: ActiveSessionState): void {
		if (this.sessions.get(state.activeSessionId) === state) {
			this.sessions.delete(state.activeSessionId);
		}
	}

	findSessionBySessionFile(sessionFile: string | undefined): ActiveSessionState | undefined {
		if (!sessionFile) {
			return undefined;
		}
		const target = resolve(sessionFile);
		for (const state of this.sessions.values()) {
			const file = state.runtime.session.sessionFile;
			if (file && resolve(file) === target) {
				return state;
			}
		}
		return undefined;
	}

	getSessionState(id: string): ActiveSessionState {
		return resolveActiveSessionState(this.sessions, id);
	}

	// A bind failure disposes the runtime, so half-bound sessions must not be
	// targetable by attach, agent messages, or observe.
	getBoundSessionState(id: string): ActiveSessionState {
		const state = this.getSessionState(id);
		if (this.bindingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is still initializing`);
		}
		if (this.callbacks.isSessionClosing(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is closing`);
		}
		return state;
	}

	async getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState> {
		let lookupError: unknown;
		try {
			return this.getBoundSessionState(id);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				return this.waitForHydratingChild(this.getSessionState(id), id);
			}
			if (error instanceof AmbiguousActiveSessionError) {
				throw error;
			}
			lookupError = error;
		}
		const passiveSubagent = this.passive ? await this.passive.findPassiveRlmSubagent(id) : undefined;
		if (passiveSubagent && this.passive) {
			return this.passive.hydratePassiveRlmSubagent(passiveSubagent);
		}
		const hydratingChild = [...this.sessions.values()].find(
			(state) => state.runtime.metadata.kind === "subagent" && state.runtime.metadata.rlmChildId === id,
		);
		if (hydratingChild) {
			return this.waitForHydratingChild(hydratingChild, id);
		}
		try {
			return this.getBoundSessionState(id);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				return this.waitForHydratingChild(this.getSessionState(id), id);
			}
			if (error instanceof AmbiguousActiveSessionError) throw error;
			throw lookupError;
		}
	}

	async waitForHydratingChild(state: ActiveSessionState, selector: string): Promise<ActiveSessionState> {
		const sessionFile = state.runtime.session.sessionFile;
		if (!sessionFile || !this.passive?.findPassivationBySessionFile(sessionFile)) {
			return this.waitForBoundSession(state);
		}
		await this.passive.waitForPassivation(sessionFile);
		const passive = await this.passive.findPassiveRlmSubagent(sessionFile);
		return passive ? this.passive.hydratePassiveRlmSubagent(passive) : this.getOrHydrateBoundSessionState(selector);
	}

	async waitForBoundSession(state: ActiveSessionState): Promise<ActiveSessionState> {
		const completion = this.bindingCompletions.get(state.activeSessionId);
		if (completion) {
			await completion;
		}
		if (this.sessions.get(state.activeSessionId) !== state || this.bindingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} did not finish initializing`);
		}
		if (this.callbacks.isSessionClosing(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is closing`);
		}
		return state;
	}

	// --- roster composition -------------------------------------------------------

	rosterAgentIdForState(state: ActiveSessionState): string {
		const session = state.runtime.session;
		const metadata = state.runtime.metadata;
		if (metadata.kind === "subagent" && metadata.rlmChildId) {
			return rosterAgentIdForSummary({
				runtimeKind: "subagent",
				rlmChildId: metadata.rlmChildId,
				sessionId: metadata.rlmChildId,
				parentSessionPath: metadata.parentSessionFile,
				parentActiveSessionId: metadata.parentActiveSessionId,
			});
		}
		return session.sessionId;
	}

	rosterAgentIdForRlmChild(childId: string, parentSessionPath: string | undefined): string {
		return rosterAgentIdForSummary({
			runtimeKind: "subagent",
			rlmChildId: childId,
			sessionId: childId,
			parentSessionPath,
		});
	}

	rosterEntryForSessionPath(canonicalPath: string): WorkerRosterEntry | undefined {
		for (const entry of this.rosterReporter.lastComposed.values()) {
			if (entry.summary.sessionFile && canonicalSessionPath(entry.summary.sessionFile) === canonicalPath) {
				return entry;
			}
		}
		return undefined;
	}

	observeRosterEvent(state: ActiveSessionState, message: DaemonOutbound): void {
		if (!this.roster?.enabled()) return;
		if (message.type === "session_event") {
			if (message.event.type === "rlm_child_update") {
				this.observeRosterChildUpdate(state, message.event.child);
				return;
			}
			if (!ROSTER_SESSION_EVENT_TRIGGERS.has(message.event.type)) return;
		} else if (
			message.type !== "session_status" &&
			message.type !== "session_closed" &&
			message.type !== "session_replaced"
		) {
			return;
		}
		this.scheduleRosterFlush();
	}

	observeRosterChildUpdate(state: ActiveSessionState, child: AgentConnectionRlmChildAgentSnapshot): void {
		if (!this.roster?.enabled()) return;
		const bound = child.activeSessionId !== undefined || this.hasSessionForRlmChild(state, child.id);
		const entry = this.queuedChildRosterEntry(state, child);
		if (!bound && (child.status === "queued" || child.status === "running")) {
			this.rosterReporter.queuedChildren.set(entry.agentId, entry);
		} else {
			this.rosterReporter.queuedChildren.delete(entry.agentId);
		}
		this.scheduleRosterFlush();
	}

	hasSessionForRlmChild(parentState: ActiveSessionState, childId: string): boolean {
		for (const candidate of this.sessions.values()) {
			const metadata = candidate.runtime.metadata;
			if (metadata.rlmChildId === childId && metadata.parentActiveSessionId === parentState.activeSessionId) {
				return true;
			}
		}
		return false;
	}

	queuedChildRosterEntry(state: ActiveSessionState, child: AgentConnectionRlmChildAgentSnapshot): WorkerRosterEntry {
		const parentSession = state.runtime.session;
		const summary: RosterSessionSummary = {
			id: child.id,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			runtimeKind: "subagent",
			rlmDepth: (parentSession.rlmDepth ?? 0) + 1,
			sessionId: child.id,
			sessionName: child.sessionName,
			cwd: parentSession.sessionManager.getCwd(),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			firstMessage: child.label,
			parentActiveSessionId: state.activeSessionId,
			parentSessionId: parentSession.sessionId,
			parentSessionPath: parentSession.sessionFile,
			rlmChildId: child.id,
		};
		return { agentId: rosterAgentIdForSummary(summary), queuedChild: true, summary };
	}

	scheduleRosterFlush(): void {
		if (!this.roster?.enabled() || this.rosterFlushScheduled || this.roster.isShuttingDown()) return;
		this.rosterFlushScheduled = true;
		setImmediate(() => {
			this.rosterFlushScheduled = false;
			try {
				this.flushRoster();
			} catch (error) {
				this.roster?.log(`could not publish roster delta: ${String(error)}`);
			}
		});
	}

	/** Compose the full roster from live states, queued children, and removals. */
	composeRosterEntries(): Map<string, WorkerRosterEntry> {
		const reporter = this.rosterReporter;
		const entries = new Map<string, WorkerRosterEntry>();
		const scheduledJobs = this.roster?.scheduledJobs() ?? [];
		for (const summary of buildSessionList([...this.sessions.values()], [], scheduledJobs)) {
			const entry = workerRosterEntryFromSummary(summary);
			entries.set(entry.agentId, entry);
		}
		for (const [agentId, queued] of reporter.queuedChildren) {
			if (entries.has(agentId)) {
				reporter.queuedChildren.delete(agentId);
				continue;
			}
			entries.set(agentId, queued);
		}
		// A terminal unbound child run owns no transcript: it is a removal, never a passivated row.
		// A vanished row whose state lives on under a new sessionId was swapped in place
		// (new_session/switch/fork): also a removal — plain list never served the old transcript.
		const composedActiveIds = new Set<string>();
		for (const entry of entries.values()) {
			if (entry.summary.activeSessionId !== undefined) composedActiveIds.add(entry.summary.activeSessionId);
		}
		for (const [agentId, previous] of reporter.lastComposed) {
			if (entries.has(agentId)) continue;
			const swapped =
				previous.summary.activeSessionId !== undefined && composedActiveIds.has(previous.summary.activeSessionId);
			if (previous.queuedChild === true || swapped) {
				reporter.removedAgentIds.set(agentId, previous.summary.sessionId);
			}
		}
		for (const [agentId, targetSessionId] of reporter.removedAgentIds) {
			const composed = entries.get(agentId);
			// A new incarnation cancels the stale removal, as does a revived resident top-level row
			// (switch-back, resume-after-archive); a resident subagent row with the removed sessionId
			// is the mid-teardown race and stays suppressed.
			const revived = composed?.summary.activeSessionId !== undefined && composed.summary.runtimeKind !== "subagent";
			if (composed && (composed.queuedChild === true || composed.summary.sessionId !== targetSessionId || revived)) {
				reporter.removedAgentIds.delete(agentId);
				continue;
			}
			entries.delete(agentId);
			reporter.queuedChildren.delete(agentId);
		}
		const registrations = scheduledJobRegistrations(scheduledJobs);
		for (const [agentId, previous] of reporter.lastComposed) {
			if (!entries.has(agentId) && !reporter.removedAgentIds.has(agentId)) {
				const file = previous.summary.sessionFile ? resolve(previous.summary.sessionFile) : undefined;
				entries.set(
					agentId,
					passivatedWorkerRosterEntry(previous, {
						hasRegisteredHeartbeat: file !== undefined && registrations.heartbeatSessionFiles.has(file),
						hasRegisteredCronJob: file !== undefined && registrations.cronSessionFiles.has(file),
					}),
				);
			}
		}
		return entries;
	}

	flushRoster(): void {
		const roster = this.roster;
		if (!roster) return;
		const reporter = this.rosterReporter;
		const entries = this.composeRosterEntries();
		const changed: WorkerRosterEntry[] = [];
		const nextJson = new Map<string, string>();
		for (const entry of entries.values()) {
			const json = JSON.stringify(entry);
			nextJson.set(entry.agentId, json);
			if (reporter.lastComposedJson.get(entry.agentId) !== json) changed.push(entry);
		}
		const removedAgentIds = [...reporter.removedAgentIds.keys()];
		reporter.lastComposed = new Map(entries);
		reporter.lastComposedJson = nextJson;
		if (!roster.hasAuthenticatedSupervisorClient()) {
			if (changed.length > 0 || removedAgentIds.length > 0) reporter.snapshotPending = true;
			return;
		}
		if (reporter.snapshotPending) {
			const delivered = roster.broadcastRosterFrame({
				type: "roster_delta",
				snapshot: true,
				entries: [...entries.values()],
				...(removedAgentIds.length > 0 ? { removedAgentIds } : {}),
			});
			if (delivered) {
				reporter.snapshotPending = false;
				reporter.removedAgentIds.clear();
			}
			return;
		}
		if (changed.length === 0 && removedAgentIds.length === 0) return;
		const delivered = roster.broadcastRosterFrame({
			type: "roster_delta",
			entries: changed,
			...(removedAgentIds.length > 0 ? { removedAgentIds } : {}),
		});
		if (delivered) reporter.removedAgentIds.clear();
		else reporter.snapshotPending = true;
	}
}
