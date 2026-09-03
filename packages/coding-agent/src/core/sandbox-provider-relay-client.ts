/**
 * B14b sandbox-side provider relay composition.
 *
 * Wraps an existing SandboxProviderClient with a relay-aware FrameTransport
 * that converts legacy ProxyFrames to RemoteHost provider_proxy envelopes
 * for outbound, and delivers inbound provider_proxy frames back to the
 * SandboxProviderClient.
 *
 * The borrowed send capability from the relay is captured at construction
 * and kept in closures, never stored as an enumerable property.
 */

import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { REMOTE_HOST_PROTOCOL_INFO, type RemoteHostFrameEnvelope } from "../modes/daemon/remote-agent-host-protocol.js";
import { decodeEnvelope, decodeJsonValue } from "../modes/daemon/remote-host-frame-codec.js";
import type { ProxyCancelFrame, ProxyFrame, ProxyRequestFrame } from "./home-provider-proxy-types.js";
import { SandboxProviderClient } from "./sandbox-provider-client.js";
import type { FrameTransport } from "./sandbox-provider-client-types.js";

// ---------------------------------------------------------------------------
// Captured native intrinsics via descriptor capture (all-or-nothing)
// ---------------------------------------------------------------------------

// Capture Promise.prototype via descriptor. Validate value: must be an
// ordinary non-Proxy object with Object.prototype.
const PROMISE_PROTOTYPE_DESC = Object.getOwnPropertyDescriptor(Promise, "prototype");
if (
	PROMISE_PROTOTYPE_DESC === undefined ||
	!("value" in PROMISE_PROTOTYPE_DESC) ||
	PROMISE_PROTOTYPE_DESC.get !== undefined ||
	PROMISE_PROTOTYPE_DESC.set !== undefined
) {
	throw new Error("Promise.prototype is not a data descriptor");
}
const _promiseProtoRaw: unknown = PROMISE_PROTOTYPE_DESC.value;
if (
	typeof _promiseProtoRaw !== "object" ||
	_promiseProtoRaw === null ||
	types.isProxy(_promiseProtoRaw) ||
	Object.getPrototypeOf(_promiseProtoRaw) !== Object.prototype
) {
	throw new Error("Promise.prototype value is not a plain object");
}
const PROMISE_PROTOTYPE = _promiseProtoRaw;

// Capture Promise.prototype.then from the validated prototype.
const PROMISE_THEN_DESC = Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, "then");
if (
	PROMISE_THEN_DESC === undefined ||
	!("value" in PROMISE_THEN_DESC) ||
	typeof PROMISE_THEN_DESC.value !== "function"
) {
	throw new Error("Promise.prototype.then is not a function data descriptor");
}
const _promiseThenRaw: unknown = PROMISE_THEN_DESC.value;
if (typeof _promiseThenRaw !== "function" || types.isProxy(_promiseThenRaw)) {
	throw new Error("Promise.prototype.then value is not a regular function");
}
// Used only through the captured Reflect.apply boundary.
const PROMISE_THEN = _promiseThenRaw;

// Capture Array.isArray via descriptor.
const ARRAY_IS_ARRAY_DESC = Object.getOwnPropertyDescriptor(Array, "isArray");
if (
	ARRAY_IS_ARRAY_DESC === undefined ||
	!("value" in ARRAY_IS_ARRAY_DESC) ||
	typeof ARRAY_IS_ARRAY_DESC.value !== "function"
) {
	throw new Error("Array.isArray is not a function data descriptor");
}
const _arrayIsArrayRaw: unknown = ARRAY_IS_ARRAY_DESC.value;
if (typeof _arrayIsArrayRaw !== "function" || types.isProxy(_arrayIsArrayRaw)) {
	throw new Error("Array.isArray value is not a regular function");
}
// Used only through the captured Reflect.apply boundary.
const ARRAY_IS_ARRAY = _arrayIsArrayRaw;

// ---------------------------------------------------------------------------
// Typed descriptor helpers
// ---------------------------------------------------------------------------

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

// strictOwnDescriptors rejects null-prototype — for public/caller-facing paths
// where only plain Object.prototype objects from the caller are accepted.
function strictOwnDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

// decodedOwnDescriptors accepts both Object.prototype and null-prototype.
// null-prototype is produced by decodeJsonValue (remote-host-frame-codec.ts line 811:
// Object.create(null)) at the exact internal trusted boundary where codec-decoded
// data enters the relay. Only decoded delta/content/usage validators should use this.
// Public/caller-facing paths must use strictOwnDescriptors.
function decodedOwnDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const proto = Object.getPrototypeOf(raw);
		if (proto !== null && proto !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exactKeys(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const d = strictOwnDescriptors(raw);
	if (d === null) return null;
	const names = Object.getOwnPropertyNames(d);
	if (names.length !== keys.size) return null;
	for (const name of names) {
		if (!keys.has(name)) return null;
	}
	for (const name of names) {
		const desc = d[name];
		if (desc === undefined || !("value" in desc) || !desc.enumerable) return null;
	}
	return d;
}

function decodedKeys(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const d = decodedOwnDescriptors(raw);
	if (d === null) return null;
	const names = Object.getOwnPropertyNames(d);
	if (names.length !== keys.size) return null;
	for (const name of names) {
		if (!keys.has(name)) return null;
	}
	for (const name of names) {
		const desc = d[name];
		if (desc === undefined || !("value" in desc) || !desc.enumerable) return null;
	}
	return d;
}

function valueFrom(descriptors: Descriptors, name: string): unknown {
	const d = descriptors[name];
	return d !== undefined && "value" in d ? d.value : undefined;
}

// ---------------------------------------------------------------------------
// Exact native Promise guard
// ---------------------------------------------------------------------------

function isExactNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (!types.isPromise(raw)) return false;
		if (Object.getPrototypeOf(raw) !== PROMISE_PROTOTYPE) return false;
		if (Object.getOwnPropertyNames(raw).length > 0) return false;
		if (Object.getOwnPropertySymbols(raw).length > 0) return false;
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Value predicates
// ---------------------------------------------------------------------------

// decodedIsRecord accepts null-prototype — for decoded data from decodeJsonValue
// where Object.create(null) produces null-prototype objects at the trusted boundary.
function decodedIsRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (Reflect.apply(ARRAY_IS_ARRAY, null, [value]) === true) return false;
		if (types.isProxy(value)) return false;
		const proto = Object.getPrototypeOf(value);
		if (proto !== null && proto !== Object.prototype) return false;
		return true;
	} catch {
		return false;
	}
}

function isFiniteNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidDoneReason(value: unknown): value is "stop" | "length" | "toolUse" {
	return value === "stop" || value === "length" || value === "toolUse";
}

// ---------------------------------------------------------------------------
// Exact content block validators via descriptors
// ---------------------------------------------------------------------------

function isValidTextBlock(raw: unknown): boolean {
	const d = decodedOwnDescriptors(raw);
	if (d === null) return false;
	const names = new Set(Object.getOwnPropertyNames(d));
	if (names.has("type") === false || names.has("text") === false) return false;
	if (valueFrom(d, "type") !== "text") return false;
	if (typeof valueFrom(d, "text") !== "string") return false;
	const extras = ["textSignature"];
	for (const n of names) {
		if (n !== "type" && n !== "text" && !extras.includes(n)) return false;
		if (n === "textSignature" && typeof valueFrom(d, n) !== "string") return false;
	}
	return true;
}

function isValidThinkingBlock(raw: unknown): boolean {
	const d = decodedOwnDescriptors(raw);
	if (d === null) return false;
	const names = new Set(Object.getOwnPropertyNames(d));
	if (names.has("type") === false || names.has("thinking") === false) return false;
	if (valueFrom(d, "type") !== "thinking") return false;
	if (typeof valueFrom(d, "thinking") !== "string") return false;
	const extras = ["thinkingSignature", "redacted"];
	for (const n of names) {
		if (n !== "type" && n !== "thinking" && !extras.includes(n)) return false;
		if (n === "thinkingSignature" && typeof valueFrom(d, n) !== "string") return false;
		if (n === "redacted" && typeof valueFrom(d, n) !== "boolean") return false;
	}
	return true;
}

function isSafeJsonValue(value: unknown, _depth: number): boolean {
	// Use codec's exact JSON decoder as validator
	const result = decodeJsonValue(value);
	return result.ok;
}

function isValidToolCallBlock(raw: unknown): boolean {
	const d = decodedOwnDescriptors(raw);
	if (d === null) return false;
	const names = new Set(Object.getOwnPropertyNames(d));
	if (
		names.has("type") === false ||
		names.has("id") === false ||
		names.has("name") === false ||
		names.has("arguments") === false
	)
		return false;
	if (valueFrom(d, "type") !== "toolCall") return false;
	if (typeof valueFrom(d, "id") !== "string") return false;
	if (typeof valueFrom(d, "name") !== "string") return false;
	const args = valueFrom(d, "arguments");
	if (!isSafeJsonValue(args, 0)) return false;
	const extras = ["thoughtSignature"];
	for (const n of names) {
		if (n !== "type" && n !== "id" && n !== "name" && n !== "arguments" && !extras.includes(n)) return false;
		if (n === "thoughtSignature" && typeof valueFrom(d, n) !== "string") return false;
	}
	return true;
}

function isValidOwnContentBlock(raw: unknown): boolean {
	const d = decodedOwnDescriptors(raw);
	if (d === null) return false;
	const t = valueFrom(d, "type");
	if (t === "text") return isValidTextBlock(raw);
	if (t === "thinking") return isValidThinkingBlock(raw);
	if (t === "toolCall") return isValidToolCallBlock(raw);
	return false;
}

function isValidOwnContentBlockArray(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (types.isProxy(value)) return false;
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		if (Object.getOwnPropertySymbols(value).length > 0) return false;
	} catch {
		return false;
	}
	const rawLen = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (typeof rawLen !== "number" || !Number.isSafeInteger(rawLen) || rawLen < 0 || rawLen > 256) return false;
	if (rawLen === 0) return true;
	const descs = Object.getOwnPropertyDescriptors(value);
	// Verify dense integer keys and data-only descriptors
	for (let i = 0; i < rawLen; i++) {
		const si = String(i);
		if (!(si in descs)) return false;
		const desc = descs[si];
		if (desc === undefined || desc.get !== undefined || desc.set !== undefined) return false;
		if (!desc.enumerable || !("value" in desc)) return false;
		if (!isValidOwnContentBlock(desc.value)) return false;
	}
	// Reject any non-integer keys besides "length"
	for (const k of Object.getOwnPropertyNames(descs)) {
		if (k === "length") continue;
		const n = Number(k);
		if (!Number.isSafeInteger(n) || n < 0 || n >= rawLen) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Exact usage validator via descriptors (full Pi Usage)
// ---------------------------------------------------------------------------

function isValidOwnUsage(raw: unknown): boolean {
	const d = decodedKeys(raw, new Set(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]));
	if (d === null) return false;
	if (typeof valueFrom(d, "input") !== "number" || !isFiniteNonNegative(valueFrom(d, "input"))) return false;
	if (typeof valueFrom(d, "output") !== "number" || !isFiniteNonNegative(valueFrom(d, "output"))) return false;
	if (typeof valueFrom(d, "cacheRead") !== "number" || !isFiniteNonNegative(valueFrom(d, "cacheRead"))) return false;
	if (typeof valueFrom(d, "cacheWrite") !== "number" || !isFiniteNonNegative(valueFrom(d, "cacheWrite"))) return false;
	if (typeof valueFrom(d, "totalTokens") !== "number" || !isFiniteNonNegative(valueFrom(d, "totalTokens")))
		return false;
	const costD = decodedKeys(valueFrom(d, "cost"), new Set(["input", "output", "cacheRead", "cacheWrite", "total"]));
	if (costD === null) return false;
	for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
		if (typeof valueFrom(costD, k) !== "number" || !isFiniteNonNegative(valueFrom(costD, k))) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Exact ProxyStreamEventFrame validator
// ---------------------------------------------------------------------------

function isValidProxyStreamEventFrame(raw: unknown): boolean {
	const d = decodedOwnDescriptors(raw);
	if (d === null) {
		return false;
	}
	const ownKeys = new Set(Object.getOwnPropertyNames(d));
	if (ownKeys.has("type") === false || ownKeys.has("eventType") === false || ownKeys.has("requestId") === false)
		return false;
	const tRaw = valueFrom(d, "type");
	if (tRaw !== "streamEvent") return false;
	const et = valueFrom(d, "eventType");
	if (typeof et !== "string") return false;
	const rid = valueFrom(d, "requestId");
	if (typeof rid !== "string" || rid.length === 0) return false;

	if (et === "start") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "content"]));
		if (sd === null) return false;
		const contentOk = isValidOwnContentBlockArray(valueFrom(sd, "content"));
		return contentOk;
	}
	if (et === "text_delta") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "delta"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return typeof valueFrom(sd, "delta") === "string";
	}
	if (et === "text_start" || et === "text_end") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "content"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return isValidOwnContentBlockArray(valueFrom(sd, "content"));
	}
	if (et === "thinking_start" || et === "thinking_end") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "content"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return isValidOwnContentBlockArray(valueFrom(sd, "content"));
	}
	if (et === "thinking_delta") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "delta"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return typeof valueFrom(sd, "delta") === "string";
	}
	if (et === "toolcall_start" || et === "toolcall_end") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "content"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return isValidOwnContentBlockArray(valueFrom(sd, "content"));
	}
	if (et === "toolcall_delta") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "contentIndex", "delta"]));
		if (sd === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(sd, "contentIndex"))) return false;
		return typeof valueFrom(sd, "delta") === "string";
	}
	if (et === "done") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "stopReason", "content", "usage"]));
		if (sd === null) return false;
		if (!isValidDoneReason(valueFrom(sd, "stopReason"))) return false;
		if (!isValidOwnContentBlockArray(valueFrom(sd, "content"))) return false;
		return isValidOwnUsage(valueFrom(sd, "usage"));
	}
	if (et === "error") {
		const sd = decodedKeys(raw, new Set(["type", "eventType", "requestId", "stopReason"]));
		if (sd === null) return false;
		const sr = valueFrom(sd, "stopReason");
		return sr === "error" || sr === "aborted";
	}

	return false;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function appliedResult(): { readonly status: "applied" } {
	return Object.freeze({ status: "applied" });
}

function errorResult(): { readonly status: "error" } {
	return Object.freeze({ status: "error" });
}

function closedResult(): { readonly status: "closed" } {
	return Object.freeze({ status: "closed" });
}

function invalidArgumentError(): { readonly ok: false; readonly error: { readonly code: "INVALID_ARGUMENT" } } {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code: "INVALID_ARGUMENT" }),
	});
}

// ---------------------------------------------------------------------------
// Deep-freeze helpers (cast-free, descriptor-safe)
// ---------------------------------------------------------------------------

function deepFreezeJsonValue(value: unknown, depth: number): null | unknown {
	if (depth > 64) return null;
	if (typeof value !== "object" || value === null) return value;
	// Use captured ARRAY_IS_ARRAY (immune to runtime monkey-patching).
	// Read elements via property descriptors instead of index access,
	// avoiding an explicit type assertion on value.
	if (Reflect.apply(ARRAY_IS_ARRAY, null, [value])) {
		const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
		if (lenDesc === undefined || lenDesc.get !== undefined || lenDesc.set !== undefined || !("value" in lenDesc))
			return null;
		const len = lenDesc.value;
		if (typeof len !== "number" || !Number.isSafeInteger(len) || len > 512 || len < 0) return null;
		const result = new Array<unknown>(len);
		for (let i = 0; i < len; i++) {
			const elemDesc = Object.getOwnPropertyDescriptor(value, String(i));
			if (elemDesc === undefined || elemDesc.get !== undefined || elemDesc.set !== undefined) return null;
			if (!("value" in elemDesc)) return null;
			const frozen = deepFreezeJsonValue(elemDesc.value, depth + 1);
			if (frozen === undefined) return null;
			result[i] = frozen;
		}
		return Object.freeze(result);
	}
	const keys = Object.getOwnPropertyNames(value);
	if (keys.length > 128) return null;
	const owned: Record<string, unknown> = {};
	for (const k of keys) {
		const desc = Object.getOwnPropertyDescriptor(value, k);
		if (desc === undefined || !("value" in desc)) continue;
		const frozen = deepFreezeJsonValue(desc.value, depth + 1);
		if (frozen === undefined) return null;
		owned[k] = frozen;
	}
	return Object.freeze(owned);
}

function deepCloneContentBlock(block: unknown): Record<string, unknown> | null {
	const d = decodedOwnDescriptors(block);
	if (d === null) return null;
	const t = valueFrom(d, "type");
	if (t === "text") {
		const out: Record<string, unknown> = { type: "text", text: valueFrom(d, "text") };
		const sig = valueFrom(d, "textSignature");
		if (sig !== undefined) out.textSignature = sig;
		return out;
	}
	if (t === "thinking") {
		const out: Record<string, unknown> = { type: "thinking", thinking: valueFrom(d, "thinking") };
		const sig = valueFrom(d, "thinkingSignature");
		if (sig !== undefined) out.thinkingSignature = sig;
		const redacted = valueFrom(d, "redacted");
		if (redacted !== undefined) out.redacted = redacted;
		return out;
	}
	if (t === "toolCall") {
		const idVal = valueFrom(d, "id");
		const nameVal = valueFrom(d, "name");
		if (typeof idVal !== "string" || typeof nameVal !== "string") return null;
		const out: Record<string, unknown> = { type: "toolCall", id: idVal, name: nameVal };
		const args = valueFrom(d, "arguments");
		if (args !== undefined) {
			const argsSafe = deepFreezeJsonValue(args, 0);
			if (argsSafe !== undefined) out.arguments = argsSafe;
		}
		const sig = valueFrom(d, "thoughtSignature");
		if (sig !== undefined) out.thoughtSignature = sig;
		return out;
	}
	return null;
}

function _deepFreezeContentBlock(block: unknown): Record<string, unknown> | null {
	const cloned = deepCloneContentBlock(block);
	if (cloned === null) return null;
	return Object.freeze(cloned);
}

function deepCloneContentArray(arr: unknown): unknown[] | null {
	if (typeof arr !== "object" || arr === null) return null;
	const lenDesc = Object.getOwnPropertyDescriptor(arr, "length");
	if (lenDesc === undefined || lenDesc.get !== undefined || lenDesc.set !== undefined) return null;
	const rawLen = lenDesc.value;
	if (typeof rawLen !== "number" || !Number.isSafeInteger(rawLen) || rawLen < 0) return null;
	const owned: unknown[] = [];
	for (let i = 0; i < rawLen; i++) {
		const elemDesc = Object.getOwnPropertyDescriptor(arr, String(i));
		if (elemDesc === undefined || elemDesc.get !== undefined || elemDesc.set !== undefined) return null;
		if (!("value" in elemDesc)) return null;
		owned.push(deepCloneContentBlock(elemDesc.value));
	}
	return owned;
}

function deepFreezeContentArray(arr: unknown): readonly unknown[] | null {
	if (typeof arr !== "object" || arr === null) return null;
	const lenDesc = Object.getOwnPropertyDescriptor(arr, "length");
	if (lenDesc === undefined || lenDesc.get !== undefined || lenDesc.set !== undefined) return null;
	const rawLen = lenDesc.value;
	if (typeof rawLen !== "number" || !Number.isSafeInteger(rawLen) || rawLen < 0) return null;
	const cloned = deepCloneContentArray(arr);
	if (cloned === null) return null;
	const frozen = new Array<unknown>(cloned.length);
	for (let i = 0; i < cloned.length; i++) {
		frozen[i] = Object.freeze(cloned[i]);
	}
	return Object.freeze(frozen);
}

// ---------------------------------------------------------------------------
// Outbound envelope builders
// ---------------------------------------------------------------------------

function buildRawFrame(req: ProxyRequestFrame): Record<string, unknown> {
	const rawFrame: Record<string, unknown> = {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId: req.requestId,
		provider: req.model.provider,
		model: req.model.modelId,
		messages: req.context.messages,
	};
	if (req.context.systemPrompt !== undefined) {
		rawFrame.systemPrompt = req.context.systemPrompt;
	}
	if (req.context.tools !== undefined && req.context.tools.length > 0) {
		rawFrame.tools = req.context.tools;
	}
	if (req.options.maxTokens !== undefined) {
		rawFrame.maxTokens = req.options.maxTokens;
	}
	if (req.options.temperature !== undefined) {
		rawFrame.temperature = req.options.temperature;
	}
	return rawFrame;
}

function buildCancelRawFrame(cancel: ProxyCancelFrame): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_cancel",
		callId: cancel.requestId,
	};
}

// ---------------------------------------------------------------------------
// Active callId tracker
// ---------------------------------------------------------------------------

function createCallTracker() {
	const calls = new Map<string, { nextIndex: number; finished: boolean }>();

	function reserve(callId: string): boolean {
		if (calls.has(callId)) return false;
		calls.set(callId, { nextIndex: 0, finished: false });
		return true;
	}

	function checkChunk(callId: string, index: number): boolean {
		const call = calls.get(callId);
		if (call === undefined) return false;
		if (call.finished) return false;
		if (index !== call.nextIndex) return false;
		call.nextIndex = index + 1;
		return true;
	}

	function markFinished(callId: string): boolean {
		const call = calls.get(callId);
		if (call === undefined) return false;
		if (call.finished) return false;
		call.finished = true;
		return true;
	}

	function has(callId: string): boolean {
		return calls.has(callId);
	}

	function drain(): string[] {
		const result = Array.from(calls.keys());
		calls.clear();
		return result;
	}

	return { reserve, checkChunk, markFinished, has, drain };
}

// ---------------------------------------------------------------------------
// Send observer — retains processing tasks, not raw promises
// ---------------------------------------------------------------------------

interface SendTask {
	callId: string;
	task: Promise<unknown>;
}

function createSendObserver() {
	const tasks: SendTask[] = [];

	function add(callId: string, task: Promise<unknown>): void {
		tasks.push({ callId, task });
	}

	function remove(targetTask: Promise<unknown>): void {
		const idx = tasks.findIndex((o) => o.task === targetTask);
		if (idx !== -1) tasks.splice(idx, 1);
	}

	function drain(): SendTask[] {
		const result = tasks.slice();
		tasks.length = 0;
		return result;
	}

	return { add, remove, drain };
}

// ---------------------------------------------------------------------------
// FIFO queue
// ---------------------------------------------------------------------------

function createFeeQueue() {
	let tail: Promise<void> = new Promise<void>((r) => r());

	function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = tail;
		const result: Promise<T> = Reflect.apply(PROMISE_THEN, prev, [fn, fn]);
		tail = Reflect.apply(PROMISE_THEN, result, [() => {}, () => {}]);
		return result;
	}

	return { enqueue };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProviderRelayApplyResult =
	| Readonly<{ readonly status: "applied" }>
	| Readonly<{ readonly status: "error" }>;

export type ProviderRelayCloseResult = Readonly<{ readonly status: "closed" }> | Readonly<{ readonly status: "error" }>;

export interface ProviderRelayApplication {
	readonly apply: (raw: unknown) => Promise<ProviderRelayApplyResult>;
	readonly close: () => Promise<ProviderRelayCloseResult>;
}

export type ProviderRelayCreateResult =
	| Readonly<{
			readonly ok: true;
			readonly streamFn: StreamFn;
			readonly application: ProviderRelayApplication;
	  }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "INVALID_ARGUMENT" }> }>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSandboxProviderRelayClient(sendRelay: unknown): ProviderRelayCreateResult {
	const d = exactKeys(sendRelay, new Set(["send"]));
	if (d === null) return invalidArgumentError();

	const sendDesc = d.send;
	if (sendDesc === undefined || typeof sendDesc.value !== "function") {
		return invalidArgumentError();
	}

	const sendFn = (envelope: RemoteHostFrameEnvelope): unknown => Reflect.apply(sendDesc.value, sendRelay, [envelope]);

	let clientHandler: ((raw: unknown) => void) | null = null;
	const callTracker = createCallTracker();
	const sendObserver = createSendObserver();
	const feeQueue = createFeeQueue();
	let closed = false;
	let closePromise: Promise<ProviderRelayCloseResult> | null = null;

	// ── Feed error to stream ──────────────────────────────────────────

	function feedProxyError(callId: string, code: string, message: string): void {
		if (clientHandler === null) return;
		callTracker.markFinished(callId);
		clientHandler({
			type: "error",
			requestId: callId,
			stopReason: "error",
			code: code,
			message: message,
		});
	}

	// ── Exact send-result validation by own descriptors ──────────────

	function validateSendFulfillment(result: unknown, expectedFrameId: string): boolean {
		const resultDesc = exactKeys(result, new Set(["ok", "value"]));
		if (resultDesc === null) return false;
		if (valueFrom(resultDesc, "ok") !== true) return false;

		const val = valueFrom(resultDesc, "value");
		const valDesc = exactKeys(val, new Set(["frameId", "replay", "journalReceipt"]));
		if (valDesc === null) return false;
		if (valueFrom(valDesc, "frameId") !== expectedFrameId) return false;
		if (typeof valueFrom(valDesc, "replay") !== "boolean") return false;

		const receipt = valueFrom(valDesc, "journalReceipt");
		const receiptDesc = exactKeys(receipt, new Set(["sequence", "size", "sha256"]));
		if (receiptDesc === null) return false;
		if (!isFiniteNonNegativeInt(valueFrom(receiptDesc, "sequence"))) return false;
		if (!isFiniteNonNegativeInt(valueFrom(receiptDesc, "size"))) return false;
		const sha256 = valueFrom(receiptDesc, "sha256");
		if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return false;

		return true;
	}

	// ── Observe one send with retained nonthrowing processing task ──

	function observeExactPromise(callId: string, promise: Promise<unknown>, expectedFrameId: string): void {
		const finalTask: Promise<unknown> = Reflect.apply(PROMISE_THEN, promise, [
			function onFulfilled(result: unknown): void {
				if (!validateSendFulfillment(result, expectedFrameId)) {
					feedProxyError(callId, "STREAM_FAILED", "send rejected");
				}
			},
			function onRejected(): void {
				feedProxyError(callId, "STREAM_FAILED", "send promise rejected");
			},
		]);

		// Build a nonrejecting native Promise that settles after validation and removes itself
		const cleanupTask: Promise<void> = Reflect.apply(PROMISE_THEN, finalTask, [
			function onSettled(): void {
				sendObserver.remove(cleanupTask);
			},
			function onSettledError(): void {
				sendObserver.remove(cleanupTask);
			},
		]);

		sendObserver.add(callId, cleanupTask);
	}

	function routeSend(callId: string, rawResult: unknown, envelope: RemoteHostFrameEnvelope): void {
		if (!isExactNativePromise(rawResult)) {
			feedProxyError(callId, "STREAM_FAILED", "send did not return a valid promise");
			return;
		}
		observeExactPromise(callId, rawResult, envelope.frameId);
	}

	// ── Feed one ProxyErrorFrame to clientHandler ─────────────────────

	function terminalErrorFrame(callId: string, code: string, message: string): void {
		if (clientHandler === null) return;
		if (!callTracker.has(callId)) return;
		if (!callTracker.markFinished(callId)) return;
		clientHandler({
			type: "error",
			requestId: callId,
			stopReason: "error",
			code: code,
			message: message,
		});
	}

	// ── Relay transport ───────────────────────────────────────────────

	const transport: FrameTransport = {
		send(frame: ProxyFrame): void {
			if (frame.type === "request") {
				const envelope = makeRequestEnvelope(frame);
				if (envelope === undefined) {
					feedProxyError(frame.requestId, "STREAM_FAILED", "failed to build request envelope");
					return;
				}
				if (!callTracker.reserve(frame.requestId)) {
					feedProxyError(frame.requestId, "DUPLICATE_REQUEST", "duplicate requestId");
					return;
				}
				let rawResult: unknown;
				try {
					rawResult = sendFn(envelope);
				} catch {
					feedProxyError(frame.requestId, "STREAM_FAILED", "send threw");
					return;
				}
				routeSend(frame.requestId, rawResult, envelope);
				return;
			}
			if (frame.type === "cancel") {
				const envelope = makeCancelEnvelope(frame);
				if (envelope === undefined) {
					terminalErrorFrame(frame.requestId, "STREAM_FAILED", "failed to build cancel envelope");
					return;
				}
				let rawResult: unknown;
				try {
					rawResult = sendFn(envelope);
				} catch {
					terminalErrorFrame(frame.requestId, "STREAM_FAILED", "cancel threw");
					return;
				}
				if (!isExactNativePromise(rawResult)) {
					terminalErrorFrame(frame.requestId, "STREAM_FAILED", "cancel did not return promise");
					return;
				}
				observeExactPromise(frame.requestId, rawResult, envelope.frameId);
				return;
			}
		},
		onFrame(handler: (raw: unknown) => void): () => void {
			clientHandler = handler;
			return () => {
				clientHandler = null;
			};
		},
		close(): void {
			// Owned by application.close()
		},
	};

	const client = new SandboxProviderClient({
		transport,
		modelLookup: null,
	});

	// ── Inbound helpers ────────────────────────────────────────────────

	function handleStructuredEvent(callId: string, index: number, delta: Record<string, unknown>): boolean {
		if (!isValidProxyStreamEventFrame(delta)) return false;
		if (delta.requestId !== callId) return false;
		if (clientHandler === null) return false;
		if (!callTracker.checkChunk(callId, index)) return false;

		const eventType = delta.eventType;

		// Build a fresh exact deep-frozen event object for every accepted
		// chunk. Internal content stays mutable (SandboxProviderClient mutates
		// blocks in-place), but caller references are severed by deepClone.
		// Never mutate or retain a reference to the caller-owned delta.
		if (
			eventType === "start" ||
			eventType === "text_start" ||
			eventType === "text_end" ||
			eventType === "thinking_start" ||
			eventType === "thinking_end" ||
			eventType === "toolcall_start" ||
			eventType === "toolcall_end"
		) {
			const contentDesc = Object.getOwnPropertyDescriptor(delta, "content");
			const ciDesc = Object.getOwnPropertyDescriptor(delta, "contentIndex");
			const fresh: Record<string, unknown> = {
				type: delta.type,
				eventType: delta.eventType,
				requestId: delta.requestId,
			};
			if (contentDesc !== undefined && "value" in contentDesc) {
				const cloned = deepCloneContentArray(contentDesc.value);
				if (cloned === null) {
					// Clone failure — do not advance callTracker state
					return false;
				}
				fresh.content = cloned;
			}
			if (ciDesc !== undefined && "value" in ciDesc) {
				fresh.contentIndex = ciDesc.value;
			}
			clientHandler(fresh);
			return true;
		}
		// String-delta events — build a fresh copy, never freeze caller delta.
		if (eventType === "text_delta" || eventType === "thinking_delta" || eventType === "toolcall_delta") {
			const ciDesc = Object.getOwnPropertyDescriptor(delta, "contentIndex");
			const deltaDesc = Object.getOwnPropertyDescriptor(delta, "delta");
			const fresh: Record<string, unknown> = {
				type: delta.type,
				eventType: delta.eventType,
				requestId: delta.requestId,
			};
			if (ciDesc !== undefined && "value" in ciDesc) {
				fresh.contentIndex = ciDesc.value;
			}
			if (deltaDesc !== undefined && "value" in deltaDesc) {
				fresh.delta = deltaDesc.value;
			}
			clientHandler(fresh);
			return true;
		}
		// Non-terminal stream events — completion/error frames follow
		if (eventType === "done" || eventType === "error") {
			// Terminal events are only valid as completion/error frames, never as chunk deltas
			return false;
		}

		return false;
	}

	function handleComplete(callId: string, result: unknown, usageRaw: unknown): boolean {
		if (clientHandler === null) return false;
		if (!callTracker.has(callId)) return false;

		const resultDesc = decodedOwnDescriptors(result);
		if (resultDesc === null) return false;

		// Enforce exact key set: role,content,stopReason + optional responseId/responseModel
		const names = new Set(Object.getOwnPropertyNames(resultDesc));
		const baseKeys = new Set(["role", "content", "stopReason"]);
		const optStrKeys = new Set(["responseId", "responseModel"]);
		for (const k of names) {
			if (!baseKeys.has(k) && !optStrKeys.has(k)) return false;
		}
		if (valueFrom(resultDesc, "role") !== "assistant") return false;
		const contentVal = valueFrom(resultDesc, "content");
		if (!isValidOwnContentBlockArray(contentVal)) return false;
		// Deep-freeze fresh owned copy; caller mutation after apply() cannot reach stream.
		// If freeze fails the apply fails without advancing callTracker.
		const ownedContent = deepFreezeContentArray(contentVal);
		if (ownedContent === null) return false;
		const stopReason = valueFrom(resultDesc, "stopReason");
		if (!isValidDoneReason(stopReason)) return false;

		// responseId/responseModel must be absent or string; reject explicit undefined/other types
		let responseId: string | undefined;
		let responseModel: string | undefined;
		if (names.has("responseId")) {
			const rid = valueFrom(resultDesc, "responseId");
			if (typeof rid !== "string") return false;
			responseId = rid;
		}
		if (names.has("responseModel")) {
			const rm = valueFrom(resultDesc, "responseModel");
			if (typeof rm !== "string") return false;
			responseModel = rm;
		}

		// Validate usage before markFinished
		let inputTokens = 0;
		let outputTokens = 0;
		if (usageRaw !== undefined) {
			const usageDesc = decodedKeys(usageRaw, new Set(["inputTokens", "outputTokens"]));
			if (usageDesc === null) return false;
			const it = valueFrom(usageDesc, "inputTokens");
			const ot = valueFrom(usageDesc, "outputTokens");
			if (!isFiniteNonNegativeInt(it) || !isFiniteNonNegativeInt(ot)) return false;
			inputTokens = it;
			outputTokens = ot;
		}

		if (!callTracker.markFinished(callId)) return false;

		const usage = Object.freeze({
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + outputTokens,
			cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
		});

		const msg: Record<string, unknown> = {
			role: "assistant",
			content: ownedContent,
			stopReason: stopReason,
		};
		if (responseId !== undefined) msg.responseId = responseId;
		if (responseModel !== undefined) msg.responseModel = responseModel;

		clientHandler(
			Object.freeze({
				type: "completion",
				requestId: callId,
				message: Object.freeze(msg),
				usage: usage,
			}),
		);
		return true;
	}
	function handleError(callId: string): boolean {
		if (clientHandler === null) return false;
		if (!callTracker.has(callId)) return false;
		if (!callTracker.markFinished(callId)) return false;

		// Only emit fixed bounded strings — never forward arbitrary provider
		// code/message that could leak internals or exceed budget.
		clientHandler(
			Object.freeze({
				type: "error",
				requestId: callId,
				stopReason: "error",
				code: "STREAM_FAILED",
				message: "provider call failed",
			}),
		);
		return true;
	}

	function handleStringDelta(callId: string, index: number): boolean {
		if (clientHandler === null) return false;
		if (!callTracker.checkChunk(callId, index)) return false;
		return false;
	}

	// ── Application (FIFO) ────────────────────────────────────────────

	const application: ProviderRelayApplication = {
		apply(raw: unknown): Promise<ProviderRelayApplyResult> {
			if (closed) return new Promise<ProviderRelayApplyResult>((r) => r(errorResult()));

			return feeQueue.enqueue(function applyTask(): ProviderRelayApplyResult {
				const d = exactKeys(raw, new Set(["envelope"]));
				if (d === null) return errorResult();

				const envelopeValue = valueFrom(d, "envelope");
				if (envelopeValue === undefined) return errorResult();

				const decoded = decodeEnvelope(envelopeValue);
				if (!decoded.ok) return errorResult();

				const envelope = decoded.value;

				if (envelope.frame.type !== "provider_proxy") return errorResult();

				const proxyFrame = envelope.frame;

				if (proxyFrame.proxyType === "model_call_request" || proxyFrame.proxyType === "model_call_cancel") {
					return errorResult();
				}

				if (proxyFrame.proxyType === "model_call_chunk") {
					if (typeof proxyFrame.delta === "string") {
						return handleStringDelta(proxyFrame.callId, proxyFrame.index) ? appliedResult() : errorResult();
					}
					if (decodedIsRecord(proxyFrame.delta)) {
						return handleStructuredEvent(proxyFrame.callId, proxyFrame.index, proxyFrame.delta)
							? appliedResult()
							: errorResult();
					}
					return errorResult();
				}

				if (proxyFrame.proxyType === "model_call_complete") {
					return handleComplete(proxyFrame.callId, proxyFrame.result, proxyFrame.usage)
						? appliedResult()
						: errorResult();
				}

				if (proxyFrame.proxyType === "model_call_error") {
					return handleError(proxyFrame.callId) ? appliedResult() : errorResult();
				}

				return errorResult();
			});
		},

		close(): Promise<ProviderRelayCloseResult> {
			if (closePromise !== null) return closePromise;
			closed = true;

			const closeTaskPromise = feeQueue.enqueue(async function closeTask(): Promise<ProviderRelayCloseResult> {
				try {
					client.disconnect();
				} catch {
					// disconnect throw is contained
				}
				callTracker.drain();

				const sentTasks = sendObserver.drain();
				if (sentTasks.length > 0) {
					// Owned allSettled via captured then — no Promise.allSettled static call
					let remaining = sentTasks.length;
					await new Promise<void>((r) => {
						for (const o of sentTasks) {
							Reflect.apply(PROMISE_THEN, o.task, [
								() => {
									remaining--;
									if (remaining === 0) r();
								},
								() => {
									remaining--;
									if (remaining === 0) r();
								},
							]);
						}
					});
				}

				return closedResult();
			});
			// Use captured PROMISE_THEN via Reflect.apply with a properly-typed new Promise wrapper.
			// The new Promise<ProviderRelayCloseResult> establishes the correct return type without
			// any explicit type assertion. PROMISE_THEN handles fulfillment (resolveClose) and rejection
			// (closeCatch → errorResult) using the captured native then, immune to runtime monkey-patching.
			closePromise = new Promise<ProviderRelayCloseResult>((resolveClose) => {
				Reflect.apply(PROMISE_THEN, closeTaskPromise, [
					resolveClose,
					function closeCatch(): void {
						resolveClose(errorResult());
					},
				]);
			});

			return closePromise;
		},
	};

	const streamFn: StreamFn = (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions & { signal?: AbortSignal },
	): AssistantMessageEventStream => client.stream(model, context, options);

	return Object.freeze({
		ok: true,
		streamFn,
		application: Object.freeze({
			apply: application.apply,
			close: application.close,
		}),
	});
}

// ---------------------------------------------------------------------------
// Envelope builders with codec validation
// ---------------------------------------------------------------------------

function makeRequestEnvelope(req: ProxyRequestFrame): RemoteHostFrameEnvelope | undefined {
	const rawFrame = buildRawFrame(req);
	const raw: Record<string, unknown> = {
		type: "frame",
		frameId: randomUUID(),
		protocol: {
			name: REMOTE_HOST_PROTOCOL_INFO.name,
			version: REMOTE_HOST_PROTOCOL_INFO.version,
		},
		sentAt: new Date().toISOString(),
		frame: rawFrame,
	};
	const decoded = decodeEnvelope(raw);
	return decoded.ok ? decoded.value : undefined;
}

function makeCancelEnvelope(cancel: ProxyCancelFrame): RemoteHostFrameEnvelope | undefined {
	const rawFrame = buildCancelRawFrame(cancel);
	const raw: Record<string, unknown> = {
		type: "frame",
		frameId: randomUUID(),
		protocol: {
			name: REMOTE_HOST_PROTOCOL_INFO.name,
			version: REMOTE_HOST_PROTOCOL_INFO.version,
		},
		sentAt: new Date().toISOString(),
		frame: rawFrame,
	};
	const decoded = decodeEnvelope(raw);
	return decoded.ok ? decoded.value : undefined;
}
