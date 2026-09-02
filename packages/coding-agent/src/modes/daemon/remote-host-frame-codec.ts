import { createHash } from "node:crypto";
import type {
	ArtifactRef,
	JsonValue,
	RemoteHostAckFrame,
	RemoteHostAgentMessageFrame,
	RemoteHostBuildIdentity,
	RemoteHostCapability,
	RemoteHostClientCapability,
	RemoteHostCommandFrame,
	RemoteHostCommandFrameBody,
	RemoteHostErrorFrame,
	RemoteHostEventBody,
	RemoteHostEventCursor,
	RemoteHostEventFrame,
	RemoteHostFrame,
	RemoteHostFrameEnvelope,
	RemoteHostHandshakeAckFrame,
	RemoteHostHandshakeFrame,
	RemoteHostHealthFrame,
	RemoteHostLinkDirection,
	RemoteHostLinkStatus,
	RemoteHostProtocolInfo,
	RemoteHostProviderProxyFrame,
} from "./remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_NAME, REMOTE_HOST_PROTOCOL_VERSION } from "./remote-agent-host-protocol.js";

// ===========================================================================
// Closed error codes — no input-derived text, no unrelated store/backend codes
// ===========================================================================

export const CODEC_ERRORS = {
	INVALID_FRAME: "INVALID_FRAME",
	INVALID_ENVELOPE: "INVALID_ENVELOPE",
	INVALID_PROTOCOL: "INVALID_PROTOCOL",
	INVALID_IDENTITY: "INVALID_IDENTITY",
	INVALID_COMMAND_BODY: "INVALID_COMMAND_BODY",
	INVALID_EVENT_BODY: "INVALID_EVENT_BODY",
	INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
	INVALID_SEQUENCE: "INVALID_SEQUENCE",
	INVALID_DIGEST: "INVALID_DIGEST",
	UNSUPPORTED_COMMAND: "UNSUPPORTED_COMMAND",
	UNSUPPORTED_EVENT: "UNSUPPORTED_EVENT",
	MISMATCH: "MISMATCH",
	OVERFLOW: "OVERFLOW",
} as const;

export type CodecErrorCode = (typeof CODEC_ERRORS)[keyof typeof CODEC_ERRORS];

/** Error result — code only, no input-derived text. */
export interface CodecError {
	code: CodecErrorCode;
}

// ===========================================================================
// DecodeResult — discriminated union. Never forge a value on error.
// ===========================================================================

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: CodecError };

function ok<T>(value: T): DecodeResult<T> {
	return { ok: true, value };
}

function fail(code: CodecErrorCode): DecodeResult<never> {
	return { ok: false, error: { code } };
}

// ===========================================================================
// Cumulative node & encoded-byte budget
// ===========================================================================

const MAX_JSON_NODES = 10_000; // total nodes (objects + arrays + leaf values)
const MAX_ENCODED_BYTES = 1_048_576; // 1 MiB total canonical output
const MAX_DEPTH = 64;

// ===========================================================================
// String bounds
// ===========================================================================

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidSafeId(id: string): boolean {
	return SAFE_ID_RE.test(id);
}

function checkId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= 128 && SAFE_ID_RE.test(v);
}

// ===========================================================================
// Plain-object guard — rejects arrays, null, non-plain prototypes, accessors,
// symbols, non-enumerable own props, undefined own-key values, array holes
// ===========================================================================

function isPlainObject(v: unknown, rejectUndefinedKeys: boolean = true): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	if (proto !== null && proto !== Object.prototype) return false;
	const descs = Object.getOwnPropertyDescriptors(v);
	const keys = Object.getOwnPropertyNames(v);
	const symbols = Object.getOwnPropertySymbols(v);
	// Reject objects with symbol keys
	if (symbols.length > 0) return false;
	for (const key of keys) {
		const desc = descs[key];
		// Reject accessors
		if (desc.get || desc.set) return false;
		// Only enumerable own properties count as "own keys" for our schema
		if (!desc.enumerable) return false;
	}
	if (rejectUndefinedKeys) {
		for (const key of keys) {
			if ((v as Record<string, unknown>)[key] === undefined) return false;
		}
	}
	return true;
}

// ===========================================================================
// Cumulative JSON-safe validator — rejects prototype, accessor, symbol,
// non-enumerable, undefined, nonfinite, array holes, over node/byte budget
// ===========================================================================

interface JsonBudget {
	nodesRemaining: number;
	bytesRemaining: number;
	depthRemaining: number;
	encodedSize: number; // running total of canonical encoded size
}

function takeBudget(budget: JsonBudget, encodedDelta: number = 0): boolean {
	if (budget.nodesRemaining <= 0) return false;
	if (encodedDelta > budget.bytesRemaining) return false;
	budget.nodesRemaining -= 1;
	budget.bytesRemaining -= encodedDelta;
	budget.encodedSize += encodedDelta;
	return true;
}

/**
 * Check that input is JSON-safe: rejects prototype, accessors, symbol keys,
 * non-enumerable own props, undefined values, nonfinite numbers, array holes.
 * Returns error code or undefined if safe. Updates cumulative budget.
 */
export function checkJsonSafe(
	value: unknown,
	budget: JsonBudget = {
		nodesRemaining: MAX_JSON_NODES,
		bytesRemaining: MAX_ENCODED_BYTES,
		depthRemaining: MAX_DEPTH,
		encodedSize: 0,
	},
): CodecErrorCode | undefined {
	if (budget.depthRemaining <= 0) return CODEC_ERRORS.OVERFLOW;
	if (!takeBudget(budget)) return CODEC_ERRORS.OVERFLOW;

	if (value === null) return undefined;
	if (typeof value === "boolean") return undefined;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return CODEC_ERRORS.INVALID_COMMAND_BODY;
		const rep = JSON.stringify(value);
		if (rep.length > budget.bytesRemaining) return CODEC_ERRORS.OVERFLOW;
		budget.bytesRemaining -= rep.length;
		budget.encodedSize += rep.length;
		return undefined;
	}
	if (typeof value === "string") {
		const byteLen = Buffer.byteLength(value, "utf-8");
		if (byteLen > budget.bytesRemaining) return CODEC_ERRORS.OVERFLOW;
		budget.bytesRemaining -= byteLen;
		budget.encodedSize += byteLen;
		return undefined;
	}
	if (Array.isArray(value)) {
		// Reject array holes
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) return CODEC_ERRORS.INVALID_COMMAND_BODY;
		}
		budget.depthRemaining -= 1;
		for (let i = 0; i < value.length; i++) {
			const err = checkJsonSafe(value[i], budget);
			if (err) return err;
		}
		return undefined;
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== null && proto !== Object.prototype) return CODEC_ERRORS.INVALID_COMMAND_BODY;
		const descs = Object.getOwnPropertyDescriptors(value);
		const keys = Object.getOwnPropertyNames(value);
		const symbols = Object.getOwnPropertySymbols(value);
		// Reject symbol keys
		if (symbols.length > 0) return CODEC_ERRORS.INVALID_COMMAND_BODY;
		for (const key of keys) {
			const desc = descs[key];
			if (desc.get || desc.set) return CODEC_ERRORS.INVALID_COMMAND_BODY;
			if (!desc.enumerable) return CODEC_ERRORS.INVALID_COMMAND_BODY;
		}
		budget.depthRemaining -= 1;
		for (const key of keys) {
			const val = (value as Record<string, unknown>)[key];
			if (val === undefined) return CODEC_ERRORS.INVALID_COMMAND_BODY;
			const err = checkJsonSafe(val, budget);
			if (err) return err;
		}
		return undefined;
	}
	return CODEC_ERRORS.INVALID_COMMAND_BODY;
}

// ===========================================================================
// Canonical strict UTC timestamp — exactly JS ISO YYYY-MM-DDTHH:mm:ss.sssZ
// ===========================================================================

const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_TIMESTAMP_YEAR = 9999;

export function isCanonicalUtcTimestamp(ts: string): boolean {
	if (typeof ts !== "string") return false;
	if (!CANONICAL_UTC_RE.test(ts)) return false;
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return false;
	const rt = d.toISOString();
	if (rt !== ts) return false;
	const year = d.getUTCFullYear();
	return year >= 1 && year <= MAX_TIMESTAMP_YEAR;
}

// ===========================================================================
// Number guards
// ===========================================================================

function isSafeInteger(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v);
}

function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}

// ===========================================================================
// Known enum sets
// ===========================================================================

const VALID_DIRECTIONS = new Set(["home_to_host", "host_to_home"]);
const VALID_ACK_STATUSES = new Set(["delivered", "replayed", "rejected"]);
const VALID_DELIVERY_MODES = new Set(["queued", "direct"]);
const VALID_PROXY_TYPES = new Set([
	"model_call_request",
	"model_call_chunk",
	"model_call_complete",
	"model_call_error",
	"model_call_cancel",
]);
const VALID_LINK_STATUSES = new Set(["connecting", "connected", "reconnecting", "unreachable", "closed"]);
const VALID_SESSION_STATES = new Set(["running", "idle", "inactive"]);
const VALID_STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);

const VALID_CAPABILITIES = new Set<RemoteHostCapability>([
	"session_commands",
	"sequenced_events",
	"provider_proxy",
	"agent_messages",
	"link_health",
	"checkpoint",
	"workspace_sync",
	"acknowledgements",
]);

const VALID_CLIENT_CAPABILITIES = new Set<RemoteHostClientCapability>([
	"acknowledgements",
	"replay_catchup",
	"provider_proxy_streaming",
]);

// ===========================================================================
// Decoder: ArtifactRef
// ===========================================================================

const ARTIFACT_KEYS = new Set(["workspaceId", "snapshotId", "changesetId"]);

export function decodeArtifactRef(raw: unknown): DecodeResult<ArtifactRef> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!ARTIFACT_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	if (typeof obj.workspaceId !== "string" || obj.workspaceId.length === 0 || obj.workspaceId.length > 128) {
		return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	if (
		obj.snapshotId !== undefined &&
		(typeof obj.snapshotId !== "string" || obj.snapshotId.length === 0 || obj.snapshotId.length > 128)
	) {
		return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	if (
		obj.changesetId !== undefined &&
		(typeof obj.changesetId !== "string" || obj.changesetId.length === 0 || obj.changesetId.length > 128)
	) {
		return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	const fresh: ArtifactRef = { workspaceId: obj.workspaceId as string };
	if (typeof obj.snapshotId === "string") fresh.snapshotId = obj.snapshotId;
	if (typeof obj.changesetId === "string") fresh.changesetId = obj.changesetId;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostProtocolInfo
// ===========================================================================

const PROTO_KEYS = new Set(["name", "version"]);

export function decodeProtocolInfo(raw: unknown): DecodeResult<RemoteHostProtocolInfo> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!PROTO_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	}
	if (obj.name !== REMOTE_HOST_PROTOCOL_NAME || typeof obj.name !== "string") {
		return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	}
	if (
		obj.version !== REMOTE_HOST_PROTOCOL_VERSION ||
		typeof obj.version !== "number" ||
		!Number.isSafeInteger(obj.version)
	) {
		return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	}
	return ok({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION });
}

// ===========================================================================
// Decoder: RemoteHostBuildIdentity
// ===========================================================================

const BUILD_KEYS = new Set(["buildId", "daemonProtocolVersion", "daemonSchemaRevision", "appVersion"]);

export function decodeBuildIdentity(raw: unknown): DecodeResult<RemoteHostBuildIdentity> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!BUILD_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	}
	if (typeof obj.buildId !== "string" || obj.buildId.length === 0 || obj.buildId.length > 128) {
		return fail(CODEC_ERRORS.INVALID_IDENTITY);
	}
	if (!isNonNegativeInt(obj.daemonProtocolVersion)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isNonNegativeInt(obj.daemonSchemaRevision)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (obj.appVersion !== undefined && (typeof obj.appVersion !== "string" || obj.appVersion.length > 64)) {
		return fail(CODEC_ERRORS.INVALID_IDENTITY);
	}
	const fresh: RemoteHostBuildIdentity = {
		buildId: obj.buildId as string,
		daemonProtocolVersion: obj.daemonProtocolVersion as number,
		daemonSchemaRevision: obj.daemonSchemaRevision as number,
	};
	if (typeof obj.appVersion === "string") fresh.appVersion = obj.appVersion;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostEventCursor
// ===========================================================================

const CURSOR_KEYS = new Set(["hostId", "generation", "sessionId", "sequence"]);

export function decodeEventCursor(raw: unknown): DecodeResult<RemoteHostEventCursor> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!CURSOR_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	}
	if (!checkId(obj.hostId)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.generation)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.sessionId)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isNonNegativeInt(obj.sequence)) return fail(CODEC_ERRORS.INVALID_SEQUENCE);
	return ok({
		hostId: obj.hostId as string,
		generation: obj.generation as string,
		sessionId: obj.sessionId as string,
		sequence: obj.sequence as number,
	});
}

// ===========================================================================
// Capabilities arrays (unique, known, bounded)
// ===========================================================================

function decodeCapabilities(raw: unknown): DecodeResult<RemoteHostCapability[]> {
	if (!Array.isArray(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.length > 50) return fail(CODEC_ERRORS.INVALID_FRAME);
	// Reject array holes
	for (let i = 0; i < raw.length; i++) {
		if (!(i in raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	const seen = new Set<string>();
	const result: RemoteHostCapability[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return fail(CODEC_ERRORS.INVALID_FRAME);
		const cap = item as RemoteHostCapability;
		if (!VALID_CAPABILITIES.has(cap)) return fail(CODEC_ERRORS.INVALID_FRAME);
		if (seen.has(item)) return fail(CODEC_ERRORS.INVALID_FRAME);
		seen.add(item);
		result.push(cap);
	}
	return ok(result);
}

function decodeClientCapabilities(raw: unknown): DecodeResult<RemoteHostClientCapability[]> {
	if (!Array.isArray(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.length > 10) return fail(CODEC_ERRORS.INVALID_FRAME);
	for (let i = 0; i < raw.length; i++) {
		if (!(i in raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	const seen = new Set<string>();
	const result: RemoteHostClientCapability[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return fail(CODEC_ERRORS.INVALID_FRAME);
		const cap = item as RemoteHostClientCapability;
		if (!VALID_CLIENT_CAPABILITIES.has(cap)) return fail(CODEC_ERRORS.INVALID_FRAME);
		if (seen.has(item)) return fail(CODEC_ERRORS.INVALID_FRAME);
		seen.add(item);
		result.push(cap);
	}
	return ok(result);
}

// ===========================================================================
// JsonValue decoder — constructs fresh structure with budget
// ===========================================================================

function decodeJsonValueRaw(raw: unknown, budget: JsonBudget): DecodeResult<JsonValue> {
	if (budget.depthRemaining <= 0) return fail(CODEC_ERRORS.OVERFLOW);
	if (!takeBudget(budget)) return fail(CODEC_ERRORS.OVERFLOW);

	if (raw === null) return ok(null);
	if (typeof raw === "boolean") return ok(raw);
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		const rep = JSON.stringify(raw);
		if (rep.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= rep.length;
		budget.encodedSize += rep.length;
		return ok(raw);
	}
	if (typeof raw === "string") {
		const byteLen = Buffer.byteLength(raw, "utf-8");
		if (byteLen > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= byteLen;
		budget.encodedSize += byteLen;
		return ok(raw);
	}
	if (Array.isArray(raw)) {
		for (let i = 0; i < raw.length; i++) {
			if (!(i in raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		}
		budget.depthRemaining -= 1;
		const arr: JsonValue[] = [];
		for (let i = 0; i < raw.length; i++) {
			const elem = decodeJsonValueRaw(raw[i], budget);
			if (!elem.ok) return elem;
			arr.push(elem.value);
		}
		return ok(arr);
	}
	if (isPlainObject(raw, true)) {
		const obj = raw as Record<string, unknown>;
		budget.depthRemaining -= 1;
		const result: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(obj).sort()) {
			const val = decodeJsonValueRaw(obj[key], budget);
			if (!val.ok) return val;
			result[key] = val.value;
		}
		return ok(result);
	}
	return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
}

export function decodeJsonValue(raw: unknown): DecodeResult<JsonValue> {
	const budget: JsonBudget = {
		nodesRemaining: MAX_JSON_NODES,
		bytesRemaining: MAX_ENCODED_BYTES,
		depthRemaining: MAX_DEPTH,
		encodedSize: 0,
	};
	return decodeJsonValueRaw(raw, budget);
}

// ===========================================================================
// Command body decoder — all 14 variants
// ===========================================================================

interface TypeKeyMap {
	required: string[];
	optional: string[];
}

const CMD_KEYS: Record<string, TypeKeyMap> = {
	create_session: { required: ["type", "workspaceId"], optional: ["name", "telemetryDisabled"] },
	destroy_session: { required: ["type"], optional: ["reason"] },
	prompt: { required: ["type", "message"], optional: ["admissionId"] },
	steer: { required: ["type", "message"], optional: ["queueKey"] },
	abort: { required: ["type"], optional: [] },
	execute_bash: { required: ["type", "command"], optional: ["transient", "runId"] },
	abort_bash: { required: ["type"], optional: [] },
	compact: { required: ["type"], optional: ["customInstructions"] },
	compact_abort: { required: ["type"], optional: [] },
	checkpoint: { required: ["type"], optional: ["leaveSandboxAlive"] },
	wake: { required: ["type", "snapshotId"], optional: [] },
	shutdown: { required: ["type"], optional: ["force"] },
	sync_workspace: { required: ["type", "artifact"], optional: [] },
};

const CMD_FIELD_VAL: Record<string, (v: unknown) => boolean> = {
	workspaceId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	name: (v) => typeof v === "string" && v.length <= 256,
	telemetryDisabled: isBoolean,
	reason: (v) => typeof v === "string" && v.length > 0 && v.length <= 1000,
	message: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf-8") <= 10_000_000,
	admissionId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	queueKey: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	command: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf-8") <= 10_000_000,
	transient: isBoolean,
	runId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	customInstructions: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf-8") <= 100_000,
	leaveSandboxAlive: isBoolean,
	snapshotId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	force: isBoolean,
	artifact: (v) => decodeArtifactRef(v).ok,
};

export function decodeCommandBody(raw: unknown): DecodeResult<RemoteHostCommandFrameBody> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const type = raw.type;
	if (typeof type !== "string" || type.length === 0) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);

	const keys = CMD_KEYS[type];
	if (!keys) return fail(CODEC_ERRORS.UNSUPPORTED_COMMAND);

	const has = new Set(Object.keys(raw));
	for (const k of keys.required) {
		if (!has.has(k)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	const allowed = new Set([...keys.required, ...keys.optional]);
	for (const k of has) {
		if (!allowed.has(k)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	for (const k of has) {
		if (k === "type") continue;
		const validator = CMD_FIELD_VAL[k];
		if (!validator || !validator(raw[k])) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
	}
	const fresh: Record<string, unknown> = { type };
	for (const k of keys.required) {
		if (k !== "type") fresh[k] = raw[k];
	}
	for (const k of keys.optional) {
		if (has.has(k)) fresh[k] = raw[k];
	}
	if (type === "sync_workspace") {
		const artResult = decodeArtifactRef(raw.artifact);
		if (!artResult.ok) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		fresh.artifact = artResult.value;
	}
	return ok(fresh as RemoteHostCommandFrameBody);
}

// ===========================================================================
// Event body decoder — 17 variants
// ===========================================================================

const EVT_KEYS: Record<string, TypeKeyMap> = {
	session_created: { required: ["type", "sessionId", "workspaceId"], optional: [] },
	session_destroyed: { required: ["type"], optional: ["reason"] },
	agent_start: { required: ["type"], optional: [] },
	agent_end: { required: ["type", "messages"], optional: [] },
	agent_text_delta: { required: ["type", "index", "text"], optional: [] },
	agent_thinking_delta: { required: ["type", "index", "text"], optional: [] },
	agent_toolcall_delta: { required: ["type", "index", "text"], optional: [] },
	bash_start: { required: ["type", "command"], optional: [] },
	bash_end: { required: ["type", "exitCode", "cancelled", "truncated"], optional: [] },
	bash_delta: { required: ["type", "text"], optional: [] },
	compact_start: { required: ["type"], optional: [] },
	compact_end: { required: ["type", "keptMessages"], optional: [] },
	compact_failed: { required: ["type", "error"], optional: [] },
	error: { required: ["type", "code", "message"], optional: [] },
	checkpoint_start: { required: ["type"], optional: [] },
	checkpoint_complete: { required: ["type", "snapshotId"], optional: [] },
	checkpoint_failed: { required: ["type", "error"], optional: [] },
	session_state: { required: ["type", "state"], optional: [] },
};

const EVT_FIELD_VAL: Record<string, (v: unknown) => boolean> = {
	sessionId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	workspaceId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	reason: (v) => typeof v === "string" && v.length > 0 && v.length <= 1000,
	messages: isNonNegativeInt,
	index: isNonNegativeInt,
	text: (v) => typeof v === "string" && Buffer.byteLength(v, "utf-8") <= 1_000_000,
	command: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf-8") <= 10_000_000,
	exitCode: isSafeInteger,
	cancelled: isBoolean,
	truncated: isBoolean,
	keptMessages: isNonNegativeInt,
	error: (v) => typeof v === "string" && v.length > 0 && v.length <= 1000,
	code: (v) => typeof v === "string" && v.length > 0 && v.length <= 100,
	message: (v) => typeof v === "string" && v.length > 0 && v.length <= 1000,
	snapshotId: (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
	state: (v) => typeof v === "string" && VALID_SESSION_STATES.has(v),
};

export function decodeEventBody(raw: unknown): DecodeResult<RemoteHostEventBody> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_EVENT_BODY);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const type = raw.type;
	if (typeof type !== "string" || type.length === 0) return fail(CODEC_ERRORS.INVALID_EVENT_BODY);

	const keys = EVT_KEYS[type];
	if (!keys) return fail(CODEC_ERRORS.UNSUPPORTED_EVENT);

	const has = new Set(Object.keys(raw));
	for (const k of keys.required) {
		if (!has.has(k)) return fail(CODEC_ERRORS.INVALID_EVENT_BODY);
	}
	const allowed = new Set([...keys.required, ...keys.optional]);
	for (const k of has) {
		if (!allowed.has(k)) return fail(CODEC_ERRORS.INVALID_EVENT_BODY);
	}
	for (const k of has) {
		if (k === "type") continue;
		const validator = EVT_FIELD_VAL[k];
		if (!validator || !validator(raw[k])) return fail(CODEC_ERRORS.INVALID_EVENT_BODY);
	}
	const fresh: Record<string, unknown> = { type };
	for (const k of keys.required) {
		if (k !== "type") fresh[k] = raw[k];
	}
	for (const k of keys.optional) {
		if (has.has(k)) fresh[k] = raw[k];
	}
	return ok(fresh as RemoteHostEventBody);
}

// ===========================================================================
// Decoder: RemoteHostHandshakeFrame
// ===========================================================================

const HANDSHAKE_REQUIRED = ["type", "direction", "hostId", "generation", "capabilities", "runtime", "protocol"];
const HANDSHAKE_OPTIONAL = new Set(["sessionId", "clientCapabilities", "resumeCursor"]);

export function decodeHandshakeFrame(raw: unknown): DecodeResult<RemoteHostHandshakeFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const obj = raw as Record<string, unknown>;
	if (obj.type !== "handshake") return fail(CODEC_ERRORS.INVALID_FRAME);

	const allowedKeys = new Set([...HANDSHAKE_REQUIRED, ...HANDSHAKE_OPTIONAL]);
	for (const k of Object.keys(obj)) {
		if (!allowedKeys.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}

	if (typeof obj.direction !== "string" || !VALID_DIRECTIONS.has(obj.direction as RemoteHostLinkDirection)) {
		return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(obj.hostId)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.generation)) return fail(CODEC_ERRORS.INVALID_IDENTITY);

	if (obj.sessionId !== undefined && !checkId(obj.sessionId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);

	const capsResult = decodeCapabilities(obj.capabilities);
	if (!capsResult.ok) return capsResult;

	let clientCaps: RemoteHostClientCapability[] | undefined;
	if (obj.clientCapabilities !== undefined) {
		const ccResult = decodeClientCapabilities(obj.clientCapabilities);
		if (!ccResult.ok) return ccResult;
		clientCaps = ccResult.value;
	}

	const runtimeResult = decodeBuildIdentity(obj.runtime);
	if (!runtimeResult.ok) return runtimeResult;

	const protoResult = decodeProtocolInfo(obj.protocol);
	if (!protoResult.ok) return protoResult;

	let resumeCursor: RemoteHostEventCursor | undefined;
	if (obj.resumeCursor !== undefined) {
		const rcResult = decodeEventCursor(obj.resumeCursor);
		if (!rcResult.ok) return rcResult;
		resumeCursor = rcResult.value;
		// Cross-field: resumeCursor identity must match own identity when sessionId present
		if (typeof obj.sessionId === "string") {
			if (
				resumeCursor.hostId !== obj.hostId ||
				resumeCursor.generation !== obj.generation ||
				resumeCursor.sessionId !== obj.sessionId
			) {
				return fail(CODEC_ERRORS.MISMATCH);
			}
		}
	}

	const fresh: RemoteHostHandshakeFrame = {
		type: "handshake",
		direction: obj.direction as RemoteHostLinkDirection,
		hostId: obj.hostId as string,
		generation: obj.generation as string,
		capabilities: capsResult.value,
		runtime: runtimeResult.value,
		protocol: protoResult.value,
	};
	if (typeof obj.sessionId === "string") fresh.sessionId = obj.sessionId;
	if (clientCaps) fresh.clientCapabilities = clientCaps;
	if (resumeCursor) fresh.resumeCursor = resumeCursor;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostHandshakeAckFrame
// ===========================================================================

const HANDSHAKE_ACK_REQUIRED = [
	"type",
	"hostId",
	"sessionId",
	"protocol",
	"accepted",
	"capabilities",
	"linkId",
	"remoteBuildIdentity",
];
const HANDSHAKE_ACK_OPTIONAL = new Set(["rejectReason", "cursor"]);

export function decodeHandshakeAckFrame(raw: unknown): DecodeResult<RemoteHostHandshakeAckFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const obj = raw as Record<string, unknown>;
	if (obj.type !== "handshake_ack") return fail(CODEC_ERRORS.INVALID_FRAME);

	const allowedKeys = new Set([...HANDSHAKE_ACK_REQUIRED, ...HANDSHAKE_ACK_OPTIONAL]);
	for (const k of Object.keys(obj)) {
		if (!allowedKeys.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}

	if (typeof obj.accepted !== "boolean") return fail(CODEC_ERRORS.INVALID_FRAME);
	if (!checkId(obj.hostId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.sessionId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.linkId as string)) return fail(CODEC_ERRORS.INVALID_FRAME);

	const protoResult = decodeProtocolInfo(obj.protocol);
	if (!protoResult.ok) return protoResult;

	const capsResult = decodeCapabilities(obj.capabilities);
	if (!capsResult.ok) return capsResult;

	const buildResult = decodeBuildIdentity(obj.remoteBuildIdentity);
	if (!buildResult.ok) return buildResult;

	// rejectReason: strictly for rejected handshake when protocol says
	// For now, allow rejectReason on accepted=false only
	if (obj.rejectReason !== undefined) {
		if (obj.accepted === true) return fail(CODEC_ERRORS.INVALID_FRAME);
		if (typeof obj.rejectReason !== "string" || obj.rejectReason.length > 256)
			return fail(CODEC_ERRORS.INVALID_FRAME);
	}

	let cursor: RemoteHostEventCursor | undefined;
	if (obj.cursor !== undefined) {
		if (obj.accepted !== true) return fail(CODEC_ERRORS.INVALID_FRAME);
		const curResult = decodeEventCursor(obj.cursor);
		if (!curResult.ok) return curResult;
		cursor = curResult.value;
	}

	const fresh: RemoteHostHandshakeAckFrame = {
		type: "handshake_ack",
		hostId: obj.hostId as string,
		sessionId: obj.sessionId as string,
		protocol: protoResult.value,
		accepted: obj.accepted as boolean,
		capabilities: capsResult.value,
		linkId: obj.linkId as string,
		remoteBuildIdentity: buildResult.value,
	};
	if (typeof obj.rejectReason === "string") fresh.rejectReason = obj.rejectReason;
	if (cursor) fresh.cursor = cursor;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostCommandFrame
// ===========================================================================

const CMD_FRAME_KEYS = new Set(["type", "commandId", "body"]);

export function decodeCommandFrame(raw: unknown): DecodeResult<RemoteHostCommandFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "command") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!CMD_FRAME_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(obj.commandId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	const bodyResult = decodeCommandBody(obj.body);
	if (!bodyResult.ok) return bodyResult;
	return ok({ type: "command", commandId: obj.commandId as string, body: bodyResult.value });
}

// ===========================================================================
// Decoder: RemoteHostEventFrame
// ===========================================================================

const EVT_FRAME_KEYS = new Set(["type", "id", "sequence", "cursor", "emittedAt", "body"]);

export function decodeEventFrame(raw: unknown): DecodeResult<RemoteHostEventFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "event") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!EVT_FRAME_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(obj.id as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isPositiveInt(obj.sequence)) return fail(CODEC_ERRORS.INVALID_SEQUENCE);

	const cursorResult = decodeEventCursor(obj.cursor);
	if (!cursorResult.ok) return cursorResult;

	// Cross-field: event.sequence === event.cursor.sequence
	if (obj.sequence !== cursorResult.value.sequence) return fail(CODEC_ERRORS.MISMATCH);

	if (!isCanonicalUtcTimestamp(obj.emittedAt as string)) return fail(CODEC_ERRORS.INVALID_TIMESTAMP);

	const bodyResult = decodeEventBody(obj.body);
	if (!bodyResult.ok) return bodyResult;

	return ok({
		type: "event",
		id: obj.id as string,
		sequence: obj.sequence as number,
		cursor: cursorResult.value,
		emittedAt: obj.emittedAt as string,
		body: bodyResult.value,
	});
}

// ===========================================================================
// Decoder: RemoteHostAckFrame
// ===========================================================================

const ACK_KEYS = new Set(["type", "ackId", "acknowledges", "status", "rejectReason"]);

export function decodeAckFrame(raw: unknown): DecodeResult<RemoteHostAckFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "ack") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!ACK_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(obj.ackId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.acknowledges as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (typeof obj.status !== "string" || !VALID_ACK_STATUSES.has(obj.status)) return fail(CODEC_ERRORS.INVALID_FRAME);

	if (obj.rejectReason !== undefined) {
		if (obj.status !== "rejected") return fail(CODEC_ERRORS.INVALID_FRAME);
		if (typeof obj.rejectReason !== "string" || obj.rejectReason.length > 256)
			return fail(CODEC_ERRORS.INVALID_FRAME);
	}

	const fresh: RemoteHostAckFrame = {
		type: "ack",
		ackId: obj.ackId as string,
		acknowledges: obj.acknowledges as string,
		status: obj.status as "delivered" | "replayed" | "rejected",
	};
	if (typeof obj.rejectReason === "string") fresh.rejectReason = obj.rejectReason;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostAgentMessageFrame
// ===========================================================================

const AGENT_KEYS = new Set(["type", "id", "fromActiveSessionId", "targetActiveSessionId", "message", "deliveryMode"]);

export function decodeAgentMessageFrame(raw: unknown): DecodeResult<RemoteHostAgentMessageFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "agent_message") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!AGENT_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(obj.id as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.fromActiveSessionId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!checkId(obj.targetActiveSessionId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (
		typeof obj.message !== "string" ||
		obj.message.length === 0 ||
		Buffer.byteLength(obj.message, "utf-8") > 10_000_000
	) {
		return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (
		obj.deliveryMode !== undefined &&
		(typeof obj.deliveryMode !== "string" || !VALID_DELIVERY_MODES.has(obj.deliveryMode))
	) {
		return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	const fresh: RemoteHostAgentMessageFrame = {
		type: "agent_message",
		id: obj.id as string,
		fromActiveSessionId: obj.fromActiveSessionId as string,
		targetActiveSessionId: obj.targetActiveSessionId as string,
		message: obj.message as string,
	};
	if (typeof obj.deliveryMode === "string") fresh.deliveryMode = obj.deliveryMode as "queued" | "direct";
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostProviderProxyFrame (5 variants — fresh DTO each)
// ===========================================================================

const PROXY_REQUEST_KEYS = new Set([
	"type",
	"proxyType",
	"callId",
	"provider",
	"model",
	"messages",
	"systemPrompt",
	"tools",
	"maxTokens",
	"temperature",
	"thinkingLevel",
	"streamingBehavior",
]);
const PROXY_CHUNK_KEYS = new Set(["type", "proxyType", "callId", "index", "delta"]);
const PROXY_COMPLETE_KEYS = new Set(["type", "proxyType", "callId", "result", "usage"]);
const PROXY_ERROR_KEYS = new Set(["type", "proxyType", "callId", "error"]);
const PROXY_CANCEL_KEYS = new Set(["type", "proxyType", "callId"]);

function decodeProxyRequest(raw: Record<string, unknown>): DecodeResult<RemoteHostProviderProxyFrame> {
	for (const k of Object.keys(raw)) {
		if (!PROXY_REQUEST_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(raw.callId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (typeof raw.provider !== "string" || raw.provider.length === 0 || raw.provider.length > 128)
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (typeof raw.model !== "string" || raw.model.length === 0 || raw.model.length > 128)
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (!Array.isArray(raw.messages)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const msgsResult = decodeJsonValue(raw.messages);
	if (!msgsResult.ok) return fail(CODEC_ERRORS.INVALID_FRAME);

	const fresh: RemoteHostProviderProxyFrame = {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId: raw.callId as string,
		provider: raw.provider as string,
		model: raw.model as string,
		messages: msgsResult.value as JsonValue[],
	};
	if (typeof raw.systemPrompt === "string") {
		if (Buffer.byteLength(raw.systemPrompt, "utf-8") > 1_000_000) return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.systemPrompt = raw.systemPrompt;
	}
	if (raw.tools !== undefined) {
		const toolsResult = decodeJsonValue(raw.tools);
		if (!toolsResult.ok) return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.tools = toolsResult.value as JsonValue[];
	}
	if (typeof raw.maxTokens === "number") {
		if (!isPositiveInt(raw.maxTokens)) return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.maxTokens = raw.maxTokens;
	}
	if (typeof raw.temperature === "number") {
		if (!Number.isFinite(raw.temperature)) return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.temperature = raw.temperature;
	}
	if (typeof raw.thinkingLevel === "string") {
		if (raw.thinkingLevel.length > 64) return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.thinkingLevel = raw.thinkingLevel;
	}
	if (raw.streamingBehavior !== undefined) {
		if (typeof raw.streamingBehavior !== "string" || !VALID_STREAMING_BEHAVIORS.has(raw.streamingBehavior))
			return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.streamingBehavior = raw.streamingBehavior as "steer" | "followUp";
	}
	return ok(fresh);
}

function decodeProxyChunk(raw: Record<string, unknown>): DecodeResult<RemoteHostProviderProxyFrame> {
	for (const k of Object.keys(raw)) {
		if (!PROXY_CHUNK_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(raw.callId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isNonNegativeInt(raw.index)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const deltaResult = decodeJsonValue(raw.delta);
	if (!deltaResult.ok) return fail(CODEC_ERRORS.INVALID_FRAME);
	return ok({
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId: raw.callId as string,
		index: raw.index as number,
		delta: deltaResult.value,
	});
}

function decodeProxyComplete(raw: Record<string, unknown>): DecodeResult<RemoteHostProviderProxyFrame> {
	for (const k of Object.keys(raw)) {
		if (!PROXY_COMPLETE_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(raw.callId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	const resultResult = decodeJsonValue(raw.result);
	if (!resultResult.ok) return fail(CODEC_ERRORS.INVALID_FRAME);

	const fresh: RemoteHostProviderProxyFrame = {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId: raw.callId as string,
		result: resultResult.value,
	};
	if (raw.usage !== undefined) {
		if (!isPlainObject(raw.usage)) return fail(CODEC_ERRORS.INVALID_FRAME);
		const usage = raw.usage as Record<string, unknown>;
		const usageKeys = new Set(Object.keys(usage));
		if (usageKeys.size !== 2 || !usageKeys.has("inputTokens") || !usageKeys.has("outputTokens"))
			return fail(CODEC_ERRORS.INVALID_FRAME);
		if (!isNonNegativeInt(usage.inputTokens) || !isNonNegativeInt(usage.outputTokens))
			return fail(CODEC_ERRORS.INVALID_FRAME);
		fresh.usage = { inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number };
	}
	return ok(fresh);
}

function decodeProxyError(raw: Record<string, unknown>): DecodeResult<RemoteHostProviderProxyFrame> {
	for (const k of Object.keys(raw)) {
		if (!PROXY_ERROR_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(raw.callId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (typeof raw.error !== "string" || raw.error.length === 0 || Buffer.byteLength(raw.error, "utf-8") > 1000) {
		return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	return ok({
		type: "provider_proxy",
		proxyType: "model_call_error",
		callId: raw.callId as string,
		error: raw.error as string,
	});
}

function decodeProxyCancel(raw: Record<string, unknown>): DecodeResult<RemoteHostProviderProxyFrame> {
	for (const k of Object.keys(raw)) {
		if (!PROXY_CANCEL_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!checkId(raw.callId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	return ok({ type: "provider_proxy", proxyType: "model_call_cancel", callId: raw.callId as string });
}

export function decodeProviderProxyFrame(raw: unknown): DecodeResult<RemoteHostProviderProxyFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const jsonErr = checkJsonSafe(raw);
	if (jsonErr) return fail(jsonErr);

	const obj = raw as Record<string, unknown>;
	if (obj.type !== "provider_proxy") return fail(CODEC_ERRORS.INVALID_FRAME);
	if (typeof obj.proxyType !== "string" || !VALID_PROXY_TYPES.has(obj.proxyType))
		return fail(CODEC_ERRORS.INVALID_FRAME);

	const baseJsonErr = checkJsonSafe({ type: "provider_proxy", proxyType: obj.proxyType, callId: obj.callId });
	if (baseJsonErr) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (typeof obj.callId !== "string" || obj.callId.length === 0) return fail(CODEC_ERRORS.INVALID_FRAME);

	switch (obj.proxyType) {
		case "model_call_request":
			return decodeProxyRequest(obj);
		case "model_call_chunk":
			return decodeProxyChunk(obj);
		case "model_call_complete":
			return decodeProxyComplete(obj);
		case "model_call_error":
			return decodeProxyError(obj);
		case "model_call_cancel":
			return decodeProxyCancel(obj);
		default:
			return fail(CODEC_ERRORS.INVALID_FRAME);
	}
}

// ===========================================================================
// Decoder: RemoteHostHealthFrame
// ===========================================================================

const HEALTH_KEYS = new Set(["type", "healthSeq", "status", "lastReceivedFrameId", "lastReceivedEventSequence"]);

export function decodeHealthFrame(raw: unknown): DecodeResult<RemoteHostHealthFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "health") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!HEALTH_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (!isNonNegativeInt(obj.healthSeq)) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (typeof obj.status !== "string" || !VALID_LINK_STATUSES.has(obj.status as RemoteHostLinkStatus)) {
		return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (obj.lastReceivedFrameId !== undefined && !checkId(obj.lastReceivedFrameId as string))
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (obj.lastReceivedEventSequence !== undefined && !isNonNegativeInt(obj.lastReceivedEventSequence))
		return fail(CODEC_ERRORS.INVALID_FRAME);

	const fresh: RemoteHostHealthFrame = {
		type: "health",
		healthSeq: obj.healthSeq as number,
		status: obj.status as RemoteHostLinkStatus,
	};
	if (typeof obj.lastReceivedFrameId === "string") fresh.lastReceivedFrameId = obj.lastReceivedFrameId;
	if (typeof obj.lastReceivedEventSequence === "number")
		fresh.lastReceivedEventSequence = obj.lastReceivedEventSequence;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostErrorFrame
// ===========================================================================

const ERROR_FRAME_KEYS = new Set(["type", "code", "message", "inReplyTo"]);

export function decodeErrorFrame(raw: unknown): DecodeResult<RemoteHostErrorFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "error") return fail(CODEC_ERRORS.INVALID_FRAME);
	for (const k of Object.keys(obj)) {
		if (!ERROR_FRAME_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	if (typeof obj.code !== "string" || obj.code.length === 0 || obj.code.length > 100)
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (typeof obj.message !== "string" || obj.message.length > 1000) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (obj.inReplyTo !== undefined && !checkId(obj.inReplyTo as string)) return fail(CODEC_ERRORS.INVALID_FRAME);

	const fresh: RemoteHostErrorFrame = { type: "error", code: obj.code as string, message: obj.message as string };
	if (typeof obj.inReplyTo === "string") fresh.inReplyTo = obj.inReplyTo;
	return ok(fresh);
}

// ===========================================================================
// Decoder: RemoteHostFrame (union dispatcher)
// ===========================================================================

export function decodeFrame(raw: unknown): DecodeResult<RemoteHostFrame> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	const obj = raw as Record<string, unknown>;
	if (typeof obj.type !== "string") return fail(CODEC_ERRORS.INVALID_FRAME);
	switch (obj.type) {
		case "handshake":
			return decodeHandshakeFrame(raw);
		case "handshake_ack":
			return decodeHandshakeAckFrame(raw);
		case "command":
			return decodeCommandFrame(raw);
		case "event":
			return decodeEventFrame(raw);
		case "ack":
			return decodeAckFrame(raw);
		case "agent_message":
			return decodeAgentMessageFrame(raw);
		case "provider_proxy":
			return decodeProviderProxyFrame(raw);
		case "health":
			return decodeHealthFrame(raw);
		case "error":
			return decodeErrorFrame(raw);
		default:
			return fail(CODEC_ERRORS.INVALID_FRAME);
	}
}

// ===========================================================================
// Decoder: RemoteHostFrameEnvelope — INDEPENDENT frameId (no event.id check)
// ===========================================================================

const ENVELOPE_KEYS = new Set(["type", "frameId", "protocol", "sentAt", "frame", "lastReceivedEventSequence"]);

export function decodeEnvelope(raw: unknown): DecodeResult<RemoteHostFrameEnvelope> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_ENVELOPE);
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "frame") return fail(CODEC_ERRORS.INVALID_ENVELOPE);
	for (const k of Object.keys(obj)) {
		if (!ENVELOPE_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_ENVELOPE);
	}
	if (!checkId(obj.frameId as string)) return fail(CODEC_ERRORS.INVALID_IDENTITY);

	const protoResult = decodeProtocolInfo(obj.protocol);
	if (!protoResult.ok) return protoResult;

	if (!isCanonicalUtcTimestamp(obj.sentAt as string)) return fail(CODEC_ERRORS.INVALID_TIMESTAMP);

	if (obj.lastReceivedEventSequence !== undefined && !isNonNegativeInt(obj.lastReceivedEventSequence)) {
		return fail(CODEC_ERRORS.INVALID_SEQUENCE);
	}

	const frameResult = decodeFrame(obj.frame);
	if (!frameResult.ok) return frameResult;

	const fresh: RemoteHostFrameEnvelope = {
		type: "frame",
		frameId: obj.frameId as string,
		protocol: protoResult.value,
		sentAt: obj.sentAt as string,
		frame: frameResult.value,
	};
	if (typeof obj.lastReceivedEventSequence === "number") {
		fresh.lastReceivedEventSequence = obj.lastReceivedEventSequence;
	}
	return ok(fresh);
}

// ===========================================================================
// Canonical JSON digest — SHA-256 of sorted-key JSON, DecodeResult
// Rejects symbols, non-enumerables, undefined, nonfinite, non-plain objects
// ===========================================================================

export function safeStableJsonStringify(value: unknown, budget?: JsonBudget): DecodeResult<string> {
	const b = budget ?? {
		nodesRemaining: MAX_JSON_NODES,
		bytesRemaining: MAX_ENCODED_BYTES,
		depthRemaining: MAX_DEPTH,
		encodedSize: 0,
	};
	return safeStableJsonStringifyImpl(value, b);
}

function safeStableJsonStringifyImpl(value: unknown, budget: JsonBudget): DecodeResult<string> {
	if (budget.depthRemaining <= 0) return fail(CODEC_ERRORS.OVERFLOW);
	if (!takeBudget(budget)) return fail(CODEC_ERRORS.OVERFLOW);

	if (value === null) return ok("null");
	if (typeof value === "boolean") return ok(value ? "true" : "false");
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		const s = JSON.stringify(value);
		if (s.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= s.length;
		budget.encodedSize += s.length;
		return ok(s);
	}
	if (typeof value === "string") {
		const s = JSON.stringify(value);
		if (s.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= s.length;
		budget.encodedSize += s.length;
		return ok(s);
	}
	if (Array.isArray(value)) {
		// Reject array holes
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		}
		budget.depthRemaining -= 1;
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			const v = value[i];
			if (v === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST);
			const part = safeStableJsonStringifyImpl(v, budget);
			if (!part.ok) return part;
			parts.push(part.value);
		}
		const result = `[${parts.join(",")}]`;
		return ok(result);
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== null && proto !== Object.prototype) return fail(CODEC_ERRORS.INVALID_DIGEST);
		const descs = Object.getOwnPropertyDescriptors(value);
		const keys = Object.getOwnPropertyNames(value);
		const symbols = Object.getOwnPropertySymbols(value);
		if (symbols.length > 0) return fail(CODEC_ERRORS.INVALID_DIGEST);
		for (const key of keys) {
			if (descs[key].get || descs[key].set) return fail(CODEC_ERRORS.INVALID_DIGEST);
			if (!descs[key].enumerable) return fail(CODEC_ERRORS.INVALID_DIGEST);
		}
		budget.depthRemaining -= 1;
		const sorted = [...keys].sort();
		const pairs: string[] = [];
		for (const k of sorted) {
			const v = (value as Record<string, unknown>)[k];
			if (v === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST); // reject undefined
			const keyPart = safeStableJsonStringifyImpl(k, budget);
			if (!keyPart.ok) return keyPart;
			const valPart = safeStableJsonStringifyImpl(v, budget);
			if (!valPart.ok) return valPart;
			pairs.push(`${keyPart.value}:${valPart.value}`);
		}
		const result = `{${pairs.join(",")}}`;
		return ok(result);
	}
	return fail(CODEC_ERRORS.INVALID_DIGEST);
}

export function canonicalDigest(value: unknown): DecodeResult<string> {
	const canon = safeStableJsonStringify(value);
	if (!canon.ok) return canon;
	const hash = createHash("sha256").update(canon.value).digest("hex");
	return ok(hash);
}

export function digestsEqual(a: string, b: string): boolean {
	return a === b;
}

export function isValidDigest(d: string): boolean {
	return typeof d === "string" && /^[0-9a-f]{64}$/.test(d);
}

// ===========================================================================
// Combined helpers
// ===========================================================================

export function decodeAndDigestCommandBody(
	raw: unknown,
): DecodeResult<{ body: RemoteHostCommandFrameBody; digest: string }> {
	const decoded = decodeCommandBody(raw);
	if (!decoded.ok) return { ok: false, error: decoded.error };
	const digestResult = canonicalDigest(decoded.value);
	if (!digestResult.ok) return { ok: false, error: digestResult.error };
	return ok({ body: decoded.value, digest: digestResult.value });
}

export function decodeAndDigestEventBody(raw: unknown): DecodeResult<{ body: RemoteHostEventBody; digest: string }> {
	const decoded = decodeEventBody(raw);
	if (!decoded.ok) return { ok: false, error: decoded.error };
	const digestResult = canonicalDigest(decoded.value);
	if (!digestResult.ok) return { ok: false, error: digestResult.error };
	return ok({ body: decoded.value, digest: digestResult.value });
}
