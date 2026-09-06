// Stable wire codec for sandbox model requests and replies.
//
// Request wire: { context, options }.
// Reply wire: { ok: true, message } or { ok: false, code: "INTERNAL_ERROR" }.
// The accepted semantic failure input for encodeModelReply is exactly
// { ok: false, code: "INTERNAL_ERROR" }.

import { isProxy } from "node:util/types";
import type { NormalizedJson } from "./prime-sandbox-model-normalize.js";
import { normalize } from "./prime-sandbox-model-normalize.js";
import { normalizeToolSchema } from "./prime-sandbox-model-typebox.js";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

const _apply: typeof Reflect.apply = Reflect.apply;
const _create: typeof Object.create = Object.create;
const _defineProperty: typeof Object.defineProperty = Object.defineProperty;
const _freeze: typeof Object.freeze = Object.freeze;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _isArray: typeof Array.isArray = Array.isArray;
const _isFinite: typeof Number.isFinite = Number.isFinite;
const _isInteger: typeof Number.isInteger = Number.isInteger;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _parseJson: typeof JSON.parse = JSON.parse;
const _stringifyJson: typeof JSON.stringify = JSON.stringify;
const _objectIs: typeof Object.is = Object.is;
const _numberValue: NumberConstructor = Number;
const _stringValue: StringConstructor = String;
const _fromCharCode: typeof String.fromCharCode = String.fromCharCode;
const _charCodeAt: typeof String.prototype.charCodeAt = String.prototype.charCodeAt;
const _sliceText: typeof String.prototype.slice = String.prototype.slice;
const _regexTest: typeof RegExp.prototype.test = RegExp.prototype.test;
const _TextEncoder: typeof TextEncoder = TextEncoder;
const _TextDecoder: typeof TextDecoder = TextDecoder;
const _Array: ArrayConstructor = Array;
const _WeakMap: WeakMapConstructor = WeakMap;
const _Set: SetConstructor = Set;
const _textEncode: typeof TextEncoder.prototype.encode = TextEncoder.prototype.encode;
const _textDecode: typeof TextDecoder.prototype.decode = TextDecoder.prototype.decode;
const _weakHas: typeof WeakMap.prototype.has = WeakMap.prototype.has;
const _weakSet: typeof WeakMap.prototype.set = WeakMap.prototype.set;
const _setHas: typeof Set.prototype.has = Set.prototype.has;
const _setAdd: typeof Set.prototype.add = Set.prototype.add;
const _objectPrototype: object = Object.prototype;
const _arrayPrototype: object = Array.prototype;

const MAX_BYTES = 262128;
const MAX_SHORT_STRING_BYTES = 4096;
const MAX_TEXT_BYTES = 65536;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 256;
const MAX_RAW_DEPTH = 32;

interface TextContentWire {
	readonly type: "text";
	readonly text: string;
	readonly textSignature: string | null;
}

interface ThinkingContentWire {
	readonly type: "thinking";
	readonly thinking: string;
	readonly thinkingSignature: string | null;
	readonly redacted: boolean | null;
}

interface ToolCallWire {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: { readonly [key: string]: NormalizedJson };
	readonly thoughtSignature: string | null;
}

type AssistantContentWire = TextContentWire | ThinkingContentWire | ToolCallWire;

interface UsageCostWire {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

interface UsageWire {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: UsageCostWire;
}

interface UserMessageWire {
	readonly role: "user";
	readonly content: string | ReadonlyArray<TextContentWire>;
	readonly timestamp: number;
}

interface ToolResultMessageWire {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: ReadonlyArray<TextContentWire>;
	readonly details: NormalizedJson;
	readonly isError: boolean;
	readonly timestamp: number;
}

interface AssistantMessageWire {
	readonly role: "assistant";
	readonly content: ReadonlyArray<AssistantContentWire>;
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly responseModel: string | null;
	readonly responseId: string | null;
	readonly diagnostics: null;
	readonly usage: UsageWire;
	readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	readonly stopReasonRaw: string | null;
	readonly errorMessage: null;
	readonly timestamp: number;
}

type MessageWire = UserMessageWire | AssistantMessageWire | ToolResultMessageWire;

interface ToolWire {
	readonly name: string;
	readonly description: string;
	readonly parameters: { readonly [key: string]: NormalizedJson };
}

interface ContextWire {
	readonly systemPrompt: string | null;
	readonly messages: ReadonlyArray<MessageWire>;
	readonly tools: ReadonlyArray<ToolWire> | null;
}

interface ThinkingBudgetsWire {
	readonly minimal?: number;
	readonly low?: number;
	readonly medium?: number;
	readonly high?: number;
}

interface SafeOptionsWire {
	readonly cacheRetention: "none" | "short" | "long" | null;
	readonly maxTokens: number | null;
	readonly reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	readonly serviceTier: "auto" | "default" | "flex" | "scale" | "priority" | null;
	readonly sessionId: string | null;
	readonly temperature: number | null;
	readonly thinkingBudgets: ThinkingBudgetsWire | null;
}

interface CodecRequest {
	readonly context: ContextWire;
	readonly options: SafeOptionsWire;
}

interface CodecReplyOk {
	readonly ok: true;
	readonly message: AssistantMessageWire;
}

interface CodecReplyError {
	readonly ok: false;
	readonly code: "INTERNAL_ERROR";
}

type CodecReply = CodecReplyOk | CodecReplyError;

interface EncodeOk {
	readonly ok: true;
	readonly bytes: Uint8Array;
}
interface EncodeInputInvalid {
	readonly ok: false;
	readonly code: "INPUT_INVALID";
}
interface EncodeInputTooLarge {
	readonly ok: false;
	readonly code: "INPUT_TOO_LARGE";
}
interface EncodeFrameError {
	readonly ok: false;
	readonly code: "FRAME_ERROR";
}
export type EncodeResult = EncodeOk | EncodeInputInvalid | EncodeInputTooLarge | EncodeFrameError;

interface DecodeRequestOk {
	readonly ok: true;
	readonly request: CodecRequest;
}
interface DecodeInputInvalid {
	readonly ok: false;
	readonly code: "INPUT_INVALID";
}
interface DecodeInputTooLarge {
	readonly ok: false;
	readonly code: "INPUT_TOO_LARGE";
}
interface DecodeFrameError {
	readonly ok: false;
	readonly code: "FRAME_ERROR";
}
interface DecodeUtf8Error {
	readonly ok: false;
	readonly code: "UTF8_ERROR";
}
interface DecodeProtocolError {
	readonly ok: false;
	readonly code: "PROTOCOL_ERROR";
}
type DecodeRequestFailure =
	| DecodeInputInvalid
	| DecodeInputTooLarge
	| DecodeFrameError
	| DecodeUtf8Error
	| DecodeProtocolError;
export type DecodeRequestResult = DecodeRequestOk | DecodeRequestFailure;

interface DecodeReplyOk {
	readonly ok: true;
	readonly reply: CodecReply;
}
type DecodeReplyFailure = DecodeRequestFailure;
export type DecodeReplyResult = DecodeReplyOk | DecodeReplyFailure;

type DescriptorRecord = Record<string, PropertyDescriptor>;
type AllowedKey = (name: string) => boolean;

interface ValidationState {
	claim(value: object): boolean;
	stringOk(value: unknown, maxBytes: number): value is string;
	readonly objectPrototype: object;
	readonly arrayPrototype: object;
}

function makeValidationState(): ValidationState {
	const seen = new _WeakMap<object, true>();
	const encoder = new _TextEncoder();
	return {
		claim(value: object): boolean {
			try {
				if (_apply(_weakHas, seen, [value])) return false;
				_apply(_weakSet, seen, [value, true]);
				return true;
			} catch {
				return false;
			}
		},
		stringOk(value: unknown, maxBytes: number): value is string {
			if (typeof value !== "string") return false;
			if (hasUnpairedSurrogate(value)) return false;
			let encoded: Uint8Array | null = null;
			try {
				encoded = _apply(_textEncode, encoder, [value]);
				return encoded.length <= maxBytes;
			} catch {
				return false;
			} finally {
				if (encoded !== null) zeroBuffer(encoded);
			}
		},
		objectPrototype: _objectPrototype,
		arrayPrototype: _arrayPrototype,
	};
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = _apply(_charCodeAt, value, [i]);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code > 0xdbff) return true;
		if (i + 1 >= value.length) return true;
		const next = _apply(_charCodeAt, value, [i + 1]);
		if (next < 0xdc00 || next > 0xdfff) return true;
		i++;
	}
	return false;
}

function isObject(value: unknown): value is object {
	return value !== null && typeof value === "object";
}

function proxyOrIntrinsicFailure(value: object): boolean {
	try {
		return isProxy(value);
	} catch {
		return true;
	}
}

function captureDescriptors(value: object): DescriptorRecord | null {
	let raw: PropertyDescriptorMap;
	try {
		raw = _getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	const copy: DescriptorRecord = _create(null);
	let names: string[];
	try {
		names = _getOwnPropertyNames(raw);
	} catch {
		return null;
	}
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const descriptor = raw[name];
		if (descriptor === undefined) return null;
		try {
			_defineProperty(copy, name, {
				value: descriptor,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} catch {
			return null;
		}
	}
	return copy;
}

function hasOwnSymbols(value: object): boolean {
	try {
		return _getOwnPropertySymbols(value).length !== 0;
	} catch {
		return true;
	}
}

function prototypeIs(value: object, expected: object): boolean {
	try {
		return _getPrototypeOf(value) === expected;
	} catch {
		return false;
	}
}

function descriptorValue(descs: DescriptorRecord, key: string): unknown {
	const descriptor = descs[key];
	if (descriptor === undefined) return undefined;
	return descriptor.value;
}

function captureExactRecord(value: unknown, state: ValidationState, allowed: AllowedKey): DescriptorRecord | null {
	if (!isObject(value)) return null;
	if (!state.claim(value)) return null;
	if (proxyOrIntrinsicFailure(value) || _isArray(value)) return null;
	if (!prototypeIs(value, state.objectPrototype) || hasOwnSymbols(value)) return null;
	const descs = captureDescriptors(value);
	if (descs === null) return null;
	const names = _getOwnPropertyNames(descs);
	if (names.length > MAX_OBJECT_KEYS) return null;
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		if (!allowed(name)) return null;
		const descriptor = descs[name];
		if (descriptor === undefined) return null;
		if (!descriptor.enumerable) return null;
		if (typeof descriptor.get !== "undefined" || typeof descriptor.set !== "undefined") return null;
		if (typeof descriptor.value === "undefined") return null;
	}
	return descs;
}

function descriptorsAllowed(descs: DescriptorRecord, allowed: AllowedKey): boolean {
	const names = _getOwnPropertyNames(descs);
	for (let i = 0; i < names.length; i++) {
		if (!allowed(names[i])) return false;
	}
	return true;
}

interface CapturedArray {
	readonly descs: DescriptorRecord;
	readonly length: number;
}

function captureDenseArray(value: unknown, state: ValidationState): CapturedArray | null {
	if (!isObject(value)) return null;
	if (!state.claim(value)) return null;
	if (proxyOrIntrinsicFailure(value) || !_isArray(value)) return null;
	if (!prototypeIs(value, state.arrayPrototype) || hasOwnSymbols(value)) return null;
	const descs = captureDescriptors(value);
	if (descs === null) return null;
	const lengthDescriptor = descs.length;
	if (lengthDescriptor === undefined) return null;
	if (typeof lengthDescriptor.get !== "undefined" || typeof lengthDescriptor.set !== "undefined") return null;
	const lengthValue = lengthDescriptor.value;
	if (typeof lengthValue !== "number" || !_isInteger(lengthValue)) return null;
	if (lengthValue < 0 || lengthValue > MAX_ARRAY_LENGTH) return null;
	if (lengthDescriptor.enumerable || lengthDescriptor.configurable) return null;
	const names = _getOwnPropertyNames(descs);
	if (names.length !== lengthValue + 1) return null;
	for (let i = 0; i < lengthValue; i++) {
		const descriptor = descs[_stringValue(i)];
		if (descriptor === undefined || !descriptor.enumerable) return null;
		if (typeof descriptor.get !== "undefined" || typeof descriptor.set !== "undefined") return null;
		if (typeof descriptor.value === "undefined") return null;
	}
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		if (name === "length") continue;
		const index = _numberValue(name);
		if (!_isInteger(index) || index < 0 || index >= lengthValue || _stringValue(index) !== name) return null;
	}
	return { descs, length: lengthValue };
}

function put(target: Record<string, unknown>, key: string, value: unknown): boolean {
	try {
		_defineProperty(target, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		return true;
	} catch {
		return false;
	}
}

function isFiniteNonnegative(value: unknown): value is number {
	return typeof value === "number" && _isFinite(value) && value >= 0 && !_objectIs(value, -0);
}

function isNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && _isSafeInteger(value) && value >= 0 && !_objectIs(value, -0);
}

function jsonPrimitive(value: unknown, state: ValidationState): boolean {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return _isFinite(value) && !_objectIs(value, -0);
	return state.stringOk(value, MAX_TEXT_BYTES);
}

function captureGenericRecord(value: unknown, state: ValidationState): DescriptorRecord | null {
	if (!isObject(value)) return null;
	if (!state.claim(value)) return null;
	if (proxyOrIntrinsicFailure(value) || _isArray(value)) return null;
	if (!prototypeIs(value, state.objectPrototype) || hasOwnSymbols(value)) return null;
	const descs = captureDescriptors(value);
	if (descs === null) return null;
	const names = _getOwnPropertyNames(descs);
	if (names.length > MAX_OBJECT_KEYS) return null;
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		if (name === "toJSON") return null;
		if (!state.stringOk(name, 512)) return null;
		const descriptor = descs[name];
		if (descriptor === undefined || !descriptor.enumerable) return null;
		if (typeof descriptor.get !== "undefined" || typeof descriptor.set !== "undefined") return null;
		if (typeof descriptor.value === "undefined") return null;
	}
	return descs;
}

function rebuildJson(value: unknown, state: ValidationState, depth: number): unknown | null {
	if (depth >= MAX_RAW_DEPTH) return null;
	if (jsonPrimitive(value, state)) return value;
	if (!isObject(value) || proxyOrIntrinsicFailure(value)) return null;
	if (_isArray(value)) {
		const captured = captureDenseArray(value, state);
		if (captured === null) return null;
		const out: unknown[] = new _Array(captured.length);
		for (let i = 0; i < captured.length; i++) {
			const rebuilt = rebuildJson(descriptorValue(captured.descs, _stringValue(i)), state, depth + 1);
			if (rebuilt === null && descriptorValue(captured.descs, _stringValue(i)) !== null) return null;
			out[i] = rebuilt;
		}
		return out;
	}
	const descs = captureGenericRecord(value, state);
	if (descs === null) return null;
	const out: Record<string, unknown> = {};
	const names = _getOwnPropertyNames(descs);
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const raw = descriptorValue(descs, name);
		const rebuilt = rebuildJson(raw, state, depth + 1);
		if (rebuilt === null && raw !== null) return null;
		if (!put(out, name, rebuilt)) return null;
	}
	return out;
}

function trackSchemaGraph(value: unknown, state: ValidationState, depth: number): boolean {
	if (depth >= MAX_RAW_DEPTH) return false;
	if (!isObject(value)) return jsonPrimitive(value, state);
	if (!state.claim(value)) return false;
	if (proxyOrIntrinsicFailure(value) || hasOwnSymbols(value)) return false;
	const expected = _isArray(value) ? state.arrayPrototype : state.objectPrototype;
	if (!prototypeIs(value, expected)) return false;
	const descs = captureDescriptors(value);
	if (descs === null) return false;
	const names = _getOwnPropertyNames(descs);
	if (names.length > MAX_OBJECT_KEYS + 1) return false;
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const descriptor = descs[name];
		if (descriptor === undefined) return false;
		if (typeof descriptor.get !== "undefined" || typeof descriptor.set !== "undefined") return false;
		if (typeof descriptor.value === "undefined") return false;
		if (name !== "length" && !trackSchemaGraph(descriptor.value, state, depth + 1)) return false;
	}
	return true;
}

function contextKey(name: string): boolean {
	return name === "systemPrompt" || name === "messages" || name === "tools";
}
function optionKey(name: string): boolean {
	return (
		name === "cacheRetention" ||
		name === "maxTokens" ||
		name === "reasoning" ||
		name === "serviceTier" ||
		name === "sessionId" ||
		name === "temperature" ||
		name === "thinkingBudgets"
	);
}
function userMessageKey(name: string): boolean {
	return name === "role" || name === "content" || name === "timestamp";
}
function assistantMessageKey(name: string): boolean {
	return (
		name === "role" ||
		name === "content" ||
		name === "api" ||
		name === "provider" ||
		name === "model" ||
		name === "responseModel" ||
		name === "responseId" ||
		name === "diagnostics" ||
		name === "usage" ||
		name === "stopReason" ||
		name === "stopReasonRaw" ||
		name === "errorMessage" ||
		name === "timestamp"
	);
}
function toolResultMessageKey(name: string): boolean {
	return (
		name === "role" ||
		name === "toolCallId" ||
		name === "toolName" ||
		name === "content" ||
		name === "details" ||
		name === "isError" ||
		name === "timestamp"
	);
}
function textContentKey(name: string): boolean {
	return name === "type" || name === "text" || name === "textSignature";
}
function thinkingContentKey(name: string): boolean {
	return name === "type" || name === "thinking" || name === "thinkingSignature" || name === "redacted";
}
function toolCallKey(name: string): boolean {
	return name === "type" || name === "id" || name === "name" || name === "arguments" || name === "thoughtSignature";
}
function usageKey(name: string): boolean {
	return (
		name === "input" ||
		name === "output" ||
		name === "cacheRead" ||
		name === "cacheWrite" ||
		name === "totalTokens" ||
		name === "cost"
	);
}
function costKey(name: string): boolean {
	return name === "input" || name === "output" || name === "cacheRead" || name === "cacheWrite" || name === "total";
}
function diagnosticKey(name: string): boolean {
	return name === "type" || name === "timestamp" || name === "error" || name === "details";
}
function diagnosticErrorKey(name: string): boolean {
	return name === "name" || name === "message" || name === "stack" || name === "code";
}
function toolKey(name: string): boolean {
	return name === "name" || name === "description" || name === "parameters";
}
function thinkingBudgetKey(name: string): boolean {
	return name === "minimal" || name === "low" || name === "medium" || name === "high";
}
function requestRootKey(name: string): boolean {
	return name === "context" || name === "options";
}
function replyRootKey(name: string): boolean {
	return name === "ok" || name === "message" || name === "code";
}
function failureInputKey(name: string): boolean {
	return name === "ok" || name === "code";
}
function messageKey(name: string): boolean {
	return userMessageKey(name) || assistantMessageKey(name) || toolResultMessageKey(name);
}
function contentKey(name: string): boolean {
	return textContentKey(name) || thinkingContentKey(name) || toolCallKey(name);
}
function replyEncodeInputKey(name: string): boolean {
	return failureInputKey(name) || assistantMessageKey(name);
}

function optionalString(
	descs: DescriptorRecord,
	key: string,
	state: ValidationState,
	maxBytes: number,
): string | null | undefined {
	const value = descriptorValue(descs, key);
	if (value === undefined) return null;
	if (value === null) return null;
	if (!state.stringOk(value, maxBytes)) return undefined;
	return value;
}

function rebuildTextContent(descs: DescriptorRecord, state: ValidationState): Record<string, unknown> | null {
	if (!descriptorsAllowed(descs, textContentKey) || descriptorValue(descs, "type") !== "text") return null;
	const text = descriptorValue(descs, "text");
	if (!state.stringOk(text, MAX_TEXT_BYTES)) return null;
	const signature = optionalString(descs, "textSignature", state, MAX_TEXT_BYTES);
	if (signature === undefined) return null;
	return { type: "text", text, textSignature: signature };
}

function rebuildThinkingContent(descs: DescriptorRecord, state: ValidationState): Record<string, unknown> | null {
	if (!descriptorsAllowed(descs, thinkingContentKey) || descriptorValue(descs, "type") !== "thinking") return null;
	const thinking = descriptorValue(descs, "thinking");
	if (!state.stringOk(thinking, MAX_TEXT_BYTES)) return null;
	const signature = optionalString(descs, "thinkingSignature", state, MAX_TEXT_BYTES);
	if (signature === undefined) return null;
	const redactedRaw = descriptorValue(descs, "redacted");
	if (redactedRaw !== undefined && redactedRaw !== null && typeof redactedRaw !== "boolean") return null;
	return {
		type: "thinking",
		thinking,
		thinkingSignature: signature,
		redacted: redactedRaw === undefined ? null : redactedRaw,
	};
}

function rebuildToolCall(descs: DescriptorRecord, state: ValidationState): Record<string, unknown> | null {
	if (!descriptorsAllowed(descs, toolCallKey) || descriptorValue(descs, "type") !== "toolCall") return null;
	const id = descriptorValue(descs, "id");
	const name = descriptorValue(descs, "name");
	if (!state.stringOk(id, MAX_SHORT_STRING_BYTES) || !state.stringOk(name, MAX_SHORT_STRING_BYTES)) return null;
	const argumentsRaw = descriptorValue(descs, "arguments");
	if (!isObject(argumentsRaw) || proxyOrIntrinsicFailure(argumentsRaw) || _isArray(argumentsRaw)) return null;
	const args = rebuildJson(argumentsRaw, state, 0);
	if (!isObject(args) || _isArray(args)) return null;
	const thoughtSignature = optionalString(descs, "thoughtSignature", state, MAX_TEXT_BYTES);
	if (thoughtSignature === undefined) return null;
	return { type: "toolCall", id, name, arguments: args, thoughtSignature };
}

function rebuildContentArray(value: unknown, state: ValidationState, mode: "text" | "assistant"): unknown[] | null {
	const captured = captureDenseArray(value, state);
	if (captured === null) return null;
	const out: unknown[] = new _Array(captured.length);
	for (let i = 0; i < captured.length; i++) {
		const descs = captureExactRecord(descriptorValue(captured.descs, _stringValue(i)), state, contentKey);
		if (descs === null) return null;
		const type = descriptorValue(descs, "type");
		let rebuilt: Record<string, unknown> | null = null;
		if (type === "text") rebuilt = rebuildTextContent(descs, state);
		else if (mode === "assistant" && type === "thinking") rebuilt = rebuildThinkingContent(descs, state);
		else if (mode === "assistant" && type === "toolCall") rebuilt = rebuildToolCall(descs, state);
		if (rebuilt === null) return null;
		out[i] = rebuilt;
	}
	return out;
}

function rebuildCost(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, costKey);
	if (descs === null) return null;
	const input = descriptorValue(descs, "input");
	const output = descriptorValue(descs, "output");
	const cacheRead = descriptorValue(descs, "cacheRead");
	const cacheWrite = descriptorValue(descs, "cacheWrite");
	const total = descriptorValue(descs, "total");
	if (
		!isFiniteNonnegative(input) ||
		!isFiniteNonnegative(output) ||
		!isFiniteNonnegative(cacheRead) ||
		!isFiniteNonnegative(cacheWrite) ||
		!isFiniteNonnegative(total)
	)
		return null;
	return { input, output, cacheRead, cacheWrite, total };
}

function rebuildUsage(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, usageKey);
	if (descs === null) return null;
	const input = descriptorValue(descs, "input");
	const output = descriptorValue(descs, "output");
	const cacheRead = descriptorValue(descs, "cacheRead");
	const cacheWrite = descriptorValue(descs, "cacheWrite");
	const totalTokens = descriptorValue(descs, "totalTokens");
	if (
		!isNonnegativeInteger(input) ||
		!isNonnegativeInteger(output) ||
		!isNonnegativeInteger(cacheRead) ||
		!isNonnegativeInteger(cacheWrite) ||
		!isNonnegativeInteger(totalTokens)
	)
		return null;
	const cost = rebuildCost(descriptorValue(descs, "cost"), state);
	if (cost === null) return null;
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function validateDiagnosticError(value: unknown, state: ValidationState): boolean {
	const descs = captureExactRecord(value, state, diagnosticErrorKey);
	if (descs === null) return false;
	const message = descriptorValue(descs, "message");
	if (!state.stringOk(message, MAX_TEXT_BYTES)) return false;
	const name = optionalString(descs, "name", state, MAX_SHORT_STRING_BYTES);
	const stack = optionalString(descs, "stack", state, MAX_TEXT_BYTES);
	if (name === undefined || stack === undefined) return false;
	const code = descriptorValue(descs, "code");
	if (code === undefined || code === null) return true;
	if (state.stringOk(code, MAX_SHORT_STRING_BYTES)) return true;
	return typeof code === "number" && _isFinite(code) && !_objectIs(code, -0);
}

function validateDiagnostics(value: unknown, state: ValidationState): boolean {
	const captured = captureDenseArray(value, state);
	if (captured === null) return false;
	for (let i = 0; i < captured.length; i++) {
		const descs = captureExactRecord(descriptorValue(captured.descs, _stringValue(i)), state, diagnosticKey);
		if (descs === null) return false;
		const type = descriptorValue(descs, "type");
		const timestamp = descriptorValue(descs, "timestamp");
		if (!state.stringOk(type, MAX_SHORT_STRING_BYTES) || !isNonnegativeInteger(timestamp)) return false;
		const error = descriptorValue(descs, "error");
		if (error !== undefined && error !== null && !validateDiagnosticError(error, state)) return false;
		const details = descriptorValue(descs, "details");
		if (details !== undefined && details !== null) {
			if (!isObject(details) || proxyOrIntrinsicFailure(details) || _isArray(details)) return false;
			const rebuilt = rebuildJson(details, state, 0);
			if (!isObject(rebuilt) || _isArray(rebuilt)) return false;
		}
	}
	return true;
}

function rebuildAssistantFromDescs(descs: DescriptorRecord, state: ValidationState): Record<string, unknown> | null {
	if (descriptorValue(descs, "role") !== "assistant") return null;
	const content = rebuildContentArray(descriptorValue(descs, "content"), state, "assistant");
	if (content === null) return null;
	const api = descriptorValue(descs, "api");
	const provider = descriptorValue(descs, "provider");
	const model = descriptorValue(descs, "model");
	if (
		!state.stringOk(api, MAX_SHORT_STRING_BYTES) ||
		!state.stringOk(provider, MAX_SHORT_STRING_BYTES) ||
		!state.stringOk(model, MAX_SHORT_STRING_BYTES)
	)
		return null;
	const responseModel = optionalString(descs, "responseModel", state, MAX_SHORT_STRING_BYTES);
	const responseId = optionalString(descs, "responseId", state, MAX_SHORT_STRING_BYTES);
	const stopReasonRaw = optionalString(descs, "stopReasonRaw", state, MAX_SHORT_STRING_BYTES);
	const errorMessage = optionalString(descs, "errorMessage", state, MAX_TEXT_BYTES);
	if (
		responseModel === undefined ||
		responseId === undefined ||
		stopReasonRaw === undefined ||
		errorMessage === undefined
	)
		return null;
	const stopReason = descriptorValue(descs, "stopReason");
	if (
		stopReason !== "stop" &&
		stopReason !== "length" &&
		stopReason !== "toolUse" &&
		stopReason !== "error" &&
		stopReason !== "aborted"
	)
		return null;
	const timestamp = descriptorValue(descs, "timestamp");
	if (!isNonnegativeInteger(timestamp)) return null;
	const usage = rebuildUsage(descriptorValue(descs, "usage"), state);
	if (usage === null) return null;
	const diagnosticsRaw = descriptorValue(descs, "diagnostics");
	if (diagnosticsRaw !== undefined && diagnosticsRaw !== null && !validateDiagnostics(diagnosticsRaw, state))
		return null;
	return {
		role: "assistant",
		content,
		api,
		provider,
		model,
		responseModel,
		responseId,
		diagnostics: null,
		usage,
		stopReason,
		stopReasonRaw,
		errorMessage: null,
		timestamp,
	};
}

function rebuildMessage(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, messageKey);
	if (descs === null) return null;
	const role = descriptorValue(descs, "role");
	if (role === "user") {
		if (!descriptorsAllowed(descs, userMessageKey)) return null;
		const contentRaw = descriptorValue(descs, "content");
		let content: unknown;
		if (state.stringOk(contentRaw, MAX_TEXT_BYTES)) content = contentRaw;
		else {
			content = rebuildContentArray(contentRaw, state, "text");
			if (content === null) return null;
		}
		const timestamp = descriptorValue(descs, "timestamp");
		if (!isNonnegativeInteger(timestamp)) return null;
		return { role: "user", content, timestamp };
	}
	if (role === "assistant") {
		if (!descriptorsAllowed(descs, assistantMessageKey)) return null;
		return rebuildAssistantFromDescs(descs, state);
	}
	if (role === "toolResult") {
		if (!descriptorsAllowed(descs, toolResultMessageKey)) return null;
		const toolCallId = descriptorValue(descs, "toolCallId");
		const toolName = descriptorValue(descs, "toolName");
		if (!state.stringOk(toolCallId, MAX_SHORT_STRING_BYTES) || !state.stringOk(toolName, MAX_SHORT_STRING_BYTES))
			return null;
		const content = rebuildContentArray(descriptorValue(descs, "content"), state, "text");
		if (content === null) return null;
		const isError = descriptorValue(descs, "isError");
		if (typeof isError !== "boolean") return null;
		const timestamp = descriptorValue(descs, "timestamp");
		if (!isNonnegativeInteger(timestamp)) return null;
		const detailsRaw = descriptorValue(descs, "details");
		let details: unknown = null;
		if (detailsRaw !== undefined && detailsRaw !== null) {
			details = rebuildJson(detailsRaw, state, 0);
			if (details === null && detailsRaw !== null) return null;
		}
		return { role: "toolResult", toolCallId, toolName, content, details, isError, timestamp };
	}
	return null;
}

function rebuildTool(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, toolKey);
	if (descs === null) return null;
	const name = descriptorValue(descs, "name");
	const description = descriptorValue(descs, "description");
	if (!state.stringOk(name, MAX_SHORT_STRING_BYTES) || !state.stringOk(description, MAX_TEXT_BYTES)) return null;
	const parametersRaw = descriptorValue(descs, "parameters");
	if (!trackSchemaGraph(parametersRaw, state, 0)) return null;
	const schema = normalizeToolSchema(parametersRaw);
	if (!schema.ok) return null;
	return { name, description, parameters: schema.value };
}

function rebuildContext(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, contextKey);
	if (descs === null) return null;
	const messagesRaw = descriptorValue(descs, "messages");
	const messagesCaptured = captureDenseArray(messagesRaw, state);
	if (messagesCaptured === null) return null;
	const messages: unknown[] = new _Array(messagesCaptured.length);
	for (let i = 0; i < messagesCaptured.length; i++) {
		const message = rebuildMessage(descriptorValue(messagesCaptured.descs, _stringValue(i)), state);
		if (message === null) return null;
		messages[i] = message;
	}
	const systemPrompt = optionalString(descs, "systemPrompt", state, MAX_TEXT_BYTES);
	if (systemPrompt === undefined) return null;
	const toolsRaw = descriptorValue(descs, "tools");
	let tools: unknown = null;
	if (toolsRaw !== undefined && toolsRaw !== null) {
		const toolsCaptured = captureDenseArray(toolsRaw, state);
		if (toolsCaptured === null) return null;
		const rebuilt: unknown[] = new _Array(toolsCaptured.length);
		for (let i = 0; i < toolsCaptured.length; i++) {
			const tool = rebuildTool(descriptorValue(toolsCaptured.descs, _stringValue(i)), state);
			if (tool === null) return null;
			rebuilt[i] = tool;
		}
		tools = rebuilt;
	}
	return { systemPrompt, messages, tools };
}

function rebuildThinkingBudgets(value: unknown, state: ValidationState): Record<string, unknown> | null {
	const descs = captureExactRecord(value, state, thinkingBudgetKey);
	if (descs === null) return null;
	const out: Record<string, unknown> = {};
	const names = _getOwnPropertyNames(descs);
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const amount = descriptorValue(descs, name);
		if (!isNonnegativeInteger(amount) || !put(out, name, amount)) return null;
	}
	return out;
}

function rebuildOptions(value: unknown, state: ValidationState): Record<string, unknown> | null {
	if (value === null) {
		return {
			cacheRetention: null,
			maxTokens: null,
			reasoning: null,
			serviceTier: null,
			sessionId: null,
			temperature: null,
			thinkingBudgets: null,
		};
	}
	const descs = captureExactRecord(value, state, optionKey);
	if (descs === null) return null;
	const cacheRetention = descriptorValue(descs, "cacheRetention");
	if (
		cacheRetention !== undefined &&
		cacheRetention !== null &&
		cacheRetention !== "none" &&
		cacheRetention !== "short" &&
		cacheRetention !== "long"
	)
		return null;
	const maxTokens = descriptorValue(descs, "maxTokens");
	if (maxTokens !== undefined && maxTokens !== null && (!isNonnegativeInteger(maxTokens) || maxTokens === 0))
		return null;
	const reasoning = descriptorValue(descs, "reasoning");
	if (
		reasoning !== undefined &&
		reasoning !== null &&
		reasoning !== "off" &&
		reasoning !== "minimal" &&
		reasoning !== "low" &&
		reasoning !== "medium" &&
		reasoning !== "high" &&
		reasoning !== "xhigh" &&
		reasoning !== "max"
	)
		return null;
	const serviceTier = descriptorValue(descs, "serviceTier");
	if (
		serviceTier !== undefined &&
		serviceTier !== null &&
		serviceTier !== "auto" &&
		serviceTier !== "default" &&
		serviceTier !== "flex" &&
		serviceTier !== "scale" &&
		serviceTier !== "priority"
	)
		return null;
	const sessionId = optionalString(descs, "sessionId", state, MAX_SHORT_STRING_BYTES);
	if (sessionId === undefined) return null;
	const temperature = descriptorValue(descs, "temperature");
	if (
		temperature !== undefined &&
		temperature !== null &&
		(typeof temperature !== "number" ||
			!_isFinite(temperature) ||
			_objectIs(temperature, -0) ||
			temperature < 0 ||
			temperature > 2)
	)
		return null;
	const budgetsRaw = descriptorValue(descs, "thinkingBudgets");
	let thinkingBudgets: unknown = null;
	if (budgetsRaw !== undefined && budgetsRaw !== null) {
		thinkingBudgets = rebuildThinkingBudgets(budgetsRaw, state);
		if (thinkingBudgets === null) return null;
	}
	return {
		cacheRetention: cacheRetention === undefined ? null : cacheRetention,
		maxTokens: maxTokens === undefined ? null : maxTokens,
		reasoning: reasoning === undefined ? null : reasoning,
		serviceTier: serviceTier === undefined ? null : serviceTier,
		sessionId,
		temperature: temperature === undefined ? null : temperature,
		thinkingBudgets,
	};
}

function safeStringify(value: unknown): string | null {
	try {
		const result = _stringifyJson(value);
		return typeof result === "string" ? result : null;
	} catch {
		return null;
	}
}

interface ParseOk {
	readonly ok: true;
	readonly value: unknown;
}
interface ParseFail {
	readonly ok: false;
}
type ParseResult = ParseOk | ParseFail;

function safeParse(text: string): ParseResult {
	try {
		return { ok: true, value: _parseJson(text) };
	} catch {
		return { ok: false };
	}
}

function encodeUtf8(value: string): Uint8Array | null {
	try {
		return _apply(_textEncode, new _TextEncoder(), [value]);
	} catch {
		return null;
	}
}

function decodeUtf8(value: Uint8Array): string | null {
	try {
		return _apply(_textDecode, new _TextDecoder("utf-8", { fatal: true }), [value]);
	} catch {
		return null;
	}
}

function zeroBuffer(buffer: Uint8Array): void {
	for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
}

function encodeComplete(value: unknown): EncodeResult {
	const normalized = normalize(value);
	if (!normalized.ok) return _freeze({ ok: false, code: "FRAME_ERROR" });
	const json = safeStringify(normalized.value);
	if (json === null) return _freeze({ ok: false, code: "FRAME_ERROR" });
	const bytes = encodeUtf8(json);
	if (bytes === null) return _freeze({ ok: false, code: "FRAME_ERROR" });
	if (bytes.length > MAX_BYTES) {
		zeroBuffer(bytes);
		return _freeze({ ok: false, code: "INPUT_TOO_LARGE" });
	}
	return _freeze({ ok: true, bytes });
}

interface StringScan {
	readonly end: number;
	readonly value: string | null;
}

function hexValue(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	return -1;
}

function scanJsonString(text: string, start: number, keepValue: boolean): StringScan | null {
	if (_apply(_charCodeAt, text, [start]) !== 0x22) return null;
	let value: string | null = keepValue ? "" : null;
	let i = start + 1;
	while (i < text.length) {
		const code = _apply(_charCodeAt, text, [i]);
		if (code === 0x22) return { end: i + 1, value };
		if (code < 0x20) return null;
		let decoded: string | null = null;
		if (code !== 0x5c) {
			if (keepValue) decoded = text[i];
			i++;
		} else {
			i++;
			if (i >= text.length) return null;
			const escaped = _apply(_charCodeAt, text, [i]);
			if (escaped === 0x22 || escaped === 0x5c || escaped === 0x2f) decoded = _fromCharCode(escaped);
			else if (escaped === 0x62) decoded = "\b";
			else if (escaped === 0x66) decoded = "\f";
			else if (escaped === 0x6e) decoded = "\n";
			else if (escaped === 0x72) decoded = "\r";
			else if (escaped === 0x74) decoded = "\t";
			else if (escaped === 0x75) {
				if (i + 4 >= text.length) return null;
				let codeUnit = 0;
				for (let j = 1; j <= 4; j++) {
					const hex = hexValue(_apply(_charCodeAt, text, [i + j]));
					if (hex < 0) return null;
					codeUnit = codeUnit * 16 + hex;
				}
				decoded = _fromCharCode(codeUnit);
				i += 4;
			} else return null;
			i++;
		}
		if (keepValue) {
			if (value === null || decoded === null || value.length >= 512) return null;
			value += decoded;
		}
	}
	return null;
}

type ObjectState = "firstKey" | "key" | "colon" | "value" | "commaOrEnd";
type ArrayState = "firstValue" | "value" | "commaOrEnd";
interface ObjectFrame {
	readonly kind: "object";
	state: ObjectState;
	readonly keys: Set<string>;
}
interface ArrayFrame {
	readonly kind: "array";
	state: ArrayState;
}
interface RootFrame {
	readonly kind: "root";
	state: "value" | "done";
}
type ScanFrame = ObjectFrame | ArrayFrame | RootFrame;
type DuplicateScanResult = "ok" | "duplicate" | "invalid" | "limit";

function whitespace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function valueEndsAt(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const code = _apply(_charCodeAt, text, [i]);
		if (whitespace(code) || code === 0x2c || code === 0x5d || code === 0x7d) break;
		i++;
	}
	return i;
}

function validPrimitiveToken(token: string): boolean {
	if (token === "true" || token === "false" || token === "null") return true;
	return _apply(_regexTest, /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/, [token]);
}

function finishParentValue(frame: ScanFrame): void {
	if (frame.kind === "root") frame.state = "done";
	else frame.state = "commaOrEnd";
}

function scanDuplicateObjectKeys(text: string): DuplicateScanResult {
	const stack: ScanFrame[] = [{ kind: "root", state: "value" }];
	let i = 0;
	while (stack.length > 0) {
		while (i < text.length && whitespace(_apply(_charCodeAt, text, [i]))) i++;
		const frame = stack[stack.length - 1];
		if (frame === undefined) return "invalid";
		if (frame.kind === "root" && frame.state === "done") {
			return i === text.length ? "ok" : "invalid";
		}
		if (i >= text.length) return "invalid";
		const code = _apply(_charCodeAt, text, [i]);
		if (frame.kind === "object") {
			if (frame.state === "firstKey" && code === 0x7d) {
				stack.length--;
				i++;
				continue;
			}
			if (frame.state === "firstKey" || frame.state === "key") {
				const scanned = scanJsonString(text, i, true);
				if (scanned === null || scanned.value === null) return "invalid";
				try {
					if (_apply(_setHas, frame.keys, [scanned.value])) return "duplicate";
					_apply(_setAdd, frame.keys, [scanned.value]);
				} catch {
					return "invalid";
				}
				frame.state = "colon";
				i = scanned.end;
				continue;
			}
			if (frame.state === "colon") {
				if (code !== 0x3a) return "invalid";
				frame.state = "value";
				i++;
				continue;
			}
			if (frame.state === "commaOrEnd") {
				if (code === 0x2c) {
					frame.state = "key";
					i++;
					continue;
				}
				if (code === 0x7d) {
					stack.length--;
					i++;
					continue;
				}
				return "invalid";
			}
		}
		if (frame.kind === "array") {
			if (frame.state === "firstValue" && code === 0x5d) {
				stack.length--;
				i++;
				continue;
			}
			if (frame.state === "commaOrEnd") {
				if (code === 0x2c) {
					frame.state = "value";
					i++;
					continue;
				}
				if (code === 0x5d) {
					stack.length--;
					i++;
					continue;
				}
				return "invalid";
			}
		}
		if (
			(frame.kind === "root" && frame.state === "value") ||
			(frame.kind === "object" && frame.state === "value") ||
			(frame.kind === "array" && (frame.state === "firstValue" || frame.state === "value"))
		) {
			finishParentValue(frame);
			if (code === 0x7b) {
				if (stack.length >= MAX_RAW_DEPTH) return "limit";
				stack[stack.length] = { kind: "object", state: "firstKey", keys: new _Set<string>() };
				i++;
				continue;
			}
			if (code === 0x5b) {
				if (stack.length >= MAX_RAW_DEPTH) return "limit";
				stack[stack.length] = { kind: "array", state: "firstValue" };
				i++;
				continue;
			}
			if (code === 0x22) {
				const scanned = scanJsonString(text, i, false);
				if (scanned === null) return "invalid";
				i = scanned.end;
				continue;
			}
			const end = valueEndsAt(text, i);
			if (end - i > 128) return "limit";
			if (end === i || !validPrimitiveToken(_apply(_sliceText, text, [i, end]))) return "invalid";
			i = end;
			continue;
		}
		return "invalid";
	}
	return "invalid";
}

function safeDuplicateScan(text: string): DuplicateScanResult {
	try {
		return scanDuplicateObjectKeys(text);
	} catch {
		return "invalid";
	}
}

function canonicalBytes(value: NormalizedJson, original: Uint8Array): boolean {
	const json = safeStringify(value);
	if (json === null) return false;
	const bytes = encodeUtf8(json);
	if (bytes === null) return false;
	try {
		if (bytes.length !== original.length) return false;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] !== original[i]) return false;
		}
		return true;
	} finally {
		zeroBuffer(bytes);
	}
}

function normalizedRecord(value: unknown): value is { readonly [key: string]: NormalizedJson } {
	return value !== null && typeof value === "object" && !_isArray(value);
}
function normalizedArray(value: unknown): value is ReadonlyArray<NormalizedJson> {
	return _isArray(value);
}
function normalizedStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
function isNormalizedJson(value: unknown): value is NormalizedJson {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return true;
	return normalizedArray(value) || normalizedRecord(value);
}

function normalizedDescs(value: unknown): DescriptorRecord | null {
	if (!normalizedRecord(value)) return null;
	return captureDescriptors(value);
}

function isTextWire(value: unknown): value is TextContentWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 3) return false;
	return (
		descriptorValue(descs, "type") === "text" &&
		typeof descriptorValue(descs, "text") === "string" &&
		normalizedStringOrNull(descriptorValue(descs, "textSignature"))
	);
}

function isThinkingWire(value: unknown): value is ThinkingContentWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 4) return false;
	const redacted = descriptorValue(descs, "redacted");
	return (
		descriptorValue(descs, "type") === "thinking" &&
		typeof descriptorValue(descs, "thinking") === "string" &&
		normalizedStringOrNull(descriptorValue(descs, "thinkingSignature")) &&
		(redacted === null || typeof redacted === "boolean")
	);
}

function isToolCallWire(value: unknown): value is ToolCallWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 5) return false;
	return (
		descriptorValue(descs, "type") === "toolCall" &&
		typeof descriptorValue(descs, "id") === "string" &&
		typeof descriptorValue(descs, "name") === "string" &&
		normalizedRecord(descriptorValue(descs, "arguments")) &&
		normalizedStringOrNull(descriptorValue(descs, "thoughtSignature"))
	);
}

function isAssistantContentWire(value: unknown): value is AssistantContentWire {
	return isTextWire(value) || isThinkingWire(value) || isToolCallWire(value);
}

function isTextWireArray(value: unknown): value is ReadonlyArray<TextContentWire> {
	if (!normalizedArray(value)) return false;
	for (let i = 0; i < value.length; i++) {
		if (!isTextWire(value[i])) return false;
	}
	return true;
}

function isAssistantContentWireArray(value: unknown): value is ReadonlyArray<AssistantContentWire> {
	if (!normalizedArray(value)) return false;
	for (let i = 0; i < value.length; i++) {
		if (!isAssistantContentWire(value[i])) return false;
	}
	return true;
}

function isUsageCostWire(value: unknown): value is UsageCostWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 5) return false;
	return (
		typeof descriptorValue(descs, "input") === "number" &&
		typeof descriptorValue(descs, "output") === "number" &&
		typeof descriptorValue(descs, "cacheRead") === "number" &&
		typeof descriptorValue(descs, "cacheWrite") === "number" &&
		typeof descriptorValue(descs, "total") === "number"
	);
}

function isUsageWire(value: unknown): value is UsageWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 6) return false;
	return (
		typeof descriptorValue(descs, "input") === "number" &&
		typeof descriptorValue(descs, "output") === "number" &&
		typeof descriptorValue(descs, "cacheRead") === "number" &&
		typeof descriptorValue(descs, "cacheWrite") === "number" &&
		typeof descriptorValue(descs, "totalTokens") === "number" &&
		isUsageCostWire(descriptorValue(descs, "cost"))
	);
}

function isAssistantMessageWire(value: unknown): value is AssistantMessageWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 13) return false;
	const diagnostics = descriptorValue(descs, "diagnostics");
	const stopReason = descriptorValue(descs, "stopReason");
	return (
		descriptorValue(descs, "role") === "assistant" &&
		isAssistantContentWireArray(descriptorValue(descs, "content")) &&
		typeof descriptorValue(descs, "api") === "string" &&
		typeof descriptorValue(descs, "provider") === "string" &&
		typeof descriptorValue(descs, "model") === "string" &&
		normalizedStringOrNull(descriptorValue(descs, "responseModel")) &&
		normalizedStringOrNull(descriptorValue(descs, "responseId")) &&
		diagnostics === null &&
		isUsageWire(descriptorValue(descs, "usage")) &&
		(stopReason === "stop" ||
			stopReason === "length" ||
			stopReason === "toolUse" ||
			stopReason === "error" ||
			stopReason === "aborted") &&
		normalizedStringOrNull(descriptorValue(descs, "stopReasonRaw")) &&
		descriptorValue(descs, "errorMessage") === null &&
		typeof descriptorValue(descs, "timestamp") === "number"
	);
}

function isUserMessageWire(value: unknown): value is UserMessageWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 3) return false;
	const content = descriptorValue(descs, "content");
	return (
		descriptorValue(descs, "role") === "user" &&
		(typeof content === "string" || isTextWireArray(content)) &&
		typeof descriptorValue(descs, "timestamp") === "number"
	);
}

function isToolResultMessageWire(value: unknown): value is ToolResultMessageWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 7) return false;
	return (
		descriptorValue(descs, "role") === "toolResult" &&
		typeof descriptorValue(descs, "toolCallId") === "string" &&
		typeof descriptorValue(descs, "toolName") === "string" &&
		isTextWireArray(descriptorValue(descs, "content")) &&
		isNormalizedJson(descriptorValue(descs, "details")) &&
		typeof descriptorValue(descs, "isError") === "boolean" &&
		typeof descriptorValue(descs, "timestamp") === "number"
	);
}

function isMessageWire(value: unknown): value is MessageWire {
	return isUserMessageWire(value) || isAssistantMessageWire(value) || isToolResultMessageWire(value);
}

function isMessageWireArray(value: unknown): value is ReadonlyArray<MessageWire> {
	if (!normalizedArray(value)) return false;
	for (let i = 0; i < value.length; i++) {
		if (!isMessageWire(value[i])) return false;
	}
	return true;
}

function isToolWire(value: unknown): value is ToolWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 3) return false;
	return (
		typeof descriptorValue(descs, "name") === "string" &&
		typeof descriptorValue(descs, "description") === "string" &&
		normalizedRecord(descriptorValue(descs, "parameters"))
	);
}

function isToolWireArray(value: unknown): value is ReadonlyArray<ToolWire> {
	if (!normalizedArray(value)) return false;
	for (let i = 0; i < value.length; i++) {
		if (!isToolWire(value[i])) return false;
	}
	return true;
}

function isContextWire(value: unknown): value is ContextWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 3) return false;
	const tools = descriptorValue(descs, "tools");
	return (
		normalizedStringOrNull(descriptorValue(descs, "systemPrompt")) &&
		isMessageWireArray(descriptorValue(descs, "messages")) &&
		(tools === null || isToolWireArray(tools))
	);
}

function isThinkingBudgetsWire(value: unknown): value is ThinkingBudgetsWire {
	const descs = normalizedDescs(value);
	if (descs === null) return false;
	const names = _getOwnPropertyNames(descs);
	if (names.length > 4) return false;
	for (let i = 0; i < names.length; i++) {
		if (!thinkingBudgetKey(names[i]) || typeof descriptorValue(descs, names[i]) !== "number") return false;
	}
	return true;
}

function isSafeOptionsWire(value: unknown): value is SafeOptionsWire {
	const descs = normalizedDescs(value);
	if (descs === null || _getOwnPropertyNames(descs).length !== 7) return false;
	const cacheRetention = descriptorValue(descs, "cacheRetention");
	const maxTokens = descriptorValue(descs, "maxTokens");
	const reasoning = descriptorValue(descs, "reasoning");
	const serviceTier = descriptorValue(descs, "serviceTier");
	const temperature = descriptorValue(descs, "temperature");
	const budgets = descriptorValue(descs, "thinkingBudgets");
	return (
		(cacheRetention === null ||
			cacheRetention === "none" ||
			cacheRetention === "short" ||
			cacheRetention === "long") &&
		(maxTokens === null || typeof maxTokens === "number") &&
		(reasoning === null ||
			reasoning === "off" ||
			reasoning === "minimal" ||
			reasoning === "low" ||
			reasoning === "medium" ||
			reasoning === "high" ||
			reasoning === "xhigh" ||
			reasoning === "max") &&
		(serviceTier === null ||
			serviceTier === "auto" ||
			serviceTier === "default" ||
			serviceTier === "flex" ||
			serviceTier === "scale" ||
			serviceTier === "priority") &&
		normalizedStringOrNull(descriptorValue(descs, "sessionId")) &&
		(temperature === null || typeof temperature === "number") &&
		(budgets === null || isThinkingBudgetsWire(budgets))
	);
}

function extractRequest(value: NormalizedJson): CodecRequest | null {
	const descs = normalizedDescs(value);
	if (descs === null) return null;
	const context = descriptorValue(descs, "context");
	const options = descriptorValue(descs, "options");
	if (!isContextWire(context) || !isSafeOptionsWire(options)) return null;
	return _freeze({ context, options });
}

function extractAssistant(value: NormalizedJson): AssistantMessageWire | null {
	return isAssistantMessageWire(value) ? value : null;
}

export function encodeModelRequest(contextRaw: unknown, optionsRaw: unknown): EncodeResult {
	const state = makeValidationState();
	const context = rebuildContext(contextRaw, state);
	if (context === null) return _freeze({ ok: false, code: "INPUT_INVALID" });
	const options = rebuildOptions(optionsRaw, state);
	if (options === null) return _freeze({ ok: false, code: "INPUT_INVALID" });
	return encodeComplete({ context, options });
}

export function decodeModelRequestBytes(input: unknown): DecodeRequestResult {
	const copied = copySandboxStrictBytes(input, MAX_BYTES);
	if (!copied.ok) {
		if (copied.code === "INPUT_TOO_LARGE") return _freeze({ ok: false, code: "INPUT_TOO_LARGE" });
		return _freeze({ ok: false, code: "INPUT_INVALID" });
	}
	const buffer = copied.value;
	try {
		const text = decodeUtf8(buffer);
		if (text === null) return _freeze({ ok: false, code: "UTF8_ERROR" });
		const scan = safeDuplicateScan(text);
		if (scan === "duplicate" || scan === "limit") return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		if (scan === "invalid") return _freeze({ ok: false, code: "FRAME_ERROR" });
		const parsed = safeParse(text);
		if (!parsed.ok) return _freeze({ ok: false, code: "FRAME_ERROR" });
		const state = makeValidationState();
		const root = captureExactRecord(parsed.value, state, requestRootKey);
		if (root === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const context = rebuildContext(descriptorValue(root, "context"), state);
		if (context === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const options = rebuildOptions(descriptorValue(root, "options"), state);
		if (options === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const complete = normalize({ context, options });
		if (!complete.ok || !canonicalBytes(complete.value, buffer))
			return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const request = extractRequest(complete.value);
		if (request === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		return _freeze({ ok: true, request });
	} finally {
		zeroBuffer(buffer);
	}
}

export function encodeModelReply(messageRaw: unknown): EncodeResult {
	const state = makeValidationState();
	const descs = captureExactRecord(messageRaw, state, replyEncodeInputKey);
	if (descs === null) return _freeze({ ok: false, code: "FRAME_ERROR" });
	if (descriptorValue(descs, "ok") === false) {
		if (_getOwnPropertyNames(descs).length !== 2 || descriptorValue(descs, "code") !== "INTERNAL_ERROR") {
			return _freeze({ ok: false, code: "FRAME_ERROR" });
		}
		return encodeComplete({ ok: false, code: "INTERNAL_ERROR" });
	}
	if (!descriptorsAllowed(descs, assistantMessageKey)) return _freeze({ ok: false, code: "FRAME_ERROR" });
	const message = rebuildAssistantFromDescs(descs, state);
	if (message === null) return _freeze({ ok: false, code: "FRAME_ERROR" });
	const stopReason = descriptorValue(descs, "stopReason");
	if (stopReason === "error") return encodeComplete({ ok: false, code: "INTERNAL_ERROR" });
	if (stopReason === "aborted") return _freeze({ ok: false, code: "FRAME_ERROR" });
	return encodeComplete({ ok: true, message });
}

export function decodeModelReplyBytes(input: unknown): DecodeReplyResult {
	const copied = copySandboxStrictBytes(input, MAX_BYTES);
	if (!copied.ok) {
		if (copied.code === "INPUT_TOO_LARGE") return _freeze({ ok: false, code: "INPUT_TOO_LARGE" });
		return _freeze({ ok: false, code: "INPUT_INVALID" });
	}
	const buffer = copied.value;
	try {
		const text = decodeUtf8(buffer);
		if (text === null) return _freeze({ ok: false, code: "UTF8_ERROR" });
		const scan = safeDuplicateScan(text);
		if (scan === "duplicate" || scan === "limit") return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		if (scan === "invalid") return _freeze({ ok: false, code: "FRAME_ERROR" });
		const parsed = safeParse(text);
		if (!parsed.ok) return _freeze({ ok: false, code: "FRAME_ERROR" });
		const state = makeValidationState();
		const root = captureExactRecord(parsed.value, state, replyRootKey);
		if (root === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const ok = descriptorValue(root, "ok");
		let assembled: Record<string, unknown>;
		if (ok === true) {
			if (descriptorValue(root, "code") !== undefined) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
			const messageDescs = captureExactRecord(descriptorValue(root, "message"), state, assistantMessageKey);
			if (messageDescs === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
			const message = rebuildAssistantFromDescs(messageDescs, state);
			if (message === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
			const stopReason = descriptorValue(messageDescs, "stopReason");
			if (stopReason === "error" || stopReason === "aborted") {
				return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
			}
			assembled = { ok: true, message };
		} else if (ok === false) {
			if (descriptorValue(root, "message") !== undefined || descriptorValue(root, "code") !== "INTERNAL_ERROR") {
				return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
			}
			assembled = { ok: false, code: "INTERNAL_ERROR" };
		} else return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const complete = normalize(assembled);
		if (!complete.ok || !canonicalBytes(complete.value, buffer))
			return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		if (!normalizedRecord(complete.value)) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const completeDescs = captureDescriptors(complete.value);
		if (completeDescs === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		if (descriptorValue(completeDescs, "ok") === false) {
			return _freeze({ ok: true, reply: _freeze({ ok: false, code: "INTERNAL_ERROR" }) });
		}
		const messageValue = descriptorValue(completeDescs, "message");
		if (!isNormalizedJson(messageValue)) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		const message = extractAssistant(messageValue);
		if (message === null) return _freeze({ ok: false, code: "PROTOCOL_ERROR" });
		return _freeze({ ok: true, reply: _freeze({ ok: true, message }) });
	} finally {
		zeroBuffer(buffer);
	}
}
