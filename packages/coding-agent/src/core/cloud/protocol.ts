import { createHash, randomUUID } from "node:crypto";

/**
 * Bounded JSON session protocol for a directly driven cloud agent session.
 *
 * A gateway owns one stable session and exchanges validated JSON frames with a
 * remote client (and the session executor) over any reliable transport:
 *
 * - hello        client -> gateway: attach to a pre-allocated session.
 * - snapshot     gateway -> client: bounded session state plus an event tail;
 *                also the catch-up answer to subscribe.
 * - events       gateway -> client: live ordered events after a subscribe,
 *                pushed in bounded batches as they are recorded.
 * - subscribe    client -> gateway: request every event after a cursor.
 * - submit       client -> gateway: idempotent command submission; the
 *                response is a command receipt frame.
 * - get_command  client -> gateway: poll one command receipt, or executor ->
 *                gateway: claim the next dispatchable command; the response
 *                is a command receipt frame.
 * - command      gateway -> client/executor: command receipt, the response to
 *                submit and get_command; an executor state report carries the
 *                updated receipt, and a claim handoff adds the request payload.
 * - ack          client -> gateway: acknowledge durably imported events by
 *                advancing the cursor; the gateway may only trim through it.
 *
 * Sessions are allocated before any compute and never created by hello: a
 * hello always attaches to a known sessionId. Every client->gateway frame
 * states the event-log generation the sender last observed - hello, submit,
 * and get_command carry it explicitly, subscribe and ack inside their cursor -
 * and every command frame stamps one; a stale generation means the attachment
 * predates a log rewrite, and the gateway fences it off instead of applying it.
 *
 * The protocol version is negotiated once in hello; frames carry no version.
 * Transport-level failures (version mismatch, malformed or oversized frames)
 * close the stream and are not protocol messages.
 */

export const CLOUD_PROTOCOL_NAME = "prime-agent.cloud";
// Version 3 adds the cross-boundary family surface: `family_roster_request` /
// `agent_message_request` events (guest -> local), `family_roster_result` /
// `agent_message_result` commands (local -> guest), optional addressing fields
// on `prompt` / `send_message` / `extension_ui_response`, and an optional
// terminal `result` payload on command receipts. Hello still requires an
// exact version match, so a mixed-version pair refuses attachment instead of
// half-interoperating; the guest bridge is uploaded lockstep with the local
// build, so only a transiently stale sandbox ever sees the refusal.
export const CLOUD_PROTOCOL_VERSION = 3;

export const CLOUD_MAX_MESSAGE_BYTES = 1_048_576;
export const CLOUD_MAX_JSON_DEPTH = 64;
export const CLOUD_MAX_ID_CHARS = 128;
export const CLOUD_MAX_PROMPT_CHARS = 65_536;
export const CLOUD_MAX_REQUEST_JSON_CHARS = 131_072;
export const CLOUD_MAX_ERROR_CHARS = 2_048;
export const CLOUD_MAX_TIMESTAMP_CHARS = 64;
export const CLOUD_MAX_PATH_CHARS = 4_096;
export const CLOUD_MAX_MODEL_ID_CHARS = 256;
export const CLOUD_MAX_CAPABILITIES = 16;
export const CLOUD_MAX_QUEUED_COMMANDS = 64;
export const CLOUD_MAX_SNAPSHOT_EVENTS = 256;
export const CLOUD_MAX_TOKEN_CHARS = 256;
export const CLOUD_MAX_OUTPUT_CHARS = 65_536;
/** Session-file entries larger than this bound travel as artifact refs, never inline. */
export const CLOUD_MAX_INLINE_ENTRY_BYTES = 262_144;
/** Bound on one ephemeral session_event frame's encoded JSON. */
export const CLOUD_MAX_SESSION_EVENT_BYTES = 131_072;
/** Bound on one inline session_entry's encoded JSON. */
export const CLOUD_MAX_ENTRY_JSON_CHARS = 262_144;
export const CLOUD_MAX_THINKING_CHARS = 64;
export const CLOUD_MAX_SESSION_NAME_CHARS = 128;
export const CLOUD_MAX_EXTENSION_RESPONSE_CHARS = 8_192;
export const CLOUD_MAX_META_CHARS = 4_096;
export const CLOUD_MAX_PREVIEW_CHARS = 4_096;
export const CLOUD_MAX_ROSTER_ROWS = 256;
export const CLOUD_MAX_ARTIFACT_REFS = 32;
export const CLOUD_MAX_CHILDREN = 512;
/** Bound on one remote-family roster batch (family_roster_result / roster requests). */
export const CLOUD_MAX_FAMILY_ROWS = 64;
/** Bound on the terminal receipt `result` payload (canonical JSON string). */
export const CLOUD_MAX_RECEIPT_RESULT_CHARS = 2048;
/** Bound on an agent-message request id and a remote target selector. */
export const CLOUD_MAX_SELECTOR_CHARS = 128;

export type CloudSessionId = string;
export type CloudClientId = string;
export type CloudCommandId = string;

export const CLOUD_CAPABILITIES = [
	"event_stream",
	"command_receipts",
	"session_entries",
	"session_events",
	"roster_stream",
	"family_messages",
	"extension_ui",
	"artifact_refs",
] as const;
export type CloudCapability = (typeof CLOUD_CAPABILITIES)[number];

export const CLOUD_SESSION_STATUSES = ["starting", "idle", "busy", "stopping", "stopped", "failed"] as const;
export type CloudSessionStatus = (typeof CLOUD_SESSION_STATUSES)[number];

export const CLOUD_COMMAND_STATES = ["accepted", "running", "completed", "failed", "cancelled"] as const;
export type CloudCommandState = (typeof CLOUD_COMMAND_STATES)[number];

export function isTerminalCloudCommandState(state: CloudCommandState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

export function isCloudCommandState(value: string): value is CloudCommandState {
	return (CLOUD_COMMAND_STATES as readonly string[]).includes(value);
}

export interface CloudCursor {
	/** Event-log epoch; bumped whenever the log is rewritten, so stale cursors resnapshot. */
	generation: number;
	/** Last event sequence the holder consumed; 0 means nothing yet. */
	sequence: number;
}

/** A validated cursor. */
export function cloudCursor(generation: number, sequence: number): CloudCursor {
	if (!Number.isInteger(generation) || generation < 1) {
		throw new Error("cursor generation must be an integer of at least 1");
	}
	if (!Number.isInteger(sequence) || sequence < 0) {
		throw new Error("cursor sequence must be an integer of at least 0");
	}
	return { generation, sequence };
}

export function advanceCursor(cursor: CloudCursor): CloudCursor {
	return cloudCursor(cursor.generation, cursor.sequence + 1);
}

/** Cursors are comparable only inside one generation; a gap forces a resnapshot. */
export function cursorAtOrBefore(earlier: CloudCursor, later: CloudCursor): boolean {
	if (earlier.generation !== later.generation) {
		throw new Error(`cursors from generations ${earlier.generation} and ${later.generation} are not comparable`);
	}
	return earlier.sequence <= later.sequence;
}

export function newCloudClientId(): CloudClientId {
	return `client_${randomUUID()}`;
}

export function newCloudCommandId(): CloudCommandId {
	return `cmd_${randomUUID()}`;
}

export function newCloudSessionId(): CloudSessionId {
	return `sess_${randomUUID()}`;
}

export type CloudTaskId = string;

export function newCloudTaskId(): CloudTaskId {
	return `task_${randomUUID()}`;
}

/**
 * Session operations for a resident guest session (protocol v2). v1's task
 * verbs (start_task / steer+taskId / cancel_task) are gone: the guest hosts a
 * real resident session, so every operation maps onto the ordinary agent-loop
 * semantics. Requests stay digest-checked, journaled, and idempotent by
 * commandId.
 */
/** Cross-boundary family context for a spawned cloud child, passed at open. */
export interface CloudFamilyInfo {
	/** The cloud child's depth under its LOCAL parent (guest-relative root is 0). */
	depth: number;
	/** Durable local parent session id. */
	parentSessionId: string;
	/** Canonical local parent session file (family catalog linkage). */
	parentSessionFile: string;
	parentName?: string;
}

/** The sender endpoint carried on a cross-boundary agent message. */
export interface CloudAgentMessageSender {
	activeSessionId?: string;
	sessionId?: string;
	sessionName?: string;
	runtimeKind?: "top-level" | "subagent";
}

export type CloudFamilyRelationship = "parent" | "sibling" | "child";

export type CloudCommandRequest =
	| {
			kind: "open_session";
			cwd: string;
			model?: string;
			thinking?: string;
			seedTranscriptArtifact?: string;
			prompt?: string;
			/** v3: family context for a spawned child (absolute depth + local parent). */
			family?: CloudFamilyInfo;
	  }
	/** v3: `targetSessionId` addresses one remote descendant session. */
	| { kind: "prompt"; text: string; queueIfBusy?: boolean; targetSessionId?: string }
	| { kind: "steer"; text: string }
	| { kind: "follow_up"; text: string }
	| { kind: "abort" }
	| {
			kind: "send_message";
			targetRemoteSessionId: string;
			message: string;
			/** v3: the sender-chosen message id, mirrored into the guest's custom entry. */
			messageId?: string;
			/** v3: sender endpoint for the guest's agent-message custom entry. */
			from?: CloudAgentMessageSender;
			/** v3: relationship from the receiver's point of view. */
			fromRelationship?: CloudFamilyRelationship;
	  }
	| { kind: "set_model"; provider: string; modelId: string }
	| { kind: "set_thinking_level"; level: string }
	| { kind: "set_session_name"; name: string }
	| { kind: "compact"; customInstructions?: string }
	| { kind: "cancel_child"; childId: string }
	| { kind: "delete_child"; childId: string }
	| {
			kind: "extension_ui_response";
			requestId: string;
			response: unknown;
			/** v3: the remote session that owns the pending request. */
			targetSessionId?: string;
	  }
	| { kind: "release" }
	/** v3: answer to a guest `family_roster_request`. */
	| { kind: "family_roster_result"; requestId: string; entries: CloudFamilyRow[] }
	/** v3: answer to a guest `agent_message_request` (receipt after admission). */
	| {
			kind: "agent_message_result";
			requestId: string;
			ok: boolean;
			/** Canonical `AgentSessionMessageReceipt` JSON when ok. */
			receipt?: Record<string, unknown>;
			error?: string;
	  };

export const CLOUD_COMMAND_KINDS = [
	"open_session",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"send_message",
	"set_model",
	"set_thinking_level",
	"set_session_name",
	"compact",
	"cancel_child",
	"delete_child",
	"extension_ui_response",
	"release",
	"family_roster_result",
	"agent_message_result",
] as const;

export type CloudCommandKind = (typeof CLOUD_COMMAND_KINDS)[number];

export interface CloudCommandReceipt {
	commandId: CloudCommandId;
	/** SHA-256 digest of the admitted request's canonical JSON. */
	digest: string;
	state: CloudCommandState;
	submittedAt: string;
	updatedAt: string;
	/** True when the journal restored this command without a terminal record. */
	uncertain: boolean;
	error?: string;
	/**
	 * v3: terminal result payload (canonical JSON string), e.g. the delivery
	 * status of a cross-boundary agent message. Absent on pre-v3 records and
	 * on commands that produce no payload.
	 */
	result?: string;
}

/** One artifact reference for an oversized session entry payload (artifact_refs capability). */
export interface CloudArtifactRef {
	/** Guest-local path (or artifact id) the mirror can pull through the gateway. */
	path: string;
	sha256: string;
	bytes: number;
}

/** One remote descendant row in a roster_delta event. */
export interface CloudRosterRow {
	childId: string;
	parentRemoteId?: string;
	name?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	depth: number;
	preview?: string;
}

/**
 * One cross-boundary family row (v3): a cloud row's own entry, its parent, or
 * a sibling, as the local supervisor sees it. Depths are absolute (spawn depth
 * shifted); parent linkage uses the same session-id/session-path edges the
 * local family catalog builds on.
 */
export interface CloudFamilyRow {
	/** Session id (cloud session id, remote session id, or local session id). */
	id: string;
	name?: string;
	depth: number;
	status: "running" | "idle" | "inactive";
	parentSessionId?: string;
	parentSessionPath?: string;
	/** Canonical session file (local sessions and cloud shadows). */
	sessionPath?: string;
}

export type CloudEvent =
	| { sequence: number; kind: "command_accepted"; recordedAt: string; receipt: CloudCommandReceipt }
	| { sequence: number; kind: "command_state"; recordedAt: string; receipt: CloudCommandReceipt }
	| { sequence: number; kind: "session_status"; recordedAt: string; status: CloudSessionStatus }
	| {
			sequence: number;
			kind: "output_delta";
			recordedAt: string;
			taskId: CloudTaskId;
			stream: "stdout" | "stderr";
			/** Bounded live output fragment; the guest batches and caps it. */
			text: string;
	  }
	/** Durable mirror of one guest session-file entry (session_entries capability). */
	| {
			sequence: number;
			kind: "session_entry";
			recordedAt: string;
			/** Remote session id (the guest's session id), not a CloudSessionId. */
			sessionId: string;
			entryId: string;
			/** Canonical session-file entry JSON; bounded by CLOUD_MAX_INLINE_ENTRY_BYTES. */
			entry: Record<string, unknown>;
			/** Artifact refs for payloads stored outside the entry (artifact_refs capability). */
			artifacts?: CloudArtifactRef[];
	  }
	/** Ephemeral live session event frame (session_events capability). */
	| {
			sequence: number;
			kind: "session_event";
			recordedAt: string;
			sessionId: string;
			/** AgentConnectionSessionEvent JSON, bounded by CLOUD_MAX_SESSION_EVENT_BYTES. */
			event: Record<string, unknown>;
	  }
	/** Latest session metadata snapshot (session_events capability). */
	| {
			sequence: number;
			kind: "session_meta";
			recordedAt: string;
			sessionId: string;
			streaming: boolean;
			runningTools: number;
			queue: number;
			recap?: string;
			taskState?: "needs_input" | "completed";
			model?: string;
			connectivityHints?: string[];
	  }
	/** Remote descendant roster rows (roster_stream capability). */
	| {
			sequence: number;
			kind: "roster_delta";
			recordedAt: string;
			rows: CloudRosterRow[];
	  }
	/** One remote child run transition (roster_stream capability). */
	| {
			sequence: number;
			kind: "child_update";
			recordedAt: string;
			childId: string;
			status: "queued" | "running" | "completed" | "failed" | "cancelled";
			answerPreview?: string;
			sessionFile?: string;
			model?: string;
	  }
	/** Token totals for one remote session (session_events capability). */
	| {
			sequence: number;
			kind: "usage";
			recordedAt: string;
			sessionId: string;
			totals: { inputTokens: number; outputTokens: number; cachedTokens?: number; requests: number };
			revision: number;
	  }
	/** v3: the guest asks for its cross-boundary family rows (family_messages). */
	| {
			sequence: number;
			kind: "family_roster_request";
			recordedAt: string;
			requestId: string;
			/** The requesting remote session id (cloud root or descendant). */
			fromRemoteSessionId: string;
	  }
	/** v3: a guest session sends one agent message across the boundary (family_messages). */
	| {
			sequence: number;
			kind: "agent_message_request";
			recordedAt: string;
			requestId: string;
			fromRemoteSessionId: string;
			/** Target selector: session id, active session id, or session name. */
			targetSelector: string;
			message: string;
	  };

export interface CloudSessionState {
	cwd: string;
	modelId: string;
	/** Command currently claimed by the executor. */
	activeCommandId?: CloudCommandId;
	/** Admitted commands waiting to be claimed, oldest first. */
	queuedCommandIds: readonly CloudCommandId[];
}

export interface CloudHello {
	type: "hello";
	protocolVersion: number;
	/** Event-log generation the client last observed; stale attachments are fenced off. */
	generation: number;
	clientId: CloudClientId;
	/** Pre-allocated session to attach; sessions are never created by hello. */
	sessionId: CloudSessionId;
	/**
	 * Protocol authentication secret for transports that terminate outside the
	 * trusted VM boundary (e.g. a public tunnel edge). Loopback transports may
	 * omit it; a tunnel bridge always requires it.
	 */
	authToken?: string;
	/** The client's last consumed position; its generation must match generation. */
	cursor?: CloudCursor;
	capabilities?: readonly CloudCapability[];
}

export interface CloudSnapshot {
	type: "snapshot";
	sessionId: CloudSessionId;
	/** Event-log epoch this tail belongs to. */
	generation: number;
	/** Position covered by this snapshot; equals the last event sequence. */
	cursor: CloudCursor;
	status: CloudSessionStatus;
	state: CloudSessionState;
	/** Bounded tail of events after the client's cursor. */
	events: readonly CloudEvent[];
	/** Capabilities this gateway supports; absent means the v1 event stream only. */
	capabilities?: readonly CloudCapability[];
}

export interface CloudSubscribe {
	type: "subscribe";
	sessionId: CloudSessionId;
	cursor: CloudCursor;
}

/** Live ordered events pushed after a subscribe; bounded batches. */
export interface CloudEvents {
	type: "events";
	sessionId: CloudSessionId;
	/** Event-log epoch the batch belongs to. */
	generation: number;
	events: readonly CloudEvent[];
}

export interface CloudSubmit {
	type: "submit";
	sessionId: CloudSessionId;
	/** Event-log generation the client last observed; stale attachments are fenced off. */
	generation: number;
	/** Client-chosen id; retries reuse it to stay idempotent. */
	commandId: CloudCommandId;
	request: CloudCommandRequest;
	/** Must equal cloudRequestDigest(request); validated on receipt. */
	digest: string;
}

export interface CloudGetCommand {
	type: "get_command";
	sessionId: CloudSessionId;
	/** Event-log generation the sender last observed; stale attachments are fenced off. */
	generation: number;
	/** Read-only receipt poll for one command. */
	commandId?: CloudCommandId;
	/** Executor claim of the next dispatchable command. */
	claim?: boolean;
}

export interface CloudCommand {
	type: "command";
	sessionId: CloudSessionId;
	/** Event-log generation the receipt belongs to; stamps every command frame. */
	generation: number;
	receipt: CloudCommandReceipt;
	/** Canonical JSON of the claimed command's request, present only on a claim handoff. */
	request?: string;
}

export interface CloudAck {
	type: "ack";
	sessionId: CloudSessionId;
	/** Durable imported-event position; the gateway may trim only through it. */
	cursor: CloudCursor;
}

export type CloudMessage =
	| CloudHello
	| CloudSnapshot
	| CloudSubscribe
	| CloudEvents
	| CloudSubmit
	| CloudGetCommand
	| CloudCommand
	| CloudAck;

/**
 * Deterministic JSON: recursively sorted keys, no whitespace, plain objects
 * only, no undefined/functions/symbols/bigints, finite numbers. Two
 * deep-equal values always serialize to the same bytes, so digests are stable
 * across processes and key order never matters.
 */
export function canonicalJson(value: unknown): string {
	return canonicalizeValue(value, 0);
}

function canonicalizeValue(value: unknown, depth: number): string {
	if (depth > CLOUD_MAX_JSON_DEPTH) {
		throw new Error(`canonical JSON depth exceeds ${CLOUD_MAX_JSON_DEPTH}`);
	}
	switch (typeof value) {
		case "object": {
			if (value === null) {
				return "null";
			}
			if (Array.isArray(value)) {
				return `[${value.map((item) => canonicalizeValue(item, depth + 1)).join(",")}]`;
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new Error("canonical JSON accepts only plain objects, arrays, and primitives");
			}
			const record = value as Record<string, unknown>;
			const parts: string[] = [];
			for (const key of Object.keys(record).sort()) {
				parts.push(`${JSON.stringify(key)}:${canonicalizeValue(record[key], depth + 1)}`);
			}
			return `{${parts.join(",")}}`;
		}
		case "string":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) {
				throw new Error("canonical JSON accepts only finite numbers");
			}
			return Object.is(value, -0) ? "0" : `${value}`;
		case "boolean":
			return value ? "true" : "false";
		default:
			throw new Error(`canonical JSON does not accept ${typeof value} values`);
	}
}

const CLOUD_REQUEST_DIGEST_DOMAIN = `${CLOUD_PROTOCOL_NAME}.request.v1`;

/** SHA-256 over canonical JSON, domain-separated so digests cannot cross protocols. */
export function cloudDigest(canonical: string): string {
	return `sha256:${createHash("sha256")
		.update(CLOUD_REQUEST_DIGEST_DOMAIN)
		.update("\0")
		.update(canonical)
		.digest("hex")}`;
}

export function cloudRequestDigest(request: CloudCommandRequest): string {
	return cloudDigest(canonicalJson(request));
}

export function isCloudDigest(value: string): boolean {
	return /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Runtime validation for a stable protocol id (session, client, or command). */
export function cloudIdProblem(value: unknown, label = "id"): string | undefined {
	if (typeof value !== "string" || value.length < 1 || value.length > CLOUD_MAX_ID_CHARS) {
		return `${label} must be a non-empty string of at most ${CLOUD_MAX_ID_CHARS} characters`;
	}
	return undefined;
}

/** Runtime validation for a submit request payload. */
export function cloudRequestProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "request must be a JSON object";
	}
	const kindProblem = expectOneOf(value.kind, "request.kind", CLOUD_COMMAND_KINDS);
	if (kindProblem !== undefined) {
		return kindProblem;
	}
	switch (value.kind) {
		case "open_session":
			return firstProblem(
				expectFields(value, ["kind", "cwd", "model", "thinking", "seedTranscriptArtifact", "prompt", "family"]),
				expectString(value.cwd, "request.cwd", CLOUD_MAX_PATH_CHARS, 1),
				optionalString(value.model, "request.model", CLOUD_MAX_MODEL_ID_CHARS),
				optionalString(value.thinking, "request.thinking", CLOUD_MAX_THINKING_CHARS),
				optionalString(value.seedTranscriptArtifact, "request.seedTranscriptArtifact", CLOUD_MAX_PATH_CHARS),
				optionalString(value.prompt, "request.prompt", CLOUD_MAX_PROMPT_CHARS),
				familyInfoProblem(value.family, "request.family"),
			);
		case "prompt":
			return firstProblem(
				expectFields(value, ["kind", "text", "queueIfBusy", "targetSessionId"]),
				expectString(value.text, "request.text", CLOUD_MAX_PROMPT_CHARS, 1),
				optionalBoolean(value.queueIfBusy, "request.queueIfBusy"),
				optionalString(value.targetSessionId, "request.targetSessionId", CLOUD_MAX_ID_CHARS),
			);
		case "steer":
		case "follow_up":
			return firstProblem(
				expectFields(value, ["kind", "text"]),
				expectString(value.text, "request.text", CLOUD_MAX_PROMPT_CHARS, 1),
			);
		case "abort":
		case "release":
			return expectFields(value, ["kind"]);
		case "send_message":
			return firstProblem(
				expectFields(value, ["kind", "targetRemoteSessionId", "message", "messageId", "from", "fromRelationship"]),
				expectString(value.targetRemoteSessionId, "request.targetRemoteSessionId", CLOUD_MAX_ID_CHARS, 1),
				expectString(value.message, "request.message", CLOUD_MAX_PROMPT_CHARS, 1),
				optionalString(value.messageId, "request.messageId", CLOUD_MAX_ID_CHARS),
				agentMessageSenderProblem(value.from, "request.from"),
				value.fromRelationship === undefined
					? undefined
					: expectOneOf(value.fromRelationship, "request.fromRelationship", ["parent", "sibling", "child"]),
			);
		case "set_model":
			return firstProblem(
				expectFields(value, ["kind", "provider", "modelId"]),
				expectString(value.provider, "request.provider", CLOUD_MAX_MODEL_ID_CHARS, 1),
				expectString(value.modelId, "request.modelId", CLOUD_MAX_MODEL_ID_CHARS, 1),
			);
		case "set_thinking_level":
			return firstProblem(
				expectFields(value, ["kind", "level"]),
				expectString(value.level, "request.level", CLOUD_MAX_THINKING_CHARS, 1),
			);
		case "set_session_name":
			return firstProblem(
				expectFields(value, ["kind", "name"]),
				expectString(value.name, "request.name", CLOUD_MAX_SESSION_NAME_CHARS, 1),
			);
		case "compact":
			return firstProblem(
				expectFields(value, ["kind", "customInstructions"]),
				optionalString(value.customInstructions, "request.customInstructions", CLOUD_MAX_PROMPT_CHARS),
			);
		case "cancel_child":
		case "delete_child":
			return firstProblem(
				expectFields(value, ["kind", "childId"]),
				expectString(value.childId, "request.childId", CLOUD_MAX_ID_CHARS, 1),
			);
		case "extension_ui_response": {
			const base = firstProblem(
				expectFields(value, ["kind", "requestId", "response", "targetSessionId"]),
				expectString(value.requestId, "request.requestId", CLOUD_MAX_ID_CHARS, 1),
				optionalString(value.targetSessionId, "request.targetSessionId", CLOUD_MAX_ID_CHARS),
			);
			if (base !== undefined) return base;
			if (value.response === undefined) return "request.response is required";
			try {
				const encoded = canonicalJson(value.response);
				if (Buffer.byteLength(encoded, "utf8") > CLOUD_MAX_EXTENSION_RESPONSE_CHARS) {
					return `request.response exceeds ${CLOUD_MAX_EXTENSION_RESPONSE_CHARS} bytes`;
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return `request.response is not canonical JSON: ${reason}`;
			}
			return undefined;
		}
		case "family_roster_result": {
			const base = firstProblem(
				expectFields(value, ["kind", "requestId", "entries"]),
				expectString(value.requestId, "request.requestId", CLOUD_MAX_ID_CHARS, 1),
			);
			if (base !== undefined) return base;
			return familyRowsProblem(value.entries, "request.entries");
		}
		case "agent_message_result": {
			const base = firstProblem(
				expectFields(value, ["kind", "requestId", "ok", "receipt", "error"]),
				expectString(value.requestId, "request.requestId", CLOUD_MAX_ID_CHARS, 1),
				typeof value.ok === "boolean" ? undefined : "request.ok must be a boolean",
				optionalString(value.error, "request.error", CLOUD_MAX_ERROR_CHARS),
			);
			if (base !== undefined) return base;
			if (value.ok === true && value.receipt === undefined) {
				return "request.receipt is required when ok is true";
			}
			if (value.ok === false && value.receipt !== undefined) {
				return "request.receipt must be omitted when ok is false";
			}
			if (value.receipt === undefined) return undefined;
			if (!isRecord(value.receipt)) return "request.receipt must be a JSON object";
			try {
				const encoded = canonicalJson(value.receipt);
				if (Buffer.byteLength(encoded, "utf8") > CLOUD_MAX_RECEIPT_RESULT_CHARS) {
					return `request.receipt exceeds ${CLOUD_MAX_RECEIPT_RESULT_CHARS} bytes`;
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return `request.receipt is not canonical JSON: ${reason}`;
			}
			return undefined;
		}
		default:
			return `request.kind must be one of ${CLOUD_COMMAND_KINDS.join(", ")}`;
	}
}

/** Validation for the optional open_session family context. */
function familyInfoProblem(value: unknown, label: string): Problem {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return `${label} must be an object`;
	const depthProblem =
		typeof value.depth === "number" && Number.isInteger(value.depth) && value.depth >= 1
			? undefined
			: `${label}.depth must be an integer of at least 1`;
	return firstProblem(
		expectFields(value, ["depth", "parentSessionId", "parentSessionFile", "parentName"]),
		depthProblem,
		expectString(value.parentSessionId, `${label}.parentSessionId`, CLOUD_MAX_ID_CHARS, 1),
		expectString(value.parentSessionFile, `${label}.parentSessionFile`, CLOUD_MAX_PATH_CHARS, 1),
		optionalString(value.parentName, `${label}.parentName`, CLOUD_MAX_SESSION_NAME_CHARS),
	);
}

/** Validation for the optional send_message sender endpoint. */
function agentMessageSenderProblem(value: unknown, label: string): Problem {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return `${label} must be an object`;
	return firstProblem(
		expectFields(value, ["activeSessionId", "sessionId", "sessionName", "runtimeKind"]),
		optionalString(value.activeSessionId, `${label}.activeSessionId`, CLOUD_MAX_ID_CHARS),
		optionalString(value.sessionId, `${label}.sessionId`, CLOUD_MAX_ID_CHARS),
		optionalString(value.sessionName, `${label}.sessionName`, CLOUD_MAX_SESSION_NAME_CHARS),
		value.runtimeKind === undefined
			? undefined
			: expectOneOf(value.runtimeKind, `${label}.runtimeKind`, ["top-level", "subagent"]),
	);
}

/** Validation for a cross-boundary family row batch. */
function familyRowsProblem(value: unknown, label: string): Problem {
	if (!Array.isArray(value)) return `${label} must be an array`;
	if (value.length > CLOUD_MAX_FAMILY_ROWS) {
		return `${label} must hold at most ${CLOUD_MAX_FAMILY_ROWS} entries`;
	}
	for (let index = 0; index < value.length; index++) {
		const row = value[index];
		if (!isRecord(row)) return `${label}[${index}] must be an object`;
		const problem = firstProblem(
			expectFields(row, ["id", "name", "depth", "status", "parentSessionId", "parentSessionPath", "sessionPath"]),
			expectString(row.id, `${label}[${index}].id`, CLOUD_MAX_ID_CHARS, 1),
			expectInteger(row.depth, `${label}[${index}].depth`, 0),
			expectOneOf(row.status, `${label}[${index}].status`, ["running", "idle", "inactive"]),
			optionalString(row.name, `${label}[${index}].name`, CLOUD_MAX_SESSION_NAME_CHARS),
			optionalString(row.parentSessionId, `${label}[${index}].parentSessionId`, CLOUD_MAX_ID_CHARS),
			optionalString(row.parentSessionPath, `${label}[${index}].parentSessionPath`, CLOUD_MAX_PATH_CHARS),
			optionalString(row.sessionPath, `${label}[${index}].sessionPath`, CLOUD_MAX_PATH_CHARS),
		);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

/** Maximum encoded bytes of one canonical request payload; enforced alongside digests. */
export function cloudRequestJsonProblem(request: CloudCommandRequest): string | undefined {
	try {
		const encoded = canonicalJson(request);
		if (Buffer.byteLength(encoded, "utf8") > CLOUD_MAX_REQUEST_JSON_CHARS) {
			return `request exceeds ${CLOUD_MAX_REQUEST_JSON_CHARS} bytes`;
		}
		return undefined;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `request is not canonical JSON: ${reason}`;
	}
}

function cursorProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ["generation", "sequence"]),
		expectInteger(value.generation, `${label}.generation`, 1),
		expectInteger(value.sequence, `${label}.sequence`, 0),
	);
}

function capabilitiesProblem(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return `${label} must be an array`;
	}
	if (value.length > CLOUD_MAX_CAPABILITIES) {
		return `${label} must hold at most ${CLOUD_MAX_CAPABILITIES} entries`;
	}
	for (const entry of value) {
		const problem = expectOneOf(entry, `${label} entry`, CLOUD_CAPABILITIES);
		if (problem !== undefined) {
			return problem;
		}
	}
	return undefined;
}

function receiptProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	return firstProblem(
		expectFields(value, ["commandId", "digest", "state", "submittedAt", "updatedAt", "uncertain", "error", "result"]),
		cloudIdProblem(value.commandId, `${label}.commandId`),
		expectDigest(value.digest, `${label}.digest`),
		expectOneOf(value.state, `${label}.state`, CLOUD_COMMAND_STATES),
		expectString(value.submittedAt, `${label}.submittedAt`, CLOUD_MAX_TIMESTAMP_CHARS),
		expectString(value.updatedAt, `${label}.updatedAt`, CLOUD_MAX_TIMESTAMP_CHARS),
		typeof value.uncertain === "boolean" ? undefined : `${label}.uncertain must be a boolean`,
		value.error === undefined ? undefined : expectString(value.error, `${label}.error`, CLOUD_MAX_ERROR_CHARS),
		optionalString(value.result, `${label}.result`, CLOUD_MAX_RECEIPT_RESULT_CHARS),
	);
}

/** Runtime validation for one CloudEvent; undefined means the value is valid. */
export function cloudEventProblem(value: unknown, label = "event"): string | undefined {
	return eventProblem(value, label);
}

function eventProblem(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) {
		return `${label} must be an object`;
	}
	const base = firstProblem(
		expectInteger(value.sequence, `${label}.sequence`, 1),
		expectString(value.recordedAt, `${label}.recordedAt`, CLOUD_MAX_TIMESTAMP_CHARS),
	);
	if (base !== undefined) {
		return base;
	}
	const kindProblem = expectOneOf(value.kind, `${label}.kind`, [
		"command_accepted",
		"command_state",
		"session_status",
		"output_delta",
		"session_entry",
		"session_event",
		"session_meta",
		"roster_delta",
		"child_update",
		"usage",
		"family_roster_request",
		"agent_message_request",
	]);
	if (kindProblem !== undefined) {
		return kindProblem;
	}
	if (value.kind === "session_status") {
		return firstProblem(
			expectFields(value, ["sequence", "kind", "recordedAt", "status"]),
			expectOneOf(value.status, `${label}.status`, CLOUD_SESSION_STATUSES),
		);
	}
	if (value.kind === "output_delta") {
		return firstProblem(
			expectFields(value, ["sequence", "kind", "recordedAt", "taskId", "stream", "text"]),
			cloudIdProblem(value.taskId, `${label}.taskId`),
			expectOneOf(value.stream, `${label}.stream`, ["stdout", "stderr"]),
			expectString(value.text, `${label}.text`, CLOUD_MAX_OUTPUT_CHARS, 0),
		);
	}
	if (value.kind === "session_entry") {
		return sessionEntryProblem(value, label);
	}
	if (value.kind === "session_event") {
		return sessionEventProblem(value, label);
	}
	if (value.kind === "session_meta") {
		return sessionMetaProblem(value, label);
	}
	if (value.kind === "roster_delta") {
		return rosterDeltaProblem(value, label);
	}
	if (value.kind === "child_update") {
		return childUpdateProblem(value, label);
	}
	if (value.kind === "usage") {
		return usageProblem(value, label);
	}
	if (value.kind === "family_roster_request") {
		return firstProblem(
			expectFields(value, ["sequence", "kind", "recordedAt", "requestId", "fromRemoteSessionId"]),
			expectString(value.requestId, `${label}.requestId`, CLOUD_MAX_ID_CHARS, 1),
			expectString(value.fromRemoteSessionId, `${label}.fromRemoteSessionId`, CLOUD_MAX_ID_CHARS, 1),
		);
	}
	if (value.kind === "agent_message_request") {
		return firstProblem(
			expectFields(value, [
				"sequence",
				"kind",
				"recordedAt",
				"requestId",
				"fromRemoteSessionId",
				"targetSelector",
				"message",
			]),
			expectString(value.requestId, `${label}.requestId`, CLOUD_MAX_ID_CHARS, 1),
			expectString(value.fromRemoteSessionId, `${label}.fromRemoteSessionId`, CLOUD_MAX_ID_CHARS, 1),
			expectString(value.targetSelector, `${label}.targetSelector`, CLOUD_MAX_SELECTOR_CHARS, 1),
			expectString(value.message, `${label}.message`, CLOUD_MAX_PROMPT_CHARS, 1),
		);
	}
	return firstProblem(
		expectFields(value, ["sequence", "kind", "recordedAt", "receipt"]),
		receiptProblem(value.receipt, `${label}.receipt`),
	);
}

function artifactRefsProblem(value: unknown, label: string): Problem {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return `${label} must be an array`;
	if (value.length > CLOUD_MAX_ARTIFACT_REFS) {
		return `${label} must hold at most ${CLOUD_MAX_ARTIFACT_REFS} entries`;
	}
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		if (!isRecord(entry)) return `${label}[${index}] must be an object`;
		const problem = firstProblem(
			expectFields(entry, ["path", "sha256", "bytes"]),
			expectString(entry.path, `${label}[${index}].path`, CLOUD_MAX_PATH_CHARS, 1),
			expectDigest(entry.sha256, `${label}[${index}].sha256`),
			expectInteger(entry.bytes, `${label}[${index}].bytes`, 0),
		);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

function sessionEntryProblem(value: Record<string, unknown>, label: string): Problem {
	const base = firstProblem(
		expectFields(value, ["sequence", "kind", "recordedAt", "sessionId", "entryId", "entry", "artifacts"]),
		expectString(value.sessionId, `${label}.sessionId`, CLOUD_MAX_ID_CHARS, 1),
		expectString(value.entryId, `${label}.entryId`, CLOUD_MAX_ID_CHARS, 1),
		artifactRefsProblem(value.artifacts, `${label}.artifacts`),
	);
	if (base !== undefined) return base;
	if (!isRecord(value.entry)) return `${label}.entry must be a JSON object`;
	const entry = value.entry;
	const entryProblem = firstProblem(
		expectString(entry.type, `${label}.entry.type`, 128, 1),
		expectString(entry.id, `${label}.entry.id`, CLOUD_MAX_ID_CHARS, 1),
		entry.parentId === undefined || entry.parentId === null
			? undefined
			: expectString(entry.parentId, `${label}.entry.parentId`, CLOUD_MAX_ID_CHARS),
		expectString(entry.timestamp, `${label}.entry.timestamp`, CLOUD_MAX_TIMESTAMP_CHARS, 1),
	);
	if (entryProblem !== undefined) return entryProblem;
	try {
		const encoded = canonicalJson(entry);
		if (Buffer.byteLength(encoded, "utf8") > CLOUD_MAX_ENTRY_JSON_CHARS) {
			return `${label}.entry exceeds ${CLOUD_MAX_ENTRY_JSON_CHARS} bytes; it must travel as artifact refs`;
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `${label}.entry is not canonical JSON: ${reason}`;
	}
	return undefined;
}

function sessionEventProblem(value: Record<string, unknown>, label: string): Problem {
	const base = firstProblem(
		expectFields(value, ["sequence", "kind", "recordedAt", "sessionId", "event"]),
		expectString(value.sessionId, `${label}.sessionId`, CLOUD_MAX_ID_CHARS, 1),
	);
	if (base !== undefined) return base;
	if (!isRecord(value.event)) return `${label}.event must be a JSON object`;
	if (typeof value.event.type !== "string" || value.event.type.length < 1) {
		return `${label}.event.type must be a non-empty string`;
	}
	try {
		const encoded = canonicalJson(value.event);
		if (Buffer.byteLength(encoded, "utf8") > CLOUD_MAX_SESSION_EVENT_BYTES) {
			return `${label}.event exceeds ${CLOUD_MAX_SESSION_EVENT_BYTES} bytes`;
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `${label}.event is not canonical JSON: ${reason}`;
	}
	return undefined;
}

function sessionMetaProblem(value: Record<string, unknown>, label: string): Problem {
	return firstProblem(
		expectFields(value, [
			"sequence",
			"kind",
			"recordedAt",
			"sessionId",
			"streaming",
			"runningTools",
			"queue",
			"recap",
			"taskState",
			"model",
			"connectivityHints",
		]),
		expectString(value.sessionId, `${label}.sessionId`, CLOUD_MAX_ID_CHARS, 1),
		typeof value.streaming === "boolean" ? undefined : `${label}.streaming must be a boolean`,
		expectInteger(value.runningTools, `${label}.runningTools`, 0),
		expectInteger(value.queue, `${label}.queue`, 0),
		optionalString(value.recap, `${label}.recap`, CLOUD_MAX_META_CHARS),
		value.taskState === undefined
			? undefined
			: expectOneOf(value.taskState, `${label}.taskState`, ["needs_input", "completed"]),
		optionalString(value.model, `${label}.model`, CLOUD_MAX_MODEL_ID_CHARS),
		connectivityHintsProblem(value.connectivityHints, `${label}.connectivityHints`),
	);
}

function connectivityHintsProblem(value: unknown, label: string): Problem {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return `${label} must be an array`;
	if (value.length > CLOUD_MAX_CAPABILITIES) return `${label} must hold at most ${CLOUD_MAX_CAPABILITIES} entries`;
	for (let index = 0; index < value.length; index++) {
		const problem = expectString(value[index], `${label}[${index}]`, CLOUD_MAX_META_CHARS, 1);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

function rosterRowProblem(value: unknown, label: string): Problem {
	if (!isRecord(value)) return `${label} must be an object`;
	return firstProblem(
		expectFields(value, ["childId", "parentRemoteId", "name", "status", "depth", "preview"]),
		expectString(value.childId, `${label}.childId`, CLOUD_MAX_ID_CHARS, 1),
		value.parentRemoteId === undefined
			? undefined
			: expectString(value.parentRemoteId, `${label}.parentRemoteId`, CLOUD_MAX_ID_CHARS, 1),
		optionalString(value.name, `${label}.name`, CLOUD_MAX_SESSION_NAME_CHARS),
		expectOneOf(value.status, `${label}.status`, ["queued", "running", "completed", "failed", "cancelled"]),
		expectInteger(value.depth, `${label}.depth`, 0),
		optionalString(value.preview, `${label}.preview`, CLOUD_MAX_PREVIEW_CHARS),
	);
}

function rosterDeltaProblem(value: Record<string, unknown>, label: string): Problem {
	const base = firstProblem(expectFields(value, ["sequence", "kind", "recordedAt", "rows"]));
	if (base !== undefined) return base;
	if (!Array.isArray(value.rows)) return `${label}.rows must be an array`;
	if (value.rows.length > CLOUD_MAX_ROSTER_ROWS) {
		return `${label}.rows must hold at most ${CLOUD_MAX_ROSTER_ROWS} entries`;
	}
	for (let index = 0; index < value.rows.length; index++) {
		const problem = rosterRowProblem(value.rows[index], `${label}.rows[${index}]`);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

function childUpdateProblem(value: Record<string, unknown>, label: string): Problem {
	return firstProblem(
		expectFields(value, [
			"sequence",
			"kind",
			"recordedAt",
			"childId",
			"status",
			"answerPreview",
			"sessionFile",
			"model",
		]),
		expectString(value.childId, `${label}.childId`, CLOUD_MAX_ID_CHARS, 1),
		expectOneOf(value.status, `${label}.status`, ["queued", "running", "completed", "failed", "cancelled"]),
		optionalString(value.answerPreview, `${label}.answerPreview`, CLOUD_MAX_PREVIEW_CHARS),
		optionalString(value.sessionFile, `${label}.sessionFile`, CLOUD_MAX_PATH_CHARS),
		optionalString(value.model, `${label}.model`, CLOUD_MAX_MODEL_ID_CHARS),
	);
}

function usageTotalsProblem(value: unknown, label: string): Problem {
	if (!isRecord(value)) return `${label} must be an object`;
	return firstProblem(
		expectFields(value, ["inputTokens", "outputTokens", "cachedTokens", "requests"]),
		expectInteger(value.inputTokens, `${label}.inputTokens`, 0),
		expectInteger(value.outputTokens, `${label}.outputTokens`, 0),
		value.cachedTokens === undefined ? undefined : expectInteger(value.cachedTokens, `${label}.cachedTokens`, 0),
		expectInteger(value.requests, `${label}.requests`, 0),
	);
}

function usageProblem(value: Record<string, unknown>, label: string): Problem {
	return firstProblem(
		expectFields(value, ["sequence", "kind", "recordedAt", "sessionId", "totals", "revision"]),
		expectString(value.sessionId, `${label}.sessionId`, CLOUD_MAX_ID_CHARS, 1),
		usageTotalsProblem(value.totals, `${label}.totals`),
		expectInteger(value.revision, `${label}.revision`, 0),
	);
}

function eventsProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, ["type", "sessionId", "generation", "events"]),
		cloudIdProblem(value.sessionId, "events.sessionId"),
		expectInteger(value.generation, "events.generation", 1),
	);
	if (base !== undefined) {
		return base;
	}
	const events = value.events;
	if (!Array.isArray(events)) {
		return "events.events must be an array";
	}
	if (events.length > CLOUD_MAX_SNAPSHOT_EVENTS) {
		return `events.events must hold at most ${CLOUD_MAX_SNAPSHOT_EVENTS} entries`;
	}
	let lastSequence = 0;
	for (let index = 0; index < events.length; index++) {
		const problem = eventProblem(events[index], `events.events[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
		const sequence = (events[index] as { sequence: number }).sequence;
		if (sequence <= lastSequence) {
			return `events.events[${index}].sequence must strictly increase`;
		}
		lastSequence = sequence;
	}
	return undefined;
}

function sessionStateProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "snapshot.state must be an object";
	}
	const queued = value.queuedCommandIds;
	if (queued === undefined) {
		return "snapshot.state.queuedCommandIds is required";
	}
	if (!Array.isArray(queued)) {
		return "snapshot.state.queuedCommandIds must be an array";
	}
	if (queued.length > CLOUD_MAX_QUEUED_COMMANDS) {
		return `snapshot.state.queuedCommandIds must hold at most ${CLOUD_MAX_QUEUED_COMMANDS} entries`;
	}
	for (let index = 0; index < queued.length; index++) {
		const problem = cloudIdProblem(queued[index], `snapshot.state.queuedCommandIds[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
	}
	return firstProblem(
		expectFields(value, ["cwd", "modelId", "activeCommandId", "queuedCommandIds"]),
		expectString(value.cwd, "snapshot.state.cwd", CLOUD_MAX_PATH_CHARS, 0),
		expectString(value.modelId, "snapshot.state.modelId", CLOUD_MAX_MODEL_ID_CHARS),
		value.activeCommandId === undefined
			? undefined
			: cloudIdProblem(value.activeCommandId, "snapshot.state.activeCommandId"),
	);
}

function helloProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, [
			"type",
			"protocolVersion",
			"generation",
			"clientId",
			"sessionId",
			"authToken",
			"cursor",
			"capabilities",
		]),
		expectInteger(value.protocolVersion, "hello.protocolVersion", 1),
		value.protocolVersion === CLOUD_PROTOCOL_VERSION
			? undefined
			: `hello.protocolVersion must equal ${CLOUD_PROTOCOL_VERSION}`,
		expectInteger(value.generation, "hello.generation", 1),
		cloudIdProblem(value.clientId, "hello.clientId"),
		cloudIdProblem(value.sessionId, "hello.sessionId"),
		value.authToken === undefined
			? undefined
			: expectString(value.authToken, "hello.authToken", CLOUD_MAX_TOKEN_CHARS),
		value.cursor === undefined ? undefined : cursorProblem(value.cursor, "hello.cursor"),
		capabilitiesProblem(value.capabilities, "hello.capabilities"),
	);
	if (base !== undefined) {
		return base;
	}
	if (value.cursor !== undefined && (value.cursor as CloudCursor).generation !== value.generation) {
		return "hello.cursor.generation must match hello.generation";
	}
	return undefined;
}

function snapshotProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, ["type", "sessionId", "generation", "cursor", "status", "state", "events", "capabilities"]),
		capabilitiesProblem(value.capabilities, "snapshot.capabilities"),
		cloudIdProblem(value.sessionId, "snapshot.sessionId"),
		expectInteger(value.generation, "snapshot.generation", 1),
		expectOneOf(value.status, "snapshot.status", CLOUD_SESSION_STATUSES),
		sessionStateProblem(value.state),
	);
	if (base !== undefined) {
		return base;
	}
	const cursorBase = cursorProblem(value.cursor, "snapshot.cursor");
	if (cursorBase !== undefined) {
		return cursorBase;
	}
	const events = value.events;
	if (!Array.isArray(events)) {
		return "snapshot.events must be an array";
	}
	if (events.length > CLOUD_MAX_SNAPSHOT_EVENTS) {
		return `snapshot.events must hold at most ${CLOUD_MAX_SNAPSHOT_EVENTS} events`;
	}
	let lastSequence = 0;
	for (let index = 0; index < events.length; index++) {
		const problem = eventProblem(events[index], `snapshot.events[${index}]`);
		if (problem !== undefined) {
			return problem;
		}
		const sequence = (events[index] as { sequence: number }).sequence;
		if (sequence <= lastSequence) {
			return `snapshot.events[${index}].sequence must strictly increase`;
		}
		lastSequence = sequence;
	}
	const cursor = value.cursor as CloudCursor;
	if (cursor.generation !== value.generation) {
		return "snapshot.cursor.generation must match snapshot.generation";
	}
	if (events.length > 0 && cursor.sequence !== lastSequence) {
		return "snapshot.cursor.sequence must match the last event sequence";
	}
	return undefined;
}

function subscribeProblem(value: Record<string, unknown>): string | undefined {
	return firstProblem(
		expectFields(value, ["type", "sessionId", "cursor"]),
		cloudIdProblem(value.sessionId, "subscribe.sessionId"),
		cursorProblem(value.cursor, "subscribe.cursor"),
	);
}

function submitProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, ["type", "sessionId", "generation", "commandId", "request", "digest"]),
		cloudIdProblem(value.sessionId, "submit.sessionId"),
		expectInteger(value.generation, "submit.generation", 1),
		cloudIdProblem(value.commandId, "submit.commandId"),
		cloudRequestProblem(value.request),
		expectDigest(value.digest, "submit.digest"),
	);
	if (base !== undefined) {
		return base;
	}
	if (cloudRequestDigest(value.request as CloudCommandRequest) !== value.digest) {
		return "submit.digest must equal the canonical digest of submit.request";
	}
	return undefined;
}

function getCommandProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, ["type", "sessionId", "generation", "commandId", "claim"]),
		cloudIdProblem(value.sessionId, "get_command.sessionId"),
		expectInteger(value.generation, "get_command.generation", 1),
		value.commandId === undefined ? undefined : cloudIdProblem(value.commandId, "get_command.commandId"),
		value.claim === undefined || typeof value.claim === "boolean" ? undefined : "get_command.claim must be a boolean",
	);
	if (base !== undefined) {
		return base;
	}
	if (value.claim === true && value.commandId !== undefined) {
		return "get_command.claim cannot be combined with get_command.commandId";
	}
	return undefined;
}

function commandProblem(value: Record<string, unknown>): string | undefined {
	const base = firstProblem(
		expectFields(value, ["type", "sessionId", "generation", "receipt", "request"]),
		cloudIdProblem(value.sessionId, "command.sessionId"),
		expectInteger(value.generation, "command.generation", 1),
		receiptProblem(value.receipt, "command.receipt"),
	);
	if (base !== undefined) {
		return base;
	}
	if (value.request === undefined) {
		return undefined;
	}
	const lengthProblem = expectString(value.request, "command.request", CLOUD_MAX_REQUEST_JSON_CHARS);
	if (lengthProblem !== undefined) {
		return lengthProblem;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.request as string);
	} catch {
		return "command.request must be JSON of a command request";
	}
	return cloudRequestProblem(parsed);
}

function ackProblem(value: Record<string, unknown>): string | undefined {
	return firstProblem(
		expectFields(value, ["type", "sessionId", "cursor"]),
		cloudIdProblem(value.sessionId, "ack.sessionId"),
		cursorProblem(value.cursor, "ack.cursor"),
	);
}

/** Runtime validation for any protocol frame; undefined means the value is a valid CloudMessage. */
export function cloudMessageProblem(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "message must be a JSON object";
	}
	switch (value.type) {
		case "hello":
			return helloProblem(value);
		case "snapshot":
			return snapshotProblem(value);
		case "subscribe":
			return subscribeProblem(value);
		case "events":
			return eventsProblem(value);
		case "submit":
			return submitProblem(value);
		case "get_command":
			return getCommandProblem(value);
		case "command":
			return commandProblem(value);
		case "ack":
			return ackProblem(value);
		default:
			return `message.type must be one of ${CLOUD_MESSAGE_TYPES.join(", ")}`;
	}
}

export type CloudMessageParseResult = { ok: true; message: CloudMessage } | { ok: false; error: string };

/** Parse an untrusted wire value into a validated CloudMessage. */
export function parseCloudMessage(value: unknown): CloudMessageParseResult {
	let candidate: unknown = value;
	if (typeof candidate === "string") {
		if (Buffer.byteLength(candidate, "utf8") > CLOUD_MAX_MESSAGE_BYTES) {
			return { ok: false, error: `message exceeds ${CLOUD_MAX_MESSAGE_BYTES} bytes` };
		}
		try {
			candidate = JSON.parse(candidate);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `message is not valid JSON: ${reason}` };
		}
	}
	const problem = cloudMessageProblem(candidate);
	return problem === undefined ? { ok: true, message: candidate as CloudMessage } : { ok: false, error: problem };
}

/** Validate and canonically serialize a frame; throws on any violation. */
export function serializeCloudMessage(message: CloudMessage): string {
	const problem = cloudMessageProblem(message);
	if (problem !== undefined) {
		throw new Error(`invalid cloud message: ${problem}`);
	}
	const serialized = canonicalJson(message);
	if (Buffer.byteLength(serialized, "utf8") > CLOUD_MAX_MESSAGE_BYTES) {
		throw new Error(`serialized message exceeds ${CLOUD_MAX_MESSAGE_BYTES} bytes`);
	}
	return serialized;
}

const CLOUD_MESSAGE_TYPES = [
	"hello",
	"snapshot",
	"subscribe",
	"events",
	"submit",
	"get_command",
	"command",
	"ack",
] as const;

type Problem = string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstProblem(...problems: Problem[]): Problem {
	return problems.find((problem) => problem !== undefined);
}

function expectFields(record: Record<string, unknown>, fields: readonly string[]): Problem {
	for (const key of Object.keys(record)) {
		if (!fields.includes(key)) {
			return `unexpected field: ${key}`;
		}
	}
	return undefined;
}

function expectString(value: unknown, label: string, maxLength: number, minLength = 1): Problem {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		return `${label} must be a string of ${minLength}-${maxLength} characters`;
	}
	return undefined;
}

function expectInteger(value: unknown, label: string, minimum: number): Problem {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
		return `${label} must be an integer of at least ${minimum}`;
	}
	return undefined;
}

function expectOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): Problem {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		return `${label} must be one of ${allowed.join(", ")}`;
	}
	return undefined;
}

function optionalString(value: unknown, label: string, maxLength: number): Problem {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		return `${label} must be a string of 1-${maxLength} characters when present`;
	}
	return undefined;
}

function optionalBoolean(value: unknown, label: string): Problem {
	if (value === undefined) return undefined;
	return typeof value === "boolean" ? undefined : `${label} must be a boolean when present`;
}

function expectDigest(value: unknown, label: string): Problem {
	return typeof value === "string" && isCloudDigest(value) ? undefined : `${label} must be a sha256:<64 hex> digest`;
}
