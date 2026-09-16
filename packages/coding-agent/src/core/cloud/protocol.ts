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
export const CLOUD_PROTOCOL_VERSION = 1;

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

export type CloudSessionId = string;
export type CloudClientId = string;
export type CloudCommandId = string;

export const CLOUD_CAPABILITIES = ["event_stream", "command_receipts"] as const;
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

/** M0 steering commands: start a task by a client-chosen taskId, or steer/cancel it by that id. */
export type CloudCommandRequest =
	| { kind: "start_task"; taskId: CloudTaskId; prompt: string }
	| { kind: "steer"; taskId: CloudTaskId; text: string }
	| { kind: "cancel_task"; taskId: CloudTaskId };

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
}

export type CloudEvent =
	| { sequence: number; kind: "command_accepted"; recordedAt: string; receipt: CloudCommandReceipt }
	| { sequence: number; kind: "command_state"; recordedAt: string; receipt: CloudCommandReceipt }
	| { sequence: number; kind: "session_status"; recordedAt: string; status: CloudSessionStatus };

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
}

export interface CloudSubscribe {
	type: "subscribe";
	sessionId: CloudSessionId;
	cursor: CloudCursor;
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
	const kindProblem = expectOneOf(value.kind, "request.kind", ["start_task", "steer", "cancel_task"]);
	if (kindProblem !== undefined) {
		return kindProblem;
	}
	if (value.kind === "start_task") {
		return firstProblem(
			expectFields(value, ["kind", "taskId", "prompt"]),
			cloudIdProblem(value.taskId, "request.taskId"),
			expectString(value.prompt, "request.prompt", CLOUD_MAX_PROMPT_CHARS, 0),
		);
	}
	if (value.kind === "steer") {
		return firstProblem(
			expectFields(value, ["kind", "taskId", "text"]),
			cloudIdProblem(value.taskId, "request.taskId"),
			expectString(value.text, "request.text", CLOUD_MAX_PROMPT_CHARS, 0),
		);
	}
	return firstProblem(expectFields(value, ["kind", "taskId"]), cloudIdProblem(value.taskId, "request.taskId"));
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
		expectFields(value, ["commandId", "digest", "state", "submittedAt", "updatedAt", "uncertain", "error"]),
		cloudIdProblem(value.commandId, `${label}.commandId`),
		expectDigest(value.digest, `${label}.digest`),
		expectOneOf(value.state, `${label}.state`, CLOUD_COMMAND_STATES),
		expectString(value.submittedAt, `${label}.submittedAt`, CLOUD_MAX_TIMESTAMP_CHARS),
		expectString(value.updatedAt, `${label}.updatedAt`, CLOUD_MAX_TIMESTAMP_CHARS),
		typeof value.uncertain === "boolean" ? undefined : `${label}.uncertain must be a boolean`,
		value.error === undefined ? undefined : expectString(value.error, `${label}.error`, CLOUD_MAX_ERROR_CHARS),
	);
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
	return firstProblem(
		expectFields(value, ["sequence", "kind", "recordedAt", "receipt"]),
		receiptProblem(value.receipt, `${label}.receipt`),
	);
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
		expectFields(value, ["type", "protocolVersion", "generation", "clientId", "sessionId", "cursor", "capabilities"]),
		expectInteger(value.protocolVersion, "hello.protocolVersion", 1),
		value.protocolVersion === CLOUD_PROTOCOL_VERSION
			? undefined
			: `hello.protocolVersion must equal ${CLOUD_PROTOCOL_VERSION}`,
		expectInteger(value.generation, "hello.generation", 1),
		cloudIdProblem(value.clientId, "hello.clientId"),
		cloudIdProblem(value.sessionId, "hello.sessionId"),
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
		expectFields(value, ["type", "sessionId", "generation", "cursor", "status", "state", "events"]),
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

const CLOUD_MESSAGE_TYPES = ["hello", "snapshot", "subscribe", "submit", "get_command", "command", "ack"] as const;

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

function expectDigest(value: unknown, label: string): Problem {
	return typeof value === "string" && isCloudDigest(value) ? undefined : `${label} must be a sha256:<64 hex> digest`;
}
