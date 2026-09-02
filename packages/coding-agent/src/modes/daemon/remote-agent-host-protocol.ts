/**
 * Remote agent-host wire protocol.
 *
 * JSON-safe, versioned protocol for communication between a home Prime Agent
 * daemon and a remote execution host (e.g. Prime Sandbox).
 *
 * This file defines the protocol types only. Implementation of the transport
 * layer and daemon-protocol integration happen in later work packages.
 *
 * The remote protocol is independent of the local daemon protocol version.
 * Compatibility is negotiated at handshake time.
 */

export const REMOTE_HOST_PROTOCOL_NAME = "prime-agent.remote-host";
export const REMOTE_HOST_PROTOCOL_VERSION = 1;

export interface RemoteHostProtocolInfo {
	name: typeof REMOTE_HOST_PROTOCOL_NAME;
	version: typeof REMOTE_HOST_PROTOCOL_VERSION;
}

export const REMOTE_HOST_PROTOCOL_INFO: RemoteHostProtocolInfo = {
	name: REMOTE_HOST_PROTOCOL_NAME,
	version: REMOTE_HOST_PROTOCOL_VERSION,
};

/** Execution-host build identity, reported at handshake so the home daemon
 *  can reject build-skewed hosts before admitting commands.
 *  Includes the home daemon protocol version and schema revision so both
 *  software build AND wire schema are validated at handshake time. */
export interface RemoteHostBuildIdentity {
	buildId: string;
	daemonProtocolVersion: number;
	daemonSchemaRevision: number;
	appVersion?: string;
}

/** JSON-safe value for all payload fields on the wire. No `unknown`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Opaque artifact reference used instead of filesystem paths. */
export interface ArtifactRef {
	workspaceId: string;
	snapshotId?: string;
	changesetId?: string;
}

export type RemoteHostCapability =
	| "session_commands"
	| "sequenced_events"
	| "provider_proxy"
	| "agent_messages"
	| "link_health"
	| "checkpoint"
	| "workspace_sync"
	| "acknowledgements";

export type RemoteHostClientCapability = "acknowledgements" | "replay_catchup" | "provider_proxy_streaming";

export type RemoteHostFrameId = string;
export type RemoteHostSessionId = string;
export type RemoteHostEventSequence = number;

export interface RemoteHostEventCursor {
	hostId: string;
	generation: string;
	sessionId: RemoteHostSessionId;
	sequence: RemoteHostEventSequence;
}

export interface RemoteHostFrameEnvelope {
	type: "frame";
	frameId: RemoteHostFrameId;
	protocol: RemoteHostProtocolInfo;
	sentAt: string;
	lastReceivedEventSequence?: RemoteHostEventSequence;
	frame: RemoteHostFrame;
}

export type RemoteHostFrame =
	| RemoteHostHandshakeFrame
	| RemoteHostHandshakeAckFrame
	| RemoteHostCommandFrame
	| RemoteHostEventFrame
	| RemoteHostAckFrame
	| RemoteHostAgentMessageFrame
	| RemoteHostProviderProxyFrame
	| RemoteHostHealthFrame
	| RemoteHostErrorFrame;

export type RemoteHostLinkDirection = "home_to_host" | "host_to_home";

export interface RemoteHostHandshakeFrame {
	type: "handshake";
	direction: RemoteHostLinkDirection;
	hostId: string;
	generation: string;
	sessionId?: RemoteHostSessionId;
	capabilities: RemoteHostCapability[];
	clientCapabilities?: RemoteHostClientCapability[];
	runtime: RemoteHostBuildIdentity;
	protocol: RemoteHostProtocolInfo;
	resumeCursor?: RemoteHostEventCursor;
}

export interface RemoteHostHandshakeAckFrame {
	type: "handshake_ack";
	hostId: string;
	sessionId: string;
	protocol: RemoteHostProtocolInfo;
	accepted: boolean;
	rejectReason?: string;
	capabilities: RemoteHostCapability[];
	linkId: string;
	cursor?: RemoteHostEventCursor;
	/** Required remote build identity for exact-build admission checks. */
	remoteBuildIdentity: RemoteHostBuildIdentity;
}

export type RemoteHostCommandFrameBody =
	| { type: "create_session"; workspaceId: string; name?: string; telemetryDisabled?: boolean }
	| { type: "destroy_session"; reason?: string }
	| { type: "prompt"; message: string; admissionId?: string }
	| { type: "steer"; message: string; queueKey?: string }
	| { type: "abort" }
	| { type: "execute_bash"; command: string; transient?: boolean; runId?: string }
	| { type: "abort_bash" }
	| { type: "compact"; customInstructions?: string }
	| { type: "compact_abort" }
	| { type: "checkpoint"; leaveSandboxAlive?: boolean }
	| { type: "wake"; snapshotId: string }
	| { type: "shutdown"; force?: boolean }
	| { type: "sync_workspace"; artifact: ArtifactRef };

export interface RemoteHostCommandFrame {
	type: "command";
	commandId: RemoteHostFrameId;
	body: RemoteHostCommandFrameBody;
}

/** Session activity states, kept separate from link connectivity status. */
export type RemoteHostSessionState = "running" | "idle" | "inactive";

export type RemoteHostEventBody =
	| { type: "session_created"; sessionId: RemoteHostSessionId; workspaceId: string }
	| { type: "session_destroyed"; reason?: string }
	| { type: "agent_start" }
	| { type: "agent_end"; messages: number }
	| { type: "agent_text_delta"; index: number; text: string }
	| { type: "agent_thinking_delta"; index: number; text: string }
	| { type: "agent_toolcall_delta"; index: number; text: string }
	| { type: "bash_start"; command: string }
	| { type: "bash_end"; exitCode: number; cancelled: boolean; truncated: boolean }
	| { type: "bash_delta"; text: string }
	| { type: "compact_start" }
	| { type: "compact_end"; keptMessages: number }
	| { type: "compact_failed"; error: string }
	| { type: "error"; code: string; message: string }
	| { type: "checkpoint_start" }
	| { type: "checkpoint_complete"; snapshotId: string }
	| { type: "checkpoint_failed"; error: string }
	| { type: "session_state"; state: RemoteHostSessionState };

export interface RemoteHostEventFrame {
	type: "event";
	id: RemoteHostFrameId;
	sequence: RemoteHostEventSequence;
	cursor: RemoteHostEventCursor;
	emittedAt: string;
	body: RemoteHostEventBody;
}

export interface RemoteHostAckFrame {
	type: "ack";
	ackId: RemoteHostFrameId;
	acknowledges: RemoteHostFrameId;
	status: "delivered" | "replayed" | "rejected";
	rejectReason?: string;
}

export interface RemoteHostAgentMessageFrame {
	type: "agent_message";
	id: RemoteHostFrameId;
	fromActiveSessionId: string;
	targetActiveSessionId: string;
	message: string;
	deliveryMode?: "queued" | "direct";
}

export type RemoteHostProviderProxyFrame =
	| {
			type: "provider_proxy";
			proxyType: "model_call_request";
			callId: string;
			provider: string;
			model: string;
			systemPrompt?: string;
			messages: JsonValue[];
			tools?: JsonValue[];
			maxTokens?: number;
			temperature?: number;
			thinkingLevel?: string;
			streamingBehavior?: "steer" | "followUp";
	  }
	| {
			type: "provider_proxy";
			proxyType: "model_call_chunk";
			callId: string;
			index: number;
			delta: JsonValue;
	  }
	| {
			type: "provider_proxy";
			proxyType: "model_call_complete";
			callId: string;
			result: JsonValue;
			usage?: { inputTokens: number; outputTokens: number };
	  }
	| {
			type: "provider_proxy";
			proxyType: "model_call_error";
			callId: string;
			error: string;
	  }
	| {
			type: "provider_proxy";
			proxyType: "model_call_cancel";
			callId: string;
	  };

export type RemoteHostLinkStatus = "connecting" | "connected" | "reconnecting" | "unreachable" | "closed";

export interface RemoteHostHealthFrame {
	type: "health";
	healthSeq: number;
	status: RemoteHostLinkStatus;
	lastReceivedFrameId?: RemoteHostFrameId;
	lastReceivedEventSequence?: RemoteHostEventSequence;
}

export interface RemoteHostErrorFrame {
	type: "error";
	code: string;
	message: string;
	inReplyTo?: RemoteHostFrameId;
}

export function isRemoteHostProtocolCompatible(local: RemoteHostProtocolInfo, remote: RemoteHostProtocolInfo): boolean {
	return remote.name === local.name && remote.version === local.version;
}

export function isRemoteHostBuildCompatible(local: RemoteHostBuildIdentity, remote: RemoteHostBuildIdentity): boolean {
	return (
		local.buildId === remote.buildId &&
		local.daemonProtocolVersion === remote.daemonProtocolVersion &&
		local.daemonSchemaRevision === remote.daemonSchemaRevision
	);
}

export function intersectRemoteHostCapabilities(
	a: readonly RemoteHostCapability[],
	b: readonly RemoteHostCapability[],
): RemoteHostCapability[] {
	const set = new Set(b);
	return a.filter((c) => set.has(c));
}

export interface RemoteHostValidationError {
	code: string;
	message: string;
}

const KNOWN_FRAME_TYPES = new Set([
	"handshake",
	"handshake_ack",
	"command",
	"event",
	"ack",
	"agent_message",
	"provider_proxy",
	"health",
	"error",
]);

const KNOWN_HANDSHAKE_ACK_FIELDS = new Set([
	"type",
	"accepted",
	"hostId",
	"sessionId",
	"protocol",
	"capabilities",
	"linkId",
	"rejectReason",
	"cursor",
	"remoteBuildIdentity",
]);

const KNOWN_CAPABILITIES = new Set([
	"session_commands",
	"sequenced_events",
	"provider_proxy",
	"agent_messages",
	"link_health",
	"checkpoint",
	"workspace_sync",
	"acknowledgements",
]);
const MAX_ID_LENGTH = 128;
const MAX_REJECT_REASON_LENGTH = 256;

/**
 * Strict validation of a parsed handshake_ack frame.
 *
 * Validates every field before the caller casts: accepted boolean,
 * bounded hostId/sessionId/linkId, exact protocol fields, known/bounded
 * capabilities, cursor identity/sequence, remoteBuildIdentity exact fields,
 * safe fixed reject reason.  Returns undefined on success or a stable
 * error code on any invalid field.
 *
 * A malformed accepted ack MUST be caught here so the relay can
 * teardown and reject connect with a stable code instead of throwing.
 */
export function validateRemoteHostHandshakeAck(value: unknown): RemoteHostValidationError | undefined {
	if (!value || typeof value !== "object") {
		return { code: "INVALID_ACK", message: "Not an object" };
	}
	const ack = value as Record<string, unknown>;

	if (ack.type !== "handshake_ack") {
		return { code: "INVALID_ACK_TYPE", message: "Expected handshake_ack" };
	}
	if (typeof ack.accepted !== "boolean") {
		return { code: "INVALID_ACK_ACCEPTED", message: "accepted must be boolean" };
	}
	if (typeof ack.hostId !== "string" || ack.hostId.length === 0 || ack.hostId.length > MAX_ID_LENGTH) {
		return { code: "INVALID_ACK_HOST_ID", message: "hostId must be a non-empty bounded string" };
	}
	if (typeof ack.sessionId !== "string" || ack.sessionId.length === 0 || ack.sessionId.length > MAX_ID_LENGTH) {
		return { code: "INVALID_ACK_SESSION_ID", message: "sessionId must be a bounded string" };
	}
	if (typeof ack.linkId !== "string" || ack.linkId.length === 0 || ack.linkId.length > MAX_ID_LENGTH) {
		return { code: "INVALID_ACK_LINK_ID", message: "linkId must be a non-empty bounded string" };
	}

	// Protocol must have exact numeric fields.
	if (!ack.protocol || typeof ack.protocol !== "object") {
		return { code: "INVALID_ACK_PROTOCOL", message: "protocol is required" };
	}
	const proto = ack.protocol as Record<string, unknown>;
	if (typeof proto.name !== "string" || proto.name.length === 0) {
		return { code: "INVALID_ACK_PROTOCOL_NAME", message: "protocol.name is required" };
	}
	if (typeof proto.version !== "number" || !Number.isInteger(proto.version) || proto.version < 0) {
		return { code: "INVALID_ACK_PROTOCOL_VERSION", message: "protocol.version must be a non-negative integer" };
	}

	// Capabilities must be a bounded array of known strings.
	if (!Array.isArray(ack.capabilities)) {
		return { code: "INVALID_ACK_CAPABILITIES", message: "capabilities must be an array" };
	}
	if (ack.capabilities.length > 50) {
		return { code: "INVALID_ACK_CAPABILITIES_BOUND", message: "capabilities exceeds max count" };
	}
	for (const cap of ack.capabilities) {
		if (typeof cap !== "string" || !KNOWN_CAPABILITIES.has(cap)) {
			return { code: "INVALID_ACK_CAPABILITY", message: "Unknown capability" };
		}
	}

	// Reject unknown fields.
	const allowedKeys = KNOWN_HANDSHAKE_ACK_FIELDS;
	for (const key of Object.keys(ack)) {
		if (!allowedKeys.has(key)) {
			return { code: "INVALID_ACK_UNKNOWN_FIELD", message: `Unknown field` };
		}
	}

	// Optional rejectReason — safe fixed string.
	if (ack.rejectReason !== undefined && typeof ack.rejectReason !== "string") {
		return { code: "INVALID_ACK_REJECT_REASON", message: "rejectReason must be a string" };
	}
	if (ack.rejectReason && typeof ack.rejectReason === "string" && ack.rejectReason.length > MAX_REJECT_REASON_LENGTH) {
		return { code: "INVALID_ACK_REJECT_REASON", message: "rejectReason too long" };
	}

	// Optional cursor — identity + sequence validation.
	if (ack.cursor !== undefined) {
		if (typeof ack.cursor !== "object" || !ack.cursor) {
			return { code: "INVALID_ACK_CURSOR", message: "cursor must be an object" };
		}
		const cursor = ack.cursor as Record<string, unknown>;
		if (typeof cursor.hostId !== "string" || cursor.hostId.length === 0 || cursor.hostId.length > MAX_ID_LENGTH) {
			return { code: "INVALID_ACK_CURSOR_HOST_ID", message: "cursor.hostId must be a bounded string" };
		}
		if (
			typeof cursor.generation !== "string" ||
			cursor.generation.length === 0 ||
			cursor.generation.length > MAX_ID_LENGTH
		) {
			return { code: "INVALID_ACK_CURSOR_GENERATION", message: "cursor.generation must be a bounded string" };
		}
		if (
			typeof cursor.sessionId !== "string" ||
			cursor.sessionId.length === 0 ||
			cursor.sessionId.length > MAX_ID_LENGTH
		) {
			return { code: "INVALID_ACK_CURSOR_SESSION_ID", message: "cursor.sessionId must be a bounded string" };
		}
		if (typeof cursor.sequence !== "number" || !Number.isInteger(cursor.sequence) || cursor.sequence < 0) {
			return { code: "INVALID_ACK_CURSOR_SEQUENCE", message: "cursor.sequence must be a non-negative integer" };
		}
	}

	// remoteBuildIdentity is required when accepted=true (exact-build gate).
	if (ack.accepted === true) {
		if (ack.remoteBuildIdentity === undefined || ack.remoteBuildIdentity === null) {
			return {
				code: "INVALID_ACK_MISSING_BUILD_IDENTITY",
				message: "remoteBuildIdentity required for accepted handshake",
			};
		}
	}

	if (ack.remoteBuildIdentity !== undefined) {
		if (typeof ack.remoteBuildIdentity !== "object" || !ack.remoteBuildIdentity) {
			return { code: "INVALID_ACK_BUILD_IDENTITY", message: "remoteBuildIdentity must be an object" };
		}
		const build = ack.remoteBuildIdentity as Record<string, unknown>;
		if (typeof build.buildId !== "string" || build.buildId.length === 0 || build.buildId.length > MAX_ID_LENGTH) {
			return { code: "INVALID_ACK_BUILD_ID", message: "buildId must be a bounded string" };
		}
		if (
			typeof build.daemonProtocolVersion !== "number" ||
			!Number.isInteger(build.daemonProtocolVersion) ||
			build.daemonProtocolVersion < 0
		) {
			return { code: "INVALID_ACK_BUILD_PROTOCOL", message: "daemonProtocolVersion must be a non-negative integer" };
		}
		if (
			typeof build.daemonSchemaRevision !== "number" ||
			!Number.isInteger(build.daemonSchemaRevision) ||
			build.daemonSchemaRevision < 0
		) {
			return { code: "INVALID_ACK_BUILD_SCHEMA", message: "daemonSchemaRevision must be a non-negative integer" };
		}
	}

	return undefined;
}

export function validateRemoteHostFrame(value: unknown): RemoteHostValidationError | undefined {
	if (!value || typeof value !== "object") {
		return { code: "NOT_AN_OBJECT", message: "Frame must be a non-null object" };
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== "frame") {
		return { code: "INVALID_ENVELOPE_TYPE", message: "Invalid envelope type" };
	}
	if (typeof candidate.frameId !== "string" || candidate.frameId.length === 0) {
		return { code: "MISSING_FRAME_ID", message: "frameId must be a non-empty string" };
	}
	if (!candidate.protocol || typeof candidate.protocol !== "object") {
		return { code: "MISSING_PROTOCOL", message: "protocol is required" };
	}
	const proto = candidate.protocol as Record<string, unknown>;
	if (proto.name !== REMOTE_HOST_PROTOCOL_NAME) {
		return { code: "UNKNOWN_PROTOCOL", message: "Protocol name mismatch" };
	}
	if (typeof proto.version !== "number") {
		return { code: "INVALID_PROTOCOL_VERSION", message: "protocol.version must be a number" };
	}
	if (typeof candidate.sentAt !== "string" || candidate.sentAt.length === 0) {
		return { code: "MISSING_SENT_AT", message: "sentAt is required" };
	}
	if (!candidate.frame || typeof candidate.frame !== "object") {
		return { code: "MISSING_FRAME", message: "frame is required" };
	}
	const frame = candidate.frame as Record<string, unknown>;
	if (typeof frame.type !== "string" || !KNOWN_FRAME_TYPES.has(frame.type)) {
		return { code: "UNKNOWN_FRAME_TYPE", message: "Unknown frame type" };
	}
	return undefined;
}

export function validateRemoteHostHandshake(value: unknown): RemoteHostValidationError | undefined {
	if (!value || typeof value !== "object") {
		return { code: "NOT_AN_OBJECT", message: "Handshake must be a non-null object" };
	}
	const h = value as Record<string, unknown>;
	if (h.type !== "handshake") {
		return { code: "INVALID_TYPE", message: "Invalid handshake type" };
	}
	const validDirections = ["home_to_host", "host_to_home"];
	if (typeof h.direction !== "string" || !validDirections.includes(h.direction)) {
		return { code: "INVALID_DIRECTION", message: "Invalid handshake direction" };
	}
	if (typeof h.hostId !== "string" || h.hostId.length === 0) {
		return { code: "MISSING_HOST_ID", message: "hostId is required" };
	}
	if (typeof h.generation !== "string" || h.generation.length === 0) {
		return { code: "MISSING_GENERATION", message: "generation is required" };
	}
	if (typeof h.runtime !== "object" || !h.runtime) {
		return { code: "MISSING_RUNTIME", message: "runtime identity is required" };
	}
	const runtime = h.runtime as Record<string, unknown>;
	if (typeof runtime.buildId !== "string" || runtime.buildId.length === 0) {
		return { code: "MISSING_BUILD_ID", message: "runtime.buildId is required" };
	}
	if (typeof runtime.daemonProtocolVersion !== "number") {
		return { code: "MISSING_DAEMON_PROTOCOL_VERSION", message: "runtime.daemonProtocolVersion is required" };
	}
	if (typeof runtime.daemonSchemaRevision !== "number") {
		return { code: "MISSING_DAEMON_SCHEMA_REVISION", message: "runtime.daemonSchemaRevision is required" };
	}
	if (!Array.isArray(h.capabilities)) {
		return { code: "MISSING_CAPABILITIES", message: "capabilities must be an array" };
	}
	return undefined;
}

export function isRemoteHostEventSequenceAfter(a: RemoteHostEventSequence, b: RemoteHostEventSequence): boolean {
	return a > b;
}

export function isRemoteHostEventSequenceBefore(a: RemoteHostEventSequence, b: RemoteHostEventSequence): boolean {
	return a < b;
}

export function isRemoteHostEventSequenceGap(last: RemoteHostEventSequence, next: RemoteHostEventSequence): boolean {
	return next > last + 1;
}
