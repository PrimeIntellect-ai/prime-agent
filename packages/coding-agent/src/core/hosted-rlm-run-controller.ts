import { types } from "node:util";
import type {
	HostedRlmAbortResult,
	HostedRlmAdmissionResult,
	HostedRlmCloseResult,
	HostedRlmObservationSnapshot,
	HostedRlmPortErrorCode,
	HostedRlmPortResult,
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmRuntimePort,
	HostedRlmTaskResult,
	HostedRlmUnsubscribeResult,
} from "./hosted-rlm-runtime-port.js";

export interface HostedRlmRunControllerInput {
	readonly port: HostedRlmRuntimePort;
	readonly expectedIdentity: HostedRlmRuntimeIdentity;
	readonly listener?: (event: HostedRlmRuntimeEvent) => void;
}

export type CreateHostedRlmRunControllerResult =
	| Readonly<{ ok: true; value: HostedRlmRunController }>
	| Readonly<{ ok: false; code: "IDENTITY_MISMATCH" | "INVALID_INPUT" | "CLEANUP_UNCERTAIN" }>;

export interface HostedRlmRunController {
	readonly identity: HostedRlmRuntimeIdentity;
	readonly start: (input: {
		prompt: string;
		spawnCode?: string;
	}) => Promise<HostedRlmPortResult<HostedRlmAdmissionResult>>;
	readonly requestAbort: () => Promise<HostedRlmPortResult<HostedRlmAbortResult>>;
	readonly finish: () => Promise<HostedRlmPortResult<HostedRlmTaskResult>>;
	readonly observe: () => Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>>;
	readonly close: () => Promise<HostedRlmPortResult<HostedRlmCloseResult>>;
}

type ExactRecord = { readonly [key: string]: unknown };
type Semantic =
	| HostedRlmAdmissionResult
	| HostedRlmAbortResult
	| HostedRlmCloseResult
	| HostedRlmObservationSnapshot
	| HostedRlmTaskResult;
type Parser<T extends Semantic> = (raw: unknown) => T | null;

const NativePromise = Promise;
const NativeThen = Promise.prototype.then;
const NativePromisePrototype = Promise.prototype;
const NativePromiseConstructorDescriptor = freezeDescriptor(
	Object.getOwnPropertyDescriptor(Promise.prototype, "constructor"),
);
const NativeSpeciesDescriptor = freezeDescriptor(Object.getOwnPropertyDescriptor(Promise, Symbol.species));

const INPUT_KEYS = Object.freeze(["port", "expectedIdentity", "listener"]);
const PORT_KEYS = Object.freeze([
	"identity",
	"startInitialTask",
	"awaitTerminal",
	"abort",
	"observe",
	"subscribe",
	"close",
]);
const IDENTITY_KEYS = Object.freeze(["childId", "sessionId", "sessionName", "modelSelector"]);
const START_KEYS = Object.freeze(["prompt", "spawnCode"]);
const SUBSCRIBE_OK_KEYS = Object.freeze(["ok", "value"]);
const UNSUBSCRIBE_KEYS = Object.freeze(["unsubscribe"]);
const RESULT_OK_KEYS = Object.freeze(["ok", "value"]);
const RESULT_ERROR_KEYS = Object.freeze(["ok", "error"]);
const ERROR_KEYS = Object.freeze(["code"]);
const STATUS_KEYS = Object.freeze(["status"]);
const CODE_KEYS = Object.freeze(["code"]);
const USAGE_KEYS = Object.freeze(["inputTokens", "outputTokens"]);
const TASK_KEYS = Object.freeze([
	"status",
	"durationMs",
	"parentReplyCount",
	"toolUseCount",
	"answerPreview",
	"errorCode",
	"usage",
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
	const record = exactRecord(raw, CODE_KEYS, false);
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
	if (record.status === "completed") {
		if (hasError) return null;
		if (answerPreview !== null && parsedUsage !== null) {
			return Object.freeze({
				status: "completed",
				durationMs,
				parentReplyCount,
				toolUseCount,
				answerPreview,
				usage: parsedUsage,
			});
		}
		if (answerPreview !== null) {
			return Object.freeze({
				status: "completed",
				durationMs,
				parentReplyCount,
				toolUseCount,
				answerPreview,
			});
		}
		if (parsedUsage !== null) {
			return Object.freeze({ status: "completed", durationMs, parentReplyCount, toolUseCount, usage: parsedUsage });
		}
		return Object.freeze({ status: "completed", durationMs, parentReplyCount, toolUseCount });
	}
	if (record.status === "cancelled") {
		if (hasAnswer || record.errorCode !== "CANCELLED") return null;
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
	if (record.status !== "error" || hasAnswer || !hasError) return null;
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

function runtimeStatus(raw: unknown): HostedRlmObservationSnapshot["status"] | null {
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
	if (record.type === "agent_start" && count === 1) return Object.freeze({ type: "agent_start" });
	if (record.type === "agent_end" && count === 1) return Object.freeze({ type: "agent_end" });
	if (record.type === "waiting" && count === 1) return Object.freeze({ type: "waiting" });
	const answerPreview = record.answerPreview;
	if (record.type === "writing" && count === 2 && boundedString(answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) {
		return Object.freeze({ type: "writing", answerPreview });
	}
	const toolName = record.toolName;
	if (record.type === "executing" && count === 2 && boundedString(toolName, MAX_TOOL_NAME_LENGTH)) {
		return Object.freeze({ type: "executing", toolName });
	}
	if (record.type !== "child_update" || (count !== 4 && count !== 5)) return null;
	const status = runtimeStatus(record.status);
	const toolUseCount = safeInteger(record.toolUseCount);
	const parentReplyCount = safeInteger(record.parentReplyCount);
	if (status === null || toolUseCount === null || parentReplyCount === null) return null;
	if (count === 5) {
		if (!boundedString(answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		return Object.freeze({ type: "child_update", status, toolUseCount, parentReplyCount, answerPreview });
	}
	return Object.freeze({ type: "child_update", status, toolUseCount, parentReplyCount });
}

function portError(raw: unknown): HostedRlmPortErrorCode | null {
	const record = exactRecord(raw, ERROR_KEYS, false);
	if (record === null) return null;
	if (record.code === "CLOSED") return "CLOSED";
	if (record.code === "INVALID_ARGUMENT") return "INVALID_ARGUMENT";
	if (record.code === "CALL_UNCERTAIN") return "CALL_UNCERTAIN";
	if (record.code === "MALFORMED_RESULT") return "MALFORMED_RESULT";
	if (record.code === "CLEANUP_UNCERTAIN") return "CLEANUP_UNCERTAIN";
	return null;
}

function publicResult<T extends Semantic>(raw: unknown, parser: Parser<T>): HostedRlmPortResult<T> | null {
	const okRecord = exactRecord(raw, RESULT_OK_KEYS, false);
	if (okRecord !== null) {
		if (okRecord.ok !== true) return null;
		const value = parser(okRecord.value);
		return value === null ? null : Object.freeze({ ok: true, value });
	}
	const errorRecord = exactRecord(raw, RESULT_ERROR_KEYS, false);
	if (errorRecord === null || errorRecord.ok !== false) return null;
	const code = portError(errorRecord.error);
	return code === null ? null : failure(code);
}

function failure<T>(code: HostedRlmPortErrorCode): HostedRlmPortResult<T> {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function resolved<T>(value: HostedRlmPortResult<T>): Promise<HostedRlmPortResult<T>> {
	return new NativePromise((resolve) => resolve(value));
}

function frozenStartInput(raw: unknown): Readonly<{ prompt: string; spawnCode?: string }> | null {
	const record = exactRecord(raw, START_KEYS, true);
	if (record === null || !boundedString(record.prompt, MAX_PROMPT_LENGTH)) return null;
	const names = Object.getOwnPropertyNames(record);
	if (names.length === 1 && !Object.hasOwn(record, "spawnCode")) return Object.freeze({ prompt: record.prompt });
	if (names.length !== 2 || !boundedString(record.spawnCode, MAX_SPAWN_CODE_LENGTH)) return null;
	return Object.freeze({ prompt: record.prompt, spawnCode: record.spawnCode });
}

function unsubscribeResult(raw: unknown): HostedRlmUnsubscribeResult | null {
	const okRecord = exactRecord(raw, Object.freeze(["ok"]), false);
	if (okRecord !== null && okRecord.ok === true) return Object.freeze({ ok: true });
	const errorRecord = exactRecord(raw, RESULT_ERROR_KEYS, false);
	if (errorRecord === null || errorRecord.ok !== false) return null;
	const nested = exactRecord(errorRecord.error, ERROR_KEYS, false);
	if (nested === null || nested.code !== "UNSUBSCRIBE_UNCERTAIN") return null;
	return Object.freeze({ ok: false, error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" }) });
}

export function createHostedRlmRunController(input: unknown): CreateHostedRlmRunControllerResult {
	const inputRecord = exactRecord(input, INPUT_KEYS, true);
	if (inputRecord === null) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	const inputNames = Object.getOwnPropertyNames(inputRecord);
	if (inputNames.length !== 2 && inputNames.length !== 3) {
		return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	}
	if (!Object.hasOwn(inputRecord, "port") || !Object.hasOwn(inputRecord, "expectedIdentity")) {
		return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	}
	const portRecord = exactRecord(inputRecord.port, PORT_KEYS, false);
	if (portRecord === null) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	const portIdentity = identity(portRecord.identity);
	const expectedIdentity = identity(inputRecord.expectedIdentity);
	if (portIdentity === null || expectedIdentity === null) {
		return Object.freeze({ ok: false, code: "INVALID_INPUT" });
	}
	const rawStart = portRecord.startInitialTask;
	const rawTerminal = portRecord.awaitTerminal;
	const rawAbort = portRecord.abort;
	const rawObserve = portRecord.observe;
	const rawSubscribe = portRecord.subscribe;
	const rawClose = portRecord.close;
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
	if (
		portIdentity.childId !== expectedIdentity.childId ||
		portIdentity.sessionId !== expectedIdentity.sessionId ||
		portIdentity.sessionName !== expectedIdentity.sessionName ||
		portIdentity.modelSelector !== expectedIdentity.modelSelector
	)
		return Object.freeze({ ok: false, code: "IDENTITY_MISMATCH" });
	let listener: ((event: HostedRlmRuntimeEvent) => void) | null = null;
	if (inputNames.length === 3) {
		if (!isFunction(inputRecord.listener)) return Object.freeze({ ok: false, code: "INVALID_INPUT" });
		const supplied = inputRecord.listener;
		listener = (event: HostedRlmRuntimeEvent): void => {
			Reflect.apply(supplied, undefined, [event]);
		};
	}

	const owner = inputRecord.port;
	const tails: Promise<unknown>[] = [];
	let started = false;
	let finishStarted = false;
	let startPromise: Promise<HostedRlmPortResult<HostedRlmAdmissionResult>> | null = null;
	let abortPromise: Promise<HostedRlmPortResult<HostedRlmAbortResult>> | null = null;
	let finishPromise: Promise<HostedRlmPortResult<HostedRlmTaskResult>> | null = null;
	let finishResolve: ((value: HostedRlmPortResult<HostedRlmTaskResult>) => void) | null = null;
	let finishSettled = false;
	let closePromise: Promise<HostedRlmPortResult<HostedRlmCloseResult>> | null = null;
	let terminalDispatched = false;
	let unsubscribe: (() => unknown) | null = null;
	let unsubscribeResultValue: HostedRlmUnsubscribeResult | null = null;
	let closed = false;
	let explicitlyClosed = false;

	function apply(method: (input: unknown) => unknown, args: unknown[]): unknown {
		return Reflect.apply(method, owner, args);
	}

	function consumeSubscription(): boolean {
		if (unsubscribeResultValue !== null) return unsubscribeResultValue.ok;
		const method = unsubscribe;
		unsubscribe = null;
		if (method === null) {
			unsubscribeResultValue = Object.freeze({ ok: false, error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" }) });
			return false;
		}
		let rawResult: unknown;
		try {
			rawResult = method();
		} catch {
			unsubscribeResultValue = Object.freeze({ ok: false, error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" }) });
			return false;
		}
		const parsed = unsubscribeResult(rawResult);
		if (parsed === null) {
			unsubscribeResultValue = Object.freeze({ ok: false, error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" }) });
			return false;
		}
		unsubscribeResultValue = parsed;
		return parsed.ok;
	}

	function settleFinish(result: HostedRlmPortResult<HostedRlmTaskResult>, requireCleanup: boolean): void {
		if (finishSettled) return;
		finishSettled = true;
		const resolve = finishResolve;
		finishResolve = null;
		if (resolve === null) return;
		if (requireCleanup && !consumeSubscription()) {
			resolve(failure("CLEANUP_UNCERTAIN"));
			return;
		}
		resolve(result);
	}

	function watch<T extends Semantic>(
		rawPromise: unknown,
		parser: Parser<T>,
		timeoutMs: number | null,
		timeoutCode: HostedRlmPortErrorCode,
		fatal: boolean,
	): Promise<HostedRlmPortResult<T>> {
		if (!isBrandedPromise(rawPromise)) {
			if (fatal) beginClose();
			return resolved(failure(timeoutCode));
		}
		const actual = rawPromise;
		let resolveOperation: (value: HostedRlmPortResult<T>) => void = () => undefined;
		const observer = new NativePromise<HostedRlmPortResult<T>>((resolve) => {
			resolveOperation = resolve;
		});
		tails.push(actual, observer);
		const acceptable = isNativePromise(actual);
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const fulfilled = (value: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			const parsed = publicResult(value, parser);
			if (parsed === null) {
				if (fatal) beginClose();
				resolveOperation(failure(timeoutCode));
				return;
			}
			resolveOperation(parsed);
		};
		const rejected = (): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			if (fatal) beginClose();
			resolveOperation(failure(timeoutCode));
		};
		const tail = safelyObservePromise(actual, fulfilled, rejected);
		if (tail !== null) tails.push(tail);
		if (!acceptable || tail === null) {
			settled = true;
			if (fatal) beginClose();
			resolveOperation(failure(timeoutCode));
			return observer;
		}
		if (timeoutMs !== null) {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				if (fatal) beginClose();
				resolveOperation(failure(timeoutCode));
			}, timeoutMs);
		}
		return observer;
	}

	function beginClose(): Promise<HostedRlmPortResult<HostedRlmCloseResult>> {
		if (closePromise !== null) return closePromise;
		let resolveClose: (value: HostedRlmPortResult<HostedRlmCloseResult>) => void = () => undefined;
		closePromise = new NativePromise((resolve) => {
			resolveClose = resolve;
		});
		const sharedClose = closePromise;
		closed = true;
		consumeSubscription();
		if (finishPromise !== null) settleFinish(failure("CLOSED"), false);
		let rawPromise: unknown;
		try {
			rawPromise = apply(closeMethod, []);
		} catch {
			resolveClose(failure("CLEANUP_UNCERTAIN"));
			return sharedClose;
		}
		const observed = watch(rawPromise, closeResult, CONTROL_TIMEOUT_MS, "CLEANUP_UNCERTAIN", false);
		const fulfilled = (result: HostedRlmPortResult<HostedRlmCloseResult>): void => resolveClose(result);
		const rejected = (): void => resolveClose(failure("CLEANUP_UNCERTAIN"));
		try {
			const tail = Reflect.apply(NativeThen, observed, [fulfilled, rejected]);
			if (isNativePromise(tail)) tails.push(observed, sharedClose, tail);
			else resolveClose(failure("CLEANUP_UNCERTAIN"));
		} catch {
			resolveClose(failure("CLEANUP_UNCERTAIN"));
		}
		return sharedClose;
	}

	let registering = true;
	let invalidEvent = false;
	const eventBuffer: unknown[] = [];
	const deliverEvent = (event: HostedRlmRuntimeEvent): void => {
		if (closed || listener === null) return;
		try {
			listener(event);
		} catch {
			beginClose();
		}
	};
	const eventListener = (rawEvent: unknown): void => {
		if (closed || invalidEvent) return;
		if (registering) {
			if (eventBuffer.length === MAX_EVENT_BUFFER) {
				invalidEvent = true;
				return;
			}
			eventBuffer.push(rawEvent);
			return;
		}
		const event = runtimeEvent(rawEvent);
		if (event === null) {
			invalidEvent = true;
			beginClose();
			return;
		}
		deliverEvent(event);
	};
	let rawSubscription: unknown;
	try {
		rawSubscription = apply(subscribeMethod, [eventListener]);
	} catch {
		registering = false;
		beginClose();
		return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
	}
	const subscriptionOuter = exactRecord(rawSubscription, SUBSCRIBE_OK_KEYS, false);
	if (subscriptionOuter === null || subscriptionOuter.ok !== true) {
		registering = false;
		beginClose();
		return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
	}
	const subscriptionInner = exactRecord(subscriptionOuter.value, UNSUBSCRIBE_KEYS, false);
	if (subscriptionInner === null || !isFunction(subscriptionInner.unsubscribe)) {
		registering = false;
		beginClose();
		return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
	}
	const tokenOwner = subscriptionOuter.value;
	const unsubscribeMethod = subscriptionInner.unsubscribe;
	unsubscribe = (): unknown => Reflect.apply(unsubscribeMethod, tokenOwner, []);
	registering = false;
	if (invalidEvent) {
		beginClose();
		return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
	}
	const decodedEvents: HostedRlmRuntimeEvent[] = [];
	for (const rawEvent of eventBuffer) {
		const event = runtimeEvent(rawEvent);
		if (event === null) {
			invalidEvent = true;
			beginClose();
			return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
		}
		decodedEvents.push(event);
	}
	for (const event of decodedEvents) {
		if (closed) break;
		deliverEvent(event);
	}
	if (closed) return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });

	function start(inputValue: {
		prompt: string;
		spawnCode?: string;
	}): Promise<HostedRlmPortResult<HostedRlmAdmissionResult>> {
		if (closed) return resolved(failure("CLOSED"));
		if (finishStarted) return resolved(failure("CALL_UNCERTAIN"));
		const validated = frozenStartInput(inputValue);
		if (validated === null) {
			beginClose();
			return resolved(failure("INVALID_ARGUMENT"));
		}
		if (started) return resolved(failure("CALL_UNCERTAIN"));
		started = true;
		let resolveStart: (value: HostedRlmPortResult<HostedRlmAdmissionResult>) => void = () => undefined;
		startPromise = new NativePromise((resolve) => {
			resolveStart = resolve;
		});
		const sharedStart = startPromise;
		tails.push(sharedStart);
		let rawPromise: unknown;
		try {
			rawPromise = apply(startMethod, [validated]);
		} catch {
			beginClose();
			resolveStart(failure("CALL_UNCERTAIN"));
			return sharedStart;
		}
		const observed = watch(rawPromise, admission, CONTROL_TIMEOUT_MS, "CALL_UNCERTAIN", true);
		const fulfilled = (result: HostedRlmPortResult<HostedRlmAdmissionResult>): void => resolveStart(result);
		const rejected = (): void => {
			beginClose();
			resolveStart(failure("CALL_UNCERTAIN"));
		};
		try {
			const tail = Reflect.apply(NativeThen, observed, [fulfilled, rejected]);
			if (isNativePromise(tail)) tails.push(observed, tail);
			else rejected();
		} catch {
			rejected();
		}
		return sharedStart;
	}

	function requestAbort(): Promise<HostedRlmPortResult<HostedRlmAbortResult>> {
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
			rawPromise = apply(abortMethod, []);
		} catch {
			beginClose();
			resolveAbort(failure("CALL_UNCERTAIN"));
			return sharedAbort;
		}
		const observed = watch(rawPromise, abortResult, CONTROL_TIMEOUT_MS, "CALL_UNCERTAIN", true);
		const fulfilled = (result: HostedRlmPortResult<HostedRlmAbortResult>): void => resolveAbort(result);
		const rejected = (): void => {
			beginClose();
			resolveAbort(failure("CALL_UNCERTAIN"));
		};
		try {
			const tail = Reflect.apply(NativeThen, observed, [fulfilled, rejected]);
			if (isNativePromise(tail)) tails.push(observed, sharedAbort, tail);
			else rejected();
		} catch {
			rejected();
		}
		return sharedAbort;
	}

	function finish(): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
		if (finishPromise !== null) return finishPromise;
		finishStarted = true;
		finishPromise = new NativePromise((resolve) => {
			finishResolve = resolve;
		});
		const sharedFinish = finishPromise;
		tails.push(sharedFinish);
		const finishWith = (result: HostedRlmPortResult<HostedRlmTaskResult>): void => {
			settleFinish(result, true);
		};
		const dispatchTerminal = (): void => {
			if (finishSettled || terminalDispatched) return;
			if (closed) {
				settleFinish(failure("CLOSED"), false);
				return;
			}
			terminalDispatched = true;
			let rawPromise: unknown;
			try {
				rawPromise = apply(terminalMethod, []);
			} catch {
				beginClose();
				finishWith(failure("CALL_UNCERTAIN"));
				return;
			}
			const terminal = watch(rawPromise, taskResult, null, "CALL_UNCERTAIN", true);
			const fulfilled = (result: HostedRlmPortResult<HostedRlmTaskResult>): void => finishWith(result);
			const rejected = (): void => {
				beginClose();
				finishWith(failure("CALL_UNCERTAIN"));
			};
			try {
				const tail = Reflect.apply(NativeThen, terminal, [fulfilled, rejected]);
				if (isNativePromise(tail)) tails.push(terminal, tail);
				else rejected();
			} catch {
				rejected();
			}
		};
		if (closed) {
			settleFinish(failure("CLOSED"), false);
			return sharedFinish;
		}
		if (!started || startPromise === null) {
			finishWith(failure("CALL_UNCERTAIN"));
			return sharedFinish;
		}
		const admissionPromise = startPromise;
		const admitted = (result: HostedRlmPortResult<HostedRlmAdmissionResult>): void => {
			if (finishSettled) return;
			if (closed) {
				settleFinish(failure("CLOSED"), false);
				return;
			}
			if (!result.ok) {
				finishWith(failure(result.error.code));
				return;
			}
			dispatchTerminal();
		};
		const rejected = (): void => {
			beginClose();
			finishWith(failure("CALL_UNCERTAIN"));
		};
		try {
			const tail = Reflect.apply(NativeThen, admissionPromise, [admitted, rejected]);
			if (isNativePromise(tail)) tails.push(admissionPromise, tail);
			else rejected();
		} catch {
			rejected();
		}
		return sharedFinish;
	}

	function observe(): Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>> {
		if (closed) return resolved(failure("CLOSED"));
		let rawPromise: unknown;
		try {
			rawPromise = apply(observeMethod, []);
		} catch {
			beginClose();
			return resolved(failure("CALL_UNCERTAIN"));
		}
		return watch(rawPromise, observation, CONTROL_TIMEOUT_MS, "CALL_UNCERTAIN", true);
	}

	function close(): Promise<HostedRlmPortResult<HostedRlmCloseResult>> {
		explicitlyClosed = true;
		return beginClose();
	}

	const controller: HostedRlmRunController = Object.freeze({
		identity: portIdentity,
		start,
		requestAbort,
		finish,
		observe,
		close,
	});
	return Object.freeze({ ok: true, value: controller });
}
