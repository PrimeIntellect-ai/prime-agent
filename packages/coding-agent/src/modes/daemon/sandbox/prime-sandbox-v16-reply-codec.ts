// V16 Reply Codec — Hosted Controller V16 Canonical Reply Sanitizer & Codec
// Public API: encodeReply(methodRaw, rawControllerOutput, identityRaw), decodeReply(input, expectedMethod, expectedIdentity).
// Outer wire: {body, execution, identity, method, version} — lexical insertion order.
// Zero casts, zero any, zero spread, zero non-null assertion, zero as const, zero explicit throws, zero instanceof.

import * as util from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// ---------- captured intrinsics (module-init, never rebound) ----------

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _keys: typeof Object.keys = Object.keys;
const _freeze: typeof Object.freeze = Object.freeze;
const _create: typeof Object.create = Object.create;
const _defineProperty: typeof Object.defineProperty = Object.defineProperty;
const _JSON_parse: typeof JSON.parse = JSON.parse;
const _JSON_stringify: typeof JSON.stringify = JSON.stringify;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _isFinite: typeof Number.isFinite = Number.isFinite;
const _isProxy: (value: object) => boolean = util.types.isProxy;

const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const _encode: (input?: string) => Uint8Array = TEXT_ENCODER.encode.bind(TEXT_ENCODER);
const _decodeFatal: (input: Uint8Array) => string = TEXT_DECODER_FATAL.decode.bind(TEXT_DECODER_FATAL);

// ---------- constants ----------

const MAX_REPLY_BYTES: number = 262128;
const MAX_NAME_UTF8_BYTES: number = 256;
const MAX_MESSAGE_PREVIEWS: number = 50;
const MAX_MESSAGE_PREVIEW_CHARS: number = 2048;
const DEPTH_MAX: number = 255;
const ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// ---------- error types ----------

type V16ReplyEncodeFailureCode = "INPUT_INVALID" | "INPUT_TOO_LARGE" | "UNKNOWN_METHOD";
type V16ReplyDecodeFailureCode =
	| "INPUT_INVALID"
	| "INPUT_TOO_LARGE"
	| "FRAME_ERROR"
	| "UTF8_ERROR"
	| "METHOD_MISMATCH"
	| "IDENTITY_MISMATCH";

interface V16ReplyEncodeSuccess {
	readonly ok: true;
	readonly bytes: Uint8Array;
}
interface V16ReplyEncodeFailure {
	readonly ok: false;
	readonly code: V16ReplyEncodeFailureCode;
}
type V16ReplyEncodeResult = V16ReplyEncodeSuccess | V16ReplyEncodeFailure;

interface V16ReplyDecodeCorrelated {
	readonly ok: true;
	readonly reply: V16DecodedReply;
}
interface V16ReplyDecodeFailure {
	readonly ok: false;
	readonly code: V16ReplyDecodeFailureCode;
}
type V16ReplyDecodeResult = V16ReplyDecodeCorrelated | V16ReplyDecodeFailure;

// ---------- method union ----------

type V16Method =
	| "list_agents"
	| "roster"
	| "await_pending"
	| "assert_name"
	| "set_name"
	| "send_message"
	| "observe_list"
	| "observe_get"
	| "observe_recent";

// ---------- canonical reply body types ----------

interface V16ReplyEndpoint {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly runtimeKind?: "top-level" | "subagent";
}

interface V16ReplyAgentSummary {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly runtimeKind?: "top-level" | "subagent";
	readonly isStreaming: boolean;
	readonly unfinishedActionCount: number;
	readonly parentActiveSessionId?: string;
	readonly rlmChildId?: string;
	readonly rlmDepth?: number;
	readonly parentSessionId?: string;
	readonly status?: "running" | "idle" | "inactive";
	readonly rlmChildRegistryStatus?: "running" | "completed" | "deleted";
}

interface V16ReplyListAgentsBody {
	readonly current?: V16ReplyEndpoint;
	readonly agents: ReadonlyArray<V16ReplyAgentSummary>;
}

interface V16ReplyRosterEntry {
	readonly relationship: "parent" | "sibling" | "child";
	readonly name: string;
	readonly id: string;
	readonly depth: number;
	readonly status: "running" | "idle" | "inactive";
	readonly repliedSinceTask?: boolean;
}

interface V16ReplyRosterBody {
	readonly current: { readonly name: string; readonly id: string; readonly depth: number };
	readonly entries: ReadonlyArray<V16ReplyRosterEntry>;
}

type V16ReplyAwaitPendingBody = string | null;

interface V16ReplyEmptyBody extends Record<string, never> {}

interface V16ReplyReceiptTarget {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly runtimeKind?: "top-level" | "subagent";
}

interface V16ReplyReceiptSender {
	readonly activeSessionId?: string;
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly runtimeKind?: "top-level" | "subagent";
	readonly clientId?: string;
}

interface V16ReplySendMessageBody {
	readonly id: string;
	readonly source: "agent_message";
	readonly target: V16ReplyReceiptTarget;
	readonly from?: V16ReplyReceiptSender;
	readonly fromRelationship?: "parent" | "sibling" | "child";
	readonly message: string;
	readonly deliveryStatus: "delivered" | "queued";
	readonly deliveredAt?: string;
	readonly queuedAt?: string;
	readonly deliveryMode?: "steer";
}

interface V16ReplyObserveAgentSummary {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly runtimeKind?: "top-level" | "subagent";
	readonly status: string;
	readonly isCurrent: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly attachedClients: number;
	readonly messageCount: number;
	readonly queuedCount: number;
	readonly isSessionActive: boolean;
	readonly parentActiveSessionId?: string;
	readonly parentSessionId?: string;
	readonly rlmChildId?: string;
	readonly rlmParentNodeId?: string;
	readonly firstMessage?: string;
	readonly latestMessage?: V16ReplyMessagePreview;
}

interface V16ReplyMessagePreview {
	readonly index: number;
	readonly role: string;
	readonly timestamp?: number;
	readonly text: string;
	readonly truncated: boolean;
	readonly toolCalls?: ReadonlyArray<string>;
	readonly customType?: string;
}

interface V16ReplyObserveListBody {
	readonly current: V16ReplyObserveAgentSummary;
	readonly agents: ReadonlyArray<V16ReplyObserveAgentSummary>;
}

interface V16ReplyObserveGetBody {
	readonly agent: V16ReplyObserveAgentSummary;
}

interface V16ReplyObserveRecentBody {
	readonly agent: V16ReplyObserveAgentSummary;
	readonly messages: ReadonlyArray<V16ReplyMessagePreview>;
	readonly limit: number;
	readonly maxChars: number;
	readonly truncated: boolean;
}

interface V16ReplyErrorBody {
	readonly error: "CONTROLLER_FAILURE" | "METHOD_UNAVAILABLE";
}

// ---------- outer wire interfaces ----------

interface V16WireExecution {
	readonly type: "prime-sandbox";
}

interface V16WireIdentity {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly rlmChildId: string;
	readonly depth: number;
	readonly sessionName: string;
}

// ---------- union of all decoded reply bodies ----------

type V16ReplyBody =
	| V16ReplyListAgentsBody
	| V16ReplyRosterBody
	| V16ReplyAwaitPendingBody
	| V16ReplyEmptyBody
	| V16ReplySendMessageBody
	| V16ReplyObserveListBody
	| V16ReplyObserveGetBody
	| V16ReplyObserveRecentBody
	| V16ReplyErrorBody;

// ---------- decoded reply union ----------

interface V16DecodedReply {
	readonly body: V16ReplyBody;
	readonly execution: V16WireExecution;
	readonly identity: V16WireIdentity;
	readonly method: V16Method;
	readonly version: 1;
}

// ---------- capture descriptors helper ----------

interface DescriptorTable {
	readonly table: Record<string, PropertyDescriptor>;
	readonly names: ReadonlyArray<string>;
}

function captureDescriptors(value: object): DescriptorTable | undefined {
	let proto: object | null;
	try {
		proto = _getPrototypeOf(value);
	} catch {
		return undefined;
	}
	if (proto !== Object.prototype && proto !== null) {
		return undefined;
	}
	let isProxy: boolean;
	try {
		isProxy = _isProxy(value);
	} catch {
		return undefined;
	}
	if (isProxy) {
		return undefined;
	}
	let ownNames: string[];
	try {
		ownNames = _getOwnPropertyNames(value);
	} catch {
		return undefined;
	}
	let ownSymbols: symbol[];
	try {
		ownSymbols = _getOwnPropertySymbols(value);
	} catch {
		return undefined;
	}
	if (ownSymbols.length !== 0) {
		return undefined;
	}
	const table: Record<string, PropertyDescriptor> = {};
	for (let i: number = 0; i < ownNames.length; i++) {
		const name: string = ownNames[i];
		let desc: PropertyDescriptor | undefined;
		try {
			desc = _getOwnPropertyDescriptor(value, name);
		} catch {
			return undefined;
		}
		if (desc === undefined) {
			return undefined;
		}
		if (desc.get !== undefined || desc.set !== undefined) {
			return undefined;
		}
		table[name] = desc;
	}
	return { table: table, names: _freeze(ownNames) };
}

function captureExactKeysOrdered(
	value: object,
	expected: ReadonlyArray<string>,
): Record<string, PropertyDescriptor> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== expected.length) {
		return undefined;
	}
	for (let i: number = 0; i < expected.length; i++) {
		if (ct.names[i] !== expected[i]) {
			return undefined;
		}
	}
	return ct.table;
}

// ---------- scalar validators ----------

function isRecord(value: unknown): value is object {
	if (typeof value !== "object") {
		return false;
	}
	if (value === null) {
		return false;
	}
	return true;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isSafeInteger(value: unknown): value is number {
	if (typeof value !== "number") {
		return false;
	}
	return _isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
	if (typeof value !== "number") {
		return false;
	}
	return _isFinite(value);
}

function isValidId(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	return ID_PATTERN.test(value);
}

function isValidDepth(value: unknown): value is number {
	if (!isSafeInteger(value)) {
		return false;
	}
	if (value < 0 || value > DEPTH_MAX) {
		return false;
	}
	return true;
}

function acceptErrorBody(raw: unknown, method: V16Method): V16ReplyErrorBody | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== 1 || ct.names[0] !== "error") {
		return undefined;
	}
	const errDesc: PropertyDescriptor | undefined = ct.table.error;
	if (errDesc === undefined) {
		return undefined;
	}
	const err: unknown = errDesc.value;
	if (err === "CONTROLLER_FAILURE") {
		const result: V16ReplyErrorBody = { error: "CONTROLLER_FAILURE" };
		return _freeze(result);
	}
	if (err === "METHOD_UNAVAILABLE") {
		if (!isMethodUnavailableAllowed(method)) {
			return undefined;
		}
		const result: V16ReplyErrorBody = { error: "METHOD_UNAVAILABLE" };
		return _freeze(result);
	}
	return undefined;
}

function validateUtf8Max(value: string, maxBytes: number): boolean {
	let count: number = 0;
	const len: number = value.length;
	for (let i: number = 0; i < len; i++) {
		const cc: number = value.charCodeAt(i);
		if (cc <= 0x7f) {
			count += 1;
		} else if (cc <= 0x7ff) {
			count += 2;
		} else if (cc >= 0xd800 && cc <= 0xdbff) {
			if (i + 1 < len) {
				const next: number = value.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					count += 4;
					i += 1;
				} else {
					count += 3;
				}
			} else {
				count += 3;
			}
		} else {
			count += 3;
		}
	}
	return count <= maxBytes;
}

// ---------- setField helper (no cast, no spread) ----------

function setField<T extends object, K extends string, V>(obj: T, key: K, value: V): void {
	_defineProperty(obj, key, {
		value: value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

// ---------- method helper (no as const, no array) ----------

function isV16Method(value: string): value is V16Method {
	if (value === "list_agents") return true;
	if (value === "roster") return true;
	if (value === "await_pending") return true;
	if (value === "assert_name") return true;
	if (value === "set_name") return true;
	if (value === "send_message") return true;
	if (value === "observe_list") return true;
	if (value === "observe_get") return true;
	if (value === "observe_recent") return true;
	return false;
}

// ---------- error body binding rules ----------

function isMethodUnavailableAllowed(method: V16Method): boolean {
	if (method === "roster") return true;
	if (method === "await_pending") return true;
	if (method === "assert_name") return true;
	if (method === "set_name") return true;
	return false;
}

// ---------- encode reply ----------
// Public API: encodeReply(methodRaw, rawControllerOutput, identityRaw)
// Home constructs execution/version/identity. identityRaw is exact own-data with NO extras.

function encodeReply(methodRaw: unknown, rawControllerOutput: unknown, identityRaw: unknown): V16ReplyEncodeResult {
	if (!isString(methodRaw)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	if (!isV16Method(methodRaw)) {
		return unsafeEncodeFailure("UNKNOWN_METHOD");
	}
	const method: V16Method = methodRaw;

	if (!isRecord(identityRaw)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	const idDescs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(
		identityRaw,
		_freeze(["activeSessionId", "sessionId", "rlmChildId", "depth", "sessionName"]),
	);
	if (idDescs === undefined) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	const asi: unknown = idDescs.activeSessionId.value;
	const si: unknown = idDescs.sessionId.value;
	const rlm: unknown = idDescs.rlmChildId.value;
	const depth: unknown = idDescs.depth.value;
	const name: unknown = idDescs.sessionName.value;
	if (!isValidId(asi) || !isValidId(si) || !isValidId(rlm)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	if (!isValidDepth(depth)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	if (!isString(name)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}
	if (!validateUtf8Max(name, MAX_NAME_UTF8_BYTES)) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}

	const identity: V16WireIdentity = _freeze({
		activeSessionId: asi,
		sessionId: si,
		rlmChildId: rlm,
		depth: depth,
		sessionName: name,
	});

	// Validate and sanitize body from rawControllerOutput per method
	const body: V16ReplyBody | undefined = sanitizeBody(method, rawControllerOutput);
	if (body === undefined) {
		return unsafeEncodeFailure("INPUT_INVALID");
	}

	// Build wire in lexical order: body, execution, identity, method, version
	const wire: Record<string, unknown> = _create(null);
	wire.body = body;
	wire.execution = _freeze({ type: "prime-sandbox" });
	wire.identity = identity;
	wire.method = method;
	wire.version = 1;

	const json: string = _JSON_stringify(wire);
	const bytes: Uint8Array = _encode(json);
	if (bytes.length > MAX_REPLY_BYTES) {
		return unsafeEncodeFailure("INPUT_TOO_LARGE");
	}
	return _freeze({ ok: true, bytes: bytes });
}

function unsafeEncodeFailure(code: V16ReplyEncodeFailureCode): V16ReplyEncodeFailure {
	return _freeze({ ok: false, code: code });
}

// ---------- encode body sanitizers ----------

// Path field names that are silently omitted from encoded output
function isPathField(name: string): boolean {
	if (name === "cwd") return true;
	if (name === "sessionDir") return true;
	if (name === "sessionPath") return true;
	if (name === "parentSessionPath") return true;
	if (name === "url") return true;
	if (name === "provider") return true;
	if (name === "logoUrl") return true;
	return false;
}

function sanitizeBody(method: V16Method, raw: unknown): V16ReplyBody | undefined {
	switch (method) {
		case "list_agents":
			return sanitizeListAgentsBody(raw, method);
		case "roster":
			return sanitizeRosterBody(raw, method);
		case "await_pending":
			return sanitizeAwaitPendingBody(raw, method);
		case "assert_name":
			return sanitizeEmptyOrErrorBody(raw, method);
		case "set_name":
			return sanitizeEmptyOrErrorBody(raw, method);
		case "send_message":
			return sanitizeSendMessageBody(raw, method);
		case "observe_list":
			return sanitizeObserveListBody(raw, method);
		case "observe_get":
			return sanitizeObserveGetBody(raw, method);
		case "observe_recent":
			return sanitizeObserveRecentBody(raw, method);
	}
}

// For assert_name/set_name: accept {} or error body
function sanitizeEmptyOrErrorBody(raw: unknown, method: V16Method): V16ReplyEmptyBody | V16ReplyErrorBody | undefined {
	if (raw === null || raw === undefined) {
		return _freeze({});
	}
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length === 0) {
		return _freeze({});
	}
	return undefined;
}

function sanitizeEndpoint(raw: object): V16ReplyEndpoint | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (name !== "activeSessionId" && name !== "sessionId" && name !== "sessionName" && name !== "runtimeKind") {
			return undefined;
		}
	}
	const activeSessionIdDesc: PropertyDescriptor | undefined = ct.table.activeSessionId;
	const sessionIdDesc: PropertyDescriptor | undefined = ct.table.sessionId;
	if (activeSessionIdDesc === undefined || sessionIdDesc === undefined) {
		return undefined;
	}
	const activeSessionId: unknown = activeSessionIdDesc.value;
	const sessionId: unknown = sessionIdDesc.value;
	if (!isString(activeSessionId) || !isString(sessionId)) {
		return undefined;
	}
	if (!validateUtf8Max(activeSessionId, MAX_NAME_UTF8_BYTES) || !validateUtf8Max(sessionId, MAX_NAME_UTF8_BYTES)) {
		return undefined;
	}
	const result: V16ReplyEndpoint = {
		activeSessionId: activeSessionId,
		sessionId: sessionId,
	};
	const sessionNameDesc: PropertyDescriptor | undefined = ct.table.sessionName;
	if (sessionNameDesc !== undefined) {
		const v: unknown = sessionNameDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
			return undefined;
		}
		setField(result, "sessionName", v);
	}
	const runtimeKindDesc: PropertyDescriptor | undefined = ct.table.runtimeKind;
	if (runtimeKindDesc !== undefined) {
		const v: unknown = runtimeKindDesc.value;
		if (v !== "top-level" && v !== "subagent") {
			return undefined;
		}
		setField(result, "runtimeKind", v);
	}
	return result;
}

function sanitizeAgentSummary(raw: object): V16ReplyAgentSummary | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (
			name === "activeSessionId" ||
			name === "sessionId" ||
			name === "sessionName" ||
			name === "runtimeKind" ||
			name === "isStreaming" ||
			name === "unfinishedActionCount" ||
			name === "parentActiveSessionId" ||
			name === "rlmChildId" ||
			name === "rlmDepth" ||
			name === "parentSessionId" ||
			name === "status" ||
			name === "rlmChildRegistryStatus"
		) {
			continue;
		}
		if (isPathField(name)) {
			continue;
		}
		return undefined;
	}
	const activeSessionIdDesc: PropertyDescriptor | undefined = ct.table.activeSessionId;
	const sessionIdDesc: PropertyDescriptor | undefined = ct.table.sessionId;
	const isStreamingDesc: PropertyDescriptor | undefined = ct.table.isStreaming;
	const unfinishedActionCountDesc: PropertyDescriptor | undefined = ct.table.unfinishedActionCount;
	if (
		activeSessionIdDesc === undefined ||
		sessionIdDesc === undefined ||
		isStreamingDesc === undefined ||
		unfinishedActionCountDesc === undefined
	) {
		return undefined;
	}
	const activeSessionId: unknown = activeSessionIdDesc.value;
	const sessionId: unknown = sessionIdDesc.value;
	const isStreaming: unknown = isStreamingDesc.value;
	const unfinishedActionCount: unknown = unfinishedActionCountDesc.value;
	if (
		!isString(activeSessionId) ||
		!isString(sessionId) ||
		!isBoolean(isStreaming) ||
		!isSafeInteger(unfinishedActionCount)
	) {
		return undefined;
	}
	if (unfinishedActionCount < 0) {
		return undefined;
	}
	const result: V16ReplyAgentSummary = {
		activeSessionId: activeSessionId,
		sessionId: sessionId,
		isStreaming: isStreaming,
		unfinishedActionCount: unfinishedActionCount,
	};

	const sessionNameDesc: PropertyDescriptor | undefined = ct.table.sessionName;
	if (sessionNameDesc !== undefined) {
		const v: unknown = sessionNameDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
			return undefined;
		}
		setField(result, "sessionName", v);
	}
	const runtimeKindDesc: PropertyDescriptor | undefined = ct.table.runtimeKind;
	if (runtimeKindDesc !== undefined) {
		const v: unknown = runtimeKindDesc.value;
		if (v !== "top-level" && v !== "subagent") {
			return undefined;
		}
		setField(result, "runtimeKind", v);
	}
	const parentActiveSessionIdDesc: PropertyDescriptor | undefined = ct.table.parentActiveSessionId;
	if (parentActiveSessionIdDesc !== undefined) {
		const v: unknown = parentActiveSessionIdDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
			return undefined;
		}
		setField(result, "parentActiveSessionId", v);
	}
	const rlmChildIdDesc: PropertyDescriptor | undefined = ct.table.rlmChildId;
	if (rlmChildIdDesc !== undefined) {
		const v: unknown = rlmChildIdDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
			return undefined;
		}
		setField(result, "rlmChildId", v);
	}
	const rlmDepthDesc: PropertyDescriptor | undefined = ct.table.rlmDepth;
	if (rlmDepthDesc !== undefined) {
		const v: unknown = rlmDepthDesc.value;
		if (!isSafeInteger(v) || v < 0) {
			return undefined;
		}
		setField(result, "rlmDepth", v);
	}
	const parentSessionIdDesc: PropertyDescriptor | undefined = ct.table.parentSessionId;
	if (parentSessionIdDesc !== undefined) {
		const v: unknown = parentSessionIdDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
			return undefined;
		}
		setField(result, "parentSessionId", v);
	}
	const statusDesc: PropertyDescriptor | undefined = ct.table.status;
	if (statusDesc !== undefined) {
		const v: unknown = statusDesc.value;
		if (v !== "running" && v !== "idle" && v !== "inactive") {
			return undefined;
		}
		setField(result, "status", v);
	}
	const rlmChildRegistryStatusDesc: PropertyDescriptor | undefined = ct.table.rlmChildRegistryStatus;
	if (rlmChildRegistryStatusDesc !== undefined) {
		const v: unknown = rlmChildRegistryStatusDesc.value;
		if (v !== "running" && v !== "completed" && v !== "deleted") {
			return undefined;
		}
		setField(result, "rlmChildRegistryStatus", v);
	}
	return result;
}

function sanitizeListAgentsBody(
	raw: unknown,
	method: V16Method,
): V16ReplyListAgentsBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (name !== "current" && name !== "agents") {
			return undefined;
		}
	}
	const agentsDesc: PropertyDescriptor | undefined = ct.table.agents;
	if (agentsDesc === undefined) {
		return undefined;
	}
	const agentsRaw: unknown = agentsDesc.value;
	if (!Array.isArray(agentsRaw)) {
		return undefined;
	}
	const agents: V16ReplyAgentSummary[] = [];
	for (let j: number = 0; j < agentsRaw.length; j++) {
		const item: unknown = agentsRaw[j];
		if (!isRecord(item)) {
			return undefined;
		}
		const agent: V16ReplyAgentSummary | undefined = sanitizeAgentSummary(item);
		if (agent === undefined) {
			return undefined;
		}
		agents.push(agent);
	}
	let current: V16ReplyEndpoint | undefined;
	const currentDesc: PropertyDescriptor | undefined = ct.table.current;
	if (currentDesc !== undefined) {
		const currentRaw: unknown = currentDesc.value;
		if (!isRecord(currentRaw)) {
			return undefined;
		}
		const parsedCurrent: V16ReplyEndpoint | undefined = sanitizeEndpoint(currentRaw);
		if (parsedCurrent === undefined) {
			return undefined;
		}
		current = parsedCurrent;
	}
	return _freeze({
		current: current,
		agents: _freeze(agents),
	});
}

function sanitizeRosterBody(raw: unknown, method: V16Method): V16ReplyRosterBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== 2) {
		return undefined;
	}
	if (ct.names[0] !== "current" || ct.names[1] !== "entries") {
		return undefined;
	}
	const currentDesc: PropertyDescriptor | undefined = ct.table.current;
	const entriesDesc: PropertyDescriptor | undefined = ct.table.entries;
	if (currentDesc === undefined || entriesDesc === undefined) {
		return undefined;
	}
	const currentRaw: unknown = currentDesc.value;
	if (!isRecord(currentRaw)) {
		return undefined;
	}
	const currentDescs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(
		currentRaw,
		_freeze(["name", "id", "depth"]),
	);
	if (currentDescs === undefined) {
		return undefined;
	}
	const name: unknown = currentDescs.name.value;
	const id: unknown = currentDescs.id.value;
	const depth: unknown = currentDescs.depth.value;
	if (!isString(name) || !isString(id) || !isValidDepth(depth)) {
		return undefined;
	}
	const entriesRaw: unknown = entriesDesc.value;
	if (!Array.isArray(entriesRaw)) {
		return undefined;
	}
	const entries: V16ReplyRosterEntry[] = [];
	for (let i: number = 0; i < entriesRaw.length; i++) {
		const item: unknown = entriesRaw[i];
		if (!isRecord(item)) {
			return undefined;
		}
		const entry: V16ReplyRosterEntry | undefined = sanitizeRosterEntry(item);
		if (entry === undefined) {
			return undefined;
		}
		entries.push(entry);
	}
	return _freeze({
		current: _freeze({ name: name, id: id, depth: depth }),
		entries: _freeze(entries),
	});
}

function sanitizeRosterEntry(raw: object): V16ReplyRosterEntry | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (
			name !== "relationship" &&
			name !== "name" &&
			name !== "id" &&
			name !== "depth" &&
			name !== "status" &&
			name !== "repliedSinceTask"
		) {
			return undefined;
		}
	}
	const relationshipDesc: PropertyDescriptor | undefined = ct.table.relationship;
	const nameDesc: PropertyDescriptor | undefined = ct.table.name;
	const idDesc: PropertyDescriptor | undefined = ct.table.id;
	const depthDesc: PropertyDescriptor | undefined = ct.table.depth;
	const statusDesc: PropertyDescriptor | undefined = ct.table.status;
	if (
		relationshipDesc === undefined ||
		nameDesc === undefined ||
		idDesc === undefined ||
		depthDesc === undefined ||
		statusDesc === undefined
	) {
		return undefined;
	}
	const relationship: unknown = relationshipDesc.value;
	const name: unknown = nameDesc.value;
	const id: unknown = idDesc.value;
	const depth: unknown = depthDesc.value;
	const status: unknown = statusDesc.value;
	if (relationship !== "parent" && relationship !== "sibling" && relationship !== "child") {
		return undefined;
	}
	if (!isString(name) || !isString(id)) {
		return undefined;
	}
	if (!isValidDepth(depth)) {
		return undefined;
	}
	if (status !== "running" && status !== "idle" && status !== "inactive") {
		return undefined;
	}
	const result: V16ReplyRosterEntry = {
		relationship: relationship,
		name: name,
		id: id,
		depth: depth,
		status: status,
	};
	const repliedSinceTaskDesc: PropertyDescriptor | undefined = ct.table.repliedSinceTask;
	if (repliedSinceTaskDesc !== undefined) {
		const v: unknown = repliedSinceTaskDesc.value;
		if (!isBoolean(v)) {
			return undefined;
		}
		setField(result, "repliedSinceTask", v);
	}
	return result;
}

function sanitizeAwaitPendingBody(
	raw: unknown,
	method: V16Method,
): V16ReplyAwaitPendingBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (raw === null) {
		return null;
	}
	if (!isString(raw)) {
		return undefined;
	}
	if (!validateUtf8Max(raw, MAX_NAME_UTF8_BYTES)) {
		return undefined;
	}
	return raw;
}

function sanitizeSendMessageBody(
	raw: unknown,
	method: V16Method,
): V16ReplySendMessageBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	const allowedKeys: ReadonlyArray<string> = _freeze([
		"id",
		"source",
		"target",
		"from",
		"fromRelationship",
		"message",
		"deliveryStatus",
		"deliveredAt",
		"queuedAt",
		"deliveryMode",
	]);
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (allowedKeys.indexOf(name) < 0) {
			return undefined;
		}
	}
	const idDesc: PropertyDescriptor | undefined = ct.table.id;
	const sourceDesc: PropertyDescriptor | undefined = ct.table.source;
	const targetDesc: PropertyDescriptor | undefined = ct.table.target;
	const messageDesc: PropertyDescriptor | undefined = ct.table.message;
	const deliveryStatusDesc: PropertyDescriptor | undefined = ct.table.deliveryStatus;
	if (
		idDesc === undefined ||
		sourceDesc === undefined ||
		targetDesc === undefined ||
		messageDesc === undefined ||
		deliveryStatusDesc === undefined
	) {
		return undefined;
	}
	const id: unknown = idDesc.value;
	const source: unknown = sourceDesc.value;
	const targetRaw: unknown = targetDesc.value;
	const message: unknown = messageDesc.value;
	const deliveryStatus: unknown = deliveryStatusDesc.value;
	if (!isString(id) || source !== "agent_message" || !isString(message)) {
		return undefined;
	}
	if (deliveryStatus !== "delivered" && deliveryStatus !== "queued") {
		return undefined;
	}
	if (!isRecord(targetRaw)) {
		return undefined;
	}
	const target: V16ReplyReceiptTarget | undefined = sanitizeEndpoint(targetRaw);
	if (target === undefined) {
		return undefined;
	}
	const result: V16ReplySendMessageBody = {
		id: id,
		source: "agent_message",
		target: target,
		message: message,
		deliveryStatus: deliveryStatus,
	};

	// from (optional)
	const fromDesc: PropertyDescriptor | undefined = ct.table.from;
	if (fromDesc !== undefined) {
		const fromRaw: unknown = fromDesc.value;
		if (!isRecord(fromRaw)) {
			return undefined;
		}
		const fromCt: DescriptorTable | undefined = captureDescriptors(fromRaw);
		if (fromCt === undefined) {
			return undefined;
		}
		const fromAllowed: ReadonlyArray<string> = _freeze([
			"activeSessionId",
			"sessionId",
			"sessionName",
			"runtimeKind",
			"clientId",
		]);
		for (let i: number = 0; i < fromCt.names.length; i++) {
			const name: string = fromCt.names[i];
			if (fromAllowed.indexOf(name) < 0) {
				return undefined;
			}
		}
		const fromResult: Record<string, unknown> = _create(null);
		const asiDesc: PropertyDescriptor | undefined = fromCt.table.activeSessionId;
		if (asiDesc !== undefined) {
			const v: unknown = asiDesc.value;
			if (!isString(v)) {
				return undefined;
			}
			fromResult.activeSessionId = v;
		}
		const siDesc: PropertyDescriptor | undefined = fromCt.table.sessionId;
		if (siDesc !== undefined) {
			const v: unknown = siDesc.value;
			if (!isString(v)) {
				return undefined;
			}
			fromResult.sessionId = v;
		}
		const snDesc: PropertyDescriptor | undefined = fromCt.table.sessionName;
		if (snDesc !== undefined) {
			const v: unknown = snDesc.value;
			if (!isString(v)) {
				return undefined;
			}
			fromResult.sessionName = v;
		}
		const rkDesc: PropertyDescriptor | undefined = fromCt.table.runtimeKind;
		if (rkDesc !== undefined) {
			const v: unknown = rkDesc.value;
			if (v !== "top-level" && v !== "subagent") {
				return undefined;
			}
			fromResult.runtimeKind = v;
		}
		const ciDesc: PropertyDescriptor | undefined = fromCt.table.clientId;
		if (ciDesc !== undefined) {
			const v: unknown = ciDesc.value;
			if (!isString(v)) {
				return undefined;
			}
			fromResult.clientId = v;
		}
		setField(result, "from", _freeze(fromResult));
	}

	const fromRelationshipDesc: PropertyDescriptor | undefined = ct.table.fromRelationship;
	if (fromRelationshipDesc !== undefined) {
		const v: unknown = fromRelationshipDesc.value;
		if (v !== "parent" && v !== "sibling" && v !== "child") {
			return undefined;
		}
		setField(result, "fromRelationship", v);
	}

	// deliveredAt xor queuedAt
	const deliveredAtDesc: PropertyDescriptor | undefined = ct.table.deliveredAt;
	const queuedAtDesc: PropertyDescriptor | undefined = ct.table.queuedAt;
	if (deliveryStatus === "delivered") {
		if (deliveredAtDesc === undefined || queuedAtDesc !== undefined) {
			return undefined;
		}
		const v: unknown = deliveredAtDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		setField(result, "deliveredAt", v);
	} else {
		if (queuedAtDesc === undefined || deliveredAtDesc !== undefined) {
			return undefined;
		}
		const v: unknown = queuedAtDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		setField(result, "queuedAt", v);
	}

	const deliveryModeDesc: PropertyDescriptor | undefined = ct.table.deliveryMode;
	if (deliveryModeDesc !== undefined) {
		const v: unknown = deliveryModeDesc.value;
		if (v !== "steer") {
			return undefined;
		}
		setField(result, "deliveryMode", v);
	}

	return result;
}

function sanitizeObserveAgentSummary(raw: object): V16ReplyObserveAgentSummary | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (
			name === "activeSessionId" ||
			name === "sessionId" ||
			name === "sessionName" ||
			name === "runtimeKind" ||
			name === "status" ||
			name === "isCurrent" ||
			name === "isStreaming" ||
			name === "isCompacting" ||
			name === "attachedClients" ||
			name === "messageCount" ||
			name === "queuedCount" ||
			name === "isSessionActive" ||
			name === "parentActiveSessionId" ||
			name === "parentSessionId" ||
			name === "rlmChildId" ||
			name === "rlmParentNodeId" ||
			name === "firstMessage" ||
			name === "latestMessage"
		) {
			continue;
		}
		if (isPathField(name)) {
			continue;
		}
		return undefined;
	}
	const requiredKeys: ReadonlyArray<string> = _freeze([
		"activeSessionId",
		"sessionId",
		"status",
		"isCurrent",
		"isStreaming",
		"isCompacting",
		"attachedClients",
		"messageCount",
		"queuedCount",
		"isSessionActive",
	]);
	for (let i: number = 0; i < requiredKeys.length; i++) {
		if (ct.table[requiredKeys[i]] === undefined) {
			return undefined;
		}
	}
	const activeSessionId: unknown = ct.table.activeSessionId.value;
	const sessionId: unknown = ct.table.sessionId.value;
	const status: unknown = ct.table.status.value;
	const isCurrent: unknown = ct.table.isCurrent.value;
	const isStreaming: unknown = ct.table.isStreaming.value;
	const isCompacting: unknown = ct.table.isCompacting.value;
	const attachedClients: unknown = ct.table.attachedClients.value;
	const messageCount: unknown = ct.table.messageCount.value;
	const queuedCount: unknown = ct.table.queuedCount.value;
	const isSessionActive: unknown = ct.table.isSessionActive.value;
	if (
		!isString(activeSessionId) ||
		!isString(sessionId) ||
		!isString(status) ||
		!isBoolean(isCurrent) ||
		!isBoolean(isStreaming) ||
		!isBoolean(isCompacting) ||
		!isSafeInteger(attachedClients) ||
		!isSafeInteger(messageCount) ||
		!isSafeInteger(queuedCount) ||
		!isBoolean(isSessionActive)
	) {
		return undefined;
	}
	const result: V16ReplyObserveAgentSummary = {
		activeSessionId: activeSessionId,
		sessionId: sessionId,
		status: status,
		isCurrent: isCurrent,
		isStreaming: isStreaming,
		isCompacting: isCompacting,
		attachedClients: attachedClients,
		messageCount: messageCount,
		queuedCount: queuedCount,
		isSessionActive: isSessionActive,
	};

	// Optional string fields
	const optStrings: ReadonlyArray<string> = _freeze([
		"sessionName",
		"parentActiveSessionId",
		"parentSessionId",
		"rlmChildId",
		"rlmParentNodeId",
		"firstMessage",
	]);
	for (let i: number = 0; i < optStrings.length; i++) {
		const key: string = optStrings[i];
		const desc: PropertyDescriptor | undefined = ct.table[key];
		if (desc !== undefined) {
			const v: unknown = desc.value;
			if (!isString(v)) {
				return undefined;
			}
			if (!validateUtf8Max(v, MAX_NAME_UTF8_BYTES)) {
				return undefined;
			}
			setField(result, key, v);
		}
	}

	const runtimeKindDesc: PropertyDescriptor | undefined = ct.table.runtimeKind;
	if (runtimeKindDesc !== undefined) {
		const v: unknown = runtimeKindDesc.value;
		if (v !== "top-level" && v !== "subagent") {
			return undefined;
		}
		setField(result, "runtimeKind", v);
	}

	const latestMessageDesc: PropertyDescriptor | undefined = ct.table.latestMessage;
	if (latestMessageDesc !== undefined) {
		const v: unknown = latestMessageDesc.value;
		if (!isRecord(v)) {
			return undefined;
		}
		const preview: V16ReplyMessagePreview | undefined = sanitizeMessagePreview(v);
		if (preview === undefined) {
			return undefined;
		}
		setField(result, "latestMessage", preview);
	}

	return result;
}

function sanitizeMessagePreview(raw: object): V16ReplyMessagePreview | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	const allowedKeys: ReadonlyArray<string> = _freeze([
		"index",
		"role",
		"timestamp",
		"text",
		"truncated",
		"toolCalls",
		"customType",
	]);
	for (let i: number = 0; i < ct.names.length; i++) {
		const name: string = ct.names[i];
		if (allowedKeys.indexOf(name) < 0) {
			return undefined;
		}
	}
	const indexDesc: PropertyDescriptor | undefined = ct.table.index;
	const roleDesc: PropertyDescriptor | undefined = ct.table.role;
	const textDesc: PropertyDescriptor | undefined = ct.table.text;
	const truncatedDesc: PropertyDescriptor | undefined = ct.table.truncated;
	if (indexDesc === undefined || roleDesc === undefined || textDesc === undefined || truncatedDesc === undefined) {
		return undefined;
	}
	const index: unknown = indexDesc.value;
	const role: unknown = roleDesc.value;
	const text: unknown = textDesc.value;
	const truncated: unknown = truncatedDesc.value;
	if (!isSafeInteger(index) || !isString(role) || !isString(text) || !isBoolean(truncated)) {
		return undefined;
	}
	if (index < 0) {
		return undefined;
	}
	if (!validateUtf8Max(text, MAX_MESSAGE_PREVIEW_CHARS)) {
		return undefined;
	}
	const result: V16ReplyMessagePreview = {
		index: index,
		role: role,
		text: text,
		truncated: truncated,
	};

	const timestampDesc: PropertyDescriptor | undefined = ct.table.timestamp;
	if (timestampDesc !== undefined) {
		const v: unknown = timestampDesc.value;
		if (!isFiniteNumber(v)) {
			return undefined;
		}
		setField(result, "timestamp", v);
	}

	const toolCallsDesc: PropertyDescriptor | undefined = ct.table.toolCalls;
	if (toolCallsDesc !== undefined) {
		const v: unknown = toolCallsDesc.value;
		if (!Array.isArray(v)) {
			return undefined;
		}
		const calls: string[] = [];
		for (let i: number = 0; i < v.length; i++) {
			const cv: unknown = v[i];
			if (!isString(cv)) {
				return undefined;
			}
			calls.push(cv);
		}
		setField(result, "toolCalls", _freeze(calls));
	}

	const customTypeDesc: PropertyDescriptor | undefined = ct.table.customType;
	if (customTypeDesc !== undefined) {
		const v: unknown = customTypeDesc.value;
		if (!isString(v)) {
			return undefined;
		}
		setField(result, "customType", v);
	}

	return result;
}

function sanitizeObserveListBody(
	raw: unknown,
	method: V16Method,
): V16ReplyObserveListBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== 2) {
		return undefined;
	}
	if (ct.names[0] !== "current" || ct.names[1] !== "agents") {
		return undefined;
	}
	const currentDesc: PropertyDescriptor | undefined = ct.table.current;
	const agentsDesc: PropertyDescriptor | undefined = ct.table.agents;
	if (currentDesc === undefined || agentsDesc === undefined) {
		return undefined;
	}
	const currentRaw: unknown = currentDesc.value;
	if (!isRecord(currentRaw)) {
		return undefined;
	}
	const current: V16ReplyObserveAgentSummary | undefined = sanitizeObserveAgentSummary(currentRaw);
	if (current === undefined) {
		return undefined;
	}
	const agentsRaw: unknown = agentsDesc.value;
	if (!Array.isArray(agentsRaw)) {
		return undefined;
	}
	const agents: V16ReplyObserveAgentSummary[] = [];
	for (let i: number = 0; i < agentsRaw.length; i++) {
		const item: unknown = agentsRaw[i];
		if (!isRecord(item)) {
			return undefined;
		}
		const a: V16ReplyObserveAgentSummary | undefined = sanitizeObserveAgentSummary(item);
		if (a === undefined) {
			return undefined;
		}
		agents.push(a);
	}
	return _freeze({
		current: current,
		agents: _freeze(agents),
	});
}

function sanitizeObserveGetBody(
	raw: unknown,
	method: V16Method,
): V16ReplyObserveGetBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== 1) {
		return undefined;
	}
	if (ct.names[0] !== "agent") {
		return undefined;
	}
	const agentDesc: PropertyDescriptor | undefined = ct.table.agent;
	if (agentDesc === undefined) {
		return undefined;
	}
	const agentRaw: unknown = agentDesc.value;
	if (!isRecord(agentRaw)) {
		return undefined;
	}
	const agent: V16ReplyObserveAgentSummary | undefined = sanitizeObserveAgentSummary(agentRaw);
	if (agent === undefined) {
		return undefined;
	}
	return _freeze({ agent: agent });
}

function sanitizeObserveRecentBody(
	raw: unknown,
	method: V16Method,
): V16ReplyObserveRecentBody | V16ReplyErrorBody | undefined {
	// Try error body first with method binding
	const errBody: V16ReplyErrorBody | undefined = acceptErrorBody(raw, method);
	if (errBody !== undefined) {
		return errBody;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) {
		return undefined;
	}
	if (ct.names.length !== 5) {
		return undefined;
	}
	if (
		ct.names[0] !== "agent" ||
		ct.names[1] !== "messages" ||
		ct.names[2] !== "limit" ||
		ct.names[3] !== "maxChars" ||
		ct.names[4] !== "truncated"
	) {
		return undefined;
	}
	const agentDesc: PropertyDescriptor | undefined = ct.table.agent;
	const messagesDesc: PropertyDescriptor | undefined = ct.table.messages;
	const limitDesc: PropertyDescriptor | undefined = ct.table.limit;
	const maxCharsDesc: PropertyDescriptor | undefined = ct.table.maxChars;
	const truncatedDesc: PropertyDescriptor | undefined = ct.table.truncated;
	if (
		agentDesc === undefined ||
		messagesDesc === undefined ||
		limitDesc === undefined ||
		maxCharsDesc === undefined ||
		truncatedDesc === undefined
	) {
		return undefined;
	}
	const agentRaw: unknown = agentDesc.value;
	if (!isRecord(agentRaw)) {
		return undefined;
	}
	const agent: V16ReplyObserveAgentSummary | undefined = sanitizeObserveAgentSummary(agentRaw);
	if (agent === undefined) {
		return undefined;
	}
	const messagesRaw: unknown = messagesDesc.value;
	if (!Array.isArray(messagesRaw)) {
		return undefined;
	}
	if (messagesRaw.length > MAX_MESSAGE_PREVIEWS) {
		return undefined;
	}
	const messages: V16ReplyMessagePreview[] = [];
	for (let i: number = 0; i < messagesRaw.length; i++) {
		const item: unknown = messagesRaw[i];
		if (!isRecord(item)) {
			return undefined;
		}
		const p: V16ReplyMessagePreview | undefined = sanitizeMessagePreview(item);
		if (p === undefined) {
			return undefined;
		}
		messages.push(p);
	}
	const limit: unknown = limitDesc.value;
	const maxChars: unknown = maxCharsDesc.value;
	const truncated: unknown = truncatedDesc.value;
	if (!isSafeInteger(limit) || !isSafeInteger(maxChars) || !isBoolean(truncated)) {
		return undefined;
	}
	if (limit < 1 || maxChars < 1) {
		return undefined;
	}
	return _freeze({
		agent: agent,
		messages: _freeze(messages),
		limit: limit,
		maxChars: maxChars,
		truncated: truncated,
	});
}

// ---------- decode reply ----------
// Full canonical: build the entire wire {body,execution,identity,method,version}
// with actual decoded values in lexical insertion order,
// stringify/encode, byte-compare length+every byte against shared-strict copied input.

function decodeReply(input: unknown, expectedMethod: string, expectedIdentity: V16WireIdentity): V16ReplyDecodeResult {
	const copyResult = copySandboxStrictBytes(input, MAX_REPLY_BYTES);
	if (!copyResult.ok) {
		if (copyResult.code === "INPUT_TOO_LARGE") {
			return unsafeDecodeFailure("INPUT_TOO_LARGE");
		}
		return unsafeDecodeFailure("INPUT_INVALID");
	}
	const originalBytes: Uint8Array = copyResult.value;

	let text: string;
	try {
		text = _decodeFatal(originalBytes);
	} catch {
		return unsafeDecodeFailure("UTF8_ERROR");
	}

	let parsed: unknown;
	try {
		parsed = _JSON_parse(text);
	} catch {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	if (!isRecord(parsed)) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}

	// Validate exact wire keys in lexical order: body, execution, identity, method, version
	const wireExpected: ReadonlyArray<string> = _freeze(["body", "execution", "identity", "method", "version"]);
	const wireDescs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(parsed, wireExpected);
	if (wireDescs === undefined) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}

	// Validate version
	const versionRaw: unknown = wireDescs.version.value;
	if (versionRaw !== 1) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}

	// Validate method
	const methodRaw: unknown = wireDescs.method.value;
	if (!isString(methodRaw)) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	if (methodRaw !== expectedMethod) {
		return unsafeDecodeFailure("METHOD_MISMATCH");
	}
	if (!isV16Method(methodRaw)) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	const method: V16Method = methodRaw;

	// Validate execution
	const executionRaw: unknown = wireDescs.execution.value;
	if (!isRecord(executionRaw)) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	const execDescs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(
		executionRaw,
		_freeze(["type"]),
	);
	if (execDescs === undefined) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	if (execDescs.type.value !== "prime-sandbox") {
		return unsafeDecodeFailure("FRAME_ERROR");
	}

	// Validate identity
	const identityRaw: unknown = wireDescs.identity.value;
	if (!isRecord(identityRaw)) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	const identityExpected: ReadonlyArray<string> = _freeze([
		"activeSessionId",
		"sessionId",
		"rlmChildId",
		"depth",
		"sessionName",
	]);
	const idDescs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(
		identityRaw,
		identityExpected,
	);
	if (idDescs === undefined) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	const decodedASI: string = idDescs.activeSessionId.value;
	const decodedSI: string = idDescs.sessionId.value;
	const decodedRLM: string = idDescs.rlmChildId.value;
	const decodedDEPTH: number = idDescs.depth.value;
	const decodedNAME: string = idDescs.sessionName.value;
	if (
		!isString(decodedASI) ||
		!isString(decodedSI) ||
		!isString(decodedRLM) ||
		!isValidDepth(decodedDEPTH) ||
		!isString(decodedNAME)
	) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	// Identity match check
	if (
		decodedASI !== expectedIdentity.activeSessionId ||
		decodedSI !== expectedIdentity.sessionId ||
		decodedRLM !== expectedIdentity.rlmChildId ||
		decodedDEPTH !== expectedIdentity.depth ||
		decodedNAME !== expectedIdentity.sessionName
	) {
		return unsafeDecodeFailure("IDENTITY_MISMATCH");
	}

	const identity: V16WireIdentity = _freeze({
		activeSessionId: decodedASI,
		sessionId: decodedSI,
		rlmChildId: decodedRLM,
		depth: decodedDEPTH,
		sessionName: decodedNAME,
	});
	const execution: V16WireExecution = _freeze({ type: "prime-sandbox" });

	// Decode body per method with error fallback
	const bodyRaw: unknown = wireDescs.body.value;
	const body: V16ReplyBody | undefined = decodeBodyByMethod(method, bodyRaw);
	if (body === undefined) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}

	// Build the exact wire with decoded values in lexical order
	const wire: Record<string, unknown> = _create(null);
	wire.body = body;
	wire.execution = execution;
	wire.identity = identity;
	wire.method = method;
	wire.version = 1;

	const canonJson: string = _JSON_stringify(wire);
	const canonBytes: Uint8Array = _encode(canonJson);

	// Byte-compare length and every byte
	if (canonBytes.length !== originalBytes.length) {
		return unsafeDecodeFailure("FRAME_ERROR");
	}
	for (let i: number = 0; i < canonBytes.length; i++) {
		if (canonBytes[i] !== originalBytes[i]) {
			return unsafeDecodeFailure("FRAME_ERROR");
		}
	}

	return _freeze({
		ok: true,
		reply: _freeze({
			body: body,
			execution: execution,
			identity: identity,
			method: method,
			version: 1,
		}),
	});
}

function unsafeDecodeFailure(code: V16ReplyDecodeFailureCode): V16ReplyDecodeFailure {
	return _freeze({ ok: false, code: code });
}

// ---------- decode body by method (uses same sanitizers as encode) ----------

function decodeBodyByMethod(method: V16Method, raw: unknown): V16ReplyBody | undefined {
	switch (method) {
		case "list_agents":
			return sanitizeListAgentsBody(raw, method);
		case "roster":
			return sanitizeRosterBody(raw, method);
		case "await_pending":
			return sanitizeAwaitPendingBody(raw, method);
		case "assert_name":
			return sanitizeEmptyOrErrorBody(raw, method);
		case "set_name":
			return sanitizeEmptyOrErrorBody(raw, method);
		case "send_message":
			return sanitizeSendMessageBody(raw, method);
		case "observe_list":
			return sanitizeObserveListBody(raw, method);
		case "observe_get":
			return sanitizeObserveGetBody(raw, method);
		case "observe_recent":
			return sanitizeObserveRecentBody(raw, method);
	}
}

// ---------- public exports ----------

export type {
	V16DecodedReply,
	V16Method,
	V16ReplyAgentSummary,
	V16ReplyAwaitPendingBody,
	V16ReplyBody,
	V16ReplyDecodeCorrelated,
	V16ReplyDecodeFailure,
	V16ReplyDecodeResult,
	V16ReplyEmptyBody,
	V16ReplyEncodeFailure,
	V16ReplyEncodeResult,
	V16ReplyEncodeSuccess,
	V16ReplyEndpoint,
	V16ReplyErrorBody,
	V16ReplyListAgentsBody,
	V16ReplyMessagePreview,
	V16ReplyObserveAgentSummary,
	V16ReplyObserveGetBody,
	V16ReplyObserveListBody,
	V16ReplyObserveRecentBody,
	V16ReplyReceiptSender,
	V16ReplyReceiptTarget,
	V16ReplyRosterBody,
	V16ReplyRosterEntry,
	V16ReplySendMessageBody,
	V16WireExecution,
	V16WireIdentity,
};

export { decodeReply, encodeReply };
