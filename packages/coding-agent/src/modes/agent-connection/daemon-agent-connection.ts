import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, ServiceTier, Transport } from "@earendil-works/pi-ai";
import { appendRotatingLog, getAgentLogPath, getDaemonLogPath } from "../../config.js";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { SessionStats } from "../../core/session-stats.js";
import {
	DaemonCapabilityUnavailableError,
	type DaemonClient,
	getDaemonSocketCloseReason,
} from "../daemon/daemon-client.js";
import { deserializeDaemonError } from "../daemon/daemon-errors.js";
import {
	collectDaemonClientEnv,
	collectDaemonLaunchEnv,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonEventCursor,
	type DaemonOutbound,
	type DaemonReplayInfo,
	type DaemonSessionClosedReason,
	type DaemonSessionSnapshot,
	isUnknownDaemonCommandError,
} from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { listDaemonHeartbeats } from "../daemon/heartbeat-catalog.js";
import {
	deleteDaemonSavedSession,
	listDaemonSavedSessions,
	renameDaemonSavedSession,
} from "../daemon/saved-session-catalog.js";
import type {
	AgentConnection,
	AgentConnectionBeforeSessionInvalidateListener,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionExecuteBashOptions,
	AgentConnectionExtensionUiResponse,
	AgentConnectionForkOptions,
	AgentConnectionHeartbeat,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionModelCycleResult,
	AgentConnectionNavigateTreeOptions,
	AgentConnectionNavigateTreeResult,
	AgentConnectionNewSessionOptions,
	AgentConnectionPromptOptions,
	AgentConnectionQueueMode,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionHeader,
	AgentConnectionSessionListCallbacks,
	AgentConnectionSessionTreeFlatNode,
	AgentConnectionSessionTreeNode,
	AgentConnectionSessionWatcher,
	AgentConnectionSideQuestionEvent,
	AgentConnectionSideQuestionTurn,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";
import { AgentConnectionPromptAdmissionError } from "./types.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;
type DaemonSnapshotBegin = Extract<DaemonOutbound, { type: "session_snapshot_begin" }>;

interface DaemonSnapshotAssembly {
	begin?: DaemonSnapshotBegin;
	chunks: Map<number, AgentMessage[]>;
	promise: Promise<DaemonSessionSnapshot>;
	resolve: (snapshot: DaemonSessionSnapshot) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export const DAEMON_REFINE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REVIVAL_RESYNC_RETRY_MS = 250;
const REVIVAL_RESYNC_MAX_ATTEMPTS = 8;
export const DAEMON_RECONNECT_TIMEOUT_MS = 60_000;
export const DAEMON_SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_IGNORED_SNAPSHOT_IDS = 128;
const UPDATE_RECONNECT_TIMEOUT_MS = 120000;
const UPDATE_RECONNECT_RETRY_MS = 100;
const MAX_COMPLETED_SNAPSHOTS = 128;
const OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS = 10_000;
const updateTransportReconnects = new WeakMap<DaemonClient, Promise<void>>();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorSentence(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).trim();
	if (!message) {
		return "Unknown daemon error.";
	}
	return /[.!?]$/.test(message) ? message : `${message}.`;
}

function reconnectDaemonTransportAfterUpdate(client: DaemonClient): Promise<void> {
	const existing = updateTransportReconnects.get(client);
	if (existing) {
		return existing;
	}
	const reconnectPromise = Promise.resolve()
		.then(async () => {
			client.disconnectForReconnect("update");
			const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
			let lastError: unknown;
			while (Date.now() < deadline) {
				try {
					await client.reconnect(1000);
					return;
				} catch (error) {
					lastError = error;
				}
				await delay(UPDATE_RECONNECT_RETRY_MS);
			}
			throw lastError ?? new Error("the updated daemon did not become available");
		})
		.finally(() => {
			if (updateTransportReconnects.get(client) === reconnectPromise) {
				updateTransportReconnects.delete(client);
			}
		});
	updateTransportReconnects.set(client, reconnectPromise);
	return reconnectPromise;
}

export interface DaemonAgentConnectionOptions {
	closeClientOnDispose?: boolean;
	/** Restart/probe the detached supervisor after a transient socket loss. */
	recoverDaemon?: () => Promise<void>;
	/** Bound supervisor recovery before surfacing a fatal connection error. */
	reconnectTimeoutMs?: number;
	/** Bound an incomplete streamed snapshot before failing the attach or resync. */
	snapshotTimeoutMs?: number;
	/**
	 * Send this client's allowlisted env (herdr pane identity) with attach so
	 * an env-less session (e.g. cron-created) adopts it. Set only by the
	 * primary interactive connection — the daemon adopts-if-absent, never
	 * rebinds, so watchers must not send env at all.
	 */
	sendClientEnv?: boolean;
	/** Advertise support for interactive extension dialogs. */
	supportsExtensionUi?: boolean;
	/** Dispose the connection by stopping its hidden worker instead of detaching. */
	ownedSession?: boolean;
	/** Require the target worker to have been created with telemetry disabled. */
	telemetryDisabled?: true;
	/**
	 * Runtime config to recreate the session with when a prompt revives it
	 * from its saved session file. Without it the daemon merges against its
	 * defaults, so the revived worker can silently run with different tools,
	 * system prompt, or model than the invocation that owns this window.
	 */
	reviveConfig?: AgentSessionRuntimeConfig;
}

/**
 * AgentConnection adapter for the local daemon JSONL socket transport.
 *
 * InteractiveMode depends only on AgentConnection; local socket ownership and
 * daemon command details stay inside this adapter.
 */
export function buildSessionTreeFromFlatNodes(
	flatNodes: readonly AgentConnectionSessionTreeFlatNode[],
): AgentConnectionSessionTreeNode[] {
	const byId = new Map<string, AgentConnectionSessionTreeNode>();
	const roots: AgentConnectionSessionTreeNode[] = [];
	for (const flatNode of flatNodes) {
		byId.set(flatNode.entry.id, { ...flatNode, children: [] });
	}
	for (const flatNode of flatNodes) {
		const entry = flatNode.entry;
		const node = byId.get(entry.id)!;
		const parent = entry.parentId === null || entry.parentId === entry.id ? undefined : byId.get(entry.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	// Match SessionManager.getTree() ordering without recursively walking deep
	// chains: every node is already indexed, so sort each sibling array directly.
	for (const node of byId.values()) {
		node.children.sort(
			(left, right) => new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
		);
	}
	return roots;
}

export class DaemonAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly unsubscribeDaemonMessages: () => void;
	private readonly unsubscribeDaemonClose: () => void;
	private readonly clientId = `daemon-agent-connection:${randomUUID()}`;
	private ownedSessionPromotionTail = Promise.resolve();
	private lastEventCursor: DaemonEventCursor | undefined;
	private readonly retiredEventGenerations = new Set<string>();
	private lastEventSequence: number | undefined;
	private latestSnapshot: AgentConnectionSnapshot | undefined;
	private latestSnapshotIsFresh = false;
	private attachedSessionId: string | undefined;
	private attachedSessionFile: string | undefined;
	private daemonLogPath: string | undefined;
	private updateRestartPending = false;
	private updateReconnectFailed = false;
	private terminalCloseEmitted = false;
	private updateReconnectPromise?: Promise<void>;
	private readonly activeSideQuestionIds = new Set<string>();
	private readonly snapshotAssemblies = new Map<string, DaemonSnapshotAssembly>();
	private readonly completedSnapshots = new Map<string, DaemonSessionSnapshot>();
	private readonly pendingBindingCatchupSnapshots = new Map<string, DaemonSessionSnapshot>();
	private readonly pendingBindingCatchupFailures = new Set<string>();
	private readonly pendingReattachActiveSessionIds = new Set<string>();
	private readonly snapshotRecoveryPromises = new Map<string, Promise<void>>();
	private readonly ignoredSnapshotIds = new Set<string>();
	private reconnectPromise?: Promise<void>;
	private reviveSession?: { promise: Promise<RevivedSessionBinding>; sourceActiveSessionId: string };
	private lastAttachCreatedAttachment = false;
	/** undefined = not yet captured; null = captured for a fileless (in-memory) session. */
	private reviveConfigSessionFile: string | null | undefined;
	private lastAttachPublishedIdentity: { sessionId: string; sessionFile: string | undefined } | undefined;
	private switchCwdOverride: { sessionPath: string; cwd: string } | undefined;
	private readonly definitiveRequestErrors = new WeakSet<Error>();
	private disposing = false;
	private disposed = false;

	constructor(
		private readonly client: DaemonClient,
		private activeSessionId: string,
		private readonly options: DaemonAgentConnectionOptions = {},
	) {
		if (options.recoverDaemon) {
			this.client.enableRequestRecovery();
		}
		this.unsubscribeDaemonMessages = this.client.onMessage((message) => {
			void this.handleDaemonMessage(message).catch((error: unknown) => {
				try {
					appendRotatingLog(
						getAgentLogPath(),
						`[${new Date().toISOString()}] daemon-message: ignored ${message.type} failure: ${String(error)}`,
					);
				} catch {
					// Logging failure must not turn an isolated message error into a connection failure.
				}
			});
		});
		this.captureDaemonLogPath();
		this.unsubscribeDaemonClose = this.client.onClose((error) => {
			this.rejectSnapshotAssemblies(error);
			if (this.disposed || this.terminalCloseEmitted) {
				return;
			}
			const closeReason = getDaemonSocketCloseReason(error);
			if (closeReason === "shutdown") {
				this.terminalCloseEmitted = true;
				void this.emit({ type: "closed", error: this.formatDaemonSessionClosedError("shutdown") });
				return;
			}
			if ((this.updateRestartPending || closeReason === "update") && !this.updateReconnectFailed) {
				this.updateRestartPending = true;
				void this.reconnectAfterUpdate();
				return;
			}
			if (this.options.recoverDaemon) {
				void this.reconnect(error);
				return;
			}
			this.terminalCloseEmitted = true;
			void this.emit({ type: "closed", error: this.formatDaemonConnectionClosedError(error) });
		});
	}

	static async attach(
		client: DaemonClient,
		activeSessionId: string,
		options?: DaemonAgentConnectionOptions,
	): Promise<DaemonAgentConnection> {
		const connection = new DaemonAgentConnection(client, activeSessionId, options);
		try {
			await connection.attach();
			return connection;
		} catch (error) {
			await connection.dispose();
			throw error;
		}
	}

	async attach(): Promise<void> {
		await this.attachSessionBinding(this.activeSessionId, false);
	}

	/**
	 * Attach to targetActiveSessionId and publish it as this connection's
	 * binding only once the attach response has been applied. If another
	 * lifecycle transition (revival, reconnect, update recovery, session
	 * switch) rebinds the connection while the request is in flight, the
	 * stale response is rejected instead of rebinding backwards, and the
	 * current binding is left untouched.
	 */
	private async attachSessionBinding(targetActiveSessionId: string, resetCursors: boolean): Promise<void> {
		const entryActiveSessionId = this.activeSessionId;
		const resumeCursor = resetCursors ? undefined : this.lastEventCursor;
		// Admit the target's frames before the request goes out: response and
		// snapshot frames can share one socket buffer, and a frame filtered out
		// here is lost (the snapshot assembly then times out or rejects).
		const admitPendingTarget = targetActiveSessionId !== entryActiveSessionId;
		if (admitPendingTarget) {
			this.pendingReattachActiveSessionIds.add(targetActiveSessionId);
		}
		try {
			await this.attachSessionBindingAdmitted(
				targetActiveSessionId,
				resetCursors,
				entryActiveSessionId,
				resumeCursor,
			);
			// The daemon queues events that land during an attach snapshot and
			// delivers them as a catch-up resync; one addressed to the target
			// while it was still pending had no waiter and was buffered. Apply
			// it now that the binding has published, so the intervening events
			// are not lost behind the older attach snapshot.
			const catchup = this.pendingBindingCatchupSnapshots.get(this.activeSessionId);
			if (catchup) {
				this.pendingBindingCatchupSnapshots.delete(this.activeSessionId);
				this.pendingBindingCatchupFailures.delete(this.activeSessionId);
				this.applyReplacementSnapshot(catchup);
			} else if (this.pendingBindingCatchupFailures.delete(this.activeSessionId)) {
				// A catch-up FAILED while the target was pending and no later one
				// succeeded: the cached attach snapshot predates the events that
				// catch-up carried. Invalidate it so the transition's mandatory
				// read actually re-reads from the daemon instead of serving the
				// stale cache.
				this.latestSnapshotIsFresh = false;
			}
		} finally {
			if (admitPendingTarget) {
				// A failed or superseded transition discards its buffered
				// catch-up and failure marker along with the admission.
				this.pendingReattachActiveSessionIds.delete(targetActiveSessionId);
				this.pendingBindingCatchupSnapshots.delete(targetActiveSessionId);
				this.pendingBindingCatchupFailures.delete(targetActiveSessionId);
			}
		}
	}

	private async attachSessionBindingAdmitted(
		targetActiveSessionId: string,
		resetCursors: boolean,
		entryActiveSessionId: string,
		resumeCursor: DaemonEventCursor | undefined,
	): Promise<void> {
		const supportsExtensionUi = this.options.supportsExtensionUi !== false;
		const result = await this.requestData<SessionSummary | DaemonAttachResult>({
			type: "attach",
			activeSessionId: targetActiveSessionId,
			supportsExtensionUi,
			clientId: this.clientId,
			capabilities: [
				"attach_snapshot",
				"event_sequence",
				...(supportsExtensionUi ? (["extension_ui"] as const) : []),
				"slim_attach",
				"chunked_snapshot",
				...(this.options.ownedSession ? (["client_owned_sessions"] as const) : []),
			],
			env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
			launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : undefined,
			telemetryDisabled: this.options.telemetryDisabled,
			resumeCursor:
				resumeCursor === undefined
					? undefined
					: {
							activeSessionId: targetActiveSessionId,
							...resumeCursor,
						},
		});
		// Recorded before any supersession throw: cleanup paths need to know
		// whether THIS attach created the socket's attachment entry (a sibling
		// connection on the shared client may already hold it, in which case a
		// detach would remove the sibling's subscription). Older daemons omit
		// the field; the conservative default is "did not create it".
		this.lastAttachCreatedAttachment = "wasAttached" in result && result.wasAttached === false;
		if (this.activeSessionId !== entryActiveSessionId) {
			throw new Error(`Session attach superseded: binding moved from ${entryActiveSessionId}`);
		}
		if (resetCursors) {
			this.lastEventSequence = undefined;
			this.lastEventCursor = undefined;
			this.retiredEventGenerations.clear();
		}
		this.activeSessionId = getAttachActiveSessionId(result);
		const summary = "snapshot" in result ? result.snapshot.summary : result;
		this.attachedSessionId = summary.sessionId;
		this.attachedSessionFile =
			summary.sessionFile ?? ("snapshot" in result ? result.snapshot.state.sessionFile : undefined);
		// The invocation's reviveConfig was computed for the transcript this
		// connection first attached to; later transcripts (session switches)
		// must not inherit its cwd. A fileless first attach (--no-session)
		// records null so a transcript resumed later still counts as foreign -
		// checked strictly against undefined because ??= would re-assign over
		// the null marker on the next reconnect attach.
		if (this.reviveConfigSessionFile === undefined) {
			this.reviveConfigSessionFile = this.attachedSessionFile ?? null;
		}
		// Recorded before the snapshot await below: a replacement snapshot
		// landing mid-stream can rewrite the attached identity, and a caller
		// capturing it afterwards would adopt the switched transcript as its
		// own.
		this.lastAttachPublishedIdentity = { sessionId: summary.sessionId, sessionFile: this.attachedSessionFile };
		this.captureDaemonLogPath();
		this.updateReconnectFailed = false;
		this.terminalCloseEmitted = false;
		const attachCursor = getAttachLastEventCursor(result);
		if (attachCursor) {
			this.observeEventCursor(attachCursor);
		}
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, getAttachLastEventSequence(result));
		if ("snapshot" in result) {
			const appliedActiveSessionId = this.activeSessionId;
			const preAwaitSnapshot = this.latestSnapshot;
			const snapshot = result.snapshotStream
				? await this.waitForSnapshot(result.snapshotStream.id)
				: result.snapshot;
			if (this.activeSessionId !== appliedActiveSessionId) {
				// A concurrent transition rebound the connection while the
				// streamed snapshot was in flight; applying the late snapshot
				// would describe a session this connection no longer shows.
				throw new Error(`Session attach superseded: binding moved from ${appliedActiveSessionId}`);
			}
			// The daemon can deliver the attach snapshot's end frame and a queued
			// catch-up resync in one socket read; the resync then lands on the
			// published binding via completeSnapshotAssembly before this
			// continuation resumes. Newest wins by event sequence: overwriting
			// it with the older attach snapshot would drop the intervening
			// events. The identity checks come first because a sequence is only
			// comparable within one session: an unchanged object can still
			// describe the previous binding, and a live event's spread-copy can
			// change the object while carrying the previous session's state.
			// Freshness deliberately does NOT gate the choice - a live event
			// clearing the flag must not resurrect the older attach snapshot.
			const concurrent = this.latestSnapshot;
			const concurrentSeq = concurrent?.lastEventSequence;
			const keepConcurrentlyAppliedSnapshot =
				concurrent !== undefined &&
				concurrent !== preAwaitSnapshot &&
				concurrent.state.sessionId === this.attachedSessionId &&
				concurrentSeq !== undefined &&
				(snapshot.lastEventSequence === undefined || concurrentSeq > snapshot.lastEventSequence);
			if (!keepConcurrentlyAppliedSnapshot) {
				this.latestSnapshot = mapDaemonSessionSnapshot(snapshot, result.replay);
				if (this.lastEventSequence !== undefined) {
					this.latestSnapshot.lastEventSequence = this.lastEventSequence;
				}
				if (this.lastEventCursor) {
					this.latestSnapshot.lastEventCursor = this.lastEventCursor;
				}
				// A live event parsed between the snapshot's end frame and this
				// continuation advanced the connection cursor past the snapshot's
				// content; marking such a cache fresh would serve state whose
				// stamped cursor claims it includes an event it does not. The
				// invalidation is preserved so the next read re-reads.
				this.latestSnapshotIsFresh =
					this.lastEventSequence === undefined ||
					snapshot.lastEventSequence === undefined ||
					this.lastEventSequence <= snapshot.lastEventSequence;
			}
		} else {
			this.latestSnapshot = undefined;
			this.latestSnapshotIsFresh = false;
		}
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(_listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		return () => {};
	}

	async getState(): Promise<AgentConnectionState> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.state;
		}
		return this.requestData<AgentConnectionState>({
			type: "get_connection_state",
			activeSessionId: this.activeSessionId,
		});
	}

	async getInitialSnapshot(): Promise<AgentConnectionSnapshot> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot;
		}
		// The session tree is intentionally not fetched here: it is large on long
		// sessions and only needed when the user opens the tree/branch selector.
		// getSessionTree() fetches it lazily via get_session_tree on first use.
		const snapshotCursor = this.lastEventCursor;
		const snapshotSequence = this.lastEventSequence;
		const [state, messagesData, sessionContextData] = await Promise.all([
			this.requestData<AgentConnectionState>({
				type: "get_connection_state",
				activeSessionId: this.activeSessionId,
			}),
			this.requestData<{ messages: AgentMessage[] }>({
				type: "get_messages",
				activeSessionId: this.activeSessionId,
			}),
			this.requestData<{ context: AgentConnectionSessionContext }>({
				type: "get_session_context",
				activeSessionId: this.activeSessionId,
			}),
		]);
		// Children only travel in the attach snapshot; a session event arriving
		// before the first read marks the cache stale, but the attach-time child
		// roster is still the best seed available (live rlm_child_update events
		// overwrite each entry anyway).
		const children = this.latestSnapshot?.children;
		const streamingMessage = this.latestSnapshot?.streamingMessage;
		this.latestSnapshot = {
			state,
			messages: messagesData.messages,
			sessionContext: sessionContextData.context,
			...(children ? { children } : {}),
			...(streamingMessage ? { streamingMessage } : {}),
		};
		if (snapshotSequence !== undefined) {
			this.latestSnapshot.lastEventSequence = snapshotSequence;
		}
		if (snapshotCursor) {
			this.latestSnapshot.lastEventCursor = snapshotCursor;
		}
		this.latestSnapshotIsFresh =
			snapshotSequence === this.lastEventSequence &&
			snapshotCursor?.generation === this.lastEventCursor?.generation &&
			snapshotCursor?.sequence === this.lastEventCursor?.sequence;
		return this.latestSnapshot;
	}

	async getMessages(): Promise<AgentMessage[]> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot) {
			return this.latestSnapshot.messages;
		}
		const data = await this.requestData<{ messages: AgentMessage[] }>({
			type: "get_messages",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getSessionHeader(): Promise<AgentConnectionSessionHeader | undefined> {
		const data = await this.requestData<{ header?: AgentConnectionSessionHeader | null }>({
			type: "get_session_header",
			activeSessionId: this.activeSessionId,
		});
		return data.header ?? undefined;
	}

	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		const data = await this.requestData<{ commands: AgentConnectionSlashCommand[] }>({
			type: "get_commands",
			activeSessionId: this.activeSessionId,
		});
		return data.commands;
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return this.requestData<AgentConnectionResourceSnapshot>({
			type: "get_resource_snapshot",
			activeSessionId: this.activeSessionId,
		});
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		const data = await this.requestData<{ models: AgentConnectionModel[] }>({
			type: "get_available_models",
			activeSessionId: this.activeSessionId,
		});
		return data.models;
	}

	async getModelCatalog(): Promise<AgentConnectionModelCatalog> {
		if (!this.client.supportsServerCapability("model_catalog")) {
			const models = await this.getAvailableModels();
			return {
				models,
				configuredProviders: [...new Set(models.map((model) => model.provider))],
			};
		}
		return this.requestData<AgentConnectionModelCatalog>({
			type: "get_model_catalog",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.requestData<SessionStats>({
			type: "get_session_stats",
			activeSessionId: this.activeSessionId,
		});
	}

	async getContextTree(): Promise<ContextTreeNode> {
		return this.requestData<ContextTreeNode>({
			type: "get_context_tree",
			activeSessionId: this.activeSessionId,
		});
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionContext) {
			return this.latestSnapshot.sessionContext;
		}
		const data = await this.requestData<{ context: AgentConnectionSessionContext }>({
			type: "get_session_context",
			activeSessionId: this.activeSessionId,
		});
		return data.context;
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		if (this.latestSnapshotIsFresh && this.latestSnapshot?.sessionTree) {
			return this.latestSnapshot.sessionTree;
		}
		const data = await this.requestData<{
			flatNodes: AgentConnectionSessionTreeFlatNode[];
			leafId: string | null;
		}>({
			type: "get_session_tree",
			activeSessionId: this.activeSessionId,
		});
		return { tree: buildSessionTreeFromFlatNodes(data.flatNodes), leafId: data.leafId };
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		return listDaemonSavedSessions(this.client, { activeSessionId: this.activeSessionId }, scope, callbacks);
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "get_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.requestData<AgentConnectionQueueState>({
			type: "clear_queue",
			activeSessionId: this.activeSessionId,
		});
	}

	async abortAndClearQueue(): Promise<AgentConnectionQueueState> {
		try {
			return await this.requestData<AgentConnectionQueueState>({
				type: "abort_and_clear_queue",
				activeSessionId: this.activeSessionId,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_and_clear_queue")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async listCronJobs(options: { includeInactive?: boolean } = {}): Promise<AgentCronJob[]> {
		const data = await this.requestData<{ jobs: AgentCronJob[] }>({
			type: "cron_list",
			activeSessionId: this.activeSessionId,
			includeInactive: options.includeInactive,
		});
		return data.jobs;
	}

	async listHeartbeats(): Promise<AgentConnectionHeartbeat[]> {
		return listDaemonHeartbeats(this.client, this.options.ownedSession ? this.activeSessionId : undefined);
	}

	async manageHeartbeat(
		activeSessionId: string,
		jobId: string,
		action: AgentHeartbeatManagementAction,
	): Promise<AgentCronJob> {
		if (!this.client.supportsServerCapability("heartbeat_management")) {
			throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
		}
		try {
			const data = await this.requestData<{ heartbeat: AgentCronJob }>({
				type: "heartbeat_manage",
				activeSessionId,
				jobId,
				action,
			});
			return data.heartbeat;
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "heartbeat_manage")) {
				throw new Error("Heartbeat management requires a newer Prime Agent daemon.");
			}
			throw error;
		}
	}

	async addCronJob(schedule: string, prompt: string): Promise<AgentCronJob> {
		return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			const data = await this.requestData<{ job: AgentCronJob }>({
				type: "cron_add",
				activeSessionId: this.activeSessionId,
				schedule,
				prompt,
				promoteOwnedSession,
			});
			return data.job;
		});
	}

	async cancelCronJob(jobId: string): Promise<AgentCronJob> {
		const data = await this.requestData<{ job: AgentCronJob }>({
			type: "cron_cancel",
			activeSessionId: this.activeSessionId,
			jobId,
		});
		return data.job;
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_get",
			activeSessionId: this.activeSessionId,
		});
		return data.heartbeat ?? undefined;
	}

	async setHeartbeat(
		schedule: string,
		instruction: string,
		deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob> {
		return this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			const data = await this.requestData<{ heartbeat: AgentCronJob }>({
				type: "heartbeat_set",
				activeSessionId: this.activeSessionId,
				schedule,
				prompt: instruction,
				...(deliveryMode ? { deliveryMode } : {}),
				promoteOwnedSession,
			});
			return data.heartbeat;
		});
	}

	async updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		const data = await this.requestData<{ heartbeat?: AgentCronJob | null }>({
			type: "heartbeat_update",
			activeSessionId: this.activeSessionId,
			action,
		});
		return data.heartbeat ?? undefined;
	}

	async sendAgentMessage(targetActiveSessionId: string, message: string): Promise<AgentSessionMessageReceipt> {
		return this.requestData<AgentSessionMessageReceipt>({
			type: "send_message",
			targetActiveSessionId,
			message,
			fromActiveSessionId: this.activeSessionId,
		});
	}

	async getAgentMessageStatus(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_status",
			activeSessionId: this.activeSessionId,
		});
	}

	async pauseAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_pause",
			activeSessionId: this.activeSessionId,
		});
	}

	async resumeAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		return this.requestData<AgentSessionMessageSafetyStatus>({
			type: "agent_messages_resume",
			activeSessionId: this.activeSessionId,
		});
	}

	async clearAgentMessages(): Promise<number> {
		return this.requestData<number>({
			type: "agent_messages_clear",
			activeSessionId: this.activeSessionId,
		});
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		const data = await this.requestData<{ messages: AgentConnectionUserMessage[] }>({
			type: "get_user_messages_for_forking",
			activeSessionId: this.activeSessionId,
		});
		return data.messages;
	}

	async getLastAssistantText(): Promise<string | undefined> {
		const data = await this.requestData<{ text?: string | null }>({
			type: "get_last_assistant_text",
			activeSessionId: this.activeSessionId,
		});
		return data.text ?? undefined;
	}

	async getSystemPrompt(): Promise<string> {
		const data = await this.requestData<{ systemPrompt: string }>({
			type: "get_system_prompt",
			activeSessionId: this.activeSessionId,
		});
		return data.systemPrompt;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		const data = await this.requestData<{ toolDefinition?: AgentConnectionToolDefinition }>({
			type: "get_tool_definition",
			activeSessionId: this.activeSessionId,
			name,
		});
		return data.toolDefinition;
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		await this.requestOk({
			type: "set_session_entry_label",
			activeSessionId: this.activeSessionId,
			entryId,
			label,
		});
	}

	async respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void> {
		await this.requestOk({
			type: "extension_ui_response",
			activeSessionId: this.activeSessionId,
			requestId,
			response,
		});
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.promptWithSessionRevival("prompt", message, options);
	}

	async promptAndWait(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.promptWithSessionRevival("prompt_and_wait", message, options);
	}

	/**
	 * Deliver a prompt, transparently reviving the session from its saved
	 * session file when the daemon no longer has it resident.
	 *
	 * A window can outlive its session: the daemon archives an RLM subagent
	 * after it delivers its final answer, evicts idle workers, and parents
	 * delete finished children. Without revival every keystroke in a window
	 * attached to such a session dead-ends in "Unknown active session" even
	 * though the transcript is saved and resumable — the exact affordance the
	 * agents view already offers via resume-on-open and resume-on-reply.
	 * Typing a message is an explicit "continue this session" request, so it
	 * gets the same treatment here. That deliberately includes sessions the
	 * daemon reported as killed: the agents view reply flow already resumes
	 * those, and a revived transcript is strictly recoverable.
	 */
	private async promptWithSessionRevival(
		type: "prompt" | "prompt_and_wait",
		message: string,
		options?: AgentConnectionPromptOptions,
	): Promise<void> {
		const attemptedActiveSessionId = this.activeSessionId;
		try {
			await this.promptWithAdmissionCancellation(type, message, options);
		} catch (error) {
			// A cancelled prompt must never restart an archived session: when the
			// abort races the unknown-session response, the admission wrapper
			// rethrows it carrying the same message, and reviving would create
			// and attach a worker only for the retry to observe the aborted
			// signal and reject.
			if (options?.signal?.aborted) {
				throw error;
			}
			if (!this.canReviveFromSavedSession(error, attemptedActiveSessionId)) {
				throw error;
			}
			if (this.activeSessionId === attemptedActiveSessionId) {
				let revived: RevivedSessionBinding;
				try {
					revived = await this.reviveFromSavedSession();
				} catch {
					// Surface the original unknown-session error: it names the session
					// the caller targeted, which is more actionable than a revival
					// failure for a session that may have been deleted outright.
					throw error;
				}
				// A transition that lands during the revival's tail or between it
				// resolving and this continuation running rebinds the connection —
				// or, for an in-worker session switch, replaces the transcript
				// WITHOUT changing the active id. Verify the full identity before
				// re-sending; injecting the prompt into another transcript is
				// worse than surfacing the original error.
				if (!this.matchesRevivedBinding(revived)) {
					throw error;
				}
				await this.promptWithAdmissionCancellation(type, message, options);
				return;
			}
			// The binding moved while this prompt was in flight. Join only a
			// sibling revival of the SAME session this prompt targeted; joining
			// any other transition (a revival of a different session, an explicit
			// session switch) would inject this prompt into another transcript.
			const revival = this.reviveSession;
			if (!revival || revival.sourceActiveSessionId !== attemptedActiveSessionId) {
				throw error;
			}
			let revived: RevivedSessionBinding;
			try {
				revived = await revival.promise;
			} catch {
				throw error;
			}
			if (!this.matchesRevivedBinding(revived)) {
				throw error;
			}
			await this.promptWithAdmissionCancellation(type, message, options);
		}
	}

	/**
	 * Whether the connection still shows the exact binding a revival resolved
	 * with: same active id AND same transcript identity. An in-worker session
	 * switch replaces the transcript while keeping the active id, so the id
	 * comparison alone would let a failed prompt retry into the newly
	 * selected transcript.
	 */
	private matchesRevivedBinding(revived: RevivedSessionBinding): boolean {
		return (
			this.activeSessionId === revived.activeSessionId &&
			this.attachedSessionId === revived.sessionId &&
			this.attachedSessionFile === revived.sessionFile
		);
	}

	private canReviveFromSavedSession(error: unknown, attemptedActiveSessionId: string): boolean {
		return (
			!this.disposed &&
			!this.disposing &&
			this.attachedSessionFile !== undefined &&
			error instanceof Error &&
			// Exact match, bound to the id this prompt actually targeted: an
			// unknown-session error about any other selector (another target id,
			// or an id this one merely prefixes) must not trigger a revival.
			error.message === `Unknown active session: ${attemptedActiveSessionId}`
		);
	}

	/**
	 * Resume this connection's saved session file into the daemon and reattach.
	 * The daemon's create-with-sessionPath is idempotent: a session that is
	 * still (or again) resident is reused instead of resumed twice.
	 *
	 * The revived binding is never published early: the connection keeps its
	 * previous binding until the attach to the revived session has succeeded,
	 * so no concurrently started prompt can target a session this client has
	 * not attached to, and there is no rollback that could stomp a newer
	 * binding installed by a concurrent transition (session switch, reconnect,
	 * update recovery). A revival superseded by such a transition fails and
	 * leaves the newer binding untouched.
	 */
	private reviveFromSavedSession(): Promise<RevivedSessionBinding> {
		if (this.reviveSession) {
			return this.reviveSession.promise;
		}
		const sourceActiveSessionId = this.activeSessionId;
		const revival = (async () => {
			// Lifecycle transitions (daemon reconnect, update recovery) rebind the
			// same state this revival reads; let any in-flight one settle first.
			await this.updateReconnectPromise?.catch(() => undefined);
			await this.reconnectPromise?.catch(() => undefined);
			const sessionFile = this.attachedSessionFile;
			if (!sessionFile) {
				throw new Error("The session is no longer active and has no saved session file to resume");
			}
			if (this.activeSessionId !== sourceActiveSessionId) {
				throw new Error(`Session revival superseded: binding moved from ${sourceActiveSessionId}`);
			}
			// Mirror the original create's launch context: without the runtime
			// config the daemon merges against its defaults, and without the
			// client environment extensions load without the invocation's pane
			// identity - the retried prompt could silently run with different
			// tools, system prompt, or model. The telemetry opt-out is folded in
			// regardless: without it the worker starts under the daemon's default
			// policy and assertTelemetryAttachAllowed rejects the attach after
			// the worker already launched.
			let invocationConfig = this.options.reviveConfig;
			if (
				invocationConfig?.cwd !== undefined &&
				this.reviveConfigSessionFile !== undefined &&
				this.reviveConfigSessionFile !== sessionFile
			) {
				// A session switch replaced the transcript this config was
				// computed for; its cwd would act as an explicit override and run
				// the retried prompt's tools in the previous project. Dropping it
				// resumes in the switched transcript's own directory, matching
				// standard resume semantics.
				const { cwd: _previousCwd, ...transcriptNeutralConfig } = invocationConfig;
				invocationConfig = transcriptNeutralConfig;
			}
			if (this.switchCwdOverride?.sessionPath === sessionFile) {
				// The transcript only opened because the user selected a fallback
				// cwd for its missing recorded directory; the recreate needs the
				// same override or it fails on that directory again.
				invocationConfig = { ...(invocationConfig ?? {}), cwd: this.switchCwdOverride.cwd };
			}
			const reviveConfig = invocationConfig
				? {
						...invocationConfig,
						...(this.options.telemetryDisabled ? { telemetryDisabled: true as const } : {}),
					}
				: this.options.telemetryDisabled
					? { telemetryDisabled: true as const }
					: undefined;
			const summary = await this.requestData<unknown>(
				{
					type: "create",
					sessionPath: sessionFile,
					continueRecent: false,
					...(reviveConfig ? { config: reviveConfig } : {}),
					env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
					...(this.options.ownedSession
						? { lifecycle: "client_owned" as const, launchEnv: collectDaemonLaunchEnv() }
						: {}),
				},
				DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
			);
			const revivedActiveSessionId = readCreatedActiveSessionId(summary);
			if (this.disposed || this.disposing) {
				this.releaseRevivedSession(revivedActiveSessionId, false);
				throw new Error("Connection was disposed during session revival");
			}
			if (this.activeSessionId !== sourceActiveSessionId) {
				// A concurrent transition rebound the connection while the daemon
				// was resuming the session; the newer binding wins. The revived
				// worker stays resident for the idle sweeps unless it is owned —
				// but when the concurrent transition bound this connection to the
				// SAME session the create just revived (a switch to the saved
				// session file), releasing it would detach the currently
				// published binding and leave the connection deaf to its events.
				if (this.activeSessionId !== revivedActiveSessionId) {
					this.releaseRevivedSession(revivedActiveSessionId, false);
				}
				throw new Error(`Session revival superseded: binding moved from ${sourceActiveSessionId}`);
			}
			try {
				await this.attachSessionBinding(revivedActiveSessionId, true);
			} catch (error) {
				// Supersede errors are thrown after a successful attach response,
				// and the response's wasAttached tells whether that attach CREATED
				// the socket's attachment entry - a sibling connection may already
				// have held it, in which case a detach would remove the sibling's
				// subscription rather than ours. Reliance on the field is gated on
				// the negotiated capability: a pre-revision-15 daemon never
				// reports ownership, and skipping the detach there would leave a
				// stale attachment that blocks the worker's idle eviction until
				// the socket closes - so legacy daemons keep the historical
				// unconditional detach instead.
				const attachAcquired =
					DaemonAgentConnection.isAttachSupersededError(error) &&
					(this.client.supportsServerCapability("attach_ownership") ? this.lastAttachCreatedAttachment : true);
				if (this.disposed || this.disposing) {
					this.releaseRevivedSession(revivedActiveSessionId, attachAcquired);
					throw error;
				}
				if (this.activeSessionId !== revivedActiveSessionId) {
					// The attach did not publish the revived binding (transient
					// failure or supersession); drop the attachment bookkeeping
					// only when this attach actually registered it, and complete
					// an owned revived worker so it cannot outlive the failed
					// revival.
					this.releaseRevivedSession(revivedActiveSessionId, attachAcquired);
					throw error;
				}
				// The attach response was applied — the binding is published and
				// the client is attached server-side — but the streamed snapshot
				// failed. Failing the revival here would strand a coherent binding
				// and lose the prompt; fall through to the snapshot reads below,
				// which recover or schedule a background resync.
			}
			// Capture the transcript identity the attach RESPONSE published (not
			// the current fields): an in-worker session switch replaces the
			// runtime transcript without changing the active-session id, and a
			// replacement snapshot landing while the attach snapshot streamed
			// can rewrite the attached identity before this line runs. Adopting
			// the switched transcript here would let matchesRevivedBinding pass
			// and resend the failed prompt into it.
			const revivedBinding: RevivedSessionBinding = {
				activeSessionId: revivedActiveSessionId,
				sessionId: this.lastAttachPublishedIdentity?.sessionId ?? this.attachedSessionId,
				sessionFile: this.lastAttachPublishedIdentity?.sessionFile ?? this.attachedSessionFile,
			};
			let snapshot: AgentConnectionSnapshot | undefined;
			try {
				snapshot = await this.getInitialSnapshot();
			} catch {
				// The connection is coherently bound AND attached to the revived
				// session (a legacy attach result leaves the snapshot to separate
				// reads, which can fail transiently); only the resync emission is
				// missing. Retry it in the background instead of failing a revival
				// whose prompts already work.
				this.scheduleRevivalResync(revivedBinding);
			}
			this.activeSideQuestionIds.clear();
			if (this.disposed) {
				// The attach succeeded, but it only ACQUIRED the attachment when it
				// created the socket entry; a sibling's pre-existing attachment
				// must survive this cleanup. Without the negotiated ownership
				// report, legacy daemons keep the historical unconditional detach.
				this.releaseRevivedSession(
					revivedActiveSessionId,
					this.client.supportsServerCapability("attach_ownership") ? this.lastAttachCreatedAttachment : true,
				);
				throw new Error("Connection was disposed during session revival");
			}
			if (sourceActiveSessionId !== revivedActiveSessionId) {
				// The dead id lingers in the shared socket client's attachment
				// bookkeeping; the supervisor's detach cleans it even when no
				// worker matches the selector anymore.
				void this.requestOk({ type: "detach", activeSessionId: sourceActiveSessionId }).catch(() => undefined);
			}
			// The emission must verify the full binding identity, not just the
			// id: an in-worker switch landing during the snapshot read keeps the
			// active id but replaces the transcript, and emitting the pre-switch
			// snapshot after its session_replaced would revert the window.
			if (snapshot && this.matchesRevivedBinding(revivedBinding)) {
				void this.emit({ type: "session_resynced", snapshot });
			}
			return revivedBinding;
		})().finally(() => {
			if (this.reviveSession?.promise === revival) {
				this.reviveSession = undefined;
			}
		});
		this.reviveSession = { promise: revival, sourceActiveSessionId };
		return revival;
	}

	/**
	 * The revival attached successfully but its resync snapshot read failed;
	 * without the session_resynced emission the window keeps rendering the
	 * dead transcript even though prompts already reach the revived session.
	 * Retry in the background until the snapshot lands or the binding moves.
	 */
	private scheduleRevivalResync(revivedBinding: RevivedSessionBinding): void {
		void (async () => {
			for (let attempt = 1; attempt <= REVIVAL_RESYNC_MAX_ATTEMPTS; attempt++) {
				await delay(attempt * REVIVAL_RESYNC_RETRY_MS);
				// The full transcript identity gates every step: an in-worker
				// switch replaces the transcript WITHOUT changing the active id,
				// and emitting a pre-switch snapshot after its session_replaced
				// would revert the window.
				if (this.disposed || !this.matchesRevivedBinding(revivedBinding)) {
					return;
				}
				try {
					const snapshot = await this.getInitialSnapshot();
					if (this.disposed || !this.matchesRevivedBinding(revivedBinding)) {
						return;
					}
					void this.emit({ type: "session_resynced", snapshot });
					return;
				} catch {
					// Keep retrying: the next prompt cannot repair the stale render.
				}
			}
		})();
	}

	/**
	 * Best-effort cleanup for a session revived after disposal began or after
	 * the revival was superseded: dispose() only released the previous
	 * binding, so an owned revived session would otherwise outlive this
	 * connection indefinitely.
	 *
	 * The detach is conditional on THIS revival having acquired the socket
	 * attachment. The supervisor tracks attachedActiveSessionIds once per
	 * socket (no refcount), and a DaemonClient can be shared by sibling
	 * connections: detaching an id we never attached would deafen a sibling
	 * attached to the session the create returned. create alone never
	 * attaches — only attachSessionBinding does — so pre-attach call-sites
	 * pass false. Completing an owned session stays unconditional: the create
	 * claimed ownership regardless of any attachment.
	 */
	private releaseRevivedSession(revivedActiveSessionId: string, detachAttachment: boolean): void {
		if (this.options.ownedSession) {
			void this.requestOk({ type: "complete_owned_session", activeSessionId: revivedActiveSessionId }).catch(
				() => undefined,
			);
		}
		if (detachAttachment) {
			void this.requestOk({ type: "detach", activeSessionId: revivedActiveSessionId }).catch(() => undefined);
		}
	}

	/**
	 * attachSessionBinding throws its supersession errors strictly AFTER a
	 * successful attach response — i.e. after the supervisor registered this
	 * socket's attachment. Any other attach failure (transport, rejected
	 * request) acquired nothing. A server-side registration whose response
	 * was lost client-side without a supersede error is the residual
	 * trade-off: it may leave a stale socket attachment (inflating the
	 * supervisor's attachedClients until the socket closes) but cannot
	 * deafen a sibling connection; with a per-socket attachment Set both
	 * cannot be avoided at once, and deafening a live sibling is worse.
	 */
	private static isAttachSupersededError(error: unknown): boolean {
		return error instanceof Error && error.message.startsWith("Session attach superseded");
	}

	private async promptWithAdmissionCancellation(
		type: "prompt" | "prompt_and_wait",
		message: string,
		options?: AgentConnectionPromptOptions,
	): Promise<void> {
		const signal = options?.signal;
		if (signal?.aborted) {
			throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
		}
		if (!signal) {
			await this.requestData<unknown>(
				{
					type,
					activeSessionId: this.activeSessionId,
					message,
					images: options?.images,
					streamingBehavior: options?.streamingBehavior,
					queueIfBusy: options?.queueIfBusy,
					source: options?.source,
				},
				DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
			);
			return;
		}
		const admissionId = `prompt-admission:${randomUUID()}`;
		let resolveAbort = () => {};
		const aborted = new Promise<"abort">((resolve) => {
			resolveAbort = () => resolve("abort");
		});
		const onAbort = () => resolveAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before issuing the first request.
		if (signal.aborted) {
			signal.removeEventListener("abort", onAbort);
			throw new AgentConnectionPromptAdmissionError("Prompt admission was cancelled.", "cancelled");
		}
		const command = {
			type,
			activeSessionId: this.activeSessionId,
			message,
			images: options.images,
			streamingBehavior: options.streamingBehavior,
			queueIfBusy: options.queueIfBusy,
			source: options.source,
			admissionId,
		} as Extract<DaemonCommandBody, { type: typeof type }>;
		let promptError: unknown;
		const promptRequest = this.requestData<unknown>(command, DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS).catch(
			(error: unknown) => {
				promptError =
					error instanceof DaemonCapabilityUnavailableError && !error.afterReconnect
						? new AgentConnectionPromptAdmissionError(error.message, "unsupported", { cause: error })
						: error;
				return "failed" as const;
			},
		);
		try {
			const first = await Promise.race([promptRequest.then(() => "settled" as const), aborted]);
			if (first === "settled" && promptError === undefined) return;
			if (first === "settled" && promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
			if (
				first === "settled" &&
				!signal.aborted &&
				promptError instanceof Error &&
				this.definitiveRequestErrors.has(promptError)
			) {
				throw promptError;
			}
			let status: "cancelled" | "owned" | "unknown" = "unknown";
			try {
				const result = await this.requestData<{ status: "cancelled" | "owned" | "unknown" }>({
					type: "cancel_prompt_admission",
					activeSessionId: this.activeSessionId,
					admissionId,
				});
				status = result.status;
			} catch {
				// Timeout/transport is indistinguishable from accepted ownership.
			}
			await promptRequest;
			if (promptError instanceof AgentConnectionPromptAdmissionError) throw promptError;
			const definitiveFailure = promptError instanceof Error && this.definitiveRequestErrors.has(promptError);
			if (promptError === undefined || (status === "owned" && type === "prompt" && !definitiveFailure)) return;
			throw new AgentConnectionPromptAdmissionError(
				promptError instanceof Error ? promptError.message : "Prompt admission did not complete.",
				status,
				promptError === undefined ? undefined : { cause: promptError },
			);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async startSideQuestion(
		id: string,
		question: string,
		previousTurns?: AgentConnectionSideQuestionTurn[],
	): Promise<void> {
		if (previousTurns?.length && !this.client.supportsServerCapability("side_question_transcript")) {
			// An older daemon would silently ignore previousTurns and answer the
			// follow-up without the side-conversation context; fail loudly instead.
			throw new Error(
				"the daemon is running an older build without side-conversation follow-ups; restart the daemon and try again",
			);
		}
		this.activeSideQuestionIds.add(id);
		try {
			await this.requestOk({
				type: "start_side_question",
				activeSessionId: this.activeSessionId,
				sideQuestionId: id,
				question,
				previousTurns,
			});
		} catch (error) {
			this.activeSideQuestionIds.delete(id);
			if (isUnknownDaemonCommandError(error, "start_side_question")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async abortSideQuestion(id: string): Promise<boolean> {
		const data = await this.requestData<{ aborted: boolean }>({
			type: "abort_side_question",
			activeSessionId: this.activeSessionId,
			sideQuestionId: id,
		});
		this.activeSideQuestionIds.delete(id);
		return data.aborted;
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "steer", activeSessionId: this.activeSessionId, message, images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.requestOk({ type: "follow_up", activeSessionId: this.activeSessionId, message, images });
	}

	async abort(): Promise<void> {
		await this.requestOk({ type: "abort", activeSessionId: this.activeSessionId });
	}

	async cancelRlmChild(childId: string): Promise<boolean> {
		try {
			const result = await this.requestData<{ cancelled: boolean }>({
				type: "cancel_rlm_child",
				activeSessionId: this.activeSessionId,
				childId,
			});
			return result.cancelled;
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "cancel_rlm_child")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async waitForIdle(): Promise<void> {
		await this.requestData<unknown>(
			{ type: "wait_for_idle", activeSessionId: this.activeSessionId },
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async waitForHeadlessCompletion(): Promise<AgentAutonomousStatus> {
		return this.requestData<AgentAutonomousStatus>(
			{
				type: "wait_for_headless_completion",
				activeSessionId: this.activeSessionId,
			},
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		if (options?.transient && !this.client.supportsServerCapability("transient_bash")) {
			// An older daemon would record the run into the session, leaking the
			// side conversation into the main transcript; fail loudly instead.
			throw new Error(
				"the daemon is running an older build without side-conversation bash; restart the daemon and try again",
			);
		}
		try {
			await this.requestOk({
				type: "execute_bash",
				activeSessionId: this.activeSessionId,
				command,
				excludeFromContext: options?.excludeFromContext,
				transient: options?.transient,
				runId: options?.runId,
			});
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "execute_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async executeBashAndWait(command: string): Promise<BashResult> {
		return this.requestData<BashResult>(
			{
				type: "execute_bash_and_wait",
				activeSessionId: this.activeSessionId,
				command,
			},
			DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS,
		);
	}

	async abortBash(): Promise<void> {
		try {
			await this.requestOk({ type: "abort_bash", activeSessionId: this.activeSessionId });
		} catch (error) {
			if (isUnknownDaemonCommandError(error, "abort_bash")) {
				throw new Error("the daemon is running an older build; restart the daemon and try again");
			}
			throw error;
		}
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		return this.requestData<AgentConnectionModel>({
			type: "set_model",
			activeSessionId: this.activeSessionId,
			provider,
			modelId,
		});
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined> {
		const result = await this.requestData<AgentConnectionModelCycleResult | null>({
			type: "cycle_model",
			activeSessionId: this.activeSessionId,
			direction,
		});
		return result ?? undefined;
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		await this.requestOk({
			type: "set_scoped_models",
			activeSessionId: this.activeSessionId,
			scopedModels,
		});
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.requestOk({ type: "set_thinking_level", activeSessionId: this.activeSessionId, level });
	}

	async setServiceTier(serviceTier: ServiceTier): Promise<void> {
		await this.requestOk({ type: "set_service_tier", activeSessionId: this.activeSessionId, serviceTier });
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const result = await this.requestData<{ level: ThinkingLevel } | null>({
			type: "cycle_thinking_level",
			activeSessionId: this.activeSessionId,
		});
		return result?.level;
	}

	async setTransport(transport: Transport): Promise<void> {
		await this.requestOk({ type: "set_transport", activeSessionId: this.activeSessionId, transport });
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_steering_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		await this.requestOk({ type: "set_follow_up_mode", activeSessionId: this.activeSessionId, mode });
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		await this.requestOk({ type: "set_auto_compaction", activeSessionId: this.activeSessionId, enabled });
	}

	async setAutoRetryEnabled(enabled: boolean): Promise<void> {
		await this.requestOk({ type: "set_auto_retry", activeSessionId: this.activeSessionId, enabled });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.requestData<CompactionResult>({
			type: "compact",
			activeSessionId: this.activeSessionId,
			customInstructions,
		});
	}

	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		const command: {
			type: "refine";
			activeSessionId: string;
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {
			type: "refine",
			activeSessionId: this.activeSessionId,
			instructions: options.instructions,
			rollbackId: options.rollbackId,
		};
		if (options.global !== undefined) {
			command.global = options.global;
		}
		return this.requestData<RefinementResult>(command, DAEMON_REFINE_REQUEST_TIMEOUT_MS);
	}

	async abortCompaction(): Promise<void> {
		await this.requestOk({ type: "abort_compaction", activeSessionId: this.activeSessionId });
	}

	async abortBranchSummary(): Promise<void> {
		await this.requestOk({ type: "abort_branch_summary", activeSessionId: this.activeSessionId });
	}

	async abortRetry(): Promise<void> {
		await this.requestOk({ type: "abort_retry", activeSessionId: this.activeSessionId });
	}

	async reload(): Promise<void> {
		await this.requestOk({ type: "reload", activeSessionId: this.activeSessionId });
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "new_session",
			activeSessionId: this.activeSessionId,
			parentSession: options?.parentSession,
		});
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		const sourceActiveSessionId = this.activeSessionId;
		try {
			const result = await this.requestData<{ cancelled: boolean }>({
				type: "switch_session",
				activeSessionId: sourceActiveSessionId,
				sessionPath,
				cwdOverride: options?.cwdOverride,
			});
			if (!result.cancelled) {
				// A transcript switched in with a user-selected fallback cwd only
				// opened BECAUSE of that override (its recorded directory is
				// missing). Reviving it later must reuse the same override or the
				// recreate fails on the missing directory and the prompt
				// dead-ends again.
				this.switchCwdOverride = options?.cwdOverride ? { sessionPath, cwd: options.cwdOverride } : undefined;
			}
			return result;
		} catch (error) {
			if (!(error instanceof SessionAlreadyActiveError) || !error.activeSessionId) {
				throw error;
			}
			if (this.options.ownedSession) {
				throw error;
			}
			if (error.activeSessionId === sourceActiveSessionId) {
				return { cancelled: false };
			}
			const result = await this.reattachSession(sourceActiveSessionId, error.activeSessionId);
			if (options?.cwdOverride) {
				// The transcript is live under another worker, but the user still
				// selected a fallback cwd because its recorded directory is
				// missing; a later revival of this transcript needs the same
				// override or its recreate fails on that directory. Keyed by the
				// reattached transcript's canonical file when known - the caller's
				// path spelling may differ.
				this.switchCwdOverride = { sessionPath: this.attachedSessionFile ?? sessionPath, cwd: options.cwdOverride };
			}
			return result;
		}
	}

	private async reattachSession(
		sourceActiveSessionId: string,
		targetActiveSessionId: string,
	): Promise<{ cancelled: false }> {
		const previousState = {
			lastEventCursor: this.lastEventCursor,
			lastEventSequence: this.lastEventSequence,
			latestSnapshot: this.latestSnapshot,
			latestSnapshotIsFresh: this.latestSnapshotIsFresh,
			retiredEventGenerations: new Set(this.retiredEventGenerations),
		};
		this.activeSessionId = targetActiveSessionId;
		this.lastEventCursor = undefined;
		this.lastEventSequence = undefined;
		this.latestSnapshot = undefined;
		this.latestSnapshotIsFresh = false;
		this.retiredEventGenerations.clear();
		this.pendingReattachActiveSessionIds.add(targetActiveSessionId);
		let reattached = false;
		try {
			const supportsExtensionUi = this.options.supportsExtensionUi !== false;
			const result = await this.requestData<DaemonAttachResult>({
				type: "reattach",
				activeSessionId: sourceActiveSessionId,
				targetActiveSessionId,
				supportsExtensionUi,
				clientId: this.clientId,
				capabilities: [
					"attach_snapshot",
					"event_sequence",
					...(supportsExtensionUi ? (["extension_ui"] as const) : []),
					"slim_attach",
					"chunked_snapshot",
					...(this.options.ownedSession ? (["client_owned_sessions"] as const) : []),
				],
				env: this.options.sendClientEnv ? collectDaemonClientEnv() : undefined,
				launchEnv: this.options.ownedSession ? collectDaemonLaunchEnv() : undefined,
				telemetryDisabled: this.options.telemetryDisabled,
			});
			reattached = true;
			this.activeSessionId = result.activeSessionId;
			this.activeSideQuestionIds.clear();
			if (result.snapshotStream) {
				try {
					await this.waitForSnapshot(result.snapshotStream.id);
				} catch (snapshotError) {
					await this.snapshotRecoveryPromises.get(result.snapshotStream.id);
					if (!this.latestSnapshotIsFresh) {
						throw snapshotError;
					}
				}
			} else {
				this.applyReplacementSnapshot(result.snapshot, result.replay);
				await this.emit({
					type: "session_replaced",
					state: result.snapshot.state,
					messages: result.snapshot.messages,
				});
			}
			return { cancelled: false };
		} catch (error) {
			if (!reattached) {
				this.activeSessionId = sourceActiveSessionId;
				this.lastEventCursor = previousState.lastEventCursor;
				this.lastEventSequence = previousState.lastEventSequence;
				this.latestSnapshot = previousState.latestSnapshot;
				this.latestSnapshotIsFresh = previousState.latestSnapshotIsFresh;
				this.retiredEventGenerations.clear();
				for (const generation of previousState.retiredEventGenerations) {
					this.retiredEventGenerations.add(generation);
				}
			}
			throw error;
		} finally {
			this.pendingReattachActiveSessionIds.delete(targetActiveSessionId);
		}
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.requestData<{ cancelled: boolean; selectedText?: string }>({
			type: "fork",
			activeSessionId: this.activeSessionId,
			entryId,
			position: options?.position,
		});
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return this.requestData<AgentConnectionNavigateTreeResult>({
			type: "navigate_tree",
			activeSessionId: this.activeSessionId,
			targetId,
			summarize: options?.summarize,
			customInstructions: options?.customInstructions,
			replaceInstructions: options?.replaceInstructions,
			label: options?.label,
		});
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.requestData<{ cancelled: boolean }>({
			type: "import_jsonl",
			activeSessionId: this.activeSessionId,
			inputPath,
			cwdOverride,
		});
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_html",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		const data = await this.requestData<{ path: string }>({
			type: "export_jsonl",
			activeSessionId: this.activeSessionId,
			outputPath,
		});
		return data.path;
	}

	async setSessionName(name: string): Promise<void> {
		await this.requestOk({ type: "set_session_name", activeSessionId: this.activeSessionId, name });
	}

	async getRlmMaxDepthStatus() {
		return this.requestData<{ maxDepth: number; source: "default" | "env" | "global" | "inherited" | "chat" }>({
			type: "get_rlm_max_depth_status",
			activeSessionId: this.activeSessionId,
		});
	}

	async setRlmMaxDepth(maxDepth: number, options?: { global?: boolean }) {
		return this.requestData<{
			maxDepth: number;
			source: "default" | "env" | "global" | "inherited" | "chat";
			globalSaved: boolean;
			globalError?: string;
		}>({
			type: "set_rlm_max_depth",
			activeSessionId: this.activeSessionId,
			maxDepth,
			global: options?.global,
		});
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		await renameDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath, name);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return deleteDaemonSavedSession(this.client, { activeSessionId: this.activeSessionId }, sessionPath);
	}

	async watchSession(activeSessionId: string): Promise<AgentConnectionSessionWatcher | undefined> {
		// A second connection on the shared client; each one filters to its own session id.
		// attach() rejects for an unknown/exited session — treat that as unreachable.
		let connection: DaemonAgentConnection;
		try {
			connection = await DaemonAgentConnection.attach(this.client, activeSessionId, { closeClientOnDispose: false });
		} catch {
			return undefined;
		}
		return {
			getMessages: () => connection.getMessages(),
			getCommands: () => connection.getCommands(),
			subscribe: (listener) => connection.subscribe(listener),
			getToolDefinition: (name) => connection.getToolDefinition(name),
			close: () => connection.dispose(),
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed || this.disposing) {
			return;
		}
		this.disposing = true;
		if (this.options.ownedSession && !this.client.isConnected && this.reconnectPromise) {
			await Promise.race([this.reconnectPromise, delay(OWNED_SESSION_DISPOSE_RECONNECT_WAIT_MS)]).catch(
				() => undefined,
			);
		}
		this.disposed = true;
		this.updateRestartPending = false;
		await Promise.allSettled([...this.activeSideQuestionIds].map((id) => this.abortSideQuestion(id)));
		this.unsubscribeDaemonMessages();
		this.unsubscribeDaemonClose();
		if (this.options.ownedSession) {
			await this.requestOk({ type: "complete_owned_session", activeSessionId: this.activeSessionId }).catch(
				() => undefined,
			);
		} else {
			await this.requestOk({ type: "detach", activeSessionId: this.activeSessionId }).catch(() => undefined);
		}
		if (this.options.closeClientOnDispose) {
			this.client.close();
		}
		this.rejectSnapshotAssemblies(new Error("Daemon connection disposed during snapshot transfer"));
	}

	async promoteToResident(): Promise<void> {
		await this.withOwnedSessionPromotion(async (promoteOwnedSession) => {
			if (!promoteOwnedSession) return;
			await this.requestOk({ type: "promote_owned_session", activeSessionId: this.activeSessionId });
		});
	}

	private withOwnedSessionPromotion<T>(operation: (promoteOwnedSession: boolean) => Promise<T>): Promise<T> {
		const run = this.ownedSessionPromotionTail.then(async () => {
			const promoteOwnedSession = this.options.ownedSession === true;
			const result = await operation(promoteOwnedSession);
			if (promoteOwnedSession) {
				this.options.ownedSession = false;
			}
			return result;
		});
		this.ownedSessionPromotionTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reconnect(cause: Error): Promise<void> {
		if (this.reconnectPromise) {
			return this.reconnectPromise;
		}
		this.reconnectPromise = (async () => {
			void this.emit({ type: "connection_status", status: "reconnecting", error: cause.message });
			const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? DAEMON_RECONNECT_TIMEOUT_MS);
			let attempt = 0;
			let lastError: Error = cause;
			while (!this.disposed && Date.now() < deadline) {
				try {
					await this.options.recoverDaemon?.();
					if (this.disposed) {
						return;
					}
					await this.client.connect(1000);
					await this.client.waitForHello(3000);
					await this.attach();
					if (!this.disposed) {
						const snapshot = await this.getInitialSnapshot();
						void this.emit({ type: "session_resynced", snapshot });
						void this.emit({ type: "connection_status", status: "connected" });
					}
					return;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (this.disposed) {
						return;
					}
					this.client.resetTransportForReconnect();
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) {
						break;
					}
					const delayMs = Math.min(remainingMs, 2000, 100 * 2 ** Math.min(attempt, 5));
					attempt++;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
				}
			}
			if (!this.disposed) {
				this.client.close();
				await this.emit({ type: "closed", error: `Daemon reconnection failed: ${lastError.message}` });
			}
		})().finally(() => {
			this.reconnectPromise = undefined;
		});
		return this.reconnectPromise;
	}

	private async requestOk(command: DaemonCommandBody): Promise<void> {
		await this.requestData<unknown>(command);
	}

	private async requestData<T>(
		command: DaemonCommandBody,
		timeoutMs?: number,
		options?: Parameters<DaemonClient["request"]>[2],
	): Promise<T> {
		const response = await this.client.request(command, timeoutMs, options);
		if (!response.success) {
			const error = deserializeDaemonError(response);
			this.definitiveRequestErrors.add(error);
			throw error;
		}
		if (invalidatesCachedSnapshot(command.type)) {
			this.latestSnapshotIsFresh = false;
		}
		return response.data as T;
	}

	private async handleDaemonMessage(message: DaemonOutbound): Promise<void> {
		if (message.type === "heartbeats_changed") {
			await this.emit({ type: "heartbeats_changed" });
			return;
		}
		if (!this.isMessageForActiveSession(message)) {
			return;
		}
		if ("snapshotId" in message && this.ignoredSnapshotIds.has(message.snapshotId)) {
			if (message.type === "session_snapshot_end" || message.type === "session_snapshot_failed") {
				this.ignoredSnapshotIds.delete(message.snapshotId);
			}
			return;
		}
		if (message.type === "session_snapshot_begin") {
			const assembly = this.getSnapshotAssembly(message.snapshotId);
			assembly.begin = message;
			return;
		}
		if (message.type === "session_snapshot_chunk") {
			this.getSnapshotAssembly(message.snapshotId).chunks.set(message.index, message.messages);
			return;
		}
		if (message.type === "session_snapshot_end") {
			await this.completeSnapshotAssembly(message);
			return;
		}
		if (message.type === "session_snapshot_failed") {
			const assembly = this.getSnapshotAssembly(message.snapshotId);
			const purpose = assembly.begin?.purpose ?? "attach";
			const snapshotError = new Error(message.error);
			// Recovery re-reads state for the PUBLISHED binding; running it for a
			// pending transition target would query the old (typically archived)
			// selector and could emit a terminal close while the transition can
			// still succeed. A failed pending catch-up needs no recovery: the
			// failure is recorded so the transition invalidates its cached
			// attach snapshot at publication and re-reads fresh state, and on
			// supersession the marker is discarded.
			const isPendingCatchupFailure =
				(purpose === "replacement" || purpose === "resync") && message.activeSessionId !== this.activeSessionId;
			if (isPendingCatchupFailure && this.pendingReattachActiveSessionIds.has(message.activeSessionId)) {
				this.pendingBindingCatchupFailures.add(message.activeSessionId);
				// Newest wins in both directions: this failure is newer than any
				// buffered success, whose snapshot now predates the events the
				// failed catch-up carried. Drop it so publication consumes the
				// marker and re-reads instead of serving the stale buffer.
				this.pendingBindingCatchupSnapshots.delete(message.activeSessionId);
			}
			const recoveryPromise =
				(purpose === "replacement" || purpose === "resync") && message.activeSessionId === this.activeSessionId
					? this.recoverFailedSnapshot(purpose, snapshotError)
					: undefined;
			if (recoveryPromise) {
				this.snapshotRecoveryPromises.set(message.snapshotId, recoveryPromise);
			}
			this.rejectSnapshotAssembly(message.snapshotId, assembly, snapshotError);
			this.ignoreSnapshotId(message.snapshotId);
			if (recoveryPromise) {
				try {
					await recoveryPromise;
				} finally {
					this.snapshotRecoveryPromises.delete(message.snapshotId);
				}
			}
			return;
		}
		if (this.isStaleSequencedMessage(message)) {
			return;
		}
		this.observeDaemonEventSequence(message);

		if (message.type === "session_event") {
			if (message.event.type !== "refine_complete" && message.event.type !== "refine_failed") {
				this.observeStreamingMessage(message.event);
			}
			this.latestSnapshotIsFresh = false;
			await this.emit({ type: "session_event", event: message.event });
			return;
		}
		if (message.type === "side_question_event") {
			this.observeSideQuestionEvent(message.event);
			await this.emit({ type: "side_question_event", event: message.event });
			return;
		}
		if (message.type === "session_status") {
			// Keep a cached snapshot's recap current so a later re-attach seeds it.
			if (this.latestSnapshot) {
				this.latestSnapshot = {
					...this.latestSnapshot,
					state: { ...this.latestSnapshot.state, recap: message.recap },
				};
			}
			await this.emit({ type: "session_status", recap: message.recap });
			return;
		}
		if (message.type === "session_resynced") {
			this.attachedSessionId = message.snapshot.state.sessionId;
			this.attachedSessionFile = message.snapshot.state.sessionFile;
			this.latestSnapshot = mapDaemonSessionSnapshot(message.snapshot);
			if (this.lastEventSequence !== undefined) {
				this.latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			if (this.lastEventCursor) {
				this.latestSnapshot.lastEventCursor = this.lastEventCursor;
			}
			this.latestSnapshotIsFresh = true;
			await this.emit({ type: "session_resynced", snapshot: this.latestSnapshot });
			return;
		}
		if (message.type === "session_replaced") {
			this.attachedSessionId = message.state.sessionId;
			this.attachedSessionFile = message.state.sessionFile;
			if (message.snapshotFollows) {
				this.latestSnapshotIsFresh = false;
				return;
			}
			const latestSnapshot: AgentConnectionSnapshot = {
				state: message.state,
				messages: message.messages,
			};
			if (this.lastEventSequence !== undefined) {
				latestSnapshot.lastEventSequence = this.lastEventSequence;
			}
			if (this.lastEventCursor) {
				latestSnapshot.lastEventCursor = this.lastEventCursor;
			}
			this.latestSnapshot = latestSnapshot;
			this.latestSnapshotIsFresh = true;
			await this.emit({ type: "session_replaced", state: message.state, messages: message.messages });
			return;
		}
		if (message.type === "extension_ui_request") {
			await this.emit({
				type: "extension_ui_request",
				request: {
					id: message.id,
					method: message.method,
					payload: message.payload,
				},
			});
			return;
		}
		if (message.type === "extension_error") {
			await this.emit({
				type: "extension_error",
				extensionPath: message.extensionPath,
				event: message.event,
				error: message.error,
			});
			return;
		}
		if (message.type === "session_closed") {
			if (message.reason === "update") {
				this.captureDaemonLogPath();
				this.updateRestartPending = true;
				void this.reconnectAfterUpdate();
				return;
			}
			this.terminalCloseEmitted = true;
			await this.emit({ type: "closed", error: this.formatDaemonSessionClosedError(message.reason) });
		}
	}

	private captureDaemonLogPath(): void {
		const socketPath = this.client.hello?.socketPath;
		if (socketPath) {
			this.daemonLogPath = getDaemonLogPath(socketPath);
		}
	}

	private formatDaemonSessionClosedError(reason: DaemonSessionClosedReason): string {
		const explanation: Record<DaemonSessionClosedReason, string> = {
			killed:
				"The daemon stopped this agent session. Its transcript remains saved and can be reopened from Agents View.",
			shutdown:
				"The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
			completed:
				"The daemon closed this agent session after it completed. Its transcript remains available from Agents View.",
			replaced:
				"The daemon replaced this agent session with another session. Reopen the current session from Agents View.",
			update:
				"The Prime Agent daemon restarted for an update, but this window did not restore automatically. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
		};
		return `${explanation[reason]} ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatDaemonConnectionClosedError(error: Error): string {
		return `Lost connection to the Prime Agent daemon. Cause: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent or reopen the session from Agents View. ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatUpdateReconnectError(error: unknown): string {
		return `The Prime Agent daemon restarted for an update, but this window could not reconnect to its restored session before the recovery timeout expired. Last error: ${formatErrorSentence(error)} The session transcript remains saved; restart Prime Agent and reopen it from Agents View. ${this.formatDaemonDiagnosticContext()}`;
	}

	private formatDaemonDiagnosticContext(): string {
		const details: string[] = [];
		if (this.attachedSessionId) {
			details.push(`Session ID: ${this.attachedSessionId}.`);
		}
		if (this.attachedSessionFile) {
			details.push(`Session file: ${this.attachedSessionFile}.`);
		}
		details.push(`Diagnostic log: ${this.daemonLogPath ?? getAgentLogPath()}.`);
		return details.join(" ");
	}

	private reconnectAfterUpdate(): Promise<void> {
		if (this.updateReconnectPromise) {
			return this.updateReconnectPromise;
		}
		void this.emit({
			type: "connection_status",
			status: "reconnecting",
			error: "The Prime Agent daemon is restarting for an update.",
		});
		const reconnectPromise = reconnectDaemonTransportAfterUpdate(this.client)
			.then(() => this.restoreConnectionAfterUpdate())
			.then(() => {
				if (!this.disposed) {
					void this.emit({ type: "connection_status", status: "connected" });
				}
			})
			.catch(async (error: unknown) => {
				this.updateRestartPending = false;
				this.updateReconnectFailed = true;
				if (!this.disposed) {
					this.terminalCloseEmitted = true;
					await this.emit({
						type: "closed",
						error: this.formatUpdateReconnectError(error),
					});
				}
			})
			.finally(() => {
				if (this.updateReconnectPromise === reconnectPromise) {
					this.updateReconnectPromise = undefined;
				}
			});
		this.updateReconnectPromise = reconnectPromise;
		return reconnectPromise;
	}

	private async restoreConnectionAfterUpdate(): Promise<void> {
		const sessionId = this.attachedSessionId;
		const sessionFile = this.attachedSessionFile;
		if (!sessionId && !sessionFile) {
			throw new Error("the previous session identity is unavailable");
		}
		const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MS;
		let lastError: unknown;
		while (!this.disposed && Date.now() < deadline) {
			try {
				await this.client.reconnect(1000);
				if (this.disposed) {
					return;
				}
				const response = await this.client.request({ type: "list" }, 30000);
				if (this.disposed) {
					return;
				}
				if (!response.success) {
					throw deserializeDaemonError(response);
				}
				const sessions = readSessionSummaries(response.data);
				const restored = sessions.find(
					(summary) =>
						summary.activeSessionId !== undefined &&
						((sessionFile !== undefined && summary.sessionFile === sessionFile) ||
							(sessionId !== undefined && summary.sessionId === sessionId)),
				);
				if (restored?.activeSessionId) {
					if (this.disposed) {
						return;
					}
					this.activeSessionId = restored.activeSessionId;
					this.lastEventSequence = undefined;
					this.lastEventCursor = undefined;
					this.retiredEventGenerations.clear();
					await this.attach();
					if (this.disposed) {
						return;
					}
					const snapshot = await this.getInitialSnapshot();
					if (this.disposed) {
						return;
					}
					this.updateRestartPending = false;
					void this.emit({ type: "session_resynced", snapshot });
					return;
				}
			} catch (error) {
				lastError = error;
			}
			await delay(UPDATE_RECONNECT_RETRY_MS);
		}
		if (this.disposed) {
			return;
		}
		throw lastError ?? new Error("the restored session did not become available");
	}

	private getSnapshotAssembly(snapshotId: string): DaemonSnapshotAssembly {
		const existing = this.snapshotAssemblies.get(snapshotId);
		if (existing) {
			return existing;
		}
		let resolveSnapshot!: (snapshot: DaemonSessionSnapshot) => void;
		let rejectSnapshot!: (error: Error) => void;
		const promise = new Promise<DaemonSessionSnapshot>((resolve, reject) => {
			resolveSnapshot = resolve;
			rejectSnapshot = reject;
		});
		void promise.catch(() => undefined);
		const timeout = setTimeout(() => {
			const current = this.snapshotAssemblies.get(snapshotId);
			if (current) {
				current.reject(new Error(`Timed out waiting for snapshot ${snapshotId}`));
				this.snapshotAssemblies.delete(snapshotId);
				this.ignoreSnapshotId(snapshotId);
			}
		}, this.options.snapshotTimeoutMs ?? DAEMON_SNAPSHOT_TIMEOUT_MS);
		timeout.unref();
		const assembly: DaemonSnapshotAssembly = {
			chunks: new Map(),
			promise,
			resolve: resolveSnapshot,
			reject: rejectSnapshot,
			timeout,
		};
		this.snapshotAssemblies.set(snapshotId, assembly);
		return assembly;
	}

	private rejectSnapshotAssemblies(error: Error): void {
		for (const assembly of this.snapshotAssemblies.values()) {
			clearTimeout(assembly.timeout);
			assembly.reject(error);
		}
		this.snapshotAssemblies.clear();
		this.completedSnapshots.clear();
		this.pendingBindingCatchupSnapshots.clear();
		this.pendingBindingCatchupFailures.clear();
		this.snapshotRecoveryPromises.clear();
		this.ignoredSnapshotIds.clear();
	}

	private ignoreSnapshotId(snapshotId: string): void {
		this.ignoredSnapshotIds.add(snapshotId);
		while (this.ignoredSnapshotIds.size > MAX_IGNORED_SNAPSHOT_IDS) {
			const oldest = this.ignoredSnapshotIds.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.ignoredSnapshotIds.delete(oldest);
		}
	}

	private rejectSnapshotAssembly(snapshotId: string, assembly: DaemonSnapshotAssembly, error: Error): void {
		assembly.reject(error);
		clearTimeout(assembly.timeout);
		if (assembly.begin?.purpose && assembly.begin.purpose !== "attach") {
			this.snapshotAssemblies.delete(snapshotId);
		}
	}

	private async recoverFailedSnapshot(purpose: "replacement" | "resync", snapshotError: Error): Promise<void> {
		this.latestSnapshotIsFresh = false;
		if (purpose === "replacement") {
			this.latestSnapshot = undefined;
		}
		try {
			const snapshot = await this.getInitialSnapshot();
			if (this.disposed) {
				return;
			}
			this.attachedSessionId = snapshot.state.sessionId;
			this.attachedSessionFile = snapshot.state.sessionFile;
			if (purpose === "replacement") {
				await this.emit({ type: "session_replaced", state: snapshot.state, messages: snapshot.messages });
			} else {
				await this.emit({ type: "session_resynced", snapshot });
			}
		} catch (recoveryError) {
			if (this.disposed) {
				return;
			}
			this.terminalCloseEmitted = true;
			await this.emit({
				type: "closed",
				error: `Failed to recover from a ${purpose} snapshot transfer. Snapshot error: ${formatErrorSentence(snapshotError)} Recovery error: ${formatErrorSentence(recoveryError)} ${this.formatDaemonDiagnosticContext()}`,
			});
		}
	}

	private async waitForSnapshot(snapshotId: string): Promise<DaemonSessionSnapshot> {
		const completed = this.completedSnapshots.get(snapshotId);
		if (completed) {
			this.completedSnapshots.delete(snapshotId);
			return completed;
		}
		const assembly = this.getSnapshotAssembly(snapshotId);
		try {
			return await assembly.promise;
		} finally {
			clearTimeout(assembly.timeout);
			this.snapshotAssemblies.delete(snapshotId);
			this.completedSnapshots.delete(snapshotId);
		}
	}

	private applyReplacementSnapshot(snapshot: DaemonSessionSnapshot, replay?: DaemonReplayInfo): void {
		if (snapshot.lastEventCursor) {
			this.observeEventCursor(snapshot.lastEventCursor);
		}
		this.lastEventSequence = maxEventSequence(this.lastEventSequence, snapshot.lastEventSequence);
		this.attachedSessionId = snapshot.state.sessionId;
		this.attachedSessionFile = snapshot.state.sessionFile;
		this.latestSnapshot = mapDaemonSessionSnapshot(snapshot, replay);
		this.latestSnapshotIsFresh = true;
	}

	private async completeSnapshotAssembly(
		message: Extract<DaemonOutbound, { type: "session_snapshot_end" }>,
	): Promise<void> {
		const assembly = this.getSnapshotAssembly(message.snapshotId);
		if (!assembly.begin) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(`Snapshot ${message.snapshotId} ended before it began`),
			);
			return;
		}
		if (assembly.chunks.size !== message.chunkCount) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(
					`Snapshot ${message.snapshotId} ended with ${assembly.chunks.size} of ${message.chunkCount} chunks`,
				),
			);
			return;
		}
		const messages: AgentMessage[] = [];
		for (let index = 0; index < message.chunkCount; index++) {
			const chunk = assembly.chunks.get(index);
			if (!chunk) {
				this.rejectSnapshotAssembly(
					message.snapshotId,
					assembly,
					new Error(`Snapshot ${message.snapshotId} is missing chunk ${index}`),
				);
				return;
			}
			messages.push(...chunk);
		}
		if (messages.length !== assembly.begin.messageCount) {
			this.rejectSnapshotAssembly(
				message.snapshotId,
				assembly,
				new Error(
					`Snapshot ${message.snapshotId} contained ${messages.length} of ${assembly.begin.messageCount} messages`,
				),
			);
			return;
		}
		const snapshot: DaemonSessionSnapshot = {
			...assembly.begin.snapshot,
			messages,
			lastEventSequence: message.lastEventSequence,
			lastEventCursor: message.lastEventCursor,
		};
		// A snapshot admitted for a pending binding transition may complete while
		// the published binding is (still, or again) a different session; its
		// waiter gets the resolved snapshot below, but the shared identity and
		// snapshot cache must only describe the published binding.
		const isForPublishedBinding = message.activeSessionId === this.activeSessionId;
		let mappedSnapshot: AgentConnectionSnapshot | undefined;
		if (isForPublishedBinding) {
			if (message.lastEventCursor) {
				this.observeEventCursor(message.lastEventCursor);
			}
			this.lastEventSequence = maxEventSequence(this.lastEventSequence, message.lastEventSequence);
			this.attachedSessionId = snapshot.state.sessionId;
			this.attachedSessionFile = snapshot.state.sessionFile;
			mappedSnapshot = mapDaemonSessionSnapshot(snapshot);
			this.latestSnapshot = mappedSnapshot;
			this.latestSnapshotIsFresh = true;
		}
		assembly.resolve(snapshot);
		const purpose = assembly.begin.purpose ?? "attach";
		clearTimeout(assembly.timeout);
		if (purpose !== "attach") {
			this.snapshotAssemblies.delete(message.snapshotId);
			if (this.pendingReattachActiveSessionIds.has(message.activeSessionId)) {
				this.completedSnapshots.set(message.snapshotId, snapshot);
				while (this.completedSnapshots.size > MAX_COMPLETED_SNAPSHOTS) {
					const oldest = this.completedSnapshots.keys().next().value;
					if (oldest === undefined) {
						break;
					}
					this.completedSnapshots.delete(oldest);
				}
				if (!isForPublishedBinding) {
					// An unsolicited catch-up (the daemon queues events that land
					// during an attach snapshot and delivers them as a resync) for
					// a still-pending binding target has no waiter: buffer the
					// newest one per target so the attach can apply it once the
					// binding publishes, instead of losing the intervening events
					// behind the older attach snapshot. A success supersedes any
					// earlier failed catch-up for the target.
					this.pendingBindingCatchupSnapshots.set(message.activeSessionId, snapshot);
					this.pendingBindingCatchupFailures.delete(message.activeSessionId);
				}
			}
		}
		if (purpose === "replacement" && isForPublishedBinding) {
			await this.emit({ type: "session_replaced", state: snapshot.state, messages });
		} else if (purpose === "resync" && mappedSnapshot) {
			await this.emit({ type: "session_resynced", snapshot: mappedSnapshot });
		}
	}

	private observeStreamingMessage(event: AgentSessionEvent): void {
		if (!this.latestSnapshot) {
			return;
		}
		if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
			this.latestSnapshot = { ...this.latestSnapshot, streamingMessage: event.message };
			return;
		}
		if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "agent_end") {
			const { streamingMessage: _streamingMessage, ...snapshot } = this.latestSnapshot;
			this.latestSnapshot = snapshot;
		}
	}

	private isMessageForActiveSession(message: DaemonOutbound): boolean {
		if (!("activeSessionId" in message)) {
			return false;
		}
		if (message.activeSessionId === this.activeSessionId) {
			return true;
		}
		// A binding transition's target is admitted alongside the published
		// binding, but ONLY for snapshot transfer frames: the daemon starts
		// streaming the target's attach snapshot in the same socket buffer as
		// the attach response, so those frames can be parsed before the
		// awaiting continuation publishes the new binding. Live frames
		// (session_event, session_status, session_closed, ...) for a pending
		// target must not be processed against the published binding — after a
		// supersession they belong to a session this window no longer shows.
		return (
			message.activeSessionId !== undefined &&
			this.pendingReattachActiveSessionIds.has(message.activeSessionId) &&
			isSnapshotTransferMessage(message)
		);
	}

	private isStaleSequencedMessage(message: DaemonOutbound): boolean {
		const cursor = getDaemonMessageCursor(message);
		if (cursor) {
			if (this.retiredEventGenerations.has(cursor.generation)) {
				return true;
			}
			return (
				this.lastEventCursor?.generation === cursor.generation && cursor.sequence <= this.lastEventCursor.sequence
			);
		}
		const sequence = getDaemonMessageSequence(message);
		return sequence !== undefined && this.lastEventSequence !== undefined && sequence <= this.lastEventSequence;
	}

	private observeDaemonEventSequence(message: DaemonOutbound): void {
		const cursor = getDaemonMessageCursor(message);
		if (cursor) {
			this.observeEventCursor(cursor);
			this.lastEventSequence = cursor.sequence;
			return;
		}
		const sequence = getDaemonMessageSequence(message);
		if (sequence === undefined) {
			return;
		}
		this.lastEventSequence =
			this.lastEventSequence === undefined ? sequence : Math.max(this.lastEventSequence, sequence);
		if (this.lastEventCursor) {
			this.lastEventCursor = {
				...this.lastEventCursor,
				sequence: Math.max(this.lastEventCursor.sequence, sequence),
			};
		}
	}

	private observeEventCursor(cursor: DaemonEventCursor): void {
		const current = this.lastEventCursor;
		if (current && current.generation !== cursor.generation) {
			this.retiredEventGenerations.add(current.generation);
		}
		if (!current || current.generation !== cursor.generation || cursor.sequence > current.sequence) {
			this.lastEventCursor = cursor;
		}
	}

	private async emit(event: AgentConnectionEvent): Promise<void> {
		const deliveries: Promise<void>[] = [];
		for (const listener of [...this.listeners]) {
			try {
				deliveries.push(Promise.resolve(listener(event)));
			} catch {
				// One attachment must not interrupt delivery or transport recovery for the others.
			}
		}
		await Promise.allSettled(deliveries);
	}

	private observeSideQuestionEvent(event: AgentConnectionSideQuestionEvent): void {
		if (event.status !== "running") {
			this.activeSideQuestionIds.delete(event.id);
		}
	}
}

function isSnapshotTransferMessage(message: DaemonOutbound): boolean {
	return (
		message.type === "session_snapshot_begin" ||
		message.type === "session_snapshot_chunk" ||
		message.type === "session_snapshot_end" ||
		message.type === "session_snapshot_failed"
	);
}

/**
 * The identity a revival resolved with: the retry must verify not just the
 * active id but the transcript identity, because an in-worker session switch
 * replaces the runtime transcript without changing the active-session id.
 */
interface RevivedSessionBinding {
	activeSessionId: string;
	sessionId: string | undefined;
	sessionFile: string | undefined;
}

function readCreatedActiveSessionId(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Daemon returned an invalid session summary");
	}
	const summary = value as { id?: unknown; activeSessionId?: unknown };
	const activeSessionId =
		typeof summary.activeSessionId === "string"
			? summary.activeSessionId
			: typeof summary.id === "string"
				? summary.id
				: undefined;
	if (!activeSessionId) {
		throw new Error("Daemon returned a revived session without an active session id");
	}
	return activeSessionId;
}

function readSessionSummaries(value: unknown): SessionSummary[] {
	if (!value || typeof value !== "object" || !Array.isArray((value as { sessions?: unknown }).sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	return (value as { sessions: SessionSummary[] }).sessions;
}

function getAttachActiveSessionId(result: SessionSummary | DaemonAttachResult): string {
	if ("snapshot" in result) {
		return result.activeSessionId;
	}
	return result.activeSessionId ?? result.id;
}

function getAttachLastEventSequence(result: SessionSummary | DaemonAttachResult): number | undefined {
	if ("lastEventSequence" in result) {
		return result.lastEventSequence;
	}
	return undefined;
}

function getAttachLastEventCursor(result: SessionSummary | DaemonAttachResult): DaemonEventCursor | undefined {
	if ("lastEventCursor" in result) {
		return result.lastEventCursor;
	}
	return undefined;
}

function maxEventSequence(current: number | undefined, observed: number | undefined): number | undefined {
	if (current === undefined) {
		return observed;
	}
	if (observed === undefined) {
		return current;
	}
	return Math.max(current, observed);
}

function mapDaemonSessionSnapshot(snapshot: DaemonSessionSnapshot, replay?: DaemonReplayInfo): AgentConnectionSnapshot {
	const connectionSnapshot: AgentConnectionSnapshot = {
		state: snapshot.state,
		messages: snapshot.messages,
		...(snapshot.summary.streamingMessage ? { streamingMessage: snapshot.summary.streamingMessage } : {}),
		lastEventSequence: snapshot.lastEventSequence,
		lastEventCursor: snapshot.lastEventCursor,
	};
	if (snapshot.sessionContext) {
		connectionSnapshot.sessionContext = snapshot.sessionContext;
	}
	if (snapshot.sessionTree) {
		connectionSnapshot.sessionTree = snapshot.sessionTree;
	}
	if (snapshot.parent) {
		connectionSnapshot.parent = snapshot.parent;
	}
	if (snapshot.children) {
		connectionSnapshot.children = snapshot.children;
	}
	if (replay) {
		connectionSnapshot.replay = replay;
	}
	return connectionSnapshot;
}

function getDaemonMessageSequence(message: DaemonOutbound): number | undefined {
	if (!("meta" in message)) {
		return undefined;
	}
	return message.meta?.sequence;
}

function getDaemonMessageCursor(message: DaemonOutbound): DaemonEventCursor | undefined {
	if (!("meta" in message)) {
		return undefined;
	}
	return message.meta?.cursor;
}

function invalidatesCachedSnapshot(commandType: DaemonCommandBody["type"]): boolean {
	switch (commandType) {
		case "attach":
		case "reattach":
		case "detach":
		case "list":
		case "list_saved_sessions":
		case "wait_for_idle":
		case "get_state":
		case "get_connection_state":
		case "get_messages":
		case "get_session_stats":
		case "get_commands":
		case "get_resource_snapshot":
		case "get_model_catalog":
		case "get_available_models":
		case "get_queue":
		case "cron_list":
		case "heartbeats_list":
		case "get_session_context":
		case "get_session_tree":
		case "get_user_messages_for_forking":
		case "get_last_assistant_text":
		case "get_system_prompt":
		case "get_tool_definition":
		case "start_side_question":
		case "abort_side_question":
		case "export_html":
		case "export_jsonl":
			return false;
		default:
			return true;
	}
}
