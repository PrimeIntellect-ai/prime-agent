import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compactRlmText } from "../../core/agent-session.js";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import { type AgentCronJob, isHeartbeatCronJob } from "../../core/cron-jobs.js";
import type { SessionActionSnapshot } from "../../core/session-action-store.js";
import type { AgentStatus, AgentTaskState, SessionInfo } from "../../core/session-manager.js";
import type { SessionUsageSummary } from "../../core/usage.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import type { ActiveSessionState } from "./active-session-state.js";

import { type AgentRosterStatus, isSessionSummaryBusy } from "./agent-roster.js";

export { classifySessionRosterStatus, isSessionSummaryBusy } from "./agent-roster.js";

// Durable lifecycle; decides agents-view visibility. Only "live" is shown.
// "draft" = no message sent yet (discarded on close); "archived" = ctrl+x'd,
// reachable only via --resume <selector>.
export type SessionLifecycle = "draft" | "live" | "archived";

// Heuristic activity of a live session. Classification-in-flight counts as
// "working" so the view never sees an unlabeled idle session.
export type SessionActivity = "working" | "idle";

// Upper bound on the spawn-code source carried in a session summary. Generous
// enough for real spawn cells while keeping the daemon wire payload bounded.
const SPAWN_CODE_MAX_CHARS = 4000;
const MAX_DATE_TIMESTAMP_MS = 8.64e15;

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
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	usage?: SessionUsageSummary;
	/** True while the agent is streaming with tool calls pending; drives the "running tools" label. */
	isRunningTools?: boolean;
	attachedClients: number;
	/** Clients attached over the direct worker transport; the supervisor adds these to its own count. */
	directAttachedClients?: number;
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
	/** Source of the Python cell that spawned this subagent, for display. */
	spawnCode?: string;
	modelFallbackMessage?: string;
	diagnostics?: AgentSessionRuntimeDiagnostic[];
	/** One-line background summary of what the agent is doing or just did. */
	summary?: string;
	/** Completion verdict for an idle session; absent while working or unjudged. */
	taskState?: AgentTaskState;
	rosterStatus?: AgentRosterStatus;
	statusLabel?: "queued" | "recovering" | "failed";
	/** Set while the owning worker has been silent past the staleness threshold. */
	lastHeardFromAt?: string;
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

export function scheduledJobRegistrations(scheduledJobs: readonly AgentCronJob[]): {
	activeHeartbeatSessionIds: Set<string>;
	heartbeatSessionIds: Set<string>;
	cronSessionIds: Set<string>;
	heartbeatSessionFiles: Set<string>;
	cronSessionFiles: Set<string>;
} {
	const activeHeartbeatSessionIds = new Set<string>();
	const heartbeatSessionIds = new Set<string>();
	const cronSessionIds = new Set<string>();
	const heartbeatSessionFiles = new Set<string>();
	const cronSessionFiles = new Set<string>();
	for (const job of scheduledJobs) {
		const heartbeat = isHeartbeatCronJob(job);
		if (heartbeat && job.status === "active") activeHeartbeatSessionIds.add(job.activeSessionId);
		// A paused heartbeat cannot fire, so unlike a live heartbeat (or a registered
		// cron job) it must not silently pin a worker forever.
		const registered = heartbeat ? job.status === "active" : job.status === "active" || job.status === "paused";
		if (!registered) continue;
		(heartbeat ? heartbeatSessionIds : cronSessionIds).add(job.activeSessionId);
		(heartbeat ? heartbeatSessionFiles : cronSessionFiles).add(resolve(job.sessionFile));
	}
	return { activeHeartbeatSessionIds, heartbeatSessionIds, cronSessionIds, heartbeatSessionFiles, cronSessionFiles };
}

/** Naming signals intent to return, so named sessions are exempt even when empty. */
export function isEvictableEmptySessionSummary(summary: SessionSummary): boolean {
	return (
		summary.messageCount === 0 &&
		!summary.sessionName &&
		!isSessionSummaryBusy(summary) &&
		summary.hasRegisteredCronJob !== true
	);
}

export function buildSessionList(
	activeSessions: readonly ActiveSessionState[],
	savedSessions: readonly SessionInfo[],
	scheduledJobs: readonly AgentCronJob[] = [],
): SessionSummary[] {
	const activeBySessionFile = new Map<string, ActiveSessionState>();
	const {
		activeHeartbeatSessionIds: heartbeatSessionIds,
		heartbeatSessionIds: registeredHeartbeatSessionIds,
		cronSessionIds: registeredCronSessionIds,
		heartbeatSessionFiles: registeredHeartbeatSessionFiles,
		cronSessionFiles: registeredCronSessionFiles,
	} = scheduledJobRegistrations(scheduledJobs);

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
				),
			);
		}
	}
	return entries;
}

// Compose memos, keyed weakly by session state so entries die with the session.
// Roster flushes re-compose every active session summary on every event; with
// large sessions that meant a full message walk plus a full compose plus a
// serialize per session per flush. The activity memo keeps the timestamp scan
// incremental, and the fingerprint memo returns the last composed summary
// (same object) whenever every input that feeds it is unchanged.
const messageActivityMemos = new WeakMap<ActiveSessionState, MessageActivityMemo>();
const summaryComposeMemos = new WeakMap<
	ActiveSessionState,
	{ fingerprint: SummaryComposeFingerprint; summary: SessionSummary }
>();

/**
 * Cheap snapshot of every summary input; any difference forces a fresh compose.
 *
 * Leaf id and message count alone are not a sufficient key: isStreaming,
 * isBashRunning, isCompacting, attachment counts, the summary verdict, and the
 * heartbeat/cron flags all change without a single append, and the daemon
 * schedules roster flushes at exactly those edges. Comparing the full input set
 * keeps the memoized summary byte-identical to a fresh compose.
 */
interface SummaryComposeFingerprint {
	// Caller inputs: registration flags vary per compose site, and the saved
	// catalog entry (when present) feeds created/modified/firstMessage/parentSessionPath.
	hasActiveHeartbeat: boolean;
	hasRegisteredHeartbeat: boolean;
	hasRegisteredCronJob: boolean;
	savedSession: SessionInfo | undefined;
	// Busy-state bits flip without appends (turn, bash, compaction, tool edges).
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
	pendingToolCallsSize: number;
	isSessionActive: boolean;
	hasRunningRlmChildren: boolean;
	unfinishedActionCount: number;
	attachedClients: number;
	directAttachedClients: number;
	messageCount: number;
	// References: memoized upstream (usage), replaced on change (model,
	// summaryState, streamingMessage), or structural (sessionActions,
	// diagnostics: post-construction changes replace the array or append).
	usage: SessionUsageSummary | undefined;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	streamingMessage: AgentMessage | undefined;
	summaryState: AgentStatus | undefined;
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	repliedSinceTask: boolean | undefined;
	sessionActions: SessionActionSnapshot;
	// Identity and display inputs: the metadata getter returns a fresh copy on
	// every read, so its summary-relevant fields compare by value.
	metadataKind: string;
	metadataParentActiveSessionId: string | undefined;
	metadataParentSessionId: string | undefined;
	metadataParentSessionFile: string | undefined;
	metadataRlmChildId: string | undefined;
	metadataRlmParentNodeId: string | undefined;
	sessionName: string | undefined;
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	rlmDepth: number | undefined;
	modelFallbackMessage: string | undefined;
	// Values computed once per attempt and shared with the compose.
	headerTimestamp: string | undefined;
	modified: string | undefined;
	lastActivityAt: string | undefined;
	firstMessage: string | undefined;
}

export function summaryForActiveSession(
	activeSession: ActiveSessionState,
	savedSession?: SessionInfo,
	hasActiveHeartbeat = false,
	hasRegisteredHeartbeat = hasActiveHeartbeat,
	hasRegisteredCronJob = false,
): SessionSummary {
	const session = activeSession.runtime.session;
	const metadata = activeSession.runtime.metadata ?? { kind: "top-level" as const };
	let modified = savedSession?.modified.toISOString();
	if (!modified && session.sessionFile) {
		try {
			modified = statSync(session.sessionFile).mtime.toISOString();
		} catch {
			// Leave age blank when the active session has not flushed a jsonl yet.
		}
	}

	const directAttachedClients = [...activeSession.clients].filter(
		(client) => client.authenticationRole === "session_client",
	).length;
	// The activity memo folds only messages appended since the last scan.
	let activityMemo = messageActivityMemos.get(activeSession);
	if (activityMemo === undefined) {
		activityMemo = { source: undefined, scannedLength: 0, tailRef: undefined, latest: undefined };
		messageActivityMemos.set(activeSession, activityMemo);
	}
	const headerTimestamp = session.sessionManager.getHeader?.()?.timestamp;
	const lastActivityAt = latestMessageActivityAt(session.messages, activityMemo) ?? modified ?? headerTimestamp;
	// Subagent sessions live in artifact dirs that the saved-session scan
	// never sees; their spawn prompt is the most identifying title we have.
	// A freshly created top-level session has neither yet — its jsonl is not
	// scanned until it flushes — so derive from the live first user message to
	// avoid titling the chat with its session ID until the file lands.
	const firstMessage =
		savedSession?.firstMessage ??
		(metadata.prompt ? compactRlmText(metadata.prompt, 120) : undefined) ??
		firstUserMessageText(session);

	const fingerprint: SummaryComposeFingerprint = {
		hasActiveHeartbeat,
		hasRegisteredHeartbeat,
		hasRegisteredCronJob,
		savedSession,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		isBashRunning: session.isBashRunning,
		pendingToolCallsSize: session.state.pendingToolCalls.size,
		isSessionActive: session.isSessionActive,
		hasRunningRlmChildren: session.hasRunningRlmChildren(),
		unfinishedActionCount: session.unfinishedActionCount,
		attachedClients: activeSession.clients.size,
		directAttachedClients,
		messageCount: session.messages.length,
		usage: session.getOwnUsageSummary?.(),
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		streamingMessage: session.state.streamingMessage,
		summaryState: activeSession.summaryState,
		diagnostics: activeSession.runtime.diagnostics,
		repliedSinceTask: metadata.kind === "subagent" ? session.repliedToParentSinceTask : undefined,
		sessionActions: session.getSessionActionSnapshot(),
		metadataKind: metadata.kind,
		metadataParentActiveSessionId: metadata.parentActiveSessionId,
		metadataParentSessionId: metadata.parentSessionId,
		metadataParentSessionFile: metadata.parentSessionFile,
		metadataRlmChildId: metadata.rlmChildId,
		metadataRlmParentNodeId: metadata.rlmParentNodeId,
		sessionName: session.sessionName,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: session.sessionManager.getCwd(),
		rlmDepth: session.rlmDepth,
		modelFallbackMessage: activeSession.runtime.modelFallbackMessage,
		headerTimestamp,
		modified,
		lastActivityAt,
		firstMessage,
	};

	const memo = summaryComposeMemos.get(activeSession);
	if (memo && summaryComposeFingerprintsEqual(memo.fingerprint, fingerprint)) {
		return memo.summary;
	}

	const summary: SessionSummary = {
		id: activeSession.activeSessionId,
		lifecycle: activeLifecycleForSession(activeSession),
		activity: activeActivityForSession(activeSession),
		isSessionActive: session.isSessionActive,
		hasActiveHeartbeat: hasActiveHeartbeat || undefined,
		hasRegisteredHeartbeat: hasRegisteredHeartbeat || undefined,
		hasRegisteredCronJob: hasRegisteredCronJob || undefined,
		lastActivityAt,
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
		isBashRunning: session.isBashRunning,
		hasRunningRlmChildren: session.hasRunningRlmChildren(),
		usage: session.getOwnUsageSummary?.(),
		isRunningTools: session.isStreaming && session.state.pendingToolCalls.size > 0,
		attachedClients: activeSession.clients.size,
		...(directAttachedClients > 0 ? { directAttachedClients } : {}),
		messageCount: session.messages.length,
		unfinishedActionCount: session.unfinishedActionCount,
		sessionActions: session.getSessionActionSnapshot(),
		streamingMessage: session.state.streamingMessage,
		created: savedSession?.created.toISOString() ?? headerTimestamp,
		modified,
		firstMessage,
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
		diagnostics: [...activeSession.runtime.diagnostics],
		// Keep the last recap visible across turns so the view never blanks, but
		// gate the verdict on currency: a stale "completed" must not show on a turn
		// that is active again.
		summary: activeSession.summaryState?.summary,
		...(isSummaryCurrent(activeSession) ? { taskState: activeSession.summaryState?.taskState } : {}),
	};
	summaryComposeMemos.set(activeSession, { fingerprint, summary });
	return summary;
}

function summaryComposeFingerprintsEqual(left: SummaryComposeFingerprint, right: SummaryComposeFingerprint): boolean {
	return (
		left.hasActiveHeartbeat === right.hasActiveHeartbeat &&
		left.hasRegisteredHeartbeat === right.hasRegisteredHeartbeat &&
		left.hasRegisteredCronJob === right.hasRegisteredCronJob &&
		left.savedSession === right.savedSession &&
		left.isStreaming === right.isStreaming &&
		left.isCompacting === right.isCompacting &&
		left.isBashRunning === right.isBashRunning &&
		left.pendingToolCallsSize === right.pendingToolCallsSize &&
		left.isSessionActive === right.isSessionActive &&
		left.hasRunningRlmChildren === right.hasRunningRlmChildren &&
		left.unfinishedActionCount === right.unfinishedActionCount &&
		left.attachedClients === right.attachedClients &&
		left.directAttachedClients === right.directAttachedClients &&
		left.messageCount === right.messageCount &&
		left.usage === right.usage &&
		left.model === right.model &&
		left.thinkingLevel === right.thinkingLevel &&
		left.streamingMessage === right.streamingMessage &&
		left.summaryState === right.summaryState &&
		left.repliedSinceTask === right.repliedSinceTask &&
		left.metadataKind === right.metadataKind &&
		left.metadataParentActiveSessionId === right.metadataParentActiveSessionId &&
		left.metadataParentSessionId === right.metadataParentSessionId &&
		left.metadataParentSessionFile === right.metadataParentSessionFile &&
		left.metadataRlmChildId === right.metadataRlmChildId &&
		left.metadataRlmParentNodeId === right.metadataRlmParentNodeId &&
		left.sessionName === right.sessionName &&
		left.sessionId === right.sessionId &&
		left.sessionFile === right.sessionFile &&
		left.cwd === right.cwd &&
		left.rlmDepth === right.rlmDepth &&
		left.modelFallbackMessage === right.modelFallbackMessage &&
		left.headerTimestamp === right.headerTimestamp &&
		left.modified === right.modified &&
		left.lastActivityAt === right.lastActivityAt &&
		left.firstMessage === right.firstMessage &&
		diagnosticsEqual(left.diagnostics, right.diagnostics) &&
		sessionActionSnapshotsEqual(left.sessionActions, right.sessionActions)
	);
}

// Runtime diagnostics change by wholesale replacement or by append; a stable
// length and tail element covers both without a deep compare.
function diagnosticsEqual(
	left: readonly AgentSessionRuntimeDiagnostic[],
	right: readonly AgentSessionRuntimeDiagnostic[],
): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.length === 0 || left[left.length - 1] === right[right.length - 1];
}

function sessionActionSnapshotsEqual(left: SessionActionSnapshot, right: SessionActionSnapshot): boolean {
	if (left === right) return true;
	if (left.queuedCount !== right.queuedCount) return false;
	if (
		left.active?.kind !== right.active?.kind ||
		left.active?.phase !== right.active?.phase ||
		left.active?.label !== right.active?.label
	) {
		return false;
	}
	return stringArraysEqual(left.steering, right.steering) && stringArraysEqual(left.followUps, right.followUps);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * Cheap display labels for callers that need only the session's identity (the
 * heartbeats list polls once per registered job); avoids the full summary
 * compose. Mirrors the sessionName/firstMessage fields summaryForActiveSession
 * produces for a session without a saved catalog entry.
 */
export function sessionDisplayLabels(activeSession: ActiveSessionState): {
	sessionName: string | undefined;
	firstMessage: string | undefined;
} {
	const session = activeSession.runtime.session;
	const metadata = activeSession.runtime.metadata ?? { kind: "top-level" as const };
	return {
		sessionName: session.sessionName,
		firstMessage:
			(metadata.prompt ? compactRlmText(metadata.prompt, 120) : undefined) ?? firstUserMessageText(session),
	};
}

/**
 * Incremental max-message-timestamp tracker for one active session.
 *
 * Sessions only append to their message array in place (full reassignments
 * replace the array object), so the memo folds just the messages appended
 * since the last scan. It falls back to a full walk whenever the array is
 * replaced, shrinks, or shifts: a mid-array insert changes the element at the
 * previous scan boundary, which the tail reference detects.
 */
export interface MessageActivityMemo {
	/** Live messages array the memo last scanned; an identity change forces a full walk. */
	source: readonly AgentMessage[] | undefined;
	/** Number of leading elements already folded into `latest`. */
	scannedLength: number;
	/** Element at `scannedLength - 1` at the last scan; detects mid-array inserts. */
	tailRef: AgentMessage | undefined;
	/** Largest valid message timestamp seen so far, or undefined before the first valid one. */
	latest: number | undefined;
}

function messageActivityTimestamp(message: AgentMessage): number | undefined {
	// Tool results and custom messages are real session activity too. Looking at
	// every timestamp also keeps this correct for future AgentMessage variants.
	if (
		typeof message.timestamp === "number" &&
		Number.isFinite(message.timestamp) &&
		Math.abs(message.timestamp) <= MAX_DATE_TIMESTAMP_MS
	) {
		return message.timestamp;
	}
	return undefined;
}

function foldMessageActivity(
	messages: readonly AgentMessage[],
	from: number,
	latest: number | undefined,
): number | undefined {
	for (let index = from; index < messages.length; index += 1) {
		const timestamp = messageActivityTimestamp(messages[index]!);
		if (timestamp === undefined) continue;
		latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
	}
	return latest;
}

export function latestMessageActivityAt(
	messages: readonly AgentMessage[],
	memo?: MessageActivityMemo,
): string | undefined {
	let latest: number | undefined;
	if (memo === undefined || memo.source !== messages || messages.length < memo.scannedLength) {
		latest = foldMessageActivity(messages, 0, undefined);
	} else if (memo.scannedLength > 0 && messages[memo.scannedLength - 1] !== memo.tailRef) {
		// A mid-array insert shifted the scanned prefix; rescan everything.
		latest = foldMessageActivity(messages, 0, undefined);
	} else {
		latest = foldMessageActivity(messages, memo.scannedLength, memo.latest);
	}
	if (memo !== undefined) {
		memo.source = messages;
		memo.scannedLength = messages.length;
		memo.tailRef = messages.length > 0 ? messages[messages.length - 1] : undefined;
		memo.latest = latest;
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
): SessionSummary {
	return {
		id: session.id,
		lifecycle: inactiveLifecycleForSession(session),
		activity: "idle",
		isSessionActive: false,
		hasRegisteredHeartbeat: hasRegisteredHeartbeat || undefined,
		hasRegisteredCronJob: hasRegisteredCronJob || undefined,
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
		usage: session.usage,
		// Carry the persisted recap/verdict so an off-daemon session keeps its
		// agents-view bucket (e.g. Completed) instead of defaulting to Needs Input.
		// Gate on message-count currency like isSummaryCurrent does for resident
		// sessions, so a verdict from before later messages isn't shown stale.
		...(session.agentStatus?.basedOnMessageCount === session.messageCount
			? { summary: session.agentStatus.summary, taskState: session.agentStatus.taskState }
			: {}),
	};
}

/** Build the root AgentSession projection with daemon-only active session ids. */
export function buildRlmChildSnapshots(
	rootActiveSessionId: string,
	activeSessions: readonly ActiveSessionState[],
): AgentConnectionRlmChildAgentSnapshot[] {
	const root = activeSessions.find((candidate) => candidate.activeSessionId === rootActiveSessionId);
	if (!root) return [];
	const activeSessionIds = new Map(
		activeSessions.flatMap((candidate) => {
			const childId = candidate.runtime.metadata.rlmChildId;
			return childId ? [[childId, candidate.activeSessionId] as const] : [];
		}),
	);
	return root.runtime.session.getRlmChildSnapshots().map((snapshot) => ({
		...snapshot,
		activeSessionId: activeSessionIds.get(snapshot.id),
	}));
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

// Live work that dies with the worker; the display activity axis deliberately excludes delegated work.
export function hasLiveSessionWork(activeSession: ActiveSessionState): boolean {
	const session = activeSession.runtime.session;
	return session.isSessionActive || session.hasRunningRlmChildren();
}

export function activeActivityForSession(activeSession: ActiveSessionState): SessionActivity {
	// The session's own work only, ignoring the classification verdict.
	if (activeSession.runtime.session.isSessionActive) {
		return "working";
	}
	// A finished subagent is resident but never gets a summarizer verdict, so don't hold
	// it at "working" waiting for one — a not-busy subagent is simply idle/done.
	if (activeSession.runtime.metadata?.kind === "subagent") {
		return "idle";
	}
	// An empty session never gets a summarizer verdict; don't hold it at "working" forever.
	if (activeSession.runtime.session.messages.length === 0) {
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
	// A resident subagent is a spawned worker, not a user draft; it is visible before its first message lands.
	if (activeSession.runtime.metadata?.kind === "subagent") return "live";
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
