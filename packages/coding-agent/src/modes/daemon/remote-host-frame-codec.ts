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
// Closed error codes — codec-specific only
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

export interface CodecError {
	code: CodecErrorCode;
}

// ===========================================================================
// DecodeResult — discriminated union
// ===========================================================================

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: CodecError };

function ok<T>(value: T): DecodeResult<T> {
	return { ok: true, value };
}

function fail(code: CodecErrorCode): DecodeResult<never> {
	return { ok: false, error: { code } };
}

// ===========================================================================
// Budget constants
// ===========================================================================

const MAX_JSON_NODES = 10_000;
const MAX_ENCODED_BYTES = 1_048_576; // 1 MiB
const MAX_DEPTH = 64;

// ===========================================================================
// Canonical byte-length preflight for exact canonical JSON
//
// Counts UTF-8 bytes of the sorted-key canonical representation including
// all syntax characters (quotes, commas, colons, brackets, braces) without
// building the string. Shares node budget. Rejects nodes/bytes/depth overflow.
// Recursion depth tracks the stack of nested containers; siblings at the
// same depth share the same depth value and do not consume extra depth.
// ===========================================================================

interface PreflightBudget {
	nodesRemaining: number;
	bytesRemaining: number;
}

function preflightCanonicalUtf8Bytes(value: unknown, depth: number, budget: PreflightBudget): DecodeResult<number> {
	if (depth > MAX_DEPTH) return fail(CODEC_ERRORS.OVERFLOW);
	if (budget.nodesRemaining <= 0) return fail(CODEC_ERRORS.OVERFLOW);
	budget.nodesRemaining -= 1;

	if (value === null) {
		const s = "null";
		if (s.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= s.length;
		return ok(4); // "null"
	}
	if (typeof value === "boolean") {
		const s = value ? "true" : "false";
		if (s.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= s.length;
		return ok(s.length);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		const s = JSON.stringify(value);
		if (s.length > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= s.length;
		return ok(s.length);
	}
	if (typeof value === "string") {
		const quoted = JSON.stringify(value);
		const bytes = Buffer.byteLength(quoted, "utf-8");
		if (bytes > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= bytes;
		return ok(bytes);
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		}
		let total = 2; // []
		for (let i = 0; i < value.length; i++) {
			if (value[i] === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST);
			if (i > 0) total += 1; // comma
			const elem = preflightCanonicalUtf8Bytes(value[i], depth + 1, budget);
			if (!elem.ok) return elem;
			total += elem.value;
		}
		if (total > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= total;
		return ok(total);
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
		const sorted = [...keys].sort();
		let total = 2; // {}
		for (let i = 0; i < sorted.length; i++) {
			if (i > 0) total += 1; // comma
			const k = sorted[i];
			const v = (value as Record<string, unknown>)[k];
			if (v === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST);
			// key: quoted + colon
			const quotedKey = JSON.stringify(k);
			const keyBytes = Buffer.byteLength(quotedKey, "utf-8");
			if (keyBytes > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
			budget.bytesRemaining -= keyBytes;
			total += keyBytes + 1; // key bytes + colon
			// value
			const val = preflightCanonicalUtf8Bytes(v, depth + 1, budget);
			if (!val.ok) return val;
			total += val.value;
		}
		if (total > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= total;
		return ok(total);
	}
	return fail(CODEC_ERRORS.INVALID_DIGEST);
}

// ===========================================================================
// JSON input preflight — validates JSON-safety AND counts canonical bytes
// Combines checkJsonSafe semantics with exact byte counting.
// Rejects prototypes, accessors, symbols, non-enumerable, undefined, holes,
// nonfinite, over node/byte/depth budget. Returns running byte count.
// ===========================================================================

interface JsonPreflightBudget {
	nodesRemaining: number;
	bytesRemaining: number;
}

function jsonSafePreflight(
	value: unknown,
	depth: number,
	budget: JsonPreflightBudget,
	countCanonicalBytes: boolean,
): DecodeResult<number> {
	if (depth > MAX_DEPTH) return fail(CODEC_ERRORS.OVERFLOW);
	if (budget.nodesRemaining <= 0) return fail(CODEC_ERRORS.OVERFLOW);
	budget.nodesRemaining -= 1;

	if (value === null) {
		const byteCost = countCanonicalBytes ? 4 : 0; // "null"
		if (countCanonicalBytes && byteCost > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= byteCost;
		return ok(byteCost);
	}
	if (typeof value === "boolean") {
		const s = value ? "true" : "false";
		const byteCost = countCanonicalBytes ? s.length : 0;
		if (countCanonicalBytes && byteCost > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= byteCost;
		return ok(byteCost);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		const s = JSON.stringify(value);
		const byteCost = countCanonicalBytes ? s.length : 0;
		if (countCanonicalBytes && byteCost > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= byteCost;
		return ok(byteCost);
	}
	if (typeof value === "string") {
		const quoted = JSON.stringify(value);
		const byteCost = countCanonicalBytes ? Buffer.byteLength(quoted, "utf-8") : 0;
		if (countCanonicalBytes && byteCost > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= byteCost;
		return ok(byteCost);
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		}
		let total = countCanonicalBytes ? 2 : 0; // []
		for (let i = 0; i < value.length; i++) {
			if (value[i] === undefined) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
			if (countCanonicalBytes && i > 0) total += 1; // comma
			const elem = jsonSafePreflight(value[i], depth + 1, budget, countCanonicalBytes);
			if (!elem.ok) return elem;
			if (countCanonicalBytes) total += elem.value;
		}
		if (countCanonicalBytes && total > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= total;
		return ok(total);
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== null && proto !== Object.prototype) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		const descs = Object.getOwnPropertyDescriptors(value);
		const keys = Object.getOwnPropertyNames(value);
		const symbols = Object.getOwnPropertySymbols(value);
		if (symbols.length > 0) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		for (const key of keys) {
			const desc = descs[key];
			if (desc.get || desc.set) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
			if (!desc.enumerable) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		}
		const sorted = [...keys].sort();
		let total = countCanonicalBytes ? 2 : 0; // {}
		for (let i = 0; i < sorted.length; i++) {
			if (countCanonicalBytes && i > 0) total += 1; // comma
			const k = sorted[i];
			const v = (value as Record<string, unknown>)[k];
			if (v === undefined) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
			if (countCanonicalBytes) {
				const quotedKey = JSON.stringify(k);
				total += Buffer.byteLength(quotedKey, "utf-8") + 1; // key bytes + colon
			}
			const val = jsonSafePreflight(v, depth + 1, budget, countCanonicalBytes);
			if (!val.ok) return val;
			if (countCanonicalBytes) total += val.value;
		}
		if (countCanonicalBytes && total > budget.bytesRemaining) return fail(CODEC_ERRORS.OVERFLOW);
		budget.bytesRemaining -= total;
		return ok(total);
	}
	return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
}

/**
 * Full preflight: validates JSON safety AND computes exact canonical byte count.
 */
export function jsonPreflight(value: unknown, countCanonicalBytes: boolean = true): DecodeResult<number> {
	const budget: JsonPreflightBudget = { nodesRemaining: MAX_JSON_NODES, bytesRemaining: MAX_ENCODED_BYTES };
	return jsonSafePreflight(value, 0, budget, countCanonicalBytes);
}

/**
 * Validate JSON safety only (no byte counting).
 */
export function checkJsonSafe(value: unknown): CodecErrorCode | undefined {
	const budget: JsonPreflightBudget = { nodesRemaining: MAX_JSON_NODES, bytesRemaining: MAX_ENCODED_BYTES };
	const result = jsonSafePreflight(value, 0, budget, false);
	return result.ok ? undefined : result.error.code;
}

// ===========================================================================
// String / ID helpers
// ===========================================================================

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidSafeId(id: string): boolean {
	return SAFE_ID_RE.test(id);
}

function checkId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= 128 && SAFE_ID_RE.test(v);
}

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
// Canonical strict UTC timestamp
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
// Plain-object guard
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	if (proto !== null && proto !== Object.prototype) return false;
	const descs = Object.getOwnPropertyDescriptors(v);
	const keys = Object.getOwnPropertyNames(v);
	const symbols = Object.getOwnPropertySymbols(v);
	if (symbols.length > 0) return false;
	for (const key of keys) {
		const desc = descs[key];
		if (desc.get || desc.set) return false;
		if (!desc.enumerable) return false;
	}
	for (const key of keys) {
		if ((v as Record<string, unknown>)[key] === undefined) return false;
	}
	return true;
}

// ===========================================================================
// ArtifactRef
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
// ProtocolInfo
// ===========================================================================

const PROTO_KEYS = new Set(["name", "version"]);

export function decodeProtocolInfo(raw: unknown): DecodeResult<RemoteHostProtocolInfo> {
	if (!isPlainObject(raw)) return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	const obj = raw as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!PROTO_KEYS.has(k)) return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	}
	if (obj.name !== REMOTE_HOST_PROTOCOL_NAME || typeof obj.name !== "string")
		return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	if (
		obj.version !== REMOTE_HOST_PROTOCOL_VERSION ||
		typeof obj.version !== "number" ||
		!Number.isSafeInteger(obj.version)
	)
		return fail(CODEC_ERRORS.INVALID_PROTOCOL);
	return ok({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION });
}

// ===========================================================================
// BuildIdentity
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
	if (typeof obj.buildId !== "string" || obj.buildId.length === 0 || obj.buildId.length > 128)
		return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isNonNegativeInt(obj.daemonProtocolVersion)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (!isNonNegativeInt(obj.daemonSchemaRevision)) return fail(CODEC_ERRORS.INVALID_IDENTITY);
	if (obj.appVersion !== undefined && (typeof obj.appVersion !== "string" || obj.appVersion.length > 64))
		return fail(CODEC_ERRORS.INVALID_IDENTITY);
	const fresh: RemoteHostBuildIdentity = {
		buildId: obj.buildId as string,
		daemonProtocolVersion: obj.daemonProtocolVersion as number,
		daemonSchemaRevision: obj.daemonSchemaRevision as number,
	};
	if (typeof obj.appVersion === "string") fresh.appVersion = obj.appVersion;
	return ok(fresh);
}

// ===========================================================================
// EventCursor
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
// Capabilities arrays
// ===========================================================================

function decodeCapabilities(raw: unknown): DecodeResult<RemoteHostCapability[]> {
	if (!Array.isArray(raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.length > 50) return fail(CODEC_ERRORS.INVALID_FRAME);
	for (let i = 0; i < raw.length; i++) {
		if (!(i in raw)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}
	const seen = new Set<string>();
	const result: RemoteHostCapability[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return fail(CODEC_ERRORS.INVALID_FRAME);
		if (!VALID_CAPABILITIES.has(item as RemoteHostCapability)) return fail(CODEC_ERRORS.INVALID_FRAME);
		if (seen.has(item)) return fail(CODEC_ERRORS.INVALID_FRAME);
		seen.add(item);
		result.push(item as RemoteHostCapability);
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
		if (!VALID_CLIENT_CAPABILITIES.has(item as RemoteHostClientCapability)) return fail(CODEC_ERRORS.INVALID_FRAME);
		if (seen.has(item)) return fail(CODEC_ERRORS.INVALID_FRAME);
		seen.add(item);
		result.push(item as RemoteHostClientCapability);
	}
	return ok(result);
}

// ===========================================================================
// JsonValue decoder — constructs fresh with budget
// ===========================================================================

export function decodeJsonValue(raw: unknown): DecodeResult<JsonValue> {
	return decodeJsonValueInner(raw, 0, { nodesRemaining: MAX_JSON_NODES, bytesRemaining: MAX_ENCODED_BYTES });
}

function decodeJsonValueInner(raw: unknown, depth: number, budget: JsonPreflightBudget): DecodeResult<JsonValue> {
	if (depth > MAX_DEPTH) return fail(CODEC_ERRORS.OVERFLOW);
	if (budget.nodesRemaining <= 0) return fail(CODEC_ERRORS.OVERFLOW);
	budget.nodesRemaining -= 1;

	if (raw === null) return ok(null);
	if (typeof raw === "boolean") return ok(raw);
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		return ok(raw);
	}
	if (typeof raw === "string") return ok(raw);
	if (Array.isArray(raw)) {
		for (let i = 0; i < raw.length; i++) {
			if (!(i in raw)) return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
		}
		const arr: JsonValue[] = [];
		for (let i = 0; i < raw.length; i++) {
			const elem = decodeJsonValueInner(raw[i], depth + 1, budget);
			if (!elem.ok) return elem;
			arr.push(elem.value);
		}
		return ok(arr);
	}
	if (isPlainObject(raw)) {
		const obj = raw as Record<string, unknown>;
		const result: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(obj).sort()) {
			const val = decodeJsonValueInner(obj[key], depth + 1, budget);
			if (!val.ok) return val;
			result[key] = val.value;
		}
		return ok(result);
	}
	return fail(CODEC_ERRORS.INVALID_COMMAND_BODY);
}

// ===========================================================================
// Command body decoder
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
// Event body decoder
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
// HandshakeFrame
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
	if (typeof obj.direction !== "string" || !VALID_DIRECTIONS.has(obj.direction as RemoteHostLinkDirection))
		return fail(CODEC_ERRORS.INVALID_FRAME);
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
// HandshakeAckFrame
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
// CommandFrame
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
// EventFrame
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
// AckFrame
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
// AgentMessageFrame
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
	)
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (
		obj.deliveryMode !== undefined &&
		(typeof obj.deliveryMode !== "string" || !VALID_DELIVERY_MODES.has(obj.deliveryMode))
	)
		return fail(CODEC_ERRORS.INVALID_FRAME);
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
// ProviderProxyFrame (5 variants — fresh DTO)
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

	// Reject wrong-type optional fields
	if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== "string") return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.maxTokens !== undefined && !isPositiveInt(raw.maxTokens)) return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.temperature !== undefined && (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)))
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (raw.thinkingLevel !== undefined && typeof raw.thinkingLevel !== "string")
		return fail(CODEC_ERRORS.INVALID_FRAME);
	if (
		raw.streamingBehavior !== undefined &&
		(typeof raw.streamingBehavior !== "string" || !VALID_STREAMING_BEHAVIORS.has(raw.streamingBehavior))
	)
		return fail(CODEC_ERRORS.INVALID_FRAME);

	// tools must be Array before decoding
	if (raw.tools !== undefined) {
		if (!Array.isArray(raw.tools)) return fail(CODEC_ERRORS.INVALID_FRAME);
	}

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
	if (typeof raw.maxTokens === "number") fresh.maxTokens = raw.maxTokens;
	if (typeof raw.temperature === "number") fresh.temperature = raw.temperature;
	if (typeof raw.thinkingLevel === "string") fresh.thinkingLevel = raw.thinkingLevel;
	if (typeof raw.streamingBehavior === "string")
		fresh.streamingBehavior = raw.streamingBehavior as "steer" | "followUp";
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
		if (typeof usage.inputTokens !== "number" || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0)
			return fail(CODEC_ERRORS.INVALID_FRAME);
		if (typeof usage.outputTokens !== "number" || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0)
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
	if (typeof raw.error !== "string" || raw.error.length === 0 || Buffer.byteLength(raw.error, "utf-8") > 1000)
		return fail(CODEC_ERRORS.INVALID_FRAME);
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
// HealthFrame
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
	if (typeof obj.status !== "string" || !VALID_LINK_STATUSES.has(obj.status as RemoteHostLinkStatus))
		return fail(CODEC_ERRORS.INVALID_FRAME);
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
// ErrorFrame
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
// Frame union dispatcher
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
// Envelope — with total-size preflight
// ===========================================================================

const ENVELOPE_KEYS = new Set(["type", "frameId", "protocol", "sentAt", "frame", "lastReceivedEventSequence"]);

/**
 * Check that a known-good envelope object (freshly decoded) fits within
 * the 1 MiB canonical byte budget. Run the preflight on the raw input
 * before constructing fresh DTOs to reject oversized payloads early.
 */
export function preflightEnvelope(raw: unknown): DecodeResult<void> {
	const result = jsonPreflight(raw, true);
	if (!result.ok) return { ok: false, error: result.error };
	if (result.value > MAX_ENCODED_BYTES) return fail(CODEC_ERRORS.OVERFLOW);
	return ok(undefined);
}

export function decodeEnvelope(raw: unknown): DecodeResult<RemoteHostFrameEnvelope> {
	// Preflight the raw input before any decoding
	const preflightResult = preflightEnvelope(raw);
	if (!preflightResult.ok) return { ok: false, error: preflightResult.error };

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
	if (obj.lastReceivedEventSequence !== undefined && !isNonNegativeInt(obj.lastReceivedEventSequence))
		return fail(CODEC_ERRORS.INVALID_SEQUENCE);
	const frameResult = decodeFrame(obj.frame);
	if (!frameResult.ok) return frameResult;
	const fresh: RemoteHostFrameEnvelope = {
		type: "frame",
		frameId: obj.frameId as string,
		protocol: protoResult.value,
		sentAt: obj.sentAt as string,
		frame: frameResult.value,
	};
	if (typeof obj.lastReceivedEventSequence === "number")
		fresh.lastReceivedEventSequence = obj.lastReceivedEventSequence;
	return ok(fresh);
}

// ===========================================================================
// Canonical JSON digest — SHA-256 with preflight
// ===========================================================================

export function canonicalDigest(value: unknown): DecodeResult<string> {
	// Preflight first
	const budget: PreflightBudget = { nodesRemaining: MAX_JSON_NODES, bytesRemaining: MAX_ENCODED_BYTES };
	const pre = preflightCanonicalUtf8Bytes(value, 0, budget);
	if (!pre.ok) return { ok: false, error: pre.error };

	// Now encode, guaranteed bounded
	const canon = buildCanonicalString(value, 0);
	if (!canon.ok) return canon;
	const hash = createHash("sha256").update(canon.value, "utf-8").digest("hex");
	return ok(hash);
}

function buildCanonicalString(value: unknown, depth: number): DecodeResult<string> {
	if (depth > MAX_DEPTH) return fail(CODEC_ERRORS.OVERFLOW);
	if (value === null) return ok("null");
	if (typeof value === "boolean") return ok(value ? "true" : "false");
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		return ok(JSON.stringify(value));
	}
	if (typeof value === "string") return ok(JSON.stringify(value));
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) return fail(CODEC_ERRORS.INVALID_DIGEST);
		}
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			if (value[i] === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST);
			const part = buildCanonicalString(value[i], depth + 1);
			if (!part.ok) return part;
			parts.push(part.value);
		}
		return ok(`[${parts.join(",")}]`);
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
		const sorted = [...keys].sort();
		const pairs: string[] = [];
		for (const k of sorted) {
			const v = (value as Record<string, unknown>)[k];
			if (v === undefined) return fail(CODEC_ERRORS.INVALID_DIGEST);
			const valStr = buildCanonicalString(v, depth + 1);
			if (!valStr.ok) return valStr;
			pairs.push(`${JSON.stringify(k)}:${valStr.value}`);
		}
		const result = `{${pairs.join(",")}}`;
		return ok(result);
	}
	return fail(CODEC_ERRORS.INVALID_DIGEST);
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
