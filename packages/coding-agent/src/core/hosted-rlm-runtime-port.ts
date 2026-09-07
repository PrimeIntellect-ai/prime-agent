import { types } from "node:util";

export interface HostedRlmRuntimeIdentity {
	readonly childId: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
}

export type HostedRlmTaskStatus = "completed" | "cancelled" | "error";
export type HostedRlmRuntimeStatus = "queued" | "running" | "completed" | "cancelled" | "error";
export type HostedRlmErrorCode = "CANCELLED" | "TIMEOUT" | "ADMISSION_FAILED" | "INTERNAL_ERROR";

export interface HostedRlmAdmissionResult {
	readonly code: "ADMITTED";
}

export interface HostedRlmTaskResult {
	readonly status: HostedRlmTaskStatus;
	readonly durationMs: number;
	readonly parentReplyCount: number;
	readonly toolUseCount: number;
	readonly answerPreview?: string;
	readonly errorCode?: HostedRlmErrorCode;
	readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
	readonly lastCommittedRequestId?: string;
}

export interface HostedRlmAbortResult {
	readonly status: "aborted" | "already_terminal";
}

/** The remote runtime is revoked, drained, and disposed when this result is returned. */
export interface HostedRlmCloseResult {
	readonly status: "closed";
}

export interface HostedRlmObservationSnapshot {
	readonly status: HostedRlmRuntimeStatus;
	readonly messageCount: number;
	readonly toolUseCount: number;
	readonly agentRunning: boolean;
	readonly parentReplyCount: number;
	readonly answerPreview?: string;
	readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}

export type HostedRlmRuntimeEvent =
	| Readonly<{ type: "agent_start" }>
	| Readonly<{ type: "agent_end" }>
	| Readonly<{ type: "waiting" }>
	| Readonly<{ type: "writing"; answerPreview: string }>
	| Readonly<{ type: "executing"; toolName: string }>
	| Readonly<{
			type: "child_update";
			status: HostedRlmRuntimeStatus;
			toolUseCount: number;
			parentReplyCount: number;
			answerPreview?: string;
	  }>;

export type HostedRlmUnsubscribeResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; error: Readonly<{ code: "UNSUBSCRIBE_UNCERTAIN" }> }>;

export interface HostedRlmSubscription {
	readonly unsubscribe: () => HostedRlmUnsubscribeResult;
}

export type HostedRlmPortErrorCode =
	| "CLOSED"
	| "INVALID_ARGUMENT"
	| "CALL_UNCERTAIN"
	| "MALFORMED_RESULT"
	| "CLEANUP_UNCERTAIN";
export type HostedRlmSubscribeErrorCode = "INVALID_ARGUMENT" | "SUBSCRIBE_UNCERTAIN" | "POISONED";

export type HostedRlmPortResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: Readonly<{ code: HostedRlmPortErrorCode }> }>;

export type HostedRlmSubscribeResult =
	| Readonly<{ ok: true; value: HostedRlmSubscription }>
	| Readonly<{ ok: false; error: Readonly<{ code: HostedRlmSubscribeErrorCode }> }>;

export interface HostedRlmRuntimePort {
	readonly identity: HostedRlmRuntimeIdentity;
	readonly startInitialTask: (input: {
		prompt: string;
		spawnCode?: string;
	}) => Promise<HostedRlmPortResult<HostedRlmAdmissionResult>>;
	readonly awaitTerminal: () => Promise<HostedRlmPortResult<HostedRlmTaskResult>>;
	readonly abort: () => Promise<HostedRlmPortResult<HostedRlmAbortResult>>;
	readonly observe: () => Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>>;
	readonly subscribe: (listener: (event: HostedRlmRuntimeEvent) => void) => HostedRlmSubscribeResult;
	readonly close: () => Promise<HostedRlmPortResult<HostedRlmCloseResult>>;
}

export type HostedRlmRuntimePortFactoryResult =
	| Readonly<{ ok: true; value: HostedRlmRuntimePort }>
	| Readonly<{ ok: false; code: "INVALID_INPUT" }>;

type ExactRecord = { readonly [key: string]: unknown };
type Parser<T> = (raw: unknown) => T | null;
type PromiseTrack = {
	actual: Promise<unknown>;
	observer: Promise<unknown>;
	tail: Promise<unknown> | null;
	actualSettled: boolean;
};
type SubscriptionState = {
	consumed: boolean;
	unsubscribe: () => unknown;
	result: HostedRlmUnsubscribeResult | null;
};

const NativePromise = Promise;
const NativeThen = Promise.prototype.then;
const NativePromisePrototype = Promise.prototype;
const NativePromiseConstructorDescriptor = freezeDescriptor(
	Object.getOwnPropertyDescriptor(Promise.prototype, "constructor"),
);
const NativeSpeciesDescriptor = freezeDescriptor(Object.getOwnPropertyDescriptor(Promise, Symbol.species));

const IDENTITY_KEYS = Object.freeze(["childId", "sessionId", "sessionName", "modelSelector"]);
const PORT_KEYS = Object.freeze([
	"identity",
	"startInitialTask",
	"awaitTerminal",
	"abort",
	"observe",
	"subscribe",
	"close",
]);
const START_KEYS = Object.freeze(["prompt", "spawnCode"]);
const UNSUBSCRIBE_KEYS = Object.freeze(["unsubscribe"]);
const ADMISSION_KEYS = Object.freeze(["code"]);
const STATUS_KEYS = Object.freeze(["status"]);
const USAGE_KEYS = Object.freeze(["inputTokens", "outputTokens"]);
const TASK_KEYS = Object.freeze([
	"status",
	"durationMs",
	"parentReplyCount",
	"toolUseCount",
	"answerPreview",
	"errorCode",
	"usage",
	"lastCommittedRequestId",
]);
const OBSERVATION_KEYS = Object.freeze([
	"status",
	"messageCount",
	"toolUseCount",
	"agentRunning",
	"parentReplyCount",
	"answerPreview",
	"usage",
]);
const EVENT_KEYS = Object.freeze(["type", "answerPreview", "toolName", "status", "toolUseCount", "parentReplyCount"]);

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PROMPT_LENGTH = 32_768;
const MAX_SPAWN_CODE_LENGTH = 4_096;
const MAX_ANSWER_PREVIEW_LENGTH = 2_048;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_EVENT_BUFFER = 16;
const CONTROL_TIMEOUT_MS = 30_000;

function freezeDescriptor(raw: PropertyDescriptor | undefined): Readonly<PropertyDescriptor> | undefined {
	return raw === undefined ? undefined : Object.freeze(raw);
}

function exactRecord(raw: unknown, keys: readonly string[], allowMissing: boolean): ExactRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(descriptors);
		if (!allowMissing && names.length !== keys.length) return null;
		const copy: { [key: string]: unknown } = {};
		for (const name of names) {
			if (!keys.includes(name)) return null;
			const descriptor = descriptors[name];
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
			copy[name] = descriptor.value;
		}
		return copy;
	} catch {
		return null;
	}
}

function isFunction(raw: unknown): raw is (input: unknown) => unknown {
	if (typeof raw !== "function") return false;
	try {
		return !types.isProxy(raw);
	} catch {
		return false;
	}
}

function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.value === right.value &&
		left.get === right.get &&
		left.set === right.set &&
		left.writable === right.writable &&
		left.enumerable === right.enumerable &&
		left.configurable === right.configurable
	);
}

function isBrandedPromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return !types.isProxy(raw) && types.isPromise(raw);
	} catch {
		return false;
	}
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (!isBrandedPromise(raw)) return false;
	try {
		if (Object.getPrototypeOf(raw) !== NativePromisePrototype) return false;
		if (!Object.isExtensible(raw)) return false;
		if (Object.getOwnPropertyNames(raw).length !== 0) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		if (
			!sameDescriptor(
				Object.getOwnPropertyDescriptor(NativePromisePrototype, "constructor"),
				NativePromiseConstructorDescriptor,
			)
		)
			return false;
		if (!sameDescriptor(Object.getOwnPropertyDescriptor(NativePromise, Symbol.species), NativeSpeciesDescriptor)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Promise.prototype.then reads `actual.constructor` before it installs a rejection
 * handler. Temporarily normalizing that property is the only local way to observe a
 * branded subclass or configurable constructor accessor without running supplier code.
 * A supplier that returns an already-rejected non-normalizable Promise, for example, one
 * with a non-configurable hostile own constructor or an untrusted inherited constructor
 * path, must attach its own rejection handler before returning it. JavaScript has no
 * local API that can do so without invoking the hostile constructor path.
 */
function safelyObservePromise(
	actual: Promise<unknown>,
	fulfilled: (value: unknown) => void,
	rejected: () => void,
): Promise<unknown> | null {
	let original: PropertyDescriptor | undefined;
	let normalized = false;
	try {
		if (
			!sameDescriptor(
				Object.getOwnPropertyDescriptor(NativePromisePrototype, "constructor"),
				NativePromiseConstructorDescriptor,
			) ||
			!sameDescriptor(Object.getOwnPropertyDescriptor(NativePromise, Symbol.species), NativeSpeciesDescriptor)
		)
			return null;
		original = Object.getOwnPropertyDescriptor(actual, "constructor");
		if (original === undefined) {
			if (!Object.isExtensible(actual)) {
				if (Object.getPrototypeOf(actual) !== NativePromisePrototype) return null;
			} else {
				Object.defineProperty(actual, "constructor", {
					value: NativePromise,
					writable: true,
					enumerable: false,
					configurable: true,
				});
				normalized = true;
			}
		} else if (original.configurable) {
			Object.defineProperty(actual, "constructor", {
				value: NativePromise,
				writable: true,
				enumerable: false,
				configurable: true,
			});
			normalized = true;
		} else if (!("value" in original) || original.value !== NativePromise) {
			return null;
		}
		const tail = Reflect.apply(NativeThen, actual, [fulfilled, rejected]);
		if (normalized) {
			if (original === undefined) Reflect.deleteProperty(actual, "constructor");
			else Object.defineProperty(actual, "constructor", original);
			normalized = false;
		}
		return isBrandedPromise(tail) ? tail : null;
	} catch {
		if (normalized) {
			try {
				if (original === undefined) Reflect.deleteProperty(actual, "constructor");
				else Object.defineProperty(actual, "constructor", original);
			} catch {
				return null;
			}
		}
		return null;
	}
}

function boundedIdentifier(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_IDENTIFIER_LENGTH) return false;
	return /^[a-zA-Z0-9_./:-]{1,128}$/.test(raw);
}

function boundedString(raw: unknown, maximum: number): raw is string {
	return typeof raw === "string" && raw.length > 0 && raw.length <= maximum;
}

function boundedPrintableAscii(raw: unknown): raw is string {
	return typeof raw === "string" && /^[!-~]{1,128}$/.test(raw);
}

function safeInteger(raw: unknown): number | null {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
	return raw;
}

function identity(raw: unknown): HostedRlmRuntimeIdentity | null {
	const record = exactRecord(raw, IDENTITY_KEYS, false);
	if (record === null) return null;
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
	return Object.freeze({ childId, sessionId, sessionName, modelSelector });
}

function usage(raw: unknown): Readonly<{ inputTokens: number; outputTokens: number }> | null {
	const record = exactRecord(raw, USAGE_KEYS, false);
	if (record === null) return null;
	const inputTokens = safeInteger(record.inputTokens);
	const outputTokens = safeInteger(record.outputTokens);
	if (inputTokens === null || outputTokens === null) return null;
	return Object.freeze({ inputTokens, outputTokens });
}

function admission(raw: unknown): HostedRlmAdmissionResult | null {
	const record = exactRecord(raw, ADMISSION_KEYS, false);
	if (record === null || record.code !== "ADMITTED") return null;
	return Object.freeze({ code: "ADMITTED" });
}

function abortResult(raw: unknown): HostedRlmAbortResult | null {
	const record = exactRecord(raw, STATUS_KEYS, false);
	if (record === null) return null;
	if (record.status === "aborted") return Object.freeze({ status: "aborted" });
	if (record.status === "already_terminal") return Object.freeze({ status: "already_terminal" });
	return null;
}

function closeResult(raw: unknown): HostedRlmCloseResult | null {
	const record = exactRecord(raw, STATUS_KEYS, false);
	if (record === null || record.status !== "closed") return null;
	return Object.freeze({ status: "closed" });
}

function taskResult(raw: unknown): HostedRlmTaskResult | null {
	const record = exactRecord(raw, TASK_KEYS, true);
	if (record === null) return null;
	const durationMs = safeInteger(record.durationMs);
	const parentReplyCount = safeInteger(record.parentReplyCount);
	const toolUseCount = safeInteger(record.toolUseCount);
	if (durationMs === null || parentReplyCount === null || toolUseCount === null) return null;
	const hasAnswer = Object.hasOwn(record, "answerPreview");
	let answerPreview: string | null = null;
	if (hasAnswer) {
		const candidate = record.answerPreview;
		if (!boundedString(candidate, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		answerPreview = candidate;
	}
	const hasError = Object.hasOwn(record, "errorCode");
	const hasUsage = Object.hasOwn(record, "usage");
	let parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | null = null;
	if (hasUsage) {
		parsedUsage = usage(record.usage);
		if (parsedUsage === null) return null;
	}
	const hasLastCommittedRequestId = Object.hasOwn(record, "lastCommittedRequestId");
	let lastCommittedRequestId: string | null = null;
	if (hasLastCommittedRequestId) {
		const candidate = record.lastCommittedRequestId;
		if (!boundedPrintableAscii(candidate)) return null;
		lastCommittedRequestId = candidate;
	}
	if (record.status === "completed") {
		if (hasError) return null;
		const result: {
			status: "completed";
			durationMs: number;
			parentReplyCount: number;
			toolUseCount: number;
			answerPreview?: string;
			usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
			lastCommittedRequestId?: string;
		} = { status: "completed", durationMs, parentReplyCount, toolUseCount };
		if (answerPreview !== null) result.answerPreview = answerPreview;
		if (parsedUsage !== null) result.usage = parsedUsage;
		if (lastCommittedRequestId !== null) result.lastCommittedRequestId = lastCommittedRequestId;
		return Object.freeze(result);
	}
	if (record.status === "cancelled") {
		if (hasAnswer || hasLastCommittedRequestId || record.errorCode !== "CANCELLED") return null;
		if (parsedUsage !== null) {
			return Object.freeze({
				status: "cancelled",
				durationMs,
				parentReplyCount,
				toolUseCount,
				errorCode: "CANCELLED",
				usage: parsedUsage,
			});
		}
		return Object.freeze({
			status: "cancelled",
			durationMs,
			parentReplyCount,
			toolUseCount,
			errorCode: "CANCELLED",
		});
	}
	if (record.status !== "error" || hasAnswer || hasLastCommittedRequestId || !hasError) return null;
	if (
		record.errorCode !== "TIMEOUT" &&
		record.errorCode !== "ADMISSION_FAILED" &&
		record.errorCode !== "INTERNAL_ERROR"
	)
		return null;
	if (parsedUsage !== null) {
		return Object.freeze({
			status: "error",
			durationMs,
			parentReplyCount,
			toolUseCount,
			errorCode: record.errorCode,
			usage: parsedUsage,
		});
	}
	return Object.freeze({
		status: "error",
		durationMs,
		parentReplyCount,
		toolUseCount,
		errorCode: record.errorCode,
	});
}

function runtimeStatus(raw: unknown): HostedRlmRuntimeStatus | null {
	if (raw === "queued") return "queued";
	if (raw === "running") return "running";
	if (raw === "completed") return "completed";
	if (raw === "cancelled") return "cancelled";
	if (raw === "error") return "error";
	return null;
}

function observation(raw: unknown): HostedRlmObservationSnapshot | null {
	const record = exactRecord(raw, OBSERVATION_KEYS, true);
	if (record === null) return null;
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
	if (status !== "running" && record.agentRunning) return null;
	const hasAnswer = Object.hasOwn(record, "answerPreview");
	let answerPreview: string | null = null;
	if (hasAnswer) {
		const candidate = record.answerPreview;
		if (!boundedString(candidate, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		answerPreview = candidate;
	}
	const hasUsage = Object.hasOwn(record, "usage");
	let parsedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | null = null;
	if (hasUsage) {
		parsedUsage = usage(record.usage);
		if (parsedUsage === null) return null;
	}
	if (answerPreview !== null && parsedUsage !== null) {
		return Object.freeze({
			status,
			messageCount,
			toolUseCount,
			agentRunning: record.agentRunning,
			parentReplyCount,
			answerPreview,
			usage: parsedUsage,
		});
	}
	if (answerPreview !== null) {
		return Object.freeze({
			status,
			messageCount,
			toolUseCount,
			agentRunning: record.agentRunning,
			parentReplyCount,
			answerPreview,
		});
	}
	if (parsedUsage !== null) {
		return Object.freeze({
			status,
			messageCount,
			toolUseCount,
			agentRunning: record.agentRunning,
			parentReplyCount,
			usage: parsedUsage,
		});
	}
	return Object.freeze({
		status,
		messageCount,
		toolUseCount,
		agentRunning: record.agentRunning,
		parentReplyCount,
	});
}

function runtimeEvent(raw: unknown): HostedRlmRuntimeEvent | null {
	const record = exactRecord(raw, EVENT_KEYS, true);
	if (record === null || typeof record.type !== "string") return null;
	const count = Object.getOwnPropertyNames(record).length;
	const answerPreview = record.answerPreview;
	if (record.type === "agent_start" && count === 1) return Object.freeze({ type: "agent_start" });
	if (record.type === "agent_end" && count === 1) return Object.freeze({ type: "agent_end" });
	if (record.type === "waiting" && count === 1) return Object.freeze({ type: "waiting" });
	if (record.type === "writing" && count === 2 && boundedString(answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) {
		return Object.freeze({ type: "writing", answerPreview });
	}
	if (record.type === "executing" && count === 2 && boundedString(record.toolName, MAX_TOOL_NAME_LENGTH)) {
		return Object.freeze({ type: "executing", toolName: record.toolName });
	}
	if (record.type !== "child_update" || (count !== 4 && count !== 5)) return null;
	const status = runtimeStatus(record.status);
	const toolUseCount = safeInteger(record.toolUseCount);
	const parentReplyCount = safeInteger(record.parentReplyCount);
	if (status === null || toolUseCount === null || parentReplyCount === null) return null;
	if (count === 5) {
		if (!boundedString(answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		return Object.freeze({
			type: "child_update",
			status,
			toolUseCount,
			parentReplyCount,
			answerPreview,
		});
	}
	return Object.freeze({ type: "child_update", status, toolUseCount, parentReplyCount });
}

function success<T>(value: T): HostedRlmPortResult<T> {
	return Object.freeze({ ok: true, value });
}

function failure<T>(code: HostedRlmPortErrorCode): HostedRlmPortResult<T> {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function subscribeFailure(code: HostedRlmSubscribeErrorCode): HostedRlmSubscribeResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function unsubscribeFailure(): HostedRlmUnsubscribeResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" }) });
}

function resolved<T>(value: HostedRlmPortResult<T>): Promise<HostedRlmPortResult<T>> {
	return new NativePromise((resolve) => resolve(value));
}

function frozenStartInput(raw: unknown): Readonly<{ prompt: string; spawnCode?: string }> | null {
	const record = exactRecord(raw, START_KEYS, true);
	if (record === null || !boundedString(record.prompt, MAX_PROMPT_LENGTH)) return null;
	const names = Object.getOwnPropertyNames(record);
	if (names.length !== 1 && names.length !== 2) return null;
	if (names.length === 2) {
		if (!Object.hasOwn(record, "spawnCode") || !boundedString(record.spawnCode, MAX_SPAWN_CODE_LENGTH)) return null;
		return Object.freeze({ prompt: record.prompt, spawnCode: record.spawnCode });
	}
	if (Object.hasOwn(record, "spawnCode")) return null;
	return Object.freeze({ prompt: record.prompt });
}

function rawUnsubscribe(raw: unknown): (() => unknown) | null {
	const record = exactRecord(raw, UNSUBSCRIBE_KEYS, false);
	if (record === null || !isFunction(record.unsubscribe)) return null;
	const method = record.unsubscribe;
	return (): unknown => Reflect.apply(method, raw, []);
}

function rawUnsubscribeCertain(raw: unknown): boolean {
	const record = exactRecord(raw, STATUS_KEYS, false);
	return record !== null && record.status === "unsubscribed";
}

export function createHostedRlmRuntimePort(raw: unknown): HostedRlmRuntimePortFactoryResult {
	const record = exactRecord(raw, PORT_KEYS, false);
	if (record === null) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	const portIdentity = identity(record.identity);
	if (portIdentity === null) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	const rawStart = record.startInitialTask;
	const rawTerminal = record.awaitTerminal;
	const rawAbort = record.abort;
	const rawObserve = record.observe;
	const rawSubscribe = record.subscribe;
	const rawClose = record.close;
	if (
		!isFunction(rawStart) ||
		!isFunction(rawTerminal) ||
		!isFunction(rawAbort) ||
		!isFunction(rawObserve) ||
		!isFunction(rawSubscribe) ||
		!isFunction(rawClose)
	)
		return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	const startMethod = rawStart;
	const terminalMethod = rawTerminal;
	const abortMethod = rawAbort;
	const observeMethod = rawObserve;
	const subscribeMethod = rawSubscribe;
	const closeMethod = rawClose;

	const tracks: PromiseTrack[] = [];
	let pendingActuals = 0;
	let revoked = false;
	let explicitlyClosed = false;
	let poisoned = false;
	let started = false;
	let admissionSettled = false;
	let admissionSucceeded = false;
	let admissionPromise: Promise<HostedRlmPortResult<HostedRlmAdmissionResult>> | null = null;
	let terminalPromise: Promise<HostedRlmPortResult<HostedRlmTaskResult>> | null = null;
	let terminalResolve: ((value: HostedRlmPortResult<HostedRlmTaskResult>) => void) | null = null;
	let terminalDispatch: (() => void) | null = null;
	let terminalDispatched = false;
	let abortPromise: Promise<HostedRlmPortResult<HostedRlmAbortResult>> | null = null;
	let activeSubscription: SubscriptionState | null = null;
	let closePromise: Promise<HostedRlmPortResult<HostedRlmCloseResult>> | null = null;
	let closeResolve: ((value: HostedRlmPortResult<HostedRlmCloseResult>) => void) | null = null;
	let closeSettled = false;
	let closeRemoteSucceeded = false;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function bindCall(method: (input: unknown) => unknown, input: unknown[]): unknown {
		return Reflect.apply(method, raw, input);
	}

	function revokeSubscription(): boolean {
		const state = activeSubscription;
		if (state === null) return true;
		if (state.consumed) return state.result !== null && state.result.ok;
		state.consumed = true;
		let result: unknown;
		try {
			result = state.unsubscribe();
		} catch {
			state.result = unsubscribeFailure();
			return false;
		}
		if (rawUnsubscribeCertain(result)) {
			state.result = Object.freeze({ ok: true });
			activeSubscription = null;
			return true;
		}
		state.result = unsubscribeFailure();
		return false;
	}

	function settleClose(result: HostedRlmPortResult<HostedRlmCloseResult>): void {
		if (closeSettled) return;
		closeSettled = true;
		if (closeTimer !== null) clearTimeout(closeTimer);
		const resolve = closeResolve;
		closeResolve = null;
		if (resolve !== null) resolve(result);
	}

	function checkCloseDrain(): void {
		if (!closeRemoteSucceeded || pendingActuals !== 0) return;
		settleClose(success(Object.freeze({ status: "closed" })));
	}

	function beginClose(): Promise<HostedRlmPortResult<HostedRlmCloseResult>> {
		if (closePromise !== null) return closePromise;
		closePromise = new NativePromise((resolve) => {
			closeResolve = resolve;
		});
		revoked = true;
		terminalDispatch = null;
		if (!terminalDispatched && terminalResolve !== null) {
			const resolve = terminalResolve;
			terminalResolve = null;
			resolve(failure("CLOSED"));
		}
		revokeSubscription();
		closeTimer = setTimeout(() => settleClose(failure("CLEANUP_UNCERTAIN")), CONTROL_TIMEOUT_MS);
		let rawPromise: unknown;
		try {
			rawPromise = bindCall(closeMethod, []);
		} catch {
			settleClose(failure("CLEANUP_UNCERTAIN"));
			return closePromise;
		}
		if (!isBrandedPromise(rawPromise)) {
			settleClose(failure("CLEANUP_UNCERTAIN"));
			return closePromise;
		}
		const actual = rawPromise;
		const track: PromiseTrack = { actual, observer: closePromise, tail: null, actualSettled: false };
		tracks.push(track);
		const acceptable = isNativePromise(actual);
		const fulfilled = (value: unknown): void => {
			track.actualSettled = true;
			if (!acceptable) return;
			const parsed = closeResult(value);
			if (parsed === null) {
				settleClose(failure("CLEANUP_UNCERTAIN"));
				return;
			}
			closeRemoteSucceeded = true;
			checkCloseDrain();
		};
		const rejected = (): void => {
			track.actualSettled = true;
			settleClose(failure("CLEANUP_UNCERTAIN"));
		};
		const tail = safelyObservePromise(actual, fulfilled, rejected);
		if (tail === null) settleClose(failure("CLEANUP_UNCERTAIN"));
		else track.tail = tail;
		if (!acceptable) settleClose(failure("CLEANUP_UNCERTAIN"));

		return closePromise;
	}

	function poison(): void {
		poisoned = true;
		beginClose();
	}

	function watch<T>(
		rawPromise: unknown,
		parser: Parser<T>,
		timeoutMs: number | null,
	): Promise<HostedRlmPortResult<T>> {
		if (!isBrandedPromise(rawPromise)) {
			poison();
			return resolved(failure("CALL_UNCERTAIN"));
		}
		const actual = rawPromise;
		let resolveOperation: (value: HostedRlmPortResult<T>) => void = () => undefined;
		const observer = new NativePromise<HostedRlmPortResult<T>>((resolve) => {
			resolveOperation = resolve;
		});
		const track: PromiseTrack = { actual, observer, tail: null, actualSettled: false };
		tracks.push(track);
		pendingActuals += 1;
		const acceptable = isNativePromise(actual);
		let operationSettled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finishActual = (): void => {
			if (track.actualSettled) return;
			track.actualSettled = true;
			pendingActuals -= 1;
			checkCloseDrain();
		};
		const fulfilled = (value: unknown): void => {
			finishActual();
			if (operationSettled) return;
			operationSettled = true;
			if (timer !== null) clearTimeout(timer);
			let parsed: T | null;
			try {
				parsed = parser(value);
			} catch {
				parsed = null;
			}
			if (parsed === null) {
				poison();
				resolveOperation(failure("MALFORMED_RESULT"));
				return;
			}
			resolveOperation(success(parsed));
		};
		const rejected = (): void => {
			finishActual();
			if (operationSettled) return;
			operationSettled = true;
			if (timer !== null) clearTimeout(timer);
			poison();
			resolveOperation(failure("CALL_UNCERTAIN"));
		};
		const tail = safelyObservePromise(actual, fulfilled, rejected);
		if (tail !== null) track.tail = tail;
		if (!acceptable || tail === null) {
			operationSettled = true;
			poison();
			resolveOperation(failure("CALL_UNCERTAIN"));
			return observer;
		}
		if (timeoutMs !== null) {
			timer = setTimeout(() => {
				if (operationSettled) return;
				operationSettled = true;
				poison();
				resolveOperation(failure("CALL_UNCERTAIN"));
			}, timeoutMs);
		}
		return observer;
	}

	function startInitialTask(input: {
		prompt: string;
		spawnCode?: string;
	}): Promise<HostedRlmPortResult<HostedRlmAdmissionResult>> {
		if (revoked) return resolved(failure("CLOSED"));
		const validated = frozenStartInput(input);
		if (validated === null) {
			poison();
			return resolved(failure("INVALID_ARGUMENT"));
		}
		if (started) return resolved(failure("CALL_UNCERTAIN"));
		started = true;
		let rawPromise: unknown;
		try {
			rawPromise = bindCall(startMethod, [validated]);
		} catch {
			poison();
			admissionSettled = true;
			return resolved(failure("CALL_UNCERTAIN"));
		}
		admissionPromise = watch(rawPromise, admission, CONTROL_TIMEOUT_MS);
		const observer = admissionPromise;
		const fulfilled = (result: HostedRlmPortResult<HostedRlmAdmissionResult>): void => {
			admissionSettled = true;
			admissionSucceeded = result.ok;
			if (revoked) return;
			const dispatch = terminalDispatch;
			terminalDispatch = null;
			if (dispatch !== null) dispatch();
		};
		const rejected = (): void => {
			admissionSettled = true;
			admissionSucceeded = false;
			poison();
			if (revoked) return;
			const dispatch = terminalDispatch;
			terminalDispatch = null;
			if (dispatch !== null) dispatch();
		};
		try {
			const tail = Reflect.apply(NativeThen, observer, [fulfilled, rejected]);
			if (isNativePromise(tail)) {
				tracks.push({ actual: observer, observer, tail, actualSettled: false });
			} else {
				poison();
			}
		} catch {
			poison();
		}
		return admissionPromise;
	}

	function awaitTerminal(): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
		if (terminalPromise !== null) return terminalPromise;
		if (revoked) return resolved(failure("CLOSED"));
		if (!started) return resolved(failure("CALL_UNCERTAIN"));
		terminalPromise = new NativePromise((resolve) => {
			terminalResolve = resolve;
		});
		const terminalObserver = terminalPromise;
		const dispatch = (): void => {
			const resolveTerminal = terminalResolve;
			if (resolveTerminal === null) return;
			if (revoked) {
				terminalResolve = null;
				resolveTerminal(failure("CLOSED"));
				return;
			}
			if (!admissionSucceeded) {
				terminalResolve = null;
				resolveTerminal(failure("CALL_UNCERTAIN"));
				return;
			}
			terminalDispatched = true;
			let rawPromise: unknown;
			try {
				rawPromise = bindCall(terminalMethod, []);
			} catch {
				poison();
				resolveTerminal(failure("CALL_UNCERTAIN"));
				return;
			}
			const observed = watch(rawPromise, taskResult, null);
			const fulfilled = (result: HostedRlmPortResult<HostedRlmTaskResult>): void => resolveTerminal(result);
			const rejected = (): void => {
				poison();
				resolveTerminal(failure("CALL_UNCERTAIN"));
			};
			try {
				const tail = Reflect.apply(NativeThen, observed, [fulfilled, rejected]);
				if (isNativePromise(tail)) {
					tracks.push({ actual: observed, observer: terminalObserver, tail, actualSettled: false });
				} else {
					poison();
					resolveTerminal(failure("CALL_UNCERTAIN"));
				}
			} catch {
				poison();
				resolveTerminal(failure("CALL_UNCERTAIN"));
			}
		};
		if (admissionSettled) dispatch();
		else terminalDispatch = dispatch;
		return terminalPromise;
	}

	function abort(): Promise<HostedRlmPortResult<HostedRlmAbortResult>> {
		if (abortPromise !== null) return abortPromise;
		if (explicitlyClosed) return resolved(failure("CLOSED"));
		if (!started) return resolved(failure("CALL_UNCERTAIN"));
		let resolveAbort: (value: HostedRlmPortResult<HostedRlmAbortResult>) => void = () => undefined;
		abortPromise = new NativePromise((resolve) => {
			resolveAbort = resolve;
		});
		const sharedAbort = abortPromise;
		let rawPromise: unknown;
		try {
			rawPromise = bindCall(abortMethod, []);
		} catch {
			poison();
			resolveAbort(failure("CALL_UNCERTAIN"));
			return sharedAbort;
		}
		const observed = watch(rawPromise, abortResult, CONTROL_TIMEOUT_MS);
		const fulfilled = (result: HostedRlmPortResult<HostedRlmAbortResult>): void => resolveAbort(result);
		const rejected = (): void => {
			poison();
			resolveAbort(failure("CALL_UNCERTAIN"));
		};
		try {
			const tail = Reflect.apply(NativeThen, observed, [fulfilled, rejected]);
			if (isNativePromise(tail)) {
				tracks.push({ actual: observed, observer: sharedAbort, tail, actualSettled: false });
			} else {
				poison();
				resolveAbort(failure("CALL_UNCERTAIN"));
			}
		} catch {
			poison();
			resolveAbort(failure("CALL_UNCERTAIN"));
		}
		return sharedAbort;
	}

	function observe(): Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>> {
		if (revoked) return resolved(failure("CLOSED"));
		let rawPromise: unknown;
		try {
			rawPromise = bindCall(observeMethod, []);
		} catch {
			poison();
			return resolved(failure("CALL_UNCERTAIN"));
		}
		return watch(rawPromise, observation, CONTROL_TIMEOUT_MS);
	}

	function subscribe(listener: (event: HostedRlmRuntimeEvent) => void): HostedRlmSubscribeResult {
		if (revoked || poisoned) return subscribeFailure("POISONED");
		if (!isFunction(listener)) {
			poison();
			return subscribeFailure("INVALID_ARGUMENT");
		}
		if (activeSubscription !== null) return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		let registering = true;
		let invalid = false;
		const buffered: unknown[] = [];
		let state: SubscriptionState | null = null;
		const callback = (rawEvent: unknown): void => {
			if (revoked || invalid) return;
			if (state !== null && state.consumed) return;
			if (registering) {
				if (buffered.length === MAX_EVENT_BUFFER) {
					invalid = true;
					return;
				}
				buffered.push(rawEvent);
				return;
			}
			const event = runtimeEvent(rawEvent);
			if (event === null) {
				poison();
				return;
			}
			try {
				Reflect.apply(listener, undefined, [event]);
			} catch {
				poison();
			}
		};
		let rawToken: unknown;
		try {
			rawToken = bindCall(subscribeMethod, [callback]);
		} catch {
			registering = false;
			poison();
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		registering = false;
		const unsubscribe = rawUnsubscribe(rawToken);
		if (unsubscribe === null) {
			poison();
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		state = { consumed: false, unsubscribe, result: null };
		activeSubscription = state;
		if (invalid) {
			poison();
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		const decoded: HostedRlmRuntimeEvent[] = [];
		for (const rawEvent of buffered) {
			const event = runtimeEvent(rawEvent);
			if (event === null) {
				poison();
				return subscribeFailure("SUBSCRIBE_UNCERTAIN");
			}
			decoded.push(event);
		}
		for (const event of decoded) {
			if (revoked || state.consumed) break;
			try {
				Reflect.apply(listener, undefined, [event]);
			} catch {
				poison();
			}
		}
		if (revoked) return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		const publicUnsubscribe = (): HostedRlmUnsubscribeResult => {
			if (state.consumed) return state.result === null ? unsubscribeFailure() : state.result;
			const certain = revokeSubscription();
			if (!certain) poisoned = true;
			return state.result === null ? unsubscribeFailure() : state.result;
		};
		return Object.freeze({
			ok: true,
			value: Object.freeze({ unsubscribe: publicUnsubscribe }),
		});
	}

	function close(): Promise<HostedRlmPortResult<HostedRlmCloseResult>> {
		explicitlyClosed = true;
		return beginClose();
	}

	const port: HostedRlmRuntimePort = Object.freeze({
		identity: portIdentity,
		startInitialTask,
		awaitTerminal,
		abort,
		observe,
		subscribe,
		close,
	});
	return Object.freeze({ ok: true, value: port });
}
