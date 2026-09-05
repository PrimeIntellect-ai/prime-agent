import { types } from "node:util";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HostedRlmRuntimeIdentity {
	readonly childId: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
}

export type HostedRlmTaskStatus = "completed" | "cancelled" | "error";

export type HostedRlmRuntimeStatus = "queued" | "running" | "completed" | "cancelled" | "error";

export type HostedRlmErrorCode = "CANCELLED" | "TIMEOUT" | "ADMISSION_FAILED" | "INTERNAL_ERROR";

export interface HostedRlmTaskResult {
	readonly status: HostedRlmTaskStatus;
	readonly durationMs: number;
	readonly parentReplyCount: number;
	readonly toolUseCount: number;
	readonly answerPreview?: string;
	readonly errorCode?: HostedRlmErrorCode;
	readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}

export interface HostedRlmAbortResult {
	readonly status: "aborted" | "already_terminal";
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

export interface HostedRlmUnsubscribeOk {
	readonly ok: true;
}

export interface HostedRlmUnsubscribeError {
	readonly ok: false;
	readonly error: Readonly<{ code: "UNSUBSCRIBE_UNCERTAIN" }>;
}

export type HostedRlmUnsubscribeResult = HostedRlmUnsubscribeOk | HostedRlmUnsubscribeError;

export interface HostedRlmSubscription {
	readonly unsubscribe: () => HostedRlmUnsubscribeResult;
}

// Port result types -- never fabricate semantic values on error.

export type HostedRlmPortErrorCode = "CLOSED" | "INVALID_ARGUMENT" | "CALL_UNCERTAIN" | "MALFORMED_RESULT";
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
	}) => Promise<HostedRlmPortResult<HostedRlmTaskResult>>;
	readonly abort: () => Promise<HostedRlmPortResult<HostedRlmAbortResult>>;
	readonly observe: () => Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>>;
	readonly subscribe: (listener: (event: HostedRlmRuntimeEvent) => void) => HostedRlmSubscribeResult;
}

export type HostedRlmRuntimePortFactoryResult =
	| Readonly<{ ok: true; value: HostedRlmRuntimePort }>
	| Readonly<{ ok: false; code: "INVALID_INPUT" }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_KEYS = new Set(["childId", "sessionId", "sessionName", "modelSelector"]);
const FACTORY_KEYS = new Set(["identity", "startInitialTask", "abort", "observe", "subscribe"]);
const UNSUBSCRIBE_KEYS = new Set(["unsubscribe"]);

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PROMPT_LENGTH = 32_768;
const MAX_SPAWN_CODE_LENGTH = 4_096;
const MAX_ANSWER_PREVIEW_LENGTH = 2_048;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_SYNC_BUFFER = 16;

const OPERATION_TIMEOUT_MS = 30_000;

const VALID_TASK_STATUSES = new Set(["completed", "cancelled", "error"]);
const VALID_RUNTIME_STATUSES = new Set(["queued", "running", "completed", "cancelled", "error"]);

const INVALID_INPUT: HostedRlmRuntimePortFactoryResult = Object.freeze({
	ok: false as const,
	code: "INVALID_INPUT" as const,
});

function portFailure<T>(code: HostedRlmPortErrorCode): HostedRlmPortResult<T> {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

const ERR_SUB_INVALID_ARGUMENT: HostedRlmSubscribeResult = Object.freeze({
	ok: false as const,
	error: Object.freeze({ code: "INVALID_ARGUMENT" as const }),
});
const ERR_SUB_UNCERTAIN: HostedRlmSubscribeResult = Object.freeze({
	ok: false as const,
	error: Object.freeze({ code: "SUBSCRIBE_UNCERTAIN" as const }),
});
const ERR_SUB_POISONED: HostedRlmSubscribeResult = Object.freeze({
	ok: false as const,
	error: Object.freeze({ code: "POISONED" as const }),
});

const UNSUBSCRIBE_OK: HostedRlmUnsubscribeResult = Object.freeze({ ok: true as const });
const UNSUBSCRIBE_UNCERTAIN: HostedRlmUnsubscribeResult = Object.freeze({
	ok: false as const,
	error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" as const }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBoundedPrintableIdentifier(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
	return /^[a-zA-Z0-9_./:-]{1,128}$/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	if (typeof value !== "string") return false;
	return value.length > 0 && value.length <= maxLength;
}

/** Validate that raw is an own-enumerable plain Object with exact key set, no Proxy, no accessors, no symbols. */
function exactRecord(raw: unknown, keys: ReadonlySet<string>): { readonly [key: string]: unknown } | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size) return null;
		if (names.some((name) => !keys.has(name))) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const d = descs[name];
			if (!d || !("value" in d) || !d.enumerable) return null;
		}
		const result: { [key: string]: unknown } = {};
		for (const name of names) result[name] = descs[name].value;
		return result;
	} catch {
		return null;
	}
}

function isNativePromise(value: unknown): value is Promise<unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (types.isProxy(value)) return false;
	} catch {
		return false;
	}
	if (!types.isPromise(value)) return false;
	try {
		if (Object.getPrototypeOf(value) !== Promise.prototype) return false;
	} catch {
		return false;
	}
	const names = Object.getOwnPropertyNames(value);
	if (names.length > 0) return false;
	const symbols = Object.getOwnPropertySymbols(value);
	if (symbols.length > 0) return false;
	return true;
}

function isNonProxyFunction(value: unknown): value is (...args: unknown[]) => unknown {
	if (typeof value !== "function") return false;
	try {
		return !types.isProxy(value);
	} catch {
		return false;
	}
}

function isNonProxyObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null) return false;
	try {
		return !types.isProxy(value);
	} catch {
		return false;
	}
}

/** Extract exact identity from a validated exact record's identity field. */
function extractIdentity(rawIdentity: unknown): HostedRlmRuntimeIdentity | null {
	const idRecord = exactRecord(rawIdentity, IDENTITY_KEYS);
	if (!idRecord) return null;
	const childId = idRecord.childId;
	const sessionId = idRecord.sessionId;
	const sessionName = idRecord.sessionName;
	const modelSelector = idRecord.modelSelector;
	if (
		!isBoundedPrintableIdentifier(childId) ||
		!isBoundedPrintableIdentifier(sessionId) ||
		!isBoundedPrintableIdentifier(sessionName) ||
		!isBoundedPrintableIdentifier(modelSelector)
	)
		return null;
	return Object.freeze({ childId, sessionId, sessionName, modelSelector });
}

/** Extract exact named unsubscribe as bound function to ORIGINAL raw token owner. */
function extractUnsubscribeToken(rawToken: unknown): (() => unknown) | null {
	const record = exactRecord(rawToken, UNSUBSCRIBE_KEYS);
	if (!record) return null;
	const fn = record.unsubscribe;
	if (!isNonProxyFunction(fn)) return null;
	return (): unknown => Reflect.apply(fn, rawToken, []);
}

/** Try to read a {status:string} from a record (allows extra keys for remote results). */
function tryStatus(raw: unknown, allowed: ReadonlySet<string>): string | null {
	const record = exactRecord(raw, new Set(["status"]));
	if (!record) return null;
	const s = record.status;
	return typeof s === "string" && allowed.has(s) ? s : null;
}

function trySafeInt(raw: unknown): number | null {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
	return raw;
}

function tryUsage(raw: unknown): Readonly<{ inputTokens: number; outputTokens: number }> | null {
	const record = exactRecord(raw, new Set(["inputTokens", "outputTokens"]));
	if (!record) return null;
	const it = trySafeInt(record.inputTokens);
	const ot = trySafeInt(record.outputTokens);
	if (it === null || ot === null) return null;
	return Object.freeze({ inputTokens: it, outputTokens: ot });
}

/** Check that raw is a plain Object with only known keys, exactly Object.prototype (not null). */
function plainRecord(raw: unknown, known: ReadonlySet<string>): { readonly [key: string]: unknown } | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
	try {
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
	} catch {
		return null;
	}
	let descs: Record<string, PropertyDescriptor>;
	try {
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
	const keys = Object.keys(descs);
	for (const name of keys) {
		if (!known.has(name)) return null;
		const d = descs[name];
		if (!d || !("value" in d) || !d.enumerable) return null;
	}
	const result: { [key: string]: unknown } = {};
	for (const name of keys) result[name] = descs[name].value;
	return result;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const names = Object.getOwnPropertyNames(value);
	for (const name of names) {
		const v = Reflect.get(value, name);
		if (typeof v === "object" && v !== null) deepFreeze(v);
	}
	Object.freeze(value);
	return value;
}

/** Observe a native Promise via Reflect.apply(Promise.prototype.then, ...) after exact guard. */
function observePromise(rawPromise: unknown, timeoutMs: number): Promise<HostedRlmPortResult<unknown>> {
	return new Promise<HostedRlmPortResult<unknown>>((resolve) => {
		let settled = false;
		const timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}, timeoutMs);

		const onFulfilled = (value: unknown): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolve(Object.freeze({ ok: true as const, value }));
		};

		const onRejected = (): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		};

		Reflect.apply(Promise.prototype.then, rawPromise, [onFulfilled, onRejected]);
	});
}

// ---------------------------------------------------------------------------
// Result / snapshot / event parsers
// ---------------------------------------------------------------------------

function tryTaskResult(raw: unknown): HostedRlmTaskResult | null {
	const record = plainRecord(
		raw,
		new Set(["status", "durationMs", "parentReplyCount", "toolUseCount", "answerPreview", "errorCode", "usage"]),
	);
	if (!record) return null;

	const status = record.status;
	if (typeof status !== "string" || !VALID_TASK_STATUSES.has(status)) return null;
	const durationMs = trySafeInt(record.durationMs);
	if (durationMs === null) return null;
	const parentReplyCount = trySafeInt(record.parentReplyCount);
	if (parentReplyCount === null) return null;
	const toolUseCount = trySafeInt(record.toolUseCount);
	if (toolUseCount === null) return null;

	const hasAnswer = "answerPreview" in record;
	const hasErrorCode = "errorCode" in record;
	const hasUsage = "usage" in record;

	if (status === "completed") {
		if (hasErrorCode) return null;
		let answerPreview: string | undefined;
		if (hasAnswer) {
			if (!isBoundedString(record.answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
			answerPreview = record.answerPreview;
		}
		let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
		if (hasUsage) {
			const u = tryUsage(record.usage);
			if (!u) return null;
			usage = u;
		}
		return deepFreeze({
			status: "completed" as const,
			durationMs,
			parentReplyCount,
			toolUseCount,
			...(answerPreview !== undefined ? { answerPreview } : undefined),
			...(usage !== undefined ? { usage } : undefined),
		});
	}

	if (status === "cancelled") {
		if (hasAnswer) return null;
		if (!hasErrorCode) return null;
		if (record.errorCode !== "CANCELLED") return null;
		let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
		if (hasUsage) {
			const u = tryUsage(record.usage);
			if (!u) return null;
			usage = u;
		}
		return deepFreeze({
			status: "cancelled" as const,
			durationMs,
			parentReplyCount,
			toolUseCount,
			errorCode: "CANCELLED" as const,
			...(usage !== undefined ? { usage } : undefined),
		});
	}

	if (status === "error") {
		if (hasAnswer) return null;
		if (!hasErrorCode) return null;
		const ec = record.errorCode;
		if (ec === "TIMEOUT") {
			let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
			if (hasUsage) {
				const u = tryUsage(record.usage);
				if (!u) return null;
				usage = u;
			}
			return deepFreeze({
				status: "error" as const,
				durationMs,
				parentReplyCount,
				toolUseCount,
				errorCode: "TIMEOUT" as const,
				...(usage !== undefined ? { usage } : undefined),
			});
		}
		if (ec === "ADMISSION_FAILED") {
			let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
			if (hasUsage) {
				const u = tryUsage(record.usage);
				if (!u) return null;
				usage = u;
			}
			return deepFreeze({
				status: "error" as const,
				durationMs,
				parentReplyCount,
				toolUseCount,
				errorCode: "ADMISSION_FAILED" as const,
				...(usage !== undefined ? { usage } : undefined),
			});
		}
		if (ec === "INTERNAL_ERROR") {
			let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
			if (hasUsage) {
				const u = tryUsage(record.usage);
				if (!u) return null;
				usage = u;
			}
			return deepFreeze({
				status: "error" as const,
				durationMs,
				parentReplyCount,
				toolUseCount,
				errorCode: "INTERNAL_ERROR" as const,
				...(usage !== undefined ? { usage } : undefined),
			});
		}
		return null; // CANCELLED not allowed for error status
	}

	return null;
}

function tryObservationSnapshot(raw: unknown): HostedRlmObservationSnapshot | null {
	const record = plainRecord(
		raw,
		new Set(["status", "messageCount", "toolUseCount", "agentRunning", "parentReplyCount", "answerPreview", "usage"]),
	);
	if (!record) return null;

	const status = record.status;
	if (typeof status !== "string" || !VALID_RUNTIME_STATUSES.has(status)) return null;
	const messageCount = trySafeInt(record.messageCount);
	if (messageCount === null) return null;
	const toolUseCount = trySafeInt(record.toolUseCount);
	if (toolUseCount === null) return null;
	const agentRunning = record.agentRunning;
	if (typeof agentRunning !== "boolean") return null;
	if (status !== "running" && agentRunning) return null;
	const parentReplyCount = trySafeInt(record.parentReplyCount);
	if (parentReplyCount === null) return null;

	const hasAnswer = "answerPreview" in record;
	const hasUsage = "usage" in record;

	let answerPreview: string | undefined;
	if (hasAnswer) {
		if (!isBoundedString(record.answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		answerPreview = record.answerPreview;
	}
	let usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
	if (hasUsage) {
		const u = tryUsage(record.usage);
		if (!u) return null;
		usage = u;
	}

	let st: HostedRlmRuntimeStatus;
	if (status === "queued") st = "queued" as const;
	else if (status === "running") st = "running" as const;
	else if (status === "completed") st = "completed" as const;
	else if (status === "cancelled") st = "cancelled" as const;
	else if (status === "error") st = "error" as const;
	else return null;

	return deepFreeze({
		status: st,
		messageCount,
		toolUseCount,
		agentRunning,
		parentReplyCount,
		...(answerPreview !== undefined ? { answerPreview } : undefined),
		...(usage !== undefined ? { usage } : undefined),
	});
}

function tryAbortResult(raw: unknown): HostedRlmAbortResult | null {
	const s = tryStatus(raw, new Set(["aborted", "already_terminal"]));
	if (s === "aborted") return Object.freeze({ status: "aborted" as const });
	if (s === "already_terminal") return Object.freeze({ status: "already_terminal" as const });
	return null;
}

function tryRuntimeEvent(raw: unknown): HostedRlmRuntimeEvent | null {
	const record = plainRecord(
		raw,
		new Set(["type", "answerPreview", "toolName", "status", "toolUseCount", "parentReplyCount"]),
	);
	if (!record) return null;

	const type = record.type;
	if (typeof type !== "string") return null;

	if (type === "agent_start") {
		if (Object.keys(record).length !== 1) return null;
		return deepFreeze({ type: "agent_start" as const });
	}
	if (type === "agent_end") {
		if (Object.keys(record).length !== 1) return null;
		return deepFreeze({ type: "agent_end" as const });
	}
	if (type === "waiting") {
		if (Object.keys(record).length !== 1) return null;
		return deepFreeze({ type: "waiting" as const });
	}

	if (type === "writing") {
		if (Object.keys(record).length !== 2) return null;
		if (!("answerPreview" in record)) return null;
		if (!isBoundedString(record.answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
		return deepFreeze({ type: "writing" as const, answerPreview: record.answerPreview });
	}

	if (type === "executing") {
		if (Object.keys(record).length !== 2) return null;
		if (!("toolName" in record)) return null;
		if (!isBoundedString(record.toolName, MAX_TOOL_NAME_LENGTH)) return null;
		return deepFreeze({ type: "executing" as const, toolName: record.toolName });
	}

	if (type === "child_update") {
		const keyCount = Object.keys(record).length;
		if (keyCount < 4 || keyCount > 5) return null;
		if (!("status" in record) || !("toolUseCount" in record) || !("parentReplyCount" in record)) return null;
		const st = record.status;
		if (typeof st !== "string" || !VALID_RUNTIME_STATUSES.has(st)) return null;
		const tuc = trySafeInt(record.toolUseCount);
		if (tuc === null) return null;
		const prc = trySafeInt(record.parentReplyCount);
		if (prc === null) return null;
		let answerPreview: string | undefined;
		if ("answerPreview" in record) {
			if (!isBoundedString(record.answerPreview, MAX_ANSWER_PREVIEW_LENGTH)) return null;
			answerPreview = record.answerPreview;
		}
		let cs: HostedRlmRuntimeStatus;
		if (st === "queued") cs = "queued" as const;
		else if (st === "running") cs = "running" as const;
		else if (st === "completed") cs = "completed" as const;
		else if (st === "cancelled") cs = "cancelled" as const;
		else if (st === "error") cs = "error" as const;
		else return null;

		return deepFreeze({
			type: "child_update" as const,
			status: cs,
			toolUseCount: tuc,
			parentReplyCount: prc,
			...(answerPreview !== undefined ? { answerPreview } : undefined),
		});
	}

	return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHostedRlmRuntimePort(raw: unknown): HostedRlmRuntimePortFactoryResult {
	const factoryRecord = exactRecord(raw, FACTORY_KEYS);
	if (!factoryRecord) return INVALID_INPUT;

	const rawIdentity = factoryRecord.identity;
	const rawStartTask = factoryRecord.startInitialTask;
	const rawAbort = factoryRecord.abort;
	const rawObserve = factoryRecord.observe;
	const rawSubscribe = factoryRecord.subscribe;

	const identity = extractIdentity(rawIdentity);
	if (!identity) return INVALID_INPUT;

	if (
		!isNonProxyFunction(rawStartTask) ||
		!isNonProxyFunction(rawAbort) ||
		!isNonProxyFunction(rawObserve) ||
		!isNonProxyFunction(rawSubscribe)
	)
		return INVALID_INPUT;

	const boundStartTask = (input: unknown): unknown => Reflect.apply(rawStartTask, raw, [input]);
	const boundAbort = (): unknown => Reflect.apply(rawAbort, raw, []);
	const boundObserve = (): unknown => Reflect.apply(rawObserve, raw, []);
	const boundSubscribe = (callback: (event: unknown) => void): unknown => Reflect.apply(rawSubscribe, raw, [callback]);

	// -----------------------------------------------------------------------
	// Lifecycle state
	// -----------------------------------------------------------------------

	let poisoned = false;
	let started = false;

	let abortPromise: Promise<HostedRlmPortResult<HostedRlmAbortResult>> | null = null;

	type SubState = {
		consumed: boolean;
		unsubscribe: () => unknown;
		result: HostedRlmUnsubscribeResult | null;
	};
	let activeSubscription: SubState | null = null;

	function clearActiveIfConsumed(): void {
		if (activeSubscription?.consumed && activeSubscription.result?.ok === true) {
			activeSubscription = null;
		}
	}

	// -----------------------------------------------------------------------
	// startInitialTask
	// -----------------------------------------------------------------------

	function startInitialTask(input: unknown): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
		if (poisoned) return Promise.resolve(portFailure<HostedRlmTaskResult>("CALL_UNCERTAIN"));

		const inputRecord = plainRecord(input, new Set(["prompt", "spawnCode"]));
		if (!inputRecord) return Promise.resolve(portFailure<HostedRlmTaskResult>("INVALID_ARGUMENT"));

		const prompt = inputRecord.prompt;
		if (!isBoundedString(prompt, MAX_PROMPT_LENGTH)) {
			return Promise.resolve(portFailure<HostedRlmTaskResult>("INVALID_ARGUMENT"));
		}

		const hasSpawn = "spawnCode" in inputRecord;
		let validatedSpawnCode: string | undefined;
		if (hasSpawn) {
			const sc = inputRecord.spawnCode;
			if (!isBoundedString(sc, MAX_SPAWN_CODE_LENGTH)) {
				return Promise.resolve(portFailure<HostedRlmTaskResult>("INVALID_ARGUMENT"));
			}
			validatedSpawnCode = sc;
		}

		if (started) return Promise.resolve(portFailure<HostedRlmTaskResult>("CALL_UNCERTAIN"));
		started = true;

		const rawInput: { prompt: string; spawnCode?: string } = Object.freeze(
			hasSpawn ? { prompt, spawnCode: validatedSpawnCode } : { prompt },
		);

		let rawPromise: unknown;
		try {
			rawPromise = boundStartTask(rawInput);
		} catch {
			poisoned = true;
			return Promise.resolve(portFailure<HostedRlmTaskResult>("CALL_UNCERTAIN"));
		}

		if (!isNativePromise(rawPromise)) {
			poisoned = true;
			return Promise.resolve(portFailure<HostedRlmTaskResult>("CALL_UNCERTAIN"));
		}

		return observePromise(rawPromise, OPERATION_TIMEOUT_MS).then((observed) => {
			if (!observed.ok) {
				poisoned = true;
				return observed;
			}
			const parsed = tryTaskResult(observed.value);
			if (!parsed) {
				poisoned = true;
				return portFailure<HostedRlmTaskResult>("MALFORMED_RESULT");
			}
			return Object.freeze({ ok: true as const, value: parsed });
		});
	}

	// -----------------------------------------------------------------------
	// abort
	// -----------------------------------------------------------------------

	function abort(): Promise<HostedRlmPortResult<HostedRlmAbortResult>> {
		if (abortPromise) return abortPromise;
		if (poisoned) {
			abortPromise = Promise.resolve(portFailure<HostedRlmAbortResult>("CALL_UNCERTAIN"));
			return abortPromise;
		}

		abortPromise = (async (): Promise<HostedRlmPortResult<HostedRlmAbortResult>> => {
			let rawPromise: unknown;
			try {
				rawPromise = boundAbort();
			} catch {
				poisoned = true;
				return portFailure<HostedRlmAbortResult>("CALL_UNCERTAIN");
			}

			if (!isNativePromise(rawPromise)) {
				poisoned = true;
				return portFailure<HostedRlmAbortResult>("CALL_UNCERTAIN");
			}

			const observed = await observePromise(rawPromise, OPERATION_TIMEOUT_MS);
			if (!observed.ok) {
				poisoned = true;
				return observed;
			}

			const parsed = tryAbortResult(observed.value);
			if (!parsed) {
				poisoned = true;
				return portFailure<HostedRlmAbortResult>("MALFORMED_RESULT");
			}
			return Object.freeze({ ok: true as const, value: parsed });
		})();
		return abortPromise;
	}

	// -----------------------------------------------------------------------
	// observe
	// -----------------------------------------------------------------------

	function observe(): Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>> {
		if (poisoned) return Promise.resolve(portFailure<HostedRlmObservationSnapshot>("CALL_UNCERTAIN"));

		let rawPromise: unknown;
		try {
			rawPromise = boundObserve();
		} catch {
			poisoned = true;
			return Promise.resolve(portFailure<HostedRlmObservationSnapshot>("CALL_UNCERTAIN"));
		}

		if (!isNativePromise(rawPromise)) {
			poisoned = true;
			return Promise.resolve(portFailure<HostedRlmObservationSnapshot>("CALL_UNCERTAIN"));
		}

		return observePromise(rawPromise, OPERATION_TIMEOUT_MS).then((observed) => {
			if (!observed.ok) {
				poisoned = true;
				return observed;
			}
			const snapshot = tryObservationSnapshot(observed.value);
			if (!snapshot) {
				poisoned = true;
				return portFailure<HostedRlmObservationSnapshot>("MALFORMED_RESULT");
			}
			return Object.freeze({ ok: true as const, value: snapshot });
		});
	}

	// -----------------------------------------------------------------------
	// subscribe
	// -----------------------------------------------------------------------

	function subscribe(listener: unknown): HostedRlmSubscribeResult {
		if (poisoned) return ERR_SUB_POISONED;
		if (activeSubscription) {
			clearActiveIfConsumed();
			if (activeSubscription) return ERR_SUB_UNCERTAIN;
		}
		if (!isNonProxyFunction(listener)) return ERR_SUB_INVALID_ARGUMENT;
		const validatedListener = listener;

		// Buffer raw synchronous events before token validation; do NOT decode yet.
		let registering = true;
		let registrationAbandoned = false;
		const rawQueue: unknown[] = [];
		let subState: SubState | null = null;

		const decoderCallback = (rawEvent: unknown): void => {
			if (poisoned) return;
			if (registrationAbandoned) return;
			if (subState?.consumed) return;

			if (registering) {
				if (rawQueue.length >= MAX_SYNC_BUFFER) {
					registrationAbandoned = true;
				} else {
					rawQueue.push(rawEvent);
				}
			} else {
				const event = tryRuntimeEvent(rawEvent);
				if (!event) {
					handleMalformedLaterEvent();
					return;
				}
				deliverEvent(event);
			}
		};

		function deliverEvent(event: HostedRlmRuntimeEvent): void {
			try {
				Reflect.apply(validatedListener, undefined, [event]);
			} catch {
				// Listener throw is contained.
			}
		}

		function handleMalformedLaterEvent(): void {
			if (subState && !subState.consumed) {
				subState.consumed = true;
				let rawUnsub: unknown;
				try {
					rawUnsub = subState.unsubscribe();
				} catch {
					subState.result = UNSUBSCRIBE_UNCERTAIN;
					activeSubscription = subState;
					poisoned = true;
					return;
				}
				// Exact validate {status:"unsubscribed"} before deciding OK vs UNCERTAIN
				const s = tryStatus(rawUnsub, new Set(["unsubscribed"]));
				if (s === "unsubscribed") {
					subState.result = UNSUBSCRIBE_OK;
				} else {
					subState.result = UNSUBSCRIBE_UNCERTAIN;
				}
			}
			poisoned = true;
			activeSubscription = null;
		}

		// Subscribe on the raw capability.
		let subscribeResult: unknown;
		try {
			subscribeResult = boundSubscribe(decoderCallback);
		} catch {
			registrationAbandoned = true;
			poisoned = true;
			return ERR_SUB_UNCERTAIN;
		} finally {
			registering = false;
		}

		// PRELIMINARY: inspect subscribeResult for exact own `unsubscribe` data descriptor
		// BEFORE any outer token validation. Reject Proxy before descriptor access.
		let preliminaryUnsub: (() => unknown) | null = null;
		if (isNonProxyObject(subscribeResult)) {
			try {
				const descs = Object.getOwnPropertyDescriptors(subscribeResult);
				const unsubDesc = descs.unsubscribe;
				if (
					unsubDesc &&
					"value" in unsubDesc &&
					typeof unsubDesc.value === "function" &&
					unsubDesc.enumerable &&
					!types.isProxy(unsubDesc.value)
				) {
					preliminaryUnsub = (): unknown => Reflect.apply(unsubDesc.value, subscribeResult, []);
				}
			} catch {
				// No preliminary unsubscribe available.
			}
		}

		// Now validate the full token via exactRecord (must be exact {unsubscribe}, no Proxy/accessors/symbols).
		const rawUnsub = extractUnsubscribeToken(subscribeResult);

		if (!rawUnsub) {
			registrationAbandoned = true;
			if (preliminaryUnsub) {
				// Backout: call preliminary unsubscribe bound to original token owner
				const failState: SubState = {
					consumed: true,
					unsubscribe: preliminaryUnsub,
					result: null,
				};
				subState = failState;
				try {
					const raw = preliminaryUnsub();
					const s = tryStatus(raw, new Set(["unsubscribed"]));
					failState.result = s === "unsubscribed" ? UNSUBSCRIBE_OK : UNSUBSCRIBE_UNCERTAIN;
				} catch {
					failState.result = UNSUBSCRIBE_UNCERTAIN;
				}
				if (!failState.result.ok) {
					activeSubscription = failState;
				}
			}
			poisoned = true;
			return ERR_SUB_UNCERTAIN;
		}

		if (registrationAbandoned || poisoned) {
			backoutSubscription(rawUnsub);
			return ERR_SUB_UNCERTAIN;
		}

		// Decode ALL buffered events successfully before delivering any.
		const decodedEvents: HostedRlmRuntimeEvent[] = [];
		for (const rawEvent of rawQueue) {
			const event = tryRuntimeEvent(rawEvent);
			if (!event) {
				backoutSubscription(rawUnsub);
				return ERR_SUB_UNCERTAIN;
			}
			decodedEvents.push(event);
		}

		const state: SubState = {
			consumed: false,
			unsubscribe: rawUnsub,
			result: null,
		};
		subState = state;
		activeSubscription = state;

		// Now deliver ALL buffered events in order.
		for (const event of decodedEvents) {
			if (poisoned) break;
			if (state.consumed) break;
			deliverEvent(event);
		}

		function backoutSubscription(unsubFn: () => unknown): void {
			const failState: SubState = {
				consumed: true,
				unsubscribe: unsubFn,
				result: null,
			};
			subState = failState;
			try {
				const raw = unsubFn();
				const s = tryStatus(raw, new Set(["unsubscribed"]));
				failState.result = s === "unsubscribed" ? UNSUBSCRIBE_OK : UNSUBSCRIBE_UNCERTAIN;
			} catch {
				failState.result = UNSUBSCRIBE_UNCERTAIN;
			}
			if (!failState.result.ok) {
				activeSubscription = failState;
			}
			poisoned = true;
		}

		const unsubscribe = (): HostedRlmUnsubscribeResult => {
			if (state.consumed) return state.result ?? UNSUBSCRIBE_UNCERTAIN;
			state.consumed = true;
			let rawResult: unknown;
			try {
				rawResult = state.unsubscribe();
			} catch {
				state.result = UNSUBSCRIBE_UNCERTAIN;
				poisoned = true;
				return state.result;
			}
			const s = tryStatus(rawResult, new Set(["unsubscribed"]));
			if (s === "unsubscribed") {
				state.result = UNSUBSCRIBE_OK;
				if (activeSubscription === state) activeSubscription = null;
			} else {
				state.result = UNSUBSCRIBE_UNCERTAIN;
				poisoned = true;
			}
			return state.result;
		};

		return Object.freeze({
			ok: true as const,
			value: Object.freeze({ unsubscribe }),
		});
	}

	// -----------------------------------------------------------------------
	// Port object
	// -----------------------------------------------------------------------

	const port: HostedRlmRuntimePort = Object.freeze({
		identity,
		startInitialTask,
		abort,
		observe,
		subscribe,
	});

	return Object.freeze({ ok: true as const, value: port });
}
