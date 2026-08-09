import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, ServiceTier, TextContent, Transport } from "@earendil-works/pi-ai";
import type {
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageReceipt,
	AgentSessionMessageSafetyStatus,
} from "../../core/agent-messages.js";
import type { SessionActionRecoverySnapshot } from "../../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentSessionRuntimeMetadata } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import type { BashResult } from "../../core/bash-executor.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { InputSource } from "../../core/extensions/types.js";
import type { CustomMessage } from "../../core/messages.js";
import type { SessionCwdIssue } from "../../core/session-cwd.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionAgentStatus,
	AgentConnectionHeartbeat,
	AgentConnectionQueueMode,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSavedSessionScope,
	AgentConnectionSavedSessionState,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionHeader,
	AgentConnectionSessionTreeNode,
	AgentConnectionSideQuestionEvent,
	AgentConnectionSideQuestionTurn,
	AgentConnectionState,
} from "../agent-connection/types.js";
import type { SessionSummary } from "./daemon-session-list.js";

/**
 * Local daemon JSONL protocol.
 *
 * This is the transport used by DaemonAgentConnection today, not the final
 * remote gateway protocol. The protocol primitives below are intentionally
 * JSON-serializable so a future gateway can wrap or proxy this local transport
 * without leaking transport details back into InteractiveMode.
 */

export const DAEMON_PROTOCOL_NAME = "prime-agent.daemon";
export const DAEMON_PROTOCOL_VERSION = 7;
export const DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION = 7;
// Revision 9 publishes persisted RLM spawn depth on passive session rows.
// Revision 10 publishes persisted RLM spawn depth on all session catalog rows.
// Revision 11 adds immediate get/set commands for active-session RLM max depth.
// Revision 12 publishes idle-residency metadata on session summary rows.
// Revision 13 narrows agent-origin reach and roster wire shapes to the nuclear family.
// Revision 14 carries the client's monotonic telemetry opt-out on attach and reattach.
// Revision 15 reports attach ownership (wasAttached) on attach results so shared-client
// cleanup can tell its own attachment from a sibling connection's.
export const DAEMON_SCHEMA_REVISION = 15;
export const DAEMON_SCHEMA_ID = "protocol-7-schema-15-816309b1cd50";

export type DaemonProtocolName = typeof DAEMON_PROTOCOL_NAME;
export type DaemonProtocolVersion = number;
export type DaemonCommandId = string;
export type DaemonEventId = string;
export type DaemonEventSequence = number;
export interface DaemonEventCursor {
	generation: string;
	sequence: DaemonEventSequence;
}
export type DaemonClientId = string;
export type DaemonClientCapability =
	| "attach_snapshot"
	| "event_sequence"
	| "extension_ui"
	| "slim_attach"
	| "chunked_snapshot"
	| "client_owned_sessions";
export type DaemonPromptAdmissionCancellationStatus = "cancelled" | "owned" | "unknown";
export interface DaemonPromptAdmissionCancellationResult {
	status: DaemonPromptAdmissionCancellationStatus;
}
export type DaemonServerCapability =
	| DaemonClientCapability
	| "delete_rlm_subagent"
	| "heartbeat_catalog"
	| "heartbeat_management"
	| "model_catalog"
	// The daemon honors previousTurns on start_side_question (multi-turn side
	// conversations). Clients must check before sending follow-up transcripts.
	| "side_question_transcript"
	// The daemon honors transient and runId on execute_bash (side-conversation
	// bash: never recorded into the session, and its bash_start/bash_end events
	// carry the transient marker and echoed runId so clients correlate runs by
	// identity). Clients must check before sending.
	| "transient_bash"
	| "session_input_admission"
	| "prompt_admission_cancellation"
	// Attach results report wasAttached (whether the attach created the
	// socket's attachment entry). Clients must check before relying on the
	// field for cleanup decisions; without it they fall back to the legacy
	// unconditional detach.
	| "attach_ownership";

export type DaemonReplayStatus = "complete" | "partial" | "unavailable";

export interface DaemonProtocolInfo {
	name: DaemonProtocolName;
	version: DaemonProtocolVersion;
}

export const DAEMON_PROTOCOL_INFO: DaemonProtocolInfo = {
	name: DAEMON_PROTOCOL_NAME,
	version: DAEMON_PROTOCOL_VERSION,
};

export const DAEMON_DEFAULT_CLIENT_CAPABILITIES: readonly DaemonClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
];

export const DAEMON_SUPPORTED_CLIENT_CAPABILITIES: readonly DaemonClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
	"extension_ui",
	"slim_attach",
	"chunked_snapshot",
	"client_owned_sessions",
];

export const DAEMON_DEFAULT_SERVER_CAPABILITIES: readonly DaemonServerCapability[] = [
	...DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	"delete_rlm_subagent",
	"heartbeat_catalog",
	"heartbeat_management",
	"model_catalog",
	"side_question_transcript",
	"transient_bash",
	"session_input_admission",
	"prompt_admission_cancellation",
	"attach_ownership",
];

export interface DaemonRuntimeIdentity {
	buildId: string;
	executablePath: string;
	entrypointPath?: string;
	launcherPath?: string;
}

export type DaemonResumeCursor =
	| ({ activeSessionId?: string } & DaemonEventCursor)
	| { activeSessionId?: string; eventSequence: DaemonEventSequence };

export interface DaemonAttachClientMetadata {
	clientId?: DaemonClientId;
	capabilities?: readonly DaemonClientCapability[];
	resumeCursor?: DaemonResumeCursor;
	/** Opt-out-only policy. A telemetry-enabled worker must reject this attach. */
	telemetryDisabled?: true;
}

/**
 * Client-side env vars forwarded to the daemon so extensions can reach them
 * (e.g. HERDR_PANE_ID/HERDR_SOCKET_PATH that herdr sets per pane). The daemon
 * scopes these to the created session and merges them over process.env for
 * that session's pi.exec() subprocesses — it does not mutate the daemon's own
 * env. Carried on create only: attach must not rebind a session's identity,
 * since watchers (agents view, subagent viewers) also attach.
 */
export interface DaemonClientEnv {
	env?: Record<string, string>;
}

export type DaemonSessionLifecycle = "resident" | "client_owned";

export interface DaemonLaunchEnv {
	launchEnv?: Record<string, string>;
}

/**
 * The allowlist of env vars a client may forward. One shared list because it
 * is the wire contract: clients filter before sending and the daemon
 * re-filters on receipt (the socket peer is untrusted).
 */
export const DAEMON_CLIENT_ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
] as const;

/** Collect the allowlisted env vars from the client process for the create command. */
export function collectDaemonClientEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

export function collectDaemonLaunchEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && !key.startsWith("PRIME_AGENT_INTERNAL_")) {
			env[key] = value;
		}
	}
	return env;
}

export interface DaemonReplayInfo {
	status: DaemonReplayStatus;
	fromSequence?: DaemonEventSequence;
	toSequence: DaemonEventSequence;
	fromCursor?: DaemonEventCursor;
	toCursor?: DaemonEventCursor;
	reason?: string;
}

export interface DaemonEventMeta {
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	cursor?: DaemonEventCursor;
	emittedAt: string;
	replayed?: boolean;
}

export interface DaemonCommandEnvelope<TCommand extends DaemonCommand = DaemonCommand> {
	type: "command";
	id: DaemonCommandId;
	protocol: DaemonProtocolInfo;
	clientId?: DaemonClientId;
	command: TCommand;
}

export type DaemonCommandWire = DaemonCommand | DaemonCommandEnvelope;

export interface DaemonEventEnvelope<TEvent extends DaemonOutbound = DaemonOutbound> {
	type: "event";
	id: DaemonEventId;
	protocol: DaemonProtocolInfo;
	activeSessionId?: string;
	sequence?: DaemonEventSequence;
	cursor?: DaemonEventCursor;
	emittedAt: string;
	event: TEvent;
}

export interface DaemonArtifactReference {
	id: string;
	sessionId: string;
	type: string;
	logicalPath: string;
	relativePath?: string;
	mimeType?: string;
	metadata?: Record<string, string | number | boolean | null>;
}

export interface DaemonSessionSnapshot {
	activeSessionId: string;
	summary: SessionSummary;
	state: AgentConnectionState;
	messages: AgentMessage[];
	sessionContext?: AgentConnectionSessionContext;
	sessionTree?: { tree: AgentConnectionSessionTreeNode[]; leafId: string | null };
	lastEventSequence: DaemonEventSequence;
	lastEventCursor?: DaemonEventCursor;
	parent?: {
		activeSessionId?: string;
		sessionId?: string;
		nodeId?: string;
		childId?: string;
	};
	/** Live RLM child sessions (including grandchildren) hosted by the daemon under this session. */
	children?: AgentConnectionRlmChildAgentSnapshot[];
}

export interface DaemonAttachResult {
	protocol: DaemonProtocolInfo;
	activeSessionId: string;
	/** Omitted for clients with the "slim_attach" capability; use snapshot.summary. */
	state?: SessionSummary;
	/** Omitted for clients with the "slim_attach" capability; use snapshot.messages. */
	messages?: AgentMessage[];
	snapshot: DaemonSessionSnapshot;
	replay: DaemonReplayInfo;
	lastEventSequence: DaemonEventSequence;
	lastEventCursor?: DaemonEventCursor;
	snapshotStream?: {
		id: string;
		messageCount: number;
		targetChunkBytes: number;
	};
	/**
	 * False when this attach created the socket's attachment entry for the
	 * session, true when the socket was already attached (a sibling
	 * connection on the shared client). Lets a failed transition decide
	 * whether a cleanup detach would remove its own registration or a
	 * sibling's. Absent on older daemons.
	 */
	wasAttached?: boolean;
	client: {
		id: DaemonClientId;
		capabilities: DaemonClientCapability[];
	};
}

export const DAEMON_UPDATE_RESTART_FORMAT_VERSION = 1;

export interface DaemonUpdateRestartQueue {
	actions: SessionActionRecoverySnapshot;
	nextTurn: CustomMessage[];
}

export interface DaemonUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: AgentSessionRuntimeConfig;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	clientEnv?: Record<string, string>;
	queue: DaemonUpdateRestartQueue;
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

export interface DaemonUpdateRestartManifest {
	formatVersion: typeof DAEMON_UPDATE_RESTART_FORMAT_VERSION;
	createdAt: string;
	sessions: DaemonUpdateRestartSession[];
	discardedActiveSessionIds?: string[];
}

export type DaemonSavedSessionListCommand =
	| { id?: string; type: "list_saved_sessions"; activeSessionId: string; scope: AgentConnectionSavedSessionScope }
	| {
			id?: string;
			type: "list_saved_sessions";
			cwd: string;
			sessionDir?: string;
			scope: AgentConnectionSavedSessionScope;
	  };

export type DaemonCommand =
	| {
			id?: string;
			type: "list";
			all?: boolean;
			cwd?: string;
			sessionDir?: string;
			includeClientOwned?: boolean;
	  }
	| DaemonSavedSessionListCommand
	| ({
			id?: string;
			type: "create";
			sessionPath?: string;
			continueRecent?: boolean;
			noSession?: boolean;
			name?: string;
			config?: AgentSessionRuntimeConfig;
			runtimeMetadata?: AgentSessionRuntimeMetadata;
			lifecycle?: DaemonSessionLifecycle;
	  } & DaemonClientEnv &
			DaemonLaunchEnv)
	// Attach env is adopt-if-absent only: it fills identity for env-less
	// sessions (e.g. cron-created) but never rebinds one, since watchers
	// (agents view, subagent viewers) also attach.
	| ({
			id?: string;
			type: "attach";
			activeSessionId: string;
			supportsExtensionUi?: boolean;
	  } & DaemonAttachClientMetadata &
			DaemonClientEnv &
			DaemonLaunchEnv)
	| ({
			id?: string;
			type: "reattach";
			activeSessionId: string;
			targetActiveSessionId: string;
			supportsExtensionUi?: boolean;
	  } & DaemonAttachClientMetadata &
			DaemonClientEnv &
			DaemonLaunchEnv)
	| { id?: string; type: "detach"; activeSessionId?: string }
	| { id?: string; type: "complete_owned_session"; activeSessionId: string }
	| { id?: string; type: "promote_owned_session"; activeSessionId: string }
	| { id?: string; type: "kill"; activeSessionId: string }
	| { id?: string; type: "rename"; activeSessionId: string; name: string }
	| {
			id?: string;
			type: "prompt";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			queueIfBusy?: boolean;
			expandPromptTemplates?: boolean;
			source?: InputSource;
			agentMessageId?: string;
			customMessage?: CustomMessage;
			/** Unique only when the caller needs cancellable pre-ownership admission. */
			admissionId?: string;
	  }
	| {
			id?: string;
			type: "cancel_prompt_admission";
			activeSessionId: string;
			admissionId: string;
	  }
	| {
			id?: string;
			type: "prompt_and_wait";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			queueIfBusy?: boolean;
			expandPromptTemplates?: boolean;
			source?: InputSource;
			/** Unique only when the caller needs cancellable pre-ownership admission. */
			admissionId?: string;
	  }
	| {
			id?: string;
			type: "steer";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			queueKey?: string;
			expandPromptTemplates?: boolean;
			agentMessageId?: string;
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
	  }
	| {
			id?: string;
			type: "follow_up";
			activeSessionId: string;
			message: string;
			content?: (TextContent | ImageContent)[];
			images?: ImageContent[];
			queueKey?: string;
			expandPromptTemplates?: boolean;
			agentMessageId?: string;
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
	  }
	| { id?: string; type: "restore_next_turn"; activeSessionId: string; messages: CustomMessage[] }
	| { id?: string; type: "restore_actions"; activeSessionId: string; snapshot: SessionActionRecoverySnapshot }
	| {
			id?: string;
			type: "append_custom_message";
			activeSessionId: string;
			message: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	  }
	| { id?: string; type: "resume_queue"; activeSessionId: string }
	| {
			id?: string;
			type: "send_message";
			targetActiveSessionId: string;
			message: string;
			fromActiveSessionId?: string;
			/** Internal worker-origin marker; public clients remain unrestricted. */
			agentOrigin?: boolean;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "agent_messages_status"; activeSessionId?: string }
	| { id?: string; type: "agent_messages_pause"; activeSessionId?: string }
	| { id?: string; type: "agent_messages_resume"; activeSessionId?: string }
	| { id?: string; type: "agent_messages_clear"; activeSessionId: string }
	| { id?: string; type: "abort"; activeSessionId: string }
	| {
			id?: string;
			type: "start_side_question";
			activeSessionId: string;
			sideQuestionId: string;
			question: string;
			previousTurns?: AgentConnectionSideQuestionTurn[];
	  }
	| { id?: string; type: "abort_side_question"; activeSessionId: string; sideQuestionId: string }
	| {
			id?: string;
			type: "execute_bash";
			activeSessionId: string;
			command: string;
			excludeFromContext?: boolean;
			transient?: boolean;
			runId?: string;
	  }
	| { id?: string; type: "abort_bash"; activeSessionId: string }
	| { id?: string; type: "cancel_rlm_child"; activeSessionId: string; childId: string }
	| { id?: string; type: "delete_rlm_subagent"; activeSessionId: string; childId: string }
	| { id?: string; type: "wait_for_idle"; activeSessionId: string }
	| { id?: string; type: "wait_for_headless_completion"; activeSessionId: string }
	| { id?: string; type: "get_session_header"; activeSessionId: string }
	| { id?: string; type: "get_state"; activeSessionId: string }
	| { id?: string; type: "get_connection_state"; activeSessionId: string }
	| { id?: string; type: "get_messages"; activeSessionId: string }
	| { id?: string; type: "get_session_stats"; activeSessionId: string }
	| { id?: string; type: "get_context_tree"; activeSessionId: string }
	| { id?: string; type: "get_commands"; activeSessionId: string }
	| { id?: string; type: "get_resource_snapshot"; activeSessionId: string }
	| { id?: string; type: "get_model_catalog"; activeSessionId: string }
	| { id?: string; type: "get_available_models"; activeSessionId: string }
	| { id?: string; type: "get_queue"; activeSessionId: string }
	| { id?: string; type: "clear_queue"; activeSessionId: string }
	| { id?: string; type: "abort_and_clear_queue"; activeSessionId: string }
	| { id?: string; type: "cron_list"; activeSessionId?: string; includeInactive?: boolean }
	| { id?: string; type: "heartbeats_list"; activeSessionId?: string }
	| {
			id?: string;
			type: "heartbeat_manage";
			activeSessionId: string;
			jobId: string;
			action: AgentHeartbeatManagementAction;
	  }
	| {
			id?: string;
			type: "cron_add";
			activeSessionId: string;
			schedule: string;
			prompt: string;
			promoteOwnedSession?: boolean;
	  }
	| { id?: string; type: "cron_cancel"; activeSessionId?: string; jobId: string }
	| { id?: string; type: "heartbeat_get"; activeSessionId: string }
	| {
			id?: string;
			type: "heartbeat_set";
			activeSessionId: string;
			schedule: string;
			prompt: string;
			deliveryMode?: AgentHeartbeatDeliveryMode;
			promoteOwnedSession?: boolean;
	  }
	| { id?: string; type: "heartbeat_update"; activeSessionId: string; action: AgentHeartbeatUpdateAction }
	| { id?: string; type: "set_model"; activeSessionId: string; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; activeSessionId: string; direction?: "forward" | "backward" }
	| { id?: string; type: "set_scoped_models"; activeSessionId: string; scopedModels: AgentConnectionScopedModel[] }
	| { id?: string; type: "set_thinking_level"; activeSessionId: string; level: ThinkingLevel }
	| { id?: string; type: "set_service_tier"; activeSessionId: string; serviceTier: ServiceTier }
	| { id?: string; type: "cycle_thinking_level"; activeSessionId: string }
	| { id?: string; type: "set_transport"; activeSessionId: string; transport: Transport }
	| { id?: string; type: "set_steering_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_follow_up_mode"; activeSessionId: string; mode: AgentConnectionQueueMode }
	| { id?: string; type: "set_auto_compaction"; activeSessionId: string; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; activeSessionId: string; enabled: boolean }
	| { id?: string; type: "compact"; activeSessionId: string; customInstructions?: string }
	| {
			id?: string;
			type: "refine";
			activeSessionId: string;
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
	  }
	| { id?: string; type: "abort_compaction"; activeSessionId: string }
	| { id?: string; type: "abort_branch_summary"; activeSessionId: string }
	| { id?: string; type: "abort_retry"; activeSessionId: string }
	| { id?: string; type: "execute_bash_and_wait"; activeSessionId: string; command: string }
	| { id?: string; type: "reload"; activeSessionId: string }
	| { id?: string; type: "new_session"; activeSessionId: string; parentSession?: string }
	| { id?: string; type: "switch_session"; activeSessionId: string; sessionPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; activeSessionId: string; entryId: string; position?: "before" | "at" }
	| {
			id?: string;
			type: "navigate_tree";
			activeSessionId: string;
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "import_jsonl"; activeSessionId: string; inputPath: string; cwdOverride?: string }
	| { id?: string; type: "export_html"; activeSessionId: string; outputPath?: string }
	| { id?: string; type: "export_jsonl"; activeSessionId: string; outputPath?: string }
	| { id?: string; type: "set_session_name"; activeSessionId: string; name: string; workerToken?: string }
	| { id?: string; type: "get_rlm_max_depth_status"; activeSessionId: string }
	| { id?: string; type: "set_rlm_max_depth"; activeSessionId: string; maxDepth: number; global?: boolean }
	| { id?: string; type: "rename_saved_session"; activeSessionId?: string; sessionPath: string; name: string }
	| { id?: string; type: "delete_saved_session"; activeSessionId?: string; sessionPath: string }
	| { id?: string; type: "get_session_context"; activeSessionId: string }
	| { id?: string; type: "get_session_tree"; activeSessionId: string }
	| { id?: string; type: "get_user_messages_for_forking"; activeSessionId: string }
	| { id?: string; type: "get_last_assistant_text"; activeSessionId: string }
	| { id?: string; type: "get_system_prompt"; activeSessionId: string }
	| { id?: string; type: "get_tool_definition"; activeSessionId: string; name: string }
	| { id?: string; type: "set_session_entry_label"; activeSessionId: string; entryId: string; label?: string }
	| {
			id?: string;
			type: "extension_ui_response";
			activeSessionId: string;
			requestId: string;
			response: DaemonExtensionUIResponse;
	  }
	| { id?: string; type: "ack_result"; commandId: string }
	| { id?: string; type: "prepare_update_restart" }
	| { id?: string; type: "retry_worker"; activeSessionId: string }
	| { id?: string; type: "restart" }
	| { id?: string; type: "shutdown"; force?: boolean };

type DaemonCommandName = DaemonCommand["type"];

export interface DaemonCommandCompatibility {
	minProtocol: number;
	minSchemaRevision?: number;
	capability?: DaemonServerCapability;
}

const LEGACY_DAEMON_COMMAND = { minProtocol: 7 } as const;
const CURRENT_DAEMON_COMMAND = { minProtocol: 7 } as const;
const RLM_MAX_DEPTH_COMMAND = { minProtocol: 7, minSchemaRevision: 11 } as const;
const SESSION_INPUT_ADMISSION_COMMAND = {
	minProtocol: 7,
	capability: "session_input_admission",
} as const;
const PROMPT_ADMISSION_CANCELLATION_COMMAND = {
	minProtocol: 7,
	minSchemaRevision: 8,
	capability: "prompt_admission_cancellation",
} as const;
const CLIENT_OWNED_DAEMON_COMMAND = {
	minProtocol: 7,
	capability: "client_owned_sessions",
} as const;
const DELETE_RLM_SUBAGENT_COMMAND = {
	minProtocol: 7,
	capability: "delete_rlm_subagent",
} as const;
const FLAT_SESSION_TREE_COMMAND = { minProtocol: 7 } as const;
const TELEMETRY_POLICY_COMMAND = { minProtocol: 7, minSchemaRevision: 14 } as const;

export const DAEMON_COMMAND_COMPATIBILITY = {
	ack_result: LEGACY_DAEMON_COMMAND,
	list: LEGACY_DAEMON_COMMAND,
	list_saved_sessions: LEGACY_DAEMON_COMMAND,
	create: LEGACY_DAEMON_COMMAND,
	attach: LEGACY_DAEMON_COMMAND,
	reattach: LEGACY_DAEMON_COMMAND,
	detach: LEGACY_DAEMON_COMMAND,
	complete_owned_session: CLIENT_OWNED_DAEMON_COMMAND,
	promote_owned_session: CLIENT_OWNED_DAEMON_COMMAND,
	kill: LEGACY_DAEMON_COMMAND,
	rename: LEGACY_DAEMON_COMMAND,
	prompt: SESSION_INPUT_ADMISSION_COMMAND,
	cancel_prompt_admission: PROMPT_ADMISSION_CANCELLATION_COMMAND,
	prompt_and_wait: SESSION_INPUT_ADMISSION_COMMAND,
	steer: SESSION_INPUT_ADMISSION_COMMAND,
	follow_up: SESSION_INPUT_ADMISSION_COMMAND,
	restore_next_turn: LEGACY_DAEMON_COMMAND,
	restore_actions: LEGACY_DAEMON_COMMAND,
	append_custom_message: LEGACY_DAEMON_COMMAND,
	resume_queue: SESSION_INPUT_ADMISSION_COMMAND,
	send_message: LEGACY_DAEMON_COMMAND,
	agent_messages_status: LEGACY_DAEMON_COMMAND,
	agent_messages_pause: LEGACY_DAEMON_COMMAND,
	agent_messages_resume: LEGACY_DAEMON_COMMAND,
	agent_messages_clear: LEGACY_DAEMON_COMMAND,
	abort: LEGACY_DAEMON_COMMAND,
	start_side_question: LEGACY_DAEMON_COMMAND,
	abort_side_question: LEGACY_DAEMON_COMMAND,
	execute_bash: LEGACY_DAEMON_COMMAND,
	abort_bash: LEGACY_DAEMON_COMMAND,
	cancel_rlm_child: LEGACY_DAEMON_COMMAND,
	delete_rlm_subagent: DELETE_RLM_SUBAGENT_COMMAND,
	wait_for_idle: LEGACY_DAEMON_COMMAND,
	wait_for_headless_completion: CURRENT_DAEMON_COMMAND,
	get_session_header: CURRENT_DAEMON_COMMAND,
	get_state: LEGACY_DAEMON_COMMAND,
	get_connection_state: LEGACY_DAEMON_COMMAND,
	get_messages: LEGACY_DAEMON_COMMAND,
	get_session_stats: LEGACY_DAEMON_COMMAND,
	get_context_tree: LEGACY_DAEMON_COMMAND,
	get_commands: LEGACY_DAEMON_COMMAND,
	get_resource_snapshot: LEGACY_DAEMON_COMMAND,
	get_model_catalog: { minProtocol: 7, capability: "model_catalog" },
	get_available_models: LEGACY_DAEMON_COMMAND,
	get_queue: LEGACY_DAEMON_COMMAND,
	clear_queue: LEGACY_DAEMON_COMMAND,
	abort_and_clear_queue: LEGACY_DAEMON_COMMAND,
	cron_list: LEGACY_DAEMON_COMMAND,
	heartbeats_list: { minProtocol: 7, capability: "heartbeat_catalog" },
	heartbeat_manage: { minProtocol: 7, capability: "heartbeat_management" },
	cron_add: LEGACY_DAEMON_COMMAND,
	cron_cancel: LEGACY_DAEMON_COMMAND,
	heartbeat_get: LEGACY_DAEMON_COMMAND,
	heartbeat_set: LEGACY_DAEMON_COMMAND,
	heartbeat_update: LEGACY_DAEMON_COMMAND,
	set_model: LEGACY_DAEMON_COMMAND,
	cycle_model: LEGACY_DAEMON_COMMAND,
	set_scoped_models: LEGACY_DAEMON_COMMAND,
	set_thinking_level: LEGACY_DAEMON_COMMAND,
	set_service_tier: LEGACY_DAEMON_COMMAND,
	cycle_thinking_level: LEGACY_DAEMON_COMMAND,
	set_transport: LEGACY_DAEMON_COMMAND,
	set_steering_mode: LEGACY_DAEMON_COMMAND,
	set_follow_up_mode: LEGACY_DAEMON_COMMAND,
	set_auto_compaction: LEGACY_DAEMON_COMMAND,
	set_auto_retry: CURRENT_DAEMON_COMMAND,
	compact: LEGACY_DAEMON_COMMAND,
	refine: LEGACY_DAEMON_COMMAND,
	abort_compaction: LEGACY_DAEMON_COMMAND,
	abort_branch_summary: LEGACY_DAEMON_COMMAND,
	abort_retry: LEGACY_DAEMON_COMMAND,
	execute_bash_and_wait: CURRENT_DAEMON_COMMAND,
	reload: LEGACY_DAEMON_COMMAND,
	new_session: LEGACY_DAEMON_COMMAND,
	switch_session: LEGACY_DAEMON_COMMAND,
	fork: LEGACY_DAEMON_COMMAND,
	navigate_tree: LEGACY_DAEMON_COMMAND,
	import_jsonl: LEGACY_DAEMON_COMMAND,
	export_html: LEGACY_DAEMON_COMMAND,
	export_jsonl: LEGACY_DAEMON_COMMAND,
	set_session_name: LEGACY_DAEMON_COMMAND,
	get_rlm_max_depth_status: RLM_MAX_DEPTH_COMMAND,
	set_rlm_max_depth: RLM_MAX_DEPTH_COMMAND,
	rename_saved_session: LEGACY_DAEMON_COMMAND,
	delete_saved_session: LEGACY_DAEMON_COMMAND,
	get_session_context: LEGACY_DAEMON_COMMAND,
	get_session_tree: FLAT_SESSION_TREE_COMMAND,
	get_user_messages_for_forking: LEGACY_DAEMON_COMMAND,
	get_last_assistant_text: LEGACY_DAEMON_COMMAND,
	get_system_prompt: LEGACY_DAEMON_COMMAND,
	get_tool_definition: LEGACY_DAEMON_COMMAND,
	set_session_entry_label: LEGACY_DAEMON_COMMAND,
	extension_ui_response: LEGACY_DAEMON_COMMAND,
	prepare_update_restart: LEGACY_DAEMON_COMMAND,
	retry_worker: LEGACY_DAEMON_COMMAND,
	restart: LEGACY_DAEMON_COMMAND,
	shutdown: LEGACY_DAEMON_COMMAND,
} as const satisfies Record<DaemonCommandName, DaemonCommandCompatibility>;

export function getDaemonCommandCompatibilities(command: DaemonCommand): readonly DaemonCommandCompatibility[] {
	const compatibility = DAEMON_COMMAND_COMPATIBILITY[command.type];
	const carriesTelemetryPolicy =
		((command.type === "attach" || command.type === "reattach") && command.telemetryDisabled !== undefined) ||
		(command.type === "create" && command.config?.telemetryDisabled !== undefined);
	if (carriesTelemetryPolicy) {
		return [TELEMETRY_POLICY_COMMAND, compatibility];
	}
	if ((command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId !== undefined) {
		return [PROMPT_ADMISSION_CANCELLATION_COMMAND, compatibility];
	}
	return [compatibility];
}

export type DaemonResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorInfo?: DaemonErrorInfo;
	  };

export type DaemonErrorInfo =
	| { code: "missing_session_cwd"; issue: SessionCwdIssue }
	| { code: "session_import_file_not_found"; filePath: string }
	| { code: "session_already_active"; sessionPath: string; activeSessionId?: string }
	| { code: "command_result_uncertain"; clientId: DaemonClientId; commandId: DaemonCommandId };

export type DaemonSessionClosedReason = "killed" | "shutdown" | "completed" | "replaced" | "update";
export type DaemonClosingReason = "shutdown" | "update";

export type DaemonExtensionUIResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export function isDaemonDialogExtensionUiRequest(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

/**
 * True when a daemon rejected a command it does not know, i.e. the daemon
 * process was started from a build that predates the command.
 */
export function isUnknownDaemonCommandError(error: unknown, command: DaemonCommand["type"]): boolean {
	return error instanceof Error && error.message.includes(`Unknown daemon command: ${command}`);
}

export type DaemonRequestProgress =
	| {
			id?: string;
			type: "session_list_progress";
			command: "list_saved_sessions";
			activeSessionId?: string;
			loaded: number;
			total: number;
	  }
	| {
			id?: string;
			type: "session_list_item";
			command: "list_saved_sessions";
			activeSessionId?: string;
			session: DaemonSavedSessionInfo;
	  };

export interface DaemonSavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: AgentConnectionSavedSessionState;
	parentSessionPath?: string;
	rlmDepth?: number;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	agentStatus?: AgentConnectionAgentStatus;
}

export type DaemonDeleteSavedSessionResult = DeleteSessionFileResult;
export type DaemonAutonomousStatus = AgentAutonomousStatus;
export type DaemonBashResult = BashResult;
export type DaemonSessionHeader = AgentConnectionSessionHeader;

export type DaemonResourceSnapshot = AgentConnectionResourceSnapshot;

export type DaemonCronJob = AgentCronJob;
export type DaemonHeartbeat = AgentConnectionHeartbeat;
export type DaemonAgentSessionMessageReceipt = AgentSessionMessageReceipt;
export type DaemonAgentSessionMessageSafetyStatus = AgentSessionMessageSafetyStatus;

export type DaemonOutbound =
	| DaemonResponse
	| DaemonRequestProgress
	| {
			type: "daemon_hello";
			socketPath: string;
			protocol: DaemonProtocolInfo;
			schemaId?: string;
			/** Monotonic wire-schema revision for field-sensitive compatibility checks. */
			schemaRevision?: number;
			/** App version of the daemon process, used to detect stale daemons after self-update. */
			appVersion?: string;
			runtime?: DaemonRuntimeIdentity;
			/** Changes whenever the public supervisor process is replaced. */
			supervisorGeneration?: string;
			/** Diagnostic process identity for attributing supervisor replacement. */
			supervisorPid?: number;
			/** Durable owner marker for validating update handoff fences. */
			supervisorOwnerToken?: string;
			/** Process start identity captured when the durable owner was published. */
			supervisorProcessStartId?: string;
			/** Normalized socket identity stored in the durable owner record. */
			supervisorSocketPath?: string;
			clientId: DaemonClientId;
			serverCapabilities: readonly DaemonServerCapability[];
	  }
	| { type: "daemon_closing"; reason: DaemonClosingReason }
	| { type: "heartbeats_changed" }
	| { type: "session_event"; activeSessionId: string; event: AgentConnectionSessionEvent; meta?: DaemonEventMeta }
	| { type: "side_question_event"; activeSessionId: string; event: AgentConnectionSideQuestionEvent }
	| { type: "session_status"; activeSessionId: string; recap?: string; meta?: DaemonEventMeta }
	| {
			type: "session_replaced";
			activeSessionId: string;
			state: AgentConnectionState;
			messages: AgentMessage[];
			snapshotFollows?: boolean;
			meta?: DaemonEventMeta;
	  }
	| {
			type: "session_resynced";
			activeSessionId: string;
			snapshot: DaemonSessionSnapshot;
			meta?: DaemonEventMeta;
	  }
	| {
			type: "session_attached";
			activeSessionId: string;
			state: SessionSummary;
			messages: AgentMessage[];
			snapshot?: DaemonSessionSnapshot;
			replay?: DaemonReplayInfo;
			lastEventSequence?: DaemonEventSequence;
	  }
	| {
			type: "session_snapshot_begin";
			activeSessionId: string;
			snapshotId: string;
			snapshot: Omit<DaemonSessionSnapshot, "messages">;
			messageCount: number;
			targetChunkBytes: number;
			purpose?: "attach" | "replacement" | "resync";
	  }
	| {
			type: "session_snapshot_chunk";
			activeSessionId: string;
			snapshotId: string;
			index: number;
			messages: AgentMessage[];
	  }
	| {
			type: "session_snapshot_end";
			activeSessionId: string;
			snapshotId: string;
			chunkCount: number;
			lastEventSequence: DaemonEventSequence;
			lastEventCursor?: DaemonEventCursor;
	  }
	| {
			type: "session_snapshot_failed";
			activeSessionId: string;
			snapshotId: string;
			error: string;
	  }
	| { type: "session_detached"; activeSessionId: string }
	| { type: "session_closed"; activeSessionId: string; reason: DaemonSessionClosedReason; meta?: DaemonEventMeta }
	| {
			type: "extension_ui_request";
			activeSessionId: string;
			id: string;
			method: string;
			payload: Record<string, unknown>;
			meta?: DaemonEventMeta;
	  }
	| {
			type: "extension_error";
			activeSessionId: string;
			extensionPath: string;
			event: string;
			error: string;
			meta?: DaemonEventMeta;
	  };

export const DAEMON_OUTBOUND_COMPATIBILITY = {
	response: LEGACY_DAEMON_COMMAND,
	session_list_progress: LEGACY_DAEMON_COMMAND,
	session_list_item: LEGACY_DAEMON_COMMAND,
	daemon_hello: LEGACY_DAEMON_COMMAND,
	daemon_closing: LEGACY_DAEMON_COMMAND,
	heartbeats_changed: { minProtocol: 7, capability: "heartbeat_catalog" },
	session_event: LEGACY_DAEMON_COMMAND,
	side_question_event: LEGACY_DAEMON_COMMAND,
	session_status: LEGACY_DAEMON_COMMAND,
	session_replaced: LEGACY_DAEMON_COMMAND,
	session_resynced: LEGACY_DAEMON_COMMAND,
	session_attached: LEGACY_DAEMON_COMMAND,
	session_snapshot_begin: LEGACY_DAEMON_COMMAND,
	session_snapshot_chunk: LEGACY_DAEMON_COMMAND,
	session_snapshot_end: LEGACY_DAEMON_COMMAND,
	session_snapshot_failed: LEGACY_DAEMON_COMMAND,
	session_detached: LEGACY_DAEMON_COMMAND,
	session_closed: LEGACY_DAEMON_COMMAND,
	extension_ui_request: LEGACY_DAEMON_COMMAND,
	extension_error: LEGACY_DAEMON_COMMAND,
} as const satisfies Record<DaemonOutbound["type"], DaemonCommandCompatibility>;

export function createDaemonCommandEnvelope<TCommand extends DaemonCommand>(
	command: TCommand,
	id: DaemonCommandId,
	clientId?: DaemonClientId,
	protocolVersion: DaemonProtocolVersion = DAEMON_PROTOCOL_VERSION,
): DaemonCommandEnvelope<TCommand> {
	return {
		type: "command",
		id,
		protocol: { name: DAEMON_PROTOCOL_NAME, version: protocolVersion },
		...(clientId ? { clientId } : {}),
		command,
	};
}

export function isDaemonCommandEnvelope(value: unknown): value is DaemonCommandEnvelope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as {
		type?: unknown;
		id?: unknown;
		protocol?: { name?: unknown; version?: unknown };
		clientId?: unknown;
		command?: unknown;
	};
	return (
		candidate.type === "command" &&
		typeof candidate.id === "string" &&
		candidate.protocol?.name === DAEMON_PROTOCOL_NAME &&
		typeof candidate.protocol.version === "number" &&
		candidate.protocol.version >= DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION &&
		candidate.protocol.version <= DAEMON_PROTOCOL_VERSION &&
		(candidate.clientId === undefined || typeof candidate.clientId === "string") &&
		typeof candidate.command === "object" &&
		candidate.command !== null
	);
}

/**
 * Best-effort id salvage for rejected command lines, so parse failures reach
 * the sender as correlatable responses instead of client-side timeouts.
 * Deliberately ignores everything but the id itself: whatever made the line
 * unparseable (rejected protocol version, missing or invalid type), the
 * sender still correlates the failure by id.
 */
export function salvageDaemonCommandId(line: string): string | undefined {
	try {
		const candidate = JSON.parse(line) as { id?: unknown };
		if (!candidate || typeof candidate !== "object") {
			return undefined;
		}
		return typeof candidate.id === "string" ? candidate.id : undefined;
	} catch {
		return undefined;
	}
}

const READ_ONLY_DAEMON_COMMANDS: ReadonlySet<DaemonCommand["type"]> = new Set([
	"ack_result",
	"list",
	"list_saved_sessions",
	"attach",
	"reattach",
	"agent_messages_status",
	"wait_for_idle",
	"get_session_header",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"get_model_catalog",
	"get_available_models",
	"get_queue",
	"cron_list",
	"heartbeats_list",
	"heartbeat_get",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_rlm_max_depth_status",
	"get_tool_definition",
]);

export function isDaemonMutatingCommand(command: Pick<DaemonCommand, "type">): boolean {
	return !READ_ONLY_DAEMON_COMMANDS.has(command.type);
}

export const UPDATE_RESTART_DRAIN_COMMANDS: ReadonlySet<DaemonCommand["type"]> = new Set([
	"extension_ui_response",
	"abort",
	"abort_bash",
	"abort_branch_summary",
	"abort_compaction",
	"abort_retry",
]);

export function createDaemonEventEnvelope<TEvent extends DaemonOutbound>(
	event: TEvent,
	meta: DaemonEventMeta,
): DaemonEventEnvelope<TEvent> {
	return {
		type: "event",
		id: meta.id,
		protocol: meta.protocol,
		...(meta.activeSessionId ? { activeSessionId: meta.activeSessionId } : {}),
		...(meta.sequence !== undefined ? { sequence: meta.sequence } : {}),
		...(meta.cursor ? { cursor: meta.cursor } : {}),
		emittedAt: meta.emittedAt,
		event,
	};
}

export function createDaemonEventMeta(
	activeSessionId: string,
	sequence: DaemonEventSequence,
	emittedAt = new Date().toISOString(),
	generation = activeSessionId,
): DaemonEventMeta {
	return {
		id: `${activeSessionId}:${sequence}`,
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		sequence,
		cursor: { generation, sequence },
		emittedAt,
	};
}

export function createDaemonReplayInfo(
	resumeCursor: DaemonResumeCursor | undefined,
	lastEventSequence: DaemonEventSequence,
	generation = "legacy",
): DaemonReplayInfo {
	const toCursor = { generation, sequence: lastEventSequence };
	if (!resumeCursor) {
		return {
			status: "complete",
			toSequence: lastEventSequence,
			toCursor,
		};
	}
	const resumeSequence = "sequence" in resumeCursor ? resumeCursor.sequence : resumeCursor.eventSequence;
	const fromCursor =
		"generation" in resumeCursor
			? { generation: resumeCursor.generation, sequence: resumeCursor.sequence }
			: undefined;
	if (fromCursor && fromCursor.generation !== generation) {
		return {
			status: "unavailable",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			fromCursor,
			toCursor,
			reason: "event_generation_changed",
		};
	}

	if (resumeSequence > lastEventSequence) {
		return {
			status: "unavailable",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			...(fromCursor ? { fromCursor } : {}),
			toCursor,
			reason: "resume_cursor_ahead_of_session",
		};
	}

	if (resumeSequence === lastEventSequence) {
		return {
			status: "complete",
			fromSequence: resumeSequence,
			toSequence: lastEventSequence,
			...(fromCursor ? { fromCursor } : {}),
			toCursor,
		};
	}

	return {
		status: "unavailable",
		fromSequence: resumeSequence,
		toSequence: lastEventSequence,
		...(fromCursor ? { fromCursor } : {}),
		toCursor,
		reason: "event_replay_not_available",
	};
}

export function success(id: string | undefined, command: DaemonCommandName, data?: unknown): DaemonResponse {
	return data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data };
}

export function failure(
	id: string | undefined,
	command: string,
	error: unknown,
	errorInfo?: DaemonErrorInfo,
): DaemonResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
		...(errorInfo ? { errorInfo } : {}),
	};
}
