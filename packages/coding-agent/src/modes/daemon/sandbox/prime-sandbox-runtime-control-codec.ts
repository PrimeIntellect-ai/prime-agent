import { createHash } from "node:crypto";
import { type TextDecoder as NodeTextDecoder, type TextEncoder as NodeTextEncoder, types } from "node:util";
import type {
	AgentSessionMessageEndpoint,
	AgentSessionMessagePayload,
	AgentSessionMessageSender,
} from "../../../core/agent-messages.js";
import type {
	HostedRlmAbortResult,
	HostedRlmAdmissionResult,
	HostedRlmCloseResult,
	HostedRlmObservationSnapshot,
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmRuntimeStatus,
	HostedRlmTaskResult,
} from "../../../core/hosted-rlm-runtime-port.js";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// ---------- private constants ----------

const MAX_LIFECYCLE_PAYLOAD: number = 262128;
const MAX_PROMPT_LENGTH: number = 32768;
const MAX_SPAWN_CODE_LENGTH: number = 4096;
const MAX_ANSWER_PREVIEW_LENGTH: number = 2048;
const MAX_TOOL_NAME_LENGTH: number = 256;
const MAX_IDENTIFIER_LENGTH: number = 128;
const MAX_MESSAGE_UTF8_BYTES: number = 16384;

const ID_PATTERN: RegExp = /^[a-zA-Z0-9_./:-]{1,128}$/;
const PRINTABLE_ASCII_PATTERN: RegExp = /^[!-~]{1,128}$/;
const HEX64_PATTERN: RegExp = /^[0-9a-fA-F]{64}$/;

const TEXT_DECODER_FATAL: NodeTextDecoder = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER: NodeTextEncoder = new TextEncoder();

// ---------- captured intrinsics ----------

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _hasOwn: typeof Object.hasOwn = Object.hasOwn;
const _keys: typeof Object.keys = Object.keys;
const _freeze: typeof Object.freeze = Object.freeze;
const _assign: typeof Object.assign = Object.assign;
const _is: typeof Object.is = Object.is;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _isProxy: (value: object) => boolean = types.isProxy;
const _encode: (input?: string) => Uint8Array = TEXT_ENCODER.encode.bind(TEXT_ENCODER);
const _decodeFatal: (input: Uint8Array) => string = TEXT_DECODER_FATAL.decode.bind(TEXT_DECODER_FATAL);
const _JSON_parse: typeof JSON.parse = JSON.parse;
const _JSON_stringify: typeof JSON.stringify = JSON.stringify;
const _hashCreate = createHash;

// ---------- lifecycle op set ----------

type LifecycleOp = "START" | "EVENT" | "TERMINAL" | "ABORT" | "CLOSE" | "DELIVER_MESSAGE" | "OBSERVE";

// ---------- exported result types ----------

export type LifecycleEncodeResult =
	| Readonly<{ ok: true; bytes: Uint8Array }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "BOUNDS_EXCEEDED" | "UNKNOWN_OP" }>;

export type LifecycleDecodeRecordResult =
	| StartDecodedRecord
	| EventDecodedRecord
	| TerminalDecodedRecord
	| AbortDecodedRecord
	| CloseDecodedRecord
	| DeliverMessageDecodedRecord
	| ObserveDecodedRecord
	| Readonly<{
			ok: false;
			code:
				| "INPUT_INVALID"
				| "BOUNDS_EXCEEDED"
				| "UNKNOWN_OP"
				| "MALFORMED_IDENTITY"
				| "MALFORMED_BODY"
				| "CANONICAL_MISMATCH";
	  }>;

export type LifecycleDecodeReplyResult =
	| StartDecodedReply
	| EventDecodedReply
	| TerminalDecodedReply
	| AbortDecodedReply
	| CloseDecodedReply
	| DeliverMessageDecodedReply
	| ObserveDecodedReply
	| Readonly<{
			ok: false;
			code: "INPUT_INVALID" | "BOUNDS_EXCEEDED" | "OP_MISMATCH" | "MALFORMED_BODY" | "CANONICAL_MISMATCH";
	  }>;

// ---------- decoded record union members (not exported as named types) ----------

interface StartDecodedRecord {
	readonly ok: true;
	readonly op: "START";
	readonly identity: HostedRlmRuntimeIdentity;
	readonly prompt: string;
	readonly promptSha256: string;
	readonly spawnCode?: string;
	readonly spawnCodeSha256?: string;
}

interface EventDecodedRecord {
	readonly ok: true;
	readonly op: "EVENT";
	readonly identity: HostedRlmRuntimeIdentity;
	readonly event: HostedRlmRuntimeEvent;
}

interface TerminalDecodedRecord {
	readonly ok: true;
	readonly op: "TERMINAL";
	readonly identity: HostedRlmRuntimeIdentity;
	readonly result: HostedRlmTaskResult;
}

interface AbortDecodedRecord {
	readonly ok: true;
	readonly op: "ABORT";
	readonly identity: HostedRlmRuntimeIdentity;
}

interface CloseDecodedRecord {
	readonly ok: true;
	readonly op: "CLOSE";
	readonly identity: HostedRlmRuntimeIdentity;
}

interface DeliverMessageDecodedRecord {
	readonly ok: true;
	readonly op: "DELIVER_MESSAGE";
	readonly identity: HostedRlmRuntimeIdentity;
	readonly payload: AgentSessionMessagePayload;
}

interface ObserveDecodedRecord {
	readonly ok: true;
	readonly op: "OBSERVE";
	readonly identity: HostedRlmRuntimeIdentity;
}

// ---------- decoded reply union members ----------

interface StartDecodedReply {
	readonly ok: true;
	readonly op: "START";
	readonly body: HostedRlmAdmissionResult;
}

interface EventDecodedReply {
	readonly ok: true;
	readonly op: "EVENT";
	readonly body: Readonly<{ code: "ACK" }>;
}

interface TerminalDecodedReply {
	readonly ok: true;
	readonly op: "TERMINAL";
	readonly body: Readonly<{ code: "ACK" }>;
}

interface AbortDecodedReply {
	readonly ok: true;
	readonly op: "ABORT";
	readonly body: HostedRlmAbortResult;
}

interface CloseDecodedReply {
	readonly ok: true;
	readonly op: "CLOSE";
	readonly body: HostedRlmCloseResult;
}

interface DeliverMessageDecodedReply {
	readonly ok: true;
	readonly op: "DELIVER_MESSAGE";
	readonly body: Readonly<{ status: "delivered" | "queued" }>;
}

interface ObserveDecodedReply {
	readonly ok: true;
	readonly op: "OBSERVE";
	readonly body: HostedRlmObservationSnapshot;
}

// ---------- frozen failure constants ----------

const FAIL_INPUT_INVALID: LifecycleEncodeResult = _freeze({ ok: false, code: "INPUT_INVALID" });
const FAIL_BOUNDS_EXCEEDED: LifecycleEncodeResult = _freeze({ ok: false, code: "BOUNDS_EXCEEDED" });
const FAIL_UNKNOWN_OP: LifecycleEncodeResult = _freeze({ ok: false, code: "UNKNOWN_OP" });

const FAIL_RECORD_INPUT_INVALID: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "INPUT_INVALID" });
const FAIL_RECORD_BOUNDS_EXCEEDED: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "BOUNDS_EXCEEDED" });
const FAIL_RECORD_UNKNOWN_OP: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "UNKNOWN_OP" });
const FAIL_RECORD_MALFORMED_IDENTITY: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "MALFORMED_IDENTITY" });
const FAIL_RECORD_MALFORMED_BODY: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "MALFORMED_BODY" });
const FAIL_RECORD_CANONICAL_MISMATCH: LifecycleDecodeRecordResult = _freeze({ ok: false, code: "CANONICAL_MISMATCH" });

const FAIL_REPLY_INPUT_INVALID: LifecycleDecodeReplyResult = _freeze({ ok: false, code: "INPUT_INVALID" });
const FAIL_REPLY_BOUNDS_EXCEEDED: LifecycleDecodeReplyResult = _freeze({ ok: false, code: "BOUNDS_EXCEEDED" });
const FAIL_REPLY_OP_MISMATCH: LifecycleDecodeReplyResult = _freeze({ ok: false, code: "OP_MISMATCH" });
const FAIL_REPLY_MALFORMED_BODY: LifecycleDecodeReplyResult = _freeze({ ok: false, code: "MALFORMED_BODY" });
const FAIL_REPLY_CANONICAL_MISMATCH: LifecycleDecodeReplyResult = _freeze({ ok: false, code: "CANONICAL_MISMATCH" });

// ---------- fail-closed helpers ----------

function safeIsProxy(value: object): boolean {
	try {
		return _isProxy(value);
	} catch {
		return true;
	}
}

function safeGetPrototypeOf(value: object): object | null {
	try {
		return _getPrototypeOf(value);
	} catch {
		return null;
	}
}

function safeGetOwnPropertySymbols(value: object): ReadonlyArray<symbol> | undefined {
	try {
		return _getOwnPropertySymbols(value);
	} catch {
		return undefined;
	}
}

// ---------- scalar-string validator (Section 3) ----------

function isScalarString(raw: unknown): raw is string {
	if (typeof raw !== "string") return false;
	const len: number = raw.length;
	for (let i: number = 0; i < len; i++) {
		const cc: number = raw.charCodeAt(i);
		if (cc >= 0xd800 && cc <= 0xdbff) {
			i++;
			if (i >= len) return false;
			const next: number = raw.charCodeAt(i);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (cc >= 0xdc00 && cc <= 0xdfff) {
			return false;
		}
	}
	return true;
}

// ---------- UTF-8 byte count (same semantics as V16 request codec) ----------

function utf8ByteCount(value: string): number {
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
		} else if (cc >= 0xdc00 && cc <= 0xdfff) {
			count += 3;
		} else {
			count += 3;
		}
	}
	return count;
}

// ---------- exact-record validator (equivalent to port's exactRecord) ----------

interface DescriptorTable {
	readonly names: ReadonlyArray<string>;
	readonly table: Record<string, TypedPropertyDescriptor<unknown>>;
}

function captureDescriptors(value: Record<string, unknown>): DescriptorTable | undefined {
	if (safeIsProxy(value)) return undefined;
	const proto: object | null = safeGetPrototypeOf(value);
	if (proto !== Object.prototype) return undefined;
	const symbols: ReadonlyArray<symbol> | undefined = safeGetOwnPropertySymbols(value);
	if (symbols === undefined || symbols.length !== 0) return undefined;
	let table: Record<string, TypedPropertyDescriptor<unknown>>;
	try {
		table = _getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	const names: ReadonlyArray<string> = _keys(table);
	for (let i: number = 0; i < names.length; i++) {
		const key: string = names[i];
		const d: TypedPropertyDescriptor<unknown> | undefined = table[key];
		if (d === undefined) return undefined;
		if (!("value" in d)) return undefined;
		if (d.enumerable !== true) return undefined;
		if (d.get !== undefined) return undefined;
		if (d.set !== undefined) return undefined;
		if (key === "toJSON") return undefined;
	}
	return { names: names, table: table };
}

function getValue(table: Record<string, TypedPropertyDescriptor<unknown>>, key: string): unknown {
	const d: TypedPropertyDescriptor<unknown> | undefined = table[key];
	if (d === undefined) return undefined;
	return d.value;
}

function exactRecordOrdered(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	for (let i: number = 0; i < expected.length; i++) {
		if (ct.names[i] !== expected[i]) return undefined;
	}
	const out: Record<string, unknown> = {};
	for (let i: number = 0; i < expected.length; i++) {
		const key: string = expected[i];
		out[key] = getValue(ct.table, key);
	}
	return out;
}

function exactRecordSet(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	const out: Record<string, unknown> = {};
	for (let i: number = 0; i < ct.names.length; i++) {
		const key: string = ct.names[i];
		if (expected.indexOf(key) < 0) return undefined;
		out[key] = getValue(ct.table, key);
	}
	return out;
}

function exactRecordAllowMissing(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	const out: Record<string, unknown> = {};
	for (let i: number = 0; i < ct.names.length; i++) {
		const key: string = ct.names[i];
		if (expected.indexOf(key) < 0) return undefined;
		out[key] = getValue(ct.table, key);
	}
	return out;
}

function exactRecordZeroKeys(value: Record<string, unknown>): boolean {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return false;
	return ct.names.length === 0;
}

function exactRecordFlexCount(
	value: Record<string, unknown>,
	allowed: ReadonlyArray<number>,
): DescriptorTable | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (allowed.indexOf(ct.names.length) < 0) return undefined;
	return ct;
}

// ---------- scalar validators ----------

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object") return false;
	if (value === null) return false;
	return true;
}

function boundedIdentifier(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_IDENTIFIER_LENGTH) return false;
	return ID_PATTERN.test(raw);
}

function boundedString(raw: unknown, maximum: number): raw is string {
	return typeof raw === "string" && raw.length > 0 && raw.length <= maximum;
}

function boundedPrintableAscii(raw: unknown): raw is string {
	return typeof raw === "string" && PRINTABLE_ASCII_PATTERN.test(raw);
}

function safeInteger(raw: unknown): number | null {
	if (typeof raw !== "number" || !_isSafeInteger(raw) || raw < 0) return null;
	return raw;
}

function isLifecycleOp(raw: unknown): raw is LifecycleOp {
	if (typeof raw !== "string") return false;
	return (
		raw === "START" ||
		raw === "EVENT" ||
		raw === "TERMINAL" ||
		raw === "ABORT" ||
		raw === "CLOSE" ||
		raw === "DELIVER_MESSAGE" ||
		raw === "OBSERVE"
	);
}

function runtimeStatus(raw: unknown): HostedRlmRuntimeStatus | null {
	if (raw === "queued") return "queued";
	if (raw === "running") return "running";
	if (raw === "completed") return "completed";
	if (raw === "cancelled") return "cancelled";
	if (raw === "error") return "error";
	return null;
}

// ---------- identity validator ----------

const IDENTITY_KEYS: ReadonlyArray<string> = _freeze(["childId", "sessionId", "sessionName", "modelSelector"]);

function validateIdentity(raw: unknown): HostedRlmRuntimeIdentity | null {
	if (!isRecord(raw)) return null;
	const record = exactRecordSet(raw, IDENTITY_KEYS);
	if (record === undefined) return null;
	const childId = record.childId;
	const sessionId = record.sessionId;
	const sessionName = record.sessionName;
	const modelSelector = record.modelSelector;
	if (
		!boundedIdentifier(childId) ||
		!boundedIdentifier(sessionId) ||
		!boundedIdentifier(sessionName) ||
		!boundedIdentifier(modelSelector)
	)
		return null;
	return _freeze({ childId, sessionId, sessionName, modelSelector });
}

// ---------- usage validator ----------

const USAGE_KEYS: ReadonlyArray<string> = _freeze(["inputTokens", "outputTokens"]);

function validateUsage(raw: unknown): Readonly<{ inputTokens: number; outputTokens: number }> | null {
	if (!isRecord(raw)) return null;
	const record = exactRecordSet(raw, USAGE_KEYS);
	if (record === undefined) return null;
	const inputTokens = safeInteger(record.inputTokens);
	const outputTokens = safeInteger(record.outputTokens);
	if (inputTokens === null || outputTokens === null) return null;
	return _freeze({ inputTokens, outputTokens });
}

// ---------- helper: scalar-check a named field if present ----------

function scalarCheckedString(value: unknown, maxLen: number): string | null {
	if (!boundedString(value, maxLen)) return null;
	if (!isScalarString(value)) return null;
	return value;
}

// ---------- event validator ----------

function validateEvent(raw: unknown): HostedRlmRuntimeEvent | null {
	if (!isRecord(raw)) return null;
	const ct: DescriptorTable | undefined = exactRecordFlexCount(raw, [1, 2, 4, 5]);
	if (ct === undefined) return null;
	const count: number = ct.names.length;
	const typeRaw: unknown = getValue(ct.table, "type");
	if (typeof typeRaw !== "string") return null;
	const type: string = typeRaw;
	if (type === "agent_start" && count === 1) return _freeze({ type: "agent_start" });
	if (type === "agent_end" && count === 1) return _freeze({ type: "agent_end" });
	if (type === "waiting" && count === 1) return _freeze({ type: "waiting" });
	if (type === "writing" && count === 2) {
		const preview: unknown = getValue(ct.table, "answerPreview");
		const checked: string | null = scalarCheckedString(preview, MAX_ANSWER_PREVIEW_LENGTH);
		if (checked === null) return null;
		return _freeze({ type: "writing", answerPreview: checked });
	}
	if (type === "executing" && count === 2) {
		const toolName: unknown = getValue(ct.table, "toolName");
		const checked: string | null = scalarCheckedString(toolName, MAX_TOOL_NAME_LENGTH);
		if (checked === null) return null;
		return _freeze({ type: "executing", toolName: checked });
	}
	if (type !== "child_update" || (count !== 4 && count !== 5)) return null;
	const statusRaw: unknown = getValue(ct.table, "status");
	const toolUseCountRaw: unknown = getValue(ct.table, "toolUseCount");
	const parentReplyCountRaw: unknown = getValue(ct.table, "parentReplyCount");
	const status = runtimeStatus(statusRaw);
	const toolUseCount = safeInteger(toolUseCountRaw);
	const parentReplyCount = safeInteger(parentReplyCountRaw);
	if (status === null || toolUseCount === null || parentReplyCount === null) return null;
	if (count === 5) {
		const preview: unknown = getValue(ct.table, "answerPreview");
		const checked: string | null = scalarCheckedString(preview, MAX_ANSWER_PREVIEW_LENGTH);
		if (checked === null) return null;
		return _freeze({ type: "child_update", status, toolUseCount, parentReplyCount, answerPreview: checked });
	}
	return _freeze({ type: "child_update", status, toolUseCount, parentReplyCount });
}

// ---------- task result validator ----------

const TASK_KEYS: ReadonlyArray<string> = _freeze([
	"status",
	"durationMs",
	"parentReplyCount",
	"toolUseCount",
	"answerPreview",
	"errorCode",
	"usage",
	"lastCommittedRequestId",
]);

function validateTaskResult(raw: unknown): HostedRlmTaskResult | null {
	if (!isRecord(raw)) return null;
	const record = exactRecordAllowMissing(raw, TASK_KEYS);
	if (record === undefined) return null;
	const durationMs = safeInteger(record.durationMs);
	const parentReplyCount = safeInteger(record.parentReplyCount);
	const toolUseCount = safeInteger(record.toolUseCount);
	if (durationMs === null || parentReplyCount === null || toolUseCount === null) return null;
	const hasAnswer = _hasOwn(record, "answerPreview");
	let answerPreview: string | undefined;
	if (hasAnswer) {
		const candidate: unknown = record.answerPreview;
		const checked: string | null = scalarCheckedString(candidate, MAX_ANSWER_PREVIEW_LENGTH);
		if (checked === null) return null;
		answerPreview = checked;
	}
	const hasError = _hasOwn(record, "errorCode");
	const hasUsage = _hasOwn(record, "usage");
	let parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
	if (hasUsage) {
		const candidateUsage = validateUsage(record.usage);
		if (candidateUsage === null) return null;
		parsedUsage = candidateUsage;
	}
	const hasLastCommittedRequestId = _hasOwn(record, "lastCommittedRequestId");
	let lastCommittedRequestId: string | undefined;
	if (hasLastCommittedRequestId) {
		const candidate: unknown = record.lastCommittedRequestId;
		if (!boundedPrintableAscii(candidate)) return null;
		lastCommittedRequestId = candidate;
	}
	const status: unknown = record.status;
	if (status === "completed") {
		if (hasError) return null;
		return completedResult(
			durationMs,
			parentReplyCount,
			toolUseCount,
			answerPreview,
			parsedUsage,
			lastCommittedRequestId,
		);
	}
	if (status === "cancelled") {
		if (hasAnswer || hasLastCommittedRequestId) return null;
		if (record.errorCode !== "CANCELLED") return null;
		return cancelledResult(durationMs, parentReplyCount, toolUseCount, parsedUsage);
	}
	if (status !== "error" || hasAnswer || hasLastCommittedRequestId || !hasError) return null;
	const errorCode: unknown = record.errorCode;
	if (errorCode !== "TIMEOUT" && errorCode !== "ADMISSION_FAILED" && errorCode !== "INTERNAL_ERROR") return null;
	return errorResult(durationMs, parentReplyCount, toolUseCount, errorCode, parsedUsage);
}

function completedResult(
	durationMs: number,
	parentReplyCount: number,
	toolUseCount: number,
	answerPreview: string | undefined,
	parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
	lastCommittedRequestId: string | undefined,
): HostedRlmTaskResult {
	const result: {
		status: "completed";
		durationMs: number;
		parentReplyCount: number;
		toolUseCount: number;
		answerPreview?: string;
		usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
		lastCommittedRequestId?: string;
	} = { status: "completed", durationMs, parentReplyCount, toolUseCount };
	if (answerPreview !== undefined) result.answerPreview = answerPreview;
	if (parsedUsage !== undefined) result.usage = parsedUsage;
	if (lastCommittedRequestId !== undefined) result.lastCommittedRequestId = lastCommittedRequestId;
	return _freeze(result);
}

function cancelledResult(
	durationMs: number,
	parentReplyCount: number,
	toolUseCount: number,
	parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): HostedRlmTaskResult {
	if (parsedUsage !== undefined) {
		return _freeze({
			status: "cancelled",
			durationMs,
			parentReplyCount,
			toolUseCount,
			errorCode: "CANCELLED",
			usage: parsedUsage,
		});
	}
	return _freeze({
		status: "cancelled",
		durationMs,
		parentReplyCount,
		toolUseCount,
		errorCode: "CANCELLED",
	});
}

function errorResult(
	durationMs: number,
	parentReplyCount: number,
	toolUseCount: number,
	errorCode: "TIMEOUT" | "ADMISSION_FAILED" | "INTERNAL_ERROR",
	parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): HostedRlmTaskResult {
	if (parsedUsage !== undefined) {
		return _freeze({
			status: "error",
			durationMs,
			parentReplyCount,
			toolUseCount,
			errorCode: errorCode,
			usage: parsedUsage,
		});
	}
	return _freeze({
		status: "error",
		durationMs,
		parentReplyCount,
		toolUseCount,
		errorCode: errorCode,
	});
}

// ---------- observation validator ----------

const OBSERVATION_KEYS: ReadonlyArray<string> = _freeze([
	"status",
	"messageCount",
	"toolUseCount",
	"agentRunning",
	"parentReplyCount",
	"answerPreview",
	"usage",
]);

function validateObservation(raw: unknown): HostedRlmObservationSnapshot | null {
	if (!isRecord(raw)) return null;
	const record = exactRecordAllowMissing(raw, OBSERVATION_KEYS);
	if (record === undefined) return null;
	const status = runtimeStatus(record.status);
	const messageCount = safeInteger(record.messageCount);
	const toolUseCount = safeInteger(record.toolUseCount);
	const parentReplyCount = safeInteger(record.parentReplyCount);
	if (
		status === null ||
		messageCount === null ||
		toolUseCount === null ||
		parentReplyCount === null ||
		typeof record.agentRunning !== "boolean"
	)
		return null;
	if (status !== "running" && record.agentRunning === true) return null;
	const hasAnswer = _hasOwn(record, "answerPreview");
	let answerPreview: string | undefined;
	if (hasAnswer) {
		const candidate: unknown = record.answerPreview;
		const checked: string | null = scalarCheckedString(candidate, MAX_ANSWER_PREVIEW_LENGTH);
		if (checked === null) return null;
		answerPreview = checked;
	}
	const hasUsage = _hasOwn(record, "usage");
	let parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
	if (hasUsage) {
		const candidateUsage = validateUsage(record.usage);
		if (candidateUsage === null) return null;
		parsedUsage = candidateUsage;
	}
	const result: {
		status: HostedRlmRuntimeStatus;
		messageCount: number;
		toolUseCount: number;
		agentRunning: boolean;
		parentReplyCount: number;
		answerPreview?: string;
		usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
	} = {
		status,
		messageCount,
		toolUseCount,
		agentRunning: record.agentRunning,
		parentReplyCount,
	};
	if (answerPreview !== undefined) result.answerPreview = answerPreview;
	if (parsedUsage !== undefined) result.usage = parsedUsage;
	return _freeze(result);
}

// ---------- canonical rebuild helpers ----------

function makeCanonicalJson(value: Record<string, unknown>): Uint8Array {
	const text: string = _JSON_stringify(value);
	return _encode(text);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i: number = 0; i < left.byteLength; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

// ---------- SHA-256 ----------

function sha256Hex(data: Uint8Array): string {
	const hash = _hashCreate("sha256");
	hash.update(data);
	const digest: Buffer = Buffer.from(hash.digest());
	return digest.toString("hex");
}

function sha256OfString(value: string): string {
	return sha256Hex(_encode(value));
}

// ---------- encode helpers ----------

function encodeEnvelope(
	identity: HostedRlmRuntimeIdentity,
	op: string,
	body: Record<string, unknown>,
): Uint8Array | undefined {
	const wire: Record<string, unknown> = Object.create(null);
	wire.v = 1;
	wire.identity = identity;
	wire.op = op;
	wire.body = body;
	return makeCanonicalJson(wire);
}

function encodeSuccess(bytes: Uint8Array): LifecycleEncodeResult {
	return _freeze({ ok: true, bytes });
}

function encodeJsonOnly(value: Record<string, unknown> | HostedRlmObservationSnapshot): Uint8Array {
	const text: string = _JSON_stringify(value);
	return _encode(text);
}

// ---------- START body validation ----------

const START_BODY_KEYS_FULL: ReadonlyArray<string> = _freeze(["prompt", "promptSha256", "spawnCode", "spawnCodeSha256"]);

function validateStartBodyInput(raw: unknown): { prompt: string; spawnCode?: string } | undefined {
	if (!isRecord(raw)) return undefined;
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) return undefined;
	const names: ReadonlyArray<string> = ct.names;
	if (names.length !== 1 && names.length !== 2) return undefined;
	let hasPrompt = false;
	let hasSpawnCode = false;
	for (let i: number = 0; i < names.length; i++) {
		if (names[i] === "prompt") hasPrompt = true;
		else if (names[i] === "spawnCode") hasSpawnCode = true;
		else return undefined;
	}
	if (!hasPrompt) return undefined;
	const promptRaw: unknown = getValue(ct.table, "prompt");
	if (!boundedString(promptRaw, MAX_PROMPT_LENGTH)) return undefined;
	if (!isScalarString(promptRaw)) return undefined;
	const prompt: string = promptRaw;
	if (hasSpawnCode) {
		const spawnCodeRaw: unknown = getValue(ct.table, "spawnCode");
		if (!boundedString(spawnCodeRaw, MAX_SPAWN_CODE_LENGTH)) return undefined;
		if (!isScalarString(spawnCodeRaw)) return undefined;
		return { prompt, spawnCode: spawnCodeRaw };
	}
	return { prompt };
}

function encodeStartBody(input: { prompt: string; spawnCode?: string }): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: input.prompt };
	body.promptSha256 = sha256OfString(input.prompt);
	if (input.spawnCode !== undefined) {
		body.spawnCode = input.spawnCode;
		body.spawnCodeSha256 = sha256OfString(input.spawnCode);
	}
	return body;
}

function decodeStartBody(
	parsed: Record<string, unknown>,
): { prompt: string; promptSha256: string; spawnCode?: string; spawnCodeSha256?: string } | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(parsed);
	if (ct === undefined) return undefined;
	const names: ReadonlyArray<string> = ct.names;
	if (names.length !== 2 && names.length !== 4) return undefined;
	const record: Record<string, unknown> = {};
	for (let i: number = 0; i < names.length; i++) {
		const key: string = names[i];
		if (START_BODY_KEYS_FULL.indexOf(key) < 0) return undefined;
		record[key] = getValue(ct.table, key);
	}
	if (!_hasOwn(record, "prompt") || !_hasOwn(record, "promptSha256")) return undefined;
	const hasSpawn = _hasOwn(record, "spawnCode");
	const hasSpawnSha = _hasOwn(record, "spawnCodeSha256");
	if (hasSpawn !== hasSpawnSha) return undefined;
	const promptRaw: unknown = record.prompt;
	const promptSha256Raw: unknown = record.promptSha256;
	if (!boundedString(promptRaw, MAX_PROMPT_LENGTH)) return undefined;
	if (!isScalarString(promptRaw)) return undefined;
	if (typeof promptSha256Raw !== "string" || !HEX64_PATTERN.test(promptSha256Raw)) return undefined;
	const prompt: string = promptRaw;
	const promptSha256: string = promptSha256Raw;
	let spawnCode: string | undefined;
	let spawnCodeSha256: string | undefined;
	if (hasSpawn) {
		const spawnCodeRaw: unknown = record.spawnCode;
		const spawnCodeSha256Raw: unknown = record.spawnCodeSha256;
		if (!boundedString(spawnCodeRaw, MAX_SPAWN_CODE_LENGTH)) return undefined;
		if (!isScalarString(spawnCodeRaw)) return undefined;
		if (typeof spawnCodeSha256Raw !== "string" || !HEX64_PATTERN.test(spawnCodeSha256Raw)) return undefined;
		spawnCode = spawnCodeRaw;
		spawnCodeSha256 = spawnCodeSha256Raw;
	}
	if (sha256OfString(prompt).toLowerCase() !== promptSha256.toLowerCase()) return undefined;
	if (
		spawnCode !== undefined &&
		spawnCodeSha256 !== undefined &&
		sha256OfString(spawnCode).toLowerCase() !== spawnCodeSha256.toLowerCase()
	)
		return undefined;
	return { prompt, promptSha256, spawnCode, spawnCodeSha256 };
}

function buildStartCanonicalBody(decoded: {
	prompt: string;
	promptSha256: string;
	spawnCode?: string;
	spawnCodeSha256?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: decoded.prompt, promptSha256: decoded.promptSha256.toLowerCase() };
	if (decoded.spawnCode !== undefined && decoded.spawnCodeSha256 !== undefined) {
		body.spawnCode = decoded.spawnCode;
		body.spawnCodeSha256 = decoded.spawnCodeSha256.toLowerCase();
	}
	return body;
}

// ---------- EVENT body validation ----------

const EVENT_BODY_KEYS: ReadonlyArray<string> = _freeze(["event"]);

function validateEventBodyInput(raw: unknown): HostedRlmRuntimeEvent | undefined {
	if (!isRecord(raw)) return undefined;
	const record = exactRecordSet(raw, EVENT_BODY_KEYS);
	if (record === undefined) return undefined;
	const ev = validateEvent(record.event);
	if (ev === null) return undefined;
	return ev;
}

function decodeEventBody(parsed: Record<string, unknown>): HostedRlmRuntimeEvent | undefined {
	const record = exactRecordSet(parsed, EVENT_BODY_KEYS);
	if (record === undefined) return undefined;
	const ev = validateEvent(record.event);
	if (ev === null) return undefined;
	return ev;
}

// ---------- TERMINAL body validation ----------

const TERMINAL_BODY_KEYS: ReadonlyArray<string> = _freeze(["result"]);

function validateTerminalBodyInput(raw: unknown): HostedRlmTaskResult | undefined {
	if (!isRecord(raw)) return undefined;
	const record = exactRecordSet(raw, TERMINAL_BODY_KEYS);
	if (record === undefined) return undefined;
	const result = validateTaskResult(record.result);
	if (result === null) return undefined;
	return result;
}

function decodeTerminalBody(parsed: Record<string, unknown>): HostedRlmTaskResult | undefined {
	const record = exactRecordSet(parsed, TERMINAL_BODY_KEYS);
	if (record === undefined) return undefined;
	const result = validateTaskResult(record.result);
	if (result === null) return undefined;
	return result;
}

// ---------- ABORT / CLOSE / OBSERVE body validation ----------

function validateEmptyBodyInput(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	return exactRecordZeroKeys(raw);
}

// ---------- DELIVER_MESSAGE body validation ----------

const DELIVER_MESSAGE_BODY_KEYS: ReadonlyArray<string> = _freeze(["payload"]);
const TARGET_ENDPOINT_KEYS: ReadonlyArray<string> = _freeze([
	"activeSessionId",
	"sessionId",
	"sessionName",
	"runtimeKind",
]);
const SENDER_KEYS: ReadonlyArray<string> = _freeze([
	"activeSessionId",
	"sessionId",
	"sessionName",
	"runtimeKind",
	"clientId",
]);
const PAYLOAD_KEYS: ReadonlyArray<string> = _freeze(["id", "source", "target", "from", "fromRelationship", "message"]);

const AGENT_MESSAGE_SOURCE_LITERAL: "agent_message" = "agent_message";

function validateTargetEndpoint(raw: unknown): AgentSessionMessageEndpoint | undefined {
	if (!isRecord(raw)) return undefined;
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) return undefined;
	if (ct.names.length < 2) return undefined;
	const out: Record<string, unknown> = {};
	for (let i: number = 0; i < ct.names.length; i++) {
		const key: string = ct.names[i];
		if (TARGET_ENDPOINT_KEYS.indexOf(key) < 0) return undefined;
		out[key] = getValue(ct.table, key);
	}
	if (!_hasOwn(out, "activeSessionId") || !_hasOwn(out, "sessionId")) return undefined;
	if (!boundedIdentifier(out.activeSessionId) || !boundedIdentifier(out.sessionId)) return undefined;
	let sessionName: string | undefined;
	if (_hasOwn(out, "sessionName")) {
		const candidate: unknown = out.sessionName;
		if (!boundedIdentifier(candidate)) return undefined;
		sessionName = candidate;
	}
	let runtimeKind: "top-level" | "subagent" | undefined;
	if (_hasOwn(out, "runtimeKind")) {
		const rk: unknown = out.runtimeKind;
		if (rk !== "top-level" && rk !== "subagent") return undefined;
		runtimeKind = rk;
	}
	const endpoint: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
		runtimeKind?: "top-level" | "subagent";
	} = {
		activeSessionId: out.activeSessionId,
		sessionId: out.sessionId,
	};
	if (sessionName !== undefined) endpoint.sessionName = sessionName;
	if (runtimeKind !== undefined) endpoint.runtimeKind = runtimeKind;
	return _freeze(endpoint);
}

function validateSender(raw: unknown): AgentSessionMessageSender | undefined {
	if (!isRecord(raw)) return undefined;
	const ct: DescriptorTable | undefined = captureDescriptors(raw);
	if (ct === undefined) return undefined;
	if (ct.names.length > 5) return undefined;
	const out: Record<string, unknown> = {};
	for (let i: number = 0; i < ct.names.length; i++) {
		const key: string = ct.names[i];
		if (SENDER_KEYS.indexOf(key) < 0) return undefined;
		out[key] = getValue(ct.table, key);
	}
	const sender: AgentSessionMessageSender = {};
	if (_hasOwn(out, "activeSessionId")) {
		const candidate: unknown = out.activeSessionId;
		if (!boundedIdentifier(candidate)) return undefined;
		sender.activeSessionId = candidate;
	}
	if (_hasOwn(out, "sessionId")) {
		const candidate: unknown = out.sessionId;
		if (!boundedIdentifier(candidate)) return undefined;
		sender.sessionId = candidate;
	}
	if (_hasOwn(out, "sessionName")) {
		const candidate: unknown = out.sessionName;
		if (!boundedIdentifier(candidate)) return undefined;
		sender.sessionName = candidate;
	}
	if (_hasOwn(out, "runtimeKind")) {
		const rk: unknown = out.runtimeKind;
		if (rk !== "top-level" && rk !== "subagent") return undefined;
		sender.runtimeKind = rk;
	}
	if (_hasOwn(out, "clientId")) {
		const candidate: unknown = out.clientId;
		if (!boundedIdentifier(candidate)) return undefined;
		sender.clientId = candidate;
	}
	return sender;
}

function validateDeliverMessageBodyInput(raw: unknown): AgentSessionMessagePayload | undefined {
	if (!isRecord(raw)) return undefined;
	const record = exactRecordSet(raw, DELIVER_MESSAGE_BODY_KEYS);
	if (record === undefined) return undefined;
	const payload: unknown = record.payload;
	if (!isRecord(payload)) return undefined;
	const ct: DescriptorTable | undefined = captureDescriptors(payload);
	if (ct === undefined) return undefined;
	const payloadRecord: Record<string, unknown> = {};
	for (let i: number = 0; i < ct.names.length; i++) {
		const key: string = ct.names[i];
		if (PAYLOAD_KEYS.indexOf(key) < 0) return undefined;
		payloadRecord[key] = getValue(ct.table, key);
	}
	if (!_hasOwn(payloadRecord, "id")) return undefined;
	const id: unknown = payloadRecord.id;
	if (!boundedIdentifier(id)) return undefined;
	if (payloadRecord.source !== AGENT_MESSAGE_SOURCE_LITERAL) return undefined;
	if (!_hasOwn(payloadRecord, "target")) return undefined;
	const target = validateTargetEndpoint(payloadRecord.target);
	if (target === undefined) return undefined;
	let sender: AgentSessionMessageSender | undefined;
	if (_hasOwn(payloadRecord, "from")) {
		sender = validateSender(payloadRecord.from);
		if (sender === undefined) return undefined;
	}
	let fromRelationship: "parent" | "sibling" | "child" | undefined;
	if (_hasOwn(payloadRecord, "fromRelationship")) {
		const fr: unknown = payloadRecord.fromRelationship;
		if (fr !== "parent" && fr !== "sibling" && fr !== "child") return undefined;
		fromRelationship = fr;
	}
	if (!_hasOwn(payloadRecord, "message")) return undefined;
	const message: unknown = payloadRecord.message;
	if (typeof message !== "string" || message.length < 1) return undefined;
	if (!isScalarString(message)) return undefined;
	if (utf8ByteCount(message) > MAX_MESSAGE_UTF8_BYTES) return undefined;
	const canonical: {
		id: string;
		source: "agent_message";
		message?: string;
		from?: AgentSessionMessageSender;
		fromRelationship?: "parent" | "sibling" | "child";
		target: AgentSessionMessageEndpoint;
	} = {
		id: id,
		source: AGENT_MESSAGE_SOURCE_LITERAL,
		target,
	};
	if (sender !== undefined) canonical.from = sender;
	if (fromRelationship !== undefined) canonical.fromRelationship = fromRelationship;
	return _freeze(_assign(canonical, { message }));
}

// ---------- encodeLifecycleRecord ----------

export function encodeLifecycleRecord(input: unknown): LifecycleEncodeResult {
	if (!isRecord(input)) return FAIL_INPUT_INVALID;
	const envelope: DescriptorTable | undefined = captureDescriptors(input);
	if (envelope === undefined) return FAIL_INPUT_INVALID;
	if (envelope.names.length !== 4) return FAIL_INPUT_INVALID;
	const sorted: ReadonlyArray<string> = _freeze(envelope.names.slice().sort());
	const expectedSorted: ReadonlyArray<string> = _freeze(["body", "identity", "op", "v"]);
	for (let i: number = 0; i < 4; i++) {
		if (sorted[i] !== expectedSorted[i]) return FAIL_INPUT_INVALID;
	}
	const v: unknown = getValue(envelope.table, "v");
	if (!_is(v, 1)) return FAIL_INPUT_INVALID;
	const identity: HostedRlmRuntimeIdentity | null = validateIdentity(getValue(envelope.table, "identity"));
	if (identity === null) return FAIL_INPUT_INVALID;
	const op: unknown = getValue(envelope.table, "op");
	if (!isLifecycleOp(op)) return FAIL_UNKNOWN_OP;
	const bodyRaw: unknown = getValue(envelope.table, "body");
	const opStr: string = op;
	if (opStr === "START") {
		const inputBody = validateStartBodyInput(bodyRaw);
		if (inputBody === undefined) return FAIL_INPUT_INVALID;
		const body = encodeStartBody(inputBody);
		const bytes = encodeEnvelope(identity, opStr, body);
		if (bytes === undefined) return FAIL_INPUT_INVALID;
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (opStr === "EVENT") {
		const event = validateEventBodyInput(bodyRaw);
		if (event === undefined) return FAIL_INPUT_INVALID;
		const body: Record<string, unknown> = { event };
		const bytes = encodeEnvelope(identity, opStr, body);
		if (bytes === undefined) return FAIL_INPUT_INVALID;
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (opStr === "TERMINAL") {
		const result = validateTerminalBodyInput(bodyRaw);
		if (result === undefined) return FAIL_INPUT_INVALID;
		const body: Record<string, unknown> = { result };
		const bytes = encodeEnvelope(identity, opStr, body);
		if (bytes === undefined) return FAIL_INPUT_INVALID;
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (opStr === "ABORT" || opStr === "CLOSE" || opStr === "OBSERVE") {
		if (!validateEmptyBodyInput(bodyRaw)) return FAIL_INPUT_INVALID;
		const body: Record<string, unknown> = Object.create(null);
		const bytes = encodeEnvelope(identity, opStr, body);
		if (bytes === undefined) return FAIL_INPUT_INVALID;
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (opStr === "DELIVER_MESSAGE") {
		const payload = validateDeliverMessageBodyInput(bodyRaw);
		if (payload === undefined) return FAIL_INPUT_INVALID;
		const body: Record<string, unknown> = { payload };
		const bytes = encodeEnvelope(identity, opStr, body);
		if (bytes === undefined) return FAIL_INPUT_INVALID;
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	return FAIL_UNKNOWN_OP;
}

// ---------- decodeLifecycleRecord ----------

function makeWireBuf(input: unknown): Uint8Array | undefined {
	const copyResult = copySandboxStrictBytes(input, MAX_LIFECYCLE_PAYLOAD);
	if (!copyResult.ok) return undefined;
	return copyResult.value;
}

export function decodeLifecycleRecord(input: unknown): LifecycleDecodeRecordResult {
	const buf: Uint8Array | undefined = makeWireBuf(input);
	if (buf === undefined) {
		const copyResult = copySandboxStrictBytes(input, MAX_LIFECYCLE_PAYLOAD);
		if (!copyResult.ok) {
			if (copyResult.code === "INPUT_TOO_LARGE") return FAIL_RECORD_BOUNDS_EXCEEDED;
		}
		return FAIL_RECORD_INPUT_INVALID;
	}
	let zeroed = false;
	const zeroBuf = (): void => {
		if (zeroed) return;
		zeroed = true;
		buf.fill(0);
	};
	const fail = (result: LifecycleDecodeRecordResult): LifecycleDecodeRecordResult => {
		zeroBuf();
		return result;
	};
	try {
		let text: string;
		try {
			text = _decodeFatal(buf);
		} catch {
			return fail(FAIL_RECORD_MALFORMED_BODY);
		}
		let parsed: unknown;
		try {
			parsed = _JSON_parse(text);
		} catch {
			return fail(FAIL_RECORD_MALFORMED_BODY);
		}
		if (!isRecord(parsed)) return fail(FAIL_RECORD_INPUT_INVALID);
		const envelope = exactRecordOrdered(parsed, _freeze(["v", "identity", "op", "body"]));
		if (envelope === undefined) return fail(FAIL_RECORD_INPUT_INVALID);
		if (!_is(envelope.v, 1)) return fail(FAIL_RECORD_INPUT_INVALID);
		const identity = validateIdentity(envelope.identity);
		if (identity === null) return fail(FAIL_RECORD_MALFORMED_IDENTITY);
		const op: unknown = envelope.op;
		if (!isLifecycleOp(op)) return fail(FAIL_RECORD_UNKNOWN_OP);
		const opStr: string = op;
		const bodyParsed: unknown = envelope.body;
		if (!isRecord(bodyParsed)) return fail(FAIL_RECORD_MALFORMED_BODY);
		if (opStr === "START") {
			const decoded = decodeStartBody(bodyParsed);
			if (decoded === undefined) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonicalBody = buildStartCanonicalBody(decoded);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "START";
			canonical.body = canonicalBody;
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			const record: {
				ok: true;
				op: "START";
				identity: HostedRlmRuntimeIdentity;
				prompt: string;
				promptSha256: string;
				spawnCode?: string;
				spawnCodeSha256?: string;
			} = {
				ok: true,
				op: "START",
				identity,
				prompt: decoded.prompt,
				promptSha256: decoded.promptSha256,
			};
			if (decoded.spawnCode !== undefined) record.spawnCode = decoded.spawnCode;
			if (decoded.spawnCodeSha256 !== undefined) record.spawnCodeSha256 = decoded.spawnCodeSha256;
			return _freeze(record);
		}
		if (opStr === "EVENT") {
			const event = decodeEventBody(bodyParsed);
			if (event === undefined) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "EVENT";
			canonical.body = { event };
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "EVENT", identity, event });
		}
		if (opStr === "TERMINAL") {
			const result = decodeTerminalBody(bodyParsed);
			if (result === undefined) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "TERMINAL";
			canonical.body = { result };
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "TERMINAL", identity, result });
		}
		if (opStr === "ABORT") {
			if (!exactRecordZeroKeys(bodyParsed)) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "ABORT";
			canonical.body = Object.create(null);
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "ABORT", identity });
		}
		if (opStr === "CLOSE") {
			if (!exactRecordZeroKeys(bodyParsed)) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "CLOSE";
			canonical.body = Object.create(null);
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "CLOSE", identity });
		}
		if (opStr === "OBSERVE") {
			if (!exactRecordZeroKeys(bodyParsed)) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "OBSERVE";
			canonical.body = Object.create(null);
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "OBSERVE", identity });
		}
		if (opStr === "DELIVER_MESSAGE") {
			if (!isRecord(bodyParsed)) return fail(FAIL_RECORD_MALFORMED_BODY);
			const payload = validateDeliverMessageBodyInput(bodyParsed);
			if (payload === undefined) return fail(FAIL_RECORD_MALFORMED_BODY);
			const canonical: Record<string, unknown> = Object.create(null);
			canonical.v = 1;
			canonical.identity = identity;
			canonical.op = "DELIVER_MESSAGE";
			canonical.body = { payload };
			const canonicalBytes = makeCanonicalJson(canonical);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_RECORD_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "DELIVER_MESSAGE", identity, payload });
		}
		return fail(FAIL_RECORD_UNKNOWN_OP);
	} finally {
		zeroBuf();
	}
}

// ---------- encodeLifecycleReply ----------

export function encodeLifecycleReply(expectedOp: unknown, body: unknown): LifecycleEncodeResult {
	if (!isLifecycleOp(expectedOp)) return FAIL_UNKNOWN_OP;
	const op: string = expectedOp;
	if (op === "START") {
		if (!isRecord(body)) return FAIL_INPUT_INVALID;
		const record = exactRecordSet(body, _freeze(["code"]));
		if (record === undefined) return FAIL_INPUT_INVALID;
		if (record.code !== "ADMITTED") return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly({ code: "ADMITTED" });
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (op === "EVENT" || op === "TERMINAL") {
		if (!isRecord(body)) return FAIL_INPUT_INVALID;
		const record = exactRecordSet(body, _freeze(["code"]));
		if (record === undefined) return FAIL_INPUT_INVALID;
		if (record.code !== "ACK") return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly({ code: "ACK" });
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (op === "ABORT") {
		if (!isRecord(body)) return FAIL_INPUT_INVALID;
		const record = exactRecordAllowMissing(body, _freeze(["status"]));
		if (record === undefined) return FAIL_INPUT_INVALID;
		if (record.status !== "aborted" && record.status !== "already_terminal") return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly({ status: record.status });
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (op === "CLOSE") {
		if (!isRecord(body)) return FAIL_INPUT_INVALID;
		const record = exactRecordAllowMissing(body, _freeze(["status"]));
		if (record === undefined) return FAIL_INPUT_INVALID;
		if (record.status !== "closed") return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly({ status: "closed" });
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (op === "DELIVER_MESSAGE") {
		if (!isRecord(body)) return FAIL_INPUT_INVALID;
		const record = exactRecordSet(body, _freeze(["status"]));
		if (record === undefined) return FAIL_INPUT_INVALID;
		if (record.status !== "delivered" && record.status !== "queued") return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly({ status: record.status });
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	if (op === "OBSERVE") {
		const obs = validateObservation(body);
		if (obs === null) return FAIL_INPUT_INVALID;
		const bytes = encodeJsonOnly(obs);
		if (bytes.byteLength > MAX_LIFECYCLE_PAYLOAD) return FAIL_BOUNDS_EXCEEDED;
		return encodeSuccess(bytes);
	}
	return FAIL_UNKNOWN_OP;
}

// ---------- decodeLifecycleReply ----------

export function decodeLifecycleReply(input: unknown, expectedOp: unknown): LifecycleDecodeReplyResult {
	if (!isLifecycleOp(expectedOp)) return FAIL_REPLY_INPUT_INVALID;
	const op: string = expectedOp;
	const buf: Uint8Array | undefined = makeWireBuf(input);
	if (buf === undefined) {
		const copyResult = copySandboxStrictBytes(input, MAX_LIFECYCLE_PAYLOAD);
		if (!copyResult.ok) {
			if (copyResult.code === "INPUT_TOO_LARGE") return FAIL_REPLY_BOUNDS_EXCEEDED;
		}
		return FAIL_REPLY_INPUT_INVALID;
	}
	let zeroed = false;
	const zeroBuf = (): void => {
		if (zeroed) return;
		zeroed = true;
		buf.fill(0);
	};
	const fail = (result: LifecycleDecodeReplyResult): LifecycleDecodeReplyResult => {
		zeroBuf();
		return result;
	};
	try {
		let text: string;
		try {
			text = _decodeFatal(buf);
		} catch {
			return fail(FAIL_REPLY_MALFORMED_BODY);
		}
		let parsed: unknown;
		try {
			parsed = _JSON_parse(text);
		} catch {
			return fail(FAIL_REPLY_MALFORMED_BODY);
		}
		if (!isRecord(parsed)) return fail(FAIL_REPLY_MALFORMED_BODY);
		if (op === "START") {
			const record = exactRecordSet(parsed, _freeze(["code"]));
			if (record === undefined) return fail(FAIL_REPLY_OP_MISMATCH);
			if (record.code !== "ADMITTED") return fail(FAIL_REPLY_OP_MISMATCH);
			const canonicalBytes = encodeJsonOnly({ code: "ADMITTED" });
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "START", body: _freeze({ code: "ADMITTED" }) });
		}
		if (op === "EVENT" || op === "TERMINAL") {
			const record = exactRecordSet(parsed, _freeze(["code"]));
			if (record === undefined) return fail(FAIL_REPLY_OP_MISMATCH);
			if (record.code !== "ACK") return fail(FAIL_REPLY_OP_MISMATCH);
			const canonicalBytes = encodeJsonOnly({ code: "ACK" });
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			if (op === "EVENT") {
				return _freeze({ ok: true, op: "EVENT", body: _freeze({ code: "ACK" }) });
			}
			return _freeze({ ok: true, op: "TERMINAL", body: _freeze({ code: "ACK" }) });
		}
		if (op === "ABORT") {
			const record = exactRecordAllowMissing(parsed, _freeze(["status"]));
			if (record === undefined) return fail(FAIL_REPLY_OP_MISMATCH);
			if (record.status !== "aborted" && record.status !== "already_terminal") return fail(FAIL_REPLY_OP_MISMATCH);
			const canonicalBytes = encodeJsonOnly({ status: record.status });
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "ABORT", body: _freeze({ status: record.status }) });
		}
		if (op === "CLOSE") {
			const record = exactRecordAllowMissing(parsed, _freeze(["status"]));
			if (record === undefined) return fail(FAIL_REPLY_OP_MISMATCH);
			if (record.status !== "closed") return fail(FAIL_REPLY_OP_MISMATCH);
			const canonicalBytes = encodeJsonOnly({ status: "closed" });
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "CLOSE", body: _freeze({ status: "closed" }) });
		}
		if (op === "DELIVER_MESSAGE") {
			const record = exactRecordSet(parsed, _freeze(["status"]));
			if (record === undefined) return fail(FAIL_REPLY_OP_MISMATCH);
			if (record.status !== "delivered" && record.status !== "queued") return fail(FAIL_REPLY_OP_MISMATCH);
			const canonicalBytes = encodeJsonOnly({ status: record.status });
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "DELIVER_MESSAGE", body: _freeze({ status: record.status }) });
		}
		if (op === "OBSERVE") {
			const obs = validateObservation(parsed);
			if (obs === null) return fail(FAIL_REPLY_MALFORMED_BODY);
			const canonicalBytes = encodeJsonOnly(obs);
			if (!bytesEqual(canonicalBytes, buf)) return fail(FAIL_REPLY_CANONICAL_MISMATCH);
			zeroBuf();
			return _freeze({ ok: true, op: "OBSERVE", body: obs });
		}
		return fail(FAIL_REPLY_INPUT_INVALID);
	} finally {
		zeroBuf();
	}
}
