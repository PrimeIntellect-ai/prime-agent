import { basename, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	type AgentFamilyCatalogEntry,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	formatAgentSessionNameUnavailable,
} from "../../core/agent-messages.js";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.js";
import type { CustomMessage } from "../../core/messages.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createDefaultRlmSubagentSessionName,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmCreateSessionResult,
	type RlmDeleteSubagentResult,
	type RlmListSubagentsResult,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "../../core/rlm-runtime.js";
import type { SemanticEdgeRecorder } from "../../core/semantic-edges.js";
import { buildChildList, snapshotChildRun, snapshotRetainedChild } from "./child-projection.js";
import { launchChildTask } from "./child-run.js";
import {
	createChildDeferred,
	noopRlmChildAbort,
	noopRlmChildEventUnsubscribe,
	type RetainedRlmChild,
	type RlmChildAgentSnapshot,
	type RlmChildAgentStatus,
	type RlmChildRun,
} from "./child-types.js";
import type { ChildUsageTracker } from "./child-usage.js";

export interface ChildRuntimeRequest {
	id: string;
	prompt: string;
	sessionName: string;
	spawnCode?: string;
	sessionDir: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	spawnedByRequestId?: string;
}
export interface SessionChildrenHost {
	isDisposed(): boolean;
	isInputSuspended(): boolean;
	isStreaming(): boolean;
	isSessionActive(): boolean;
	getMessageController(): AgentSessionMessageController | undefined;
	getDepth(): number;
	getMaxDepth(): number;
	getParentNodeId(): string | undefined;
	getCwd(): string;
	getSessionId(): string;
	getSessionName(): string | undefined;
	getSessionFile(): string | undefined;
	getThinkingLevel(): ThinkingLevel;
	getSemanticEdges(): SemanticEdgeRecorder;
	getChildOwner(child: AgentSession): SessionChildren;
	getParentReplyCount(child: AgentSession): number;
	getChildSessionDir(child: AgentSession): string | undefined;
	listRlmSubagents(): Promise<RlmListSubagentsResult>;
	deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult>;
	registerRlmChildSession(childId: string, session: AgentSession): boolean;
	resolveModel(reference: string | undefined, target?: string): Promise<{ model: Model<Api> }>;
	createSessionDir(): string;
	createRuntimeOptions(request: ChildRuntimeRequest): CreateRlmSubagentRuntimeOptions;
	createRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	createUsageTracker(): ChildUsageTracker;
	hasDeferredTerminalNotices(): boolean;
	waitForHeadlessIdle(): Promise<void>;
	waitForActivityChange(signal: AbortSignal): Promise<void>;
	deliverTerminalNotice(message: CustomMessage): Promise<void>;
	emit(event: AgentSessionEvent): void;
	onSettled(): void;
}
type RlmSubagentModelSelection = { model: Model<Api> };

export class SessionChildren {
	constructor(private readonly host: SessionChildrenHost) {}
	private _subagentRuntimeHost?: SubagentRuntimeHost;
	private _activeRlmChildRuns = new Map<string, RlmChildRun>();
	private _unsettledRlmChildRuns = new Set<RlmChildRun>();
	private _abandonedRlmQuiescenceChildIds = new Set<string>();
	private _rlmQuiescenceWaitAborts = new Set<AbortController>();
	private _pendingRlmSubagentSessionNames = new Set<string>();
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	private _rlmChildSessions = new Map<string, RetainedRlmChild>();
	private _deletedRlmChildIds = new Set<string>();
	// Failed explicit deletes stay hidden from listings but retain their original
	// selector so a later delete can retry cleanup without orphaning the runtime.
	private _rlmChildCleanupFailures = new Map<string, RlmSubagentRegistryEntry>();
	private _deletingRlmChildren = new Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>();
	// Kept alive for retained children so nested updates (e.g. a grandchild cancel)
	// still forward to root; torn down when the retained child is disposed.
	private _rlmChildUnsubscribes = new Map<string, () => void>();
	private _abandonRlmRunForQuiescence(run: RlmChildRun): void {
		run.suppressTerminalNotice = true;
		run.abandonedForQuiescence = true;
		this._abandonedRlmQuiescenceChildIds.add(run.id);
		this._unsettledRlmChildRuns.delete(run);
		run.settlement.resolve();
		this.host.onSettled();
	}

	cancelActiveRuns(reason: string): void {
		for (const run of this._activeRlmChildRuns.values()) {
			this._cancelRlmChildRun(run, reason);
		}
	}

	private _cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
		if (run.status !== "running" && run.status !== "queued") {
			return false;
		}
		run.status = "cancelled";
		if (this.host.isInputSuspended()) this._abandonRlmRunForQuiescence(run);
		run.error = reason;
		run.publication.reject(new Error(reason));
		run.abort();
		// Surface the cancellation immediately; the run's own terminal update is
		// delayed indefinitely when the child is stuck mid-stream, which is
		// exactly when users reach for the kill.
		run.emitUpdate?.();
		return true;
	}

	getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined {
		return this._activeRlmChildRuns.get(childId)?.status;
	}

	private async _currentActiveSessionId(): Promise<string | undefined> {
		try {
			return (await this.host.getMessageController()?.listAgents())?.current?.activeSessionId;
		} catch {
			return undefined;
		}
	}

	async awaitPublication(selector: string): Promise<string | undefined> {
		const run = [...this._activeRlmChildRuns.values()].find(
			(candidate) =>
				(candidate.status === "queued" || candidate.status === "running" || candidate.status === "done") &&
				!candidate.detachedDeletion &&
				(candidate.id === selector || candidate.sessionName === selector),
		);
		if (!run) return undefined;
		await run.publication.promise;
		return run.session?.sessionId;
	}

	async listRlmSubagents(): Promise<RlmListSubagentsResult> {
		return this._buildRlmSubagentList(await this.host.getMessageController()?.listAgents());
	}

	private _buildRlmSubagentList(listedAgents?: AgentSessionMessageListResult): RlmListSubagentsResult {
		return buildChildList(
			this._activeRlmChildRuns.values(),
			this._rlmChildSessions,
			{
				isDeleting: (id) => this._deletingRlmChildren.has(id),
				isDeleted: (id) => this._deletedRlmChildIds.has(id),
				hasCleanupFailure: (id) => this._rlmChildCleanupFailures.has(id),
			},
			(child) => this.host.getChildSessionDir(child),
			listedAgents,
		);
	}

	private _rlmSubagentMatchesTarget(entry: RlmSubagentRegistryEntry, target: string): boolean {
		return (
			entry.rlm_child_id === target ||
			entry.active_session_id === target ||
			entry.session_id === target ||
			entry.session_name === target
		);
	}

	private async _resolveDirectRlmSubagent(target: string): Promise<RlmSubagentRegistryEntry> {
		const candidates = [...(await this.host.listRlmSubagents()).subagents, ...this._rlmChildCleanupFailures.values()];
		const matches = candidates.filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		if (matches.length === 0) {
			throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
		}
		if (matches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		return matches[0]!;
	}

	async deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		for (const owner of this._rlmSubtreeSessions()) {
			const isRunning = (): boolean => {
				const status = owner._activeRlmChildRuns.get(childId)?.status;
				return status === "queued" || status === "running" || isExternallyRunning();
			};
			if (isRunning()) {
				return "running";
			}
			const subagent = [
				...(await owner.host.listRlmSubagents()).subagents,
				...owner._rlmChildCleanupFailures.values(),
			].find((entry) => entry.rlm_child_id === childId);
			if (!subagent) continue;
			if (isRunning()) {
				return "running";
			}
			const result = await owner._trackRlmSubagentDeletion(subagent, () => {
				if (isRunning()) {
					return Promise.resolve({ subagent, outcome: "skipped_running" });
				}
				return owner._deleteResolvedRlmSubagent(subagent);
			});
			return result.outcome === "skipped_running" ? "running" : "deleted";
		}
		return "not_found";
	}

	async deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		const inFlight = [...this._deletingRlmChildren.values()].filter(({ subagent }) =>
			this._rlmSubagentMatchesTarget(subagent, target),
		);
		if (inFlight.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}

		// Running and retained children can be reserved synchronously. This keeps
		// them hidden immediately while the async daemon listing checks for a
		// conflicting passive selector.
		const localMatches = [
			...this._buildRlmSubagentList().subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const matchingChildIds = new Set([
			...inFlight.map(({ subagent }) => subagent.rlm_child_id),
			...localMatches.map((subagent) => subagent.rlm_child_id),
		]);
		if (matchingChildIds.size > 1 || localMatches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		if (inFlight[0]) {
			return inFlight[0].promise;
		}
		if (localMatches[0]) {
			const subagent = localMatches[0];
			return this._trackRlmSubagentDeletion(subagent, async () => {
				const listedAgents = await this.host.getMessageController()?.listAgents();
				const listedSubagents = this._buildRlmSubagentList(listedAgents).subagents;
				const passiveMatches = listedSubagents.filter(
					(entry) => entry.rlm_child_id !== subagent.rlm_child_id && this._rlmSubagentMatchesTarget(entry, target),
				);
				if (passiveMatches.length > 0) {
					throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
				}
				const parentActiveSessionId = listedAgents?.current?.activeSessionId;
				const daemonChild = listedAgents?.agents.find(
					(agent) =>
						agent.rlmChildId === subagent.rlm_child_id && agent.parentActiveSessionId === parentActiveSessionId,
				);
				const resolvedSubagent = daemonChild
					? {
							...subagent,
							active_session_id: daemonChild.activeSessionId,
							session_id: daemonChild.sessionId,
							session_name: daemonChild.sessionName ?? subagent.session_name,
						}
					: subagent;
				return this._deleteResolvedRlmSubagent(resolvedSubagent);
			});
		}

		const directMatches = [
			...(await this.host.listRlmSubagents()).subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const directChildIds = new Set(directMatches.map((subagent) => subagent.rlm_child_id));
		if (directChildIds.size > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		const subagent = directMatches[0] ?? (await this._resolveDirectRlmSubagent(target));
		return this._trackRlmSubagentDeletion(subagent, () => this._deleteResolvedRlmSubagent(subagent));
	}

	private async _trackRlmSubagentDeletion(
		subagent: RlmSubagentRegistryEntry,
		startDeletion: () => Promise<RlmDeleteSubagentResult>,
	): Promise<RlmDeleteSubagentResult> {
		const existing = this._deletingRlmChildren.get(subagent.rlm_child_id);
		if (existing) return existing.promise;
		const deletion = Promise.resolve().then(startDeletion);
		this._deletingRlmChildren.set(subagent.rlm_child_id, {
			subagent,
			promise: deletion,
		});
		try {
			return await deletion;
		} finally {
			const clearReservation = () => {
				if (this._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
					this._deletingRlmChildren.delete(subagent.rlm_child_id);
				}
			};
			const run = this._activeRlmChildRuns.get(subagent.rlm_child_id);
			if (run?.detachedDeletion) {
				// Keep every selector reserved until the run settles, or until a failed
				// cleanup is exposed for an explicit retry. Repeated deletes before that
				// boundary return the same accepted result.
				void run.deletionReservation.promise.then(clearReservation, clearReservation);
			} else {
				clearReservation();
			}
		}
	}

	private _deleteRlmSubagentSession(childId: string, session?: AgentSession): Promise<void> {
		if (this._subagentRuntimeHost) {
			return this._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
		}
		return session?.disposeAsync() ?? Promise.resolve();
	}

	private _ensureRlmRunDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void> {
		if (run.deletionCleanup) return run.deletionCleanup;
		const cleanup = Promise.resolve().then(() => this._deleteRlmSubagentSession(run.id, session));
		run.deletionCleanup = cleanup;
		// Deletion admission is intentionally nonblocking. The detached run owner
		// joins this exact promise before settlement and records any failure.
		void cleanup.catch(() => undefined);
		return cleanup;
	}

	private async _recordRlmRunDeletionCleanupFailure(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		error: unknown,
	): Promise<void> {
		if (this.host.isDisposed()) {
			run.suppressTerminalNotice = true;
			await session.disposeAsync().catch(() => undefined);
			if (!run.settled) await this._finishRlmRunDeletion(run);
			return;
		}
		run.deletionCleanup = undefined;
		run.deletionCleanupObserver = undefined;
		run.deletionCleanupFailed = true;
		run.session = session;
		this._rlmChildCleanupFailures.set(run.id, subagent);
		// Make retry admission available before waking the parent model with the
		// retry-required notice.
		run.deletionReservation.resolve();
		await Promise.resolve();
		await run.reportDeletionCleanupFailure?.(error);
	}

	private async _finishRlmRunDeletion(run: RlmChildRun): Promise<void> {
		await run.completeDeletion?.();
		if (this._activeRlmChildRuns.get(run.id) === run) {
			this._removeRlmSubagentTracking(run.id, run);
		}
		run.settled = true;
		run.settlement.resolve();
		run.deletionReservation.resolve();
		this._unsettledRlmChildRuns.delete(run);
		this.host.onSettled();
	}

	private _observeRlmRunDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean> {
		if (run.deletionCleanupObserver) return run.deletionCleanupObserver;
		const observer = cleanup.then(
			() => true,
			async (error) => {
				await this._recordRlmRunDeletionCleanupFailure(run, subagent, session, error);
				return false;
			},
		);
		run.deletionCleanupObserver = observer;
		void observer.catch(() => undefined);
		return observer;
	}

	private _continueFinishedRlmRunDeletion(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
	): void {
		const cleanup = this._ensureRlmRunDeletionCleanup(run, session);
		const observer = this._observeRlmRunDeletionCleanup(run, subagent, session, cleanup);
		if (!run.deletionRunFinished) return;
		void observer
			.then(async (cleanupSucceeded) => {
				if (cleanupSucceeded) await this._finishRlmRunDeletion(run);
			})
			.catch(() => undefined);
	}

	private _removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		run?.unsubscribe?.();
		this._rlmChildUnsubscribes.get(childId)?.();
		this._rlmChildUnsubscribes.delete(childId);
		this._rlmChildSessions.delete(childId);
		this._rlmChildCleanupFailures.delete(childId);
		this._abandonedRlmQuiescenceChildIds.delete(childId);
		if (!run || this._activeRlmChildRuns.get(childId) === run) {
			this._activeRlmChildRuns.delete(childId);
		}
		if (run) {
			run.abort = noopRlmChildAbort;
			run.unsubscribe = undefined;
			run.session = undefined;
		}
	}

	private _emitRlmSubagentRemoval(subagent: RlmSubagentRegistryEntry): void {
		this.host.emit({
			type: "rlm_child_update",
			child: {
				id: subagent.rlm_child_id,
				parentId: this.host.getParentNodeId(),
				activeSessionId: subagent.active_session_id ?? undefined,
				sessionName: subagent.session_name,
				label: subagent.session_name,
				status: "cancelled",
				sessionDir: subagent.session_dir,
				error: "Deleted by parent orchestrator",
			},
		});
	}

	private async _deleteResolvedRlmSubagent(subagent: RlmSubagentRegistryEntry): Promise<RlmDeleteSubagentResult> {
		const childId = subagent.rlm_child_id;
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			if (run.deletionCleanupFailed) {
				// Reset retry coordination only after selector preflight reaches the
				// resolved child. A failed preflight must leave the prior retry boundary
				// intact so a later call can acquire it.
				run.deletionCleanupFailed = false;
				run.deletionFailureNotice = undefined;
				run.deletionReservation = createChildDeferred();
			}
			// The detached task remains the sole lifecycle owner. Mark deletion before
			// cancellation so its catch/finally path cannot race a normal release or
			// terminal notice against the physical delete.
			run.detachedDeletion = subagent;
			if (this._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
				run.deletionNeedsCompletionNotice = true;
			} else {
				this._emitRlmSubagentRemoval(subagent);
			}
			const liveSession = run.session;
			if (run.status === "error" && !liveSession && run.settled) {
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}
			if (liveSession && run.settled) {
				run.deletionRunFinished = true;
				run.settlement = createChildDeferred();
				run.settled = false;
				this._unsettledRlmChildRuns.add(run);
			}
			if (liveSession) this._continueFinishedRlmRunDeletion(run, subagent, liveSession);

			// Return once deletion is accepted. The run stays hidden but unsettled until
			// abort-insensitive model/tool work unwinds and the shared cleanup finishes.
			this._deletedRlmChildIds.add(childId);
			return { subagent };
		}

		this._emitRlmSubagentRemoval(subagent);
		const retained = this._rlmChildSessions.get(childId)?.session;
		try {
			await this._deleteRlmSubagentSession(childId, retained);
		} catch (error) {
			if (this.host.isDisposed()) {
				this._removeRlmSubagentTracking(childId);
				void retained?.disposeAsync().catch(() => undefined);
			} else {
				this._rlmChildCleanupFailures.set(childId, subagent);
			}
			throw error;
		}
		this._deletedRlmChildIds.add(childId);
		this._removeRlmSubagentTracking(childId);
		return { subagent };
	}

	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean {
		// A child can finish concurrently while the parent is (or has) torn down; don't
		// resurrect the map (it would never be disposed), just drop the child now.
		if (this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId)) {
			return false;
		}
		if (this._subagentRuntimeHost?.completeRlmSubagentRuntime?.(childId, session) === false) {
			return false;
		}
		if (this.host.isDisposed()) {
			void session.disposeAsync().catch(() => undefined);
			return false;
		}
		this._rlmChildSessions.set(childId, { session, run: this._activeRlmChildRuns.get(childId) });
		if (unsubscribe) {
			this._rlmChildUnsubscribes.set(childId, unsubscribe);
		}
		return true;
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		const run = this._activeRlmChildRuns.get(childId);
		if (run?.session === session && run.status === "done") {
			const unsubscribe = run.unsubscribe ?? noopRlmChildEventUnsubscribe;
			return () => {
				run.unsubscribe = undefined;
				this._activeRlmChildRuns.delete(childId);
				unsubscribe();
			};
		}
		if (this._rlmChildSessions.get(childId)?.session !== session) return false;
		const unsubscribe = this._rlmChildUnsubscribes.get(childId) ?? noopRlmChildEventUnsubscribe;
		return () => {
			this._rlmChildUnsubscribes.delete(childId);
			this._rlmChildSessions.delete(childId);
			unsubscribe();
		};
	}

	private _rlmChildSnapshotForRun(
		run: RlmChildRun,
		child = run.session ?? this._rlmChildSessions.get(run.id)?.session,
	): RlmChildAgentSnapshot {
		return snapshotChildRun(run, child, this.host.getParentNodeId());
	}

	private _rlmChildSnapshotForSession(childId: string, child: AgentSession): RlmChildAgentSnapshot {
		return snapshotRetainedChild(childId, child, this.host.getParentNodeId(), this.host.getChildSessionDir(child));
	}

	private _isUnboundTerminalRlmChildRun(run: RlmChildRun): boolean {
		if (run.session !== undefined || this._rlmChildSessions.has(run.id)) return false;
		return run.status === "done" || run.status === "error" || run.status === "cancelled";
	}

	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		const snapshots: RlmChildAgentSnapshot[] = [];
		const recorded = new Set<string>();
		const traversed = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			const hidden =
				run.detachedDeletion ||
				this._deletingRlmChildren.has(run.id) ||
				this._deletedRlmChildIds.has(run.id) ||
				this._isUnboundTerminalRlmChildRun(run);
			const child = run.session;
			if (!hidden) {
				snapshots.push(this._rlmChildSnapshotForRun(run));
				recorded.add(run.id);
			}
			if (child) {
				traversed.add(run.id);
				snapshots.push(...child.getRlmChildSnapshots());
			}
		}
		for (const [childId, { session: child, run }] of this._rlmChildSessions) {
			if (recorded.has(childId) || traversed.has(childId)) continue;
			const hidden = this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId);
			if (!hidden) {
				const snapshot = run
					? this._rlmChildSnapshotForRun(run, child)
					: this._rlmChildSnapshotForSession(childId, child);
				snapshots.push({
					...snapshot,
					status: this._rlmChildCleanupFailures.has(childId) ? "cancelled" : snapshot.status,
				});
			}
			snapshots.push(...child.getRlmChildSnapshots());
		}
		return snapshots;
	}

	hasRunningRlmChildren(): boolean {
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.status === "running" || run.status === "queued") {
					return true;
				}
			}
		}
		return false;
	}

	private _rlmChildSessionSnapshot(): AgentSession[] {
		const sessions = new Set<AgentSession>();
		for (const [childId, { session }] of this._rlmChildSessions) {
			if (!this._abandonedRlmQuiescenceChildIds.has(childId)) sessions.add(session);
		}
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session && !run.abandonedForQuiescence) sessions.add(run.session);
		}
		return [...sessions];
	}

	hasUnsettledWork(): boolean {
		if (this.host.hasDeferredTerminalNotices()) return true;
		if ([...this._unsettledRlmChildRuns].some((run) => !run.settled)) return true;
		return this._rlmChildSessionSnapshot().some(
			(child) => child.isSessionActive || this.host.getChildOwner(child).hasUnsettledWork(),
		);
	}

	async waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<void> {
		const cancellation = new AbortController();
		const cancelFromParent = () => cancellation.abort();
		if (externalSignal?.aborted) cancellation.abort();
		else externalSignal?.addEventListener("abort", cancelFromParent, { once: true });
		this._rlmQuiescenceWaitAborts.add(cancellation);
		let rejectCancelled = (_error: Error) => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const onCancelled = () => rejectCancelled(new Error("RLM quiescence wait cancelled"));
		cancellation.signal.addEventListener("abort", onCancelled, { once: true });
		if (cancellation.signal.aborted) onCancelled();
		const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
		try {
			while (true) {
				await wait(this.host.waitForHeadlessIdle());
				// Strong RLM quiescence also owns work that interactive waitForIdle ignores.
				if (this.host.isSessionActive() || this.host.hasDeferredTerminalNotices()) {
					await wait(this.host.waitForActivityChange(cancellation.signal));
					continue;
				}
				const unsettledRuns = [...this._unsettledRlmChildRuns].filter((run) => !run.settled);
				const childSessions = this._rlmChildSessionSnapshot();
				if (unsettledRuns.length === 0 && !this.hasUnsettledWork()) return;
				await wait(
					Promise.all([
						...unsettledRuns.map((run) => run.settlement.promise),
						...childSessions.map((child) => child.waitForRlmQuiescence(cancellation.signal)),
					]),
				);
				// Always loop through the self-active/deferred checks again. Work may
				// start at the child-settlement boundary.
			}
		} finally {
			// A local descendant error must cancel sibling recursive waits owned by
			// this barrier before their propagation listeners are removed.
			cancellation.abort();
			externalSignal?.removeEventListener("abort", cancelFromParent);
			cancellation.signal.removeEventListener("abort", onCancelled);
			this._rlmQuiescenceWaitAborts.delete(cancellation);
		}
	}

	getRlmChildSession(childId: string): AgentSession | undefined {
		for (const session of this._rlmSubtreeSessions()) {
			const direct =
				session._activeRlmChildRuns.get(childId)?.session ?? session._rlmChildSessions.get(childId)?.session;
			if (direct) {
				return direct;
			}
		}
		return undefined;
	}

	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		for (const session of this._rlmSubtreeSessions()) {
			const run = session._activeRlmChildRuns.get(childId);
			if (run) {
				if (run.status !== "running" && run.status !== "queued" && !run.settled) {
					if (session.host.isInputSuspended()) session._abandonRlmRunForQuiescence(run);
					else run.suppressTerminalNotice = true;
					return true;
				}
				// The abort cascade never reaches running work retained under a settled descendant.
				const cancelled = session._cancelRlmChildRun(run, reason);
				const descendantsCancelled = run.session?.cancelRunningRlmDescendants(reason) ?? false;
				if (cancelled || descendantsCancelled) {
					return true;
				}
			}
			// A fruitless match keeps walking: child ids are only mkdir-unique among
			// siblings, so a colliding live run elsewhere must stay reachable.
			if (session._rlmChildSessions.get(childId)?.session.cancelRunningRlmDescendants(reason)) {
				return true;
			}
		}
		return false;
	}

	// A completed child may belong to both maps; visit each owner once.
	private *_rlmSubtreeSessions(): Generator<SessionChildren> {
		const visited = new Set<SessionChildren>([this]);
		const stack: SessionChildren[] = [this];
		while (stack.length > 0) {
			const session = stack.pop()!;
			yield session;
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.session && !visited.has(this.host.getChildOwner(run.session))) {
					visited.add(this.host.getChildOwner(run.session));
					stack.push(this.host.getChildOwner(run.session));
				}
			}
			for (const { session: retained } of session._rlmChildSessions.values()) {
				if (!visited.has(this.host.getChildOwner(retained))) {
					visited.add(this.host.getChildOwner(retained));
					stack.push(this.host.getChildOwner(retained));
				}
			}
		}
	}

	cancelRunningRlmDescendants(reason = "Cancelled by user"): boolean {
		let cancelled = false;
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (session._cancelRlmChildRun(run, reason)) cancelled = true;
			}
		}
		return cancelled;
	}

	private async _assertRlmSubagentSessionNameAvailable(name: string, ignorePendingReservation = false): Promise<void> {
		const depth = this.host.getDepth() + 1;
		if (!ignorePendingReservation && this._pendingRlmSubagentSessionNames.has(name)) {
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const localConflict =
			[...this._activeRlmChildRuns.values()].some(
				(run) => run.session?.sessionName === name || (!run.session && run.sessionName === name),
			) ||
			[...this._rlmChildSessions.values()].some(({ session }) => session.sessionName === name) ||
			[...this._rlmChildCleanupFailures.values()].some((entry) => entry.session_name === name);
		if (localConflict) {
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const controller = this.host.getMessageController();
		if (!controller) return;
		const input = {
			name,
			depth,
			parentSessionId: this.host.getSessionId(),
			parentSessionPath: this.host.getSessionFile(),
		};
		if (controller.assertSessionNameAvailable) {
			await controller.assertSessionNameAvailable(input);
			return;
		}
		const listed = await controller.listAgents();
		const catalog = listed.agents.map(
			(agent): AgentFamilyCatalogEntry => ({
				id: agent.sessionId,
				...(agent.sessionName ? { name: agent.sessionName } : {}),
				depth: agent.rlmDepth ?? 0,
				status: agent.status ?? "idle",
				...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
				...(agent.parentSessionPath ? { parentSessionPath: agent.parentSessionPath } : {}),
				...(agent.sessionPath ? { sessionPath: agent.sessionPath } : {}),
			}),
		);
		assertAgentSessionNameAvailable(catalog, input);
	}

	async reapAfterCompaction(): Promise<void> {
		const childIds = [...this._rlmChildCleanupFailures.keys()].filter(
			(childId) => !this._activeRlmChildRuns.get(childId)?.detachedDeletion,
		);
		await Promise.allSettled(childIds.map((childId) => this.host.deleteRlmSubagent(childId)));
	}

	async run(prompt: string, kwargs: Record<string, unknown> = {}, spawnCode?: string): Promise<RlmSpawnHandle> {
		// Snapshot before any await: the spawning request is the turn whose tool call is
		// executing now. A spawn arriving outside an active run (a detached kernel task
		// firing while the parent is idle) has no such turn; an absent edge beats a wrong one.
		const spawnedByRequestId = this.host.isStreaming() ? this.host.getSemanticEdges().lastTurnRequestId : undefined;
		const { name: rawName, model: rawModel, thinking: rawThinking, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.spawn kwargs: ${unsupportedKwargs.sort().join(", ")}`);
		}
		const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking);
		if (requestedSessionName) assertDirectAgentMessageTarget(requestedSessionName);
		if (this.host.getDepth() >= this.host.getMaxDepth()) {
			throw new Error(
				`RLM recursion depth limit reached (RLM_DEPTH=${this.host.getDepth()}, RLM_MAX_DEPTH=${this.host.getMaxDepth()})`,
			);
		}
		if (requestedSessionName) {
			if (this._pendingRlmSubagentSessionNames.has(requestedSessionName)) {
				throw new Error(formatAgentSessionNameUnavailable(requestedSessionName, this.host.getDepth() + 1));
			}
			this._pendingRlmSubagentSessionNames.add(requestedSessionName);
		}
		let modelSelection: RlmSubagentModelSelection;
		try {
			if (requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(requestedSessionName, true);
			modelSelection = await this.host.resolveModel(requestedModel);
		} finally {
			if (requestedSessionName) this._pendingRlmSubagentSessionNames.delete(requestedSessionName);
		}
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		if (this.host.isDisposed()) throw new Error("Cannot spawn a subagent after its parent was disposed");

		const childSessionDir = this.host.createSessionDir();
		const childNodeId = basename(childSessionDir);
		const sessionName = requestedSessionName ?? createDefaultRlmSubagentSessionName(prompt, childNodeId);
		if (!requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(sessionName);

		return launchChildTask(
			this.host,
			{
				admitRun: (run) => {
					this._activeRlmChildRuns.set(run.id, run);
					this._unsettledRlmChildRuns.add(run);
				},
				isCurrentRun: (run) => this._activeRlmChildRuns.get(run.id) === run,
				snapshotForRun: (run) => this._rlmChildSnapshotForRun(run),
				registerSession: (id, child) => this.host.registerRlmChildSession(id, child),
				currentActiveSessionId: () => this._currentActiveSessionId(),
				getRuntimeHost: () => this._subagentRuntimeHost,
				recordDeleted: (id) => {
					this._deletedRlmChildIds.add(id);
				},
				removeTracking: (id, run) => this._removeRlmSubagentTracking(id, run),
				ensureDeletionCleanup: (run, child) => this._ensureRlmRunDeletionCleanup(run, child),
				observeDeletionCleanup: (run, entry, child, cleanup) =>
					this._observeRlmRunDeletionCleanup(run, entry, child, cleanup),
				finishDeletion: (run) => this._finishRlmRunDeletion(run),
				finishRun: (run) => this.finishRun(run),
			},
			{
				id: childNodeId,
				prompt,
				sessionName,
				spawnCode,
				sessionDir: childSessionDir,
				model: modelSelection.model,
				thinkingLevel: requestedThinkingLevel,
				spawnedByRequestId,
			},
		);
	}
	private finishRun(run: RlmChildRun): void {
		if (this._activeRlmChildRuns.get(run.id) === run) {
			if (this._rlmChildSessions.has(run.id)) {
				this._activeRlmChildRuns.delete(run.id);
				if (run.unsubscribe) this._rlmChildUnsubscribes.set(run.id, run.unsubscribe);
				run.abort = noopRlmChildAbort;
				run.unsubscribe = undefined;
				run.session = undefined;
			} else if (run.status !== "error") {
				this._removeRlmSubagentTracking(run.id, run);
			} else {
				run.unsubscribe?.();
				run.abort = noopRlmChildAbort;
				run.unsubscribe = undefined;
			}
		}
		run.settled = true;
		run.settlement.resolve();
		this._unsettledRlmChildRuns.delete(run);
		this.host.onSettled();
	}

	async createRlmSession(prompt: string, kwargs: Record<string, unknown> = {}): Promise<RlmCreateSessionResult> {
		const { name: rawName, model: rawModel, thinking: rawThinking, cwd: rawCwd, ...unsupported } = kwargs;
		const unsupportedKeys = Object.keys(unsupported);
		if (unsupportedKeys.length > 0) {
			throw new Error(`Unsupported rlm.create_session kwargs: ${unsupportedKeys.sort().join(", ")}`);
		}
		if (!prompt.trim()) {
			throw new Error("rlm.create_session prompt must not be empty");
		}
		if (this.host.getDepth() !== 0) {
			throw new Error("rlm.create_session is available only from a depth-0 session");
		}
		if (this.host.isDisposed()) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		const host = this._subagentRuntimeHost;
		if (!host?.createRlmRootSession) {
			throw new Error("rlm.create_session requires a daemon-backed depth-0 session");
		}

		const operation = "rlm.create_session";
		const sessionName = normalizeRequestedRlmSubagentSessionName(rawName, operation);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel, operation);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking, operation);
		if (sessionName) {
			assertDirectAgentMessageTarget(sessionName);
			const controller = this.host.getMessageController();
			if (controller?.assertSessionNameAvailable) {
				await controller.assertSessionNameAvailable({ name: sessionName, depth: 0 });
			}
		}
		if (rawCwd !== undefined && (typeof rawCwd !== "string" || !rawCwd.trim())) {
			throw new Error("rlm.create_session cwd must be a non-empty string");
		}
		const cwd = rawCwd === undefined ? this.host.getCwd() : resolve(this.host.getCwd(), rawCwd.trim());
		const modelSelection = await this.host.resolveModel(requestedModel, "top-level session");
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		const thinkingLevel =
			requestedThinkingLevel ??
			(clampThinkingLevel(modelSelection.model, this.host.getThinkingLevel()) as ThinkingLevel);
		if (this.host.isDisposed()) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		return host.createRlmRootSession({
			prompt,
			sessionName,
			cwd,
			model: modelSelection.model,
			thinkingLevel,
		});
	}
	async disposeAsync(afterChildren: () => Promise<void>): Promise<void> {
		for (const run of [...this._activeRlmChildRuns.values()]) {
			const childSession = run.session;
			if (!childSession) continue;
			if (run.detachedDeletion) {
				run.suppressTerminalNotice = true;
				if (run.deletionCleanupObserver) {
					await run.deletionCleanupObserver.catch(() => false);
				} else if (run.deletionCleanup) {
					await run.deletionCleanup.catch(() => childSession.disposeAsync().catch(() => undefined));
				} else {
					// Cleanup already failed and was exposed for retry before disposal.
					await childSession.disposeAsync().catch(() => undefined);
				}
				if (!run.settled) await this._finishRlmRunDeletion(run);
			} else {
				await childSession.disposeAsync().catch(() => undefined);
			}
		}
		for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._rlmChildUnsubscribes.clear();
		for (const { session } of this._rlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		return afterChildren();
	}
	dispose(): void {
		this.cancelActiveRuns("Parent session disposed");
		for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._rlmChildUnsubscribes.clear();
		for (const { session } of this._rlmChildSessions.values()) {
			session.dispose();
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
	}

	beginDisposal(): void {
		for (const run of this._unsettledRlmChildRuns) run.suppressTerminalNotice = true;
		this.cancelQuiescenceWaits();
	}
	cancelQuiescenceWaits(): void {
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
	}
	requestAbort(): void {
		for (const run of [...this._unsettledRlmChildRuns]) {
			if (run.status === "cancelled") this._abandonRlmRunForQuiescence(run);
		}
		this.cancelQuiescenceWaits();
	}
	setRuntimeHost(host?: SubagentRuntimeHost): void {
		this._subagentRuntimeHost = host;
	}
	getRuntimeHost(): SubagentRuntimeHost | undefined {
		return this._subagentRuntimeHost;
	}
	getActiveRuns(): Iterable<
		Readonly<Pick<RlmChildRun, "id" | "prompt" | "status" | "sessionDir">> & {
			readonly session?: Pick<AgentSession, "getContextTree">;
		}
	> {
		return this._activeRlmChildRuns.values();
	}
}
