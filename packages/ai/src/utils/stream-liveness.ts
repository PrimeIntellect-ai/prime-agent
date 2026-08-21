import type { AssistantMessage } from "../types.js";
import { appendAssistantMessageDiagnostic, extractDiagnosticError } from "./diagnostics.js";

export type StreamLivenessPhase = "connecting" | "headers" | "streaming" | "finalizing";

export type StreamLivenessAbortability = "abortable" | "not_abortable";

export type StreamLivenessId = string | number;

export interface StreamLivenessClock {
	now(): number;
}

export interface StreamLivenessScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface StreamLivenessIdentity {
	readonly provider: string;
	readonly model: string;
	readonly transport: string;
}

export interface StreamLivenessPolicy {
	/** Maximum time before any provider event is observed. */
	readonly connectingTimeoutMs: number;
	/** Maximum time in the headers phase without content. */
	readonly headersTimeoutMs: number;
	/** Idle timeout for the streaming phase before progress extensions. */
	readonly streamingIdleTimeoutMs: number;
	/** Maximum time allowed after the stream enters finalizing. */
	readonly finalizingTimeoutMs: number;
	/** Additional idle time granted by one meaningful content update. */
	readonly progressExtensionMs: number;
	/** Total extension budget measured from the first streaming deadline. */
	readonly maxProgressExtensionMs: number;
}

/** The host owns this resolver; stream events cannot select or alter policy. */
export type StreamLivenessPolicyResolver = (
	identity: Readonly<StreamLivenessIdentity>,
) => Readonly<StreamLivenessPolicy>;

export type StreamLivenessObservation =
	| StreamLivenessFinalizingObservation
	| { readonly type: "headers"; readonly receivedBytes?: number; readonly blocks?: number }
	| {
			readonly type: "provider_event";
			readonly eventId?: string;
			readonly receivedBytes?: number;
			readonly blocks?: number;
	  }
	| { readonly type: "text_delta"; readonly delta: string; readonly receivedBytes?: number; readonly blocks?: number }
	| {
			readonly type: "thinking_delta";
			readonly delta: string;
			readonly receivedBytes?: number;
			readonly blocks?: number;
	  }
	| {
			readonly type: "tool_call";
			readonly id: string;
			readonly name: string;
			readonly args: unknown;
			readonly receivedBytes?: number;
			readonly blocks?: number;
	  }
	| { readonly type: "block"; readonly receivedBytes?: number; readonly blocks?: number };

type StreamLivenessFinalizingObservation = {
	readonly type: "finalizing";
	readonly receivedBytes?: number;
	readonly blocks?: number;
};

export interface StreamLivenessState {
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly provider: string;
	readonly model: string;
	readonly transport: string;
	readonly lastProviderEventAt: number | undefined;
	readonly lastDeltaAt: number | undefined;
	readonly lastMeaningfulContentDeltaAt: number | undefined;
	readonly receivedBytes: number;
	readonly blocks: number;
	readonly phase: StreamLivenessPhase;
	readonly abortability: StreamLivenessAbortability;
	readonly requestId: string | undefined;
	readonly attemptId: string | undefined;
	readonly terminal: boolean;
}

export interface StreamLivenessDiagnostic {
	readonly type: "provider_stream_stalled";
	readonly phase: StreamLivenessPhase;
	readonly reason: StreamLivenessStallReason;
	readonly at: number;
	readonly elapsedMs: number;
	readonly idleMs: number;
	readonly receivedBytes: number;
	readonly blocks: number;
	readonly provider: string;
	readonly model: string;
	readonly transport: string;
	readonly requestId: string | undefined;
	readonly attemptId: string | undefined;
}

export type StreamLivenessStallReason = "no_provider_event" | "no_meaningful_content_progress" | "finalizing_timeout";

export interface StreamLivenessStalledDecision {
	readonly type: "provider_stream_stalled";
	readonly at: number;
	readonly abortIntent: {
		readonly requested: boolean;
		readonly reason: "provider_stream_stalled" | "not_abortable";
	};
	readonly diagnostic: StreamLivenessDiagnostic;
}

export type StreamLivenessTerminalOutcome =
	| StreamLivenessStalledDecision
	| { readonly type: "provider_stream_final"; readonly at: number }
	| { readonly type: "provider_stream_error"; readonly at: number }
	| { readonly type: "provider_stream_aborted"; readonly at: number };

export interface StreamLivenessWatchdogOptions {
	readonly clock: StreamLivenessClock;
	readonly scheduler: StreamLivenessScheduler;
	readonly identity: StreamLivenessIdentity;
	readonly policyResolver: StreamLivenessPolicyResolver;
	readonly abortability?: StreamLivenessAbortability;
	readonly requestId?: StreamLivenessId;
	readonly attemptId?: StreamLivenessId;
	readonly abort?: () => void;
	readonly onTerminal?: (outcome: StreamLivenessTerminalOutcome) => void;
}

export interface StreamLivenessWatchdog {
	observe(observation: StreamLivenessObservation): StreamLivenessTerminalOutcome | undefined;
	markFinalizing(): StreamLivenessTerminalOutcome | undefined;
	markFinal(): StreamLivenessTerminalOutcome | undefined;
	markError(): StreamLivenessTerminalOutcome | undefined;
	markAborted(): StreamLivenessTerminalOutcome | undefined;
	snapshot(): StreamLivenessState;
}

/**
 * Host-owned inputs used when a provider stream is attached to a watchdog.
 * Providers derive provider, model, and transport identity from the resolved
 * model and selected transport; callers only supply the host policy resolver.
 */
export interface StreamLivenessHost {
	readonly policyResolver: StreamLivenessPolicyResolver;
	readonly clock?: StreamLivenessClock;
	readonly scheduler?: StreamLivenessScheduler;
	readonly abortability?: StreamLivenessAbortability;
	readonly onState?: (state: StreamLivenessState) => void;
	readonly onTerminal?: (outcome: StreamLivenessTerminalOutcome) => void;
}

export type StreamLivenessHostOptions = StreamLivenessHost;

/** Create a host-owned liveness configuration without exposing request identity fields. */
export function createStreamLivenessHost(options: StreamLivenessHostOptions): StreamLivenessHost {
	return Object.freeze({ ...options });
}

/** Policy used when an embedding host has not supplied a provider-specific resolver. */
export const DEFAULT_STREAM_LIVENESS_POLICY: StreamLivenessPolicy = Object.freeze({
	connectingTimeoutMs: 30_000,
	// Bounds time to the FIRST content block, not idle time between blocks, and no observation in
	// the headers phase can extend it. A reasoning model can think for minutes before its first
	// summary part: 30_000 killed every long gpt-5.6-sol turn at exactly 30s with bytes received
	// and zero blocks. Sized for time-to-first-token, still absolute, and still <= the streaming
	// budget (streamingIdleTimeoutMs + maxProgressExtensionMs) so silence never outlives progress.
	headersTimeoutMs: 300_000,
	streamingIdleTimeoutMs: 60_000,
	finalizingTimeoutMs: 30_000,
	progressExtensionMs: 10_000,
	maxProgressExtensionMs: 300_000,
});

const DEFAULT_STREAM_LIVENESS_HOST: StreamLivenessHost = Object.freeze({
	policyResolver: () => DEFAULT_STREAM_LIVENESS_POLICY,
});

export function getDefaultStreamLivenessHost(): StreamLivenessHost {
	return DEFAULT_STREAM_LIVENESS_HOST;
}

export class ProviderStreamStalledError extends Error {
	readonly code = "provider_stream_stalled";
	readonly retryable = true;
	readonly outcome: StreamLivenessStalledDecision;
	readonly diagnostic: StreamLivenessDiagnostic;

	constructor(outcome: StreamLivenessStalledDecision) {
		super(`provider_stream_stalled (${outcome.diagnostic.phase}/${outcome.diagnostic.reason})`);
		this.name = "ProviderStreamStalledError";
		this.outcome = outcome;
		this.diagnostic = outcome.diagnostic;
	}
}

export function applyProviderStreamStall(output: AssistantMessage, error: ProviderStreamStalledError): void {
	output.stopReason = "error";
	output.errorMessage = error.message;
	if (output.diagnostics?.some((diagnostic) => diagnostic.type === "provider_stream_stalled")) return;
	appendAssistantMessageDiagnostic(output, {
		type: "provider_stream_stalled",
		timestamp: Date.now(),
		error: extractDiagnosticError(error),
		details: { ...error.diagnostic },
	});
}

export interface ProviderStreamLivenessOptions {
	readonly identity: StreamLivenessIdentity;
	readonly host?: StreamLivenessHost;
	readonly signal?: AbortSignal;
	readonly requestId?: StreamLivenessId;
	readonly attemptId?: StreamLivenessId;
	readonly onStall?: (error: ProviderStreamStalledError) => void;
}

export interface ProviderStreamLiveness {
	readonly signal: AbortSignal;
	readonly watchdog: StreamLivenessWatchdog;
	readonly stalledError: () => ProviderStreamStalledError | undefined;
	readonly callerAborted: () => boolean;
	observe(observation: StreamLivenessObservation): void;
	markFinalizing(): void;
	markFinal(): void;
	markError(): void;
	markAborted(): void;
	close(): void;
}

function createMonotonicClock(): StreamLivenessClock {
	let last = 0;
	return {
		now: () => {
			const value = typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
			last = Math.max(last, value);
			return last;
		},
	};
}

const DEFAULT_STREAM_LIVENESS_SCHEDULER: StreamLivenessScheduler = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function rethrowStall(error: ProviderStreamStalledError | undefined): void {
	if (error) throw error;
}

/**
 * Attach a caller-cancelable signal and a host-owned watchdog to one provider attempt.
 * A stall aborts the combined signal and records one structured error; caller aborts
 * remain ordinary aborts and never become provider failures.
 */
export function createProviderStreamLiveness(options: ProviderStreamLivenessOptions): ProviderStreamLiveness {
	const host = options.host ?? DEFAULT_STREAM_LIVENESS_HOST;
	const controller = new AbortController();
	let callerAborted = false;
	let stalled: ProviderStreamStalledError | undefined;
	let closed = false;

	const abortCombined = () => {
		if (!controller.signal.aborted) controller.abort();
	};

	const watchdog = createStreamLivenessWatchdog({
		clock: host.clock ?? createMonotonicClock(),
		scheduler: host.scheduler ?? DEFAULT_STREAM_LIVENESS_SCHEDULER,
		identity: options.identity,
		policyResolver: host.policyResolver,
		abortability: host.abortability ?? "abortable",
		requestId: options.requestId,
		attemptId: options.attemptId,
		abort: abortCombined,
		onTerminal: (outcome) => {
			host.onTerminal?.(outcome);
			if (outcome.type !== "provider_stream_stalled") return;
			stalled = new ProviderStreamStalledError(outcome);
			options.onStall?.(stalled);
		},
	});
	host.onState?.(watchdog.snapshot());

	const onCallerAbort = () => {
		callerAborted = true;
		abortCombined();
		watchdog.markAborted();
	};
	if (options.signal?.aborted) onCallerAbort();
	else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

	const assertNotStalled = () => rethrowStall(stalled);
	const observe = (observation: StreamLivenessObservation): void => {
		if (closed) return;
		assertNotStalled();
		const outcome = watchdog.observe(observation);
		host.onState?.(watchdog.snapshot());
		if (outcome?.type === "provider_stream_stalled") {
			assertNotStalled();
		}
	};
	const mark = (finish: () => StreamLivenessTerminalOutcome | undefined): void => {
		if (closed) return;
		const outcome = finish();
		host.onState?.(watchdog.snapshot());
		if (outcome?.type === "provider_stream_stalled") assertNotStalled();
	};

	return {
		signal: controller.signal,
		watchdog,
		stalledError: () => stalled,
		callerAborted: () => callerAborted,
		observe,
		markFinalizing: () => mark(watchdog.markFinalizing),
		markFinal: () => mark(watchdog.markFinal),
		markError: () => mark(watchdog.markError),
		markAborted: () => mark(watchdog.markAborted),
		close: () => {
			if (closed) return;
			closed = true;
			options.signal?.removeEventListener("abort", onCallerAbort);
			if (!watchdog.snapshot().terminal) watchdog.markError();
		},
	};
}

/**
 * Observe raw provider events while preserving the iterator's cancellation path.
 * The signal listener explicitly calls return() so SSE/HTTP/WebSocket adapters
 * get a chance to release their reader/socket instead of waiting for a late done.
 */
export async function* observeProviderAsyncIterable<T>(
	source: AsyncIterable<T>,
	liveness: ProviderStreamLiveness,
	eventId: (event: T) => string | undefined = () => undefined,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let returned = false;
	const closeIterator = () => {
		if (returned) return;
		returned = true;
		try {
			void Promise.resolve(iterator.return?.()).catch(() => undefined);
		} catch {
			// A provider iterator may reject synchronous teardown.
		}
	};
	liveness.signal.addEventListener("abort", closeIterator, { once: true });
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) return;
			liveness.observe({
				type: "provider_event",
				eventId: eventId(next.value),
				receivedBytes: estimateProviderEventBytes(next.value),
			});
			yield next.value;
		}
	} finally {
		liveness.signal.removeEventListener("abort", closeIterator);
		if (!returned) {
			returned = true;
			try {
				await iterator.return?.();
			} catch {
				// The provider may have already closed its transport.
			}
		}
	}
}

const providerEventEncoder = typeof TextEncoder === "function" ? new TextEncoder() : undefined;

function estimateProviderEventBytes(event: unknown): number | undefined {
	let serialized: string | undefined;
	if (typeof event === "string") {
		serialized = event;
	} else {
		try {
			serialized = JSON.stringify(event);
		} catch {
			return undefined;
		}
	}
	if (serialized === undefined) return undefined;
	return providerEventEncoder?.encode(serialized).byteLength ?? serialized.length;
}

export function isProviderStreamStalledError(error: unknown): error is ProviderStreamStalledError {
	return error instanceof ProviderStreamStalledError;
}

/** Keep byte/block counters within exactly representable JSON number bounds. */
export const STREAM_LIVENESS_COUNTER_MAX = Number.MAX_SAFE_INTEGER;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_POLICY_DURATION_MS = Number.MAX_SAFE_INTEGER;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 1024;
const MAX_CANONICAL_BYTES = 16_384;
const MAX_SEMANTIC_TEXT_LENGTH = 65_536;
const SHA256_ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);
const DEFAULT_IGNORABLE_OR_FORMAT_PATTERN = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
const STANDALONE_INVISIBLE_PATTERN = /^[\p{M}]+$/u;
const INVISIBLE_BLANK_CODE_POINTS = new Set([0x115f, 0x1160, 0x2800, 0x303f, 0x3164, 0xffa0]);

function finiteTime(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
	return value;
}

function addTime(start: number, duration: number, label: string): number {
	const result = start + duration;
	if (result === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
	if (!Number.isFinite(result)) throw new RangeError(`${label} overflowed the monotonic clock`);
	return result;
}

function boundedDuration(now: number, start: number): number {
	const duration = now - start;
	return Number.isFinite(duration)
		? Math.min(STREAM_LIVENESS_COUNTER_MAX, Math.max(0, duration))
		: STREAM_LIVENESS_COUNTER_MAX;
}

function snapshotPolicy(policy: Readonly<StreamLivenessPolicy>): StreamLivenessPolicy {
	if (policy === null || typeof policy !== "object") throw new TypeError("policyResolver must return an object");
	const prototype = Object.getPrototypeOf(policy);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("policyResolver must return an object with a plain prototype");
	}
	const values: Array<[keyof StreamLivenessPolicy, boolean]> = [
		["connectingTimeoutMs", false],
		["headersTimeoutMs", false],
		["streamingIdleTimeoutMs", false],
		["finalizingTimeoutMs", false],
		["progressExtensionMs", true],
		["maxProgressExtensionMs", true],
	];
	const descriptors = new Map<keyof StreamLivenessPolicy, unknown>();
	for (const [name] of values) {
		const descriptor = Object.getOwnPropertyDescriptor(policy, name);
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new TypeError(`policy.${name} must be an own data property`);
		}
		descriptors.set(name, descriptor.value);
	}
	for (const [name, allowZero] of values) {
		const value = descriptors.get(name);
		if (typeof value !== "number") throw new TypeError(`policy.${name} must be a number`);
		finiteTime(value, `policy.${name}`);
		if (value < 0 || (!allowZero && value === 0)) throw new RangeError(`policy.${name} must be positive`);
		if (value > MAX_POLICY_DURATION_MS) throw new RangeError(`policy.${name} exceeds the safe duration bound`);
	}
	return {
		connectingTimeoutMs: descriptors.get("connectingTimeoutMs") as number,
		headersTimeoutMs: descriptors.get("headersTimeoutMs") as number,
		streamingIdleTimeoutMs: descriptors.get("streamingIdleTimeoutMs") as number,
		finalizingTimeoutMs: descriptors.get("finalizingTimeoutMs") as number,
		progressExtensionMs: descriptors.get("progressExtensionMs") as number,
		maxProgressExtensionMs: descriptors.get("maxProgressExtensionMs") as number,
	};
}

function incrementCounter(current: number, increment: number | undefined, label: string): number {
	if (increment === undefined) return current;
	if (!Number.isSafeInteger(increment) || increment < 0) {
		throw new RangeError(`${label} must be a non-negative safe integer`);
	}
	return Math.min(STREAM_LIVENESS_COUNTER_MAX, current + increment);
}

function codePointWidth(codePoint: number): number {
	return codePoint > 0xffff ? 2 : 1;
}

function skipCsiSequence(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return index;
		const width = codePointWidth(codePoint);
		if (codePoint >= 0x40 && codePoint <= 0x7e) return index + width;
		index += width;
	}
	return index;
}

function skipAnsiString(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return index;
		const width = codePointWidth(codePoint);
		if (codePoint === 0x07 || codePoint === 0x9c) return index + width;
		if (codePoint === 0x1b) {
			const next = value.codePointAt(index + width);
			if (next === 0x5c) return index + width + codePointWidth(next);
		}
		index += width;
	}
	return index;
}

function skipEscSequence(value: string, start: number): number {
	const first = value.codePointAt(start);
	if (first === undefined) return start;
	const firstWidth = codePointWidth(first);
	if (first === 0x5b) return skipCsiSequence(value, start + firstWidth);
	if (first === 0x5d || first === 0x50 || first === 0x5e || first === 0x5f) {
		return skipAnsiString(value, start + firstWidth);
	}
	if ((first >= 0x30 && first <= 0x7e) || first === 0x37 || first === 0x38) return start + firstWidth;
	if (first < 0x20 || first > 0x2f) return start;

	let index = start;
	while (index < value.length) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return index;
		const width = codePointWidth(codePoint);
		if (codePoint >= 0x30 && codePoint <= 0x7e) return index + width;
		if (codePoint < 0x20 || codePoint > 0x2f) return index;
		index += width;
	}
	return index;
}

function stripInvisibleControls(value: string): string {
	const output: string[] = [];
	let index = 0;
	while (index < value.length) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) break;
		const width = codePointWidth(codePoint);
		if (codePoint === 0x1b) {
			index = skipEscSequence(value, index + width);
			continue;
		}
		if (codePoint === 0x9b) {
			index = skipCsiSequence(value, index + width);
			continue;
		}
		if (codePoint === 0x90 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
			index = skipAnsiString(value, index + width);
			continue;
		}
		if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
			index += width;
			continue;
		}
		if (DEFAULT_IGNORABLE_OR_FORMAT_PATTERN.test(String.fromCodePoint(codePoint))) {
			index += width;
			continue;
		}
		if (INVISIBLE_BLANK_CODE_POINTS.has(codePoint)) {
			index += width;
			continue;
		}
		output.push(String.fromCodePoint(codePoint));
		index += width;
	}
	return output.join("");
}

function normalizeSemanticText(value: string): string | undefined {
	if (value.length > MAX_SEMANTIC_TEXT_LENGTH) return undefined;
	const normalized = stripInvisibleControls(value).normalize("NFC").trim().replace(/\s+/g, " ");
	const nonWhitespace = normalized.replace(/\s/g, "");
	if (nonWhitespace.length === 0 || STANDALONE_INVISIBLE_PATTERN.test(nonWhitespace)) return undefined;
	return normalized.length > 0 ? normalized : undefined;
}

type CanonicalFrame =
	| { readonly type: "value"; readonly value: unknown; readonly depth: number }
	| { readonly type: "array"; readonly value: readonly unknown[]; readonly index: number; readonly depth: number }
	| {
			readonly type: "object";
			readonly value: Record<string, unknown>;
			readonly keys: readonly string[];
			readonly index: number;
			readonly depth: number;
	  };

function boundedEnumerableOwnKeys(value: object): readonly string[] | undefined {
	const keys: string[] = [];
	try {
		for (const key in value) {
			if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
			keys.push(key);
			if (keys.length > MAX_CANONICAL_NODES) return undefined;
		}
	} catch {
		return undefined;
	}
	keys.sort();
	return keys;
}

function canonicalValue(value: unknown): string | undefined {
	const output: string[] = [];
	let outputBytes = 0;
	let nodes = 0;
	const seen = new Set<object>();
	const stack: CanonicalFrame[] = [{ type: "value", value, depth: 0 }];

	function append(part: string): boolean {
		const partBytes = part.length > MAX_CANONICAL_BYTES / 4 ? MAX_CANONICAL_BYTES + 1 : part.length * 4;
		if (partBytes > MAX_CANONICAL_BYTES - outputBytes) return false;
		output.push(part);
		outputBytes += partBytes;
		return true;
	}

	try {
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame.type === "value") {
				if (frame.depth > MAX_CANONICAL_DEPTH) return undefined;
				const current = frame.value;
				if (current === null) {
					if (!append("null")) return undefined;
					stack.pop();
					continue;
				}
				if (typeof current === "string") {
					if (current.length > MAX_CANONICAL_BYTES) return undefined;
					if (!append(JSON.stringify(current))) return undefined;
					stack.pop();
					continue;
				}
				if (typeof current === "number") {
					if (!Number.isFinite(current) || !append(String(Object.is(current, -0) ? 0 : current))) return undefined;
					stack.pop();
					continue;
				}
				if (typeof current === "boolean") {
					if (!append(current ? "true" : "false")) return undefined;
					stack.pop();
					continue;
				}
				if (typeof current === "undefined") {
					if (!append("undefined")) return undefined;
					stack.pop();
					continue;
				}
				if (typeof current !== "object") return undefined;
				if (seen.has(current)) return undefined;
				seen.add(current);
				nodes++;
				if (nodes > MAX_CANONICAL_NODES) return undefined;
				if (Array.isArray(current)) {
					if (current.length > MAX_CANONICAL_NODES) return undefined;
					if (!append("[")) return undefined;
					stack[stack.length - 1] = { type: "array", value: current, index: 0, depth: frame.depth };
					continue;
				}
				const keys = boundedEnumerableOwnKeys(current);
				if (keys === undefined || !append("{")) return undefined;
				stack[stack.length - 1] = {
					type: "object",
					value: current as Record<string, unknown>,
					keys,
					index: 0,
					depth: frame.depth,
				};
				continue;
			}

			if (frame.type === "array") {
				if (frame.index >= frame.value.length) {
					if (!append("]")) return undefined;
					stack.pop();
					continue;
				}
				if (frame.index > 0 && !append(",")) return undefined;
				stack[stack.length - 1] = { ...frame, index: frame.index + 1 };
				stack.push({ type: "value", value: frame.value[frame.index], depth: frame.depth + 1 });
				continue;
			}

			if (frame.index >= frame.keys.length) {
				if (!append("}")) return undefined;
				stack.pop();
				continue;
			}
			if (frame.index > 0 && !append(",")) return undefined;
			const key = frame.keys[frame.index];
			if (key.length > MAX_CANONICAL_BYTES || !append(`${JSON.stringify(key)}:`)) return undefined;
			stack[stack.length - 1] = { ...frame, index: frame.index + 1 };
			stack.push({ type: "value", value: frame.value[key], depth: frame.depth + 1 });
		}
	} catch {
		return undefined;
	}

	return output.join("");
}

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(bytes: Uint8Array): string {
	const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.byteLength] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLength = bytes.byteLength * 8;
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
	view.setUint32(paddedLength - 4, bitLength >>> 0);

	const state = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
		for (let index = 16; index < 64; index++) {
			const word15 = words[index - 15] ?? 0;
			const word2 = words[index - 2] ?? 0;
			const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
			const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
			words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = ((state[0] ?? 0) + a) >>> 0;
		state[1] = ((state[1] ?? 0) + b) >>> 0;
		state[2] = ((state[2] ?? 0) + c) >>> 0;
		state[3] = ((state[3] ?? 0) + d) >>> 0;
		state[4] = ((state[4] ?? 0) + e) >>> 0;
		state[5] = ((state[5] ?? 0) + f) >>> 0;
		state[6] = ((state[6] ?? 0) + g) >>> 0;
		state[7] = ((state[7] ?? 0) + h) >>> 0;
	}
	return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function hashSha256(value: string): string {
	return `h2-${sha256Hex(new TextEncoder().encode(JSON.stringify(value)))}`;
}

function hashOpaque(value: string | number): string {
	return hashSha256(String(value));
}

function hashOptional(value: StreamLivenessId | undefined): string | undefined {
	return value === undefined ? undefined : hashOpaque(value);
}

function validateScheduler(scheduler: StreamLivenessScheduler): void {
	const candidate = scheduler as unknown as Record<string, unknown>;
	if (
		scheduler === null ||
		typeof scheduler !== "object" ||
		typeof candidate.setTimeout !== "function" ||
		typeof candidate.clearTimeout !== "function"
	) {
		throw new TypeError("scheduler must provide setTimeout and clearTimeout functions");
	}
}

function isSchedulerHandle(value: unknown): boolean {
	if (value === null) return false;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "object" || typeof value === "string" || typeof value === "symbol";
}

function phaseRank(phase: StreamLivenessPhase): number {
	return phase === "connecting" ? 0 : phase === "headers" ? 1 : phase === "streaming" ? 2 : 3;
}

/**
 * Track provider-stream liveness using host-injected time, scheduling, and policy.
 *
 * The watchdog is intentionally ephemeral: callers snapshot the state for live
 * diagnostics and forward terminal outcomes to their own stream protocol.
 *
 * Args:
 * options: Clock, scheduler, host policy resolver, and terminal callbacks for one provider attempt.
 * Return: An ephemeral watchdog with observation and terminal-transition methods.
 */
export function createStreamLivenessWatchdog(options: StreamLivenessWatchdogOptions): StreamLivenessWatchdog {
	validateScheduler(options.scheduler);
	const startedAt = finiteTime(options.clock.now(), "clock.now()");
	let lastClockAt = startedAt;
	const identity = Object.freeze({ ...options.identity });
	const policy = snapshotPolicy(options.policyResolver(identity));
	const abortability = options.abortability ?? "abortable";
	const provider = hashOpaque(identity.provider);
	const model = hashOpaque(identity.model);
	const transport = hashOpaque(identity.transport);
	const requestId = hashOptional(options.requestId);
	const attemptId = hashOptional(options.attemptId);
	const abort = options.abort ?? (() => undefined);

	let phase: StreamLivenessPhase = "connecting";
	let lastProviderEventAt: number | undefined;
	let lastDeltaAt: number | undefined;
	let lastMeaningfulContentDeltaAt: number | undefined;
	let receivedBytes = 0;
	let blocks = 0;
	let terminal = false;
	let timerHandle: unknown;
	let deadlineAt = addTime(startedAt, policy.connectingTimeoutMs, "connecting deadline");
	let streamingBaseDeadlineAt: number | undefined;
	let previousMeaningfulFingerprint: string | undefined;
	let schedulingTimer = false;

	function readClock(): number {
		const now = finiteTime(options.clock.now(), "clock.now()");
		if (now < lastClockAt) throw new RangeError("monotonic clock regressed");
		lastClockAt = now;
		return now;
	}

	function readClockSafely(): number | undefined {
		try {
			return readClock();
		} catch (error) {
			if (error instanceof RangeError && error.message === "monotonic clock regressed") throw error;
			commit({ type: "provider_stream_error", at: lastClockAt });
			return undefined;
		}
	}

	function clearTimer(): void {
		const handle = timerHandle;
		timerHandle = undefined;
		if (handle === undefined) return;
		try {
			options.scheduler.clearTimeout(handle);
		} catch {
			// Timer cleanup is best effort; terminal state must still be committed.
		}
	}

	function scheduleTimer(): void {
		clearTimer();
		if (terminal) return;
		if (schedulingTimer) throw new TypeError("scheduler.setTimeout must not invoke callbacks synchronously");
		const delay = Math.max(0, deadlineAt - lastClockAt);
		let callbackWasSynchronous = false;
		let handle: unknown;
		schedulingTimer = true;
		try {
			handle = options.scheduler.setTimeout(
				() => {
					if (schedulingTimer) {
						callbackWasSynchronous = true;
						return;
					}
					onTimer();
				},
				Math.min(delay, MAX_TIMER_DELAY_MS),
			);
		} finally {
			schedulingTimer = false;
		}
		if (callbackWasSynchronous) {
			if (isSchedulerHandle(handle)) options.scheduler.clearTimeout(handle);
			throw new TypeError("scheduler.setTimeout must not invoke callbacks synchronously");
		}
		if (!isSchedulerHandle(handle)) throw new TypeError("scheduler.setTimeout must return a clearable handle");
		timerHandle = handle;
	}

	function transitionTo(nextPhase: StreamLivenessPhase, now: number): void {
		if (phaseRank(nextPhase) <= phaseRank(phase)) return;
		phase = nextPhase;
		if (nextPhase === "headers") {
			deadlineAt = addTime(now, policy.headersTimeoutMs, "headers deadline");
			scheduleTimer();
		} else if (nextPhase === "streaming") {
			streamingBaseDeadlineAt = addTime(now, policy.streamingIdleTimeoutMs, "streaming deadline");
			deadlineAt = streamingBaseDeadlineAt;
			scheduleTimer();
		} else if (nextPhase === "finalizing") {
			deadlineAt = addTime(now, policy.finalizingTimeoutMs, "finalizing deadline");
			scheduleTimer();
		}
	}

	function updateCounters(observation: StreamLivenessObservation): void {
		receivedBytes = incrementCounter(receivedBytes, observation.receivedBytes, "receivedBytes");
		const blockIncrement = observation.blocks === undefined && observation.type === "block" ? 1 : observation.blocks;
		blocks = incrementCounter(blocks, blockIncrement, "blocks");
	}

	function stallReason(): StreamLivenessStallReason {
		if (phase === "connecting") return "no_provider_event";
		if (phase === "finalizing") return "finalizing_timeout";
		return "no_meaningful_content_progress";
	}

	function commit(outcome: StreamLivenessTerminalOutcome): StreamLivenessTerminalOutcome {
		if (terminal) return outcome;
		terminal = true;
		clearTimer();
		if (outcome.type === "provider_stream_stalled" && outcome.abortIntent.requested) {
			try {
				abort();
			} catch {
				// An abort hook is host-owned; terminal reporting must survive hook failure.
			}
		}
		options.onTerminal?.(outcome);
		return outcome;
	}

	function commitStall(now: number): StreamLivenessStalledDecision {
		const activityAt =
			phase === "streaming" ? (lastMeaningfulContentDeltaAt ?? startedAt) : (lastProviderEventAt ?? startedAt);
		const diagnostic: StreamLivenessDiagnostic = {
			type: "provider_stream_stalled",
			phase,
			reason: stallReason(),
			at: now,
			elapsedMs: boundedDuration(now, startedAt),
			idleMs: boundedDuration(now, activityAt),
			receivedBytes,
			blocks,
			provider,
			model,
			transport,
			requestId,
			attemptId,
		};
		const requested = abortability === "abortable";
		return commit({
			type: "provider_stream_stalled",
			at: now,
			abortIntent: { requested, reason: requested ? "provider_stream_stalled" : "not_abortable" },
			diagnostic,
		}) as StreamLivenessStalledDecision;
	}

	function checkDeadline(now: number): StreamLivenessTerminalOutcome | undefined {
		if (terminal || now < deadlineAt) return undefined;
		return commitStall(now);
	}

	function onTimer(): void {
		timerHandle = undefined;
		if (terminal) return;
		const now = readClockSafely();
		if (now === undefined) return;
		if (now < deadlineAt) {
			scheduleTimer();
			return;
		}
		commitStall(now);
	}

	function meaningfulProgress(now: number, fingerprint: string): void {
		if (fingerprint === previousMeaningfulFingerprint) return;
		previousMeaningfulFingerprint = fingerprint;
		lastMeaningfulContentDeltaAt = now;
		if (
			phase !== "streaming" ||
			streamingBaseDeadlineAt === undefined ||
			policy.progressExtensionMs === 0 ||
			policy.maxProgressExtensionMs === 0
		)
			return;
		const extensionCap = addTime(streamingBaseDeadlineAt, policy.maxProgressExtensionMs, "progress extension cap");
		deadlineAt = Math.max(
			deadlineAt,
			Math.min(addTime(now, policy.progressExtensionMs, "progress extension"), extensionCap),
		);
		scheduleTimer();
	}

	function observe(observation: StreamLivenessObservation): StreamLivenessTerminalOutcome | undefined {
		if (terminal) return undefined;
		const now = readClockSafely();
		if (now === undefined) return { type: "provider_stream_error", at: lastClockAt };
		const expired = checkDeadline(now);
		if (expired) return expired;
		updateCounters(observation);
		lastProviderEventAt = now;

		if (observation.type === "headers" || observation.type === "provider_event") {
			transitionTo("headers", now);
			return undefined;
		}
		if (observation.type === "finalizing") {
			transitionTo("finalizing", now);
			return undefined;
		}
		if (observation.type === "block") return undefined;

		if (observation.type === "text_delta" || observation.type === "thinking_delta") {
			lastDeltaAt = now;
			const text = normalizeSemanticText(observation.delta);
			if (text === undefined) return undefined;
			transitionTo("streaming", now);
			meaningfulProgress(now, `${observation.type}:${hashSha256(text)}`);
			return undefined;
		}
		const toolFingerprint = canonicalValue({
			id: observation.id.trim(),
			name: observation.name.trim(),
			args: observation.args,
		});
		lastDeltaAt = now;
		if (toolFingerprint === undefined) return undefined;
		transitionTo("streaming", now);
		meaningfulProgress(now, `tool_call:${hashSha256(toolFingerprint)}`);
		return undefined;
	}

	function markFinalizing(): StreamLivenessTerminalOutcome | undefined {
		if (terminal) return undefined;
		const now = readClockSafely();
		if (now === undefined) return { type: "provider_stream_error", at: lastClockAt };
		const expired = checkDeadline(now);
		if (expired) return expired;
		transitionTo("finalizing", now);
		return undefined;
	}

	function finish(
		type: "provider_stream_final" | "provider_stream_error" | "provider_stream_aborted",
	): StreamLivenessTerminalOutcome | undefined {
		if (terminal) return undefined;
		const now = readClockSafely();
		if (now === undefined) return { type: "provider_stream_error", at: lastClockAt };
		const expired = checkDeadline(now);
		if (expired) return expired;
		if (terminal) return undefined;
		return commit({ type, at: now });
	}

	scheduleTimer();

	return {
		observe,
		markFinalizing,
		markFinal: () => finish("provider_stream_final"),
		markError: () => finish("provider_stream_error"),
		markAborted: () => finish("provider_stream_aborted"),
		snapshot: (): StreamLivenessState => ({
			startedAt,
			deadlineAt,
			provider,
			model,
			transport,
			lastProviderEventAt,
			lastDeltaAt,
			lastMeaningfulContentDeltaAt,
			receivedBytes,
			blocks,
			phase,
			abortability,
			requestId,
			attemptId,
			terminal,
		}),
	};
}
