import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type CloudGuestCursorRecord,
	CloudTunnelAttachment,
	type CloudTunnelAttachmentTarget,
} from "../../core/cloud/bridge/tunnel-attachment.js";
import type { CloudTunnelTransport } from "../../core/cloud/bridge/tunnel-transport.js";
import { WsTunnelTransport } from "../../core/cloud/bridge/tunnel-transport.js";
import type { CloudSessionRecord, CloudSessionSpawnInfo } from "../../core/cloud/cloud-session-store.js";
import {
	DirectCloudService,
	type DirectCloudServiceOptions,
	isResidentCloudSessionRecord,
	loadTunnelGuestCursor,
	saveTunnelGuestCursor,
} from "../../core/cloud/direct-cloud-service.js";
import { DurableCloudEventOutbox } from "../../core/cloud/event-outbox.js";
import {
	type CloudArtifactRef,
	type CloudCommandReceipt,
	type CloudCommandRequest,
	type CloudEvent,
	type CloudRosterRow,
	type CloudSessionStatus,
	isTerminalCloudCommandState,
	newCloudSessionId,
} from "../../core/cloud/protocol.js";
import { type ShadowArtifactResolver, ShadowSessionWriter } from "../../core/cloud/shadow-session-writer.js";
import { emptyGoalState } from "../../core/goals.js";
import { PromptAdmissionCancelledError } from "../../core/prompt-admission.js";
import { createDefaultRlmSubagentSessionName } from "../../core/rlm-runtime.js";
import { buildSessionContext, type SessionEntry, type SessionHeader } from "../../core/session-manager.js";
import type { SessionUsageSummary } from "../../core/usage.js";
import type {
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionHeader,
	AgentConnectionSessionTreeNode,
	AgentConnectionState,
} from "../agent-connection/types.js";
import { rosterAgentIdForSummary, type WorkerRosterEntry } from "./agent-roster.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonCloudSessionInfo,
	type DaemonCommand,
	type DaemonEventMeta,
	type DaemonResponse,
	failure,
	success,
} from "./daemon-protocol.js";
import type { CloudSessionConnectivity, SessionExecutionInfo, SessionSummary } from "./daemon-session-list.js";

/**
 * Supervisor-owned resident cloud session registry.
 *
 * One instance per daemon supervisor owns every cloud session record:
 *
 * - Resident records get a single-writer local shadow transcript per remote
 *   session (root and every descendant), a tunnel attachment that mirrors
 *   `session_entry` events (fsync strictly before the guest ack), a cached
 *   live-meta snapshot, and a roster row projection carrying
 *   `execution.location === "cloud"`.
 * - Daemon commands addressed at a cloud row translate into protocol-v2
 *   cloud commands over the tunnel; read-only snapshots are served from the
 *   shadow and cached meta with no tunnel round-trip, through the supervisor
 *   control plane only.
 * - Records are durable (CloudSessionStore on disk), so a supervisor restart
 *   re-registers roster rows and re-attaches running sandboxes; a lost or
 *   stopped session keeps its shadow locally readable.
 * - Legacy one-shot delegations (records without resident fields) keep
 *   flowing through the owned DirectCloudService untouched.
 */

export interface CloudSessionRegistryCallbacks {
	log(message: string): void;
	/** Write/refresh one roster row (supervisor-owned roster store). */
	writeRosterEntry(entry: WorkerRosterEntry): void;
	/** Remove one roster row by agent id. */
	deleteRosterEntry(agentId: string): void;
	/** Durably record a remote-descendant parent edge at admission time. */
	appendLedgerEdge(input: {
		childId: string;
		parent: string;
		child: string;
		depth: number;
		name: string;
	}): Promise<void>;
	/** Remove a remote descendant's ledger edge (deleted child). */
	deleteLedgerChild(input: { childId: string; child: string }): Promise<void>;
	/**
	 * Push one spawned-cloud-child status update into the local parent's
	 * worker (feeds the parent's RlmChildRun). Provisioning is asynchronous,
	 * so updates may arrive at any time after admission.
	 */
	pushChildUpdate(update: {
		childId: string;
		/** The local parent's active-session id (the worker update address). */
		parentActiveSessionId: string;
		status: "queued" | "running" | "completed" | "error" | "cancelled";
		error?: string;
		answerPreview?: string;
	}): void;
	/** Fan one live session event out to the clients attached to the cloud row. */
	writeSessionEvent(activeSessionId: string, event: AgentConnectionSessionEvent, meta: DaemonEventMeta): boolean;
	/** Push a session status (recap) frame to attached clients. */
	writeSessionStatus(activeSessionId: string, recap: string | undefined): void;
	/** Push the cloud_session_update lifecycle/connectivity event to every client. */
	broadcastCloudSessionUpdate(info: DaemonCloudSessionInfo): void;
	/** Attached supervisor-client count for one active session id. */
	attachedClientCount(activeSessionId: string): number;
}

export interface CloudSessionRegistryOptions {
	/** Cloud state directory (agentDir/cloud): records, secrets, outboxes, cursors. */
	stateDirectory: string;
	/** Standard local session dir; shadow transcripts live beside ordinary sessions. */
	sessionDir: string;
	/** Default cwd for shadow headers when the record carries no baseline. */
	cwd: string;
	callbacks: CloudSessionRegistryCallbacks;
	/** Injectable service for tests; defaults to a real DirectCloudService. */
	service?: DirectCloudService;
	/** Injectable tunnel transport; defaults to the production WebSocket client. */
	transport?: CloudTunnelTransport;
	/** Injectable artifact gateway for oversized session entries. */
	artifactResolver?: ShadowArtifactResolver;
	/** Sandbox lifetime default in minutes. */
	timeoutMinutes?: number;
	/** Tunnel bridge token override (tests pin the guest's expected token). */
	bridgeToken?: string;
	/** Tunnel attachment reconnect floor; small in tests. */
	reconnectDelayMs?: number;
	/** Attachment submit wait before reporting a command as queued. */
	submitWaitMs?: number;
}

/** One addressable cloud row: the root session or a remote descendant. */
export interface CloudSessionTarget {
	record: CloudSessionRecord;
	/** The remote session id this target addresses (root or descendant). */
	remoteSessionId: string;
	/** Supervisor roster address (stable while the row is live). */
	activeSessionId: string;
	/** True when the target is a remote descendant row. */
	descendant: boolean;
	summary: SessionSummary;
}

/** The supervisor registry's spawn-admission result (supervisor command response). */
export interface RlmCloudSpawnAdmission {
	/** Cloud session id; doubles as the parent's `rlm_child_id`. */
	rlm_child_id: string;
	name: string;
	/** Local shadow-session directory (the handle's frozen `session_dir`). */
	session_dir: string;
	/** Resolved model selector "provider/modelId"; empty when unset. */
	model: string;
	cloud_session_id: string;
	/** Supervisor active-session id of the cloud roster row (cancel/delete address). */
	active_session_id: string;
}

/** Prompt admission hooks; the supervisor owns the admission registry. */
export interface CloudPromptAdmissionHooks {
	isCancelled(): boolean;
	markOwned(): void;
}

/** Attach snapshot pieces served from the shadow and cached meta. */
export interface CloudAttachSnapshot {
	summary: SessionSummary;
	state: AgentConnectionState;
	messages: AgentMessage[];
	sessionContext: AgentConnectionSessionContext;
	children: AgentConnectionRlmChildAgentSnapshot[];
	lastEventSequence: number;
}

interface CloudSessionMeta {
	sessionId: string;
	streaming: boolean;
	runningTools: number;
	queue: number;
	recap?: string;
	taskState?: "needs_input" | "completed";
	model?: string;
	updatedAt: string;
}

interface CloudChildRow {
	childId: string;
	parentRemoteId?: string;
	name?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	depth: number;
	preview?: string;
	/** Remote session id once observed (shadow key). */
	sessionId?: string;
	/** Supervisor active id for the descendant roster row. */
	activeSessionId: string;
}

interface CloudResidentSession {
	sessionId: string;
	record: CloudSessionRecord;
	activeSessionId: string;
	attachment: CloudTunnelAttachment;
	shadows: Map<string, ShadowSessionWriter>;
	/** Latest receipt per cloud command id; terminal states surface honestly. */
	receipts: Map<string, CloudCommandReceipt>;
	/** In-flight shadow appends (artifact transfer); flush awaits these before ack. */
	pendingAppends: Set<Promise<void>>;
	metaBySession: Map<string, CloudSessionMeta>;
	children: Map<string, CloudChildRow>;
	connectivity: CloudSessionConnectivity;
	eventRing: Array<{ sessionId: string; event: AgentConnectionSessionEvent }>;
	eventSequence: number;
	opened: boolean;
	usage: { inputTokens: number; outputTokens: number; requests: number };
	/** Spawned-child task tracker; present only for `location === "spawned-child"`. */
	spawnTask?: CloudSpawnTaskTracker;
}

/** Where a spawned cloud child's initial task stands, pushed to the parent. */
interface CloudSpawnTaskTracker {
	info: CloudSessionSpawnInfo;
	/** Whether the initial prompt was admitted into the guest journal. */
	promptAdmitted: boolean;
	/** The admitted task produced observable guest work (streaming or busy). */
	sawWork: boolean;
	/** One terminal state never transitions again. */
	terminal: boolean;
}

/** Bound on the ephemeral live-event ring (last ~60s / 1 MiB). */
const RING_MAX_EVENTS = 512;
const RING_MAX_BYTES = 1024 * 1024;
const CLOUD_MAX_MIRRORED_CHILDREN = 512;
const IDLE_WAIT_TIMEOUT_MS = 15 * 60_000;
const IDLE_WAIT_POLL_MS = 50;
const ATTACHMENT_WAIT_TIMEOUT_MS = 60_000;
const ATTACHMENT_WAIT_POLL_MS = 50;
const RECEIPT_WAIT_TIMEOUT_MS = 15_000;
const RECEIPT_WAIT_POLL_MS = 25;

/** Typed error thrown when a client tries to open a cloud shadow locally. */
export class CloudShadowSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CloudShadowSessionError";
	}
}

/** Commands served by the registry when a session-addressed command resolves to a cloud row. */
export function isCloudSessionCommand(command: DaemonCommand): boolean {
	switch (command.type) {
		case "prompt":
		case "prompt_and_wait":
		case "steer":
		case "follow_up":
		case "abort":
		case "set_model":
		case "set_thinking_level":
		case "compact":
		case "set_session_name":
		case "rename":
		case "send_message":
		case "cancel_rlm_child":
		case "delete_rlm_subagent":
		case "extension_ui_response":
		case "get_state":
		case "get_messages":
		case "get_session_header":
		case "get_session_tree":
		case "get_session_context":
		case "get_queue":
		case "get_rlm_children":
		case "wait_for_idle":
		case "wait_for_headless_completion":
			return true;
		default:
			return false;
	}
}

export class CloudSessionRegistry {
	readonly service: DirectCloudService;
	private readonly options: CloudSessionRegistryOptions;
	private readonly callbacks: CloudSessionRegistryCallbacks;
	private readonly transport: CloudTunnelTransport;
	private readonly sessions = new Map<string, CloudResidentSession>();
	private readonly activeIndex = new Map<string, { sessionId: string; remoteSessionId: string }>();
	private readonly shadowIndex = new Map<string, string>();
	private disposed = false;

	constructor(options: CloudSessionRegistryOptions) {
		this.options = options;
		this.callbacks = options.callbacks;
		this.transport = options.transport ?? new WsTunnelTransport();
		// The session dir must exist before any shadow path is canonicalized
		// (the canonical path is the create/attach interception key).
		mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
		if (options.service !== undefined) {
			this.service = options.service;
		} else {
			const serviceOptions: DirectCloudServiceOptions = {
				stateDirectory: options.stateDirectory,
				tunnelTransport: this.transport,
				// The registry exclusively owns resident records; the legacy
				// one-shot surface never touches them, so exactly one
				// attachment per record ever exists.
				recordFilter: (record) => !isResidentCloudSessionRecord(record),
			};
			this.service = new DirectCloudService(serviceOptions);
		}
	}

	get store() {
		return this.service.store;
	}

	// ---------------------------------------------------------------------------
	// Roster projection
	// ---------------------------------------------------------------------------

	/** Every live cloud roster row (root and descendants). */
	liveSummaries(): SessionSummary[] {
		const summaries: SessionSummary[] = [];
		for (const session of this.sessions.values()) {
			if (!this.isRowLive(session)) continue;
			summaries.push(this.rootSummary(session));
			for (const child of session.children.values()) {
				const summary = this.childSummary(session, child);
				if (summary !== undefined) summaries.push(summary);
			}
		}
		return summaries;
	}

	/** Resolve a client-supplied active session id (or cloud session id) to a cloud target. */
	resolveActive(selector: string): CloudSessionTarget | undefined {
		const indexEntry = this.activeIndex.get(selector);
		if (indexEntry !== undefined) {
			return this.targetForIndexed(indexEntry);
		}
		const session = this.sessions.get(selector);
		if (session === undefined || !this.isRowLive(session)) return undefined;
		return {
			record: this.currentRecord(session),
			remoteSessionId: session.record.sessionId,
			activeSessionId: session.activeSessionId,
			descendant: false,
			summary: this.rootSummary(session),
		};
	}

	private targetForIndexed(indexEntry: {
		sessionId: string;
		remoteSessionId: string;
	}): CloudSessionTarget | undefined {
		const session = this.sessions.get(indexEntry.sessionId);
		if (session === undefined || !this.isRowLive(session)) return undefined;
		if (indexEntry.remoteSessionId === session.record.sessionId) {
			return {
				record: this.currentRecord(session),
				remoteSessionId: indexEntry.remoteSessionId,
				activeSessionId: session.activeSessionId,
				descendant: false,
				summary: this.rootSummary(session),
			};
		}
		const child = this.childForRemote(session, indexEntry.remoteSessionId);
		const summary = child !== undefined ? this.childSummary(session, child) : undefined;
		if (child === undefined || summary === undefined) return undefined;
		return {
			record: this.currentRecord(session),
			remoteSessionId: indexEntry.remoteSessionId,
			activeSessionId: child.activeSessionId,
			descendant: true,
			summary,
		};
	}

	/** The record whose shadow file is this canonical path, when any. */
	recordForShadowFile(canonicalPath: string): CloudSessionRecord | undefined {
		const sessionId = this.shadowIndex.get(canonicalPath);
		if (sessionId === undefined) return undefined;
		return this.store.get(sessionId) ?? this.sessions.get(sessionId)?.record;
	}

	/** Execution marker for a saved shadow row; undefined for non-cloud files. */
	executionForShadowFile(canonicalPath: string): SessionExecutionInfo | undefined {
		const record = this.recordForShadowFile(canonicalPath);
		return record === undefined ? undefined : this.executionInfo(record, this.connectivityForRecord(record));
	}

	private connectivityForRecord(record: CloudSessionRecord): CloudSessionConnectivity {
		const session = this.sessions.get(record.sessionId);
		if (session !== undefined) return session.connectivity;
		if (record.observedLifecycle === "lost") return "lost";
		if (record.observedLifecycle === "stopped" || record.observedLifecycle === "deleted") return "stopped";
		return "disconnected";
	}

	// ---------------------------------------------------------------------------
	// Lifecycle commands (capability-gated daemon commands)
	// ---------------------------------------------------------------------------

	/** Convert one idle local session into a resident cloud session. */
	async convertSession(input: {
		cwd: string;
		/** Pre-allocated cloud session id (tests, future spawn admission); random by default. */
		sessionId?: string;
		sessionName?: string;
		model?: string;
		thinking?: string;
		timeoutMinutes?: number;
	}): Promise<DaemonCloudSessionInfo> {
		const sessionId = input.sessionId ?? newCloudSessionId();
		const shadowFile = ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, sessionId);
		if (existsSync(shadowFile)) {
			throw new Error(`Shadow session file already exists: ${shadowFile}`);
		}
		// Provision first: no shadow row is published until the guest exists.
		await this.service.delegate({
			activeSessionId: "",
			parentSessionId: undefined,
			delegationId: sessionId,
			cwd: input.cwd,
			prompt: "",
			options: {
				resident: true,
				tunnel: true,
				...(input.model ? { model: input.model } : {}),
				timeoutMinutes: input.timeoutMinutes ?? this.options.timeoutMinutes ?? 120,
				...(this.options.bridgeToken ? { bridgeToken: this.options.bridgeToken } : {}),
			},
		});
		let record = this.store.get(sessionId);
		if (record === undefined) throw new Error(`Cloud session record is missing: ${sessionId}`);
		this.store.setShadowSession(sessionId, shadowFile);
		this.store.setLocation(sessionId, "converted-root");
		record = this.store.get(sessionId)!;
		const session = this.registerResidentSession(record);
		this.writeRootShadow(session, record);
		try {
			await this.submitResident(session, `open_${randomUUID()}`, {
				kind: "open_session",
				cwd: input.cwd,
				...(input.model ? { model: input.model } : {}),
				...(input.thinking ? { thinking: input.thinking } : {}),
			});
			session.opened = true;
			if (input.sessionName) {
				await this.submitResident(session, `name_${randomUUID()}`, {
					kind: "set_session_name",
					name: input.sessionName,
				}).catch((error: unknown) => {
					this.callbacks.log(`cloud session name failed: ${String(error)}`);
				});
			}
		} catch (error) {
			// The sandbox is running; the failure surfaces on the row instead
			// of destroying the provisioned session.
			this.store.setLastError(
				sessionId,
				`open_session failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			session.connectivity = "disconnected";
		}
		this.publishRosterRows(session);
		const info = this.sessionInfo(session);
		this.callbacks.broadcastCloudSessionUpdate(info);
		return info;
	}

	/**
	 * Durably admit a first-class cloud child under a local parent and return
	 * the standard spawn handle immediately after admission (D7). The durable
	 * record, shadow transcript, roster row, and ledger edge exist before the
	 * response; provisioning and the guest's task run proceed asynchronously,
	 * with status pushes routed to the parent's worker.
	 */
	async spawnChild(input: {
		parent: {
			/** Local parent durable session id. */
			sessionId: string;
			/** Canonical local parent session file (ledger edge parent). */
			sessionFile: string;
			/** Parent active-session id (worker update routing). */
			activeSessionId: string;
			/** Parent RLM depth; the child is parent depth + 1. */
			depth: number;
			/** Workspace cwd captured for the guest. */
			cwd: string;
		};
		prompt: string;
		/** Stable child name; the registry generates a readable default when omitted. */
		name?: string;
		/** Pre-allocated cloud session id (tests); random by default. */
		sessionId?: string;
		/** Resolved model selector "provider/modelId". */
		model?: string;
		thinking?: string;
		timeoutMinutes?: number;
	}): Promise<RlmCloudSpawnAdmission> {
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("cloud_spawn_child prompt must not be empty");
		const sessionId = input.sessionId ?? newCloudSessionId();
		const shadowFile = ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, sessionId);
		if (existsSync(shadowFile)) {
			throw new Error(`Shadow session file already exists: ${shadowFile}`);
		}
		const depth = input.parent.depth + 1;
		const sessionName = input.name ?? createDefaultRlmSubagentSessionName(prompt, sessionId);
		const model = input.model ? `${input.model}` : undefined;
		const spawn: CloudSessionSpawnInfo = {
			parentSessionId: input.parent.sessionId,
			parentSessionFile: input.parent.sessionFile,
			parentActiveSessionId: input.parent.activeSessionId,
			depth,
			name: sessionName,
			prompt,
			...(model ? { model } : {}),
			...(input.thinking ? { thinking: input.thinking } : {}),
		};
		this.store.create({
			sessionId,
			parentSessionId: input.parent.sessionId,
			residentProcessUuid: randomUUID(),
		});
		let session: CloudResidentSession | undefined;
		try {
			this.store.setLocation(sessionId, "spawned-child");
			this.store.setShadowSession(sessionId, shadowFile);
			this.store.setSpawn(sessionId, spawn);
			// The row is live from admission (provisioning is in-flight work).
			this.store.setObservedLifecycle(sessionId, "provisioning");
			session = this.registerResidentSession(this.store.get(sessionId)!, { startAttachment: false });
			this.writeRootShadow(session, this.store.get(sessionId)!);
			session.spawnTask = { info: spawn, promptAdmitted: false, sawWork: false, terminal: false };
			// The normal ledger edge is load-bearing: admission fails closed when
			// the durable append fails (the same contract as a local child).
			await this.callbacks.appendLedgerEdge({
				childId: sessionId,
				parent: input.parent.sessionFile,
				child: shadowFile,
				depth,
				name: sessionName,
			});
		} catch (error) {
			await this.rollbackSpawnedChild(session, sessionId, shadowFile).catch((rollbackError: unknown) =>
				this.callbacks.log(`cloud spawn rollback failed for ${sessionId}: ${String(rollbackError)}`),
			);
			throw error;
		}
		this.publishRosterRows(session!);
		this.pushSpawnTaskUpdate(session!, "queued");
		// Provisioning is asynchronous: the handle returned before the sandbox exists.
		void this.provisionSpawnedChild(session!, spawn, input.parent.cwd, input.timeoutMinutes).catch(
			(error: unknown) => {
				// provisionSpawnedChild records its own failures; this is a rethrow guard.
				this.callbacks.log(
					`cloud spawn provisioning crashed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		);
		return {
			rlm_child_id: sessionId,
			name: sessionName,
			session_dir: this.options.sessionDir,
			model: model ?? "",
			cloud_session_id: sessionId,
			active_session_id: session!.activeSessionId,
		};
	}

	/** Admitted-but-failed spawn: retract the row, shadow, and durable record. */
	private async rollbackSpawnedChild(
		session: CloudResidentSession | undefined,
		sessionId: string,
		shadowFile: string,
	): Promise<void> {
		if (session !== undefined) {
			await this.disposeSession(session, { closeShadows: true, broadcast: false }).catch(() => undefined);
		}
		// No ledger edge may exist, so the never-published shadow is inert; a
		// stale file would block the same session id forever.
		rmSync(shadowFile, { force: true });
		const record = this.store.get(sessionId);
		if (record !== undefined && record.observedLifecycle !== "deleted") {
			this.store.setDesiredLifecycle(sessionId, "deleted");
			this.store.setObservedLifecycle(sessionId, "deleted");
		}
	}

	/** Provision the sandbox, open the guest session, and admit the initial task. */
	private async provisionSpawnedChild(
		session: CloudResidentSession,
		spawn: CloudSessionSpawnInfo,
		cwd: string,
		timeoutMinutes?: number,
	): Promise<void> {
		const sessionId = session.sessionId;
		try {
			await this.service.delegate({
				activeSessionId: "",
				parentSessionId: spawn.parentSessionId,
				delegationId: sessionId,
				cwd,
				prompt: "",
				options: {
					resident: true,
					tunnel: true,
					...(spawn.model ? { model: spawn.model } : {}),
					timeoutMinutes: timeoutMinutes ?? this.options.timeoutMinutes ?? 120,
					...(this.options.bridgeToken ? { bridgeToken: this.options.bridgeToken } : {}),
				},
			});
			if (this.spawnTaskCancelled(session)) return;
			// The tunnel is registered now: start the attachment and wait for
			// the guest bridge before admitting the task prompt.
			session.attachment.start();
			await this.waitForAttachment(session);
			// Recovery: a shadow that already holds the task prompt means the
			// guest admitted it before the restart; re-sending it would run
			// the task twice, so only the session open is repeated (idempotent).
			const alreadyAdmitted = this.spawnTaskAlreadyAdmitted(session);
			await this.submitResident(
				session,
				`open_${randomUUID()}`,
				{
					kind: "open_session",
					cwd,
					...(spawn.model ? { model: spawn.model } : {}),
					...(spawn.thinking ? { thinking: spawn.thinking } : {}),
					...(alreadyAdmitted ? {} : { prompt: `[task from parent]\n\n${spawn.prompt}` }),
				},
				true,
			);
			session.opened = true;
			if (session.spawnTask !== undefined) {
				session.spawnTask.promptAdmitted = true;
				// The admitted task IS the work: a fast guest may finish its
				// entire run between mirror ticks, so quiescence alone must
				// settle it once the shadow holds the child's answer.
				session.spawnTask.sawWork = true;
			}
			this.pushSpawnTaskUpdate(session, "running");
			this.publishRosterRows(session);
		} catch (error) {
			if (this.spawnTaskCancelled(session)) return;
			const message = error instanceof Error ? error.message : String(error);
			if (this.store.get(sessionId) !== undefined) this.store.setLastError(sessionId, message);
			this.pushSpawnTaskUpdate(session, "error", message);
			this.publishRosterRows(session);
		}
	}

	private spawnTaskCancelled(session: CloudResidentSession): boolean {
		return session.spawnTask !== undefined && session.spawnTask.terminal === true;
	}

	/** True when the mirrored shadow already holds the admitted task prompt. */
	private spawnTaskAlreadyAdmitted(session: CloudResidentSession): boolean {
		const shadow = session.shadows.get(session.sessionId);
		if (shadow === undefined) return false;
		return shadow
			.getEntries()
			.some((entry) => entry.type === "message" && JSON.stringify(entry).includes("[task from parent]"));
	}

	/** Wait for the guest bridge to accept the tunnel attachment (provisioning gate). */
	private async waitForAttachment(session: CloudResidentSession): Promise<void> {
		const deadline = Date.now() + ATTACHMENT_WAIT_TIMEOUT_MS;
		while (Date.now() < deadline && !this.disposed) {
			if (session.attachment.attached) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, ATTACHMENT_WAIT_POLL_MS));
		}
		throw new Error("cloud session did not attach before the wait timeout");
	}

	/** Push one task-status transition to the parent's worker; terminal states fire once. */
	private pushSpawnTaskUpdate(
		session: CloudResidentSession,
		status: "queued" | "running" | "completed" | "error" | "cancelled",
		error?: string,
	): void {
		const task = session.spawnTask;
		if (task === undefined) return;
		if (task.terminal) return;
		if (status === "completed" || status === "error" || status === "cancelled") {
			task.terminal = true;
		}
		this.callbacks.pushChildUpdate({
			childId: session.sessionId,
			parentActiveSessionId: task.info.parentActiveSessionId,
			status,
			...(error ? { error } : {}),
			...(status === "completed" ? { answerPreview: this.shadowAnswerPreview(session) } : {}),
		});
	}

	/** The cloud child's latest assistant text, read from the local shadow. */
	private shadowAnswerPreview(session: CloudResidentSession): string | undefined {
		const shadow = session.shadows.get(session.sessionId);
		if (shadow === undefined) return undefined;
		for (let index = shadow.getEntries().length - 1; index >= 0; index--) {
			const entry = shadow.getEntries()[index];
			if (entry.type !== "message") continue;
			const message = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (message?.role !== "assistant") continue;
			const text = readMessageText(message.content).trim();
			if (text) return text.slice(0, 240);
		}
		return undefined;
	}

	/** Cancel a spawned cloud child: abort the guest run and settle the parent. */
	private cancelSpawnedChild(session: CloudResidentSession, reason: string): void {
		if (this.spawnTaskCancelled(session)) return;
		if (session.opened) {
			void this.submitResident(session, `abort_${randomUUID()}`, { kind: "abort" }).catch((error: unknown) =>
				this.callbacks.log(`cloud spawn abort failed: ${String(error)}`),
			);
		}
		if (this.store.get(session.sessionId) !== undefined) this.store.setLastError(session.sessionId, reason);
		this.pushSpawnTaskUpdate(session, "cancelled", reason);
		this.publishRosterRows(session);
	}

	/** Stop and retract a spawned cloud child row (explicit delete path). */
	private async deleteSpawnedChild(session: CloudResidentSession): Promise<void> {
		this.cancelSpawnedChild(session, "Deleted by parent orchestrator");
		try {
			await this.stopSession(session.sessionId, true);
		} finally {
			const shadowFile = this.store.get(session.sessionId)?.shadowSessionFile;
			if (shadowFile !== undefined) {
				this.callbacks
					.deleteLedgerChild({ childId: session.sessionId, child: shadowFile })
					.catch((error: unknown) => this.callbacks.log(`cloud ledger delete failed: ${String(error)}`));
			}
		}
	}

	/** List every cloud session record (resident and legacy) with connectivity. */
	async listSessions(): Promise<DaemonCloudSessionInfo[]> {
		const infos: DaemonCloudSessionInfo[] = [];
		for (const record of this.store.list()) {
			if (isResidentCloudSessionRecord(record)) {
				await this.refreshResidentRecord(record).catch((error: unknown) => {
					this.callbacks.log(`cloud session refresh failed for ${record.sessionId}: ${String(error)}`);
				});
			}
			const session = this.sessions.get(record.sessionId);
			infos.push(
				session !== undefined
					? this.sessionInfo(session)
					: this.recordInfo(this.store.get(record.sessionId) ?? record),
			);
		}
		infos.sort(
			(left, right) =>
				left.createdAt.localeCompare(right.createdAt) || left.sessionId.localeCompare(right.sessionId),
		);
		return infos;
	}

	/** Resolve a selector (cloud active id or cloud session id) to a record. */
	recordForSelector(selector: string): CloudSessionRecord | undefined {
		const target = this.resolveActive(selector);
		if (target !== undefined) return target.record;
		return this.store.get(selector);
	}

	/** Stop one cloud session: drain, retrieve the result, release the sandbox. */
	async stopSession(selector: string, forfeit = false): Promise<DaemonCloudSessionInfo> {
		const record = this.requireRecordForSelector(selector);
		const session = this.sessions.get(record.sessionId);
		if (session !== undefined) {
			// Release first: the drain happens inside the guest.
			await this.submitResident(session, `release_${randomUUID()}`, { kind: "release" }).catch(() => undefined);
			await session.attachment.stop();
			await this.disposeSession(session, { closeShadows: true, broadcast: true });
		}
		if (session !== undefined && session.spawnTask !== undefined) {
			// A stopped spawned child settles the parent's run as cancelled.
			this.pushSpawnTaskUpdate(session, "cancelled", "Cloud session stopped");
		}
		const released = forfeit
			? await this.service.forfeitResidentSession(record.sessionId)
			: await this.service.stopResidentSession(record.sessionId, true);
		const info = this.recordInfo(released);
		this.callbacks.broadcastCloudSessionUpdate(info);
		return info;
	}

	/** Reprovision: bump the generation and provision a fresh sandbox for the same session id. */
	async reprovisionSession(selector: string, timeoutMinutes?: number): Promise<DaemonCloudSessionInfo> {
		const record = this.requireRecordForSelector(selector);
		if (!isResidentCloudSessionRecord(record)) {
			throw new Error(`Cloud session ${record.sessionId} is a legacy delegation and cannot be reprovisioned`);
		}
		const session = this.sessions.get(record.sessionId);
		const cwd = record.baseline?.repoRoot ?? this.shadowCwd(record);
		let rootShadow: ShadowSessionWriter | undefined;
		if (session !== undefined) {
			rootShadow = session.shadows.get(record.sessionId);
			await session.attachment.stop();
			await this.disposeSession(session, { closeShadows: false, broadcast: false });
		}
		// A fresh incarnation: same session id, same shadow, new cursors.
		this.store.nextGeneration(record.sessionId, randomUUID());
		const generation = this.store.get(record.sessionId)?.generation ?? record.generation + 1;
		if (rootShadow === undefined && record.shadowSessionFile !== undefined) {
			// A stopped session's shadow survives on disk; reopen it and keep
			// writing the same transcript across incarnations.
			rootShadow = ShadowSessionWriter.openOrCreate({
				sessionFile: record.shadowSessionFile,
				sessionId: record.sessionId,
				cwd,
				cloudSessionId: record.sessionId,
				generation,
			});
		}
		rootShadow?.appendGenerationMarker({ generation });
		await this.service.delegate({
			activeSessionId: "",
			parentSessionId: undefined,
			delegationId: record.sessionId,
			cwd,
			prompt: "",
			options: {
				resident: true,
				tunnel: true,
				timeoutMinutes: timeoutMinutes ?? this.options.timeoutMinutes ?? 120,
				...(this.options.bridgeToken ? { bridgeToken: this.options.bridgeToken } : {}),
			},
		});
		const fresh = this.store.get(record.sessionId)!;
		const nextSession = this.registerResidentSession(fresh);
		if (rootShadow !== undefined) nextSession.shadows.set(fresh.sessionId, rootShadow);
		else this.writeRootShadow(nextSession, fresh);
		try {
			await this.submitResident(nextSession, `open_${randomUUID()}`, { kind: "open_session", cwd });
			nextSession.opened = true;
		} catch (error) {
			this.store.setLastError(
				record.sessionId,
				`open_session failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			nextSession.connectivity = "disconnected";
		}
		this.publishRosterRows(nextSession);
		const info = this.sessionInfo(nextSession);
		this.callbacks.broadcastCloudSessionUpdate(info);
		return info;
	}

	/** Import a retrieved session result patch into the baseline repository. */
	async importResult(selector: string, cwd: string): Promise<DaemonCloudSessionInfo> {
		const record = this.requireRecordForSelector(selector);
		await this.service.applyForSession(record.sessionId, cwd);
		return this.recordInfo(this.store.get(record.sessionId) ?? record);
	}

	// ---------------------------------------------------------------------------
	// Legacy one-shot delegation surface (deprecated; kept for migration)
	// ---------------------------------------------------------------------------

	legacyList(ownerSessionId: string) {
		return this.service.list(ownerSessionId);
	}

	legacyDelegate(input: Parameters<DirectCloudService["delegate"]>[0]) {
		return this.service.delegate(input);
	}

	legacyStop(ownerSessionId: string, sessionId: string, forfeit: boolean) {
		return this.service.stop(ownerSessionId, sessionId, forfeit);
	}

	legacyApply(ownerSessionId: string, sessionId: string, cwd: string) {
		return this.service.apply(ownerSessionId, sessionId, cwd);
	}

	legacySteer(ownerSessionId: string, sessionId: string, text: string, steerId?: string) {
		return this.service.steer(ownerSessionId, sessionId, text, steerId);
	}

	// ---------------------------------------------------------------------------
	// Session command translation (DaemonCommand -> cloud commands)
	// ---------------------------------------------------------------------------

	/**
	 * Translate one session-plane daemon command into the cloud surface. A
	 * submission or dispatch failure becomes a typed failure response (the
	 * caller's journal records it; the client sees an honest error).
	 */
	async handleSessionCommand(
		command: DaemonCommand,
		target: CloudSessionTarget,
		admission?: CloudPromptAdmissionHooks,
	): Promise<DaemonResponse> {
		try {
			return await this.translateSessionCommand(command, target, admission);
		} catch (error) {
			if (error instanceof PromptAdmissionCancelledError) throw error;
			return failure(command.id, command.type, error instanceof Error ? error.message : String(error));
		}
	}

	private async translateSessionCommand(
		command: DaemonCommand,
		target: CloudSessionTarget,
		admission?: CloudPromptAdmissionHooks,
	): Promise<DaemonResponse> {
		const session = this.sessions.get(target.record.sessionId);
		if (session === undefined) {
			throw new Error(`Cloud session is not registered: ${target.record.sessionId}`);
		}
		// A spawned cloud child IS the guest root: the existing cancel/delete
		// verbs address its own lifecycle, not a guest-side subagent row.
		if (!target.descendant && session.spawnTask !== undefined) {
			switch (command.type) {
				case "cancel_rlm_child":
					this.cancelSpawnedChild(
						session,
						command.childId === session.sessionId
							? "Cancelled by parent orchestrator"
							: `Cancelled by parent orchestrator (${command.childId})`,
					);
					return success(command.id, command.type);
				case "delete_rlm_subagent":
					await this.deleteSpawnedChild(session);
					return success(command.id, command.type);
				default:
					break;
			}
		}
		if (target.descendant && !this.descendantCommandAllowed(command)) {
			return failure(
				command.id,
				command.type,
				`Remote descendant rows accept messages, not direct ${command.type}; prompt the cloud session instead`,
			);
		}
		switch (command.type) {
			case "prompt":
			case "prompt_and_wait": {
				const failed = await this.submitPrompt(session, command, admission);
				if (failed !== undefined) return failed;
				if (command.type === "prompt_and_wait") {
					await this.waitForIdle(session, false);
				}
				return success(command.id, command.type);
			}
			case "steer":
				await this.requireConnected(session, "steer");
				await this.submitResident(session, `steer_${command.id ?? randomUUID()}`, {
					kind: "steer",
					text: command.message,
				});
				return success(command.id, command.type);
			case "follow_up":
				await this.requireConnected(session, "follow up");
				await this.submitResident(session, `follow_${command.id ?? randomUUID()}`, {
					kind: "follow_up",
					text: command.message,
				});
				return success(command.id, command.type);
			case "abort":
				await this.requireConnected(session, "abort");
				await this.submitResident(session, `abort_${command.id ?? randomUUID()}`, { kind: "abort" });
				return success(command.id, command.type);
			case "set_model":
				await this.requireConnected(session, "set model");
				await this.submitResident(
					session,
					`model_${command.id ?? randomUUID()}`,
					{
						kind: "set_model",
						provider: command.provider,
						modelId: command.modelId,
					},
					true,
				);
				return success(command.id, command.type);
			case "set_thinking_level":
				await this.requireConnected(session, "set thinking level");
				await this.submitResident(
					session,
					`think_${command.id ?? randomUUID()}`,
					{
						kind: "set_thinking_level",
						level: command.level,
					},
					true,
				);
				return success(command.id, command.type);
			case "compact":
				await this.requireConnected(session, "compact");
				await this.submitResident(session, `compact_${command.id ?? randomUUID()}`, {
					kind: "compact",
					...(command.customInstructions ? { customInstructions: command.customInstructions } : {}),
				});
				return success(command.id, command.type);
			case "set_session_name":
			case "rename":
				await this.requireConnected(session, "rename");
				await this.submitResident(
					session,
					`name_${command.id ?? randomUUID()}`,
					{
						kind: "set_session_name",
						name: command.name,
					},
					true,
				);
				return success(command.id, command.type);
			case "send_message": {
				await this.requireConnected(session, "send message");
				const remoteSessionId = this.remoteSessionIdForSelector(command.targetActiveSessionId);
				if (remoteSessionId === undefined) {
					return failure(
						command.id,
						command.type,
						`Unknown cloud message target: ${command.targetActiveSessionId}`,
					);
				}
				await this.submitResident(session, `msg_${command.id ?? randomUUID()}`, {
					kind: "send_message",
					targetRemoteSessionId: remoteSessionId,
					message: command.message,
				});
				return success(command.id, command.type);
			}
			case "cancel_rlm_child":
				await this.requireConnected(session, "cancel child");
				await this.submitResident(
					session,
					`cancel_${command.id ?? randomUUID()}`,
					{
						kind: "cancel_child",
						childId: command.childId,
					},
					true,
				);
				return success(command.id, command.type);
			case "delete_rlm_subagent":
				await this.requireConnected(session, "delete child");
				await this.submitResident(
					session,
					`delete_${command.id ?? randomUUID()}`,
					{
						kind: "delete_child",
						childId: command.childId,
					},
					true,
				);
				return success(command.id, command.type);
			case "extension_ui_response":
				await this.requireConnected(session, "answer extension ui");
				await this.submitResident(session, `ui_${command.id ?? randomUUID()}`, {
					kind: "extension_ui_response",
					requestId: command.requestId,
					response: command.response,
				});
				return success(command.id, command.type);
			case "get_state":
				return success(command.id, command.type, this.connectionState(session, target));
			case "get_messages":
				return success(command.id, command.type, {
					messages: this.shadowContext(session, target.remoteSessionId).messages,
				});
			case "get_session_header":
				return success(command.id, command.type, this.sessionHeader(session, target));
			case "get_session_tree":
				return success(command.id, command.type, this.sessionTree(session, target));
			case "get_session_context":
				return success(command.id, command.type, this.shadowContext(session, target.remoteSessionId));
			case "get_queue": {
				const meta = session.metaBySession.get(target.remoteSessionId);
				return success(command.id, command.type, {
					queuedCount: meta?.queue ?? 0,
					steering: [],
					followUps: [],
				});
			}
			case "get_rlm_children":
				return success(command.id, command.type, { children: this.childSnapshots(session) });
			case "wait_for_idle":
				await this.waitForIdle(session, false);
				return success(command.id, command.type);
			case "wait_for_headless_completion":
				await this.waitForIdle(session, true);
				return success(command.id, command.type);
			default:
				return failure(
					command.id,
					command.type,
					`Command ${command.type} is not supported on a cloud session in this version`,
				);
		}
	}

	private descendantCommandAllowed(command: DaemonCommand): boolean {
		switch (command.type) {
			case "send_message":
			case "get_state":
			case "get_messages":
			case "get_session_header":
			case "get_session_tree":
			case "get_session_context":
			case "get_queue":
			case "wait_for_idle":
			case "wait_for_headless_completion":
				return true;
			default:
				return false;
		}
	}

	// ---------------------------------------------------------------------------
	// Attach serving (shadow + cached meta; supervisor control plane only)
	// ---------------------------------------------------------------------------

	/** Build the attach snapshot for a cloud row from the shadow and cached meta. */
	attachSnapshot(target: CloudSessionTarget): CloudAttachSnapshot {
		const session = this.requireSession(target.record.sessionId);
		const summary = target.descendant
			? (this.childSummary(session, this.childForRemote(session, target.remoteSessionId)) ?? target.summary)
			: this.rootSummary(session);
		return {
			summary: {
				...summary,
				streamingMessage: this.streamingMessage(session, target.remoteSessionId),
			},
			state: this.connectionState(session, target),
			messages: this.shadowContext(session, target.remoteSessionId).messages,
			sessionContext: this.shadowContext(session, target.remoteSessionId),
			children: target.descendant ? [] : this.childSnapshots(session),
			lastEventSequence: session.eventSequence,
		};
	}

	// ---------------------------------------------------------------------------
	// Recovery and disposal
	// ---------------------------------------------------------------------------

	/**
	 * Supervisor startup: rebuild in-memory state from the durable records,
	 * re-attach running sandboxes, and re-register roster rows. Stopped and
	 * lost records keep their shadows readable without a live row.
	 */
	async recover(): Promise<void> {
		for (const record of this.store.list()) {
			if (!isResidentCloudSessionRecord(record)) continue;
			try {
				await this.refreshResidentRecord(record);
			} catch (error) {
				this.callbacks.log(`cloud session refresh failed for ${record.sessionId}: ${String(error)}`);
			}
			const current = this.store.get(record.sessionId);
			if (current === undefined || !this.isResidentLive(current)) continue;
			const session = this.registerResidentSession(current);
			this.writeRootShadow(session, current);
			if (current.location === "spawned-child" && current.spawn !== undefined) {
				// The durable spawn record rebuilds the parent's task tracker
				// BEFORE descendant shadows project (their depth is relative to
				// the spawned child's own depth); a live sandbox re-attaches,
				// a lost one re-runs provisioning idempotently.
				session.spawnTask = {
					info: current.spawn,
					promptAdmitted: session.opened,
					sawWork: session.opened,
					terminal: false,
				};
				void this.provisionSpawnedChild(session, current.spawn, this.shadowCwd(current)).catch((error: unknown) =>
					this.callbacks.log(`cloud spawn reprovision failed for ${current.sessionId}: ${String(error)}`),
				);
			}
			for (const remoteSessionId of current.remoteSessionIds ?? []) {
				this.ensureDescendantShadow(session, remoteSessionId);
			}
			this.publishRosterRows(session);
		}
	}

	/** Stop every attachment and close shadows; used on supervisor shutdown. */
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			try {
				await session.attachment.stop();
			} catch (error) {
				this.callbacks.log(`cloud attachment stop failed: ${String(error)}`);
			}
			for (const shadow of session.shadows.values()) {
				await shadow.close().catch(() => undefined);
			}
		}
		this.sessions.clear();
		this.activeIndex.clear();
		this.shadowIndex.clear();
	}

	// ---------------------------------------------------------------------------
	// Internals: attachment and mirroring
	// ---------------------------------------------------------------------------

	private registerResidentSession(
		record: CloudSessionRecord,
		options?: { startAttachment?: boolean },
	): CloudResidentSession {
		const existing = this.sessions.get(record.sessionId);
		if (existing !== undefined) return existing;
		const activeSessionId = record.activeSessionId ?? `cloud-active-${randomUUID()}`;
		if (record.activeSessionId === undefined) {
			this.store.setActiveSessionId(record.sessionId, activeSessionId);
		}
		const session: CloudResidentSession = {
			sessionId: record.sessionId,
			record: this.store.get(record.sessionId) ?? record,
			activeSessionId,
			attachment: undefined as never,
			shadows: new Map(),
			receipts: new Map(),
			pendingAppends: new Set(),
			metaBySession: new Map(),
			children: new Map(),
			connectivity: record.observedLifecycle === "running" ? "reconnecting" : "provisioning",
			eventRing: [],
			eventSequence: 0,
			opened: false,
			usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
		};
		session.attachment = this.createAttachment(session);
		this.sessions.set(record.sessionId, session);
		this.activeIndex.set(activeSessionId, {
			sessionId: record.sessionId,
			remoteSessionId: record.sessionId,
		});
		if (record.shadowSessionFile !== undefined) {
			this.shadowIndex.set(record.shadowSessionFile, record.sessionId);
		}
		// A spawned child registers its row at admission, before its sandbox
		// (and tunnel) exists; the attachment starts once provisioning has
		// registered the tunnel (an earlier start would terminate against the
		// not-yet-registered target and never reconnect).
		if (options?.startAttachment !== false) session.attachment.start();
		return session;
	}

	private createAttachment(session: CloudResidentSession): CloudTunnelAttachment {
		const eventsDirectory = join(this.options.stateDirectory, "events", session.sessionId);
		return new CloudTunnelAttachment({
			sessionId: session.sessionId,
			generation: session.record.generation,
			transport: this.transport,
			...(this.options.reconnectDelayMs !== undefined ? { reconnectDelayMs: this.options.reconnectDelayMs } : {}),
			...(this.options.submitWaitMs !== undefined ? { submitWaitMs: this.options.submitWaitMs } : {}),
			callbacks: {
				resolveTarget: (): CloudTunnelAttachmentTarget | undefined => {
					const record = this.currentRecord(session);
					if (record.tunnel === undefined || record.tunnelState !== "registered" || !this.isResidentLive(record)) {
						return undefined;
					}
					const secrets = this.service.tunnelSecretStore.get(session.sessionId);
					if (secrets === undefined) return undefined;
					return {
						url: record.tunnel.url,
						httpUser: record.tunnel.httpUser,
						httpPassword: secrets.httpPassword,
						bridgeToken: secrets.bridgeToken,
					};
				},
				appendGuestEvent: (event) => this.appendGuestEvent(session, eventsDirectory, event),
				flushTrace: () => this.flushShadows(session),
				persistGuestCursor: (cursor: CloudGuestCursorRecord) => {
					// Ack follows local durability: the shadows are fsynced
					// before the cursor names the position as imported.
					this.syncShadows(session);
					try {
						this.service.store.advanceAckCursor(session.sessionId, {
							generation: this.currentRecord(session).generation,
							sequence: cursor.sequence,
						});
					} catch {
						// A retention epoch bump makes cross-generation
						// sequences incomparable; the guest-cursor file stays
						// the authoritative resume point.
					}
					saveTunnelGuestCursor(eventsDirectory, cursor);
				},
				loadGuestCursor: () => loadTunnelGuestCursor(eventsDirectory),
				recordAttachment: (attachmentUuid) => {
					if (this.store.get(session.sessionId))
						this.service.store.recordAttachment(session.sessionId, attachmentUuid);
				},
				isSessionLive: () => this.isResidentLive(this.currentRecord(session)),
				checkTunnelAlive: async () => {
					const record = this.currentRecord(session);
					if (record.tunnel === undefined) return false;
					return (await this.service.tunnelClient?.get(record.tunnel.tunnelId)) !== undefined;
				},
				onAttachmentError: (message) => {
					this.callbacks.log(`cloud attachment ${session.sessionId}: ${message}`);
					if (this.store.get(session.sessionId)) this.service.store.setLastError(session.sessionId, message);
					this.updateConnectivity(session, "reconnecting");
				},
				onTerminal: (reason) => {
					const record = this.currentRecord(session);
					this.service.store.setLastError(session.sessionId, `tunnel bridge stopped: ${reason}`);
					if (record.tunnelState === "registered" && record.tunnel !== undefined) {
						const tunnelId = record.tunnel.tunnelId;
						void this.service.tunnelClient?.delete(tunnelId).catch(() => undefined);
					}
					if (record.tunnelState !== "released") {
						this.service.store.setTunnelState(session.sessionId, "released");
					}
					this.service.tunnelSecretStore.delete(session.sessionId);
					this.updateConnectivity(session, "disconnected");
				},
			},
		});
	}

	private appendGuestEvent(session: CloudResidentSession, eventsDirectory: string, event: CloudEvent): void {
		// Durable local outbox first: the guest only trims through the ack.
		const outbox = new DurableCloudEventOutbox({ directory: eventsDirectory, sessionId: session.sessionId });
		outbox.append(event);
		try {
			this.service.store.advanceEventCursor(session.sessionId, {
				generation: this.currentRecord(session).generation,
				sequence: event.sequence,
			});
		} catch {
			// Record cursors are informational; a retention epoch change makes
			// cross-generation sequences incomparable. The guest-cursor file
			// stays the authoritative resume point.
		}
		try {
			this.applyGuestEvent(session, event);
		} catch (error) {
			this.callbacks.log(`cloud event mirror failed for ${session.sessionId}: ${String(error)}`);
		}
	}

	/**
	 * A spawned child's guest work observation. `session_meta` streaming frames
	 * mark the task running; the first quiescent meta after admitted work
	 * completes the parent's run (the guest's answer is already in the shadow).
	 */
	private observeSpawnedChildWork(session: CloudResidentSession, remoteSessionId: string, streaming: boolean): void {
		const task = session.spawnTask;
		if (task === undefined || task.terminal || !task.promptAdmitted) return;
		if (remoteSessionId !== session.sessionId) return;
		if (streaming) {
			task.sawWork = true;
			this.pushSpawnTaskUpdate(session, "running");
			return;
		}
		const meta = session.metaBySession.get(session.sessionId);
		if (task.sawWork && (meta?.queue ?? 0) === 0 && (meta?.runningTools ?? 0) === 0) {
			this.maybeCompleteSpawnedChild(session);
		}
	}

	/** A spawned child settles when the guest's aggregate status quiets after work. */
	private observeSpawnedChildSettle(session: CloudResidentSession, status: CloudSessionStatus): void {
		const task = session.spawnTask;
		if (task === undefined || task.terminal || !task.promptAdmitted) return;
		if (status === "busy") {
			task.sawWork = true;
			this.pushSpawnTaskUpdate(session, "running");
		} else if ((status === "idle" || status === "stopped") && task.sawWork) {
			this.maybeCompleteSpawnedChild(session);
		}
	}

	/**
	 * Quiescence alone is ambiguous (a needs-input pause looks idle too), so
	 * the task completes only once the durable shadow holds the child's own
	 * assistant answer.
	 */
	private maybeCompleteSpawnedChild(session: CloudResidentSession): void {
		const task = session.spawnTask;
		if (task === undefined || task.terminal) return;
		if (this.shadowAnswerPreview(session) === undefined) return;
		this.pushSpawnTaskUpdate(session, "completed");
	}

	private applyGuestEvent(session: CloudResidentSession, event: CloudEvent): void {
		switch (event.kind) {
			case "session_entry":
				this.mirrorSessionEntry(session, event);
				return;
			case "session_event":
				this.pushRing(session, event.sessionId, event.event as AgentConnectionSessionEvent);
				this.relaySessionEvent(session, event.sessionId, event.event as AgentConnectionSessionEvent);
				return;
			case "session_meta": {
				session.metaBySession.set(event.sessionId, {
					sessionId: event.sessionId,
					streaming: event.streaming,
					runningTools: event.runningTools,
					queue: event.queue,
					...(event.recap ? { recap: event.recap } : {}),
					...(event.taskState ? { taskState: event.taskState } : {}),
					...(event.model ? { model: event.model } : {}),
					updatedAt: new Date().toISOString(),
				});
				this.updateConnectivity(session, "connected");
				this.observeSpawnedChildWork(session, event.sessionId, event.streaming);
				this.publishRosterRows(session);
				this.callbacks.writeSessionStatus(session.activeSessionId, event.recap);
				return;
			}
			case "roster_delta":
				this.applyRosterDelta(session, event.rows);
				return;
			case "child_update":
				this.applyChildUpdate(session, event);
				return;
			case "usage":
				session.usage = {
					inputTokens: event.totals.inputTokens,
					outputTokens: event.totals.outputTokens,
					requests: event.totals.requests,
				};
				return;
			case "session_status":
				this.observeSpawnedChildSettle(session, event.status);
				this.publishRosterRows(session);
				return;
			case "command_accepted":
			case "command_state":
				session.receipts.set(event.receipt.commandId, event.receipt);
				if (session.receipts.size > 512) {
					const oldest = session.receipts.keys().next().value;
					if (oldest !== undefined) session.receipts.delete(oldest);
				}
				return;
			default:
				return;
		}
	}

	private mirrorSessionEntry(
		session: CloudResidentSession,
		event: Extract<CloudEvent, { kind: "session_entry" }>,
	): void {
		const shadow = this.ensureShadow(session, event.sessionId);
		if (shadow === undefined) return;
		// A naming entry (session_info) lets an unclaimed descendant shadow
		// match its roster row (the guest's rows carry names, not ids).
		if ((event.entry as { type?: string }).type === "session_info") {
			for (const child of session.children.values()) {
				this.tryClaimDescendantShadow(session, child);
			}
		}
		const append = shadow.appendEntry(event.entry, event.artifacts).then(
			(appended) => {
				if (appended) this.publishRosterRows(session);
			},
			(error: unknown) => {
				// An artifact transfer failure surfaces honestly: the next
				// flush rethrows so the attachment closes instead of acking an
				// incomplete batch.
				this.callbacks.log(`cloud shadow append failed for ${session.sessionId}: ${String(error)}`);
				throw error;
			},
		);
		session.pendingAppends.add(append);
		void append.finally(() => {
			session.pendingAppends.delete(append);
		});
	}

	private async flushShadows(session: CloudResidentSession): Promise<void> {
		// Artifact transfers resolve before anything is acknowledged; the
		// attachment acks only after this fsync completes.
		const pending = [...session.pendingAppends];
		await Promise.all(pending);
		this.syncShadows(session);
	}

	private syncShadows(session: CloudResidentSession): void {
		for (const shadow of session.shadows.values()) shadow.sync();
	}

	/**
	 * Guest-reported depths are relative to the guest's root session; a
	 * spawned child's root sits at its own depth under the LOCAL parent, so
	 * every remote descendant shifts by the spawn depth.
	 */
	private remoteDepth(session: CloudResidentSession, depth: number): number {
		return depth + (session.spawnTask?.info.depth ?? 0);
	}

	private applyRosterDelta(session: CloudResidentSession, rows: readonly CloudRosterRow[]): void {
		const seen = new Set<string>();
		for (const row of rows) {
			seen.add(row.childId);
			const existing = session.children.get(row.childId);
			if (session.children.size >= CLOUD_MAX_MIRRORED_CHILDREN && existing === undefined) {
				this.callbacks.log(`cloud roster delta exceeded the child bound for ${session.sessionId}`);
				continue;
			}
			if (existing === undefined) {
				const child: CloudChildRow = {
					childId: row.childId,
					...(row.parentRemoteId ? { parentRemoteId: row.parentRemoteId } : {}),
					...(row.name ? { name: row.name } : {}),
					status: row.status,
					depth: this.remoteDepth(session, row.depth),
					...(row.preview ? { preview: row.preview } : {}),
					activeSessionId: `cloud-child-${randomUUID()}`,
				};
				session.children.set(row.childId, child);
			} else {
				existing.status = row.status;
				existing.depth = this.remoteDepth(session, row.depth);
				if (row.name !== undefined) existing.name = row.name;
				if (row.preview !== undefined) existing.preview = row.preview;
				if (row.parentRemoteId !== undefined) existing.parentRemoteId = row.parentRemoteId;
			}
			// A row address becomes routable once its shadow is claimed;
			// before that the child id is display-only.
			const current = session.children.get(row.childId)!;
			this.tryClaimDescendantShadow(session, current);
			if (current.sessionId !== undefined) {
				this.activeIndex.set(current.activeSessionId, {
					sessionId: session.sessionId,
					remoteSessionId: current.sessionId,
				});
			}
		}
		for (const [childId, child] of session.children) {
			if (seen.has(childId)) continue;
			// The guest dropped the row (deleted child): mirror locally.
			const summary = this.childSummary(session, child) ?? this.childFallbackSummary(session, child);
			this.callbacks.deleteRosterEntry(rosterAgentIdForSummary(summary));
			if (child.sessionId !== undefined) {
				const childFile = ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, child.sessionId);
				this.callbacks
					.deleteLedgerChild({ childId, child: childFile })
					.catch((error: unknown) => this.callbacks.log(`cloud ledger delete failed: ${String(error)}`));
				if (this.store.get(session.sessionId)) {
					this.store.removeRemoteSessionId(session.sessionId, child.sessionId);
				}
			}
			this.activeIndex.delete(child.activeSessionId);
			session.children.delete(childId);
		}
		this.publishRosterRows(session);
	}

	private applyChildUpdate(session: CloudResidentSession, event: Extract<CloudEvent, { kind: "child_update" }>): void {
		const child = session.children.get(event.childId);
		if (child !== undefined) {
			child.status = event.status;
			if (event.answerPreview !== undefined) child.preview = event.answerPreview;
			// A run's session file name carries its remote session id.
			const remoteSessionId = event.sessionFile !== undefined ? basenameSessionId(event.sessionFile) : undefined;
			if (remoteSessionId !== undefined) {
				this.attachChildSessionId(session, child, remoteSessionId);
			} else {
				this.tryClaimDescendantShadow(session, child);
			}
		}
		this.publishRosterRows(session);
	}

	private attachChildSessionId(session: CloudResidentSession, child: CloudChildRow, remoteSessionId: string): void {
		if (child.sessionId === remoteSessionId) return;
		child.sessionId = remoteSessionId;
		this.activeIndex.set(child.activeSessionId, { sessionId: session.sessionId, remoteSessionId });
		const shadow = this.ensureDescendantShadow(session, remoteSessionId);
		const parentRemoteId = child.parentRemoteId ?? session.record.sessionId;
		const parentShadowFile = ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, parentRemoteId);
		if (shadow !== undefined) {
			this.callbacks
				.appendLedgerEdge({
					childId: child.childId,
					parent: parentShadowFile,
					child: shadow.sessionFile,
					depth: child.depth,
					name: child.name ?? child.childId,
				})
				.catch((error: unknown) => this.callbacks.log(`cloud ledger edge failed: ${String(error)}`));
		}
		if (this.store.get(session.sessionId)) {
			try {
				this.store.addRemoteSessionId(session.sessionId, remoteSessionId);
			} catch (error) {
				this.callbacks.log(`cloud remote session registration failed: ${String(error)}`);
			}
		}
	}

	private ensureShadow(session: CloudResidentSession, remoteSessionId: string): ShadowSessionWriter | undefined {
		const existing = session.shadows.get(remoteSessionId);
		if (existing !== undefined) return existing;
		if (remoteSessionId === session.record.sessionId) {
			return this.writeRootShadow(session, this.currentRecord(session));
		}
		return this.ensureDescendantShadow(session, remoteSessionId);
	}

	/** Unclaimed descendant shadows: mirrored but not yet linked to a roster row. */
	private unclaimedShadowIds(session: CloudResidentSession): string[] {
		const claimed = new Set([...session.children.values()].map((child) => child.sessionId));
		return [...session.shadows.keys()].filter((id) => id !== session.record.sessionId && !claimed.has(id));
	}

	/**
	 * Claim one unclaimed descendant shadow for a roster row. The guest's
	 * roster rows carry the child id but not the remote session id, so the
	 * link is made by the shadow's session name (matches the roster name)
	 * or, when unambiguous, by being the single unclaimed shadow of the
	 * single awaiting row. Until a claim lands, the shadow still mirrors.
	 */
	private tryClaimDescendantShadow(session: CloudResidentSession, child: CloudChildRow): void {
		if (child.sessionId !== undefined) return;
		const unclaimed = this.unclaimedShadowIds(session);
		if (unclaimed.length === 0) return;
		const byName =
			child.name !== undefined ? unclaimed.filter((id) => this.shadowSessionName(session, id) === child.name) : [];
		if (byName.length === 1) {
			this.attachChildSessionId(session, child, byName[0]!);
			return;
		}
		if (byName.length > 1) return;
		const awaitingRows = [...session.children.values()].filter((row) => row.sessionId === undefined);
		if (unclaimed.length === 1 && awaitingRows.length === 1 && awaitingRows[0] === child) {
			this.attachChildSessionId(session, child, unclaimed[0]!);
		}
	}

	private writeRootShadow(session: CloudResidentSession, record: CloudSessionRecord): ShadowSessionWriter {
		const existing = session.shadows.get(record.sessionId);
		if (existing !== undefined) return existing;
		const shadowFile =
			record.shadowSessionFile ?? ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, record.sessionId);
		if (record.shadowSessionFile === undefined) this.store.setShadowSession(record.sessionId, shadowFile);
		const shadow = ShadowSessionWriter.openOrCreate({
			sessionFile: shadowFile,
			sessionId: record.sessionId,
			cwd: this.shadowCwd(record),
			cloudSessionId: record.sessionId,
			generation: record.generation,
			...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
			artifactResolver: this.artifactResolver(record),
		});
		session.shadows.set(record.sessionId, shadow);
		this.shadowIndex.set(shadowFile, record.sessionId);
		return shadow;
	}

	/**
	 * Open (never invent) a descendant shadow. The roster row that names the
	 * child arrives through roster_delta; the session id arrives through the
	 * child's own session_entry stream; `tryClaimDescendantShadow` links them.
	 */
	private ensureDescendantShadow(
		session: CloudResidentSession,
		remoteSessionId: string,
	): ShadowSessionWriter | undefined {
		const existing = session.shadows.get(remoteSessionId);
		if (existing !== undefined) return existing;
		const child = this.childForRemote(session, remoteSessionId);
		const depth = child?.depth ?? this.remoteDepth(session, 1);
		const parentRemoteId = child?.parentRemoteId ?? session.record.sessionId;
		const shadowFile = ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, remoteSessionId);
		const shadow = ShadowSessionWriter.openOrCreate({
			sessionFile: shadowFile,
			sessionId: remoteSessionId,
			cwd: this.shadowCwd(session.record),
			cloudSessionId: session.record.sessionId,
			generation: session.record.generation,
			...(session.record.sandboxId ? { sandboxId: session.record.sandboxId } : {}),
			parentSessionPath: ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, parentRemoteId),
			rlmDepth: depth,
			artifactResolver: this.artifactResolver(session.record),
		});
		session.shadows.set(remoteSessionId, shadow);
		this.shadowIndex.set(shadowFile, session.record.sessionId);
		if (this.store.get(session.record.sessionId)) {
			try {
				this.store.addRemoteSessionId(session.record.sessionId, remoteSessionId);
			} catch (error) {
				this.callbacks.log(`cloud remote session registration failed: ${String(error)}`);
			}
		}
		return shadow;
	}

	private artifactResolver(record: CloudSessionRecord): ShadowArtifactResolver | undefined {
		if (this.options.artifactResolver !== undefined) return this.options.artifactResolver;
		return {
			fetch: async (ref: CloudArtifactRef) => {
				if (record.sandboxId === undefined) {
					throw new Error("cloud session has no sandbox for artifact transfer");
				}
				const auth = await this.service.platform.getSandboxAuth(record.sandboxId);
				return this.service.platform.downloadFile(record.sandboxId, ref.path, { auth });
			},
		};
	}

	private pushRing(session: CloudResidentSession, remoteSessionId: string, event: AgentConnectionSessionEvent): void {
		session.eventRing.push({ sessionId: remoteSessionId, event });
		let bytes = 0;
		for (const entry of session.eventRing) bytes += Buffer.byteLength(JSON.stringify(entry.event), "utf8");
		while (session.eventRing.length > RING_MAX_EVENTS || (bytes > RING_MAX_BYTES && session.eventRing.length > 1)) {
			const removed = session.eventRing.shift();
			if (removed === undefined) break;
			bytes -= Buffer.byteLength(JSON.stringify(removed.event), "utf8");
		}
	}

	private relaySessionEvent(
		session: CloudResidentSession,
		remoteSessionId: string,
		event: AgentConnectionSessionEvent,
	): void {
		const activeSessionId = this.activeIdForRemote(session, remoteSessionId);
		if (activeSessionId === undefined) return;
		session.eventSequence += 1;
		const meta: DaemonEventMeta = {
			id: `cloud_evt_${randomUUID()}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence: session.eventSequence,
			emittedAt: new Date().toISOString(),
		};
		this.callbacks.writeSessionEvent(activeSessionId, event, meta);
	}

	// ---------------------------------------------------------------------------
	// Internals: command submission
	// ---------------------------------------------------------------------------

	private async submitPrompt(
		session: CloudResidentSession,
		command: Extract<DaemonCommand, { type: "prompt" | "prompt_and_wait" }>,
		admission: CloudPromptAdmissionHooks | undefined,
	): Promise<DaemonResponse | undefined> {
		try {
			if (admission?.isCancelled()) {
				return failure(command.id, command.type, "Prompt admission was cancelled");
			}
			await this.requireConnected(session, "prompt");
			const outcome = await this.submitResident(session, `prompt_${command.id ?? randomUUID()}`, {
				kind: "prompt",
				text: command.message,
				queueIfBusy: true,
			});
			if (admission?.isCancelled()) {
				return failure(command.id, command.type, "Prompt admission was cancelled");
			}
			if (outcome === "acknowledged") {
				admission?.markOwned();
			}
			return undefined;
		} catch (error) {
			if (admission?.isCancelled()) {
				return failure(command.id, command.type, "Prompt admission was cancelled");
			}
			throw error;
		}
	}

	/**
	 * Submit one cloud command. For short-lived commands (`waitForTerminal`)
	 * the response waits for the receipt's terminal state, so an unknown
	 * model or child fails honestly; long-running commands (prompts, abort)
	 * report admission, exactly like the local daemon's contract.
	 */
	private async submitResident(
		session: CloudResidentSession,
		commandId: string,
		request: CloudCommandRequest,
		waitForTerminal = false,
	): Promise<"acknowledged" | "queued"> {
		const outcome = await session.attachment.submit(commandId, request);
		if (outcome.state === "queued") {
			return "queued";
		}
		let receipt = outcome.receipt;
		if (receipt.state === "failed") {
			throw new Error(receipt.error ?? `cloud command ${request.kind} failed`);
		}
		if (waitForTerminal && !isTerminalCloudCommandState(receipt.state)) {
			const deadline = Date.now() + RECEIPT_WAIT_TIMEOUT_MS;
			while (Date.now() < deadline && !this.disposed) {
				const current = session.receipts.get(commandId);
				if (current !== undefined) {
					receipt = current;
					if (isTerminalCloudCommandState(current.state)) break;
				}
				await new Promise((resolve) => setTimeout(resolve, RECEIPT_WAIT_POLL_MS));
			}
			if (receipt.state === "failed") {
				throw new Error(receipt.error ?? `cloud command ${request.kind} failed`);
			}
		}
		return "acknowledged";
	}

	private async requireConnected(session: CloudResidentSession, action: string): Promise<void> {
		if (!session.attachment.attached) {
			throw new Error(`Cloud session is not connected; cannot ${action} until the tunnel reconnects`);
		}
	}

	private async waitForIdle(session: CloudResidentSession, waitForChildren: boolean): Promise<void> {
		const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
		while (Date.now() < deadline && !this.disposed) {
			const meta = session.metaBySession.get(session.record.sessionId);
			const streaming = meta?.streaming ?? false;
			const runningTools = meta?.runningTools ?? 0;
			const queue = meta?.queue ?? 0;
			const childrenBusy = waitForChildren
				? [...session.children.values()].some((child) => child.status === "running" || child.status === "queued")
				: false;
			if (!streaming && runningTools === 0 && queue === 0 && !childrenBusy) return;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, IDLE_WAIT_POLL_MS));
		}
		throw new Error("Cloud session did not settle before the wait timeout");
	}

	// ---------------------------------------------------------------------------
	// Internals: summaries and info shapes
	// ---------------------------------------------------------------------------

	private updateConnectivity(session: CloudResidentSession, connectivity: CloudSessionConnectivity): void {
		if (session.connectivity === connectivity) return;
		session.connectivity = connectivity;
		this.publishRosterRows(session);
		this.callbacks.broadcastCloudSessionUpdate(this.sessionInfo(session));
	}

	private publishRosterRows(session: CloudResidentSession): void {
		if (!this.isRowLive(session)) return;
		const rootSummary = this.rootSummary(session);
		this.callbacks.writeRosterEntry({
			agentId: rosterAgentIdForSummary(rootSummary),
			summary: this.rosterSummary(rootSummary),
		});
		for (const child of session.children.values()) {
			const summary = this.childSummary(session, child);
			if (summary === undefined) continue;
			this.callbacks.writeRosterEntry({
				agentId: rosterAgentIdForSummary(summary),
				summary: this.rosterSummary(summary),
			});
		}
	}

	/** Roster rows carry the slim summary shape (no streaming/actions/diagnostics). */
	private rosterSummary(summary: SessionSummary): SessionSummary {
		const { streamingMessage: _s, sessionActions: _a, diagnostics: _d, ...slim } = summary;
		return slim as SessionSummary;
	}

	private isRowLive(session: CloudResidentSession): boolean {
		return this.isResidentLive(this.currentRecord(session));
	}

	private isResidentLive(record: CloudSessionRecord): boolean {
		return (
			isResidentCloudSessionRecord(record) &&
			(record.observedLifecycle === "running" || record.observedLifecycle === "provisioning") &&
			(record.desiredLifecycle === "running" || record.desiredLifecycle === "provisioning")
		);
	}

	private rootSummary(session: CloudResidentSession): SessionSummary {
		const record = this.currentRecord(session);
		const shadow = session.shadows.get(record.sessionId);
		const meta = session.metaBySession.get(record.sessionId);
		const context = shadow !== undefined ? this.entriesContext(shadow) : undefined;
		const messages = context?.messages ?? [];
		const info = shadow !== undefined ? statSummary(shadow.sessionFile) : undefined;
		const connected = session.connectivity === "connected";
		const busy = connected && ((meta?.streaming ?? false) || (meta?.runningTools ?? 0) > 0);
		const usage: SessionUsageSummary | undefined =
			session.usage.inputTokens > 0 || session.usage.outputTokens > 0
				? { inputTokens: session.usage.inputTokens, outputTokens: session.usage.outputTokens, cost: 0 }
				: undefined;
		// A spawned child projects as a subagent row under its LOCAL parent:
		// real parent edges (ledger + family reach) with the cloud execution marker.
		const spawn = record.location === "spawned-child" ? record.spawn : undefined;
		const taskStatus = session.spawnTask;
		const spawnRunning = taskStatus !== undefined && !taskStatus.terminal;
		return {
			id: session.activeSessionId,
			lifecycle: messages.length > 0 || session.opened ? "live" : "draft",
			activity: busy ? "working" : "idle",
			isSessionActive: busy,
			activeSessionId: session.activeSessionId,
			sessionId: record.sessionId,
			...(record.shadowSessionFile ? { sessionFile: record.shadowSessionFile } : {}),
			sessionName: spawn?.name ?? this.shadowSessionName(session, record.sessionId),
			cwd: shadow?.header.cwd ?? this.shadowCwd(record),
			isStreaming: meta?.streaming ?? false,
			isCompacting: false,
			isRunningTools: (meta?.runningTools ?? 0) > 0,
			...([...session.children.values()].some((child) => child.status === "running" || child.status === "queued")
				? { hasRunningRlmChildren: true }
				: {}),
			attachedClients: this.callbacks.attachedClientCount(session.activeSessionId),
			messageCount: messages.length,
			sessionActions: { queuedCount: meta?.queue ?? 0, steering: [], followUps: [] },
			thinkingLevel: (context?.thinkingLevel ?? "off") as ThinkingLevel,
			...(spawn
				? {
						rlmDepth: spawn.depth,
						runtimeKind: "subagent" as const,
						rlmChildId: record.sessionId,
						parentActiveSessionId: spawn.parentActiveSessionId,
						parentSessionId: spawn.parentSessionId,
						parentSessionPath: spawn.parentSessionFile,
					}
				: { rlmDepth: 0 }),
			...(spawnRunning ? { statusLabel: "queued" as const } : {}),
			...(info ? { created: info.created, modified: info.modified, lastActivityAt: info.modified } : {}),
			firstMessage: firstUserMessage(messages),
			usage,
			...(meta?.recap ? { summary: meta.recap } : {}),
			...(meta?.taskState ? { taskState: meta.taskState } : {}),
			execution: this.executionInfo(record, session.connectivity),
		};
	}

	private childSummary(session: CloudResidentSession, child: CloudChildRow | undefined): SessionSummary | undefined {
		if (child === undefined) return undefined;
		const shadow = child.sessionId !== undefined ? session.shadows.get(child.sessionId) : undefined;
		const messages = shadow !== undefined ? (this.entriesContext(shadow)?.messages ?? []) : [];
		const record = this.currentRecord(session);
		return {
			id: child.activeSessionId,
			lifecycle: "live",
			activity: child.status === "running" ? "working" : "idle",
			isSessionActive: child.status === "running",
			activeSessionId: child.activeSessionId,
			runtimeKind: "subagent",
			rlmDepth: child.depth,
			rlmChildId: child.childId,
			sessionId: child.sessionId ?? child.childId,
			...(child.sessionId !== undefined
				? { sessionFile: ShadowSessionWriter.shadowSessionFile(this.options.sessionDir, child.sessionId) }
				: {}),
			sessionName: child.name,
			cwd: shadow?.header.cwd ?? this.shadowCwd(record),
			parentSessionPath: ShadowSessionWriter.shadowSessionFile(
				this.options.sessionDir,
				child.parentRemoteId ?? record.sessionId,
			),
			isStreaming: child.status === "running",
			isCompacting: false,
			attachedClients: this.callbacks.attachedClientCount(child.activeSessionId),
			messageCount: messages.length,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			firstMessage: child.preview,
			execution: this.executionInfo(record, session.connectivity),
		};
	}

	private childFallbackSummary(session: CloudResidentSession, child: CloudChildRow): SessionSummary {
		const record = this.currentRecord(session);
		return {
			id: child.activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			activeSessionId: child.activeSessionId,
			runtimeKind: "subagent",
			rlmDepth: child.depth,
			rlmChildId: child.childId,
			sessionId: child.sessionId ?? child.childId,
			cwd: this.shadowCwd(record),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			execution: this.executionInfo(record, session.connectivity),
		};
	}

	private childSnapshots(session: CloudResidentSession): AgentConnectionRlmChildAgentSnapshot[] {
		const snapshots: AgentConnectionRlmChildAgentSnapshot[] = [];
		for (const child of session.children.values()) {
			snapshots.push({
				id: child.childId,
				...(child.name ? { sessionName: child.name } : {}),
				...(child.sessionId !== undefined ? { activeSessionId: child.activeSessionId } : {}),
				label: child.name ?? child.childId,
				status: child.status === "queued" || child.status === "running" ? "running" : "completed",
				...(child.preview ? { answerPreview: child.preview } : {}),
			} as AgentConnectionRlmChildAgentSnapshot);
		}
		return snapshots;
	}

	private connectionState(session: CloudResidentSession, target: CloudSessionTarget): AgentConnectionState {
		const shadow = session.shadows.get(target.remoteSessionId);
		const context = shadow !== undefined ? this.entriesContext(shadow) : undefined;
		const meta = session.metaBySession.get(target.remoteSessionId);
		const record = this.currentRecord(session);
		return {
			activeSessionId: target.activeSessionId,
			cwd: shadow?.header.cwd ?? this.shadowCwd(record),
			thinkingLevel: (context?.thinkingLevel ?? "off") as ThinkingLevel,
			availableThinkingLevels: [],
			isStreaming: meta?.streaming ?? false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: "all",
			followUpMode: "all",
			serviceTier: (context?.serviceTier ?? "default") as AgentConnectionState["serviceTier"],
			...(shadow ? { sessionFile: shadow.sessionFile } : {}),
			sessionId: target.remoteSessionId,
			sessionName: this.shadowSessionName(session, target.remoteSessionId),
			leafId: shadow?.getEntries().at(-1)?.type === "session" ? null : (shadow?.getEntries().at(-1)?.id ?? null),
			autoCompactionEnabled: true,
			messageCount: context?.messages.length ?? 0,
			sessionActions: { queuedCount: meta?.queue ?? 0, steering: [], followUps: [] },
			compactionCount: shadow?.getEntries().filter((entry) => entry.type === "compaction").length ?? 0,
			goal: emptyGoalState(),
			scopedModels: [],
			activeToolNames: [],
			contextUsage: {
				tokens: null,
				contextWindow: 0,
				percent: null,
			} as AgentConnectionState["contextUsage"],
		};
	}

	private sessionHeader(session: CloudResidentSession, target: CloudSessionTarget): AgentConnectionSessionHeader {
		const shadow = session.shadows.get(target.remoteSessionId);
		const header: SessionHeader | undefined = shadow?.header;
		return {
			type: "session",
			version: header?.version,
			id: target.remoteSessionId,
			timestamp: header?.timestamp ?? target.record.createdAt,
			cwd: header?.cwd ?? this.shadowCwd(target.record),
			...(header?.parentSession ? { parentSession: header.parentSession } : {}),
			rlmDepth: header?.rlmDepth ?? 0,
		} as AgentConnectionSessionHeader;
	}

	private sessionTree(
		session: CloudResidentSession,
		target: CloudSessionTarget,
	): { tree: AgentConnectionSessionTreeNode[]; leafId: string | null } {
		const shadow = session.shadows.get(target.remoteSessionId);
		const entries = shadow !== undefined ? this.sessionEntries(shadow) : [];
		const nodes = new Map<string, AgentConnectionSessionTreeNode>();
		const roots: AgentConnectionSessionTreeNode[] = [];
		for (const entry of entries) {
			const node: AgentConnectionSessionTreeNode = { entry: entry as never, children: [] };
			nodes.set(entry.id, node);
			const parent = entry.parentId !== null ? nodes.get(entry.parentId) : undefined;
			if (parent !== undefined) parent.children.push(node);
			else roots.push(node);
		}
		const lastEntry = entries.at(-1);
		return { tree: roots, leafId: lastEntry?.id ?? null } as never;
	}

	private shadowContext(session: CloudResidentSession, remoteSessionId: string): AgentConnectionSessionContext {
		const shadow = session.shadows.get(remoteSessionId);
		const context = shadow !== undefined ? this.entriesContext(shadow) : undefined;
		const meta = session.metaBySession.get(remoteSessionId);
		return {
			messages: context?.messages ?? [],
			thinkingLevel: (context?.thinkingLevel ?? "off") as string,
			serviceTier: (context?.serviceTier ?? "default") as AgentConnectionSessionContext["serviceTier"],
			model: context?.model ?? (meta?.model !== undefined ? { provider: "cloud", modelId: meta.model } : null),
		};
	}

	private entriesContext(shadow: ShadowSessionWriter): ReturnType<typeof buildSessionContext> | undefined {
		const entries = this.sessionEntries(shadow);
		if (entries.length === 0) return undefined;
		return buildSessionContext(entries);
	}

	private sessionEntries(shadow: ShadowSessionWriter): SessionEntry[] {
		return shadow.getEntries().filter((entry): entry is SessionEntry => entry.type !== "session");
	}

	private streamingMessage(session: CloudResidentSession, remoteSessionId: string): AgentMessage | undefined {
		let streaming: AgentMessage | undefined;
		for (const entry of session.eventRing) {
			if (entry.sessionId !== remoteSessionId) continue;
			const event = entry.event as { type: string; partial?: AgentMessage; message?: AgentMessage };
			if (event.type === "message_start" && event.partial !== undefined) {
				streaming = event.partial;
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				streaming = undefined;
			}
		}
		return streaming;
	}

	private shadowSessionName(session: CloudResidentSession, remoteSessionId: string): string | undefined {
		const shadow = session.shadows.get(remoteSessionId);
		if (shadow === undefined) return undefined;
		for (const entry of [...shadow.getEntries()].reverse()) {
			if (entry.type === "session_info" && entry.name !== undefined) return entry.name;
		}
		return undefined;
	}

	private sessionInfo(session: CloudResidentSession): DaemonCloudSessionInfo {
		const record = this.currentRecord(session);
		return {
			sessionId: record.sessionId,
			activeSessionId: session.activeSessionId,
			...(record.shadowSessionFile ? { sessionFile: record.shadowSessionFile } : {}),
			...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
			generation: record.generation,
			connectivity: session.connectivity,
			status: this.statusForRecord(record),
			location: record.location,
			remoteSessionCount: record.remoteSessionIds?.length ?? 0,
			sessionName: this.shadowSessionName(session, record.sessionId),
			...(record.lastError ? { lastError: record.lastError } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	private recordInfo(record: CloudSessionRecord): DaemonCloudSessionInfo {
		const session = this.sessions.get(record.sessionId);
		if (session !== undefined) return this.sessionInfo(session);
		return {
			sessionId: record.sessionId,
			activeSessionId: record.activeSessionId,
			...(record.shadowSessionFile ? { sessionFile: record.shadowSessionFile } : {}),
			...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
			generation: record.generation,
			connectivity: this.connectivityForRecord(record),
			status: this.statusForRecord(record),
			...(record.location ? { location: record.location } : { legacyDelegation: true }),
			remoteSessionCount: record.remoteSessionIds?.length ?? 0,
			...(record.lastError ? { lastError: record.lastError } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	private statusForRecord(record: CloudSessionRecord): DaemonCloudSessionInfo["status"] {
		if (record.observedLifecycle === "lost") return "lost";
		if (record.observedLifecycle === "deleted" || record.observedLifecycle === "stopped") return "stopped";
		if (record.desiredLifecycle === "stopping") return "stopping";
		if (record.observedLifecycle === "running") return "running";
		if (record.sandboxId === undefined) return "provisioning";
		return record.resultImportState !== "pending" ? "stopped" : "running";
	}

	private executionInfo(record: CloudSessionRecord, connectivity: CloudSessionConnectivity): SessionExecutionInfo {
		return {
			location: "cloud",
			...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
			connectivity,
		};
	}

	// ---------------------------------------------------------------------------
	// Internals: lookups and record helpers
	// ---------------------------------------------------------------------------

	private currentRecord(session: CloudResidentSession): CloudSessionRecord {
		const record = this.store.get(session.sessionId);
		if (record !== undefined) {
			session.record = record;
			return record;
		}
		return session.record;
	}

	private childForRemote(session: CloudResidentSession, remoteSessionId: string): CloudChildRow | undefined {
		return [...session.children.values()].find((child) => child.sessionId === remoteSessionId);
	}

	private activeIdForRemote(session: CloudResidentSession, remoteSessionId: string): string | undefined {
		if (remoteSessionId === session.record.sessionId) return session.activeSessionId;
		return this.childForRemote(session, remoteSessionId)?.activeSessionId;
	}

	private remoteSessionIdForSelector(selector: string): string | undefined {
		const target = this.resolveActive(selector);
		if (target !== undefined) return target.remoteSessionId;
		if (this.store.get(selector) !== undefined) return selector;
		return undefined;
	}

	private shadowCwd(record: CloudSessionRecord): string {
		return record.baseline?.repoRoot ?? this.options.cwd;
	}

	private requireRecordForSelector(selector: string): CloudSessionRecord {
		const record = this.recordForSelector(selector);
		if (record === undefined) throw new Error(`Unknown cloud session: ${selector}`);
		return record;
	}

	private requireSession(sessionId: string): CloudResidentSession {
		const session = this.sessions.get(sessionId);
		if (session === undefined) throw new Error(`Cloud session is not registered: ${sessionId}`);
		return session;
	}

	private async refreshResidentRecord(record: CloudSessionRecord): Promise<void> {
		if (
			record.observedLifecycle === "deleted" ||
			record.observedLifecycle === "stopped" ||
			record.observedLifecycle === "lost"
		) {
			return;
		}
		await this.service.refreshResident(record);
	}

	private async disposeSession(
		session: CloudResidentSession,
		options: { closeShadows: boolean; broadcast: boolean },
	): Promise<void> {
		if (options.closeShadows) {
			for (const shadow of session.shadows.values()) {
				await shadow.close().catch(() => undefined);
			}
		}
		this.sessions.delete(session.sessionId);
		this.activeIndex.delete(session.activeSessionId);
		for (const child of session.children.values()) {
			const summary = this.childSummary(session, child) ?? this.childFallbackSummary(session, child);
			this.callbacks.deleteRosterEntry(rosterAgentIdForSummary(summary));
			this.activeIndex.delete(child.activeSessionId);
		}
		this.callbacks.deleteRosterEntry(rosterAgentIdForSummary(this.rootSummary(session)));
		if (options.broadcast) {
			const record = this.store.get(session.sessionId) ?? session.record;
			this.callbacks.broadcastCloudSessionUpdate(this.recordInfo(record));
		}
	}
}

function statSummary(sessionFile: string): { created: string; modified: string } | undefined {
	try {
		const stats = statSync(sessionFile);
		return {
			created: stats.birthtime.toISOString(),
			modified: stats.mtime.toISOString(),
		};
	} catch {
		return undefined;
	}
}

function firstUserMessage(messages: readonly AgentMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = readMessageText(message.content).trim();
		if (text) return text.slice(0, 120);
	}
	return undefined;
}

function readMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

function basenameSessionId(sessionFile: string): string | undefined {
	const base = sessionFile.split("/").pop() ?? "";
	if (!base.endsWith(".jsonl")) return undefined;
	const sessionId = base.slice(0, -6);
	return sessionId.length > 0 ? sessionId : undefined;
}
