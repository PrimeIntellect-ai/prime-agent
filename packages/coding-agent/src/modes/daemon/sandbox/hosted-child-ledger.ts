/**
 * hosted-child-ledger.ts - Hosted Child Ledger V1 semantic codec.
 *
 * Pure deterministic hosted-child ledger codec over opaque single-record byte
 * wrappers. Every public entry point accepts `unknown` and returns deeply frozen
 * discriminated-union results with no `LedgerRecord`, `LedgerIdentity`,
 * `LedgerRecordBytes`, `LedgerBounds`, or `LedgerRecord[]` in public parameter
 * position - only as return types.
 *
 * No casts, `as unknown as`, `as`, assertions, `any`, non-null assertions,
 * `as const`, spread, `instanceof`, `throw`, TODO, placeholder, or
 * `Object.setPrototypeOf` appear in this file.
 */

import { createHash } from "node:crypto";
import * as util from "node:util";
import type { SandboxStrictByteCopyResult } from "./prime-sandbox-strict-bytes.js";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// =========================================================================
// 1. Captured intrinsics
// =========================================================================

const _getPrototypeOf: (o: object) => object = Object.getPrototypeOf;
const _getOwnPropertyNames: (o: object) => string[] = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: (o: object) => symbol[] = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptor: (o: object, p: string) => PropertyDescriptor | undefined =
	Object.getOwnPropertyDescriptor;
const _freeze: <T extends object>(o: T) => T = Object.freeze;
const _isFrozen: (o: object) => boolean = Object.isFrozen;
const _hasOwn: (o: object, p: string) => boolean = Object.hasOwn;
const _isProxy: (o: object) => boolean = util.types.isProxy;
// biome-ignore lint/complexity/noBannedTypes: Reflect.apply needs generic function type
const _reflectApply: Function = Reflect.apply;
// biome-ignore lint/complexity/noBannedTypes: Reflect.construct needs generic function type
const _reflectConstruct: Function = Reflect.construct;
// biome-ignore lint/complexity/noBannedTypes: Captured WeakMap.prototype.get
const _weakMapProtoGet: Function = WeakMap.prototype.get;
// biome-ignore lint/complexity/noBannedTypes: Captured WeakMap.prototype.set
const _weakMapProtoSet: Function = WeakMap.prototype.set;

// =========================================================================
// 2. String enum sets
// =========================================================================

const _LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set<string>([
	"reserved",
	"allocating",
	"allocated",
	"starting",
	"running",
	"completed",
	"error",
	"cancelled",
	"deleting",
	"cleanup-uncertain",
	"deleted",
]);

const _TERMINAL_STATUS_SET: ReadonlySet<string | null> = new Set<string | null>([
	"completed",
	"error",
	"cancelled",
	null,
]);

const _TERMINAL_CODE_SET: ReadonlySet<string | null> = new Set<string | null>([
	"SUCCESS",
	"FAILURE",
	"TIMEOUT",
	"EVICTED",
	"USER_STOP",
	"PARENT_STOP",
	"REVOKED",
	"MAX_DEPTH",
	"INTERNAL",
	"UNKNOWN",
	null,
]);

const _THINKING_LEVEL_SET: ReadonlySet<string> = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const _SERVICE_TIER_SET: ReadonlySet<string | null> = new Set<string | null>([
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
	null,
]);

const _TERMINAL_LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set<string>(["completed", "error", "cancelled"]);

const _POST_TERMINAL_STATUS_SET: ReadonlySet<string> = new Set<string>(["deleting", "cleanup-uncertain", "deleted"]);

// =========================================================================
// 3. Public exact string type aliases
// =========================================================================

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;
type LifecycleStatus =
	| "reserved"
	| "allocating"
	| "allocated"
	| "starting"
	| "running"
	| "completed"
	| "error"
	| "cancelled"
	| "deleting"
	| "cleanup-uncertain"
	| "deleted";
type TerminalStatus = "completed" | "error" | "cancelled" | null;
type TerminalCode =
	| "SUCCESS"
	| "FAILURE"
	| "TIMEOUT"
	| "EVICTED"
	| "USER_STOP"
	| "PARENT_STOP"
	| "REVOKED"
	| "MAX_DEPTH"
	| "INTERNAL"
	| "UNKNOWN"
	| null;

// =========================================================================
// 3. LedgerRecordBytes
// =========================================================================

let _issueLedgerRecordBytesSequence: (() => LedgerRecordBytes) | undefined;

const _ISSUE_TOKEN: object = Object.freeze({});

class LedgerRecordBytes {
	private constructor(_token: object) {}

	static {
		_issueLedgerRecordBytesSequence = (): LedgerRecordBytes => {
			const instance: LedgerRecordBytes = new LedgerRecordBytes(_ISSUE_TOKEN);
			Object.freeze(instance);
			return instance;
		};
		Object.freeze(LedgerRecordBytes.prototype);
		Object.freeze(LedgerRecordBytes);
	}
}

const _bufferMap: WeakMap<LedgerRecordBytes, ArrayBuffer> = new WeakMap<LedgerRecordBytes, ArrayBuffer>();

// =========================================================================
// 4. Captured TypedArray/ArrayBuffer getter descriptors
// =========================================================================

// Retained for decode/inventory view byteLength access
const _u8BLDesc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(
	_getPrototypeOf(Uint8Array.prototype),
	"byteLength",
);

// Retained for brand check (abProto) and reveal (abByteLengthDesc)
const _abProto: object = _getPrototypeOf(new ArrayBuffer(0));
const _abByteLengthDesc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
);

// =========================================================================
// 5. Type definitions
// =========================================================================

type LedgerErrorCode =
	| "HOSTILE_INPUT"
	| "BRAND_CHECK_FAILURE"
	| "DECODE_FAILURE"
	| "CANONICAL_BYTES_MISMATCH"
	| "FIELD_TYPE_MISMATCH"
	| "FIELD_TOO_LARGE"
	| "FIELD_UNKNOWN_KEY"
	| "FIELD_NON_PRINTABLE"
	| "FIELD_STATUS_INVALID"
	| "FIELD_TERMINAL_STATUS_INVALID"
	| "FIELD_TERMINAL_CODE_INVALID"
	| "FIELD_THINKING_LEVEL_INVALID"
	| "FIELD_SERVICE_TIER_INVALID"
	| "FIELD_ANCHOR_INVALID"
	| "GENESIS_REV_NOT_ZERO"
	| "GENESIS_STATUS_NOT_RESERVED"
	| "GENESIS_HAS_PREV_DIGEST"
	| "GENESIS_HAS_TERMINAL"
	| "GENESIS_HAS_TERMINAL_CODE"
	| "GENESIS_FIELD_UNEXPECTED"
	| "EMPTY_CHAIN"
	| "NON_MONOTONIC_REVISION"
	| "PREV_DIGEST_MISMATCH"
	| "CONTENT_DIGEST_MISMATCH"
	| "INVALID_TRANSITION"
	| "TERMINAL_BEFORE_COMPLETED"
	| "MISSING_TERMINAL_PAIR_ON_TERMINAL"
	| "TERMINAL_PAIR_CHANGED"
	| "NULL_TERMINAL_STATUS_WITH_CODE"
	| "TERMINAL_STATUS_CONTRADICTION"
	| "LIFECYCLE_ANCHOR_CHANGED"
	| "IDENTITY_FIELD_CHANGED"
	| "LIFECYCLE_KEY_DIGEST_MISMATCH"
	| "BOUND_RECORDS_EXCEEDED"
	| "BOUND_BYTES_EXCEEDED"
	| "BOUND_RECORD_BYTES_EXCEEDED"
	| "BOUND_GROUPS_EXCEEDED"
	| "ANCHOR_REUSE_IDENTITY_COLLISION"
	| "LIFECYCLE_DIGEST_COLLISION"
	| "DUPLICATE_REV"
	| "FORK_DETECTED"
	| "GAP_DETECTED"
	| "ORPHAN_DETECTED";

interface LedgerIdentity {
	readonly schema: "hosted-child-ledger-v1";
	readonly lifecycleKeyDigest: string;
	readonly sessionId: string;
	readonly activeSessionId: string;
	readonly childId: string;
	readonly name: string;
	readonly modelSelector: string;
	readonly durableParentSessionId: string;
	readonly rlmParentNodeId: string;
	readonly spawnedByRequestId: string | null;
	readonly thinkingLevel: ThinkingLevel;
	readonly serviceTier: ServiceTier | null;
	readonly spawnContextDigest: string;
	readonly depth: number;
}

interface LedgerRecord {
	readonly schema: "hosted-child-ledger-v1";
	readonly identity: LedgerIdentity;
	readonly rev: number;
	readonly status: LifecycleStatus;
	readonly terminalStatus: TerminalStatus;
	readonly terminalCode: TerminalCode;
	readonly contentDigest: string;
	readonly prevDigest: string | null;
}

interface LedgerAnchor {
	readonly childId: string;
	readonly sessionId: string;
	readonly activeSessionId: string;
}

interface LedgerInventoryGroup {
	readonly anchor: LedgerAnchor;
	readonly chain: readonly LedgerRecord[];
	readonly totalBytes: number;
}

// - Result types -

interface DecodeSuccess {
	readonly code: "OK";
	readonly record: LedgerRecord;
}

interface DecodeFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type DecodeResult = DecodeSuccess | DecodeFailure;

interface EncodeSuccess {
	readonly code: "OK";
	readonly bytes: LedgerRecordBytes;
}

interface EncodeFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type EncodeResult = EncodeSuccess | EncodeFailure;

interface AppendSuccess {
	readonly code: "OK";
	readonly record: LedgerRecord;
	readonly bytes: LedgerRecordBytes;
}

interface AppendFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type AppendResult = AppendSuccess | AppendFailure;

interface ValidateSuccess {
	readonly code: "OK";
}

interface ValidateFailure {
	readonly code: "FAIL";
	readonly errors: readonly LedgerErrorCode[];
}

type ValidateChainResult = ValidateSuccess | ValidateFailure;

interface DecodeJournalSuccess {
	readonly code: "OK";
	readonly records: readonly LedgerRecord[];
}

interface DecodeJournalFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type DecodeJournalResult = DecodeJournalSuccess | DecodeJournalFailure;

interface InventorySuccess {
	readonly code: "OK";
	readonly groups: readonly LedgerInventoryGroup[];
}

interface InventoryFailure {
	readonly code: "FAIL";
	readonly errors: readonly LedgerErrorCode[];
}

type InventoryResult = InventorySuccess | InventoryFailure;

interface RevealSuccess {
	readonly code: "OK";
	readonly data: Uint8Array;
}

interface RevealFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type RevealResult = RevealSuccess | RevealFailure;

// - Internal types -

interface MintSuccess {
	readonly code: "OK";
	readonly bytes: LedgerRecordBytes;
	readonly record: LedgerRecord;
}

interface MintFailure {
	readonly code: "FAIL";
	readonly error: LedgerErrorCode;
}

type MintResult = MintSuccess | MintFailure;

interface BrandOk {
	readonly ok: true;
	readonly buffer: unknown;
}

interface BrandFail {
	readonly ok: false;
	readonly error: LedgerErrorCode;
}

type BrandResult = BrandOk | BrandFail;

// =========================================================================
// 6. Digest helpers
// =========================================================================

const _HEX64: RegExp = /^[0-9a-f]{64}$/;
const _C64ZEROS: string = "0000000000000000000000000000000000000000000000000000000000000000";

const _LIFECYCLE_KEY_FIELDS: readonly string[] = Object.freeze([
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);

const _CANONICAL_RECORD_FIELDS: readonly string[] = Object.freeze([
	"schema",
	"identity",
	"rev",
	"status",
	"terminalStatus",
	"terminalCode",
	"contentDigest",
	"prevDigest",
]);

const _CANONICAL_IDENTITY_FIELDS: readonly string[] = Object.freeze([
	"schema",
	"lifecycleKeyDigest",
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);

function _serializeFieldValue(value: unknown): Uint8Array {
	if (value === null) {
		return new TextEncoder().encode("null");
	}
	if (typeof value === "boolean") {
		return new TextEncoder().encode(value ? "true" : "false");
	}
	if (typeof value === "number") {
		return new TextEncoder().encode(String(value));
	}
	if (typeof value === "string") {
		return new TextEncoder().encode(value);
	}
	return new TextEncoder().encode("");
}

function _sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf-8").digest("hex");
}

function _sha256HexBytes(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function _serializeIdentityTuple(identity: Record<string, unknown>): Uint8Array {
	const parts_list: Uint8Array[] = [];
	const LE32: DataView = new DataView(new ArrayBuffer(4));
	for (const field of _LIFECYCLE_KEY_FIELDS) {
		const val: unknown = identity[field];
		const raw: Uint8Array = _serializeFieldValue(val);
		LE32.setUint32(0, raw.byteLength, true);
		parts_list.push(new Uint8Array(LE32.buffer.slice(0)));
		parts_list.push(raw);
	}
	const totalLen: number = parts_list.reduce((acc: number, p: Uint8Array) => acc + p.byteLength, 0);
	const result: Uint8Array = new Uint8Array(totalLen);
	let offset: number = 0;
	for (const p of parts_list) {
		result.set(p, offset);
		offset += p.byteLength;
	}
	return result;
}

function _deriveLifecycleKeyDigest(identity: Record<string, unknown>): string {
	const payload: Uint8Array = _serializeIdentityTuple(identity);
	return _sha256HexBytes(payload);
}

// =========================================================================
// 7. Canonical serialization
// =========================================================================

function _buildRecordJSON(record: object, zeroContentDigest: boolean): string {
	const fields: string[] = [];
	for (const k of _CANONICAL_RECORD_FIELDS) {
		if (_hasOwn(record, k)) {
			let v: unknown;
			if (k === "contentDigest" && zeroContentDigest) {
				v = _C64ZEROS;
			} else {
				v = Reflect.get(record, k);
			}
			fields.push(`"${k}":${_canonicalJSON(v, _CANONICAL_RECORD_FIELDS)}`);
		}
	}
	return `{${fields.join(",")}}`;
}

function _canonicalJSON(obj: unknown, fieldOrder: readonly string[]): string {
	if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
		const lkd: unknown = Reflect.get(obj, "lifecycleKeyDigest");
		const order: readonly string[] = typeof lkd === "string" ? _CANONICAL_IDENTITY_FIELDS : fieldOrder;
		const fields: string[] = [];
		for (const k of order) {
			if (_hasOwn(obj, k)) {
				const v: unknown = Reflect.get(obj, k);
				fields.push(`"${k}":${_canonicalJSON(v, fieldOrder)}`);
			}
		}
		return `{${fields.join(",")}}`;
	}
	if (typeof obj === "string") {
		return JSON.stringify(obj);
	}
	if (typeof obj === "boolean") {
		return obj ? "true" : "false";
	}
	if (typeof obj === "number" || typeof obj === "bigint") {
		return String(obj);
	}
	if (obj === null) {
		return "null";
	}
	if (Array.isArray(obj)) {
		const items: string[] = [];
		for (const item of obj) {
			items.push(_canonicalJSON(item, fieldOrder));
		}
		return `[${items.join(",")}]`;
	}
	return JSON.stringify(obj);
}

function _deriveContentDigest(record: object): string {
	const preimage: string = _buildRecordJSON(record, true);
	return _sha256Hex(preimage);
}

function _canonicalRecordBytes(record: object): Uint8Array {
	const preimage: string = _buildRecordJSON(record, false);
	const encoded: Uint8Array = new TextEncoder().encode(preimage);
	const result: Uint8Array = new Uint8Array(encoded.byteLength + 1);
	result.set(encoded, 0);
	result[encoded.byteLength] = 0x0a;
	return result;
}

// =========================================================================
// 8. Plain object validation
// =========================================================================

function _validatePlainObject(raw: unknown): object | string {
	if (typeof raw !== "object" || raw === null) return "HOSTILE_INPUT";
	if (_isProxy(raw)) return "HOSTILE_INPUT";
	if (_getPrototypeOf(raw) !== Object.prototype) return "HOSTILE_INPUT";
	if (_getOwnPropertySymbols(raw).length > 0) return "HOSTILE_INPUT";
	const names: string[] = _getOwnPropertyNames(raw);
	for (const name of names) {
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, name);
		if (desc === undefined) return "HOSTILE_INPUT";
		if (desc.get !== undefined || desc.set !== undefined) return "HOSTILE_INPUT";
		if (desc.value === undefined) return "HOSTILE_INPUT";
		if (desc.enumerable !== true) return "HOSTILE_INPUT";
		const val: unknown = desc.value;
		if (typeof val === "object" && val !== null) {
			if (_isProxy(val)) return "HOSTILE_INPUT";
		}
	}
	const result: Record<string, unknown> = {};
	for (const name of names) {
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, name);
		if (desc === undefined) return "HOSTILE_INPUT";
		result[name] = desc.value;
	}
	return result;
}

function _validatePlainObjectExpected(raw: unknown, expectedFields: readonly string[]): object | string {
	const objResult: object | string = _validatePlainObject(raw);
	if (typeof objResult === "string") return objResult;
	const obj: object = objResult;
	const names: string[] = _getOwnPropertyNames(obj);
	if (names.length !== expectedFields.length) return "FIELD_UNKNOWN_KEY";
	for (const name of names) {
		if (expectedFields.indexOf(name) === -1) return "FIELD_UNKNOWN_KEY";
	}
	const fresh: Record<string, unknown> = {};
	for (const name of expectedFields) {
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(obj, name);
		if (desc === undefined) continue;
		fresh[name] = desc.value;
	}
	return fresh;
}

// =========================================================================
// 9. Dense array validation
// =========================================================================

function _validateDenseArray(raw: unknown): unknown[] | string {
	if (typeof raw !== "object" || raw === null) return "HOSTILE_INPUT";
	if (_isProxy(raw)) return "HOSTILE_INPUT";
	if (_getPrototypeOf(raw) !== Array.prototype) return "HOSTILE_INPUT";
	if (_getOwnPropertySymbols(raw).length > 0) return "HOSTILE_INPUT";

	const ownNames: string[] = _getOwnPropertyNames(raw);
	const lenDesc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, "length");
	if (lenDesc === undefined) return "HOSTILE_INPUT";
	if (lenDesc.writable !== true) return "HOSTILE_INPUT";
	if (lenDesc.enumerable !== false) return "HOSTILE_INPUT";
	if (lenDesc.configurable !== false) return "HOSTILE_INPUT";

	const lengthVal: unknown = lenDesc.value;
	if (typeof lengthVal !== "number" || !Number.isSafeInteger(lengthVal) || lengthVal < 0) {
		return "HOSTILE_INPUT";
	}
	const length: number = lengthVal;

	if (ownNames.length !== 1 + length) return "HOSTILE_INPUT";

	const seen: Set<object> = new Set<object>();

	for (let i: number = 0; i < length; i++) {
		const idx: string = String(i);
		if (ownNames.indexOf(idx) === -1) return "HOSTILE_INPUT";
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, idx);
		if (desc === undefined) return "HOSTILE_INPUT";
		if (desc.get !== undefined || desc.set !== undefined) return "HOSTILE_INPUT";
		if (desc.value === undefined) return "HOSTILE_INPUT";
		if (desc.writable !== true) return "HOSTILE_INPUT";
		if (desc.enumerable !== true) return "HOSTILE_INPUT";
		if (desc.configurable !== true) return "HOSTILE_INPUT";
		if (typeof desc.value === "object" && desc.value !== null) {
			if (_isProxy(desc.value)) return "HOSTILE_INPUT";
			if (seen.has(desc.value)) return "HOSTILE_INPUT";
			seen.add(desc.value);
		}
	}

	const arr: unknown[] = [];
	for (let i: number = 0; i < length; i++) {
		const idx: string = String(i);
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, idx);
		if (desc === undefined) return "HOSTILE_INPUT";
		arr.push(desc.value);
	}
	return arr;
}

// =========================================================================
// 10. Uint8Array validation (storage ingress only)
// =========================================================================

function _validateUint8Array(raw: unknown): Uint8Array | string {
	const sbResult: SandboxStrictByteCopyResult = copySandboxStrictBytes(raw, 1048576);
	if (!sbResult.ok) {
		if (sbResult.code === "INPUT_TOO_LARGE") return "BOUND_RECORD_BYTES_EXCEEDED";
		return "HOSTILE_INPUT";
	}
	return sbResult.value;
}

// =========================================================================
// 11. Brand validation
// =========================================================================

function _brandCheckResultOk(buffer: unknown): BrandOk {
	const obj: BrandOk = { ok: true, buffer };
	_freeze(obj);
	return obj;
}

function _brandCheckResultFail(error: LedgerErrorCode): BrandFail {
	const obj: BrandFail = { ok: false, error };
	_freeze(obj);
	return obj;
}

function _brandCheck(raw: unknown): BrandResult {
	if (typeof raw !== "object" || raw === null) return _brandCheckResultFail("BRAND_CHECK_FAILURE");
	if (_isProxy(raw)) return _brandCheckResultFail("BRAND_CHECK_FAILURE");
	if (_getPrototypeOf(raw) !== LedgerRecordBytes.prototype) return _brandCheckResultFail("BRAND_CHECK_FAILURE");
	const bufUnknown: unknown = _reflectApply(_weakMapProtoGet, _bufferMap, [raw]);
	if (typeof bufUnknown !== "object" || bufUnknown === null) return _brandCheckResultFail("BRAND_CHECK_FAILURE");
	if (_getPrototypeOf(bufUnknown) !== _abProto) return _brandCheckResultFail("BRAND_CHECK_FAILURE");
	return _brandCheckResultOk(bufUnknown);
}

// =========================================================================
// 12. Record field validation helpers
// =========================================================================

function _isPrintableASCII(s: string): boolean {
	for (let i: number = 0; i < s.length; i++) {
		const code: number = s.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function _isValidUnicodeNoControls(s: string): boolean {
	for (let i: number = 0; i < s.length; i++) {
		const code: number = s.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
			return false;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			i++;
			if (i >= s.length) return false;
			const next: number = s.charCodeAt(i);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function _utf8ByteLength(s: string): number {
	let bytes: number = 0;
	for (let i: number = 0; i < s.length; i++) {
		const code: number = s.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return -1;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function _checkStr(val: unknown, maxBytes: number, printable: boolean, unicodeOk: boolean): string | undefined {
	if (typeof val !== "string") return "FIELD_TYPE_MISMATCH";
	if (val.length === 0) return "FIELD_TYPE_MISMATCH";
	if (printable && !_isPrintableASCII(val)) return "FIELD_NON_PRINTABLE";
	if (unicodeOk && !_isValidUnicodeNoControls(val)) return "FIELD_NON_PRINTABLE";
	const byteLen: number = _utf8ByteLength(val);
	if (byteLen < 0 || byteLen > maxBytes) return "FIELD_TOO_LARGE";
	return undefined;
}

function _checkHex64(val: unknown): string | undefined {
	if (typeof val !== "string") return "FIELD_TYPE_MISMATCH";
	if (!_HEX64.test(val)) return "FIELD_TYPE_MISMATCH";
	return undefined;
}

function _checkSafeIntGE0(val: unknown): string | undefined {
	if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) return "FIELD_TYPE_MISMATCH";
	return undefined;
}

function _checkSafeIntGE1(val: unknown): string | undefined {
	if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1) return "FIELD_TYPE_MISMATCH";
	return undefined;
}

// =========================================================================
// 13. Input field lists and validators
// =========================================================================

const _EXPECTED_GENESIS_FIELDS: readonly string[] = Object.freeze([
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);

const _EXPECTED_TRANSITION_FIELDS: readonly string[] = Object.freeze(["status", "terminalStatus", "terminalCode"]);

const _EXPECTED_BOUNDS_FIELDS: readonly string[] = Object.freeze([
	"maxRecords",
	"maxBytes",
	"maxRecordBytes",
	"maxGroups",
]);

// =========================================================================
// 14. Record field validation (full record including identity)
// =========================================================================

function _validateRecordFields(record: object): string | undefined {
	const schemaVal: unknown = Reflect.get(record, "schema");
	if (typeof schemaVal !== "string") return "FIELD_TYPE_MISMATCH";
	if (schemaVal !== "hosted-child-ledger-v1") return "FIELD_TYPE_MISMATCH";
	const schemaBytes: number = _utf8ByteLength(schemaVal);
	if (schemaBytes < 0 || schemaBytes >= 128) return "FIELD_TOO_LARGE";

	const identityVal: unknown = Reflect.get(record, "identity");
	if (typeof identityVal !== "object" || identityVal === null) return "FIELD_TYPE_MISMATCH";
	const identityObj: object = identityVal;

	const errLkd: string | undefined = _checkHex64(Reflect.get(identityObj, "lifecycleKeyDigest"));
	if (errLkd !== undefined) return errLkd;

	for (const fld of ["sessionId", "activeSessionId", "childId"]) {
		const e: string | undefined = _checkStr(Reflect.get(identityObj, fld), 1024, true, false);
		if (e !== undefined) return e;
	}

	const eName: string | undefined = _checkStr(Reflect.get(identityObj, "name"), 2048, false, true);
	if (eName !== undefined) return eName;

	const eModel: string | undefined = _checkStr(Reflect.get(identityObj, "modelSelector"), 4096, false, true);
	if (eModel !== undefined) return eModel;

	for (const fld of ["durableParentSessionId", "rlmParentNodeId"]) {
		const e: string | undefined = _checkStr(Reflect.get(identityObj, fld), 1024, true, false);
		if (e !== undefined) return e;
	}

	const sbr: unknown = Reflect.get(identityObj, "spawnedByRequestId");
	if (sbr !== null) {
		const e: string | undefined = _checkStr(sbr, 1024, true, false);
		if (e !== undefined) return e;
	}

	const tl: unknown = Reflect.get(identityObj, "thinkingLevel");
	if (typeof tl !== "string" || !_THINKING_LEVEL_SET.has(tl)) return "FIELD_THINKING_LEVEL_INVALID";

	const st: unknown = Reflect.get(identityObj, "serviceTier");
	if (st !== null) {
		if (typeof st !== "string" || !_SERVICE_TIER_SET.has(st)) return "FIELD_SERVICE_TIER_INVALID";
	}

	const eSpwn: string | undefined = _checkHex64(Reflect.get(identityObj, "spawnContextDigest"));
	if (eSpwn !== undefined) return eSpwn;

	const depthErr: string | undefined = _checkSafeIntGE0(Reflect.get(identityObj, "depth"));
	if (depthErr !== undefined) return depthErr;

	const revErr: string | undefined = _checkSafeIntGE0(Reflect.get(record, "rev"));
	if (revErr !== undefined) return revErr;

	const status: unknown = Reflect.get(record, "status");
	if (typeof status !== "string" || !_LIFECYCLE_STATUS_SET.has(status)) return "FIELD_STATUS_INVALID";

	const ts: unknown = Reflect.get(record, "terminalStatus");
	if (ts !== null) {
		if (typeof ts !== "string" || !_TERMINAL_STATUS_SET.has(ts)) return "FIELD_TERMINAL_STATUS_INVALID";
	}

	const tc: unknown = Reflect.get(record, "terminalCode");
	if (tc !== null) {
		if (typeof tc !== "string" || !_TERMINAL_CODE_SET.has(tc)) return "FIELD_TERMINAL_CODE_INVALID";
	}

	const eCD: string | undefined = _checkHex64(Reflect.get(record, "contentDigest"));
	if (eCD !== undefined) return eCD;

	const pd: unknown = Reflect.get(record, "prevDigest");
	if (pd !== null) {
		const ePD: string | undefined = _checkHex64(pd);
		if (ePD !== undefined) return ePD;
	}

	return undefined;
}

// =========================================================================
// 15. Bounds validation
// =========================================================================

function _validateBounds(raw: unknown): Record<string, number> | string {
	const plain: object | string = _validatePlainObjectExpected(raw, _EXPECTED_BOUNDS_FIELDS);
	if (typeof plain === "string") return plain;
	const bounds: Record<string, number> = {};
	const names: string[] = _getOwnPropertyNames(plain);
	for (const name of names) {
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(plain, name);
		if (desc === undefined) continue;
		const err: string | undefined = _checkSafeIntGE1(desc.value);
		if (err !== undefined) return "FIELD_TYPE_MISMATCH";
		const n: number = Number(desc.value);
		bounds[name] = n;
	}
	return bounds;
}

// =========================================================================
// 16. Lifecycle state machine
// =========================================================================

function _isValidTransition(fromStatus: string, toStatus: string): boolean {
	if (fromStatus === "reserved") {
		return toStatus === "reserved" || toStatus === "allocating" || toStatus === "error" || toStatus === "cancelled";
	}
	if (fromStatus === "allocating") {
		return toStatus === "allocating" || toStatus === "allocated" || toStatus === "error" || toStatus === "cancelled";
	}
	if (fromStatus === "allocated") {
		return toStatus === "allocated" || toStatus === "starting" || toStatus === "error" || toStatus === "cancelled";
	}
	if (fromStatus === "starting") {
		return toStatus === "starting" || toStatus === "running" || toStatus === "error" || toStatus === "cancelled";
	}
	if (fromStatus === "running") {
		return toStatus === "running" || toStatus === "completed" || toStatus === "error" || toStatus === "cancelled";
	}
	if (fromStatus === "completed") return toStatus === "completed" || toStatus === "deleting";
	if (fromStatus === "error") return toStatus === "error" || toStatus === "deleting";
	if (fromStatus === "cancelled") return toStatus === "cancelled" || toStatus === "deleting";
	if (fromStatus === "deleting") {
		return toStatus === "deleting" || toStatus === "deleted" || toStatus === "cleanup-uncertain";
	}
	if (fromStatus === "cleanup-uncertain") return toStatus === "cleanup-uncertain" || toStatus === "deleting";
	return false;
}

// =========================================================================
// 17. Chain validation
// =========================================================================

function _makeFailResult(error: LedgerErrorCode): ValidateChainResult {
	const errors: readonly LedgerErrorCode[] = Object.freeze([error]);
	const result: ValidateFailure = { code: "FAIL", errors };
	return Object.freeze(result);
}

function _makeOkResult(): ValidateChainResult {
	const result: ValidateSuccess = { code: "OK" };
	return Object.freeze(result);
}

function _buildIdentityRec(identityObj: object): Record<string, unknown> {
	const r: Record<string, unknown> = {};
	for (const f of _LIFECYCLE_KEY_FIELDS) {
		const v: unknown = Reflect.get(identityObj, f);
		r[f] = v;
	}
	return r;
}

function _validateChain(records: readonly object[]): ValidateChainResult {
	if (records.length === 0) return _makeFailResult("EMPTY_CHAIN");

	const first: object = records[0];
	if (Reflect.get(first, "rev") !== 0) return _makeFailResult("GENESIS_REV_NOT_ZERO");
	if (Reflect.get(first, "status") !== "reserved") return _makeFailResult("GENESIS_STATUS_NOT_RESERVED");
	if (Reflect.get(first, "prevDigest") !== null) return _makeFailResult("GENESIS_HAS_PREV_DIGEST");
	if (Reflect.get(first, "terminalStatus") !== null) return _makeFailResult("GENESIS_HAS_TERMINAL");
	if (Reflect.get(first, "terminalCode") !== null) return _makeFailResult("GENESIS_HAS_TERMINAL_CODE");

	// Validate genesis contentDigest and lifecycleKeyDigest
	if (Reflect.get(first, "contentDigest") !== _deriveContentDigest(first)) {
		return _makeFailResult("CONTENT_DIGEST_MISMATCH");
	}
	const firstIdObj: unknown = Reflect.get(first, "identity");
	if (typeof firstIdObj === "object" && firstIdObj !== null) {
		if (Reflect.get(firstIdObj, "lifecycleKeyDigest") !== _deriveLifecycleKeyDigest(_buildIdentityRec(firstIdObj))) {
			return _makeFailResult("LIFECYCLE_KEY_DIGEST_MISMATCH");
		}
	}

	for (let i: number = 1; i < records.length; i++) {
		const prev: object = records[i - 1];
		const curr: object = records[i];

		const prevRev: unknown = Reflect.get(prev, "rev");
		const currRev: unknown = Reflect.get(curr, "rev");
		if (typeof prevRev !== "number" || typeof currRev !== "number" || currRev !== prevRev + 1) {
			return _makeFailResult("NON_MONOTONIC_REVISION");
		}

		if (Reflect.get(curr, "prevDigest") !== Reflect.get(prev, "contentDigest")) {
			return _makeFailResult("PREV_DIGEST_MISMATCH");
		}

		if (Reflect.get(curr, "contentDigest") !== _deriveContentDigest(curr)) {
			return _makeFailResult("CONTENT_DIGEST_MISMATCH");
		}

		const prevStatus: unknown = Reflect.get(prev, "status");
		const currStatus: unknown = Reflect.get(curr, "status");
		if (
			typeof prevStatus !== "string" ||
			typeof currStatus !== "string" ||
			!_isValidTransition(prevStatus, currStatus)
		) {
			return _makeFailResult("INVALID_TRANSITION");
		}

		const currTS: unknown = Reflect.get(curr, "terminalStatus");
		const prevTS: unknown = Reflect.get(prev, "terminalStatus");

		// TERMINAL_BEFORE_COMPLETED
		if (
			currTS !== null &&
			prevTS === null &&
			typeof currStatus === "string" &&
			!_TERMINAL_LIFECYCLE_STATUS_SET.has(currStatus) &&
			!_POST_TERMINAL_STATUS_SET.has(currStatus)
		) {
			return _makeFailResult("TERMINAL_BEFORE_COMPLETED");
		}

		// MISSING_TERMINAL_PAIR_ON_TERMINAL
		if (typeof currStatus === "string" && _TERMINAL_LIFECYCLE_STATUS_SET.has(currStatus) && currTS === null) {
			return _makeFailResult("MISSING_TERMINAL_PAIR_ON_TERMINAL");
		}

		// TERMINAL_PAIR_CHANGED
		const currTC: unknown = Reflect.get(curr, "terminalCode");
		const prevTC: unknown = Reflect.get(prev, "terminalCode");
		if (prevTS !== null && (currTS !== prevTS || currTC !== prevTC)) {
			return _makeFailResult("TERMINAL_PAIR_CHANGED");
		}

		// NULL_TERMINAL_STATUS_WITH_CODE
		if (currTS === null && currTC !== null) return _makeFailResult("NULL_TERMINAL_STATUS_WITH_CODE");

		// TERMINAL_STATUS_CONTRADICTION
		if (
			typeof currStatus === "string" &&
			_TERMINAL_LIFECYCLE_STATUS_SET.has(currStatus) &&
			currTS !== null &&
			currTS !== currStatus
		) {
			return _makeFailResult("TERMINAL_STATUS_CONTRADICTION");
		}

		// Identity checks
		const cIdObj: unknown = Reflect.get(curr, "identity");
		const pIdObj: unknown = Reflect.get(prev, "identity");
		if (typeof cIdObj === "object" && cIdObj !== null && typeof pIdObj === "object" && pIdObj !== null) {
			for (const fld of ["sessionId", "activeSessionId", "childId"]) {
				if (Reflect.get(cIdObj, fld) !== Reflect.get(pIdObj, fld)) {
					return _makeFailResult("LIFECYCLE_ANCHOR_CHANGED");
				}
			}

			for (const fld of _LIFECYCLE_KEY_FIELDS) {
				if (Reflect.get(cIdObj, fld) !== Reflect.get(pIdObj, fld)) {
					return _makeFailResult("IDENTITY_FIELD_CHANGED");
				}
			}

			if (Reflect.get(cIdObj, "lifecycleKeyDigest") !== _deriveLifecycleKeyDigest(_buildIdentityRec(cIdObj))) {
				return _makeFailResult("LIFECYCLE_KEY_DIGEST_MISMATCH");
			}
		}
	}

	return _makeOkResult();
}

// =========================================================================
// 18. Build LedgerRecord
// =========================================================================

function _str2(v: unknown): string {
	if (typeof v === "string") return v;
	return "";
}

function _strOrNull2(v: unknown): string | null {
	if (v === null) return null;
	if (typeof v === "string") return v;
	return null;
}

function _num2(v: unknown): number {
	if (typeof v === "number") return v;
	return 0;
}

function _narrowThinkingLevel(v: unknown): ThinkingLevel {
	if (v === "off") return "off";
	if (v === "minimal") return "minimal";
	if (v === "low") return "low";
	if (v === "medium") return "medium";
	if (v === "high") return "high";
	if (v === "xhigh") return "xhigh";
	return "max";
}

function _narrowServiceTier(v: unknown): ServiceTier | null {
	if (v === null) return null;
	if (v === "auto") return "auto";
	if (v === "default") return "default";
	if (v === "flex") return "flex";
	if (v === "scale") return "scale";
	if (v === "priority") return "priority";
	return null;
}

function _narrowLifecycleStatus(v: unknown): LifecycleStatus {
	if (v === "reserved") return "reserved";
	if (v === "allocating") return "allocating";
	if (v === "allocated") return "allocated";
	if (v === "starting") return "starting";
	if (v === "running") return "running";
	if (v === "completed") return "completed";
	if (v === "error") return "error";
	if (v === "cancelled") return "cancelled";
	if (v === "deleting") return "deleting";
	if (v === "cleanup-uncertain") return "cleanup-uncertain";
	return "deleted";
}

function _narrowTerminalStatus(v: unknown): TerminalStatus {
	if (v === "completed") return "completed";
	if (v === "error") return "error";
	if (v === "cancelled") return "cancelled";
	return null;
}

function _narrowTerminalCode(v: unknown): TerminalCode {
	if (v === null) return null;
	if (v === "SUCCESS") return "SUCCESS";
	if (v === "FAILURE") return "FAILURE";
	if (v === "TIMEOUT") return "TIMEOUT";
	if (v === "EVICTED") return "EVICTED";
	if (v === "USER_STOP") return "USER_STOP";
	if (v === "PARENT_STOP") return "PARENT_STOP";
	if (v === "REVOKED") return "REVOKED";
	if (v === "MAX_DEPTH") return "MAX_DEPTH";
	if (v === "INTERNAL") return "INTERNAL";
	return "UNKNOWN";
}

function _buildLedgerRecord(recordObj: object, identityObj: unknown): LedgerRecord {
	const idObj: object = typeof identityObj === "object" && identityObj !== null ? identityObj : Object.create(null);
	const identity: LedgerIdentity = Object.freeze({
		schema: "hosted-child-ledger-v1",
		lifecycleKeyDigest: _str2(Reflect.get(idObj, "lifecycleKeyDigest")),
		sessionId: _str2(Reflect.get(idObj, "sessionId")),
		activeSessionId: _str2(Reflect.get(idObj, "activeSessionId")),
		childId: _str2(Reflect.get(idObj, "childId")),
		name: _str2(Reflect.get(idObj, "name")),
		modelSelector: _str2(Reflect.get(idObj, "modelSelector")),
		durableParentSessionId: _str2(Reflect.get(idObj, "durableParentSessionId")),
		rlmParentNodeId: _str2(Reflect.get(idObj, "rlmParentNodeId")),
		spawnedByRequestId: _strOrNull2(Reflect.get(idObj, "spawnedByRequestId")),
		thinkingLevel: _narrowThinkingLevel(Reflect.get(idObj, "thinkingLevel")),
		serviceTier: _narrowServiceTier(Reflect.get(idObj, "serviceTier")),
		spawnContextDigest: _str2(Reflect.get(idObj, "spawnContextDigest")),
		depth: _num2(Reflect.get(idObj, "depth")),
	});
	const record: LedgerRecord = Object.freeze({
		schema: "hosted-child-ledger-v1",
		identity,
		rev: _num2(Reflect.get(recordObj, "rev")),
		status: _narrowLifecycleStatus(Reflect.get(recordObj, "status")),
		terminalStatus: _narrowTerminalStatus(Reflect.get(recordObj, "terminalStatus")),
		terminalCode: _narrowTerminalCode(Reflect.get(recordObj, "terminalCode")),
		contentDigest: _str2(Reflect.get(recordObj, "contentDigest")),
		prevDigest: _strOrNull2(Reflect.get(recordObj, "prevDigest")),
	});
	return record;
}

// =========================================================================
// 19. Decode and validate bytes to parsed object (shared helper)
// =========================================================================

function _decodeJSONString(raw: string): string | null {
	// Decode a JSON string value (without surrounding quotes) to its Unicode form.
	// Handles \uXXXX, \", \\, \/, \b, \f, \n, \r, \t escapes.
	// Returns null on invalid escape (caller treats overall JSON as DECODE_FAILURE).
	// Validates exactly four hex nibbles per \u, all standard escapes, surrogate code units.
	let result: string = "";
	let i: number = 0;
	while (i < raw.length) {
		if (raw.charCodeAt(i) === 0x5c && i + 1 < raw.length) {
			const next: string = raw[i + 1];
			if (next === '"') {
				result += '"';
				i += 2;
			} else if (next === "\\") {
				result += "\\";
				i += 2;
			} else if (next === "/") {
				result += "/";
				i += 2;
			} else if (next === "b") {
				result += "\b";
				i += 2;
			} else if (next === "f") {
				result += "\f";
				i += 2;
			} else if (next === "n") {
				result += "\n";
				i += 2;
			} else if (next === "r") {
				result += "\r";
				i += 2;
			} else if (next === "t") {
				result += "\t";
				i += 2;
			} else if (next === "u") {
				// Validate exactly four hex nibbles after \u
				if (i + 5 >= raw.length) return null;
				const hex: string = raw.substring(i + 2, i + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
				const codePoint: number = parseInt(hex, 16);
				if (Number.isNaN(codePoint) || codePoint < 0) return null;
				result += String.fromCodePoint(codePoint);
				i += 6;
			} else {
				// Any unrecognized escape after backslash is invalid in JSON
				return null;
			}
		} else {
			result += raw[i];
			i += 1;
		}
	}
	return result;
}

function _hasDuplicateKeys(text: string): boolean {
	// Bounded nonrecursive duplicate JSON object-key detection with
	// proper escape-aware key comparison and explicit state machine.
	// Tracks both object and array contexts iteratively up to MAX_DEPTH.
	// Inside arrays, skips key detection; nested objects within arrays ARE checked.
	// Returns true if a duplicate key is found (caller treats as DECODE_FAILURE).
	const MAX_DEPTH: number = 64;
	const INIT: number = 0;
	const KEY_END: number = 1;
	const VALUE_START: number = 2;
	const VALUE_END: number = 3;
	const COMMA_OR_END: number = 4;

	let depth: number = 0;
	const states: number[] = [INIT];
	const keySets: Array<Set<string> | null> = [null];
	const isArray: boolean[] = [false];
	let inString: boolean = false;
	let escapeChar: boolean = false;
	let readingKey: boolean = false;
	let keyBuffer: string = "";
	const len: number = text.length;
	let i: number = 0;

	while (i < len) {
		const ch: number = text.charCodeAt(i);

		if (inString) {
			if (escapeChar) {
				escapeChar = false;
				if (readingKey) keyBuffer += text[i];
				i += 1;
				continue;
			}
			if (ch === 0x5c) {
				escapeChar = true;
				if (readingKey) keyBuffer += text[i];
				i += 1;
				continue;
			}
			if (ch === 0x22) {
				if (readingKey) {
					const decodedKey: string | null = _decodeJSONString(keyBuffer);
					// Invalid escape in key -> treat JSON as undecodable
					if (decodedKey === null) return true;
					const ks: Set<string> | null = keySets[depth];
					if (ks !== null && ks.has(decodedKey)) {
						return true;
					}
					if (ks !== null) ks.add(decodedKey);
					readingKey = false;
					keyBuffer = "";
					states[depth] = KEY_END;
				} else {
					states[depth] = VALUE_END;
				}
				inString = false;
				i += 1;
				continue;
			}
			if (readingKey) keyBuffer += text[i];
			i += 1;
			continue;
		}

		if (ch === 0x22) {
			inString = true;
			escapeChar = false;
			const st: number = states[depth];
			// Only read as a key when not in an array context
			readingKey = !isArray[depth] && (st === INIT || st === COMMA_OR_END);
			keyBuffer = "";
			i += 1;
			continue;
		}

		if (ch === 0x7b) {
			if (depth >= MAX_DEPTH) return true;
			depth += 1;
			while (depth >= states.length) {
				states.push(INIT);
				keySets.push(null);
				isArray.push(false);
			}
			states[depth] = INIT;
			keySets[depth] = new Set<string>();
			isArray[depth] = false;
			i += 1;
			continue;
		}

		if (ch === 0x7d) {
			if (depth > 0) {
				keySets[depth] = null;
				depth -= 1;
				if (depth >= 0) states[depth] = VALUE_END;
			}
			i += 1;
			continue;
		}

		if (ch === 0x5b) {
			if (depth >= MAX_DEPTH) return true;
			depth += 1;
			while (depth >= states.length) {
				states.push(INIT);
				keySets.push(null);
				isArray.push(false);
			}
			states[depth] = INIT;
			keySets[depth] = null;
			isArray[depth] = true;
			i += 1;
			continue;
		}

		if (ch === 0x5d) {
			if (depth > 0) {
				keySets[depth] = null;
				depth -= 1;
				if (depth >= 0) states[depth] = VALUE_END;
			}
			i += 1;
			continue;
		}

		if (ch === 0x3a) {
			const st: number = states[depth];
			if (st === KEY_END) states[depth] = VALUE_START;
			i += 1;
			continue;
		}

		if (ch === 0x2c) {
			const st: number = states[depth];
			if (st === VALUE_END) states[depth] = COMMA_OR_END;
			i += 1;
			continue;
		}

		if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
			i += 1;
			continue;
		}

		const st: number = states[depth];
		if (st === VALUE_START) states[depth] = VALUE_END;
		i += 1;
	}

	return false;
}

// =========================================================================
// 19. Decode and validate bytes to parsed object (shared helper)
// =========================================================================

function _decodeAndValidateBytes(bytes: Uint8Array): object | string {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (_e) {
		return "DECODE_FAILURE";
	}

	if (text.length === 0 || text.charCodeAt(text.length - 1) !== 0x0a) {
		return "CANONICAL_BYTES_MISMATCH";
	}
	text = text.slice(0, -1);

	if (_hasDuplicateKeys(text)) {
		return "DECODE_FAILURE";
	}

	let parsed: object;
	try {
		const parsedUnknown: unknown = JSON.parse(text);
		if (typeof parsedUnknown !== "object" || parsedUnknown === null || Array.isArray(parsedUnknown)) {
			return "DECODE_FAILURE";
		}
		parsed = parsedUnknown;
	} catch (_e) {
		return "DECODE_FAILURE";
	}

	const fieldErr: string | undefined = _validateRecordFields(parsed);
	if (fieldErr !== undefined) return fieldErr;

	if (Reflect.get(parsed, "contentDigest") !== _deriveContentDigest(parsed)) {
		return "CANONICAL_BYTES_MISMATCH";
	}

	const canonical: Uint8Array = _canonicalRecordBytes(parsed);
	if (canonical.byteLength !== bytes.byteLength) return "CANONICAL_BYTES_MISMATCH";
	for (let i: number = 0; i < canonical.byteLength; i++) {
		if (canonical[i] !== bytes[i]) return "CANONICAL_BYTES_MISMATCH";
	}

	return parsed;
}

// Error string to LedgerErrorCode helper (no cast)
function _toLedgerError(s: string): LedgerErrorCode {
	if (s === "HOSTILE_INPUT") return "HOSTILE_INPUT";
	if (s === "BRAND_CHECK_FAILURE") return "BRAND_CHECK_FAILURE";
	if (s === "DECODE_FAILURE") return "DECODE_FAILURE";
	if (s === "CANONICAL_BYTES_MISMATCH") return "CANONICAL_BYTES_MISMATCH";
	if (s === "FIELD_TYPE_MISMATCH") return "FIELD_TYPE_MISMATCH";
	if (s === "FIELD_TOO_LARGE") return "FIELD_TOO_LARGE";
	if (s === "FIELD_UNKNOWN_KEY") return "FIELD_UNKNOWN_KEY";
	if (s === "FIELD_NON_PRINTABLE") return "FIELD_NON_PRINTABLE";
	if (s === "FIELD_STATUS_INVALID") return "FIELD_STATUS_INVALID";
	if (s === "FIELD_TERMINAL_STATUS_INVALID") return "FIELD_TERMINAL_STATUS_INVALID";
	if (s === "FIELD_TERMINAL_CODE_INVALID") return "FIELD_TERMINAL_CODE_INVALID";
	if (s === "FIELD_THINKING_LEVEL_INVALID") return "FIELD_THINKING_LEVEL_INVALID";
	if (s === "FIELD_SERVICE_TIER_INVALID") return "FIELD_SERVICE_TIER_INVALID";
	return "DECODE_FAILURE";
}

// =========================================================================
// 20. Mint record bytes (private storage ingress)
// =========================================================================

function _mintRecordBytes(raw: unknown): MintResult {
	const u8: Uint8Array | string = _validateUint8Array(raw);
	if (typeof u8 === "string") {
		let error: LedgerErrorCode = "HOSTILE_INPUT";
		if (u8 === "BOUND_RECORD_BYTES_EXCEEDED") error = "BOUND_RECORD_BYTES_EXCEEDED";
		const fail: MintFailure = { code: "FAIL", error };
		return Object.freeze(fail);
	}

	const parsedOrErr: object | string = _decodeAndValidateBytes(u8);
	if (typeof parsedOrErr === "string") {
		let error: LedgerErrorCode = "DECODE_FAILURE";
		if (parsedOrErr === "CANONICAL_BYTES_MISMATCH") error = "CANONICAL_BYTES_MISMATCH";
		else if (parsedOrErr === "FIELD_TYPE_MISMATCH") error = "FIELD_TYPE_MISMATCH";
		else if (parsedOrErr === "FIELD_TOO_LARGE") error = "FIELD_TOO_LARGE";
		else if (parsedOrErr === "FIELD_NON_PRINTABLE") error = "FIELD_NON_PRINTABLE";
		else if (parsedOrErr === "FIELD_STATUS_INVALID") error = "FIELD_STATUS_INVALID";
		else if (parsedOrErr === "FIELD_TERMINAL_STATUS_INVALID") error = "FIELD_TERMINAL_STATUS_INVALID";
		else if (parsedOrErr === "FIELD_TERMINAL_CODE_INVALID") error = "FIELD_TERMINAL_CODE_INVALID";
		else if (parsedOrErr === "FIELD_THINKING_LEVEL_INVALID") error = "FIELD_THINKING_LEVEL_INVALID";
		else if (parsedOrErr === "FIELD_SERVICE_TIER_INVALID") error = "FIELD_SERVICE_TIER_INVALID";
		const fail: MintFailure = { code: "FAIL", error };
		return Object.freeze(fail);
	}
	const parsed: object = parsedOrErr;

	if (_issueLedgerRecordBytesSequence === undefined) {
		const fail: MintFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}

	const record: LedgerRecord = _buildLedgerRecord(parsed, Reflect.get(parsed, "identity"));
	const instance: LedgerRecordBytes = _issueLedgerRecordBytesSequence();
	const ownedBuffer: ArrayBuffer = new ArrayBuffer(u8.byteLength);
	const dst: Uint8Array = new Uint8Array(ownedBuffer);
	dst.set(u8, 0);
	_bufferMap.set(instance, ownedBuffer);

	const success: MintSuccess = { code: "OK", bytes: instance, record };
	return Object.freeze(success);
}

// =========================================================================
// 21a. Decode bytes from view (helper using descriptor iteration)
// =========================================================================

function _decodeBytesFromView(srcView: object): object | string {
	// Get byteLength from captured TypedArray getter
	if (_u8BLDesc === undefined) return "DECODE_FAILURE";
	const blGetFn: unknown = _u8BLDesc.get;
	if (typeof blGetFn !== "function") return "DECODE_FAILURE";
	let blUnknown: unknown;
	try {
		blUnknown = _reflectApply(blGetFn, srcView, []);
	} catch (_e) {
		return "DECODE_FAILURE";
	}
	if (typeof blUnknown !== "number" || !Number.isFinite(blUnknown)) return "DECODE_FAILURE";
	const byteLength: number = blUnknown;

	// Copy bytes to fresh Uint8Array
	const freshBuf: ArrayBuffer = new ArrayBuffer(byteLength);
	const dst: Uint8Array = new Uint8Array(freshBuf);
	for (let i: number = 0; i < byteLength; i++) {
		const idx: string = String(i);
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(srcView, idx);
		if (desc === undefined) continue;
		const byteVal: unknown = desc.value;
		if (typeof byteVal !== "number") continue;
		dst[i] = byteVal;
	}

	return _decodeAndValidateBytes(dst);
}

// =========================================================================
// 21. Decode record (public)
// =========================================================================

function _decodeRecord(raw: unknown): DecodeResult {
	const brandResult: BrandResult = _brandCheck(raw);
	if (!brandResult.ok) {
		const fail: DecodeFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}

	const ownedBuffer: unknown = brandResult.buffer;
	const src: object = _reflectConstruct(Uint8Array, [ownedBuffer]);
	const parsedOrErr: object | string = _decodeBytesFromView(src);
	if (typeof parsedOrErr === "string") {
		let error: LedgerErrorCode = "DECODE_FAILURE";
		if (parsedOrErr === "CANONICAL_BYTES_MISMATCH") error = "CANONICAL_BYTES_MISMATCH";
		else if (parsedOrErr === "FIELD_TYPE_MISMATCH") error = "FIELD_TYPE_MISMATCH";
		else if (parsedOrErr === "FIELD_TOO_LARGE") error = "FIELD_TOO_LARGE";
		else if (parsedOrErr === "FIELD_NON_PRINTABLE") error = "FIELD_NON_PRINTABLE";
		else if (parsedOrErr === "FIELD_STATUS_INVALID") error = "FIELD_STATUS_INVALID";
		else if (parsedOrErr === "FIELD_TERMINAL_STATUS_INVALID") error = "FIELD_TERMINAL_STATUS_INVALID";
		else if (parsedOrErr === "FIELD_TERMINAL_CODE_INVALID") error = "FIELD_TERMINAL_CODE_INVALID";
		else if (parsedOrErr === "FIELD_THINKING_LEVEL_INVALID") error = "FIELD_THINKING_LEVEL_INVALID";
		else if (parsedOrErr === "FIELD_SERVICE_TIER_INVALID") error = "FIELD_SERVICE_TIER_INVALID";
		const fail: DecodeFailure = { code: "FAIL", error };
		return Object.freeze(fail);
	}
	const parsed: object = parsedOrErr;

	const record: LedgerRecord = _buildLedgerRecord(parsed, Reflect.get(parsed, "identity"));
	const success: DecodeSuccess = { code: "OK", record };
	return Object.freeze(success);
}

// =========================================================================
// 22. Decode journal (public)
// =========================================================================

function _decodeJournal(raw: unknown): DecodeJournalResult {
	const arrOrErr: unknown[] | string = _validateDenseArray(raw);
	if (typeof arrOrErr === "string") {
		const fail: DecodeJournalFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const arr: unknown[] = arrOrErr;

	const records: LedgerRecord[] = [];
	for (const item of arr) {
		const result: DecodeResult = _decodeRecord(item);
		if (result.code === "FAIL") {
			const fail: DecodeJournalFailure = { code: "FAIL", error: result.error };
			return Object.freeze(fail);
		}
		records.push(result.record);
	}

	const chainResult: ValidateChainResult = _validateChain(records);
	if (chainResult.code === "FAIL") {
		const fail: DecodeJournalFailure = { code: "FAIL", error: chainResult.errors[0] };
		return Object.freeze(fail);
	}

	const frozenRecords: readonly LedgerRecord[] = Object.freeze(records);
	const success: DecodeJournalSuccess = { code: "OK", records: frozenRecords };
	return Object.freeze(success);
}

// =========================================================================
// 23. Append genesis
// =========================================================================

function _appendGenesis(rawChain: unknown, rawGenesis: unknown, _rawBounds: unknown): AppendResult {
	const chainArrOrErr: unknown[] | string = _validateDenseArray(rawChain);
	if (typeof chainArrOrErr === "string") {
		const fail: AppendFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const chainArr: unknown[] = chainArrOrErr;
	if (chainArr.length !== 0) {
		const fail: AppendFailure = { code: "FAIL", error: "EMPTY_CHAIN" };
		return Object.freeze(fail);
	}

	const genesisOrErr: object | string = _validatePlainObjectExpected(rawGenesis, _EXPECTED_GENESIS_FIELDS);
	if (typeof genesisOrErr === "string") {
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(genesisOrErr) };
		return Object.freeze(fail);
	}
	const genesis: object = genesisOrErr;

	// Validate identity fields
	const errTL: string | undefined = _checkStr(Reflect.get(genesis, "thinkingLevel"), 16, false, false);
	if (errTL !== undefined) {
		if (errTL === "FIELD_TYPE_MISMATCH") {
			const fail: AppendFailure = { code: "FAIL", error: "FIELD_THINKING_LEVEL_INVALID" };
			return Object.freeze(fail);
		}
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(errTL) };
		return Object.freeze(fail);
	}
	const tlVal: unknown = Reflect.get(genesis, "thinkingLevel");
	if (typeof tlVal !== "string" || !_THINKING_LEVEL_SET.has(tlVal)) {
		const fail: AppendFailure = { code: "FAIL", error: "FIELD_THINKING_LEVEL_INVALID" };
		return Object.freeze(fail);
	}

	const stVal: unknown = Reflect.get(genesis, "serviceTier");
	if (stVal !== null) {
		if (typeof stVal !== "string" || !_SERVICE_TIER_SET.has(stVal)) {
			const fail: AppendFailure = { code: "FAIL", error: "FIELD_SERVICE_TIER_INVALID" };
			return Object.freeze(fail);
		}
	}

	for (const fld of ["sessionId", "activeSessionId", "childId"]) {
		const e: string | undefined = _checkStr(Reflect.get(genesis, fld), 1024, true, false);
		if (e !== undefined) {
			const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(e) };
			return Object.freeze(fail);
		}
	}

	const eName: string | undefined = _checkStr(Reflect.get(genesis, "name"), 2048, false, true);
	if (eName !== undefined) {
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(eName) };
		return Object.freeze(fail);
	}

	const eModel: string | undefined = _checkStr(Reflect.get(genesis, "modelSelector"), 4096, false, true);
	if (eModel !== undefined) {
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(eModel) };
		return Object.freeze(fail);
	}

	for (const fld of ["durableParentSessionId", "rlmParentNodeId"]) {
		const e: string | undefined = _checkStr(Reflect.get(genesis, fld), 1024, true, false);
		if (e !== undefined) {
			const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(e) };
			return Object.freeze(fail);
		}
	}

	const sbr: unknown = Reflect.get(genesis, "spawnedByRequestId");
	if (sbr !== null) {
		const e: string | undefined = _checkStr(sbr, 1024, true, false);
		if (e !== undefined) {
			const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(e) };
			return Object.freeze(fail);
		}
	}

	const eSpwn: string | undefined = _checkHex64(Reflect.get(genesis, "spawnContextDigest"));
	if (eSpwn !== undefined) {
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(eSpwn) };
		return Object.freeze(fail);
	}

	const depthVal: unknown = Reflect.get(genesis, "depth");
	if (typeof depthVal !== "number" || !Number.isSafeInteger(depthVal) || depthVal < 0) {
		const fail: AppendFailure = { code: "FAIL", error: "FIELD_TYPE_MISMATCH" };
		return Object.freeze(fail);
	}

	// Derive lifecycleKeyDigest
	const identityRec: Record<string, unknown> = {};
	for (const fld of _LIFECYCLE_KEY_FIELDS) {
		identityRec[fld] = Reflect.get(genesis, fld);
	}
	const lifecycleKeyDigest: string = _deriveLifecycleKeyDigest(identityRec);

	// Build identity
	const identity: LedgerIdentity = Object.freeze({
		schema: "hosted-child-ledger-v1",
		lifecycleKeyDigest,
		sessionId: _str2(Reflect.get(genesis, "sessionId")),
		activeSessionId: _str2(Reflect.get(genesis, "activeSessionId")),
		childId: _str2(Reflect.get(genesis, "childId")),
		name: _str2(Reflect.get(genesis, "name")),
		modelSelector: _str2(Reflect.get(genesis, "modelSelector")),
		durableParentSessionId: _str2(Reflect.get(genesis, "durableParentSessionId")),
		rlmParentNodeId: _str2(Reflect.get(genesis, "rlmParentNodeId")),
		spawnedByRequestId: _strOrNull2(Reflect.get(genesis, "spawnedByRequestId")),
		thinkingLevel: _narrowThinkingLevel(tlVal),
		serviceTier: _narrowServiceTier(stVal),
		spawnContextDigest: _str2(Reflect.get(genesis, "spawnContextDigest")),
		depth: _num2(depthVal),
	});

	// Build record object for serialization
	const recordObj: Record<string, unknown> = {
		schema: "hosted-child-ledger-v1",
		identity: identity,
		rev: 0,
		status: "reserved",
		terminalStatus: null,
		terminalCode: null,
		contentDigest: _C64ZEROS,
		prevDigest: null,
	};
	recordObj.contentDigest = _deriveContentDigest(recordObj);

	const canonical: Uint8Array = _canonicalRecordBytes(recordObj);

	if (_issueLedgerRecordBytesSequence === undefined) {
		const fail: AppendFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const instance: LedgerRecordBytes = _issueLedgerRecordBytesSequence();
	const ownedBuffer: ArrayBuffer = new ArrayBuffer(canonical.byteLength);
	const dst: Uint8Array = new Uint8Array(ownedBuffer);
	dst.set(canonical, 0);
	_bufferMap.set(instance, ownedBuffer);

	const record: LedgerRecord = _buildLedgerRecord(recordObj, identity);

	// Validate chain
	const chainResult: ValidateChainResult = _validateChain([recordObj]);
	if (chainResult.code === "FAIL") {
		const fail: AppendFailure = { code: "FAIL", error: chainResult.errors[0] };
		return Object.freeze(fail);
	}

	const success: AppendSuccess = { code: "OK", record, bytes: instance };
	return Object.freeze(success);
}

// =========================================================================
// 24. Append transition
// =========================================================================

function _appendTransition(rawChain: unknown, rawTransition: unknown, _rawBounds: unknown): AppendResult {
	const chainArrOrErr: unknown[] | string = _validateDenseArray(rawChain);
	if (typeof chainArrOrErr === "string") {
		const fail: AppendFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const chainArr: unknown[] = chainArrOrErr;
	if (chainArr.length === 0) {
		const fail: AppendFailure = { code: "FAIL", error: "EMPTY_CHAIN" };
		return Object.freeze(fail);
	}

	// Decode each existing wrapper to LedgerRecord
	const existingRecords: object[] = [];
	for (const item of chainArr) {
		const result: DecodeResult = _decodeRecord(item);
		if (result.code === "FAIL") {
			const fail: AppendFailure = { code: "FAIL", error: result.error };
			return Object.freeze(fail);
		}
		existingRecords.push(result.record);
	}

	const transitionOrErr: object | string = _validatePlainObjectExpected(rawTransition, _EXPECTED_TRANSITION_FIELDS);
	if (typeof transitionOrErr === "string") {
		const fail: AppendFailure = { code: "FAIL", error: _toLedgerError(transitionOrErr) };
		return Object.freeze(fail);
	}
	const transition: object = transitionOrErr;

	// Validate transition fields
	const statusVal: unknown = Reflect.get(transition, "status");
	if (typeof statusVal !== "string" || !_LIFECYCLE_STATUS_SET.has(statusVal)) {
		const fail: AppendFailure = { code: "FAIL", error: "FIELD_STATUS_INVALID" };
		return Object.freeze(fail);
	}

	const tsVal: unknown = Reflect.get(transition, "terminalStatus");
	if (tsVal !== null) {
		if (typeof tsVal !== "string" || !_TERMINAL_STATUS_SET.has(tsVal)) {
			const fail: AppendFailure = { code: "FAIL", error: "FIELD_TERMINAL_STATUS_INVALID" };
			return Object.freeze(fail);
		}
	}

	const tcVal: unknown = Reflect.get(transition, "terminalCode");
	if (tcVal !== null) {
		if (typeof tcVal !== "string" || !_TERMINAL_CODE_SET.has(tcVal)) {
			const fail: AppendFailure = { code: "FAIL", error: "FIELD_TERMINAL_CODE_INVALID" };
			return Object.freeze(fail);
		}
	}

	// Clone identity from last record
	const lastRecord: object = existingRecords[existingRecords.length - 1];
	const lastIdObj: unknown = Reflect.get(lastRecord, "identity");
	const identityRec: Record<string, unknown> = {};
	if (typeof lastIdObj === "object" && lastIdObj !== null) {
		for (const f of _LIFECYCLE_KEY_FIELDS) {
			identityRec[f] = Reflect.get(lastIdObj, f);
		}
	}
	const lifecycleKeyDigest: string = _deriveLifecycleKeyDigest(identityRec);

	const lastRevVal: unknown = Reflect.get(lastRecord, "rev");
	const lastRev: number = typeof lastRevVal === "number" ? lastRevVal : 0;
	const lastCD: unknown = Reflect.get(lastRecord, "contentDigest");
	const prevDigest: string | null = typeof lastCD === "string" ? lastCD : null;

	// Build identity
	const identity: LedgerIdentity = Object.freeze({
		schema: "hosted-child-ledger-v1",
		lifecycleKeyDigest,
		sessionId: _str2(identityRec.sessionId),
		activeSessionId: _str2(identityRec.activeSessionId),
		childId: _str2(identityRec.childId),
		name: _str2(identityRec.name),
		modelSelector: _str2(identityRec.modelSelector),
		durableParentSessionId: _str2(identityRec.durableParentSessionId),
		rlmParentNodeId: _str2(identityRec.rlmParentNodeId),
		spawnedByRequestId: _strOrNull2(identityRec.spawnedByRequestId),
		thinkingLevel: _narrowThinkingLevel(identityRec.thinkingLevel),
		serviceTier: _narrowServiceTier(identityRec.serviceTier),
		spawnContextDigest: _str2(identityRec.spawnContextDigest),
		depth: _num2(identityRec.depth),
	});

	// Build record
	const newRev: number = lastRev + 1;
	const recordObj: Record<string, unknown> = {
		schema: "hosted-child-ledger-v1",
		identity: identity,
		rev: newRev,
		status: statusVal,
		terminalStatus: tsVal,
		terminalCode: tcVal,
		contentDigest: _C64ZEROS,
		prevDigest,
	};
	recordObj.contentDigest = _deriveContentDigest(recordObj);

	const canonical: Uint8Array = _canonicalRecordBytes(recordObj);

	if (_issueLedgerRecordBytesSequence === undefined) {
		const fail: AppendFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const instance: LedgerRecordBytes = _issueLedgerRecordBytesSequence();
	const ownedBuffer: ArrayBuffer = new ArrayBuffer(canonical.byteLength);
	const dst: Uint8Array = new Uint8Array(ownedBuffer);
	dst.set(canonical, 0);
	_bufferMap.set(instance, ownedBuffer);

	const record: LedgerRecord = _buildLedgerRecord(recordObj, identity);

	// Validate chain with all records
	const allRecords: object[] = existingRecords.concat([recordObj]);
	const chainResult: ValidateChainResult = _validateChain(allRecords);
	if (chainResult.code === "FAIL") {
		const fail: AppendFailure = { code: "FAIL", error: chainResult.errors[0] };
		return Object.freeze(fail);
	}

	const success: AppendSuccess = { code: "OK", record, bytes: instance };
	return Object.freeze(success);
}

// =========================================================================
// 25. Encode genesis bytes (safe path)
// =========================================================================

function _encodeGenesisBytes(rawGenesis: unknown, rawBounds: unknown): EncodeResult {
	const boundsOrErr: Record<string, number> | string = _validateBounds(rawBounds);
	if (typeof boundsOrErr === "string") {
		const fail: EncodeFailure = { code: "FAIL", error: _toLedgerError(boundsOrErr) };
		return Object.freeze(fail);
	}

	const genesisOrErr: object | string = _validatePlainObjectExpected(rawGenesis, _EXPECTED_GENESIS_FIELDS);
	if (typeof genesisOrErr === "string") {
		const fail: EncodeFailure = { code: "FAIL", error: _toLedgerError(genesisOrErr) };
		return Object.freeze(fail);
	}

	// Build genesis record (same logic as appendGenesis but without chain)
	const tlVal: unknown = Reflect.get(genesisOrErr, "thinkingLevel");
	if (typeof tlVal !== "string" || !_THINKING_LEVEL_SET.has(tlVal)) {
		const fail: EncodeFailure = { code: "FAIL", error: "FIELD_THINKING_LEVEL_INVALID" };
		return Object.freeze(fail);
	}
	const stVal: unknown = Reflect.get(genesisOrErr, "serviceTier");
	if (stVal !== null) {
		if (typeof stVal !== "string" || !_SERVICE_TIER_SET.has(stVal)) {
			const fail: EncodeFailure = { code: "FAIL", error: "FIELD_SERVICE_TIER_INVALID" };
			return Object.freeze(fail);
		}
	}

	const identityRec: Record<string, unknown> = {};
	for (const fld of _LIFECYCLE_KEY_FIELDS) {
		identityRec[fld] = Reflect.get(genesisOrErr, fld);
	}
	const lifecycleKeyDigest: string = _deriveLifecycleKeyDigest(identityRec);

	const identity: LedgerIdentity = Object.freeze({
		schema: "hosted-child-ledger-v1",
		lifecycleKeyDigest,
		sessionId: _str2(Reflect.get(genesisOrErr, "sessionId")),
		activeSessionId: _str2(Reflect.get(genesisOrErr, "activeSessionId")),
		childId: _str2(Reflect.get(genesisOrErr, "childId")),
		name: _str2(Reflect.get(genesisOrErr, "name")),
		modelSelector: _str2(Reflect.get(genesisOrErr, "modelSelector")),
		durableParentSessionId: _str2(Reflect.get(genesisOrErr, "durableParentSessionId")),
		rlmParentNodeId: _str2(Reflect.get(genesisOrErr, "rlmParentNodeId")),
		spawnedByRequestId: _strOrNull2(Reflect.get(genesisOrErr, "spawnedByRequestId")),
		thinkingLevel: _narrowThinkingLevel(tlVal),
		serviceTier: _narrowServiceTier(stVal),
		spawnContextDigest: _str2(Reflect.get(genesisOrErr, "spawnContextDigest")),
		depth: _num2(Reflect.get(genesisOrErr, "depth")),
	});

	const recordObj: Record<string, unknown> = {
		schema: "hosted-child-ledger-v1",
		identity: identity,
		rev: 0,
		status: "reserved",
		terminalStatus: null,
		terminalCode: null,
		contentDigest: _C64ZEROS,
		prevDigest: null,
	};
	recordObj.contentDigest = _deriveContentDigest(recordObj);

	// Validate chain (single record)
	const chainResult: ValidateChainResult = _validateChain([recordObj]);
	if (chainResult.code === "FAIL") {
		const fail: EncodeFailure = { code: "FAIL", error: chainResult.errors[0] };
		return Object.freeze(fail);
	}

	// Mint
	const canonical: Uint8Array = _canonicalRecordBytes(recordObj);
	if (_issueLedgerRecordBytesSequence === undefined) {
		const fail: EncodeFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const instance: LedgerRecordBytes = _issueLedgerRecordBytesSequence();
	const ownedBuffer: ArrayBuffer = new ArrayBuffer(canonical.byteLength);
	const dst: Uint8Array = new Uint8Array(ownedBuffer);
	dst.set(canonical, 0);
	_bufferMap.set(instance, ownedBuffer);

	const success: EncodeSuccess = { code: "OK", bytes: instance };
	return Object.freeze(success);
}

// =========================================================================
// 26. Encode transition bytes (safe path)
// =========================================================================

function _encodeTransitionBytes(rawChain: unknown, rawTransition: unknown, rawBounds: unknown): EncodeResult {
	const boundsOrErr: Record<string, number> | string = _validateBounds(rawBounds);
	if (typeof boundsOrErr === "string") {
		const fail: EncodeFailure = { code: "FAIL", error: _toLedgerError(boundsOrErr) };
		return Object.freeze(fail);
	}

	const chainArrOrErr: unknown[] | string = _validateDenseArray(rawChain);
	if (typeof chainArrOrErr === "string") {
		const fail: EncodeFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const chainArr: unknown[] = chainArrOrErr;
	if (chainArr.length === 0) {
		const fail: EncodeFailure = { code: "FAIL", error: "EMPTY_CHAIN" };
		return Object.freeze(fail);
	}

	// Decode existing chain
	const existingRecords: object[] = [];
	for (const item of chainArr) {
		const result: DecodeResult = _decodeRecord(item);
		if (result.code === "FAIL") {
			const fail: EncodeFailure = { code: "FAIL", error: result.error };
			return Object.freeze(fail);
		}
		existingRecords.push(result.record);
	}

	// Same as appendTransition but returns only bytes
	const transitionOrErr: object | string = _validatePlainObjectExpected(rawTransition, _EXPECTED_TRANSITION_FIELDS);
	if (typeof transitionOrErr === "string") {
		const fail: EncodeFailure = { code: "FAIL", error: _toLedgerError(transitionOrErr) };
		return Object.freeze(fail);
	}
	const transition: object = transitionOrErr;

	const statusVal: unknown = Reflect.get(transition, "status");
	if (typeof statusVal !== "string" || !_LIFECYCLE_STATUS_SET.has(statusVal)) {
		const fail: EncodeFailure = { code: "FAIL", error: "FIELD_STATUS_INVALID" };
		return Object.freeze(fail);
	}
	const tsVal: unknown = Reflect.get(transition, "terminalStatus");
	if (tsVal !== null) {
		if (typeof tsVal !== "string" || !_TERMINAL_STATUS_SET.has(tsVal)) {
			const fail: EncodeFailure = { code: "FAIL", error: "FIELD_TERMINAL_STATUS_INVALID" };
			return Object.freeze(fail);
		}
	}
	const tcVal: unknown = Reflect.get(transition, "terminalCode");
	if (tcVal !== null) {
		if (typeof tcVal !== "string" || !_TERMINAL_CODE_SET.has(tcVal)) {
			const fail: EncodeFailure = { code: "FAIL", error: "FIELD_TERMINAL_CODE_INVALID" };
			return Object.freeze(fail);
		}
	}

	const lastRecord: object = existingRecords[existingRecords.length - 1];
	const lastIdObj: unknown = Reflect.get(lastRecord, "identity");
	const identityRec: Record<string, unknown> = {};
	if (typeof lastIdObj === "object" && lastIdObj !== null) {
		for (const f of _LIFECYCLE_KEY_FIELDS) {
			identityRec[f] = Reflect.get(lastIdObj, f);
		}
	}
	const lifecycleKeyDigest: string = _deriveLifecycleKeyDigest(identityRec);

	const lastRevVal: unknown = Reflect.get(lastRecord, "rev");
	const lastRev: number = typeof lastRevVal === "number" ? lastRevVal : 0;
	const lastCD: unknown = Reflect.get(lastRecord, "contentDigest");
	const prevDigest: string | null = typeof lastCD === "string" ? lastCD : null;

	const identity: LedgerIdentity = Object.freeze({
		schema: "hosted-child-ledger-v1",
		lifecycleKeyDigest,
		sessionId: _str2(identityRec.sessionId),
		activeSessionId: _str2(identityRec.activeSessionId),
		childId: _str2(identityRec.childId),
		name: _str2(identityRec.name),
		modelSelector: _str2(identityRec.modelSelector),
		durableParentSessionId: _str2(identityRec.durableParentSessionId),
		rlmParentNodeId: _str2(identityRec.rlmParentNodeId),
		spawnedByRequestId: _strOrNull2(identityRec.spawnedByRequestId),
		thinkingLevel: _narrowThinkingLevel(identityRec.thinkingLevel),
		serviceTier: _narrowServiceTier(identityRec.serviceTier),
		spawnContextDigest: _str2(identityRec.spawnContextDigest),
		depth: _num2(identityRec.depth),
	});

	const newRev: number = lastRev + 1;
	const recordObj: Record<string, unknown> = {
		schema: "hosted-child-ledger-v1",
		identity: identity,
		rev: newRev,
		status: statusVal,
		terminalStatus: tsVal,
		terminalCode: tcVal,
		contentDigest: _C64ZEROS,
		prevDigest,
	};
	recordObj.contentDigest = _deriveContentDigest(recordObj);

	const allRecords: object[] = existingRecords.concat([recordObj]);
	const chainResult: ValidateChainResult = _validateChain(allRecords);
	if (chainResult.code === "FAIL") {
		const fail: EncodeFailure = { code: "FAIL", error: chainResult.errors[0] };
		return Object.freeze(fail);
	}

	const canonical: Uint8Array = _canonicalRecordBytes(recordObj);
	if (_issueLedgerRecordBytesSequence === undefined) {
		const fail: EncodeFailure = { code: "FAIL", error: "HOSTILE_INPUT" };
		return Object.freeze(fail);
	}
	const instance: LedgerRecordBytes = _issueLedgerRecordBytesSequence();
	const ownedBuffer: ArrayBuffer = new ArrayBuffer(canonical.byteLength);
	const dst: Uint8Array = new Uint8Array(ownedBuffer);
	dst.set(canonical, 0);
	_bufferMap.set(instance, ownedBuffer);

	const success: EncodeSuccess = { code: "OK", bytes: instance };
	return Object.freeze(success);
}

// =========================================================================
// 27. Inventory
// =========================================================================

function _compareUtf8Bytes(a: string, b: string): number {
	const aBytes: Uint8Array = new TextEncoder().encode(a);
	const bBytes: Uint8Array = new TextEncoder().encode(b);
	if (aBytes.byteLength < bBytes.byteLength) return -1;
	if (aBytes.byteLength > bBytes.byteLength) return 1;
	for (let i: number = 0; i < aBytes.byteLength; i++) {
		if (aBytes[i] < bBytes[i]) return -1;
		if (aBytes[i] > bBytes[i]) return 1;
	}
	return 0;
}

function _compareAnchor(a: LedgerAnchor, b: LedgerAnchor): number {
	let cmp: number = _compareUtf8Bytes(a.childId, b.childId);
	if (cmp !== 0) return cmp;
	cmp = _compareUtf8Bytes(a.sessionId, b.sessionId);
	if (cmp !== 0) return cmp;
	return _compareUtf8Bytes(a.activeSessionId, b.activeSessionId);
}

function _inventory(rawRecords: unknown, rawBounds: unknown): InventoryResult {
	const boundsOrErr: Record<string, number> | string = _validateBounds(rawBounds);
	if (typeof boundsOrErr === "string") {
		const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze([_toLedgerError(boundsOrErr)]) };
		return Object.freeze(fail);
	}
	const bounds: Record<string, number> = boundsOrErr;

	const arrOrErr: unknown[] | string = _validateDenseArray(rawRecords);
	if (typeof arrOrErr === "string") {
		const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["HOSTILE_INPUT"]) };
		return Object.freeze(fail);
	}
	const arr: unknown[] = arrOrErr;

	const maxRecords: number = bounds.maxRecords;
	const maxBytes: number = bounds.maxBytes;
	const maxRecordBytes: number = bounds.maxRecordBytes;
	const maxGroups: number = bounds.maxGroups;

	// Step 1: Dense array count check BEFORE any brand/decode
	if (arr.length > maxRecords) {
		const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["BOUND_RECORDS_EXCEEDED"]) };
		return Object.freeze(fail);
	}

	// Step 2: Brand and retain byte views. Each wrapper branded ONCE.
	const retainedViews: { view: object; byteLength: number }[] = [];
	for (const item of arr) {
		const brandResult: BrandResult = _brandCheck(item);
		if (!brandResult.ok) {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["BRAND_CHECK_FAILURE"]) };
			return Object.freeze(fail);
		}

		// Create view over the owned buffer
		const ownedBuffer: unknown = brandResult.buffer;
		const srcView: object = _reflectConstruct(Uint8Array, [ownedBuffer]);

		// Get byteLength from the view using captured descriptor
		if (_u8BLDesc === undefined) {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["HOSTILE_INPUT"]) };
			return Object.freeze(fail);
		}
		const blGetFn: unknown = _u8BLDesc.get;
		if (typeof blGetFn !== "function") {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["HOSTILE_INPUT"]) };
			return Object.freeze(fail);
		}
		let blUnknown: unknown;
		try {
			blUnknown = _reflectApply(blGetFn, srcView, []);
		} catch (_e) {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["HOSTILE_INPUT"]) };
			return Object.freeze(fail);
		}
		if (typeof blUnknown !== "number") {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["HOSTILE_INPUT"]) };
			return Object.freeze(fail);
		}
		const size: number = blUnknown;

		// Step 3: Per-record size check before decode
		if (size > maxRecordBytes) {
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["BOUND_RECORD_BYTES_EXCEEDED"]) };
			return Object.freeze(fail);
		}

		retainedViews.push({ view: srcView, byteLength: size });
	}

	// Step 4: Aggregate byte count before any decode
	const totalBytes: number = retainedViews.reduce(
		(acc: number, v: { view: object; byteLength: number }) => acc + v.byteLength,
		0,
	);
	if (totalBytes > maxBytes) {
		const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze(["BOUND_BYTES_EXCEEDED"]) };
		return Object.freeze(fail);
	}

	// Step 5: Decode each retained byte view once (no second parse)
	const decodedRecords: object[] = [];
	for (const entry of retainedViews) {
		// Copy bytes from view to fresh Uint8Array for decode
		const bl: number = entry.byteLength;
		const freshBuf: ArrayBuffer = new ArrayBuffer(bl);
		const dst: Uint8Array = new Uint8Array(freshBuf);
		for (let bi: number = 0; bi < bl; bi++) {
			const idx: string = String(bi);
			const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(entry.view, idx);
			if (desc === undefined) continue;
			const byteVal: unknown = desc.value;
			if (typeof byteVal !== "number") continue;
			dst[bi] = byteVal;
		}

		const parsedOrErr: object | string = _decodeAndValidateBytes(dst);
		if (typeof parsedOrErr === "string") {
			let error: LedgerErrorCode = "DECODE_FAILURE";
			if (parsedOrErr === "CANONICAL_BYTES_MISMATCH") error = "CANONICAL_BYTES_MISMATCH";
			else if (parsedOrErr === "FIELD_TYPE_MISMATCH") error = "FIELD_TYPE_MISMATCH";
			else if (parsedOrErr === "FIELD_TOO_LARGE") error = "FIELD_TOO_LARGE";
			else if (parsedOrErr === "FIELD_NON_PRINTABLE") error = "FIELD_NON_PRINTABLE";
			else if (parsedOrErr === "FIELD_STATUS_INVALID") error = "FIELD_STATUS_INVALID";
			else if (parsedOrErr === "FIELD_TERMINAL_STATUS_INVALID") error = "FIELD_TERMINAL_STATUS_INVALID";
			else if (parsedOrErr === "FIELD_TERMINAL_CODE_INVALID") error = "FIELD_TERMINAL_CODE_INVALID";
			else if (parsedOrErr === "FIELD_THINKING_LEVEL_INVALID") error = "FIELD_THINKING_LEVEL_INVALID";
			else if (parsedOrErr === "FIELD_SERVICE_TIER_INVALID") error = "FIELD_SERVICE_TIER_INVALID";
			const fail: InventoryFailure = { code: "FAIL", errors: Object.freeze([error]) };
			return Object.freeze(fail);
		}
		decodedRecords.push(parsedOrErr);
	}

	// Global LIFECYCLE_DIGEST_COLLISION check
	const digestMap: Record<string, { idBytes: Uint8Array; anchor: LedgerAnchor }[]> = {};
	for (const rec of decodedRecords) {
		const idObj: unknown = Reflect.get(rec, "identity");
		const lkd: string = _str2(
			typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "lifecycleKeyDigest") : "",
		);
		const idBytes: Uint8Array = _serializeIdentityTuple(
			typeof idObj === "object" && idObj !== null ? _buildIdentityRec(idObj) : {},
		);
		const anchor: LedgerAnchor = {
			childId: _str2(typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "childId") : ""),
			sessionId: _str2(typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "sessionId") : ""),
			activeSessionId: _str2(
				typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "activeSessionId") : "",
			),
		};
		const entries: { idBytes: Uint8Array; anchor: LedgerAnchor }[] = digestMap[lkd] || [];
		let found: boolean = false;
		for (const existing of entries) {
			if (existing.idBytes.byteLength !== idBytes.byteLength) continue;
			let match: boolean = true;
			for (let bi: number = 0; bi < idBytes.byteLength; bi++) {
				if (existing.idBytes[bi] !== idBytes[bi]) {
					match = false;
					break;
				}
			}
			if (match) {
				found = true;
				break;
			}
		}
		if (!found) {
			entries.push({ idBytes, anchor });
			digestMap[lkd] = entries;
		}
	}

	const collisionError: LedgerErrorCode[] = [];
	for (const lkdKey in digestMap) {
		if (Object.hasOwn(digestMap, lkdKey)) {
			if (digestMap[lkdKey].length > 1) {
				collisionError.push("LIFECYCLE_DIGEST_COLLISION");
				break;
			}
		}
	}

	// Group by anchor using nested Maps (V9: Map<childId, Map<sessionId, Map<activeSessionId, object[]>>>)
	const anchorGroups: Map<string, Map<string, Map<string, object[]>>> = new Map();
	for (const rec of decodedRecords) {
		const idObj: unknown = Reflect.get(rec, "identity");
		const cid: string = _str2(typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "childId") : "");
		const sid: string = _str2(typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "sessionId") : "");
		const asid: string = _str2(
			typeof idObj === "object" && idObj !== null ? Reflect.get(idObj, "activeSessionId") : "",
		);
		let byCid: Map<string, Map<string, object[]>> | undefined = anchorGroups.get(cid);
		if (byCid === undefined) {
			byCid = new Map();
			anchorGroups.set(cid, byCid);
		}
		let bySid: Map<string, object[]> | undefined = byCid.get(sid);
		if (bySid === undefined) {
			bySid = new Map();
			byCid.set(sid, bySid);
		}
		let byAsid: object[] | undefined = bySid.get(asid);
		if (byAsid === undefined) {
			byAsid = [];
			bySid.set(asid, byAsid);
		}
		byAsid.push(rec);
	}

	// Build anchor list from nested Map keys (deterministic insertion order)
	const anchorList: { anchor: LedgerAnchor; records: object[] }[] = [];
	for (const [cid, byCid] of anchorGroups) {
		for (const [sid, bySid] of byCid) {
			for (const [asid, records] of bySid) {
				anchorList.push({
					anchor: { childId: cid, sessionId: sid, activeSessionId: asid },
					records,
				});
			}
		}
	}

	// Count distinct anchor groups (collected after collision check, not early return)
	const _groupCountExceeded: boolean = anchorList.length > maxGroups;

	// Sort by length-prefixed UTF-8 tuple comparator for deterministic ordering
	anchorList.sort((a: { anchor: LedgerAnchor; records: object[] }, b: { anchor: LedgerAnchor; records: object[] }) => {
		return _compareAnchor(a.anchor, b.anchor);
	});
	const allErrors: LedgerErrorCode[] = collisionError;
	if (_groupCountExceeded) {
		allErrors.push("BOUND_GROUPS_EXCEEDED");
	}
	for (const entry of anchorList) {
		const group: object[] = entry.records;
		const groupSeen: Set<object> = new Set<object>();

		const lkds: Set<string> = new Set<string>();
		for (const rec of group) {
			// Per-group reference alias rejection
			if (groupSeen.has(rec)) {
				allErrors.push("HOSTILE_INPUT");
			} else {
				groupSeen.add(rec);
			}
			const idObj: unknown = Reflect.get(rec, "identity");
			if (typeof idObj === "object" && idObj !== null) {
				lkds.add(_str2(Reflect.get(idObj, "lifecycleKeyDigest")));
			}
		}
		if (lkds.size > 1) {
			allErrors.push("ANCHOR_REUSE_IDENTITY_COLLISION");
		}

		group.sort((a: object, b: object) => {
			const ar: unknown = Reflect.get(a, "rev");
			const br: unknown = Reflect.get(b, "rev");
			if (typeof ar !== "number") return -1;
			if (typeof br !== "number") return 1;
			return ar - br;
		});

		const revMap: Record<number, { cd: string; index: number }[]> = {};
		for (let gi: number = 0; gi < group.length; gi++) {
			const rec: object = group[gi];
			const rv: unknown = Reflect.get(rec, "rev");
			const revNum: number = typeof rv === "number" ? rv : -1;
			if (revMap[revNum] === undefined) revMap[revNum] = [];
			revMap[revNum].push({
				cd: _str2(Reflect.get(rec, "contentDigest")),
				index: gi,
			});
		}

		let maxRev: number = -1;
		for (const rvStr in revMap) {
			if (Object.hasOwn(revMap, rvStr)) {
				const rn: number = Number(rvStr);
				if (rn > maxRev) maxRev = rn;
			}
		}

		for (let r: number = 0; r <= maxRev; r++) {
			if (revMap[r] === undefined) {
				allErrors.push("GAP_DETECTED");
			}
		}

		for (const rvStr in revMap) {
			if (Object.hasOwn(revMap, rvStr)) {
				const entries2: { cd: string; index: number }[] = revMap[rvStr];
				if (entries2.length > 1) {
					const cds: Set<string> = new Set<string>();
					for (const e of entries2) cds.add(e.cd);
					if (cds.size > 1) {
						allErrors.push("FORK_DETECTED");
					} else {
						allErrors.push("DUPLICATE_REV");
					}
				}
			}
		}

		for (const rec of group) {
			const idObj: unknown = Reflect.get(rec, "identity");
			if (typeof idObj === "object" && idObj !== null) {
				const expectedLKD: string = _deriveLifecycleKeyDigest(_buildIdentityRec(idObj));
				const actualLKD: unknown = Reflect.get(idObj, "lifecycleKeyDigest");
				if (actualLKD !== expectedLKD) {
					allErrors.push("ORPHAN_DETECTED");
					break;
				}
			}
		}

		const chainResult: ValidateChainResult = _validateChain(group);
		if (chainResult.code === "FAIL") {
			for (const err of chainResult.errors) {
				allErrors.push(err);
			}
		}
	}

	if (allErrors.length > 0) {
		const frozenErrors: readonly LedgerErrorCode[] = Object.freeze(allErrors);
		const fail: InventoryFailure = { code: "FAIL", errors: frozenErrors };
		return Object.freeze(fail);
	}

	const groups: LedgerInventoryGroup[] = [];
	for (const entry of anchorList) {
		const group: object[] = entry.records;
		group.sort((a: object, b: object) => {
			const ar: unknown = Reflect.get(a, "rev");
			const br: unknown = Reflect.get(b, "rev");
			if (typeof ar !== "number") return -1;
			if (typeof br !== "number") return 1;
			return ar - br;
		});
		const chain: LedgerRecord[] = [];
		let gBytes: number = 0;
		for (const recObj of group) {
			const idObj: unknown = Reflect.get(recObj, "identity");
			const rec: LedgerRecord = _buildLedgerRecord(recObj, idObj);
			chain.push(rec);
			const json: string = _buildRecordJSON(recObj, false);
			gBytes += new TextEncoder().encode(json).byteLength + 1; // +1 for trailing 0x0A
		}
		groups.push({
			anchor: entry.anchor,
			chain: Object.freeze(chain),
			totalBytes: gBytes,
		});
	}

	const frozenGroups: readonly LedgerInventoryGroup[] = Object.freeze(groups);
	const success: InventorySuccess = { code: "OK", groups: frozenGroups };
	return Object.freeze(success);
} // =========================================================================
// 28. Reveal
// =========================================================================

function _reveal(raw: unknown): RevealResult {
	const brandResult: BrandResult = _brandCheck(raw);
	if (!brandResult.ok) {
		const fail: RevealFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}

	const ownedBuffer: unknown = brandResult.buffer;

	if (_abByteLengthDesc === undefined) {
		const fail: RevealFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}
	const blGetFn: unknown = _abByteLengthDesc.get;
	if (typeof blGetFn !== "function") {
		const fail: RevealFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}
	let byteLenUnknown: unknown;
	try {
		byteLenUnknown = _reflectApply(blGetFn, ownedBuffer, []);
	} catch (_e) {
		const fail: RevealFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}
	if (typeof byteLenUnknown !== "number") {
		const fail: RevealFailure = { code: "FAIL", error: "BRAND_CHECK_FAILURE" };
		return Object.freeze(fail);
	}
	const byteLength: number = byteLenUnknown;

	// Create fresh ArrayBuffer and copy bytes via DataView setUint8
	const copyBuf: ArrayBuffer = new ArrayBuffer(byteLength);
	const srcDV: object = _reflectConstruct(DataView, [ownedBuffer]);
	const dst: Uint8Array = new Uint8Array(copyBuf);

	for (let i: number = 0; i < byteLength; i++) {
		dst[i] = _reflectApply(DataView.prototype.getUint8, srcDV, [i]);
	}

	const data: Uint8Array = dst;
	const success: RevealSuccess = { code: "OK", data };
	return Object.freeze(success);
}

// =========================================================================
// 29. Iterative deep freeze
// =========================================================================

function _iterativeDeepFreeze(root: object): void {
	const worklist: object[] = [root];
	const seen: Set<object> = new Set<object>();
	while (worklist.length > 0) {
		const current: object | undefined = worklist.pop();
		if (current === undefined) break;
		if (seen.has(current)) continue;
		seen.add(current);
		_freeze(current);
		const names: string[] = _getOwnPropertyNames(current);
		for (const name of names) {
			const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(current, name);
			if (desc === undefined) continue;
			if (desc.get !== undefined || desc.set !== undefined) continue;
			const val: unknown = desc.value;
			if (typeof val !== "object" || val === null) continue;
			const proto: object = _getPrototypeOf(val);
			if (proto === Object.prototype || proto === Array.prototype) {
				worklist.push(val);
			}
		}
	}
}

// =========================================================================
// 30. Public exports
// =========================================================================

function appendGenesis(rawChain: unknown, rawGenesis: unknown, rawBounds: unknown): AppendResult {
	const result: AppendResult = _appendGenesis(rawChain, rawGenesis, rawBounds);
	_iterativeDeepFreeze(result);
	return result;
}

function appendTransition(rawChain: unknown, rawTransition: unknown, rawBounds: unknown): AppendResult {
	const result: AppendResult = _appendTransition(rawChain, rawTransition, rawBounds);
	_iterativeDeepFreeze(result);
	return result;
}

function decodeRecord(raw: unknown): DecodeResult {
	const result: DecodeResult = _decodeRecord(raw);
	_iterativeDeepFreeze(result);
	return result;
}

function decodeJournal(raw: unknown): DecodeJournalResult {
	const result: DecodeJournalResult = _decodeJournal(raw);
	_iterativeDeepFreeze(result);
	return result;
}

function encodeGenesisBytes(rawGenesis: unknown, rawBounds: unknown): EncodeResult {
	const result: EncodeResult = _encodeGenesisBytes(rawGenesis, rawBounds);
	_iterativeDeepFreeze(result);
	return result;
}

function encodeTransitionBytes(rawChain: unknown, rawTransition: unknown, rawBounds: unknown): EncodeResult {
	const result: EncodeResult = _encodeTransitionBytes(rawChain, rawTransition, rawBounds);
	_iterativeDeepFreeze(result);
	return result;
}

function inventory(rawRecords: unknown, rawBounds: unknown): InventoryResult {
	const result: InventoryResult = _inventory(rawRecords, rawBounds);
	_iterativeDeepFreeze(result);
	return result;
}

function reveal(raw: unknown): RevealResult {
	const result: RevealResult = _reveal(raw);
	_iterativeDeepFreeze(result);
	return result;
}

function mintRecordBytes(raw: unknown): MintResult {
	const result: MintResult = _mintRecordBytes(raw);
	_iterativeDeepFreeze(result);
	return result;
}

export type {
	AppendFailure,
	AppendResult,
	AppendSuccess,
	DecodeFailure,
	DecodeJournalFailure,
	DecodeJournalResult,
	DecodeJournalSuccess,
	DecodeResult,
	DecodeSuccess,
	EncodeFailure,
	EncodeResult,
	EncodeSuccess,
	InventoryFailure,
	InventoryResult,
	InventorySuccess,
	LedgerAnchor,
	LedgerErrorCode,
	LedgerIdentity,
	LedgerInventoryGroup,
	LedgerRecord,
	LedgerRecordBytes,
	MintFailure,
	MintResult,
	MintSuccess,
	RevealFailure,
	RevealResult,
	RevealSuccess,
	ValidateChainResult,
	ValidateFailure,
	ValidateSuccess,
};
export {
	appendGenesis,
	appendTransition,
	decodeJournal,
	decodeRecord,
	encodeGenesisBytes,
	encodeTransitionBytes,
	inventory,
	mintRecordBytes,
	reveal,
};
