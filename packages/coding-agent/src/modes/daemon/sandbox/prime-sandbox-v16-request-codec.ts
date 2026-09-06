import * as util from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// ---------- constants ----------

const MAX_REQUEST_BYTES: number = 262128;
const MAX_STRING_UTF8_BYTES: number = 16384;
const MAX_NAME_UTF8_BYTES: number = 256;
const MAX_SELECTOR_UTF8_BYTES: number = 128;

const ID_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();

// ---------- captured intrinsics (module-init, never rebound) ----------

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _keys: typeof Object.keys = Object.keys;
const _freeze: typeof Object.freeze = Object.freeze;
const _is: typeof Object.is = Object.is;
const _JSON_parse: typeof JSON.parse = JSON.parse;
const _JSON_stringify: typeof JSON.stringify = JSON.stringify;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _isProxy: (value: object) => boolean = util.types.isProxy;
const _encode: (input?: string) => Uint8Array = TEXT_ENCODER.encode.bind(TEXT_ENCODER);
const _decodeFatal: (input: Uint8Array) => string = TEXT_DECODER_FATAL.decode.bind(TEXT_DECODER_FATAL);
const METHOD_NAMES: ReadonlyArray<string> = _freeze([
	"list_agents",
	"roster",
	"await_pending",
	"assert_name",
	"set_name",
	"send_message",
	"observe_list",
	"observe_get",
	"observe_recent",
]);

// ---------- error types ----------

type V16EncodeFailureCode = "INPUT_INVALID" | "INPUT_TOO_LARGE" | "UNKNOWN_METHOD" | "FRAME_ERROR";
type V16DecodeFailureCode = "INPUT_INVALID" | "INPUT_TOO_LARGE" | "FRAME_ERROR" | "UTF8_ERROR";

interface V16EncodeSuccess {
	readonly ok: true;
	readonly bytes: Uint8Array;
}
interface V16EncodeFailure {
	readonly ok: false;
	readonly code: V16EncodeFailureCode;
}
type V16EncodeResult = V16EncodeSuccess | V16EncodeFailure;

interface V16DecodeFailure {
	readonly ok: false;
	readonly code: V16DecodeFailureCode;
}

// ---------- frozen failure constants ----------

const FAIL_ENCODE_INPUT_INVALID: V16EncodeFailure = _freeze({ ok: false, code: "INPUT_INVALID" });
const FAIL_ENCODE_INPUT_TOO_LARGE: V16EncodeFailure = _freeze({ ok: false, code: "INPUT_TOO_LARGE" });
const _FAIL_ENCODE_UNKNOWN_METHOD: V16EncodeFailure = _freeze({ ok: false, code: "UNKNOWN_METHOD" });
const _FAIL_ENCODE_FRAME_ERROR: V16EncodeFailure = _freeze({ ok: false, code: "FRAME_ERROR" });

const FAIL_DECODE_INPUT_INVALID: V16DecodeFailure = _freeze({ ok: false, code: "INPUT_INVALID" });
const FAIL_DECODE_INPUT_TOO_LARGE: V16DecodeFailure = _freeze({ ok: false, code: "INPUT_TOO_LARGE" });
const FAIL_DECODE_FRAME_ERROR: V16DecodeFailure = _freeze({ ok: false, code: "FRAME_ERROR" });
const FAIL_DECODE_UTF8_ERROR: V16DecodeFailure = _freeze({ ok: false, code: "UTF8_ERROR" });

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

// ---------- body types ----------

interface V16EmptyBody {
	readonly [key: string]: never;
}

interface V16AwaitPendingBody {
	readonly selector: string;
}

interface V16AssertNameBody {
	readonly name: string;
	readonly depth: number;
	readonly parentSessionId: string | null;
	readonly ignoreSessionId: string | null;
}

interface V16SetNameBody {
	readonly name: string;
}

interface V16SendMessageBody {
	readonly target: string;
	readonly message: string;
	readonly receiverRole: "parent" | "sibling" | "child" | null;
}

interface V16ObserveGetBody {
	readonly target: string;
}

interface V16ObserveRecentBody {
	readonly target: string;
	readonly limit: number | null;
	readonly maxChars: number | null;
}

type V16RequestBody =
	| V16EmptyBody
	| V16AwaitPendingBody
	| V16AssertNameBody
	| V16SetNameBody
	| V16SendMessageBody
	| V16ObserveGetBody
	| V16ObserveRecentBody;

// ---------- correlated request discriminated union ----------

type V16ListAgentsRequest = { readonly method: "list_agents"; readonly body: V16EmptyBody };
type V16RosterRequest = { readonly method: "roster"; readonly body: V16EmptyBody };
type V16ObserveListRequest = { readonly method: "observe_list"; readonly body: V16EmptyBody };
type V16AwaitPendingRequest = { readonly method: "await_pending"; readonly body: V16AwaitPendingBody };
type V16AssertNameRequest = { readonly method: "assert_name"; readonly body: V16AssertNameBody };
type V16SetNameRequest = { readonly method: "set_name"; readonly body: V16SetNameBody };
type V16SendMessageRequest = { readonly method: "send_message"; readonly body: V16SendMessageBody };
type V16ObserveGetRequest = { readonly method: "observe_get"; readonly body: V16ObserveGetBody };
type V16ObserveRecentRequest = { readonly method: "observe_recent"; readonly body: V16ObserveRecentBody };

type V16TypedRequest =
	| V16ListAgentsRequest
	| V16RosterRequest
	| V16ObserveListRequest
	| V16AwaitPendingRequest
	| V16AssertNameRequest
	| V16SetNameRequest
	| V16SendMessageRequest
	| V16ObserveGetRequest
	| V16ObserveRecentRequest;

// ---------- correlated decode success ----------

interface V16DecodeCorrelatedOk {
	readonly ok: true;
	readonly request: V16TypedRequest;
}

type V16DecodeCorrelated = V16DecodeCorrelatedOk | V16DecodeFailure;

// ---------- fail-closed reflection wrappers ----------

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

// Captures descriptors once, returns undefined on any reflection failure.
// The names array comes from the descriptor map, not a separate getOwnPropertyNames call.
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
	const names: ReadonlyArray<string> = _freeze(_keys(table));
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

function captureExactKeySetSorted(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): Record<string, TypedPropertyDescriptor<unknown>> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	const sorted: ReadonlyArray<string> = _freeze(ct.names.slice().sort());
	const expectedSorted: ReadonlyArray<string> = _freeze(expected.slice().sort());
	for (let i: number = 0; i < sorted.length; i++) {
		if (sorted[i] !== expectedSorted[i]) return undefined;
	}
	return ct.table;
}

function captureExactKeysOrdered(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): Record<string, TypedPropertyDescriptor<unknown>> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	for (let i: number = 0; i < expected.length; i++) {
		if (ct.names[i] !== expected[i]) return undefined;
	}
	return ct.table;
}

function hasNoOwnKeys(value: Record<string, unknown>): boolean {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return false;
	return ct.names.length === 0;
}

// ---------- scalar validators ----------

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object") return false;
	if (value === null) return false;
	return true;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isSafeInteger(value: unknown): value is number {
	if (typeof value !== "number") return false;
	return _isSafeInteger(value);
}

function isV16Method(value: string): boolean {
	return METHOD_NAMES.indexOf(value) >= 0;
}

function isValidId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return ID_PATTERN.test(value);
}

// UTF-8 byte count for a string
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

// Validate printable Unicode string with exact UTF-8 byte bound.
// Rejects: empty, C0 (0x00-0x1F), DEL (0x7F), unpaired surrogates,
// exceeds maxUtf8Bytes. Accepts all other printable Unicode including
// slash, backslash, whitespace, emoji.
function validateUtf8String(value: unknown, maxUtf8Bytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length < 1) return undefined;
	if (utf8ByteCount(value) > maxUtf8Bytes) return undefined;
	const len: number = value.length;
	for (let i: number = 0; i < len; i++) {
		const cc: number = value.charCodeAt(i);
		if (cc <= 0x1f) return undefined;
		if (cc >= 0x7f && cc <= 0x9f) return undefined;
		if (cc === 0x2028 || cc === 0x2029) return undefined;
		if (cc >= 0xd800 && cc <= 0xdfff) {
			if (cc <= 0xdbff) {
				if (i + 1 >= len) return undefined;
				const next: number = value.charCodeAt(i + 1);
				if (next < 0xdc00 || next > 0xdfff) return undefined;
				i += 1;
			} else {
				return undefined;
			}
		}
	}
	return value;
}

function isValidRelationship(value: unknown): value is "parent" | "sibling" | "child" {
	if (typeof value !== "string") return false;
	if (value === "parent") return true;
	if (value === "sibling") return true;
	if (value === "child") return true;
	return false;
}

function isValidMessage(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 1) return false;
	if (utf8ByteCount(value) > MAX_STRING_UTF8_BYTES) return false;
	return true;
}

function isValidLimit(value: unknown): value is number {
	if (!isSafeInteger(value)) return false;
	if (value < 1) return false;
	if (value > 50) return false;
	return true;
}

function isValidMaxChars(value: unknown): value is number {
	if (!isSafeInteger(value)) return false;
	if (value < 80) return false;
	if (value > 2000) return false;
	return true;
}

function isValidDepth(value: unknown): value is number {
	if (!isSafeInteger(value)) return false;
	if (value < 0) return false;
	if (value > 100) return false;
	return true;
}

function isNegativeZero(value: number): boolean {
	return _is(value, -0);
}

// ---------- optional value helpers ----------

function validateOptionalId(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (!isValidId(value)) return undefined;
	return value;
}

function validateOptionalRole(value: unknown): "parent" | "sibling" | "child" | null | undefined {
	if (value === null) return null;
	if (!isValidRelationship(value)) return undefined;
	return value;
}

function validateOptionalLimit(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (!isValidLimit(value)) return undefined;
	if (isNegativeZero(value)) return undefined;
	return value;
}

function validateOptionalMaxChars(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (!isValidMaxChars(value)) return undefined;
	if (isNegativeZero(value)) return undefined;
	return value;
}

// ---------- body validators ----------

function validateEmptyBody(value: unknown): V16EmptyBody | undefined {
	if (!isRecord(value)) return undefined;
	if (!hasNoOwnKeys(value)) return undefined;
	return _freeze({});
}

function validateAwaitPendingBody(value: unknown): V16AwaitPendingBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["selector"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const selector: unknown = d.selector.value;
	const validated: string | undefined = validateUtf8String(selector, MAX_SELECTOR_UTF8_BYTES);
	if (validated === undefined) return undefined;
	return _freeze({ selector: validated });
}

function validateAssertNameBody(value: unknown): V16AssertNameBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["name", "depth", "parentSessionId", "ignoreSessionId"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const nameRaw: unknown = d.name.value;
	const nameVal: string | undefined = validateUtf8String(nameRaw, MAX_NAME_UTF8_BYTES);
	if (nameVal === undefined) return undefined;
	const depthRaw: unknown = d.depth.value;
	if (!isValidDepth(depthRaw)) return undefined;
	if (isNegativeZero(depthRaw)) return undefined;
	const parentSessionId: string | null | undefined = validateOptionalId(d.parentSessionId.value);
	if (parentSessionId === undefined) return undefined;
	const ignoreSessionId: string | null | undefined = validateOptionalId(d.ignoreSessionId.value);
	if (ignoreSessionId === undefined) return undefined;
	return _freeze({
		name: nameVal,
		depth: depthRaw,
		parentSessionId: parentSessionId,
		ignoreSessionId: ignoreSessionId,
	});
}

function validateSetNameBody(value: unknown): V16SetNameBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["name"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const nameRaw: unknown = d.name.value;
	const nameVal: string | undefined = validateUtf8String(nameRaw, MAX_NAME_UTF8_BYTES);
	if (nameVal === undefined) return undefined;
	return _freeze({ name: nameVal });
}

function validateSendMessageBody(value: unknown): V16SendMessageBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["target", "message", "receiverRole"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const targetRaw: unknown = d.target.value;
	if (!isValidId(targetRaw)) return undefined;
	const messageRaw: unknown = d.message.value;
	if (!isValidMessage(messageRaw)) return undefined;
	const receiverRole: "parent" | "sibling" | "child" | null | undefined = validateOptionalRole(d.receiverRole.value);
	if (receiverRole === undefined) return undefined;
	return _freeze({
		target: targetRaw,
		message: messageRaw,
		receiverRole: receiverRole,
	});
}

function validateObserveGetBody(value: unknown): V16ObserveGetBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["target"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const targetRaw: unknown = d.target.value;
	if (!isValidId(targetRaw)) return undefined;
	return _freeze({ target: targetRaw });
}

function validateObserveRecentBody(value: unknown): V16ObserveRecentBody | undefined {
	if (!isRecord(value)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["target", "limit", "maxChars"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(value, expected);
	if (d === undefined) return undefined;
	const targetRaw: unknown = d.target.value;
	if (!isValidId(targetRaw)) return undefined;
	const limit: number | null | undefined = validateOptionalLimit(d.limit.value);
	if (limit === undefined) return undefined;
	const maxChars: number | null | undefined = validateOptionalMaxChars(d.maxChars.value);
	if (maxChars === undefined) return undefined;
	return _freeze({
		target: targetRaw,
		limit: limit,
		maxChars: maxChars,
	});
}

// ---------- top-level encode boundary validator ----------

interface EncodeRawInput {
	readonly method: string;
	readonly body: unknown;
}

function validateEncodeInput(input: unknown): EncodeRawInput | undefined {
	if (!isRecord(input)) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["body", "method"]);
	const d: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeySetSorted(input, expected);
	if (d === undefined) return undefined;
	const methodRaw: unknown = d.method.value;
	if (!isString(methodRaw)) return undefined;
	if (!isV16Method(methodRaw)) return undefined;
	return { method: methodRaw, body: d.body.value };
}

// ---------- wire envelope ----------

function buildWireBytes(body: unknown, method: string, version: number): Uint8Array {
	const wire: Record<string, unknown> = Object.create(null);
	wire.body = body;
	wire.method = method;
	wire.version = version;
	const json: string = _JSON_stringify(wire);
	return _encode(json);
}

function decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
	try {
		return _decodeFatal(bytes);
	} catch {
		return undefined;
	}
}

// ---------- encode (public API takes unknown, protected by descriptor validation) ----------

function encodeRequest(raw: unknown): V16EncodeResult {
	const parsed: EncodeRawInput | undefined = validateEncodeInput(raw);
	if (parsed === undefined) {
		return FAIL_ENCODE_INPUT_INVALID;
	}
	const method: string = parsed.method;
	let body: V16RequestBody | undefined;
	switch (method) {
		case "list_agents":
			body = validateEmptyBody(parsed.body);
			break;
		case "roster":
			body = validateEmptyBody(parsed.body);
			break;
		case "observe_list":
			body = validateEmptyBody(parsed.body);
			break;
		case "await_pending":
			body = validateAwaitPendingBody(parsed.body);
			break;
		case "assert_name":
			body = validateAssertNameBody(parsed.body);
			break;
		case "set_name":
			body = validateSetNameBody(parsed.body);
			break;
		case "send_message":
			body = validateSendMessageBody(parsed.body);
			break;
		case "observe_get":
			body = validateObserveGetBody(parsed.body);
			break;
		case "observe_recent":
			body = validateObserveRecentBody(parsed.body);
			break;
	}
	if (body === undefined) {
		return FAIL_ENCODE_INPUT_INVALID;
	}
	const bytes: Uint8Array = buildWireBytes(body, method, 1);
	if (bytes.length > MAX_REQUEST_BYTES) {
		return FAIL_ENCODE_INPUT_TOO_LARGE;
	}
	// Freeze the result envelope. bytes is already a fresh Uint8Array from TEXT_ENCODER.encode.
	const result: V16EncodeSuccess = _freeze({ ok: true, bytes: bytes });
	return result;
}

// ---------- typed overloads for compile-time correlation ----------

function encodeTypedRequestListAgents(body: V16EmptyBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "list_agents" });
}
function encodeTypedRequestRoster(body: V16EmptyBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "roster" });
}
function encodeTypedRequestObserveList(body: V16EmptyBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "observe_list" });
}
function encodeTypedRequestAwaitPending(body: V16AwaitPendingBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "await_pending" });
}
function encodeTypedRequestAssertName(body: V16AssertNameBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "assert_name" });
}
function encodeTypedRequestSetName(body: V16SetNameBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "set_name" });
}
function encodeTypedRequestSendMessage(body: V16SendMessageBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "send_message" });
}
function encodeTypedRequestObserveGet(body: V16ObserveGetBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "observe_get" });
}
function encodeTypedRequestObserveRecent(body: V16ObserveRecentBody): V16EncodeResult {
	return encodeRequest({ body: body, method: "observe_recent" });
}

// ---------- decode ----------

function decodeRequest(input: unknown): V16DecodeCorrelated {
	const copyResult = copySandboxStrictBytes(input, MAX_REQUEST_BYTES);
	if (!copyResult.ok) {
		if (copyResult.code === "INPUT_TOO_LARGE") {
			return FAIL_DECODE_INPUT_TOO_LARGE;
		}
		return FAIL_DECODE_INPUT_INVALID;
	}
	const bytes: Uint8Array = copyResult.value;

	const text: string | undefined = decodeUtf8Fatal(bytes);
	if (text === undefined) {
		return FAIL_DECODE_UTF8_ERROR;
	}

	let parsed: unknown;
	try {
		parsed = _JSON_parse(text);
	} catch {
		return FAIL_DECODE_FRAME_ERROR;
	}
	if (!isRecord(parsed)) {
		return FAIL_DECODE_FRAME_ERROR;
	}

	const wireKeys: ReadonlyArray<string> = _freeze(["body", "method", "version"]);
	const topDescs: Record<string, TypedPropertyDescriptor<unknown>> | undefined = captureExactKeysOrdered(
		parsed,
		wireKeys,
	);
	if (topDescs === undefined) {
		return FAIL_DECODE_FRAME_ERROR;
	}

	const versionRaw: unknown = topDescs.version.value;
	if (versionRaw !== 1) {
		return FAIL_DECODE_FRAME_ERROR;
	}

	const methodRaw: unknown = topDescs.method.value;
	if (!isString(methodRaw)) {
		return FAIL_DECODE_FRAME_ERROR;
	}
	if (!isV16Method(methodRaw)) {
		return FAIL_DECODE_FRAME_ERROR;
	}
	const method: string = methodRaw;

	const bodyRaw: unknown = topDescs.body.value;

	function decodeDispatchAndBuild(m: string): V16DecodeCorrelated | undefined {
		switch (m) {
			case "list_agents": {
				const b: V16EmptyBody | undefined = validateEmptyBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "list_agents", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				const result: V16DecodeCorrelated = _freeze({
					ok: true,
					request: _freeze({ method: "list_agents", body: b }),
				});
				return result;
			}
			case "roster": {
				const b: V16EmptyBody | undefined = validateEmptyBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "roster", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "roster", body: b }) });
			}
			case "observe_list": {
				const b: V16EmptyBody | undefined = validateEmptyBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "observe_list", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "observe_list", body: b }) });
			}
			case "await_pending": {
				const b: V16AwaitPendingBody | undefined = validateAwaitPendingBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "await_pending", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "await_pending", body: b }) });
			}
			case "assert_name": {
				const b: V16AssertNameBody | undefined = validateAssertNameBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "assert_name", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "assert_name", body: b }) });
			}
			case "set_name": {
				const b: V16SetNameBody | undefined = validateSetNameBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "set_name", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "set_name", body: b }) });
			}
			case "send_message": {
				const b: V16SendMessageBody | undefined = validateSendMessageBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "send_message", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "send_message", body: b }) });
			}
			case "observe_get": {
				const b: V16ObserveGetBody | undefined = validateObserveGetBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "observe_get", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "observe_get", body: b }) });
			}
			case "observe_recent": {
				const b: V16ObserveRecentBody | undefined = validateObserveRecentBody(bodyRaw);
				if (b === undefined) return undefined;
				const canon: Uint8Array = buildWireBytes(b, "observe_recent", 1);
				if (canon.length !== bytes.length) return FAIL_DECODE_FRAME_ERROR;
				for (let i2: number = 0; i2 < bytes.length; i2++) {
					if (canon[i2] !== bytes[i2]) return FAIL_DECODE_FRAME_ERROR;
				}
				return _freeze({ ok: true, request: _freeze({ method: "observe_recent", body: b }) });
			}
		}
		return undefined;
	}

	const correlatedResult: V16DecodeCorrelated | undefined = decodeDispatchAndBuild(method);
	if (correlatedResult === undefined) {
		return FAIL_DECODE_INPUT_INVALID;
	}
	return correlatedResult;
}

// ---------- exports ----------

export type {
	V16AssertNameBody,
	V16AwaitPendingBody,
	V16DecodeCorrelated,
	V16DecodeFailure,
	V16DecodeFailureCode,
	V16EmptyBody,
	V16EncodeFailure,
	V16EncodeFailureCode,
	V16EncodeResult,
	V16EncodeSuccess,
	V16Method,
	V16ObserveGetBody,
	V16ObserveRecentBody,
	V16RequestBody,
	V16SendMessageBody,
	V16SetNameBody,
	V16TypedRequest,
};
export {
	decodeRequest,
	encodeRequest,
	encodeTypedRequestAssertName,
	encodeTypedRequestAwaitPending,
	encodeTypedRequestListAgents,
	encodeTypedRequestObserveGet,
	encodeTypedRequestObserveList,
	encodeTypedRequestObserveRecent,
	encodeTypedRequestRoster,
	encodeTypedRequestSendMessage,
	encodeTypedRequestSetName,
	utf8ByteCount,
	validateUtf8String,
};
