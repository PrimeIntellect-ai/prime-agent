import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, StreamLivenessDiagnostic } from "@earendil-works/pi-ai";
import {
	type AgentSessionCompactionLiveness,
	type AgentSessionProviderStreamLiveness,
	compactRlmText,
	rlmChildLabel,
} from "../../core/agent-session.js";
import type { AgentSessionRuntimeMetadata } from "../../core/agent-session-runtime.js";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import { type AgentCronJob, type AgentCronJobSource, isHeartbeatCronJob } from "../../core/cron-jobs.js";
import type { SessionActionSnapshot } from "../../core/session-action-store.js";
import {
	type AgentTaskState,
	projectResourceExhaustedBlocker,
	type ResourceExhaustedBlocker,
	type SessionInfo,
} from "../../core/session-manager.js";
import type { ToolExecutionLiveness, ToolExecutionStallDiagnostic } from "../../core/tool-execution-liveness.js";
import {
	projectWorkerModelCapabilityBlocker,
	type WorkerModelCapabilityBlocker,
} from "../../core/workflow/worker-model-capability-gate.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import type { ActiveSessionState } from "./active-session-state.js";

// Durable lifecycle; decides agents-view visibility. Only "live" is shown.
// "draft" = no message sent yet (discarded on close); "archived" = ctrl+x'd,
// reachable only via --resume <selector>.
export type SessionLifecycle = "draft" | "live" | "archived";

// Heuristic activity of a live session. Classification-in-flight counts as
// "working" so the view never sees an unlabeled idle session.
export type SessionActivity = "working" | "idle";
export type SessionRosterStatus = "running" | "idle" | "inactive";

export interface SessionScheduledWake {
	readonly owner: "daemon_cron";
	readonly jobId: string;
	readonly source: AgentCronJobSource;
	readonly nextRunAt: string;
}

export type DaemonWorkflowStatus =
	| "idle"
	| "active"
	| "awaiting_user"
	| "paused"
	| "budget_limited"
	| "blocked"
	| "failed"
	| "cancelled"
	| "complete";

export type DaemonWorkflowPhase =
	| "discovering_capacity"
	| "hardening_goal"
	| "hardening_scorecard"
	| "reconnaissance"
	| "analyzing_lenses"
	| "verifying_evidence"
	| "synthesizing"
	| "red_teaming"
	| "adjudicating"
	| "planning"
	| "dispatching"
	| "executing"
	| "auditing_progress"
	| "verifying"
	| "auditing_completion"
	| "refining"
	| "failed"
	| "cancelled"
	| "complete";

export interface DaemonWorkflowBlockerProjection {
	readonly kind: "cancellation_reconciliation" | "phase_outcome" | "planner_continuity" | "awaiting_external";
	readonly reason: string;
	readonly blockerId?: string;
	readonly blockerDigest?: string;
	readonly owner?: "workflow_host" | "resource_host" | "capability_host" | "external";
	readonly resumeEventKind?: string;
	readonly resumePredicateDigest?: string;
	readonly nextEligibleAt?: string | null;
}

export interface DaemonWorkflowApprovalProjection {
	readonly approvalRequestId: string;
	readonly question: string;
	readonly expiresAt: string;
	readonly expectedResponseSequence: number;
	readonly headDigest: string;
	readonly stateDigest: string;
	readonly options: readonly {
		readonly optionId: string;
		readonly label: string;
		readonly effectDigest: string;
	}[];
}

export type DaemonWorkflowAttemptStatus =
	| "admitted"
	| "starting"
	| "running"
	| "awaiting_audit"
	| "reconciling"
	| "completed"
	| "needs_fix"
	| "blocked"
	| "failed"
	| "interrupted"
	| "cancelled"
	| "quarantined";

/** Safe attempt fields for status consumers; child identity and authority never cross this boundary. */
export interface DaemonWorkflowAttemptProjection {
	readonly taskId: string;
	readonly attemptId: string;
	readonly status: DaemonWorkflowAttemptStatus;
	readonly leaseExpiresAt?: string | null;
}

export type DaemonWorkflowLeaseKind = "progress" | "resource" | "ownership";
export type DaemonWorkflowLeaseStatus =
	| "reserved"
	| "active"
	| "release_pending"
	| "released"
	| "quarantined"
	| "expired";

/** Safe lease fields for status consumers; holder, capacity, paths, and auth material are excluded. */
export interface DaemonWorkflowLeaseProjection {
	readonly kind: DaemonWorkflowLeaseKind;
	readonly leaseId: string;
	readonly taskId?: string | null;
	readonly attemptId?: string | null;
	readonly status: DaemonWorkflowLeaseStatus;
	readonly expiresAt?: string | null;
}

/**
 * Safe, optional workflow metadata carried on daemon session summaries.
 *
 * The source provider must omit credentials, approval proofs, and trusted
 * principals. The head digest is an immutable journal identity, not an action
 * credential.
 */
export interface DaemonWorkflowStatusProjection {
	readonly workflowId: string | null;
	readonly status: DaemonWorkflowStatus;
	readonly phase: DaemonWorkflowPhase | null;
	readonly nextGate: string | null;
	readonly nextTask: string | null;
	readonly blocker: DaemonWorkflowBlockerProjection | null;
	readonly headDigest: string | null;
	readonly approvalRequest: DaemonWorkflowApprovalProjection | null;
	readonly attempts?: readonly DaemonWorkflowAttemptProjection[];
	readonly leases?: readonly DaemonWorkflowLeaseProjection[];
}

/** Synchronous seam used by the live session host to expose safe workflow metadata. */
export interface DaemonWorkflowStatusProjectionProvider {
	getWorkflowStatusProjection?: () => DaemonWorkflowStatusProjection | undefined;
}

// Upper bound on the spawn-code source carried in a session summary. Generous
// enough for real spawn cells while keeping the daemon wire payload bounded.
const SPAWN_CODE_MAX_CHARS = 4000;
const MAX_DATE_TIMESTAMP_MS = 8.64e15;
const MAX_WORKFLOW_ATTEMPTS = 128;
const MAX_WORKFLOW_LEASES = 128;

// Lightweight daemon session shape used by list, create, rename, attach, and state responses.
export interface SessionSummary {
	id: string;
	lifecycle: SessionLifecycle;
	activity: SessionActivity;
	isSessionActive: boolean;
	hasActiveHeartbeat?: boolean;
	/** Any active heartbeat registered for this session. Paused heartbeats do not pin residency. */
	hasRegisteredHeartbeat?: boolean;
	/** Any active or paused non-heartbeat scheduled job registered for this session. */
	hasRegisteredCronJob?: boolean;
	/** Earliest durable scheduler wake; its presence suppresses a false user-input verdict. */
	scheduledWake?: SessionScheduledWake;
	/** Latest message activity, used by the supervisor residency policy. */
	lastActivityAt?: string;
	runtimeKind?: "top-level" | "subagent";
	/** RLM spawn depth (0 for roots); fork edges preserve the source depth. */
	rlmDepth?: number;
	activeSessionId?: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	/** Optional backward-compatible host liveness projection for active compaction. */
	compactionLiveness?: AgentSessionCompactionLiveness;
	/** Optional backward-compatible host liveness projection for the provider stream. */
	providerStreamLiveness?: AgentSessionProviderStreamLiveness;
	/** Host-known stall classification; present until the next provider attempt. */
	providerStreamStallDiagnostic?: StreamLivenessDiagnostic;
	/** Host-owned invocation leases for tools with bounded forward-progress deadlines. */
	toolExecutionLiveness?: readonly ToolExecutionLiveness[];
	/** Host-known tool stall retained across session reopen. */
	toolExecutionStallDiagnostic?: ToolExecutionStallDiagnostic;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	/** True while the agent is streaming with tool calls pending; drives the "running tools" label. */
	isRunningTools?: boolean;
	attachedClients: number;
	messageCount: number;
	unfinishedActionCount?: number;
	sessionActions: SessionActionSnapshot;
	streamingMessage?: AgentMessage;
	created?: string;
	modified?: string;
	firstMessage?: string;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	rlmChildId?: string;
	repliedSinceTask?: boolean;
	rlmParentNodeId?: string;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	modelFallbackMessage?: string;
	diagnostics?: AgentSessionRuntimeDiagnostic[];
	/** One-line background summary of what the agent is doing or just did. */
	summary?: string;
	/** Completion verdict for an idle session; absent while working or unjudged. */
	taskState?: AgentTaskState;
	/** Host-owned provider resource blocker; it outranks any LLM recap/verdict. */
	resourceExhaustedBlocker?: ResourceExhaustedBlocker;
	/** Host-owned worker-model blocker; it outranks any LLM recap/verdict. */
	workerModelCapabilityBlocker?: WorkerModelCapabilityBlocker;
	/** Optional negotiated workflow phase/gate/blocker projection. */
	workflowStatus?: DaemonWorkflowStatusProjection;
	/** Resident session-host process state, populated by the global supervisor. */
	workerState?: "starting" | "ready" | "recovering" | "stopping" | "failed";
	/** Diagnostic process identity; clients must not use this as a stable session identifier. */
	workerPid?: number;
}

/**
 * Pick the model fallback message to show when attaching to a daemon session.
 *
 * The daemon's summary is authoritative. The attaching process's own startup
 * snapshot only applies when the summary reports no model: a UI process may
 * compute "no models available" merely because it cannot see credentials the
 * daemon resolves fine (e.g. an env var set only for the daemon).
 */
export function resolveAttachModelFallbackMessage(
	summary: SessionSummary,
	startupModelFallbackMessage: string | undefined,
): string | undefined {
	if (summary.modelFallbackMessage) {
		return summary.modelFallbackMessage;
	}
	return summary.model ? undefined : startupModelFallbackMessage;
}

export function classifySessionRosterStatus(summary: SessionSummary): SessionRosterStatus {
	if (!summary.activeSessionId) return "inactive";
	if (summary.hasActiveHeartbeat || summary.activity === "working" || isSessionSummaryBusy(summary)) return "running";
	return "idle";
}

export function isSessionSummaryBusy(summary: SessionSummary): boolean {
	return summary.isSessionActive || summary.hasRunningRlmChildren === true;
}

export function buildSessionList(
	activeSessions: readonly ActiveSessionState[],
	savedSessions: readonly SessionInfo[],
	scheduledJobs: readonly AgentCronJob[] = [],
): SessionSummary[] {
	const activeBySessionFile = new Map<string, ActiveSessionState>();
	const heartbeatSessionIds = new Set<string>();
	const registeredHeartbeatSessionIds = new Set<string>();
	const registeredCronSessionIds = new Set<string>();
	const registeredHeartbeatSessionFiles = new Set<string>();
	const registeredCronSessionFiles = new Set<string>();
	const scheduledWakeBySessionId = new Map<string, SessionScheduledWake>();
	const scheduledWakeBySessionFile = new Map<string, SessionScheduledWake>();
	for (const job of scheduledJobs) {
		const heartbeat = isHeartbeatCronJob(job);
		if (heartbeat && job.status === "active") heartbeatSessionIds.add(job.activeSessionId);
		// A paused heartbeat cannot fire, so unlike a live heartbeat (or a registered
		// cron job) it must not silently pin a worker forever.
		const registered = heartbeat ? job.status === "active" : job.status === "active" || job.status === "paused";
		if (!registered) continue;
		const ids = heartbeat ? registeredHeartbeatSessionIds : registeredCronSessionIds;
		const files = heartbeat ? registeredHeartbeatSessionFiles : registeredCronSessionFiles;
		ids.add(job.activeSessionId);
		const sessionFile = resolve(job.sessionFile);
		files.add(sessionFile);
		const scheduledWake = scheduledWakeForJob(job);
		if (scheduledWake !== undefined) {
			recordEarlierScheduledWake(scheduledWakeBySessionId, job.activeSessionId, scheduledWake);
			recordEarlierScheduledWake(scheduledWakeBySessionFile, sessionFile, scheduledWake);
		}
	}

	for (const activeSession of activeSessions) {
		const sessionFile = activeSession.runtime.session.sessionFile;
		if (sessionFile) {
			activeBySessionFile.set(resolve(sessionFile), activeSession);
		}
	}

	const entries: SessionSummary[] = [];
	const seenActiveSessionIds = new Set<string>();
	for (const savedSession of savedSessions) {
		const sessionFile = resolve(savedSession.path);
		const activeSession = activeBySessionFile.get(sessionFile);
		if (activeSession) {
			entries.push(
				summaryForActiveSession(
					activeSession,
					savedSession,
					heartbeatSessionIds.has(activeSession.activeSessionId),
					registeredHeartbeatSessionIds.has(activeSession.activeSessionId) ||
						registeredHeartbeatSessionFiles.has(sessionFile),
					registeredCronSessionIds.has(activeSession.activeSessionId) ||
						registeredCronSessionFiles.has(sessionFile),
					scheduledWakeBySessionId.get(activeSession.activeSessionId) ??
						scheduledWakeBySessionFile.get(sessionFile),
				),
			);
			seenActiveSessionIds.add(activeSession.activeSessionId);
			continue;
		}
		entries.push(
			summaryForInactiveSession(
				savedSession,
				registeredHeartbeatSessionFiles.has(sessionFile),
				registeredCronSessionFiles.has(sessionFile),
				scheduledWakeBySessionFile.get(sessionFile),
			),
		);
	}

	for (const activeSession of activeSessions) {
		if (!seenActiveSessionIds.has(activeSession.activeSessionId)) {
			const sessionFile = activeSession.runtime.session.sessionFile;
			const resolvedSessionFile = sessionFile ? resolve(sessionFile) : undefined;
			entries.push(
				summaryForActiveSession(
					activeSession,
					undefined,
					heartbeatSessionIds.has(activeSession.activeSessionId),
					registeredHeartbeatSessionIds.has(activeSession.activeSessionId) ||
						(resolvedSessionFile !== undefined && registeredHeartbeatSessionFiles.has(resolvedSessionFile)),
					registeredCronSessionIds.has(activeSession.activeSessionId) ||
						(resolvedSessionFile !== undefined && registeredCronSessionFiles.has(resolvedSessionFile)),
					scheduledWakeBySessionId.get(activeSession.activeSessionId) ??
						(resolvedSessionFile === undefined ? undefined : scheduledWakeBySessionFile.get(resolvedSessionFile)),
				),
			);
		}
	}
	return entries;
}

export function summaryForActiveSession(
	activeSession: ActiveSessionState,
	savedSession?: SessionInfo,
	hasActiveHeartbeat = false,
	hasRegisteredHeartbeat = hasActiveHeartbeat,
	hasRegisteredCronJob = false,
	scheduledWake?: SessionScheduledWake,
): SessionSummary {
	const session = activeSession.runtime.session;
	const workflowStatus = (
		session as typeof session & DaemonWorkflowStatusProjectionProvider
	).getWorkflowStatusProjection?.();
	const resourceExhaustedBlocker = session.getResourceExhaustedBlocker?.();
	const workerModelCapabilityBlocker = session.getWorkerModelCapabilityBlocker?.();
	const sessionInputWakeInvariantViolation = session.sessionInputWakeInvariantViolation;
	const providerStreamLiveness = session.getProviderStreamLiveness?.();
	const providerStreamStallDiagnostic = session.getProviderStreamStallDiagnostic?.();
	const toolExecutionLiveness = session.getToolExecutionLiveness?.() ?? [];
	const toolExecutionStallDiagnostic = session.getToolExecutionStallDiagnostic?.();
	const metadata = activeSession.runtime.metadata ?? { kind: "top-level" as const };
	let modified = savedSession?.modified.toISOString();
	if (!modified && session.sessionFile) {
		try {
			modified = statSync(session.sessionFile).mtime.toISOString();
		} catch {
			// Leave age blank when the active session has not flushed a jsonl yet.
		}
	}

	return {
		id: activeSession.activeSessionId,
		lifecycle: activeLifecycleForSession(activeSession),
		activity: activeActivityForSession(activeSession),
		isSessionActive: session.isSessionActive,
		hasActiveHeartbeat: hasActiveHeartbeat || undefined,
		hasRegisteredHeartbeat: hasRegisteredHeartbeat || undefined,
		hasRegisteredCronJob: hasRegisteredCronJob || undefined,
		scheduledWake,
		lastActivityAt:
			latestMessageActivityAt(session.messages) ?? modified ?? session.sessionManager.getHeader?.()?.timestamp,
		runtimeKind: metadata.kind,
		rlmDepth: session.rlmDepth,
		activeSessionId: activeSession.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		compactionLiveness: session.getCompactionLiveness?.(),
		providerStreamLiveness,
		providerStreamStallDiagnostic,
		toolExecutionLiveness,
		toolExecutionStallDiagnostic,
		isBashRunning: session.isBashRunning,
		hasRunningRlmChildren: session.hasRunningRlmChildren(),
		isRunningTools: toolExecutionLiveness.length > 0,
		attachedClients: activeSession.clients.size,
		messageCount: session.messages.length,
		unfinishedActionCount: session.unfinishedActionCount,
		sessionActions: session.getSessionActionSnapshot(),
		streamingMessage: session.state.streamingMessage,
		created: savedSession?.created.toISOString() ?? session.sessionManager.getHeader?.()?.timestamp,
		modified,
		// Subagent sessions live in artifact dirs that the saved-session scan
		// never sees; their spawn prompt is the most identifying title we have.
		// A freshly created top-level session has neither yet — its jsonl is not
		// scanned until it flushes — so derive from the live first user message to
		// avoid titling the chat with its session ID until the file lands.
		firstMessage:
			savedSession?.firstMessage ??
			(metadata.prompt ? compactRlmText(metadata.prompt, 120) : undefined) ??
			firstUserMessageText(session),
		parentActiveSessionId: metadata.parentActiveSessionId,
		parentSessionId: metadata.parentSessionId,
		parentSessionPath: savedSession?.parentSessionPath ?? metadata.parentSessionFile,
		rlmChildId: metadata.rlmChildId,
		...(metadata.kind === "subagent" && session.repliedToParentSinceTask !== undefined
			? { repliedSinceTask: session.repliedToParentSinceTask }
			: {}),
		rlmParentNodeId: metadata.rlmParentNodeId,
		// Cap the cell source so the summary stays small on the daemon wire; the
		// agents view truncates further for display.
		spawnCode: metadata.spawnCode ? metadata.spawnCode.slice(0, SPAWN_CODE_MAX_CHARS) : undefined,
		modelFallbackMessage: activeSession.runtime.modelFallbackMessage,
		diagnostics: [
			...activeSession.runtime.diagnostics,
			...(sessionInputWakeInvariantViolation === "queued_without_wake"
				? [
						{
							type: "error" as const,
							message: "queued_without_wake: selectable agent message has no scheduler wake or drain owner",
						},
					]
				: []),
			...(providerStreamStallDiagnostic
				? [
						{
							type: "error" as const,
							message: `provider_stream_stalled: ${providerStreamStallDiagnostic.phase}/${providerStreamStallDiagnostic.reason}`,
						},
					]
				: []),
			...(toolExecutionStallDiagnostic
				? [
						{
							type: "error" as const,
							message: `tool_execution_stalled: ${toolExecutionStallDiagnostic.toolName}/${toolExecutionStallDiagnostic.reason}`,
						},
					]
				: []),
		],
		// Keep the last recap visible across turns so the view never blanks, but
		// gate the verdict on currency: a stale "completed" must not show on a turn
		// that is active again.
		summary: workerModelCapabilityBlocker
			? workerModelCapabilityBlocker.summary.text
			: resourceExhaustedBlocker
				? "Provider resource limit reached"
				: sessionInputWakeInvariantViolation === "queued_without_wake"
					? "Invariant violation: queued_without_wake"
					: providerStreamStallDiagnostic
						? "Provider stream stalled"
						: toolExecutionStallDiagnostic
							? "Tool execution stalled"
							: activeSession.summaryState?.summary,
		...(workerModelCapabilityBlocker
			? {
					taskState: "blocked_model_capability" as const,
					workerModelCapabilityBlocker: projectWorkerModelCapabilityBlocker(workerModelCapabilityBlocker),
				}
			: resourceExhaustedBlocker
				? { taskState: "resource_exhausted" as const, resourceExhaustedBlocker }
				: sessionInputWakeInvariantViolation === "queued_without_wake"
					? {}
					: providerStreamStallDiagnostic
						? {}
						: toolExecutionStallDiagnostic
							? {}
							: scheduledWake !== undefined
								? {}
								: isSummaryCurrent(activeSession) && !isActiveSessionBusy(activeSession)
									? { taskState: activeSession.summaryState?.taskState }
									: {}),
		...(workflowStatus ? { workflowStatus: cloneWorkflowStatusProjection(workflowStatus) } : {}),
	};
}

/** Remove optional workflow metadata when a client did not negotiate its capability. */
export function projectSessionSummaryForClient(
	summary: SessionSummary,
	includeWorkflowStatus: boolean,
): SessionSummary {
	if (includeWorkflowStatus || summary.workflowStatus === undefined) {
		return summary;
	}
	const { workflowStatus: _workflowStatus, ...legacySummary } = summary;
	return legacySummary;
}

function cloneWorkflowStatusProjection(projection: DaemonWorkflowStatusProjection): DaemonWorkflowStatusProjection {
	return {
		workflowId: projection.workflowId,
		status: projection.status,
		phase: projection.phase,
		nextGate: projection.nextGate,
		nextTask: projection.nextTask,
		headDigest: projection.headDigest,
		blocker: projection.blocker
			? {
					kind: projection.blocker.kind,
					reason: projection.blocker.reason,
					...(projection.blocker.blockerId ? { blockerId: projection.blocker.blockerId } : {}),
					...(projection.blocker.blockerDigest ? { blockerDigest: projection.blocker.blockerDigest } : {}),
					...(projection.blocker.owner ? { owner: projection.blocker.owner } : {}),
					...(projection.blocker.resumeEventKind ? { resumeEventKind: projection.blocker.resumeEventKind } : {}),
					...(projection.blocker.resumePredicateDigest
						? { resumePredicateDigest: projection.blocker.resumePredicateDigest }
						: {}),
					...(projection.blocker.nextEligibleAt !== undefined
						? { nextEligibleAt: projection.blocker.nextEligibleAt }
						: {}),
				}
			: null,
		approvalRequest: projection.approvalRequest
			? {
					approvalRequestId: projection.approvalRequest.approvalRequestId,
					question: projection.approvalRequest.question,
					expiresAt: projection.approvalRequest.expiresAt,
					expectedResponseSequence: projection.approvalRequest.expectedResponseSequence,
					headDigest: projection.approvalRequest.headDigest,
					stateDigest: projection.approvalRequest.stateDigest,
					options: projection.approvalRequest.options.map(({ optionId, label, effectDigest }) => ({
						optionId,
						label,
						effectDigest,
					})),
				}
			: null,
		...(projection.attempts !== undefined
			? {
					attempts: projection.attempts.slice(0, MAX_WORKFLOW_ATTEMPTS).map((attempt) => ({
						taskId: attempt.taskId,
						attemptId: attempt.attemptId,
						status: attempt.status,
						...(attempt.leaseExpiresAt !== undefined ? { leaseExpiresAt: attempt.leaseExpiresAt } : {}),
					})),
				}
			: {}),
		...(projection.leases !== undefined
			? {
					leases: projection.leases.slice(0, MAX_WORKFLOW_LEASES).map((lease) => ({
						kind: lease.kind,
						leaseId: lease.leaseId,
						...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
						...(lease.attemptId !== undefined ? { attemptId: lease.attemptId } : {}),
						status: lease.status,
						...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
					})),
				}
			: {}),
	};
}

function latestMessageActivityAt(messages: readonly AgentMessage[]): string | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		// Tool results and custom messages are real session activity too. Looking at
		// every timestamp also keeps this correct for future AgentMessage variants.
		if (
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp) &&
			Math.abs(message.timestamp) <= MAX_DATE_TIMESTAMP_MS
		) {
			latest = latest === undefined ? message.timestamp : Math.max(latest, message.timestamp);
		}
	}
	return latest === undefined ? undefined : new Date(latest).toISOString();
}

export function isSummaryCurrent(activeSession: ActiveSessionState): boolean {
	const status = activeSession.summaryState;
	return status !== undefined && status.basedOnMessageCount === activeSession.runtime.session.messages.length;
}

export function summaryForInactiveSession(
	session: SessionInfo,
	hasRegisteredHeartbeat = false,
	hasRegisteredCronJob = false,
	scheduledWake?: SessionScheduledWake,
): SessionSummary {
	return {
		id: session.id,
		lifecycle: inactiveLifecycleForSession(session),
		activity: "idle",
		isSessionActive: false,
		hasRegisteredHeartbeat: hasRegisteredHeartbeat || undefined,
		hasRegisteredCronJob: hasRegisteredCronJob || undefined,
		scheduledWake,
		sessionId: session.id,
		sessionFile: session.path,
		sessionName: session.name,
		cwd: session.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: session.messageCount,
		unfinishedActionCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		lastActivityAt: session.modified.toISOString(),
		firstMessage: session.firstMessage,
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		providerStreamStallDiagnostic: session.providerStreamStallDiagnostic,
		toolExecutionStallDiagnostic: session.toolExecutionStallDiagnostic,
		diagnostics:
			session.providerStreamStallDiagnostic || session.toolExecutionStallDiagnostic
				? [
						...(session.providerStreamStallDiagnostic
							? [
									{
										type: "error" as const,
										message: `provider_stream_stalled: ${session.providerStreamStallDiagnostic.phase}/${session.providerStreamStallDiagnostic.reason}`,
									},
								]
							: []),
						...(session.toolExecutionStallDiagnostic
							? [
									{
										type: "error" as const,
										message: `tool_execution_stalled: ${session.toolExecutionStallDiagnostic.toolName}/${session.toolExecutionStallDiagnostic.reason}`,
									},
								]
							: []),
					]
				: undefined,
		// Carry the persisted recap/verdict so an off-daemon session keeps its
		// agents-view bucket (e.g. Completed) instead of defaulting to Needs Input.
		// Gate on message-count currency like isSummaryCurrent does for resident
		// sessions, so a verdict from before later messages isn't shown stale.
		...(session.workerModelCapabilityBlocker
			? {
					summary: session.workerModelCapabilityBlocker.summary.text,
					taskState: "blocked_model_capability" as const,
					workerModelCapabilityBlocker: projectWorkerModelCapabilityBlocker(session.workerModelCapabilityBlocker),
				}
			: session.resourceExhaustedBlocker
				? {
						summary: "Provider resource limit reached",
						taskState: "resource_exhausted" as const,
						resourceExhaustedBlocker: projectResourceExhaustedBlocker(session.resourceExhaustedBlocker),
					}
				: session.providerStreamStallDiagnostic
					? { summary: "Provider stream stalled" }
					: session.toolExecutionStallDiagnostic
						? { summary: "Tool execution stalled" }
						: scheduledWake !== undefined
							? { summary: session.agentStatus?.summary }
							: session.agentStatus?.basedOnMessageCount === session.messageCount
								? {
										summary: session.agentStatus.summary,
										taskState: session.agentStatus.taskState,
									}
								: {}),
	};
}

function scheduledWakeForJob(job: AgentCronJob): SessionScheduledWake | undefined {
	if (job.status !== "active" || job.nextRunAt === undefined || !Number.isFinite(Date.parse(job.nextRunAt)))
		return undefined;
	return {
		owner: "daemon_cron",
		jobId: job.id,
		source: job.source ?? "cron",
		nextRunAt: job.nextRunAt,
	};
}

function recordEarlierScheduledWake(
	target: Map<string, SessionScheduledWake>,
	key: string,
	candidate: SessionScheduledWake,
): void {
	const current = target.get(key);
	if (current === undefined || Date.parse(candidate.nextRunAt) < Date.parse(current.nextRunAt))
		target.set(key, candidate);
}

/**
 * Build snapshots for all RLM child sessions hosted by the daemon under the
 * given session, including grandchildren. Mirrors the shape of live
 * rlm_child_update events so attach clients can seed their subagent state
 * from daemon memory instead of replaying the event stream.
 */
export function buildRlmChildSnapshots(
	rootActiveSessionId: string,
	activeSessions: readonly ActiveSessionState[],
): AgentConnectionRlmChildAgentSnapshot[] {
	const childrenByParent = new Map<string, ActiveSessionState[]>();
	for (const candidate of activeSessions) {
		const metadata = candidate.runtime.metadata;
		if (metadata.kind !== "subagent" || !metadata.parentActiveSessionId) {
			continue;
		}
		const siblings = childrenByParent.get(metadata.parentActiveSessionId) ?? [];
		siblings.push(candidate);
		childrenByParent.set(metadata.parentActiveSessionId, siblings);
	}

	const snapshots: AgentConnectionRlmChildAgentSnapshot[] = [];
	const visit = (parent: ActiveSessionState | undefined, parentActiveSessionId: string): void => {
		const parentNodeId = parent?.runtime.metadata.rlmChildId;
		for (const child of childrenByParent.get(parentActiveSessionId) ?? []) {
			snapshots.push(rlmChildSnapshotForActiveSession(child, child.runtime.metadata, parentNodeId, parent));
			// A child passes its own node id to its children as their parent id.
			visit(child, child.activeSessionId);
		}
	};
	const root = activeSessions.find((candidate) => candidate.activeSessionId === rootActiveSessionId);
	visit(root, rootActiveSessionId);
	return snapshots;
}

function rlmChildSnapshotForActiveSession(
	activeSession: ActiveSessionState,
	metadata: AgentSessionRuntimeMetadata,
	parentNodeId: string | undefined,
	parent: ActiveSessionState | undefined,
): AgentConnectionRlmChildAgentSnapshot {
	const session = activeSession.runtime.session;
	let answerPreview: string | undefined;
	let toolUseCount = 0;
	const messages =
		session.state.streamingMessage?.role === "assistant"
			? [...session.messages, session.state.streamingMessage]
			: session.messages;
	for (const message of messages) {
		if (message.role === "assistant") {
			const text = compactRlmText(readMessageText(message.content));
			if (text) {
				answerPreview = text;
			}
			toolUseCount += message.content.filter((block) => block.type === "toolCall").length;
		}
	}
	// The parent session's run tracker is the source of truth for child status;
	// a daemon-hosted child whose agent is momentarily idle is still part of an
	// active run. The streaming heuristic only covers parents the daemon does
	// not host (e.g. children attributed to a session created by an older build).
	const runStatus = metadata.rlmChildId
		? parent?.runtime.session.getRlmChildRunStatus(metadata.rlmChildId)
		: undefined;
	const status = runStatus ?? (session.isSessionActive ? "running" : "done");
	const isActive = status === "running" || session.isSessionActive;
	return {
		id: metadata.rlmChildId ?? activeSession.activeSessionId,
		parentId: parentNodeId,
		activeSessionId: activeSession.activeSessionId,
		sessionName: session.sessionName,
		model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
		label: rlmChildLabel(metadata.prompt ?? ""),
		status,
		answerPreview,
		toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
		tokenCount: session._contextTokensForCurrentMessages(),
		recap: session.getCurrentRecap(),
		sessionDir: metadata.sessionDir ?? session.sessionManager.getSessionDir(),
		activity: isActive ? { kind: session.isStreaming ? "writing" : "waiting" } : undefined,
	};
}

function firstUserMessageText(session: ActiveSessionState["runtime"]["session"]): string | undefined {
	for (const message of session.messages) {
		if (message.role !== "user") {
			continue;
		}
		const text = compactRlmText(readMessageText(message.content), 120).trim();
		if (text) {
			return text;
		}
	}
	return undefined;
}

function readMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

// Agent doing work, ignoring the classification verdict.
export function isActiveSessionBusy(activeSession: ActiveSessionState): boolean {
	const session = activeSession.runtime.session;
	// Background subagents keep the parent "working" even after its own turn ends.
	return session.isSessionActive || session.hasRunningRlmChildren();
}

export function activeActivityForSession(activeSession: ActiveSessionState): SessionActivity {
	if (isActiveSessionBusy(activeSession)) {
		return "working";
	}
	// A finished subagent is resident but never gets a summarizer verdict, so don't hold
	// it at "working" waiting for one — a not-busy subagent is simply idle/done.
	if (activeSession.runtime.metadata?.kind === "subagent") {
		return "idle";
	}
	// Hold at "working" until the idle verdict is current, so the view never
	// buckets an unlabeled idle session.
	return isSummaryCurrent(activeSession) ? "idle" : "working";
}

/**
 * Lifecycle for an on-disk session not resident in the daemon. Explicitly
 * archived/crashed records stay out of the view; everything else is classified
 * by message count (live once a message exists, draft otherwise). A missing
 * session_state is treated as not-archived, so older sessions that never wrote a
 * lifecycle entry still surface. Message-based to match activeLifecycleForSession.
 */
export function inactiveLifecycleForSession(session: SessionInfo): SessionLifecycle {
	const status = session.state?.status;
	if (status === "archived" || status === "crash") {
		return "archived";
	}
	return session.messageCount > 0 ? "live" : "draft";
}

export function activeLifecycleForSession(activeSession: ActiveSessionState): SessionLifecycle {
	// Lifecycle drives agents-view visibility and is message-based: a session
	// becomes live once a message is sent. A message-less session is a draft (hidden
	// from the view) even if the user changed its model/name first — that config is
	// still preserved on disk by the discard guard (see isEmptyDraftContent), it
	// just doesn't surface a conversation-less row. Keeping this purely message-based
	// matches inactiveLifecycleForSession, so a session doesn't change lifecycle when
	// it leaves daemon memory. Stale on-disk archived/crash markers never apply to a
	// resident session.
	return activeSession.runtime.session.messages.length === 0 ? "draft" : "live";
}
