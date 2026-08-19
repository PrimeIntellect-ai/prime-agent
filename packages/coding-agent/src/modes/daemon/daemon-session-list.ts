import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compactRlmText, rlmChildLabel } from "../../core/agent-session.js";
import type { AgentSessionRuntimeMetadata } from "../../core/agent-session-runtime.js";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import { type AgentCronJob, isHeartbeatCronJob } from "../../core/cron-jobs.js";
import type { SessionActionSnapshot } from "../../core/session-action-store.js";
import type { AgentTaskState, SessionInfo } from "../../core/session-manager.js";
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
		files.add(resolve(job.sessionFile));
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

	return {
		id: activeSession.activeSessionId,
		lifecycle: activeLifecycleForSession(activeSession),
		activity: activeActivityForSession(activeSession),
		isSessionActive: session.isSessionActive,
		hasActiveHeartbeat: hasActiveHeartbeat || undefined,
		hasRegisteredHeartbeat: hasRegisteredHeartbeat || undefined,
		hasRegisteredCronJob: hasRegisteredCronJob || undefined,
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
		isBashRunning: session.isBashRunning,
		hasRunningRlmChildren: session.hasRunningRlmChildren(),
		isRunningTools: session.isStreaming && session.state.pendingToolCalls.size > 0,
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
		diagnostics: [...activeSession.runtime.diagnostics],
		// Keep the last recap visible across turns so the view never blanks, but
		// gate the verdict on currency: a stale "completed" must not show on a turn
		// that is active again.
		summary: activeSession.summaryState?.summary,
		...(isSummaryCurrent(activeSession) ? { taskState: activeSession.summaryState?.taskState } : {}),
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
		// Carry the persisted recap/verdict so an off-daemon session keeps its
		// agents-view bucket (e.g. Completed) instead of defaulting to Needs Input.
		// Gate on message-count currency like isSummaryCurrent does for resident
		// sessions, so a verdict from before later messages isn't shown stale.
		...(session.agentStatus?.basedOnMessageCount === session.messageCount
			? { summary: session.agentStatus.summary, taskState: session.agentStatus.taskState }
			: {}),
	};
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
